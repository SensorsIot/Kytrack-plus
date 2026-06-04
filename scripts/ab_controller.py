#!/usr/bin/env python3
"""Autonomous IF-width optimiser for the 403.500 A/B on kytrack.

Each night, after the overnight capture, this compares the challenger width
(SDR1's 403.500 IF) against the champion width (SDR2's 403.500 IF) on the SAME
sonde, frame-for-frame, and hill-climbs toward the width that decodes the most
good frames.

Invariants (safety for an unattended loop on a live receiver):
- SDR2 (control) ALWAYS runs the current champion width, so live 403.500
  tracking never drops below the best width found so far. Only SDR1 (the
  redundant second receiver on 403.500) ever runs an unproven challenger.
- A width change is applied ONLY on a statistically significant result
  (McNemar p < ALPHA). A weak or off-frequency flight changes nothing and is
  re-flown unchanged.
- Challenger width is bounded to BOUNDS; the climb stops at STEP_MIN.

Pairing key is the sonde's own frame counter, taken as a set per SDR, so the
repeated sondeudp screen-snapshots collapse to one entry per real frame.

Modes:
  (default)          evaluate the newest not-yet-seen *-23utc capture, decide,
                     apply, log.
  --status           print current state and the decision history.
  --dry-run-history  replay every historical capture through the evaluator
                     WITHOUT touching state or any config file.
  --init             write the initial state and apply the first challenger.
"""

import csv
import glob
import json
import math
import os
import re
import sys

LOG_DIR = os.path.expanduser("~/sonde_ab_logs")
STATE = os.path.join(LOG_DIR, "ab_controller_state.json")
DECISIONS = os.path.join(LOG_DIR, "ab_controller.log")
RESULTS_CSV = os.path.join(LOG_DIR, "ab_results.csv")
TARGET_MHZ = "403.500"

# Live frequency files: index 1 -> SDR1 (challenger), 2 -> SDR2 (control).
SETUP = {1: "/opt/dxlAPRS/setup/frequency_1.txt", 2: "/opt/dxlAPRS/setup/frequency_2.txt"}
CONFIG = {1: "/opt/dxlAPRS/config/sdr_config.txt", 2: "/opt/dxlAPRS/config/sdr_config_2.txt"}
CHALLENGER_SDR, CONTROL_SDR = 1, 2

ALPHA = 0.05            # significance threshold for accepting a width change
MIN_FRAMES = 30        # good frames on 403.500 required on BOTH sdrs for a valid pass
MIN_DISCORDANT = 10    # min (b+c) before a p-value is trusted
BOUNDS = (3000, 12000)
STEP_INIT = 1000
STEP_MIN = 500
CONVERGE_HOLDS = 3     # consecutive non-significant flights at min step => converged

INITIAL_STATE = {
    "champion_width": 6500, "direction": -1, "step": STEP_INIT,
    "challenger_width": 6500 - STEP_INIT, "phase": "climbing",
    "consec_nonsig": 0, "last_flight": "", "bounds": list(BOUNDS), "history": [],
}

GOOD = re.compile(r"^(\d+):\S+\s+(\S+)\s+(\d+)\s+\d{4}\.\d{2}\.\d{2}\s")


def clamp(w):
    return max(BOUNDS[0], min(BOUNDS[1], w))


def target_channel(meta_text, sdr_header):
    """1-based channel index of the 403.500 line in one SDR's frequency file."""
    in_block = False
    idx = 0
    for line in meta_text.splitlines():
        if line.startswith("--- frequency_") and sdr_header in line:
            in_block = True
            continue
        if in_block:
            if line.startswith("--- ") or line.startswith("==="):
                break
            m = re.match(r"\s*f\s+(\d+\.\d+)\s", line)
            if m:
                idx += 1
                if m.group(1) == TARGET_MHZ:
                    return idx
    return None


