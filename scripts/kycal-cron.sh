#!/bin/bash
# kycal-cron.sh — pre-launch PPM calibration orchestrator (iterative).
#
# For each dongle: measure → if not converged take a damped step → restart
# chain → re-measure. Loop stops on convergence, no-improvement, or max
# iterations. Telegram alert only when the final residual is unacceptable
# AND a second consecutive cycle also fails. Self-heal stays silent per
# alert policy.
#
# Configuration is sourced from /home/pi/.kycal/config (mode 600).

set -u
shopt -s lastpipe

CONFIG=/home/pi/.kycal/config
STATE_DIR=/home/pi/.kycal
STATE=${STATE_DIR}/state.json
HISTORY=/home/pi/kycal-history.csv
LOG=/home/pi/kycal-history.log
KYCAL=/home/pi/kycal.py
USER_INFO=/opt/dxlAPRS/setup/user_info.txt
USER_INFO_BAK=${USER_INFO}.kycal.bak

# Reference and FFT. Production: POLYCOM TETRA channel at 394.6875 MHz
# (Swiss emergency network, regulated to ≤0.05 ppm). For sonde-based
# testing, override at invocation time: POLYCOM_REF=403.500e6 kycal-cron.sh
POLYCOM_REF=${POLYCOM_REF:-394.6875e6}
FFT_SIZE=${FFT_SIZE:-1048576}
SEARCH_BW=${SEARCH_BW:-30000}
POST_RESTART_SLEEP=${POST_RESTART_SLEEP:-25}
# Squelch: reject low-SNR kycal results. ≥30 dB cleanly separates real
# locks from noise (POLYCOM ~46 dB, sonde ~50 dB, noise <25 dB).
MIN_SNR_DB=${MIN_SNR_DB:-30}

# Iteration control.
MAX_ITERATIONS=${MAX_ITERATIONS:-5}
CONVERGED_PPM=${CONVERGED_PPM:-0.5}          # |residual| at-or-below this = ok
QUANTIZED_OK_PPM=${QUANTIZED_OK_PPM:-1.5}    # acceptable if no-improvement landed here
DAMPING=${DAMPING:-0.7}                       # apply 0.7×residual per step
MAX_STEP=${MAX_STEP:-5}                       # cap per-iteration X change
ALERT_THRESHOLD_FAILURES=${ALERT_THRESHOLD_FAILURES:-2}

# POLYCOM may be idle for minutes at quiet times (esp. ~23 UTC = 01 CEST).
# Wait up to this long for a usable burst; if none arrives, keep the prior
# calibration silently (no alarm) — last cycle's value is still valid.
POLYCOM_WAIT_SECONDS=${POLYCOM_WAIT_SECONDS:-600}
# After a chain restart (verification iter), POLYCOM was loud just minutes
# ago — should reappear quickly. Cap the wait so a long-quiet period doesn't
# stall the whole cron cycle.
POLYCOM_RETRY_WAIT_SECONDS=${POLYCOM_RETRY_WAIT_SECONDS:-90}

mkdir -p "$STATE_DIR"

if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
fi

log() {
    printf "[%s] %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

# Telegram helper. Silent if creds missing or send fails (logs only).
notify_telegram() {
    local text="$1"
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
        log "Telegram creds missing in $CONFIG; cannot notify"
        return 1
    fi
    local rc
    curl -fsS -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${text}" \
        --data-urlencode "parse_mode=Markdown"
    rc=$?
    if [ $rc -ne 0 ]; then
        log "Telegram send failed rc=$rc"
        return 2
    fi
}

# State I/O.
state_load() {
    if [ -f "$STATE" ]; then
        ALERT_SENT=$(python3 -c "import json; print(json.load(open('$STATE')).get('alert_sent', False))")
        CONSEC_FAILURES=$(python3 -c "import json; print(json.load(open('$STATE')).get('consec_failures', 0))")
    else
        ALERT_SENT=False
        CONSEC_FAILURES=0
    fi
}

state_save() {
    python3 - <<PYEOF
import json, time
json.dump({
    "alert_sent": ${1},
    "consec_failures": ${2},
    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}, open("$STATE", "w"))
PYEOF
}

# PIDs of processes named $1 whose cmdline contains substring $2.
# /proc scan avoids pgrep self-match risk.
pids_matching() {
    local procname="$1" needle="$2"
    local p cl
    for p in $(pidof "$procname" 2>/dev/null); do
        cl=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
        case " $cl " in
            *"$needle"*) printf '%s ' "$p" ;;
        esac
    done
}

