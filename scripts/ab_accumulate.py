#!/usr/bin/env python3
"""Accumulate IF-width A/B results from sonde_ab_logger meta files into one CSV.

Idempotent: rebuilds sonde_ab_logs/ab_results.csv in full from every *.meta.txt
on each run, so it is safe to re-run and it backfills history automatically.

For each capture it records, per SDR, the IF width that was actually in the
403.500 frequency-file line, the frequency each SDR's receiver locked (derived
from the dominant sondeudp channel), and the decoded good/unique frame count.
A pass only counts as a valid A/B when BOTH receivers locked 403.500 — that is
the `both_on_403500` column. The `narrow_over_wide` column is the headline
metric: narrower-IF good frames divided by wider-IF good frames on 403.500.

Telemetry format changed at commit 696f761 (2026-06-02): older captures report
"unique frames" (quality field was broken), newer ones report "good frames".
The `telem_era` column flags which, so the two are never silently mixed.
"""

import csv
import glob
import os
import re

LOG_DIR = os.path.expanduser("~/sonde_ab_logs")
OUT_CSV = os.path.join(LOG_DIR, "ab_results.csv")
TARGET_MHZ = "403.500"

COLUMNS = [
    "capture", "started_utc", "window",
    "sdr1_if_hz", "sdr2_if_hz",
    "sdr1_dom_mhz", "sdr2_dom_mhz", "both_on_403500",
    "telem_era", "sdr1_frames", "sdr2_frames",
    "sdr1_crc_pct", "sdr2_crc_pct", "udp4010_decoded",
    "narrow_if_hz", "narrow_frames", "wide_frames", "narrow_over_wide",
]


def parse_freq_block(text, header):
    """Return ordered list of (mhz_str, if_hz) for one SDR's frequency file."""
    chans = []
    in_block = False
    for line in text.splitlines():
        if line.startswith("--- frequency_") and header in line:
            in_block = True
            continue
        if in_block:
            if line.startswith("--- ") or line.startswith("==="):
                break
            m = re.match(r"\s*f\s+(\d+\.\d+)\s+.*\s+(\d+)\s*$", line)
            if m:
                chans.append((m.group(1), int(m.group(2))))
    return chans


def dominant_channel(log_path):
    """Most frequent leading 'N:' channel index in a sondeudp log, or None."""
    if not os.path.exists(log_path):
        return None
    counts = {}
    with open(log_path, "r", errors="replace") as fh:
        for line in fh:
            i = line.find(":")
            if i <= 0:
                continue
            head = line[:i]
            if head.isdigit():
                counts[int(head)] = counts.get(int(head), 0) + 1
    if not counts:
        return None
    return max(counts, key=counts.get)


def dom_mhz(chans, dom_idx):
    """Map a 1-based dominant channel index to its frequency string."""
    if dom_idx is None or not (1 <= dom_idx <= len(chans)):
        return ""
    return chans[dom_idx - 1][0]


def if_on_target(chans):
    for mhz, hz in chans:
        if mhz == TARGET_MHZ:
            return hz
    return ""


def parse_frames(text, sdr):
    """Return (frames, crc_pct, era) for SDRn from its telemetry line."""
    new = re.search(rf"{sdr}:\s+(\d+) good frames,\s+\d+ crc-err \(([\d.]+|n/a)%", text)
    if new:
        pct = new.group(2)
        return int(new.group(1)), ("" if pct == "n/a" else pct), "good"
    old = re.search(rf"{sdr}:\s+(\d+) unique frames", text)
    if old:
        return int(old.group(1)), "", "unique"
    return None, "", "none"


def parse_udp4010(text):
    lines = text.splitlines()
    for n, line in enumerate(lines):
        if "decoded sonde frame count" in line:
            for nxt in lines[n + 1:n + 5]:
                s = nxt.strip()
                if s.isdigit():
                    return int(s)
            return ""
    return ""


def row_for(meta_path):
    cap = os.path.basename(meta_path)[: -len(".meta.txt")]
    with open(meta_path, "r", errors="replace") as fh:
        text = fh.read()

    started = ""
    m = re.search(r"Started:\s+(\S+)", text)
    if m:
        started = m.group(1)
    window = cap.rsplit("-", 1)[-1]

    s1_chans = parse_freq_block(text, "(SDR1)")
    s2_chans = parse_freq_block(text, "(SDR2)")
    s1_if = if_on_target(s1_chans)
    s2_if = if_on_target(s2_chans)

    s1_dom = dom_mhz(s1_chans, dominant_channel(os.path.join(LOG_DIR, f"{cap}.sdr1_sondeudp.log")))
    s2_dom = dom_mhz(s2_chans, dominant_channel(os.path.join(LOG_DIR, f"{cap}.sdr2_sondeudp.log")))
    both = "yes" if (s1_dom == TARGET_MHZ and s2_dom == TARGET_MHZ) else "no"

    s1_fr, s1_crc, era1 = parse_frames(text, "SDR1")
    s2_fr, s2_crc, era2 = parse_frames(text, "SDR2")
    era = era1 if era1 == era2 else f"{era1}/{era2}"

    narrow_if = narrow_fr = wide_fr = ratio = ""
    if both == "yes" and s1_if and s2_if and s1_if != s2_if \
            and s1_fr is not None and s2_fr is not None:
        if s1_if < s2_if:
            narrow_if, narrow_fr, wide_fr = s1_if, s1_fr, s2_fr
        else:
            narrow_if, narrow_fr, wide_fr = s2_if, s2_fr, s1_fr
        ratio = round(narrow_fr / wide_fr, 2) if wide_fr else ""

    return {
        "capture": cap, "started_utc": started, "window": window,
        "sdr1_if_hz": s1_if, "sdr2_if_hz": s2_if,
        "sdr1_dom_mhz": s1_dom, "sdr2_dom_mhz": s2_dom, "both_on_403500": both,
        "telem_era": era, "sdr1_frames": "" if s1_fr is None else s1_fr,
        "sdr2_frames": "" if s2_fr is None else s2_fr,
        "sdr1_crc_pct": s1_crc, "sdr2_crc_pct": s2_crc,
        "udp4010_decoded": parse_udp4010(text),
        "narrow_if_hz": narrow_if, "narrow_frames": narrow_fr,
        "wide_frames": wide_fr, "narrow_over_wide": ratio,
    }


def main():
    metas = sorted(glob.glob(os.path.join(LOG_DIR, "*.meta.txt")))
    rows = [row_for(m) for m in metas]
    with open(OUT_CSV, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    valid = [r for r in rows if r["narrow_over_wide"] != ""]
    print(f"wrote {len(rows)} rows -> {OUT_CSV} ({len(valid)} valid 403.500 A/B passes)")


if __name__ == "__main__":
    main()
