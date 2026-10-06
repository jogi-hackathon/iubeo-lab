# vc

> **iubeo lab 実験ノート**
>
> - **目的**: 距離減衰つきボイスチャット（3D空間）のベンチリグ。WebRTC mesh / WS relay /
>   WebTransport (moq, wt-datagram) を同一シナリオで比較する。
> - **起動**: `pnpm install` → `pnpm bench genkeys` → `pnpm server:ref` →
>   `pnpm bench run --scenario smoke --transport webrtc-mesh`
> - **公開デモ**: <https://vc.thirdlf03.com/> — Chrome/Edge のみ（WebTransport を使用）。
>   実デプロイ手順は [`deploy/README.md`](./deploy/README.md)、ホスト名は `deploy/deploy.env` で変更する。
> - **このコピーで省いたもの**:
>   - `bench/dev-keys/`（開発用 Ed25519 鍵）— 公開リポジトリのため未収録。`pnpm bench genkeys` で再生成する。
>   - コンパイル済みバイナリ（`servers/docker/bin/`, `servers/go_vc/go_vc`,
>     `servers/wt_relay/wt_relay`, `bench/chaos-udp/chaos-udp`）— `go build` / `cargo build` / `zig build` で再生成する。
>   - 生成物（`bench/results/`, `bench/demo/`, `bench/harness/demo/`, `_build/`, `deps/`, `target/`, `zig-out/`）。
>   - 計測用ブラウザ — `pnpm -C bench/harness playwright-install` で別途導入する。

Distance-attenuated voice chat on a three.js 3D space — currently a **benchmark rig** for comparing transports (WebRTC mesh / WS relay / WebTransport / MoQ) and server implementations (Node / Elixir / Rust / Go / …).

## Layout

- `docs/protocol.md` — the server contract every impl must satisfy (WS signaling + optional binary media relay + `/metrics`)
- `docs/metrics.md` — metric schemas (audio one-way latency via marker tones is the headline)
- `docs/evaluation.md` — axes, scenarios, methodology
- `shared/protocol` — TS types/codecs shared by client, servers, harness
- `servers/ref-node` — reference server (correctness oracle)
- `bench/client` — browser client-under-test, pluggable transports
- `bench/harness` — Playwright runner, collector, report, `check-server` contract test

## Quick start

```sh
pnpm install
pnpm -C bench/harness playwright-install   # one-time Chromium
pnpm server:ref                            # terminal 1: ws://localhost:8080
pnpm bench run --scenario smoke --transport webrtc-mesh   # terminal 2
pnpm bench run --scenario smoke --transport ws-relay
pnpm bench run --scenario rooms-10 --transport webrtc-mesh --browsers 10
```

Results land in `bench/results/<ts>-<scenario>-<transport>/` (`metrics.jsonl`, `server-metrics.jsonl`, `summary.json`).

**Harness capacity note**: one browser process saturates around ~10 client pages (real Opus encode/decode + WebAudio). Use `--browsers N` (default `ceil(clients/10)`) to shard pages across Chromium processes. All processes share the machine clock so latency correlation stays valid. Watch client-side saturation artifacts (ctrl-rtt p99 spike = event-loop starvation, not server).

## Adding a server implementation

1. Implement `docs/protocol.md` (any language)
2. `pnpm bench check-server --url ws://localhost:PORT` — must pass
3. Point scenarios at it: `--server ws://localhost:PORT`

## Deploying the demo

`deploy/` puts the walk-in lobby + 3D world + the Elixir vc service + a
`moq-relay` WebTransport relay on one host: TLS via Caddy, a publicly-trusted
certificate for the QUIC relay, production JWT keys outside the repo, systemd
units, and an idempotent `install.sh` (no Docker). See `deploy/README.md`.

```sh
node deploy/verify.mjs https://vc.<domain>                 # protocol contract, no keys needed
node bench/harness/src/deploy-e2e.ts https://vc.<domain>   # two browsers over WebTransport
```

## Position data & spatialization

Out of scope for the VC layer by design — positions flow on the game server's WS; clients attach remote streams to `THREE.PositionalAudio`. See `docs/protocol.md` §5.
