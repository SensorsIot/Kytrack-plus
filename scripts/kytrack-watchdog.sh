#!/bin/bash
# kytrack-watchdog: monitors dxlAPRS stack, self-heals in 5 tiers, alerts via Telegram.
# Deployed to /usr/local/bin/kytrack-watchdog.sh; run from /etc/cron.d/kytrack-watchdog
# every 5 min as user pi.
#
# Alert policy: silent on self-heal (tiers 1-4, including the bounded reboot).
# Telegram fires only on the give-up state (tier 5 / reboot budget exhausted),
# once per episode, plus a single RECOVERED when that give-up clears. All tiers
# are still recorded in history.log. While kycal-cron holds the dongles for PPM
# calibration it touches /var/tmp/.kytrack-watchdog-cal and we skip the cycle,
# so its chain teardown is never mistaken for a failure.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

STATE_DIR=/var/lib/kytrack-watchdog
LOG_FILE=$STATE_DIR/watchdog.log
STATE_FILE=$STATE_DIR/state
HISTORY_FILE=$STATE_DIR/history.log
REBOOT_FILE=$STATE_DIR/reboots
LOCK_FILE=$STATE_DIR/lock
DISABLE_FILE=/var/tmp/.kytrack-watchdog-disabled

DXLAPRS_LOG=/opt/dxlAPRS/log/aprs-is.log
LOG_STALE_SEC=300
USB_VENDOR_PRODUCT="0bda:2838"
EXPECTED_DONGLES=2
SECRETS=/home/pi/.secrets/env

REBOOT_LIMIT_24H=3

mkdir -p "$STATE_DIR"

log() {
    local msg="$1"
    printf '%s %s\n' "$(date '+%F %T')" "$msg" >> "$LOG_FILE"
}

# --- single-instance lock ---
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another instance is running; exiting"
    exit 0
fi

# --- manual override (indefinite) ---
if [ -e "$DISABLE_FILE" ]; then
    log "DISABLED via $DISABLE_FILE; exiting"
    exit 0
fi

# --- calibration pause (kycal holds the dongles & restarts the chain) ---
# kycal-cron touches CAL_FILE for the duration of a PPM run. Skip our checks so
# we don't read its chain teardown as a failure and restart underneath it. Age
# the file out after CAL_MAX_AGE: a crashed/killed kycal that never removed it
# must not disable the watchdog indefinitely (manual pause uses DISABLE_FILE).
CAL_FILE=/var/tmp/.kytrack-watchdog-cal
CAL_MAX_AGE=2400
if [ -e "$CAL_FILE" ]; then
    cal_age=$(( $(date +%s) - $(stat -c %Y "$CAL_FILE" 2>/dev/null || echo 0) ))
    if [ "$cal_age" -lt "$CAL_MAX_AGE" ]; then
        log "calibration in progress ($CAL_FILE, ${cal_age}s old); skipping cycle"
        exit 0
    fi
    log "stale $CAL_FILE (${cal_age}s > ${CAL_MAX_AGE}s); ignoring and removing"
    rm -f "$CAL_FILE" 2>/dev/null || true
fi

# --- secrets ---
# shellcheck disable=SC1090
[ -r "$SECRETS" ] && . "$SECRETS"
if [ -z "${ALARM_BOT_TOKEN:-}" ] || [ -z "${ALARM_CHAT_ID:-}" ]; then
    log "ALARM_BOT_TOKEN or ALARM_CHAT_ID not set; alerts disabled"
fi

notify() {
    local msg="$1"
    log "TG> $msg"
    [ -z "${ALARM_BOT_TOKEN:-}" ] && return 0
    curl -s --max-time 10 -X POST \
        "https://api.telegram.org/bot${ALARM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${ALARM_CHAT_ID}" \
        --data-urlencode "text=[kytrack] ${msg}" >/dev/null || \
        log "telegram send failed"
}