# TERM → wait → KILL escalator. Returns 0 only when no matches remain.
# A bare `kill` (SIGTERM) used to be fire-and-forget: if sdrtst didn't exit
# in time we proceeded to spawn a replacement, ending up with two writers
# on the same FIFO and an eventual orphan.
kill_matching() {
    local procname="$1" needle="$2" tag="$3"
    local pids p i
    pids=$(pids_matching "$procname" "$needle")
    [ -z "$pids" ] && return 0
    log "[$tag] killing $procname '$needle': $pids"
    for p in $pids; do kill "$p" 2>/dev/null; done
    for i in 1 2 3 4 5 6; do
        sleep 0.5
        pids=$(pids_matching "$procname" "$needle")
        [ -z "$pids" ] && return 0
    done
    log "[$tag] SIGTERM ineffective, escalating to SIGKILL on: $pids"
    for p in $pids; do kill -9 "$p" 2>/dev/null; done
    sleep 1
    pids=$(pids_matching "$procname" "$needle")
    if [ -n "$pids" ]; then
        log "[$tag] WARNING: still alive after SIGKILL: $pids"
        return 1
    fi
    return 0
}

kill_rtl_tcp_for_device() {
    kill_matching rtl_tcp " -d $1 " "rtl_tcp d=$1"
}

kill_sdrtst_for_port() {
    kill_matching sdrtst "127.0.0.1:$1" "sdrtst p=$1"
}

# Start helpers refuse to spawn if a matching process is already running —
# prevents duplicate writers on the audio FIFO when restart_chain has
# already brought the process back.
start_rtl_tcp() {
    local idx="$1" port="$2" ppm="$3"
    local existing
    existing=$(pids_matching rtl_tcp " -d $idx ")
    if [ -n "$existing" ]; then
        log "[rtl_tcp d=$idx] already running ($existing); not spawning duplicate"
        return 0
    fi
    nohup rtl_tcp -d "$idx" -a 127.0.0.1 -p "$port" -g 0 -b 20 -P "$ppm" \
        > "/tmp/rtl_tcp_d${idx}.log" 2>&1 < /dev/null &
    disown
}

start_sdrtst() {
    local idx="$1" port="$2" cfg="$3" fifo="$4"
    local existing
    existing=$(pids_matching sdrtst "127.0.0.1:$port")
    if [ -n "$existing" ]; then
        log "[sdrtst p=$port] already running ($existing); not spawning duplicate"
        return 0
    fi
    nohup /opt/dxlAPRS/bin/sdrtst \
        -c "/opt/dxlAPRS/config/$cfg" \
        -t "127.0.0.1:$port" \
        -r 25000 -k -v \
        -s "/opt/dxlAPRS/tmp/$fifo" \
        > "/tmp/sdrtst_${idx}.log" 2>&1 < /dev/null &
    disown
}

# Verify exactly one rtl_tcp per device and one sdrtst per port.
# Prune duplicates (keep the oldest by start time). Logs missing instances.
audit_chain() {
    local tag="${1:-audit}"
    local idx port pids count keep p
    for idx in 0 1; do
        case "$idx" in
            0) port=1234 ;;
            1) port=1235 ;;
        esac
        pids=$(pids_matching rtl_tcp " -d $idx ")
        count=$(echo $pids | wc -w)
        if [ "$count" -gt 1 ]; then
            keep=$(ps -o pid=,etimes= -p $pids 2>/dev/null | sort -k2 -n -r | head -1 | awk '{print $1}')
            log "[$tag] duplicate rtl_tcp d=$idx: $pids — keeping oldest=$keep"
            for p in $pids; do
                [ "$p" = "$keep" ] && continue
                kill "$p" 2>/dev/null
            done
        elif [ "$count" -eq 0 ]; then
            log "[$tag] no rtl_tcp for d=$idx"
        fi
        pids=$(pids_matching sdrtst "127.0.0.1:$port")
        count=$(echo $pids | wc -w)
        if [ "$count" -gt 1 ]; then
            keep=$(ps -o pid=,etimes= -p $pids 2>/dev/null | sort -k2 -n -r | head -1 | awk '{print $1}')
            log "[$tag] duplicate sdrtst port=$port: $pids — keeping oldest=$keep"
            for p in $pids; do
                [ "$p" = "$keep" ] && continue
                kill "$p" 2>/dev/null
            done
        elif [ "$count" -eq 0 ]; then
            log "[$tag] no sdrtst for port=$port"
        fi
    done
}

