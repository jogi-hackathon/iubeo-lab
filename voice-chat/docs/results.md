# VC bench results

Measured on a single macOS host (localhost), Chromium via Playwright, Opus 20ms
frames @48kHz, marker-tone one-way audio latency. All numbers are from
`bench/results/<ts>-<scenario>-<transport>/summary.json`.

Environment: devenv (node 26.8.2, elixir 1.19.6/OTP 28.5, go 1.26.7,
rust 1.98.1, zig 0.16.0), moq-relay 0.16.0, wt_relay (Go/quic-go).

## Transport matrix — audio-latency ms (sent→marker-detected, Opus incl.)

### Clean network

| scenario | transport | p50 | p95 | p99 | notes |
|---|---|---|---|---|---|
| smoke 1x3 | webrtc-mesh | 70.7 | 74.6 | 74.6 | P2P, adaptive jitter buffer |
| smoke 1x3 | ws-relay    | 10.0 | 11.5 | 11.5 | TCP relay, no jitter buffer |
| smoke 1x3 | wt-datagram |  8.7 | 10.1 | 13.9 | QUIC datagrams, wt_relay (Go) |
| smoke 1x3 | moq         | 10.1 | 11.3 | 11.3 | MOQT datagrams, moq-relay (Rust) |
| rooms-10 30cl | webrtc-mesh | 74.7 | - | 120.7 | P2P; server load ~flat |
| rooms-10 30cl | ws-relay    | 10.1 | - | 331.1 | |
| rooms-10 30cl | wt-datagram |  9.5 | 12.0 | 12.1 | 53k frames/30s relayed |
| rooms-10 30cl | moq         |  9.5 | 12.0 | 12.2 | moq-lite datagrams, maxAge=150 |

### Impaired network (downstream 50ms + 10ms jitter + 5% loss)

ws-relay/webrtc-mesh used docker `tc netem` on server egress; wt-datagram/moq used
`bench/chaos-udp` on the UDP relay path. Caveat: not a perfectly identical
topology, and WebRTC media is P2P so its media path bypassed impairment entirely.

| scenario | transport | p50 | p99 |
|---|---|---|---|
| smoke | ws-relay (TCP)    | 75.4 | 203.4 | ← head-of-line blocking on loss |
| smoke | wt-datagram       | 63.5 | 104.6 | datagrams just drop |
| smoke | moq               | 62.7 |  74.1 | same, MOQT framing, maxAge=150 |
| smoke | webrtc-mesh       | 68.0 | 117.9 | media P2P, NOT impaired — signaling only |
| rooms-10 | wt-datagram   | 73.5 | 336.0 | via chaos-udp |

## Server implementation matrix — ws-relay transport

All five implementations pass `check-server` (11/11): JWT(EdDSA), roster,
join/leave, directed signal, ping/pong, binary media relay, metrics.

| server | lang | smoke p50 | rooms-10 p50 | rooms-10 p99 | cpu_s | rss MB |
|---|---|---|---|---|---|---|
| ref-node | Node 26    | 10.0 | 10.1 | 331 | 4.6 | 77 |
| ex_vc    | Elixir 1.19 | 8.7 | 9.9 | 48 | 6.2 | 68 |
| go_vc    | Go 1.26    | 9.8 | 10.8 | 315 | 6.0 | 19 |
| rust_vc  | Rust 1.98  | 8.7 | 10.6 | 860 | 3.4 | 12 |
| zig_vc   | Zig 0.16   | 10.1 | 11.3 | 819 | 3.1 | 26 |

rooms-10 tails vary a lot between implementations (single runs on a busy
machine — treat p99 as directional, not definitive). Elixir's BEAM scheduler
shows the flattest tail here; Rust/Zig single-digit p50 are fine but the tail
blew out in these runs.

## Verified

- 5 contract-compliant servers (Node/Elixir/Go/Rust/Zig), 11/11 checks each.
- 4 transports end-to-end through real browsers: webrtc-mesh, ws-relay,
  wt-datagram (custom Go relay + serverCertificateHashes), moq
  (@moq/net + moq-relay 0.16.0 over WebTransport, `vc-bench/<room>/<id>`
  broadcast per client, Opus in MOQT datagrams).
