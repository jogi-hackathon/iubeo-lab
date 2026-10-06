#!/usr/bin/env bash
# certbot --deploy-hook: copy the media certificate where the moq-relay service
# (user vc) can read it, then restart the relay so it picks the new cert up.
#
# Installed by deploy/install.sh as the renewal deploy hook, so it also runs on
# the first issuance. RENEWED_LINEAGE is set by certbot.
set -euo pipefail

: "${RENEWED_LINEAGE:?this hook is run by certbot}"

install -d -m 0750 -o root -g vc /etc/vc/tls
# install(1) opens the source path, so it follows the symlink into
# /etc/letsencrypt/archive and the relay gets a stable regular file rather than
# a link into a root-only tree.
install -m 0640 -o root -g vc "$RENEWED_LINEAGE/fullchain.pem" /etc/vc/tls/fullchain.pem
install -m 0640 -o root -g vc "$RENEWED_LINEAGE/privkey.pem" /etc/vc/tls/privkey.pem

# The hook can run before the unit exists (first install); that is not a failure.
systemctl restart moq-relay.service || true
echo "[renew-hook] published $RENEWED_LINEAGE to /etc/vc/tls"
