# Live VC demo — headless-Chrome recording with real audio

`bench demo` renders an actual voice-chat session (N real headless-Chromium
clients exchanging Opus audio through a chosen transport) as a dashboard, and
produces a `.webm` video **with an audio track containing what a player would
actually hear**. Requires no mic/display — everything is synthesized.

Outputs land in `bench/demo/`:

```
vc-demo-<transport>-<stamp>.webm        # dashboard video (silent)
vc-demo-<transport>-<stamp>-audio.webm  # video + recorded audio muxed in
mix-<stamp>.wav                         # the audio that was muxed
rec/<client>__<peer>.f32                # raw 48kHz f32le PCM per client←peer
rec/<client>__self.f32                  # client's own pre-encode PCM ("sidetone")
voices/v<i>.wav                         # per-player voice loops (VOICEVOX)
```

## How it works

Playwright launches **two** browser contexts:

- **Client context** (not recorded): N pages running the real bench client —
  JWT join, signaling, Opus encode/decode, relay/mesh media.
- **Dashboard context** (recorded via `recordVideo`): a single page fed by the
  harness with `window.__vc` (per-client stats) and `window.__pos` (simulated
  positions) every 200ms. Renders per-client cards (per-peer RMS level bars,
  transport latency, frame counters) and a spatial map (players, hearing-radius
  rings, edges whose width/alpha track inbound audio level).

Audio capture: `recordVideo` produces video only, so the dashboard's own audio
is captured by recording **decoded inbound PCM inside each client** instead:

- The detector worklet (`audio/worklets.ts`) gains a `rec` processor option and
  posts `{kind:"pcm"}` buffers every ~100ms of scanned audio. This covers both
  feed-mode (relay transports: decoded Opus → `det.feed`) and stream-mode
  (WebRTC: remote MediaStream → worklet input).
- `Detector.onpcm` → `TransportCtx.onRecvPcm` → `main.ts` accumulates per-peer
  chunks; the harness drains them via `window.__drainRec()` (~1s cadence,
  base64 f32) and appends to `rec/<client>__<peer>.f32`.
- With `record=1`, `main.ts` also taps `audio.onPcm` (pre-encode send PCM) into
  `__self` — the "you can hear your own mic" stream for the mix.
- Post-run: `ffmpeg amix` of the listener's (`room-demo-p0`) streams
  → `mix-*.wav` → muxed with `-c:v copy -c:a libopus -shortest`.

So the audio in the video is genuinely "what p0's client decoded", including
encode/relay/decode artifacts — not the source files.

## Voices (VOICEVOX)

Per-player voice loops are synthesized by a local VOICEVOX engine
(`docker run -p 50021:50021 voicevox/voicevox_engine:cpu-ubuntu22.04-latest`).
`bench/demo/voices/` was assembled as ~34s conversation scripts — lines are
offset in time so players take turns instead of all talking over each other:

| player | voice | lines at |
|---|---|---|
| p0 | ずんだもん (speaker 3) | 0.5s, 16s |
| p1 | 四国めたん (speaker 2) | 5.5s, 21s |
| p2 | 春日部つむぎ (speaker 8) | 10.5s, 26s |

Client side, `?voice=<url>` fetches the wav, `decodeAudioData`, loops it via an
`AudioBufferSourceNode` mixed over the (now-silenced) carrier. `?markers=0`
disables the 3kHz marker beeps, so the demo audio is pure speech. Marker
scheduling and the carrier remain on by default for latency-measuring bench
runs. Voice-fetch failure degrades to carrier-only, it doesn't kill the client.

## Simulated spatial attenuation

Positions are not provided by a game server yet, so the harness simulates a
top-down layout (dashboard px space): p0/p1 sit 240u apart (inside hearing
radius), p2 starts ~500u away and walks in during t=11s..23s.

- Harness computes `gain = min(1, 180/dist)` for every pair each 200ms tick.
- Each client page holds `window.__gains` (a `Map` mutated in place by
  `page.evaluate`); transports copy it into `det.gain` every 250ms.
- Feed-mode detectors multiply decoded PCM by `gain` before the worklet;
  stream-mode (WebRTC) inserts a `GainNode` before the detector. Both affect
  levels, recording, and map edges identically — the attenuation is real DSP,
  applied at the receiver like a game would (PositionalAudio-equivalent).

Verified on one run: p2 heard by p0 went mean -33.4dB (far) → -25.5dB (near),
≈ +8dB matching the 0.36→1.0 gain change.

## Impairment playback

- `--chaos d:j:p:s` — TCP chaos proxy in front of the signaling+media WS.
  Downstream chunks get a monotonic release time (`delay + jitter·rand +
  stallMs` with prob `p`); a stalled chunk holds all later bytes in order —
  observable-identical to loss→retransmit head-of-line blocking. Heard as
  audio freezing mid-word then jumping.
- `--uchaos d:j:l` — spawns `bench/chaos-udp` in front of the media relay
  (wt-datagram/moq only; fetched `/wtcert` URL is rewritten to the proxy port).
  Dropped datagrams become small mid-speech holes without stalls.
  Signaling WS stays unimpaired — matching the real topology.

