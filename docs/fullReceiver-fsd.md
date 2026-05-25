# Full Receiver Coverage Functional Specification

## Purpose

Tune the two existing RTL-SDR dongles so that their combined coverage spans
**402.0–405.0 MHz** with intentional overlap on the dominant Payerne 403.5 MHz
channel.

The change is software-only: two channel-list files are updated. The decoder
chain, screen topology, watchdog, and APRS-IS upload path are all preserved.

## Background

Local traffic analysis (Switzerland, recent sample) shows:

- Payerne accounts for ~88 % of received sondes, almost all on **403.500 MHz**.
- Wetzikon launches transmit on **405.000 MHz** locally (not on 401.x as global
  data suggests).
- The full local population fits inside a 2.3 MHz window (**402.7 – 405.0 MHz**).

In addition, two anchor frequencies are required by spec to remain reachable
even if no current local traffic uses them:

- **402.000 MHz**
- **404.000 MHz**

The operational coverage window therefore extends to **402.0 – 405.0 MHz**
(3.0 MHz). Two RTL-SDR dongles with ~1.6 MHz usable bandwidth each provide
3.2 MHz combined — enough for the 3.0 MHz window with 200 kHz of overlap.

Today's setup covers only ~1.3 MHz (SDR1 fixed at 403.500, SDR2 sweeping
403.6–404.8). It misses 402.0, the Wetzikon 405.0 cluster, the 404.5 cluster,
and the 404.0 anchor.

## Goals

- Cover the contiguous 402.0–405.0 MHz spectrum with the two existing SDRs.
- Include **402.000**, **403.500** (Payerne), **404.000**, and **405.000**
  (Wetzikon) as continuously reachable channels.
- Decode Payerne 403.500 MHz redundantly on **both** dongles so that an antenna
  null or per-decoder framing miss on one dongle still produces a track via the
  other.
- Preserve the existing decode chain, sondemod instance count, screen
  topology, Tier-3 watchdog, APRS-IS upload path, and station identity.

## Non-Goals

- Adding a third dongle (deferred; not needed at current traffic density).
- Implementing band rotation, scanning, or signal-aware lock-on-band logic.
- Splitting `sondemod` into per-SDR instances.
- Decoding non-radiosonde signals.
- Storing per-decode telemetry beyond what dxlAPRS already does in screen
  scrollback.

## Architecture

The decoder chain remains exactly as today. Only the contents of the two
channel-list files change.

```
SDR1 → rtl_tcp(1234) → sdrtst → audio_buffer.fifo   → sondeudp → UDP 4000 ┐
                                                                           ├→ sondemod → udpgate4 → APRS-IS
SDR2 → rtl_tcp(1235) → sdrtst → audio_buffer_2.fifo → sondeudp → UDP 4000 ┘
```

### Band plan

| Dongle | Window | LO ≈ | Anchors covered |
|---|---|---|---|
| **SDR1** | 402.0 – 403.6 MHz | 402.8 | **402.000** (lower edge), Payerne **403.500** (near upper edge) |
| **SDR2** | 403.4 – 405.0 MHz | 404.2 | Payerne **403.500** (near lower edge, redundant), **404.000**, Wetzikon **405.000** (upper edge) |

Overlap: 200 kHz at 403.4–403.6 MHz. Payerne 403.500 MHz is therefore
listed in both channel files and decoded by both dongles in parallel.

Filter rolloff is ~3 dB at each dongle's outer edges. This affects:
- 402.000 MHz (SDR1 lower edge) — acceptable; capability anchor with no
  current local traffic.
- 405.000 MHz (SDR2 upper edge) — acceptable; covers the Wetzikon source.
- Payerne 403.500 MHz on each individual dongle (near each one's overlap
  edge) — but the *redundant* decode across two dongles compensates: the
  signal hits two different filter profiles and two independent demod
  paths, so net decode probability is higher than the single-dongle case.

### Channel lists

The exact channel lists are written into the two existing channel-list
files. Channel spacing is 100–300 kHz (matching observed sonde-frequency
quantisation).

**`/opt/dxlAPRS/setup/frequency_1.txt`** (SDR1)

```
f 402.000 10 60 70 6500
f 402.300 10 60 70 6500
f 402.500 10 60 70 6500
f 402.700 10 60 70 6500
f 403.000 10 60 70 6500
f 403.200 10 60 70 6500
f 403.500 10 60 70 6500
```

**`/opt/dxlAPRS/setup/frequency_2.txt`** (SDR2)

```
f 403.500 10 60 70 6500
f 403.700 10 60 70 6500
f 404.000 10 60 70 6500
f 404.200 10 60 70 6500
f 404.500 10 60 70 6500
f 404.800 10 60 70 6500
f 405.000 10 60 70 6500
```

## System Requirements

The receiver shall:

- Cover 402.0–405.0 MHz continuously across the two dongles with no
  intentional gap.
- List **402.000**, **403.500**, **404.000**, and **405.000** MHz as
  channels in at least one of the two channel files.
- List **403.500** MHz in both channel files so the Payerne anchor is
  decoded redundantly.
