# Evaluation Axes

The bench rig exists to compare **transports** × **server impls** × **scale**, with the same metrics for every cell. Audio latency is measured with in-band marker tones so all transports are measured identically (same clock domain, same detector).

## Axis 1: Transport / topology

| id | shape | media path | status |
|---|---|---|---|
| `webrtc-mesh` | P2P full mesh | browser ↔ browser (signaling relayed) | implemented |
| `ws-relay` | star via server | browser → server → browsers (WS binary, Opus/WebCodecs) | implemented |
| `wt-datagram` | star via server | WebTransport datagrams (QUIC, unreliable) | stub |
| `moq` | publish/subscribe via MOQT relay | MOQT over WebTransport (LOC-packaged Opus) | stub |

Notes:

- `ws-relay` isolates "server relays media over TCP" — the baseline for "does QUIC/UDP actually win?"
- `wt-datagram` = same star topology as ws-relay but unreliable datagrams. Hypothesis: beats ws-relay under loss; similar on localhost.
- `moq` = MOQT relay (pub/sub, group ordering, LOC container). Hypothesis: machinery is overhead at 3-person scale — measure how much.

### MoQ evaluation plan

Sora MoQ (Shiguredō) is relevant as a reference *architecture*, not necessarily a dependency:

- Full-stack Erlang/OTP implementation: QUIC, Multipath QUIC, HTTP/3, HTTP/2, WebTransport over H2/H3, MOQT, LOC, MSF, C4M — interop-tested against ngtcp2/nghttp3/nghttp2, s2n-quic, picoquic, aioquic, Chrome/WebKit/Firefox WebTransport
- OSS Sans-I/O libs: `moqt-js` (TS), `moqt-rs` (Rust), `moqt-py` (PyO3 over moqt-rs)
- Auth = C4M (CAT-4-MOQT) in URI fragment — same shape as our `?token=JWT`; easy to map
- Sora Labo hosts a public demo; Sora Cloud hosting planned

How to measure the MoQ cell, in increasing effort:

1. **`moq` relay + `moq-js`** (kixelated, Rust) — quickest self-hosted MOQT path
2. **Own relay on `moqt-rs`/`moqt-js`** — Sans-I/O, wrap in our own server to also test "Erlang-style relay in Rust"
3. **Sora Labo hosted** — sanity-check real product; uncontrolled env, do last

All three slot into the same `Transport` interface and emit the same `audio-latency`/`media` reports.

## Axis 2: Server implementation

Contract = `docs/protocol.md` + `check-server` gate. Candidates:

| impl | notes |
|---|---|
| `ref-node` | Node+ws reference (already exists; also the correctness oracle) |
| `elixir-phoenix` | Phoenix Channels — control-plane darling (presence, rooms, OTP) |
| `rust` | axum/tokio or str0m if it ever serves media |
| `go` | gorilla/nhooyr — matches game-server stack |
| `zig` | zap/http.zig — for honor |

Erlang/OTP trivia relevant here: Sora MoQ's server is pure Erlang/OTP — i.e., BEAM *can* run a serious media data-plane (QUIC included) in 2026. So "Elixir signaling + Rust data plane" vs "all-Elixir" is itself an open question this rig can answer.

## Axis 3: Scale scenarios (`bench/scenarios/*.json`)

- `smoke`: 1 room × 3 clients, 15 s — CI sanity
- `rooms-10`: 10 × 3
- `rooms-100`: 100 × 3 (=300 pages; watch browser RAM — split browsers if needed)
- Latency/jitter under load is the interesting curve; webrtc-mesh should be flat in server load (P2P) vs relay transports linear in server traffic.

## Axis 4: Network conditions (future)

Localhost measures protocol/stack overhead only. For loss/jitter realism: run server+clients inside a docker network with `tc netem` (delay/loss/duplication). ws-relay(TCP) vs wt-datagram(QUIC-UDP) divergence should show up here.

## Methodology / fairness rules

- Same synthesized audio source for every transport (oscillator + noise + markers)
- Same detector worklet; detection bias constant across transports
- Headless Chromium via Playwright: `--autoplay-policy=no-user-gesture-required` (no getUserMedia — we synthesize)
- Warmup period excluded from summary
- Server CPU/RSS from `/metrics`, polled 1 Hz

### Measured baseline (M-series MacBook, localhost, ref-node)

| scenario | transport | audio-latency p50 | ctrl-rtt p50 | server cpu_s |
|---|---|---|---|---|
| smoke (1×3) | webrtc-mesh | 70.7 ms | 0.6 ms | 0.05 |
| smoke | ws-relay | 10.0 ms | 0.5 ms | 0.59 |
| rooms-10 (10×3, 10 browsers) | webrtc-mesh | 74.7 ms | 1.0 ms | 0.34 |
| rooms-10 (3 browsers) | ws-relay | 10.1 ms | 1.1 ms | 4.62 |

Interpretation: localhost has ~zero network latency/jitter, so ws-relay wins trivially (no jitter buffer needed — WebRTC's ~70ms is mostly its adaptive jitter buffer). ws-relay server CPU grows linearly with relayed frames (58k frames in 30s); webrtc-mesh server CPU is flat (media is P2P — server only does signaling). The real divergence is expected under netem loss (Axis 4): TCP head-of-line blocking should wreck ws-relay while WebRTC/QUIC shrug it off.

### Harness capacity limits (found the hard way)

- ~10 AudioContext pages per Chromium process before client CPU saturation distorts results — shard with `--browsers`
- Headless inbound RTC audio decodes only while a media element renders the stream — bench attaches a muted `<audio>` per remote stream as a decode pump
- Watch `ctrl-rtt` p99 as a client-starvation canary: if it climbs above ~50ms, client results are suspect, not the server's