Example run produced 21 ≥150ms dropouts for ws-relay under
`--chaos 40:30:0.04:350`; the wt-datagram `--uchaos 40:30:5` mix is ~1.5dB
quieter and choppy instead of stalling.

## Usage

```sh
# needs: ref server on :8080 (pnpm server:ref); voicevox on :50021 for voices
pnpm bench demo --transport ws-relay --clients 3 --seconds 32 \
  --out bench/demo \
  --voices bench/demo/voices/v0.wav,bench/demo/voices/v1.wav,bench/demo/voices/v2.wav

pnpm bench demo ... --self 0                    # exclude own voice from the mix
pnpm bench demo ... --chaos 40:30:0.04:350      # TCP HOL impairment (ws-relay)
pnpm bench demo --transport wt-datagram --media http://localhost:8091 \
  ... --uchaos 40:30:5                          # UDP loss impairment
```

## three.js WebGPU 3D world demo (`--world`)

`pnpm bench demo --world 1` records the same session inside a real 3D world
instead of the 2D dashboard: the recorded page **is a real VC client**
(`bench/client/src/world.ts`, served at `/world`) — same signaling, JWT, and
MoQ transport stack as the headless bench client, plus a three.js scene.

- Renderer: `three/webgpu` `WebGPURenderer` (TSL/WebGPU-style code). Headless
  Chromium has no usable WebGPU device, so the demo passes `?gl=1` which sets
  `forceWebGL` — the WebGL2 backend renders identical output from the same
  scene code. On a desktop browser, omit it and the real WebGPU backend is
  used (HUD shows `WebGPU` vs `WebGL2`).
- Scene: capsule avatars + name sprites, hearing rings (full volume inside
  `HEAR_REF`=15, silence at `HEAR_MAX`=90 world units), grid ground, boxes,
  fog, HUD with per-peer distance/gain/level.
- Movement: WASD/arrows + QE rotate + mouse-drag orbit (follow cam);
  `?cam=top` isometric; `?auto=1&path=x,z;x,z;...` scripted waypoints;
  `window.__moveTo(x,z)` for harness/scripted control.
- Position sharing goes over the real game channel: every client broadcasts
  `{pos:[x,z], mute}` as directed `signal` messages at 10Hz (see `?pos` param +
  `__setPos` in `main.ts`; world.ts does the same). Attenuation is
  client-side: `gain = clamp((HEAR_MAX - dist) / (HEAR_MAX - HEAR_REF))` —
  a finite linear rolloff (1 inside 15u, 0 at/beyond 90u) applied via the
  transport `gains` map, exactly like the 2D demo's pushed gains but
  computed from real signaled positions. (The earlier `30/dist` curve
  never reached silence — ~0.26 at 115u — so far voices stayed audible.)

### Real-VC mode (live voice + mute controls)

The world page doubles as an actual usable VC client, not just a benchmark:

- **Mic input is the default voice source** — `getUserMedia` with echo
  cancellation / noise suppression / AGC joins the send graph. `?voice=mic`
  forces it, `?voice=<url>` keeps the wav-demo mode, `?nomic=1` reverts to
  the bench carrier. Mic acquisition is async — the page joins on the
  carrier and swaps to mic when permission lands (`audio.mode` on the HUD).
- **Join gate**: real browsers gate AudioContext + mic behind a user
  gesture, so the page shows "click to join voice" first. `?autojoin=1`
  (or `?auto=1`, used by the harness) skips it.
- **Audible receive path**: `TransportCtx.play` is a shared speaker bus the
  world page wires to `ctx.destination`; feed detectors schedule decoded
  PCM as AudioBufferSources against the WebAudio clock (30ms lookahead,
  >500ms jitter build-up re-anchors to live edge). Bench pages pass no bus
  and stay silent.
- **Mute controls**: `M` = mic mute (send gate → digital silence on the
  wire; frames keep flowing), `N` = speaker deafen (speaker bus gain → 0),
  plus on-screen buttons bottom-right. Mic state rides the pos broadcast
  (`{pos, mute}`) so peers render `·muted` on the avatar label and HUD.
  `window.__setMicMuted/__setSpkMuted/__muteState` for harness control.
- `?markers=` defaults to off when a real voice source (mic/voice) is
  active — bench beeps stay opt-in via `markers=1`.
- **Walk-in join**: with no `?id`/`?token` the page POSTs `server`'s
  `/v1/join` (`{room, name?}`) after the gate click, receives a
  roster-unique id + freshly minted JWT, and connects with those — one
  shareable lobby URL, everyone who opens it lands in the same room.
  `&name=<label>` pins the avatar label (dup names collide on connect;
  nameless joins get `p-xxxx` ids that never collide). Implemented as
  `POST /v1/join` on ex_vc (`router.ex`) minting via `Vc.Jwt.sign` —
  dev/demo endpoint, no auth of its own.