# Run kycal, return the JSON line. Caller is responsible for having
# stopped the current sdrtst (so kycal's TCP socket isn't fighting it).
# `wait_s` (4th arg) — how long kycal will continuously listen for a chunk
# meeting --min-snr before giving up. 0 = single-shot.
measure_dongle() {
    local port="$1" current_ppm="$2" label="$3" wait_s="${4:-0}"
    python3 "$KYCAL" \
        --port "$port" \
        --label "$label" \
        --ppm-corr "$current_ppm" \
        --ref "$POLYCOM_REF" \
        --fft-size "$FFT_SIZE" \
        --search-bw "$SEARCH_BW" \
        --min-snr "$MIN_SNR_DB" \
        --listen-timeout "$wait_s" \
        2>&1
}

# Parse a kycal JSON line into globals: M_OK, M_RAW, M_RES, M_SNR, M_OFFSET.
parse_measurement() {
    local json="$1"
    eval "$(python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    print("M_OK=" + ("true" if d.get("ok") else "false"))
    print("M_RAW=" + str(d.get("raw_ppm", 0)))
    print("M_RES=" + str(d.get("residual_ppm", 0)))
    print("M_SNR=" + str(d.get("snr_db", 0)))
    print("M_OFFSET=" + str(d.get("offset_hz", 0)))
except Exception:
    print("M_OK=false")
    print("M_RAW=0")
    print("M_RES=0")
    print("M_SNR=0")
    print("M_OFFSET=0")
' "$json")"
}

# Restart the whole dxlAPRS chain so a new user_info.txt PPM takes effect.
# We do a full STOP+START because per-dongle restart was flaky. Brief outage
# of the other dongle is acceptable since cron runs 30 min before launch.
restart_chain() {
    /opt/dxlAPRS/scripts/STOP.sh > /dev/null 2>&1
    sleep 3
    nohup /opt/dxlAPRS/scripts/START_SDR_1.sh > /tmp/kycal_sdr1_restart.log 2>&1 < /dev/null &
    disown
    sleep 4
    nohup /opt/dxlAPRS/scripts/START_SDR_2.sh > /tmp/kycal_sdr2_restart.log 2>&1 < /dev/null &
    disown
    sleep "$POST_RESTART_SLEEP"
    audit_chain "post-restart"
}