- Impaired-path runs for all 4 transports (UDP chaos proxy / docker netem).
- rooms-10 scale (30 clients across 10 browser processes) for all 4 transports.

## Findings

1. **ws-relay (TCP) is fastest on a clean LAN** (~10ms e2e incl. Opus) because
   there is no jitter buffer, but degrades worst under loss (HOL blocking:
   p99 203ms vs ~80-105ms for UDP transports).
2. **wt-datagram and moq are the sweet spot** for relayed audio: clean-path
   latency ≈ ws-relay, impaired-path tail roughly 2x better.
3. **webrtc-mesh** carries ~60-70ms of Opus+adaptive jitter buffer even on
   localhost; scales with clients not servers, but pays baseline latency and
   client CPU, and cannot be relay-impaired (P2P bypasses the relay — an
   advantage for quality, a caveat for the benchmark).
4. **moq-relay works end-to-end today** (moq-lite-06 negotiated) and, after
   bounding `maxAge`, matches wt-datagram under rooms-10 load. The earlier
   570ms tail was not the protocol: `subscribe({maxAge: 1000})` told the
   relay to re-serve up to 1s of stale frames, so queued backlog was
   delivered as "latency". Live voice wants the live edge — see below.

### IETF MOQT vs moq-lite (same relay, same client lib)

`--listen-version` on moq-relay pins the negotiated version; @moq/net offers
both protocol families and the browser code switches wire format accordingly
(native datagrams on moq-lite; single-frame groups on IETF MOQT, which has no
standalone datagram object — the relay carries single-frame groups as QUIC
datagrams on egress).

| version | rooms-10 p50/p99, maxAge=1000 (old) | rooms-10 p50/p99, maxAge=150 |
|---|---|---|
| moq-lite-06 (native datagrams) | 12.4 / 570 | 9.5 / 12.2 |
| moq-transport-14 (1-frame groups) | 800.8 / 1467 | — |
| moq-transport-22 (1-frame groups) | 968.1 / 1487 | 10.0 / 17.2 |

The rooms-10 tail was a **delivery-semantics bug in our client config**, not
the wire format: `maxAge` is the window of stale data a subscription will
accept from the relay (publisher `Info.maxAge` sets the matching cache
bound). 1000ms meant queued backlog replayed as measurable "latency"; 150ms
(≈7 frames) skips it at the live edge. With that fixed, both wire formats
sit within ~5ms of each other — IETF group-per-frame churn (~1500 group
streams/sec at 30×50fps) is observable but not the bottleneck. Caveat:
skipped frames are dropped, not delivered — correct for live voice, but the
latency metric only ever counts delivered markers either way.

### MoQ latency floor: where the remaining ~10ms lives

After the `maxAge` fix, we profiled the e2e path to find the residual
~9.5-10ms p50. The datagram-arrival metric (`Date.now()` at receiver minus
`sentMs` stamped at encoder output) reads **p50 ≈ 1-2ms** — the MoQ/QUIC
relay path is nearly free on localhost. The residual is client pipeline:

| lever tried | smoke p50 | rooms-10 p50/p99 | verdict |
|---|---|---|---|
| `framedur=10` + `latmode=realtime` | 10.7 | 96.0 / 979 | worse at scale |
| `framedur=5` + `capchunk=240` + realtime | 11.6 | 811 / 1487 | much worse at scale |
| `detjs=1` (JS-side marker detect, skips worklet render quantum) + realtime | — | 9.8 / 14.8 | no change |
| `moqmaxage=0` + realtime | — | 9.8 / 12.1 | same as 150 |

Two independent ceilings explain this:

1. **Codec + audio pipeline ≈ 8ms**, not wire. Marker→wire includes the
   capture worklet's chunk fill + Opus encode; detection adds decode +
   Goertzel eval. Shrinking Opus `frameDuration` (20→5ms) does NOT lower the
   number even at 3 clients, so encoder lookahead + decode dominate, not
   frame quantization.
2. **Per-datagram client overhead**: at 30 clients the datagram rate is
   30×fps. 10ms frames (≈3000 dg/s) already degrade the tail; 5ms frames
   (≈6000 dg/s) drown the event loop entirely (ctrl-rtt p99 517ms). QUIC
   datagrams don't retransmit but DO queue in the sender when the app can't
   drain — smaller frames trade codec delay for queueing delay, and lose.

