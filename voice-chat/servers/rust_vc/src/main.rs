// VC server in Rust — implements docs/protocol.md contract.
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Instant,
};
use tokio::sync::mpsc;

type RoomMap = HashMap<String, HashMap<String, mpsc::UnboundedSender<Msg>>>;

#[derive(Clone)]
enum Msg {
    Text(String),
    Binary(Vec<u8>),
}

struct Metrics {
    signal_msgs: AtomicU64,
    media_frames: AtomicU64,
    media_bytes: AtomicU64,
}

struct AppState {
    rooms: RwLock<RoomMap>,
    metrics: Metrics,
    key: DecodingKey,
    started: Instant,
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    room: String,
    exp: u64,
}

#[derive(Deserialize)]
struct Q {
    token: String,
}

#[tokio::main]
async fn main() {
    let key_path = std::env::var("VC_PUBLIC_KEY_PATH")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/dev-keys/public.jwk").to_string());
    let jwk: Value = serde_json::from_slice(&std::fs::read(&key_path).expect("public.jwk")).unwrap();
    let key = DecodingKey::from_ed_components(jwk["x"].as_str().unwrap()).unwrap();

    let state = Arc::new(AppState {
        rooms: RwLock::new(HashMap::new()),
        metrics: Metrics {
            signal_msgs: AtomicU64::new(0),
            media_frames: AtomicU64::new(0),
            media_bytes: AtomicU64::new(0),
        },
        key,
        started: Instant::now(),
    });

    let app = Router::new()
        .route("/v1/signaling", get(ws_handler))
        .route("/healthz", get(|| async { "{\"ok\":true}" }))
        .route("/metrics", get(metrics))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "8083".into())
        .parse()
        .unwrap();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[rust_vc] ws://localhost:{port}/v1/signaling");
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<Q>,
) -> Result<impl IntoResponse, StatusCode> {
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.required_spec_claims = Default::default();
    let claims = decode::<Claims>(&q.token, &state.key, &validation)
        .map_err(|_| StatusCode::UNAUTHORIZED)?
        .claims;
    let now = jsonwebtoken::get_current_timestamp();
    if claims.sub.is_empty() || claims.room.is_empty() || claims.exp <= now {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |s| handle_socket(s, state, claims.sub, claims.room)))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, id: String, room: String) {
    const ROOM_MAX: usize = 8;
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();

    let joined: Option<Vec<String>> = {
        let mut rooms = state.rooms.write().unwrap();
        let members = rooms.entry(room.clone()).or_default();
        if members.contains_key(&id) || members.len() >= ROOM_MAX {
            None
        } else {
            let ids: Vec<String> = members.keys().cloned().collect();
            for (_, otx) in members.iter() {
                let _ = otx.send(Msg::Text(
                    json!({"type": "peer-joined", "id": id}).to_string(),
                ));
            }
            members.insert(id.clone(), tx.clone());
            Some(ids)
        }
    };
    let Some(existing) = joined else {
        let _ = socket.close().await;
        return;
    };

    let (mut sink, mut stream) = socket.split();
    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let r = match msg {
                Msg::Text(t) => sink.send(Message::Text(t.into())).await,
                Msg::Binary(b) => sink.send(Message::Binary(b.into())).await,
            };
            if r.is_err() {
                break;
            }
        }
    });

    let _ = tx.send(Msg::Text(
        json!({"type": "peers", "peers": existing.iter().map(|i| json!({"id": i})).collect::<Vec<_>>()})
            .to_string(),
    ));

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) => {
                relay_binary(&state, &room, &id, &b);
            }
            Message::Text(t) => {
                if let Some(reply) = handle_text(&state, &room, &id, &t) {
                    let _ = tx.send(Msg::Text(reply));
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // disconnect: remove + broadcast peer-left
    {
        let mut rooms = state.rooms.write().unwrap();
        if let Some(members) = rooms.get_mut(&room) {
            members.remove(&id);
            for (_, otx) in members.iter() {
                let _ = otx.send(Msg::Text(
                    json!({"type": "peer-left", "id": id}).to_string(),
                ));
            }
            if members.is_empty() {
                rooms.remove(&room);
            }
        }
    }
    drop(tx);
    let _ = write_task.await;
}

// Synchronous helpers — locks never cross an await.
fn relay_binary(state: &AppState, room: &str, id: &str, b: &[u8]) {
    state.metrics.media_frames.fetch_add(1, Ordering::Relaxed);
    state.metrics.media_bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
    let rooms = state.rooms.read().unwrap();
    if let Some(members) = rooms.get(room) {
        for (pid, otx) in members.iter() {
            if pid != id {
                let _ = otx.send(Msg::Binary(b.to_vec()));
            }
        }
    }
}

fn handle_text(state: &AppState, room: &str, id: &str, t: &str) -> Option<String> {
    let v: Value = serde_json::from_str(t).ok()?;
    match v["type"].as_str() {
        Some("ping") => Some(json!({"type": "pong", "t": v["t"]}).to_string()),
        Some("signal") => {
            state.metrics.signal_msgs.fetch_add(1, Ordering::Relaxed);
            let to = v["to"].as_str().unwrap_or("");
            let rooms = state.rooms.read().unwrap();
            match rooms.get(room).and_then(|m| m.get(to)) {
                Some(otx) => {
                    let _ = otx.send(Msg::Text(
                        json!({"type": "signal", "from": id, "data": v["data"]}).to_string(),
                    ));
                    None
                }
                None => Some(
                    json!({"type": "error", "code": "no_such_peer", "message": to}).to_string(),
                ),
            }
        }
        _ => None,
    }
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let rooms = state.rooms.read().unwrap();
    let peers: usize = rooms.values().map(|m| m.len()).sum();
    let room_count = rooms.len();
    drop(rooms);

    let mut sys = sysinfo::System::new();
    let pid = sysinfo::get_current_pid().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let rss = sys
        .process(pid)
        .map(|p| p.memory())
        .unwrap_or(0);

    let cpu_s = {
        let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
        (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) as f64
            + (ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) as f64 / 1e6
    };

    axum::Json(json!({
        "uptime_s": state.started.elapsed().as_secs_f64(),
        "ws_connections": peers,
        "rooms": room_count,
        "peers": peers,
        "signal_msgs_total": state.metrics.signal_msgs.load(Ordering::Relaxed),
        "media_frames_total": state.metrics.media_frames.load(Ordering::Relaxed),
        "media_bytes_total": state.metrics.media_bytes.load(Ordering::Relaxed),
        "rss_bytes": rss,
        "cpu_s": cpu_s
    }))
}