# Process one dongle by iterating measure → step → restart until one of:
#   converged   — |residual| ≤ CONVERGED_PPM            → OK
#   no_improvement — |residual| didn't shrink this iter:
#       and |residual| ≤ QUANTIZED_OK_PPM               → OK  (quantization-limited)
#       else                                            → FAIL
#   max_iter    — ran MAX_ITERATIONS without converging → FAIL
#   measure_fail — kycal SNR too low (signal absent)    → SKIP (no alarm count)
#
# Echoes one of {OK, SKIP, FAIL} on stdout.
process_dongle() {
    local idx port label cfg fifo line
    idx="$1"
    case "$idx" in
        0) port=1234; label=SDR1; cfg=sdr_config.txt;   fifo=audio_buffer.fifo;   line=22 ;;
        1) port=1235; label=SDR2; cfg=sdr_config_2.txt; fifo=audio_buffer_2.fifo; line=23 ;;
        *) log "process_dongle: bad idx=$idx"; echo FAIL; return 1 ;;
    esac

    local start_ppm current_ppm
    start_ppm=$(sed -n "${line}p" "$USER_INFO" | tr -dc '0-9-')
    : "${start_ppm:=0}"
    current_ppm="$start_ppm"
    log "[$label] starting at PPM=$current_ppm; will listen up to ${POLYCOM_WAIT_SECONDS}s for first usable signal"

    # Iteration loop. Iter 1 listens up to POLYCOM_WAIT_SECONDS (POLYCOM may
    # be quiet at this hour). Later iters use POLYCOM_RETRY_WAIT_SECONDS
    # since the signal was just there.
    local attempt=0
    local prev_abs="" cur_res="" cur_snr=""
    # Track the best (smallest |residual|) PPM seen so we can revert if a
    # later step makes things worse.
    local best_ppm="$start_ppm" best_abs="" best_res="" best_snr=""

    while [ "$attempt" -lt "$MAX_ITERATIONS" ]; do
        attempt=$((attempt + 1))

        kill_sdrtst_for_port "$port"
        sleep 2

        local wait_s="$POLYCOM_RETRY_WAIT_SECONDS"
        [ "$attempt" = "1" ] && wait_s="$POLYCOM_WAIT_SECONDS"

        local m
        m=$(measure_dongle "$port" "$current_ppm" "$label" "$wait_s")
        log "[$label] iter $attempt @PPM=$current_ppm (listened ≤${wait_s}s): $m"
        parse_measurement "$m"

        if [ "$M_OK" != "true" ]; then
            # First iter timed out waiting for POLYCOM → keep prior PPM, no alarm.
            # Later iter timed out → roll back to best.
            local action_name="no_signal_keep_prior"
            [ "$attempt" -gt 1 ] && action_name="measure_fail"
            log "[$label] iter $attempt: no usable signal (last SNR=$M_SNR) — ${action_name}"
            if [ "$current_ppm" != "$best_ppm" ] && [ -n "$best_abs" ]; then
                log "[$label] rolling back PPM $current_ppm -> $best_ppm (best |residual|=$best_abs)"
                sudo sed -i "${line}s/^.*\$/${best_ppm}/" "$USER_INFO"
                restart_chain
                current_ppm="$best_ppm"
            fi
            start_sdrtst "$idx" "$port" "$cfg" "$fifo"
            printf '%s,%s,%s,%s,%s,%s,%s\n' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "$action_name" "$M_RES" "$M_SNR" >> "$HISTORY"
            echo SKIP
            return 0
        fi

        cur_res="$M_RES"; cur_snr="$M_SNR"
        local abs_res
        abs_res=$(python3 -c "print(abs($M_RES))")
        log "[$label] iter $attempt: residual=$cur_res (|=$abs_res) SNR=${cur_snr}dB"

        # Update best if this is the smallest |residual| seen so far.
        if [ -z "$best_abs" ] || python3 -c "import sys; sys.exit(0 if $abs_res < $best_abs else 1)"; then
            best_ppm="$current_ppm"
            best_abs="$abs_res"
            best_res="$cur_res"
            best_snr="$cur_snr"
            log "[$label] new best: PPM=$best_ppm |residual|=$best_abs"
        fi

        # Converged?
        if python3 -c "import sys; sys.exit(0 if $abs_res <= $CONVERGED_PPM else 1)"; then
            start_sdrtst "$idx" "$port" "$cfg" "$fifo"
            local action="updated"
            [ "$current_ppm" = "$start_ppm" ] && action="skip"
            log "[$label] CONVERGED at iter $attempt: PPM $start_ppm -> $current_ppm, residual=$cur_res"
            printf '%s,%s,%s,%s,%s,%s,%s\n' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "$action" "$cur_res" "$cur_snr" >> "$HISTORY"
            echo OK
            return 0
        fi

        # No improvement vs previous iter? (Only after we've taken at least one step.)
        if [ -n "$prev_abs" ]; then
            if python3 -c "import sys; sys.exit(0 if $abs_res >= $prev_abs else 1)"; then
                log "[$label] NO_IMPROVEMENT: residual=$cur_res (|=$abs_res) is no better than prev $prev_abs"
                # Roll back to best PPM seen so we never leave the chain worse off.
                if [ "$best_ppm" != "$current_ppm" ]; then
                    log "[$label] rolling back PPM $current_ppm -> $best_ppm (best |residual|=$best_abs)"
                    sudo sed -i "${line}s/^.*\$/${best_ppm}/" "$USER_INFO"
                    restart_chain
                    current_ppm="$best_ppm"
                    cur_res="$best_res"
                    cur_snr="$best_snr"
                    abs_res="$best_abs"
                fi
                start_sdrtst "$idx" "$port" "$cfg" "$fifo"
                if python3 -c "import sys; sys.exit(0 if $abs_res <= $QUANTIZED_OK_PPM else 1)"; then
                    log "[$label] stopping with best |residual|=$abs_res <= $QUANTIZED_OK_PPM: OK"
                    printf '%s,%s,%s,%s,%s,%s,%s\n' \
                        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "quantized_ok" "$cur_res" "$cur_snr" >> "$HISTORY"
                    echo OK
                    return 0
                fi
                printf '%s,%s,%s,%s,%s,%s,%s\n' \
                    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "no_improvement" "$cur_res" "$cur_snr" >> "$HISTORY"
                echo FAIL
                return 1
            fi
        fi

        # Take a damped step toward zero. round() then cap at MAX_STEP.
        # Force at least 1 in the correct direction so we always make progress.
        local step
        step=$(python3 -c "
r=$M_RES; d=$DAMPING; m=$MAX_STEP
s=round(d*r)
s=max(-m, min(m, s))
if s==0:
    s = 1 if r>0 else -1
print(s)
")
        local new_ppm=$((current_ppm - step))
        log "[$label] iter $attempt: step=$step → new PPM $current_ppm -> $new_ppm"

        if [ ! -f "$USER_INFO_BAK" ]; then
            sudo cp "$USER_INFO" "$USER_INFO_BAK"
        fi
        sudo sed -i "${line}s/^.*\$/${new_ppm}/" "$USER_INFO"

        log "[$label] full chain restart for new PPM"
        restart_chain

        prev_abs="$abs_res"
        current_ppm="$new_ppm"
    done

    # Fell out of the loop without converging. Roll back to best.
    log "[$label] MAX_ITER ($MAX_ITERATIONS) reached. last residual=$cur_res, best=$best_res (PPM=$best_ppm)"
    if [ "$best_ppm" != "$current_ppm" ]; then
        log "[$label] rolling back PPM $current_ppm -> $best_ppm"
        sudo sed -i "${line}s/^.*\$/${best_ppm}/" "$USER_INFO"
        restart_chain
        current_ppm="$best_ppm"
        cur_res="$best_res"
        cur_snr="$best_snr"
    fi
    start_sdrtst "$idx" "$port" "$cfg" "$fifo"
    # Treat max_iter with acceptable best as quantized_ok; else FAIL.
    local best_abs2
    best_abs2=$(python3 -c "print(abs($cur_res))")
    if python3 -c "import sys; sys.exit(0 if $best_abs2 <= $QUANTIZED_OK_PPM else 1)"; then
        log "[$label] best |residual|=$best_abs2 within QUANTIZED_OK: OK"
        printf '%s,%s,%s,%s,%s,%s,%s\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "quantized_ok" "$cur_res" "$cur_snr" >> "$HISTORY"
        echo OK
        return 0
    fi
    printf '%s,%s,%s,%s,%s,%s,%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$start_ppm" "$current_ppm" "max_iter" "$cur_res" "$cur_snr" >> "$HISTORY"
    echo FAIL
    return 1
}

