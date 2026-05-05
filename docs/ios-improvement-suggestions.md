# BalloonHunter iOS — Improvement Suggestions

Reading the iOS FSD (`BalloonHunterAppFSD.md`, 2 275 lines) alongside the
kytrack-web FSD turned up a handful of places where the iOS app could be
sharpened. This document collects them, ordered by expected impact. None are
critical — the iOS spec is far more thorough than ours — but each closes a
real gap in either resilience, accuracy, or operating cost.

## 1. Throughput-based BLE staleness, not connection-state staleness

**Today.** The app trusts `connectionState == .connected` plus a 3 s
"telemetry stale" flag fed by the timestamp of the most recent decoded
packet. If MySondyGo's BLE link stays nominally up but the radio side stops
forwarding frames (low signal, antenna fault, firmware soft-fault), the
3 s timer eventually fires — but only after 3 s of silence.

**Suggested.** Track an "RX bytes per second" or "frames per second" on the
BLE channel itself, independent of decode success. When the rate falls to
zero for more than ~1 s while the connection is still claimed alive, raise
a separate "BLE silent" indicator that's distinct from "telemetry stale."
This catches the same class of fault we just fixed on the kytrack receiver:
**the connection is alive, the bytes are not.** Liveness ≠ throughput.

In practice this is a few-line addition to `BLECommunicationService`:
increment a counter on each `peripheral(_:didUpdateValueFor:error:)`, sample
it in a 1 Hz timer, expose `isBLEThroughputStalled: Bool`.

## 2. Adaptive APRS gap-fill duration

**Today.** `fillTrackGapsFromAPRS` requests `/sondes/telemetry?serial=X&duration=3d` —
~9.6 MB uncompressed (685 KB gzipped) per call, ~9 s server processing. This
is fine on the first fill but wasteful on every subsequent fill where the
local track is already current.

**Suggested.** Compute `since = max(3d_ago, last_track_point.timestamp - 60 s)`
and pass `duration = now - since`. For a steady BLE-driven session where the
last gap-fill was 5 minutes ago, this drops the request from 9.6 MB to
< 100 KB. The SondeHub endpoint already supports arbitrary `duration` values.

Falls back cleanly: if `last_track_point` is older than 3 d, use the existing
3 d limit; if there's no local track, use 3 d.

## 3. Persist the SondeHub-serial confirmation

**Today.** The "Use SondeHub serial T4630250 changed to V4210123?" popup
is intentionally non-persistent — *"the mapping is not persisted across app
launches so the prompt reappears on the next run if needed."*

**Suggested.** Persist the user's most recent confirmation (BLE serial → APRS
serial) in `UserDefaults` with a TTL of, say, 24 hours or "until next
sonde change." Clear automatically when `BalloonTrackService` detects a sonde
change. This avoids re-prompting users who relaunch the app mid-flight, while
still preventing stale mappings from outliving the actual sonde.

## 4. Time-based stationary-period window

**Today.** Stationary-period landing detection uses a **1 200-point** sliding
window. With BLE telemetry at ~1 Hz that's 20 minutes; with a sparse APRS
stream at one packet every 30 s it's 10 hours. The threshold drifts with
source rate.

**Suggested.** Switch to a time-based window: "20 minutes of telemetry,
regardless of point count." Same lat/lon/alt thresholds, just gated on
`window[end].timestamp - window[start].timestamp >= 20 minutes` instead of
`window.length >= 1200`. The detection logic stays identical; the trigger
becomes source-rate-independent.

The blackout-scenario window (>20 min gap) is already time-based — this
just makes both detectors symmetric.

## 5. Real cycling routes via OSRM, not walking-route × 0.7

**Today.** When MapKit cycling directions aren't available, the app falls
back to `MKDirectionsTransportType.walking` and multiplies the ETA by 0.7
to approximate cycling time. Distance and route geometry are still walking.
A pedestrian shortcut through a park or up a staircase is recommended for
a cyclist.

**Suggested.** When MapKit returns `.directionsNotAvailable` for cycling,
fall back to OSRM's public bicycle profile
(`https://router.project-osrm.org/route/v1/cycling/{lon},{lat};{lon},{lat}?overview=full&geometries=geojson`)
before resorting to the walking proxy. OSRM cycling routes are real cycling
routes (avoid pedestrian-only paths, follow bike infrastructure where tagged).
The straight-line heuristic remains the final fallback if both fail.

This is what kytrack-web does for its car route, and it works well enough
to ship. Cycling is the case where it matters most because the distance
distortion of "walking-as-cycling" can be ~15 %.

## 6. Optional "all sondes near me" mode