def good_frames(log_path, chan):
    """Set of frame counters decoded good on `chan`, and the dominant serial."""
    if chan is None or not os.path.exists(log_path):
        return set(), None
    frames, serials = set(), {}
    with open(log_path, "r", errors="replace") as fh:
        for line in fh:
            m = GOOD.match(line)
            if not m or int(m.group(1)) != chan:
                continue
            frames.add(int(m.group(3)))
            serials[m.group(2)] = serials.get(m.group(2), 0) + 1
    serial = max(serials, key=serials.get) if serials else None
    return frames, serial


def mcnemar_p(b, c):
    """Two-sided McNemar p-value: exact binomial for small n, normal approx else."""
    n = b + c
    if n == 0:
        return 1.0
    if n <= 1000:
        k = min(b, c)
        tail = sum(math.comb(n, i) for i in range(k + 1)) * (0.5 ** n)
        return min(1.0, 2 * tail)
    z = (abs(b - c) - 1) / math.sqrt(n)
    return math.erfc(z / math.sqrt(2))


def evaluate(capture):
    """Compare champion (SDR2) vs challenger (SDR1) on one capture's 403.500."""
    meta = os.path.join(LOG_DIR, capture + ".meta.txt")
    with open(meta, "r", errors="replace") as fh:
        text = fh.read()
    ch1 = target_channel(text, "(SDR1)")
    ch2 = target_channel(text, "(SDR2)")
    s1, ser1 = good_frames(os.path.join(LOG_DIR, capture + ".sdr1_sondeudp.log"), ch1)
    s2, ser2 = good_frames(os.path.join(LOG_DIR, capture + ".sdr2_sondeudp.log"), ch2)

    def width(text, header):
        in_block = False
        for line in text.splitlines():
            if line.startswith("--- frequency_") and header in line:
                in_block = True
                continue
            if in_block:
                if line.startswith("--- ") or line.startswith("==="):
                    break
                m = re.match(rf"\s*f\s+{re.escape(TARGET_MHZ)}\s+.*\s+(\d+)\s*$", line)
                if m:
                    return int(m.group(1))
        return None

    chall_w, champ_w = width(text, "(SDR1)"), width(text, "(SDR2)")
    # Validity is anchored on the control/champion side (SDR2): a real sonde must
    # have been tracked on 403.500. A near-dead challenger is a LOSS, not invalid,
    # so the loop never stalls re-flying a hopeless width. If the challenger did
    # decode, its serial must match (same sonde).
    serial_ok = ser1 is None or ser1 == ser2
    valid = len(s2) >= MIN_FRAMES and ser2 is not None and serial_ok
    b = len(s2 - s1)   # champion-only good frames
    c = len(s1 - s2)   # challenger-only good frames
    p = mcnemar_p(b, c)
    winner = "challenger" if c > b else "champion"
    return {
        "capture": capture, "valid": valid, "serial": ser1,
        "champion_width": champ_w, "challenger_width": chall_w,
        "champ_frames": len(s2), "chall_frames": len(s1),
        "b": b, "c": c, "p": p, "winner": winner,
        "significant": valid and p < ALPHA and (b + c) >= MIN_DISCORDANT,
    }


