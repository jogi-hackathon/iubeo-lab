# VC Protocol Contract

All VC server implementations (Node/Elixir/Rust/Go/…) MUST satisfy this contract.
Conformance is verified by `pnpm bench check-server --url ws://host:port`.

The server does exactly two things:

1. **Signaling relay** — forward opaque signaling payloads between peers in a room
2. **Media relay** (optional transport) — forward opaque binary media frames to all *other* members of the room

The server MUST NOT inspect or transform `signal.data` or media payloads.

---

## 1. Authentication

Connection URL:

```
GET ws(s)://HOST/v1/signaling?token=JWT
```

JWT (EdDSA / Ed25519):

| claim | meaning |
|---|---|
| `iss` | issuer, e.g. `"vc-bench"` |
| `sub` | player id (unique per client) |
| `room` | room id |
| `exp` | expiry (unix seconds) |

Invalid or expired token → reject with HTTP 401 (preferred) or WS close code `4401`.

Dev keypair lives in `bench/dev-keys/` — **dev only, never ship**.

## 2. WebSocket signaling messages

JSON text frames. `type` field required.

### Server → Client

```jsonc
{"type": "peers", "peers": [{"id": "p1"}, {"id": "p2"}]}  // roster sent once on join
{"type": "peer-joined", "id": "p3"}                       // broadcast to existing members
{"type": "peer-left", "id": "p3"}                         // broadcast on disconnect/close
{"type": "signal", "from": "p1", "data": {/* opaque */}}  // relayed signaling
{"type": "pong", "t": 1234.5}                             // echo of ping.t
{"type": "error", "code": "bad_message", "message": "..."}
```

### Client → Server

```jsonc
{"type": "signal", "to": "p2", "data": {/* opaque, e.g. SDP/ICE */}}
{"type": "ping", "t": 1234.5}   // server MUST reply pong with same t (control RTT probe)
```

Rules:

- `signal` is delivered only to `to`. If `to` is not in the room → `error` (`code: "no_such_peer"`) or silently drop (impl choice, document it).
- A client's own `peer-joined`/`peer-left` MUST NOT be echoed back to itself.
- Room membership comes **only** from the JWT `room` claim — there is no `join` message.
- Server SHOULD limit room size (recommend ≥8; bench uses 3).

### Offer rule (mesh, client-side convention)

To avoid glare: the **newcomer** sends WebRTC offers to every peer in the initial `peers` roster. Existing members only answer. When a peer joins mid-session, it offers to everyone.

## 3. Binary media frames (WS relay transport)

Binary WebSocket frames on the same connection. Header is 16 bytes little-endian:

| offset | field   | type | notes |
|---|---|---|---|
| 0  | type    | u8   | `0x01` = audio |
| 1  | codec   | u8   | `0x01` = opus (WebCodecs-encoded) |
| 2  | flags   | u16  | reserved, 0 |
| 4  | seq     | u32  | per-sender frame counter |
| 8  | sent_ms | f64  | sender `Date.now()` epoch ms |

Server relays the frame **verbatim** to all other members of the room. Ordering/dedup is the receiver's problem (seq is provided).

## 4. HTTP endpoints

```
GET /healthz → 200 {"ok": true}
GET /metrics → 200 application/json
```

`/metrics` minimal schema (impls may add fields):

```jsonc
{
  "uptime_s": 12.3,
  "ws_connections": 300,        // current open WS conns
  "rooms": 100,                 // current non-empty rooms
  "peers": 300,                 // total joined peers
  "signal_msgs_total": 1234,    // cumulative
  "media_frames_total": 98765,
  "media_bytes_total": 1234567,
  "rss_bytes": 12345678,        // process RSS
  "cpu_s": 3.21                 // cumulative process CPU seconds
}
```

## 5. Position data is out of scope

Distance attenuation needs positions, but positions arrive via the **game server's** WS, never through the VC layer. The VC server is deliberately ignorant of positions — spatialization is a client-render concern.