record_history() {
    printf '%s tier=%s scope=%s reason=%s\n' \
        "$(date -u +%FT%TZ)" "$1" "$2" "$3" >> "$HISTORY_FILE"
}

# --- health checks ------------------------------------------------------------
# Each check sets fail_<name>=1 on failure; appends a one-line reason to FAILS.
declare -a FAILS=()
declare -A SCOPE_FAIL=( [SDR1]=0 [SDR2]=0 [SHARED]=0 [USB]=0 )

mark_fail() {
    local scope="$1" reason="$2"
    SCOPE_FAIL[$scope]=1
    FAILS+=("$scope: $reason")
}

# C1: rtl_tcp -d 0 (SDR1)
if [ "$(pgrep -cf 'rtl_tcp -d 0')" -lt 1 ]; then
    mark_fail SDR1 "rtl_tcp(d0) not running"
fi
# C2: rtl_tcp -d 1 (SDR2)
if [ "$(pgrep -cf 'rtl_tcp -d 1')" -lt 1 ]; then
    mark_fail SDR2 "rtl_tcp(d1) not running"
fi
# C3: SDR1 audio pipeline (sdrtst + sondeudp on audio_buffer.fifo)
if [ "$(pgrep -cf 'audio_buffer\.fifo')" -lt 2 ]; then
    mark_fail SDR1 "sdrtst/sondeudp on audio_buffer.fifo missing"
fi
# C4: SDR2 audio pipeline
if [ "$(pgrep -cf 'audio_buffer_2\.fifo')" -lt 2 ]; then
    mark_fail SDR2 "sdrtst/sondeudp on audio_buffer_2.fifo missing"
fi
# C5: sondemod (lives in dxl screen, shared decoder)
if [ "$(pgrep -cx sondemod)" -lt 1 ]; then
    mark_fail SHARED "sondemod not running"
fi
# C6: udpgate4 (lives in dxl screen, APRS-IS gateway)
if [ "$(pgrep -cx udpgate4)" -lt 1 ]; then
    mark_fail SHARED "udpgate4 not running"
fi
# C7: USB dongles present
DONGLE_COUNT=$(lsusb 2>/dev/null | grep -c -F "$USB_VENDOR_PRODUCT" || true)
if [ "$DONGLE_COUNT" -lt "$EXPECTED_DONGLES" ]; then
    mark_fail USB "RTL2838 count=${DONGLE_COUNT} expected=${EXPECTED_DONGLES}"
fi
# C8: aprs-is.log freshness (end-to-end heartbeat)
if [ -f "$DXLAPRS_LOG" ]; then
    NOW=$(date +%s)
    MTIME=$(stat -c %Y "$DXLAPRS_LOG")
    AGE=$(( NOW - MTIME ))
    if [ "$AGE" -gt "$LOG_STALE_SEC" ]; then
        mark_fail SHARED "aprs-is.log stale (${AGE}s, threshold ${LOG_STALE_SEC}s)"
    fi
else
    mark_fail SHARED "aprs-is.log missing"
fi

# C9: any screens at all?
SCREENS_OK=1
if ! screen -ls 2>/dev/null | grep -q '\.dxl'; then
    SCREENS_OK=0
fi

# --- state machine ------------------------------------------------------------
# load previous state
prev_state=OK
prev_consec=0
if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE" 2>/dev/null || true
fi
prev_state="${last_state:-OK}"
prev_consec="${consecutive_fails:-0}"
prev_alerted="${alerted:-0}"

