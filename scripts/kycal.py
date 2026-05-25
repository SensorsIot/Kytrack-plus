#!/usr/bin/env python3
# kycal.py — RTL-SDR PPM measurement against a known reference carrier.
#
# Talks to an already-running rtl_tcp instance over TCP. Connecting kicks
# the previous client (sdrtst) off; that client's `-k` keep/reconnect flag
# means it auto-reconnects when we close, so total chain downtime is just
# the capture duration plus a few hundred ms.
#
# Pipeline:
#   1. Connect to rtl_tcp on the supplied port, read 12-byte header.
#   2. Send set_sample_rate, set_freq, set_gain_mode commands.
#   3. Stream N IQ bytes from the socket into a temp file.
#   4. Hann window + FFT (default 2**20 → ~2.3 Hz / bin at 2.4 MS/s).
#   5. Locate peak, refine with three-point parabolic interpolation.
#   6. Convert to ppm error relative to the supplied reference.
#
# Output is a single JSON line on stdout. Exit code 0 = good measurement,
# 2 = peak SNR below --min-snr (untrustworthy), 1 = connection/parse error.

import argparse
import json
import os
import socket
import struct
import sys
import tempfile
import time

import numpy as np


# rtl_tcp command codes (subset)
CMD_SET_FREQ = 0x01
CMD_SET_SAMPLE_RATE = 0x02
CMD_SET_GAIN_MODE = 0x03
CMD_SET_GAIN = 0x04
CMD_SET_FREQ_CORRECTION = 0x05
CMD_SET_AGC_MODE = 0x08


def send_cmd(sock, cmd, value):
    sock.sendall(struct.pack(">BI", cmd, value & 0xFFFFFFFF))


def _connect_with_retry(host, port, attempts=5, gap_s=3, per_try_timeout=4):
    last_err = None
    for i in range(attempts):
        try:
            return socket.create_connection((host, port), timeout=per_try_timeout)
        except (ConnectionRefusedError, socket.timeout, OSError) as e:
            last_err = e
            if i < attempts - 1:
                time.sleep(gap_s)
    raise last_err if last_err else RuntimeError("connect failed")


def _recv_exact(sock, n_bytes):
    buf = bytearray()
    while len(buf) < n_bytes:
        chunk = sock.recv(min(131072, n_bytes - len(buf)))
        if not chunk:
            raise RuntimeError("rtl_tcp closed (got %d / %d)" % (len(buf), n_bytes))
        buf.extend(chunk)
    return bytes(buf)


def _open_and_configure(host, port, freq_hz, samplerate_hz, samplerate_settling_discard_bytes,
                        gain_mode, gain_tenths_db, ppm_corr):
    """Connect to rtl_tcp, send config commands, swallow settling samples,
    return the open socket and tuner_type."""
    s = _connect_with_retry(host, port)
    try:
        s.settimeout(30)
        hdr = _recv_exact(s, 12)
        magic, tuner_type, _ = struct.unpack(">4sII", hdr)
        if magic != b"RTL0":
            raise RuntimeError("bad header magic: %r" % magic)
        send_cmd(s, CMD_SET_SAMPLE_RATE, int(samplerate_hz))
        send_cmd(s, CMD_SET_FREQ_CORRECTION, int(ppm_corr) & 0xFFFFFFFF)
        send_cmd(s, CMD_SET_GAIN_MODE, int(gain_mode))
        if gain_mode == 1:
            send_cmd(s, CMD_SET_GAIN, int(gain_tenths_db))
        send_cmd(s, CMD_SET_AGC_MODE, 0)
        send_cmd(s, CMD_SET_FREQ, int(freq_hz))
        _ = _recv_exact(s, samplerate_settling_discard_bytes)
        return s, int(tuner_type)
    except Exception:
        try: s.close()
        except OSError: pass
        raise


