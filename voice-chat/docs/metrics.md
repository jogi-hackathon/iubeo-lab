# Metrics

Two sources: **clients** (in-browser, reported to harness) and **server** (`/metrics` polling).

## Client report schema

Clients batch reports to the harness. One report per line in `metrics.jsonl`:

```jsonc
{"ts": 1730000000000, "client": "r0-p0", "room": "room-0",
 "transport": "webrtc-mesh", "kind": "...", "data": { ... }}
```

### `kind: "join"`
Connection setup timing (ms since navigation / WS open start).

```jsonc
{"data": {"ws_open_ms": 4.2, "joined_ms": 8.1, "peers": 2}}
```

### `kind: "ctrl-rtt"`
WS signaling ping→pong round trip.

```jsonc
{"data": {"rtt_ms": 0.42}}
```

### `kind: "marker-sent"` / `kind: "marker-detected"` — the headline metric
E2E **one-way** audio latency measured with marker tones. All bench pages run in the same browser on the same machine → same clock domain, so `detected_epoch_ms - sent_epoch_ms` is real latency (encode + network + decode + detect). Events are correlated in `report.ts`: each detection pairs with the sender's latest marker within the preceding 1.5 s.

```jsonc
{"kind": "marker-sent", "data": {"epoch_ms": 1730000000123.4}}
{"kind": "marker-detected", "data": {"peer": "r0-p1", "epoch_ms": 1730000000170.7}}
```

Marker: sine burst, f=3000 Hz, 60 ms, every 2 s, phase-offset per client index. Detected in an AudioWorklet (Goertzel, sub-block granularity). Detection overhead is constant across transports, so comparisons are fair even if absolute values carry ~3–5 ms bias.

### `kind: "rtc"` (webrtc-mesh only)
From `RTCPeerConnection.getStats()`:

```jsonc
{"data": {"peer": "r0-p1", "rtt_ms": 0.8, "jitter_ms": 1.1,
          "packets_lost": 0, "bytes_recv": 41023, "audio_level": 0.4}}
```

### `kind: "media"` — per-transport frame counters

```jsonc
{"data": {"sent_frames": 900, "recv_frames": 1800, "recv_bytes": 72000}}
```

### `kind: "error"`

```jsonc
{"data": {"message": "ice failed", "peer": "r0-p1"}}
```

## Server metrics

Polled every second during a run → `server-metrics.jsonl`:

```jsonc
{"ts": 1730000000000, "url": "ws://localhost:8080", "data": {/* /metrics schema */}}
```

## Aggregation

`summary.json` per run:

- `audio_latency_ms`: `{p50, p95, p99, max}` — computed by correlating `marker-sent`/`marker-detected` pairs
- `ctrl_rtt_ms`: `{p50, p99}`
- `rtc.rtt_ms`, `rtc.jitter_ms`: `{p50, p99}` (webrtc-mesh)
- `media.recv_fps`: received frames/s per client avg
- `server.rss_bytes`: `{max}`, `server.cpu_s_total`: delta
- `join.joined_ms`: `{p50, p99}`
