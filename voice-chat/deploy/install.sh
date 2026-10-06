#!/usr/bin/env bash
# Install (or update) the public vc demo on this host.
#
#   sudo deploy/install.sh
#
# Idempotent: re-run it after rsyncing a new tree. Reads deploy/deploy.env.
# Installs the toolchain under /opt (no distro packages for Node/OTP/Elixir,
# whose Ubuntu 24.04 versions are too old for this code), generates production
# JWT keys, obtains the media certificate, and (re)starts the three services.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_DIR/deploy/deploy.env"

: "${VC_HOST:?VC_HOST missing in deploy/deploy.env}"
: "${MEDIA_HOST:?MEDIA_HOST missing in deploy/deploy.env}"
WT_PORT="${WT_PORT:-4443}"
ACME_EMAIL="${ACME_EMAIL:-}"
OTP_URL="${OTP_URL:?OTP_URL missing in deploy/deploy.env}"
ELIXIR_VERSION="${ELIXIR_VERSION:-1.20.4}"
ELIXIR_OTP="${ELIXIR_OTP:-29}"
NODE_VERSION="${NODE_VERSION:-24.21.0}"
MOQ_RELAY_VERSION="${MOQ_RELAY_VERSION:-0.17.1}"
MOQ_LISTEN_VERSION="${MOQ_LISTEN_VERSION:-moq-lite-06}"

OTP_DIR=/opt/otp
ELIXIR_DIR=/opt/elixir
NODE_DIR=/opt/node
VC_USER=vc
VC_HOME=/var/lib/vc
ETC=/etc/vc
KEYS="$ETC/keys"
TLS="$ETC/tls"
ACME_ROOT=/var/www/acme
SERVICES=(vc-elixir vc-web moq-relay)

[ "$(id -u)" = 0 ] || { echo "run as root: sudo deploy/install.sh" >&2; exit 1; }

case "$(dpkg --print-architecture)" in
	amd64) NODE_ARCH=x64;  MOQ_ARCH=x86_64-unknown-linux-gnu ;;
	arm64) NODE_ARCH=arm64; MOQ_ARCH=aarch64-unknown-linux-gnu ;;
	*) echo "unsupported architecture" >&2; exit 1 ;;
esac

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Run a shell command line as the vc user (from $2, default the repo root).
as_vc() {
	local cmd="$1" wd="${2:-$REPO_DIR}"
	runuser -u "$VC_USER" -- env \
		HOME="$VC_HOME" MIX_HOME="$VC_HOME/.mix" HEX_HOME="$VC_HOME/.hex" MIX_ENV=prod \
		PATH="$ELIXIR_DIR/bin:$OTP_DIR/bin:$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
		sh -c "cd '$wd' && $cmd"
}

# ---------------------------------------------------------------- host packages
log "host packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl unzip xz-utils caddy certbot

if ufw status 2>/dev/null | grep -q 'Status: active'; then
	log "ufw: allowing 80/tcp 443/tcp $WT_PORT/udp"
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw allow "$WT_PORT"/udp >/dev/null
fi

# moq-relay asks the kernel for 8MiB UDP buffers; the default 208KiB makes it
# warn and drops datagrams under fan-out. Raise the ceiling it can ask for.
log "UDP socket buffers"
cat > /etc/sysctl.d/99-vc-udp.conf <<'SYSCTL'
net.core.rmem_max = 8388608
net.core.wmem_max = 8388608
SYSCTL
sysctl -q --system

# ------------------------------------------------------------------ toolchain
if [ ! -x "$NODE_DIR/bin/node" ]; then
	log "installing Node $NODE_VERSION"
	curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
	rm -rf "/opt/node-v$NODE_VERSION-linux-$NODE_ARCH"
	tar -xJf /tmp/node.tar.xz -C /opt
	ln -sfn "/opt/node-v$NODE_VERSION-linux-$NODE_ARCH" "$NODE_DIR"
	for b in node npm npx; do ln -sfn "$NODE_DIR/bin/$b" "/usr/local/bin/$b"; done
	"$NODE_DIR/bin/npm" install -g pnpm@10 >/dev/null
fi
ln -sfn "$NODE_DIR/bin/pnpm" /usr/local/bin/pnpm

if [ ! -x "$OTP_DIR/bin/erl" ]; then
	log "installing OTP (erlef prebuilt)"
	curl -fsSL -o /tmp/otp.tar.gz "$OTP_URL"
	rm -rf "$OTP_DIR"; mkdir -p "$OTP_DIR"
	tar -xzf /tmp/otp.tar.gz -C "$OTP_DIR" --strip-components=1
fi
log "OTP: $("$OTP_DIR/bin/erl" -noshell -eval 'io:format("~s",[erlang:system_info(otp_release)]),halt().')"

if [ ! -x "$ELIXIR_DIR/bin/elixir" ]; then
	log "installing Elixir $ELIXIR_VERSION (OTP $ELIXIR_OTP)"
	curl -fsSL -o /tmp/elixir.zip \
		"https://github.com/elixir-lang/elixir/releases/download/v$ELIXIR_VERSION/elixir-otp-$ELIXIR_OTP.zip"
	rm -rf "$ELIXIR_DIR"; mkdir -p "$ELIXIR_DIR"
	unzip -q /tmp/elixir.zip -d "$ELIXIR_DIR"
	for b in elixir elixirc mix iex; do
		[ -e "$ELIXIR_DIR/bin/$b" ] && ln -sfn "$ELIXIR_DIR/bin/$b" "/usr/local/bin/$b"
	done