# --- main ---
log "=== kycal-cron start ==="

if [ ! -f "$HISTORY" ]; then
    echo "ts,label,old_ppm,new_ppm,action,residual_ppm,snr_db" > "$HISTORY"
fi

audit_chain "entry"

ANY_FAIL=0
ANY_OK=0
for idx in 0 1; do
    result=$(process_dongle "$idx" | tail -1)
    case "$result" in
        OK)   ANY_OK=1 ;;
        SKIP) ;;                  # measure_fail = no info; don't move state
        *)    ANY_FAIL=1 ;;
    esac
done

state_load
log "prior state: alert_sent=${ALERT_SENT} consec_failures=${CONSEC_FAILURES}"

if [ "$ANY_FAIL" = "1" ]; then
    NEW_CONSEC=$((CONSEC_FAILURES + 1))
    if [ "$NEW_CONSEC" -ge "$ALERT_THRESHOLD_FAILURES" ] && [ "$ALERT_SENT" = "False" ]; then
        log "ALERT: ${NEW_CONSEC} consecutive failures — sending Telegram"
        notify_telegram "🚨 *kytrack PPM calibration failed*

${NEW_CONSEC} consecutive cycles have failed. The dxlAPRS chain is still running but its dongle frequency calibration is stale.

Check \`/home/pi/kycal-history.log\` on kytrack (192.168.0.209)."
        state_save True "$NEW_CONSEC"
    else
        state_save "$ALERT_SENT" "$NEW_CONSEC"
    fi
elif [ "$ANY_OK" = "1" ]; then
    if [ "$ALERT_SENT" = "True" ]; then
        log "RECOVERED: clearing alert"
        notify_telegram "✅ *kytrack PPM calibration recovered*

Auto-corrected after prior alert. No further action needed."
    fi
    state_save False 0
else
    log "all dongles SKIP (no measurement available) — state unchanged"
fi

log "=== kycal-cron done ==="
