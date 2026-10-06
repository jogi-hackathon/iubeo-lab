# Deploying the public vc demo

Serves the walk-in lobby (`/`), the 3D world client (`/world`) and the vc
service (WebSocket signaling, JWT, room list, moq relay auth) on a single host,
with **moq-lite over WebTransport** as the media transport.

```
browser ──https/wss──▶ Caddy ──▶ vc-web    (node, 127.0.0.1:3000)  lobby + /world
                              └─▶ vc-elixir (bandit, 127.0.0.1:8081) /v1/signaling,
                                                                    /v1/join, /v1/rooms
browser ──QUIC/UDP───▶ moq-relay (:4443, its own Let's Encrypt cert)
                              └─ POST /v1/moq/auth ──▶ vc-elixir  (room-scoped grant)
```

## Requirements

- Ubuntu 24.04 (or similar) with root, and the distro `erlang`/`elixir` are
  **too old** (the code needs OTP 27+ for `:json`), so the toolchain is
  installed under `/opt` from prebuilt releases — no Docker.
- Two DNS records pointing at the host, **Cloudflare proxy OFF (DNS only)**:
  - `vc.<domain>` — HTTPS + WSS. Proxying is fine functionally, but ACME
    HTTP-01 is simpler and lower-latency for a VC demo without it.
  - `media.<domain>` — must be DNS only: WebTransport is UDP, which the
    Cloudflare proxy does not forward to an origin.
- Inbound `80/tcp`, `443/tcp`, `4443/udp` (install.sh adds the ufw rules when
  ufw is active; open them in the provider's panel too).

## Install / update

```sh
# from your workstation
rsync -az --delete \
  --exclude node_modules --exclude .devenv --exclude .git \
  --exclude bench/results --exclude bench/demo --exclude bench/dev-keys \
  --exclude logs --exclude _build --exclude deps --exclude '*.log' \
  ./ root@<host>:/opt/vc/

ssh root@<host> 'chmod +x /opt/vc/deploy/*.sh && /opt/vc/deploy/install.sh'
```

`install.sh` is idempotent. It installs Node/OTP/Elixir/moq-relay if missing,
generates production JWT keys under `/etc/vc/keys`, installs the Caddy config and
the three systemd units, obtains the media certificate with certbot (webroot
through Caddy, so it can share port 80), and restarts the services.

## Verify

```sh
node deploy/verify.mjs https://vc.<domain>          # protocol contract, no keys needed
node bench/harness/src/deploy-e2e.ts https://vc.<domain>   # two browsers over WebTransport
ssh root@<host> 'systemctl status vc-elixir vc-web moq-relay'
```

`verify.mjs` uses the server's own `POST /v1/join` to mint tokens, so it works
without the private key. The e2e script launches headless Chromium, walks two
clients in through the lobby path, and asserts that Opus frames are published
and decoded across the relay.

## Configuration

`deploy/deploy.env` holds the hostnames, the UDP port, the ACME email and the
pinned toolchain versions. `install.sh` substitutes them into
`deploy/Caddyfile.tmpl` and `deploy/systemd/*.service`.

| service | listens | notes |
|---|---|---|
| `vc-elixir` | `127.0.0.1:8081` | reads `/etc/vc/keys/{public,private}.jwk` via `VC_PUBLIC_KEY_PATH` / `VC_PRIVATE_KEY_PATH` |
| `vc-web` | `127.0.0.1:3000` | bakes `window.__VC_CFG` from `VC_SERVER` / `VC_MEDIA` / `VC_TRANSPORT` |
| `moq-relay` | `0.0.0.0:4443/udp` | `--listen-version moq-lite-06` (the revision the bench rig was verified against) |
| `caddy` | `:80`, `:443` | TLS, WSS, ACME webroot for the media cert |

## Certificates

`vc.<domain>` is issued and renewed by Caddy automatically. `media.<domain>` is
issued by certbot into `/etc/letsencrypt/live/media.<domain>/`; the
`deploy/renew-hook.sh` deploy hook copies the pair to `/etc/vc/tls/` (readable by
the `vc` user) and restarts `moq-relay`. `certbot.timer` runs the renewal, so no
extra cron is needed.

The client deliberately does **not** pin the relay certificate
(`VC_WTHASH` unset): Chrome rejects a pinned certificate whose validity exceeds
14 days, which every Let's Encrypt certificate does. Pinning still works for
self-signed dev certs by setting `VC_WTHASH`.

## Notes

- Production keys are generated per host and never live in the repo. The
  committed `bench/dev-keys/` pair is dev-only; the deploy excludes it and
  points the service at `/etc/vc/keys` instead.
- `/v1/join` is an unauthenticated demo endpoint (anyone gets a room-scoped
  JWT). Put it behind auth or remove it before using this as anything but a demo.
- Room membership still comes from the JWT `room` claim, and moq-relay only
  grants publish/subscribe inside that room, so peers cannot eavesdrop across
  rooms.