- Keep all anchor frequencies at least 100 kHz inside their dongle's
  outer filter edge — except where the analysis above explicitly accepts
  edge rolloff (402.000 and 405.000).
- Preserve the existing single shared `sondemod` instance on UDP 4000
  and the existing `udpgate4` aux ports.
- Preserve the existing `screen` session topology (`dxl`, `dxl_sdr2`)
  and the existing Tier-3 watchdog `pgrep` checks unchanged.
- Preserve the existing station identity (`HB9BLA-14` sender, `HB9BLA-15`
  gateway) and APRS-IS server list.

## Files

| Path | Action |
|---|---|
| `/opt/dxlAPRS/setup/frequency_1.txt` | **Replace contents** (SDR1 channel list above) |
| `/opt/dxlAPRS/setup/frequency_2.txt` | **Replace contents** (SDR2 channel list above) |
| All scripts | No change |
| Crontab / watchdog | No change |
| `user_info.txt` | No change |

## Deployment

1. Back up the current `frequency_1.txt` and `frequency_2.txt` on the Pi.
2. `rsync` the two new files into `/opt/dxlAPRS/setup/`.
3. Restart the dxlAPRS chain (re-run `START.sh`, or wait for the next
   natural restart via the Tier-3 watchdog).
4. Verify in each SDR's `screen` window that the new channel list is in
   effect (sdrtst prints its loaded channels at startup).

Total change footprint: two file replacements, ~10 lines each.

## Operational Acceptance

Acceptance is demonstrated by:

- A Payerne launch decoded by **both** SDR1 and SDR2 (visible in both
  `sondeudp` screen windows; APRS-IS upload of the resulting track).
- A Wetzikon launch (or any 405.000 MHz sonde) decoded by SDR2.
- A sonde on or near 404.000 MHz decoded by SDR2.
- A test transmission at 402.000 MHz (handheld test source or local
  signal generator) decoded by SDR1, demonstrating the capability anchor
  is live even if no operational traffic uses it.
- 24-hour clean run with no Tier-3 watchdog escalations.

## Risks

- **Edge rolloff on 402.000 and 405.000 MHz** (~3 dB). 405.000 is real
  operational traffic (Wetzikon) — if reception is consistently weak we
  may want to retune SDR2 upward (e.g. 403.5 → 405.1) at the cost of
  weakening the Payerne overlap.
- **Narrow null on 403.4 and 403.6 MHz boundaries.** A sonde transmitting
  exactly on the overlap boundary receives attenuated signal on both
  dongles. Mitigation: the channel lists already include 403.500
  redundantly; no operational frequencies are observed at 403.4 or 403.6
  in the local analysis.
- **Local analysis sample size is small.** If traffic patterns shift —
  e.g. a new launch site appears outside the 402.7–405.0 window — the
  retune is a two-file edit and is cheap to repeat.
- **No new capability for 3rd simultaneous sonde.** With one shared
  `sondemod` and two dongles, two concurrent decodes is the practical
  ceiling. The user has accepted this for the current traffic density.

## Reversibility

The change set is fully reversible:

- The deploy step backs up the existing two channel files.
- Rollback is a `cp` of the backup files plus a `START.sh` re-run.
- No process count, port assignment, or watchdog rule changes — so the
  rollback restores the system to bit-for-bit the prior behaviour.

## Future Retune — drop the 402.0 anchor

The 402.000 MHz anchor is included to support an ongoing experiment with
no current local operational traffic. When that experiment ends, the
receiver can be retuned to drop 402.0 and instead optimise SNR on
Payerne 403.5 (which today sits near each dongle's overlap edge).

The retune narrows the operational window from 402.0–405.0 MHz to
402.7–405.0 MHz, which the local analysis showed covers 100 % of
observed traffic.

| Dongle | Window | LO ≈ | Anchors covered |
|---|---|---|---|
| **SDR1** | 402.7 – 404.3 MHz | 403.5 | Payerne **403.500** well-centred |
| **SDR2** | 403.4 – 405.0 MHz | 404.2 | Payerne 403.500 (redundant), **404.000**, Wetzikon **405.000** (edge) |

In this configuration, Payerne 403.5 is no longer at any filter edge on
SDR1 — best possible decode SNR on the dominant source — and SDR2's
coverage is unchanged. The retune is a single-file edit of
`frequency_1.txt` (SDR2's list stays as defined above).

Suggested `frequency_1.txt` for this future configuration:

```
f 402.700 10 60 70 6500
f 403.000 10 60 70 6500
f 403.200 10 60 70 6500
f 403.500 10 60 70 6500
f 403.700 10 60 70 6500
f 404.000 10 60 70 6500
f 404.200 10 60 70 6500
```

Trigger condition for the retune: confirmation from the operator that
the 402 MHz experiment is complete and no further coverage at 402.000
is required.

## Related

- [[kytrack-config]] — current dxlAPRS topology, port map, channel-file
  format, and Tier-3 watchdog.
- [[kytrack-map-fsd]] — downstream consumer of decoded sondes via APRS
  TCP on port 14580.
- [[feedback_alert_policy]] — alert-only-on-give-up rule (unchanged by
  this FSD).