- **Debug overlay**: `` ` `` (backquote) or `?debug=1` toggles a live
  panel (top-right, refreshed at 4 Hz from `transport.stats()`): sig RTT,
  real rendered fps, send/recv frame rates + kb/s, decoder queue depth
  (moq `dec_queue` — the starvation tell from the loaded-machine runs),
  datagram p50/max latency (moq/wt), and a per-peer table
  `peer · dist · gain · lat_ms · level`. webrtc-mesh shows its per-peer
  RTT/jitter/loss rows instead.
- **Lobby (`/`)**: serveClient bakes `__VC_CFG` (server/media/wthash/
  transport) into the pages, so the lobby URL needs zero params. It lists
  live rooms from `GET /v1/rooms` (name, n/8, member ids; empty rooms
  vanish automatically), offers join buttons, and a name field that
  creates-or-joins (button label flips as you type an existing name).
  Your display name persists in localStorage. Room names are validated
  server-side (`[^\s/\\]{1,32}`) since they land in the relay's media
  namespace. Bench page moved to `/bench`.

```sh
pnpm bench try [--transport moq]
# prints the bare lobby URL (http://127.0.0.1:PORT), auto-opens Chrome
```

Verified: `bench/harness/src/autojoin.ts` — two nameless+named pages
auto-join, get `p-lCUP`/`bob`, discover each other (`AUTOJOIN_PASS`);
`bench/harness/src/lobbytest.ts` — `/` → create room → world join →
room+member live in a second lobby view (`LOBBY_PASS`).

Example (moq + Elixir auth relay + VOICEVOX all three incl. p0's own
ずんだもん voice; p0 is the recorded listener walking
`-60,-40 → 6,3 → 52,27 → 0,-40`):

```sh
pnpm bench demo --world 1 --transport moq \
  --server ws://localhost:8081 \
  --media https://localhost:4443 --mediahash <cert sha256> \
  --voices bench/demo/voices/v0.wav,bench/demo/voices/v1.wav,bench/demo/voices/v2.wav \
  --audio --seconds 30            # --self 1 (default): own voice in the mix
```

Pass `--self 0` and an empty first voice (`--voices ",v1.wav,v2.wav"`) for
the strict "what p0 receives" recording.

Output: `bench/harness/demo/vc-world-<transport>-<ts>.webm` (video) and
`-audio.webm` (video + p0's decoded receive mix + own sidetone with
default `--self 1`). Verified artifact
`vc-world-moq-2026-10-03T10-23-26-audio.webm` shows `gain=1.00 → 0.43 →
0.00` on the HUD as p0 approaches/leaves, p2's recorded stream ramping
with distance, and p0's own ずんだもん voice in the mix.

Under heavy machine load the recorded page's decoder starves (visible in
the harness stats line as `decq` growing while `recv` climbs). The demo
mitigates this with `fps=24` (world page render cap), 960x600 capture,
and `framedur=40` on all clients. If a run still starves, re-run when the
machine is idle.

## Caveats / limits

- Listener perspective is `room-demo-p0`. `--self 1` (default) adds p0's
  pre-encode PCM so all three voices are audible; `--self 0` is the strict
  "what p0 receives" VC view.
- Positions are synthetic; wiring real 3D positions would mean the game server
  pushing `__gains`-equivalent data — the client-side gain hook is the same.
- Level bars / map edges reflect post-attenuation RMS, so a distant speaker
  shows a thin line even while talking — intended.
- `--chaos` on ws-relay impairs signaling and media together (one TCP conn) —
  same as a real TCP-based VC.
- The client's `lat_ms` display is transport-frame latency
  (`Date.now() - sentMs`), independent of marker detection, so it stays
  correct with `markers=0`.
- VOICEVOX lines were pre-rendered to `bench/demo/voices/`; the engine is only
  needed to regenerate them, not at demo time.

## Files

| path | role |
|---|---|
| `bench/harness/src/demo.ts` | orchestration: dashboard server, recorded+client contexts, gains/positions push, PCM drain, ffmpeg mix+mux, TCP/UDP chaos |
| `bench/client/src/main.ts` | `__state` snapshot (250ms), `__gains` map, `__drainRec`, `?voice/?record/?markers` params |
| `bench/client/src/audio/source.ts` | voice-file loop source, marker/carrier toggles |
| `bench/client/src/audio/worklets.ts` | detector RMS level + `rec` PCM post-back |
| `bench/client/src/audio/detector.ts` | `Detector.level`, `Detector.gain` (feed=PCM scale, stream=GainNode), `onpcm` tap |
| `bench/client/src/transports/*` | stats expose `levels`+`lat_ms`; `gainTimer` applies `c.gains` to detectors |
| `bench/harness/src/try.ts` | `pnpm bench try`: serveClient(cfg) + auto wthash + bare lobby URL |
| `bench/harness/src/serveClient.ts` | `/` lobby (room list + create/join), `/world`, `/bench`; bakes `__VC_CFG` |
| `bench/harness/src/autojoin.ts` | walk-in e2e: two pages, no credentials, mutual discovery |
| `bench/harness/src/lobbytest.ts` | lobby e2e: `/` → create room → world join → live listing |
| `servers/elixir_vc/lib/vc/router.ex` | `POST /v1/join` (id+JWT, room-name validated), `GET /v1/rooms` |