if [ ${#FAILS[@]} -eq 0 ]; then
    # all healthy
    if [ "$prev_state" = "FAIL" ]; then
        # Only announce recovery if we actually alerted (a give-up). Silent
        # self-heal (tiers 1-4) must not emit a lone RECOVERED.
        [ "$prev_alerted" = "1" ] && notify "RECOVERED: all checks passing again."
        record_history 0 "" "recovered"
    fi
    {
        echo 'last_state=OK'
        echo 'consecutive_fails=0'
        echo 'alerted=0'
        echo "last_ok_epoch=$(date +%s)"
    } > "$STATE_FILE"
    log "OK (all checks pass)"
    exit 0
fi

# something failed
new_consec=$(( prev_consec + 1 ))
fail_summary=$(IFS='; '; echo "${FAILS[*]}")
log "FAIL ($new_consec consecutive): $fail_summary"

# --- pick tier ----------------------------------------------------------------
# Tier rules:
#   no screens at all   → Tier 3 (full START.sh) immediately
#   1st consecutive fail → Tier 1 (restart affected screen)
#   2nd                  → Tier 2 (USB rebind + restart)
#   3rd                  → Tier 3 (full START.sh)
#   4th                  → Tier 4 (bounded reboot)
#   5th+                 → Tier 5 (alert only)
if [ "$SCREENS_OK" -eq 0 ]; then
    tier=3
elif [ "$new_consec" -le 1 ]; then
    tier=1
elif [ "$new_consec" -le 2 ]; then
    tier=2
elif [ "$new_consec" -le 3 ]; then
    tier=3
elif [ "$new_consec" -le 4 ]; then
    tier=4
else
    tier=5
fi

# --- USB scope forces tier 2 minimum ---
if [ "${SCOPE_FAIL[USB]}" -eq 1 ] && [ "$tier" -lt 2 ]; then
    tier=2
fi

# --- determine affected screens ---
restart_dxl=0
restart_dxl_sdr2=0
if [ "${SCOPE_FAIL[SDR1]}" -eq 1 ] || [ "${SCOPE_FAIL[SHARED]}" -eq 1 ]; then
    restart_dxl=1
fi
if [ "${SCOPE_FAIL[SDR2]}" -eq 1 ]; then
    restart_dxl_sdr2=1
fi

# --- tier executors -----------------------------------------------------------
do_tier1_restart_dxl() {
    log "Tier 1: restarting screen dxl"
    sudo killall -q -w sondemod udpgate4 2>/dev/null || true
    screen -S dxl -X quit 2>/dev/null || true
    sleep 2
    sudo killall -q rtl_tcp sdrtst sondeudp 2>/dev/null || true  # cleanup orphans from dxl
    sleep 1
    bash /opt/dxlAPRS/scripts/START_SDR_1.sh >> "$LOG_FILE" 2>&1
}

do_tier1_restart_dxl_sdr2() {
    log "Tier 1: restarting screen dxl_sdr2"
    screen -S dxl_sdr2 -X quit 2>/dev/null || true
    sleep 2
    bash /opt/dxlAPRS/scripts/START_SDR_2.sh >> "$LOG_FILE" 2>&1
}

do_tier2_usb_rebind() {
    log "Tier 2: USB rebind for RTL2838 dongles"
    # find both 0bda:2838 sysfs paths
    local paths=()
    for d in /sys/bus/usb/devices/*; do
        [ -f "$d/idVendor" ] || continue
        [ -f "$d/idProduct" ] || continue
        if [ "$(cat "$d/idVendor")" = "0bda" ] && [ "$(cat "$d/idProduct")" = "2838" ]; then
            paths+=( "$(basename "$d")" )
        fi
    done
    log "Tier 2: found ${#paths[@]} dongle(s): ${paths[*]:-none}"
    # also include "missing" candidates from typical hub ports if count is low
    # (1-1.2 and 1-1.4 are the observed ports; rebind whatever's there)
    for p in "${paths[@]}"; do
        log "Tier 2: unbinding $p"
        echo "$p" | sudo tee /sys/bus/usb/drivers/usb/unbind >/dev/null 2>&1 || true
    done
    sleep 3
    # bind: USB will auto-rebind on hub rescan; force by writing all hub ports
    for p in "${paths[@]}"; do
        log "Tier 2: binding $p"
        echo "$p" | sudo tee /sys/bus/usb/drivers/usb/bind >/dev/null 2>&1 || true
    done
    sleep 5
}

do_tier3_full_restart() {
    log "Tier 3: full dxlAPRS restart via START.sh"
    sudo killall -q screen sondemod udpgate4 sondeudp sdrtst rtl_tcp 2>/dev/null || true
    sleep 3
    bash /opt/dxlAPRS/scripts/START.sh >> "$LOG_FILE" 2>&1 &
    sleep 10
}

do_tier4_reboot() {
    # bounded: max REBOOT_LIMIT_24H reboots in any 24h window
    local now cutoff count
    now=$(date +%s)
    cutoff=$(( now - 86400 ))
    touch "$REBOOT_FILE"
    # keep only entries within last 24h
    awk -v c="$cutoff" '$1+0 >= c' "$REBOOT_FILE" > "$REBOOT_FILE.tmp" && \
        mv "$REBOOT_FILE.tmp" "$REBOOT_FILE"
    count=$(wc -l < "$REBOOT_FILE")
    if [ "$count" -ge "$REBOOT_LIMIT_24H" ]; then
        log "Tier 4: reboot budget exhausted ($count in 24h); escalating to Tier 5"
        # give-up state: alert once per episode, then stay quiet.
        if [ "$prev_alerted" != "1" ]; then
            notify "REBOOT BUDGET EXHAUSTED ($count in 24h). No more reboots; manual intervention needed. Failures: $fail_summary"
        fi
        record_history 5 budget "exhausted"
        # save state and exit; stay in alerted state so we don't re-spam.
        {
            echo 'last_state=FAIL'
            echo "consecutive_fails=$new_consec"
            echo 'last_action_tier=5'
            echo 'alerted=1'
            echo "last_failures=\"$fail_summary\""
        } > "$STATE_FILE"
        exit 0
    fi
    echo "$now" >> "$REBOOT_FILE"
    log "Tier 4: rebooting (count $((count+1))/${REBOOT_LIMIT_24H} in 24h)"
    # silent self-heal per alert policy (incl. reboots); history.log records it.
    sleep 5
    sudo /sbin/reboot
}

# --- execute selected tier ----------------------------------------------------
# Alert policy: stay silent on self-heal (tiers 1-4). Telegram fires only on the
# give-up state (tier 5 / reboot budget exhausted). history.log keeps every tier.
record_history "$tier" "${restart_dxl}/${restart_dxl_sdr2}" "$fail_summary"

alerted="$prev_alerted"
case $tier in
    1)
        [ "$restart_dxl" = 1 ] && do_tier1_restart_dxl
        [ "$restart_dxl_sdr2" = 1 ] && do_tier1_restart_dxl_sdr2
        ;;
    2)
        do_tier2_usb_rebind
        [ "$restart_dxl" = 1 ] && do_tier1_restart_dxl
        [ "$restart_dxl_sdr2" = 1 ] && do_tier1_restart_dxl_sdr2
        # if USB scope but neither SDR scope, restart both
        if [ "$restart_dxl" = 0 ] && [ "$restart_dxl_sdr2" = 0 ]; then
            do_tier1_restart_dxl
            do_tier1_restart_dxl_sdr2
        fi
        ;;
    3)
        do_tier3_full_restart
        ;;
    4)
        do_tier4_reboot
        ;;
    5)
        # give-up state: human intervention needed. Alert once per episode.
        log "Tier 5: alert-only mode"
        if [ "$prev_alerted" != "1" ]; then
            notify "GIVE UP after $new_consec consec fails — manual intervention needed: $fail_summary"
        fi
        alerted=1
        ;;
esac

# --- save state ---------------------------------------------------------------
{
    echo 'last_state=FAIL'
    echo "consecutive_fails=$new_consec"
    echo "last_action_tier=$tier"
    echo "alerted=$alerted"
    echo "last_failures=\"$fail_summary\""
} > "$STATE_FILE"

exit 0