def listen_for_signal(host, port, freq_hz, samplerate_hz, n_samples,
                      gain_mode, gain_tenths_db, ppm_corr,
                      expected_baseband_hz, search_bw_hz,
                      min_snr_db, listen_timeout_s):
    """Open rtl_tcp, configure, stream back-to-back FFT-sized chunks. Return
    as soon as a chunk's peak-search SNR meets `min_snr_db`, or when
    `listen_timeout_s` elapses (whichever first). `listen_timeout_s <= 0`
    means single-shot — capture exactly one chunk and return regardless.

    rtl_tcp resets the peer occasionally; we transparently reconnect within
    the listen window so a single TCP hiccup doesn't lose the cycle.
    """
    n_bytes = n_samples * 2
    deadline = time.time() + listen_timeout_s if listen_timeout_s > 0 else 0.0
    settling = int(0.1 * samplerate_hz) * 2
    chunks = 0
    reconnects = 0
    tuner_type = -1
    last = {"baseband_hz": 0.0, "peak_mag": 0.0, "snr_db": -999.0,
            "bin_hz": samplerate_hz / n_samples, "top_peaks": []}

    while True:
        try:
            s, tuner_type = _open_and_configure(
                host, port, freq_hz, samplerate_hz, settling,
                gain_mode, gain_tenths_db, ppm_corr,
            )
        except Exception:
            if listen_timeout_s <= 0 or time.time() >= deadline:
                raise
            time.sleep(1)
            reconnects += 1
            continue

        try:
            while True:
                raw = np.frombuffer(_recv_exact(s, n_bytes), dtype=np.uint8)
                iq = ((raw[0::2].astype(np.float32) - 127.5)
                      + 1j * (raw[1::2].astype(np.float32) - 127.5))
                baseband_hz, peak_mag, snr_db, bin_hz, top_peaks = find_peak(
                    iq, samplerate_hz,
                    expected_baseband_hz=expected_baseband_hz,
                    search_bw_hz=search_bw_hz,
                )
                chunks += 1
                last = {"baseband_hz": baseband_hz, "peak_mag": peak_mag,
                        "snr_db": snr_db, "bin_hz": bin_hz, "top_peaks": top_peaks}
                if snr_db >= min_snr_db:
                    try: s.close()
                    except OSError: pass
                    return {"ok": True, "tuner_type": tuner_type,
                            "chunks_tried": chunks, "reconnects": reconnects, **last}
                if listen_timeout_s <= 0 or time.time() >= deadline:
                    try: s.close()
                    except OSError: pass
                    return {"ok": False, "tuner_type": tuner_type,
                            "chunks_tried": chunks, "reconnects": reconnects, **last}
        except (RuntimeError, socket.error, OSError, ConnectionResetError) as e:
            try: s.close()
            except OSError: pass
            if listen_timeout_s <= 0 or time.time() >= deadline:
                # single-shot or timed out: bubble out with whatever we have
                return {"ok": False, "tuner_type": tuner_type,
                        "chunks_tried": chunks, "reconnects": reconnects,
                        "last_error": str(e), **last}
            reconnects += 1
            time.sleep(1)
            # loop back to outer, reconnect, keep listening


def find_peak(iq, samplerate_hz, expected_baseband_hz=0.0, search_bw_hz=None):
    n = len(iq)
    win = np.hanning(n).astype(np.float32)
    spec = np.fft.fftshift(np.fft.fft(iq * win))
    mag = np.abs(spec).astype(np.float32)
    bin_hz = samplerate_hz / n
    # DC bin index after fftshift is n/2; suppress it and a few neighbours
    # to avoid locking on the ADC offset spike.
    dc_idx = n // 2
    for j in range(max(0, dc_idx - 3), min(n, dc_idx + 4)):
        mag[j] = 0.0
    if search_bw_hz is not None:
        center_idx = int(round(n / 2.0 + expected_baseband_hz / bin_hz))
        half = int(round(search_bw_hz / bin_hz))
        lo, hi = max(0, center_idx - half), min(n, center_idx + half + 1)
        search_mag = mag[lo:hi]
        local_idx = int(np.argmax(search_mag))
        peak_idx = lo + local_idx
    else:
        peak_idx = int(np.argmax(mag))

    if 0 < peak_idx < n - 1:
        y0, y1, y2 = float(mag[peak_idx - 1]), float(mag[peak_idx]), float(mag[peak_idx + 1])
        denom = y0 - 2.0 * y1 + y2
        sub_offset = 0.5 * (y0 - y2) / denom if denom != 0.0 else 0.0
    else:
        sub_offset = 0.0
    interp_idx = peak_idx + sub_offset
    baseband_hz = (interp_idx - n / 2.0) * bin_hz

    nbr_lo, nbr_hi = max(0, peak_idx - 50), min(n, peak_idx + 51)
    mask = np.ones(n, dtype=bool)
    mask[nbr_lo:nbr_hi] = False
    noise = float(np.median(mag[mask]))
    peak_mag = float(mag[peak_idx])
    snr_db = 20.0 * np.log10(peak_mag / max(noise, 1e-30))

    # Top-5 peaks in the WHOLE spectrum (regardless of search window) for diagnostics.
    flat_top_idx = np.argpartition(mag, -5)[-5:]
    flat_top_idx = flat_top_idx[np.argsort(mag[flat_top_idx])[::-1]]
    top_peaks = []
    for idx in flat_top_idx:
        top_peaks.append({
            "baseband_hz": (int(idx) - n / 2.0) * bin_hz,
            "mag_db": 20.0 * np.log10(float(mag[idx]) / max(noise, 1e-30)),
        })
    return baseband_hz, peak_mag, snr_db, bin_hz, top_peaks


