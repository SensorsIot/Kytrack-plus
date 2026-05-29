#!/bin/bash
# Restart rtl_tcp when its TCP socket stops sending bytes.
#
# A wedged librtlsdr keeps the TCP listener alive but stops issuing USB bulk
# transfers, so liveness checks (PID running, socket connected) all pass while
# zero IQ samples flow. The kernel's tcp_info bytes_sent counter on the
# rtl_tcp listening port is the authoritative throughput signal: ~4 MB/s when
# healthy, exactly 0 when wedged. We sample it twice with a sleep in between;
# if the delta is below the threshold we kill rtl_tcp and re-issue its
# original argv into the dxlAPRS screen window so it relaunches in place.
#
# bytes_sent is per-connection: it resets to ~0 whenever the rtl_tcp socket
# is re-established (e.g. kycal-cron takes the dongle for PPM calibration,
# or rtl_tcp itself is restarted). That makes the delta go NEGATIVE, which
# is a counter reset, not a wedge (a real wedge is delta ~= 0). We must not
# restart on a negative delta — doing so let kycal's twice-daily teardown
# trigger a self-amplifying restart storm. A negative delta just means
# "re-baseline next cycle".
set -u

INTERVAL="${INTERVAL:-30}"
MIN_BYTES="${MIN_BYTES:-1000000}"
GRACE="${GRACE:-60}"

# port  device  screen_session  window
WATCH=(
  "1234 0 dxl rtl_tcp"
  "1235 1 dxl_sdr2 rtl_tcp"
)

log() { logger -t kytrack-sdr-watchdog -- "$*"; printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }

bytes_for_port() {
  ss -tin "src :$1" 2>/dev/null | grep -oE 'bytes_sent:[0-9]+' | head -1 | cut -d: -f2
}

pid_for_device() {
  ps -C rtl_tcp -o pid=,args= 2>/dev/null | awk -v d="$1" '$0 ~ "-d "d" "{print $1; exit}'
}

restart_dongle() {
  local device="$1" session="$2" window="$3" pid cmd
  pid=$(pid_for_device "$device")
  if [ -z "$pid" ]; then
    log "rtl_tcp -d $device not running, nothing to restart"
    return 1
  fi
  cmd=$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')
  if [ -z "$cmd" ]; then
    log "could not capture argv for pid $pid"
    return 1
  fi
  log "restarting SDR $device (pid=$pid): $cmd"
  kill -INT "$pid" 2>/dev/null
  sleep 2
  kill -KILL "$pid" 2>/dev/null
  sleep 3
  if screen -S "$session" -p "$window" -X stuff "$cmd"$'\n'; then
    log "respawn issued in screen $session/$window"
  else
    log "screen stuff failed for $session/$window"
    return 1
  fi
}

declare -A before
declare -A restart_at

log "watchdog started (interval=${INTERVAL}s, min=${MIN_BYTES}B, grace=${GRACE}s)"

while true; do
  for entry in "${WATCH[@]}"; do
    read -r port device session window <<<"$entry"
    before[$port]=$(bytes_for_port "$port")
  done
  sleep "$INTERVAL"
  now=$(date +%s)
  for entry in "${WATCH[@]}"; do
    read -r port device session window <<<"$entry"
    if [ -n "${restart_at[$port]:-}" ] && [ "$((now - restart_at[$port]))" -lt "$GRACE" ]; then
      continue
    fi
    a="${before[$port]:-}"
    b=$(bytes_for_port "$port")
    if [ -z "$a" ] || [ -z "$b" ]; then
      continue
    fi
    delta=$(( b - a ))
    if [ "$delta" -lt 0 ]; then
      # Counter reset: the rtl_tcp connection was re-established (kycal took
      # the dongle, or rtl_tcp restarted). Not a wedge — skip; the top of the
      # loop re-baselines before[$port] for the next cycle.
      log "SDR $device port $port counter reset (Δ=${delta} B); no action"
      continue
    fi
    if [ "$delta" -lt "$MIN_BYTES" ]; then
      log "SDR $device port $port wedged (Δ=${delta} B over ${INTERVAL}s)"
      if restart_dongle "$device" "$session" "$window"; then
        restart_at[$port]=$now
      fi
    fi
  done
done
