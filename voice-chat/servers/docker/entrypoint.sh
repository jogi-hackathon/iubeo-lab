#!/bin/sh
# Applies netem impairment on eth0 egress (server->client direction) then runs
# the requested servers. Env: DELAY_MS JITTER_MS LOSS_PCT, RUN="go_vc wt_relay"
set -e

if [ -n "$DELAY_MS" ] || [ -n "$LOSS_PCT" ]; then
  DELAY_PART=""
  [ -n "$DELAY_MS" ] && DELAY_PART="delay ${DELAY_MS}ms ${JITTER_MS:-0}ms"
  LOSS_PART=""
  [ -n "$LOSS_PCT" ] && LOSS_PART="loss ${LOSS_PCT}%"
  # shellcheck disable=SC2086
  tc qdisc add dev eth0 root netem $DELAY_PART $LOSS_PART
  echo "[netem] eth0 egress: $DELAY_PART $LOSS_PART"
fi

export VC_PUBLIC_KEY_PATH=/keys/public.jwk

case " $RUN " in
  *" go_vc "*) PORT=8082 go_vc & ;;
esac
case " $RUN " in
  *" wt_relay "*) PORT=8090 CTRL_PORT=8091 wt_relay & ;;
esac

wait