**Today.** APRS service is keyed on a single `station_id` (Payerne by
default). A balloon hunter standing in a region with multiple regular
launch sites — or chasing a record-breaker that flew in from elsewhere —
has to manually swap the station setting.

**Suggested.** Add a "nearby" mode that calls
`GET /sondes?lat=X&lon=Y&distance=200000` (the current GPS position +
200 km) and ranks results by `datetime` descending. The verification step
(launch within X km of `station_id`) is replaced by a recency check and
optionally a ground-test filter (drop candidates within 1 km of their
uploader, like the iOS APRS service already does). This is ~30 lines of
code on top of what's already there and removes the "what's my launch
site again?" friction for hunters who travel.

## 7. Ground-test filter applies to *all* candidates, not only when
   `uploader_position` is present

**Today.** The 1 km uploader-distance filter is documented as relying on
SondeHub's `uploader_position`. If that field is absent (some uploaders
omit it), the filter silently passes the candidate through.

**Suggested.** When `uploader_position` is missing, fall back to comparing
the candidate's first telemetry frame against the configured `station_id`'s
known launch coordinate. If the *first* frame is more than ~30 km from the
launch site, treat it as not-from-this-site (which subsumes ground-test
sondes 99 % of the time, since recovered sondes never start near the
launch pad). This is roughly what kytrack-web's `_verify_launch_site` does;
porting it gives the iOS filter a reliable second leg.

## 8. Surface adjusted descent rate in the UI / data panel

**Today.** `motionMetrics.adjustedDescentRateMS` is computed (60 s median
+ 20-entry rolling average) and used internally by `PredictionService`.
The data panel shows the *raw* vertical speed.

**Suggested.** Add the adjusted descent rate to the data panel during
descent (next to the raw vertical speed, perhaps as a smaller secondary
value). It's already computed and persisted; it just isn't shown. Hunters
care about it because it's what the predictor uses — making it visible
explains *why* the predicted landing point shifts when the balloon hits a
faster-than-modeled descent rate. Today the panel and the prediction can
disagree without explanation.

## 9. Prediction confidence cone (optional)

**Today.** Tawhiri returns one path. The app draws one path.

**Suggested.** Issue two extra Tawhiri requests in parallel with the
descent rate set to ±20 % of the adjusted value, draw the resulting two
extra landing points as faint markers, and connect them as a translucent
"uncertainty footprint" polygon. Hunters chasing a balloon in the last
5 km benefit from seeing where the landing *might* be, not just the point
estimate. This is one Tawhiri call → three; with the existing prediction
cache the marginal cost over a flight is small (only fires when the
prediction key actually changes).

If three calls feels too aggressive, even just one extra request at the
"natural worst case" (current vertical rate × 0.8) gives a useful
"early-arrival" landing point.

## 10. Background → foreground refresh: also re-validate the prediction cache

**Today.** When `scenePhase` returns to `.active` during a flight, the app
fires `fillTrackGapsFromAPRS()` and runs track-based landing detection.
The prediction cache is not invalidated — but if the app was backgrounded
for, say, 30 minutes, the cached entry for the *current* coarse position
has aged past the 5-minute time bucket on its own and won't be hit. So
this isn't strictly broken, but it's silently relying on the bucket logic.

**Suggested.** On foreground resume, explicitly drop any cached prediction
older than 5 minutes (regardless of bucket alignment). Trivial change,
removes the "two reasons it might be valid" ambiguity in the cache key
contract.

---

## Items intentionally not suggested

A few patterns from kytrack-web that would *not* fit the iOS app:

- **Per-process throughput watchdog (à la `kytrack-sdr-watchdog`).** Doesn't
  apply: the iOS app doesn't manage radio hardware; it talks to MySondyGo
  via BLE, and BLE has its own kernel-level liveness signals. The throughput
  idea (#1 above) is the right port of this concept.
- **Server-side track persistence with `--tracks-persist-path`.** iOS already
  persists `balloontrack.json` per current sonde with explicit save/load — the
  equivalent already exists.
- **OSE / SSE event stream.** Not relevant; the iOS app *is* the renderer.

## How these were derived

This list comes from a side-by-side read of `BalloonHunterAppFSD.md` against
`kytrack-map-fsd.md` and the issues we hit while debugging the Pi receiver
(notably the wedged `rtl_tcp` / "alive process, zero throughput" failure
mode). Items 1, 2, 4, 5, 6, 7 are direct ports of patterns that earned their
keep on the kytrack side; items 3, 8, 9, 10 are observations specific to
iOS-only behaviour described in its FSD.

None of these are blocking — the iOS spec is more thorough than ours in
absolute terms. They're sanding edges, not filling holes.