def main():
    ap = argparse.ArgumentParser(description="RTL-SDR PPM measurement via rtl_tcp client connection.")
    ap.add_argument("--host", default="127.0.0.1", help="rtl_tcp host")
    ap.add_argument("--port", "-p", type=int, default=1234, help="rtl_tcp port (1234=SDR1, 1235=SDR2 in kytrack)")
    ap.add_argument("--label", default="", help="label for output (e.g. 'SDR1')")
    ap.add_argument("--ref", type=float, default=394.700e6, help="reference carrier in Hz (default 394.700 MHz POLYCOM)")
    ap.add_argument("--samplerate", type=float, default=2.4e6, help="IQ sample rate in Hz")
    ap.add_argument("--fft-size", type=int, default=2**20, help="FFT length (default 1048576)")
    ap.add_argument("--gain-mode", type=int, default=0, help="0 = auto, 1 = manual")
    ap.add_argument("--gain-tenths-db", type=int, default=0, help="gain in tenths of dB when gain-mode=1")
    ap.add_argument("--ppm-corr", type=int, default=0, help="PPM correction to apply during measurement (0 = measure raw)")
    ap.add_argument("--tuner-offset", type=float, default=250e3, help="LO offset from reference, Hz")
    ap.add_argument("--search-bw", type=float, default=30e3, help="search this many Hz around expected position only")
    ap.add_argument("--min-snr", type=float, default=10.0, help="reject result below this SNR (dB)")
    ap.add_argument("--listen-timeout", type=float, default=0.0,
                    help="keep streaming up to this many seconds waiting for SNR >= min-snr (0 = single-shot)")
    args = ap.parse_args()

    tune_freq = args.ref - args.tuner_offset
    n_samples = args.fft_size
    expected_baseband_hz = args.ref - tune_freq

    t0 = time.time()
    try:
        r = listen_for_signal(
            args.host, args.port, tune_freq, args.samplerate, n_samples,
            args.gain_mode, args.gain_tenths_db, args.ppm_corr,
            expected_baseband_hz, args.search_bw,
            args.min_snr, args.listen_timeout,
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": "capture_failed", "detail": str(e),
                          "port": args.port, "label": args.label}))
        return 1
    elapsed_s = time.time() - t0

    measured_signal_freq = tune_freq + r["baseband_hz"]
    offset_hz = measured_signal_freq - args.ref
    apparent_ppm = offset_hz / args.ref * 1.0e6

    result = {
        "ok": bool(r["ok"]),
        "label": args.label,
        "port": args.port,
        "tuner_type": r["tuner_type"],
        "ppm_corr_applied": int(args.ppm_corr),
        "ref_hz": args.ref,
        "tune_freq_hz": tune_freq,
        "measured_signal_hz": measured_signal_freq,
        "offset_hz": offset_hz,
        "residual_ppm": apparent_ppm,
        "raw_ppm": apparent_ppm + args.ppm_corr,
        "snr_db": r["snr_db"],
        "bin_hz": r["bin_hz"],
        "fft_size": n_samples,
        "samplerate_hz": args.samplerate,
        "chunks_tried": r["chunks_tried"],
        "reconnects": r.get("reconnects", 0),
        "elapsed_s": elapsed_s,
        "listen_timeout_s": args.listen_timeout,
        "top_peaks": r["top_peaks"],
        "search_bw_hz": args.search_bw,
        "expected_baseband_hz": expected_baseband_hz,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    print(json.dumps(result))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