fi

if ! /usr/local/bin/moq-relay --version 2>/dev/null | grep -q "$MOQ_RELAY_VERSION"; then
	log "installing moq-relay $MOQ_RELAY_VERSION"
	curl -fsSL -o /usr/local/bin/moq-relay \
		"https://github.com/moq-dev/moq/releases/download/moq-relay-v$MOQ_RELAY_VERSION/moq-relay-v$MOQ_RELAY_VERSION-$MOQ_ARCH"
	chmod 0755 /usr/local/bin/moq-relay
fi

# -------------------------------------------------------------- user and dirs
id -u "$VC_USER" >/dev/null 2>&1 || \
	useradd --system --create-home --home-dir "$VC_HOME" --shell /usr/sbin/nologin "$VC_USER"
install -d -m 0755 "$ETC" "$ACME_ROOT"
install -d -m 0750 -o root -g "$VC_USER" "$KEYS" "$TLS"
install -d -m 0755 -o "$VC_USER" -g "$VC_USER" "$VC_HOME"

# ------------------------------------------------------------- production keys
log "production JWT keys"
"$NODE_DIR/bin/node" "$REPO_DIR/deploy/genkeys.mjs" "$KEYS"
chown root:"$VC_USER" "$KEYS"/*.jwk
chmod 0640 "$KEYS/private.jwk"
chmod 0644 "$KEYS/public.jwk"

# ------------------------------------------------------------------ app build
log "pnpm install"
chown -R "$VC_USER:$VC_USER" "$REPO_DIR"
as_vc "pnpm install"

log "mix deps.get + compile"
as_vc "mix local.hex --force >/dev/null && mix local.rebar --force >/dev/null"
as_vc "mix deps.get && mix compile" "$REPO_DIR/servers/elixir_vc"

# --------------------------------------------------------------------- caddy
log "caddy config"
GLOBAL_BLOCK=""
[ -n "$ACME_EMAIL" ] && GLOBAL_BLOCK="{ email $ACME_EMAIL }"
sed -e "s|@GLOBAL_BLOCK@|$GLOBAL_BLOCK|" \
	-e "s|@VC_HOST@|$VC_HOST|g" \
	-e "s|@MEDIA_HOST@|$MEDIA_HOST|g" \
	-e "s|@WT_PORT@|$WT_PORT|g" \
	"$REPO_DIR/deploy/Caddyfile.tmpl" > /etc/caddy/Caddyfile

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
for _ in $(seq 1 30); do
	ss -ltn 2>/dev/null | grep -q ':80 ' && break
	sleep 1
done

# -------------------------------------------------------------------- systemd
log "systemd units"
for u in "${SERVICES[@]}"; do
	sed -e "s|@VC_HOST@|$VC_HOST|g" \
		-e "s|@MEDIA_HOST@|$MEDIA_HOST|g" \
		-e "s|@WT_PORT@|$WT_PORT|g" \
		-e "s|@MOQ_LISTEN_VERSION@|$MOQ_LISTEN_VERSION|g" \
		"$REPO_DIR/deploy/systemd/$u.service" > "/etc/systemd/system/$u.service"
done
systemctl daemon-reload
systemctl enable "${SERVICES[@]}" >/dev/null 2>&1 || true
systemctl restart vc-elixir.service vc-web.service

# ------------------------------------------------------------------ media cert
# HTTP-01 needs inbound 80/tcp to reach this host. A failure here is NOT fatal:
# the lobby, the world page and signaling come up regardless, and re-running
# install.sh finishes the relay once the provider's firewall is open.
log "media certificate for $MEDIA_HOST"
if [ -f "/etc/letsencrypt/live/$MEDIA_HOST/fullchain.pem" ]; then
	RENEWED_LINEAGE="/etc/letsencrypt/live/$MEDIA_HOST" "$REPO_DIR/deploy/renew-hook.sh"
else
	EMAIL_ARGS=(--register-unsafely-without-email)
	[ -n "$ACME_EMAIL" ] && EMAIL_ARGS=(-m "$ACME_EMAIL")
	if certbot certonly --webroot -w "$ACME_ROOT" -d "$MEDIA_HOST" \
		--non-interactive --agree-tos "${EMAIL_ARGS[@]}" \
		--deploy-hook "$REPO_DIR/deploy/renew-hook.sh"; then
		log "media certificate issued"
	else
		echo "!! certbot could not validate $MEDIA_HOST." >&2
		echo "!! is inbound 80/tcp open at the provider (not just ufw)?" >&2
		echo "!! the lobby works without it; re-run deploy/install.sh once it is open." >&2
	fi
fi
systemctl restart moq-relay.service || true

log "done"
echo "  lobby : https://$VC_HOST/"
echo "  media : https://$MEDIA_HOST:$WT_PORT/  (WebTransport, QUIC/UDP)"
echo
echo "  systemctl status vc-elixir vc-web moq-relay"
echo "  node deploy/verify.mjs https://$VC_HOST"