Practical floor on this stack is ~9-10ms e2e (Opus in/out + pipeline) with
~1-2ms of that on the wire. MoQ matches wt-datagram; sub-10ms would need a
codec/pipeline change (e.g. PCM passthrough or shorter Opus modes), not a
transport change.

Tuning knobs added for these experiments (client URL params):
`moqmaxage` (sub + publisher `Info.maxAge`), `framedur` (Opus frameDuration
ms, e.g. 5/10/20), `capchunk` (capture worklet samples/chunk),
`latmode` (AudioEncoder `latencyMode`), `detjs=1` (JS-side marker detect).

5. Language choice for the signaling/relay server is swappable at will — all
   five pass the contract; differences show up in tail latency and memory
   under relay load, not in correctness.

## MoQ media-plane auth via Elixir (`--auth-url`)

The relay delegates admission to the Elixir control plane. `moq-relay` is
started with `--auth-url http://127.0.0.1:8081/v1/moq/auth`; the VC client
carries its signaling JWT on the WebTransport URL as `?jwt=` (moq.ts). The
relay POSTs one JSON event per session lifecycle to the endpoint:

- `connect` / `revalidate` → endpoint verifies the JWT (`Vc.Jwt`), and returns
  a room-scoped grant:
  `{publish: ["vc-bench/<room>/<sub>"], subscribe: ["vc-bench/<room>/*"],
    expires: <jwt exp>, revalidate: 60}`.
- `revalidate` additionally requires the subject to still be in the room
  roster (`Vc.Rooms.lookup`) — a member that left gets refused and the relay
  drops the media session (kick enforcement, observed working as sessions are
  refused at teardown).
- `end` → `200 {}` (notification only).
- 401/403 → session refused; any other non-2xx → relay retries with backoff,
  session lives until `expires`.

Verified:
- **smoke (auth)**: `audio-latency p50=9.3 p99=12.1ms, errors=0` — identical
  to the unauthenticated path.
- **rooms-10 (auth vs no-auth, same signaling server, same build)**: 22.8 vs
  18.5 p50 / 1129 vs 1390 p99 — statistically identical under the current
  machine load (load avg ~20 during measurement; repeated identical-config
  runs drift 10→18ms p50). No auth-specific media cost detected at this
  scale; the `connect` POST adds ~10-25ms to session setup only.
- Refusals (bad/missing JWT) → relay refuses the session at connect.
- `?moqauth=0` client param skips the `?jwt=` param — required against
  `--auth-public` relays, which refuse any session presenting a token.

## Known harness caveats

- `server.cpu_s_delta` can go negative if a server was restarted mid-poll —
  read per-run values with that in mind.
- WebRTC mesh media never traverses the relay, so "impaired" WebRTC numbers
  only reflect signaling impairment.
- moq impaired runs used the chaos proxy; ws-relay impaired used docker netem.
- headless Chromium requires a muted `<audio>` element per remote stream or
  remote audio is never decoded (WebRTC only).
- ~10 AudioContexts per browser process is the practical ceiling; `--browsers`
  shards clients across processes (same machine clock keeps latency valid).

## Audiovisual demo

`pnpm bench demo` records a real multi-client VC session (headless Chromium +
dashboard + recorded decoded audio) to `bench/demo/*.webm` — see `docs/demo.md`.

## Recommendation

- **Architecture**: keep plan B — VC service isolated behind the JWT contract;
  position data stays on the game WS, spatialization stays client-side
  (PositionalAudio), VC only moves Opus.
- **Transport**: WS-relay for v1 is legitimate (simple, every server impl
  already does it, 10ms on LAN), but the impairment data says UDP
  (wt-datagram or moq) wins under real internet loss. For rooms-of-3 mesh,
  WebRTC is still the zero-server-media option with a ~60ms latency tax.
- **Implementation**: Elixir/Phoenix remains a solid pick for signaling
  (flattest tail in this matrix). If media-plane relay is needed, Go/Rust
  QUIC (wt_relay / moq-relay) measured best-under-loss.
- **MoQ**: verified end-to-end on both wire versions; with `maxAge=150`
  (live-edge delivery) it matches wt-datagram at rooms-10 scale. Keep as a
  real transport axis, not just experimental.