def decide(state, ev):
    """Pure transition: returns (new_state, action_string)."""
    s = dict(state)
    if not ev["valid"]:
        return s, "hold: no valid 403.500 A/B (off-freq or <%d frames)" % MIN_FRAMES
    if not ev["significant"]:
        s["consec_nonsig"] = s["consec_nonsig"] + 1
        act = "hold: not significant (p=%.3f, b=%d c=%d)" % (ev["p"], ev["b"], ev["c"])
        if s["phase"] == "climbing" and s["step"] <= STEP_MIN and s["consec_nonsig"] >= CONVERGE_HOLDS:
            s["phase"] = "converged"
            s["challenger_width"] = s["champion_width"]
            act += " -> CONVERGED (flat at min step)"
        return s, act

    s["consec_nonsig"] = 0
    if ev["winner"] == "challenger":
        s["champion_width"] = ev["challenger_width"]
        nxt = clamp(s["champion_width"] + s["direction"] * s["step"])
        if nxt == s["champion_width"]:           # hit a bound; turn around
            s["direction"] *= -1
            s["step"] = max(STEP_MIN, s["step"] // 2)
            nxt = clamp(s["champion_width"] + s["direction"] * s["step"])
        act = "WIN: %d beats %d (p=%.4g) -> champion=%d, next challenger=%d" % (
            ev["challenger_width"], ev["champion_width"], ev["p"],
            s["champion_width"], nxt)
        s["challenger_width"] = nxt
    else:
        if s["step"] <= STEP_MIN:
            s["phase"] = "converged"
            s["challenger_width"] = s["champion_width"]
            act = "LOSS at min step -> CONVERGED at champion=%d" % s["champion_width"]
            return s, act
        s["direction"] *= -1
        s["step"] = max(STEP_MIN, s["step"] // 2)
        nxt = clamp(s["champion_width"] + s["direction"] * s["step"])
        act = "LOSS: %d worse than %d (p=%.4g) -> reverse+halve, next challenger=%d" % (
            ev["challenger_width"], s["champion_width"], ev["p"], nxt)
        s["challenger_width"] = nxt
    return s, act


def set_width(sdr, width):
    """Idempotently set the 403.500 IF width in this SDR's setup+live files.

    Only the trailing width field is rewritten; the line's terminator is
    preserved so adjacent frequency entries never fuse.
    """
    pat = re.compile(r"^(f\s+" + re.escape(TARGET_MHZ) + r"\s+\S+\s+\S+\s+\S+\s+)\d+\s*$")

    def rewrite(ln):
        if not pat.match(ln):
            return ln
        nl = "\n" if ln.endswith("\n") else ""
        return "%s%d%s" % (pat.match(ln).group(1), width, nl)

    for path in (SETUP[sdr], CONFIG[sdr]):
        if not os.path.exists(path):
            continue
        bak = path + ".bak-abctl"
        with open(path) as fh:
            lines = fh.readlines()
        if not os.path.exists(bak):
            with open(bak, "w") as fh:
                fh.writelines(lines)
        out = [rewrite(ln) for ln in lines]
        with open(path, "w") as fh:
            fh.writelines(out)


def log(msg):
    line = msg if msg.startswith("[") else "  " + msg
    with open(DECISIONS, "a") as fh:
        fh.write(line + "\n")
    print(line)


def load_state():
    if os.path.exists(STATE):
        with open(STATE) as fh:
            return json.load(fh)
    return None


def save_state(s):
    with open(STATE, "w") as fh:
        json.dump(s, fh, indent=2)


def newest_capture():
    # Filenames begin YYYYMMDD-HHMM (UTC start), so lexical max == most recent.
    # Both daily flights (overnight 23utc, midday 11utc) are candidates: each runs
    # on the width applied at the kycal sdrtst restart that precedes it.
    caps = sorted(os.path.basename(m)[: -len(".meta.txt")]
                  for m in glob.glob(os.path.join(LOG_DIR, "*.meta.txt")))
    return caps[-1] if caps else None


def run_live():
    state = load_state()
    if state is None:
        log("[ERROR] no state; run --init first")
        return
    cap = newest_capture()
    if state["phase"] == "converged":
        log("[%s] converged at %d Hz; no action" % (cap, state["champion_width"]))
        return
    if not cap or cap == state["last_flight"]:
        log("[%s] nothing new to evaluate" % cap)
        return
    ev = evaluate(cap)
    # Only step on a flight that actually ran the widths the state expects; a
    # mismatch (missed run, external edit, capture straddling a restart) is logged
    # and skipped rather than corrupting the climb.
    if ev["challenger_width"] != state["challenger_width"] or ev["champion_width"] != state["champion_width"]:
        log("[%s] width mismatch (flight champ/chall=%s/%s, state=%s/%s); seen, no step"
            % (cap, ev["champion_width"], ev["challenger_width"],
               state["champion_width"], state["challenger_width"]))
        state["last_flight"] = cap
        save_state(state)
        return
    new_state, action = decide(state, ev)
    new_state["last_flight"] = cap
    new_state["history"] = state.get("history", []) + [{
        "flight": cap, "serial": ev["serial"], "p": round(ev["p"], 5),
        "champ_w": ev["champion_width"], "chall_w": ev["challenger_width"],
        "champ_frames": ev["champ_frames"], "chall_frames": ev["chall_frames"],
        "action": action,
    }]
    log("[%s] %s" % (cap, action))
    set_width(CONTROL_SDR, new_state["champion_width"])
    set_width(CHALLENGER_SDR, new_state["challenger_width"])
    log("applied: SDR%d(control)=%d  SDR%d(challenger)=%d"
        % (CONTROL_SDR, new_state["champion_width"], CHALLENGER_SDR, new_state["challenger_width"]))
    save_state(new_state)


def cmd_status():
    state = load_state()
    if state is None:
        print("no state; run --init")
        return
    print("phase            : %s" % state["phase"])
    print("champion width   : %d Hz  (live on SDR%d, control)" % (state["champion_width"], CONTROL_SDR))
    print("challenger width : %d Hz  (live on SDR%d)" % (state["challenger_width"], CHALLENGER_SDR))
    print("step / direction : %d Hz / %s" % (state["step"], "narrower" if state["direction"] < 0 else "wider"))
    print("last flight      : %s" % state["last_flight"])
    print("\nclimb history:")
    for h in state.get("history", []):
        print("  %-28s champ %5d (%4d fr) vs chall %5d (%4d fr)  %s"
              % (h["flight"], h["champ_w"], h["champ_frames"], h["chall_w"], h["chall_frames"], h["action"]))


def cmd_dry_run_history():
    metas = sorted(glob.glob(os.path.join(LOG_DIR, "*.meta.txt")))
    state = dict(INITIAL_STATE)
    print("%-28s %-9s %6s %6s %5s %5s %8s  %s"
          % ("capture", "serial", "champW", "challW", "champ", "chall", "p", "decision"))
    for m in metas:
        cap = os.path.basename(m)[: -len(".meta.txt")]
        ev = evaluate(cap)
        if not ev["valid"]:
            print("%-28s %-9s %6s %6s %5d %5d %8s  skip (invalid)"
                  % (cap, ev["serial"] or "-", ev["champion_width"], ev["challenger_width"],
                     ev["champ_frames"], ev["chall_frames"], "-"))
            continue
        state, action = decide(state, ev)
        print("%-28s %-9s %6d %6d %5d %5d %8.2g  %s"
              % (cap, ev["serial"], ev["champion_width"], ev["challenger_width"],
                 ev["champ_frames"], ev["chall_frames"], ev["p"], action))


def cmd_init():
    if load_state() is not None:
        print("state already exists; refusing to re-init. Delete %s first." % STATE)
        return
    s = dict(INITIAL_STATE)
    save_state(s)
    set_width(CONTROL_SDR, s["champion_width"])
    set_width(CHALLENGER_SDR, s["challenger_width"])
    log("[init] champion=%d (SDR%d), first challenger=%d (SDR%d); step=%d, direction=narrower"
        % (s["champion_width"], CONTROL_SDR, s["challenger_width"], CHALLENGER_SDR, s["step"]))
    print("initialised. Live at next 00:30 CEST sdrtst restart.")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--status":
        cmd_status()
    elif arg == "--dry-run-history":
        cmd_dry_run_history()
    elif arg == "--init":
        cmd_init()
    else:
        run_live()
