#!/bin/bash
# sonde_ab_logger.sh — per-SDR A/B capture for one Payerne flight.
#
# Triggered by cron at 11:00 UTC and 23:00 UTC.
# Captures:
#   - UDP 4000 (sondeudp -> sondemod): every demodulated frame, with source
#     port so frames are attributable to SDR1 vs SDR2.
#   - UDP 4010 (sondemod -> udpgate4): every successfully decoded sonde frame
#     ready for APRS-IS upload. Used as the "is the balloon still alive?"
#     signal.
# Stops 15 min after the last decoded sonde frame on UDP 4010, or after a
# 2 h wait if no decode ever arrives.

set -u

LOGDIR=/home/pi/sonde_ab_logs
mkdir -p "$LOGDIR"

LOCKFILE=/tmp/sonde_ab_logger.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    echo "Another logger is running; exiting."
    exit 0
fi

TS=$(date -u +%Y%m%d-%H%M)
HR=$(date -u +%H)
case "$HR" in
    10|11|12) WINDOW="payerne-11utc" ;;
    22|23|00) WINDOW="payerne-23utc" ;;
    *)        WINDOW="window-${HR}utc" ;;
esac

BASE="$LOGDIR/${TS}-${WINDOW}"
META="${BASE}.meta.txt"
LOG4000="${BASE}.udp4000.log"
LOG4010="${BASE}.udp4010.log"

write_meta() {
    {
        echo "=== Sonde A/B logger ==="
        echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "Local:   $(date '+%Y-%m-%dT%H:%M:%S %Z')"
        echo "Host:    $(hostname)"
        echo
        echo "--- frequency_1.txt (SDR1) ---"
        cat /opt/dxlAPRS/setup/frequency_1.txt
        echo "--- frequency_2.txt (SDR2) ---"
        cat /opt/dxlAPRS/setup/frequency_2.txt
        echo
        echo "--- sondeudp processes (per-SDR identification) ---"
        for pid in $(pgrep sondeudp); do
            cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
            fifo=$(echo "$cmd" | grep -oE 'audio_buffer[_0-9]*\.fifo' | head -1)
            # sondeudp opens its outbound UDP socket on fd 3 (-S 3).
            # Read inode from /proc/<pid>/fd/3, then look it up in
            # /proc/<pid>/net/udp to get the local source port.
            port=""
            inode=$(readlink "/proc/$pid/fd/3" 2>/dev/null | grep -oE '[0-9]+' | head -1)
            if [ -n "$inode" ]; then
                port_hex=$(awk -v inode="$inode" '$10==inode{split($2,a,":"); print a[2]; exit}' "/proc/$pid/net/udp" 2>/dev/null)
                [ -n "$port_hex" ] && port=$((16#$port_hex))
            fi
            echo "pid=$pid fifo=$fifo src_port=$port"
        done
        echo
    } > "$META"
}

cleanup() {
    kill "$PID_4000" "$PID_4010" 2>/dev/null || true
    wait 2>/dev/null || true
    sync
    {
        echo
        echo "=== Stopped: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        echo
        echo "--- per source-port frame count (UDP 4000, sondeudp -> sondemod) ---"
        # column 3 in '-tttt' output is the source 'ip.port'
        awk '/IP /{print $3}' "$LOG4000" 2>/dev/null \
            | sort | uniq -c | sort -rn
        echo
        echo "--- decoded sonde frame count (UDP 4010, sondemod -> udpgate4) ---"
        wc -l < "$LOG4010" 2>/dev/null || echo 0
        echo
        echo "--- first/last decoded sonde lines ---"
        head -1 "$LOG4010" 2>/dev/null || true
        tail -1 "$LOG4010" 2>/dev/null || true
    } >> "$META"
}
trap cleanup EXIT INT TERM

write_meta

# Start packet captures. Text mode, line-buffered, immediate delivery, with
# microsecond absolute timestamps for parseability.
tcpdump -i lo -n -l --immediate-mode -tttt udp port 4000 > "$LOG4000" 2>/dev/null &
PID_4000=$!
tcpdump -i lo -n -l --immediate-mode -tttt udp port 4010 > "$LOG4010" 2>/dev/null &
PID_4010=$!

# Verify both tcpdumps came up
read -r -t 2 _ < /dev/null 2>/dev/null || true
if ! kill -0 "$PID_4000" 2>/dev/null || ! kill -0 "$PID_4010" 2>/dev/null; then
    echo "tcpdump failed to start; aborting." >> "$META"
    exit 1
fi

MAX_WAIT_FOR_FIRST_SEC=${MAX_WAIT_FOR_FIRST_SEC:-$((2 * 3600))}   # default 2h
SILENCE_TIMEOUT_SEC=${SILENCE_TIMEOUT_SEC:-$((15 * 60))}          # default 15 min
POLL_SEC=${POLL_SEC:-10}

start_unix=$(date -u +%s)

while true; do
    read -r -t "$POLL_SEC" _ < /dev/null 2>/dev/null || true

    if [ ! -s "$LOG4010" ]; then
        elapsed=$(($(date -u +%s) - start_unix))
        if [ "$elapsed" -gt "$MAX_WAIT_FOR_FIRST_SEC" ]; then
            echo "No UDP 4010 decode in ${MAX_WAIT_FOR_FIRST_SEC}s. Giving up." >> "$META"
            break
        fi
        continue
    fi

    # Parse timestamp of last decoded packet
    # Format: 'YYYY-MM-DD HH:MM:SS.uuuuuu IP 127.0.0.1.X > 127.0.0.1.4010: ...'
    last_line=$(tail -1 "$LOG4010")
    last_ts_str=$(echo "$last_line" | awk '{print $1, $2}' | cut -d. -f1)
    last_unix=$(date -u -d "$last_ts_str UTC" +%s 2>/dev/null || true)
    if [ -z "$last_unix" ]; then
        continue
    fi

    now_unix=$(date -u +%s)
    silence=$((now_unix - last_unix))
    if [ "$silence" -gt "$SILENCE_TIMEOUT_SEC" ]; then
        echo "Silence ${silence}s on UDP 4010 exceeds ${SILENCE_TIMEOUT_SEC}s. Stopping." >> "$META"
        break
    fi
done
