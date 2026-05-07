# kytrack Live Map Functional Specification

## Purpose

Provide a local web map on the Raspberry Pi that shows received radiosonde /
balloon positions and a continuously updated browser-side landing forecast.

The backend runs entirely on the Pi. It receives decoded balloon positions from
the existing dxlAPRS stack, serves the web app, and relays live points to
browsers. The browser performs map rendering, track state, and prediction work.

## Users

- Field operator watching active balloon flights on the Pi LAN.
- Remote operator connected to the same network or VPN.

## Non-Goals

- Replace dxlAPRS decoding or APRS-IS upload.
- Perform heavy prediction or map rendering on the Pi.
- Provide a broad historical database in v1. Only predicted landing-point
  history is persisted.
- Guarantee meteorological-grade landing predictions without wind-model data.

## Existing Inputs

Primary supported inputs:

- APRS TCP stream from local `udpgate4` on `127.0.0.1:14580`.
- Optional structured JSON datagrams from `sondemod -J 127.0.0.1:<port>`.

The first implementation uses APRS TCP because it is already enabled on
kytrack. JSON UDP is implemented as a cleaner upgrade path.

## Backend Requirements

The backend shall:

- Run on Raspberry Pi OS as a Python service.
- Serve static frontend files.
- Connect to `udpgate4` APRS TCP and parse sonde object packets.
- Parse local receiver beacons as receiver markers, not balloons.
- Listen for optional `sondemod -J` JSON UDP packets.
- Normalize decoded points into a stable browser event schema.
- Keep a bounded in-memory track buffer per balloon.
- Stream snapshots and new points to browsers using Server-Sent Events.
- Expose a health endpoint with source status and latest packet age.
- Periodically poll SondeHub for the newest sonde launched within a configured
  radius of a known launch site (default Payerne, WMO 06610) and ingest its
  current telemetry as a normalized point so the page shows the site flight
  even when the local receiver hasn't acquired it yet. A candidate is accepted
  only after verification that its earliest telemetry frame is within the
  configured launch radius (default 15 km).
- Expose a manual refresh endpoint that triggers the site poll synchronously
  so the page can force a fresh search on load.
- Persist the per-balloon track buffer to disk every N points (default 10) and
  on shutdown, and reload it on startup so a service restart doesn't lose the
  in-flight history.
- Use low CPU and memory under normal operation.

The backend shall not:

- Compute landing forecasts.
- Render map tiles.
- Maintain complex per-user UI state.

## Frontend Requirements

The browser app shall:

- Display an OpenStreetMap-based Leaflet map.
- Show each active balloon's current position.
- Show the local receiver as a separate `RX` marker.
- Show the current locally received balloon position without drawing a separate
  local receiver track line.
- Fetch and draw travelled track history from SondeHub telemetry for each active
  sonde.
- Show latest telemetry for the selected balloon.
- Run landing prediction in a Web Worker.
- Draw predicted path and landing marker.
- Hide the burst marker once the latest local telemetry is descending.
- Draw a car route from the receiver marker to the predicted landing point and
  show route distance/duration.
- Support more than one active balloon.
- Mark stale balloons visually.
- On page load, open the SSE stream first and then `POST /api/sonde/refresh`
  in parallel so the freshest site sonde appears within ~1 s without waiting
  for the next periodic poll.
- Auto-select and pan to the balloon with the most recent received_at on
  every update. A manual selection from the dropdown sticks until that track
  no longer exists.
- Feed prediction motion estimation from the SondeHub flight history when it
  is longer than the local APRS track, so a prediction renders on the very
  first ingested point instead of waiting for ≥2 local packets.
- Smooth motion before sending it to Tawhiri: apply a Hampel outlier filter
  (window 10, k = 3) plus an exponential moving average (τ = 10 s) to the
  per-step horizontal and vertical rates derived from the track. Below
  10 km altitude, use the median of the last 60 s of vertical-rate samples
  (the *adjusted descent rate*) as Tawhiri's `descent_rate` so the predicted
  landing tracks the balloon's actual terminal velocity instead of the
  configured constant.
- Cache Tawhiri responses in the browser keyed on
  `id | lat@2dp | lon@2dp | alt/100 | 5-min bucket`, capacity 50, LRU
  eviction. A repeated prediction for the same coarse position within the
  same 5-minute bucket reuses the previous result instead of refiring the
  API call.
- Mark the balloon visually stale (grey marker, "X s/m ago" label) when the
  latest point is more than 3 s old. A 1 Hz timer refreshes the marker class
  and the "last seen" string.
- Detect a **last-seen** point on the SondeHub flight history once the
  altitude peak is past — radiosondes typically lose telemetry above ground
  level, so the last received fix is not the actual landing.
  - **Blackout**: any gap > 20 min between consecutive points → last-seen
    point = last point before the gap.
  - **Stationary**: a 20-min sliding window where the per-sample mean
    |Δlat| and |Δlon| are < 0.0001° and the mean |Δalt| is < 0.3 m/sample
    → last-seen point = window start.
  When detected, draw a hollow-ring **last-seen marker** at that point and
  switch the balloon icon to the post-flight style. **Continue** running
  Tawhiri so the predicted landing (yellow pin) extrapolates from the
  last-seen point to ground, and the OSRM driving route follows the
  predicted landing — not the last-seen point.
- Hide the live telemetry rows (Last, Altitude, Climb, Speed, Burst,
  Landing) when no live track is selected, leaving only the Drive metric
  visible. This keeps the side panel relevant in the no-flight state and
  during initial bootstrap.
- Maintain a **flying / no-flight** state (see "No-Flight State"). In the
  no-flight state, suppress every live-balloon overlay and render only the
  pre-flight forecast and its car route.
- Implement the two states as **`LiveMode`** and **`ForecastMode`** objects
  with a shared `enter / exit / refresh / onPoint / onSelect / onPrediction
  / onReceiverUpdate / onSettingsChanged / render` lifecycle. A small
  dispatcher swaps the active mode based on the Payerne probe result;
  every mode-specific Map / Set / interval lives on the mode object so a
  transition fully cleans up its overlays and timers. SSE points, worker
  prediction replies, dropdown changes, and settings changes are routed
  through the active mode, with each async fetch handler ignoring its own
  reply if the active mode has changed in the meantime.

## Normalized Point Schema

Events sent from backend to browser use this shape:

```json
{
  "type": "point",
  "point": {
    "id": "W4150594",
    "source": "aprs",
    "received_at": "2026-05-04T12:34:56Z",
    "lat": 47.101333,
    "lon": 7.3645,
    "alt_m": 27248,
    "climb_mps": 3.4,
    "course_deg": 99,
    "speed_mps": 6.17,
    "raw": "original APRS or JSON payload",
    "meta": {
      "callsign": "HB9BLA-14",
      "type": "RS41-SG",
      "frequency_mhz": 404.5
    }
  }
}
```

Receiver beacons use `source: "receiver"` and are excluded from balloon
selection, SondeHub track fetching, prediction, and landing history.

Snapshots use:

```json
{
  "type": "snapshot",
  "tracks": {
    "W4150594": [{ "id": "W4150594", "lat": 47.1, "lon": 7.3 }]
  }
}
```

## Landing Forecast V1

The browser computes predictions using the same model family as BalloonHunter:
SondeHub's Tawhiri endpoint. The backend still does not compute predictions.

- Received APRS altitude is parsed from `A=` in feet and converted to metres.
- Tawhiri request fields:
  - `launch_latitude`: latest balloon latitude.
  - `launch_longitude`: latest balloon longitude.
  - `launch_datetime`: browser time plus 60 seconds.
  - `launch_altitude`: latest balloon altitude in metres.
  - `ascent_rate`: configured ascent rate.
  - `burst_altitude`: if ascending, max(configured burst altitude, current
    altitude + 100 m); if descending, current altitude + 10 m.
  - `descent_rate`: configured descent rate, except when descending below
    10,000 m and a live negative vertical speed is available; then use the
    absolute live vertical speed.
  - `profile`: `standard_profile`.
  - `format`: `json`.
- Default prediction settings:
  - burst altitude: 35,000 m
  - ascent rate: 5 m/s
  - descent rate: 5 m/s
- Tawhiri response parsing:
  - prediction path is the concatenation of all stage trajectories.
  - burst point is the last point in the `ascent` trajectory.
  - landing point is the last point in the `descent` trajectory.
- Burst marker visibility:
  - shown only while latest local vertical speed is non-negative.
  - hidden once latest local vertical speed is negative, because burst is in the
    past.
- If Tawhiri is unavailable, the browser may temporarily fall back to a simple
  local extrapolation so the map remains usable.

### Pre-flight Forecast

When the browser is in the no-flight state (see "No-Flight State"), it
requests a single Tawhiri prediction for the next scheduled Payerne launch
slot. No real track is required.

- Slot times: 11:00 UTC and 23:00 UTC. The browser picks the earliest slot
  whose UTC time is strictly in the future; if both have passed today, it
  picks 11:00 UTC tomorrow.
- Tawhiri request fields:
  - `launch_latitude`: 46.8117
  - `launch_longitude`: 6.9425
  - `launch_altitude`: 491 m
  - `launch_datetime`: next slot in UTC.
  - `ascent_rate`, `burst_altitude`, `descent_rate`: from the configured
    prediction settings. The adjusted-descent-rate path does not apply
    because no live telemetry exists.
  - `profile`: `standard_profile`.
  - `format`: `json`.
- Rendering:
  - Predicted path drawn as a **dashed grey** polyline, visually distinct
    from the live solid green prediction polyline.
  - Launch marker at Payerne with tooltip
    `Payerne forecast — launch HH:00 UTC`.
  - Burst marker at the predicted burst point. The pre-flight balloon is
    by definition ascending (it has not launched yet), so the burst marker
    is always shown for the forecast.
  - Landing marker at the predicted landing point with tooltip
    `Forecast landing HH:MM UTC`, where `HH:MM` is the **predicted
    touchdown** time (taken from the last point of Tawhiri's descent
    trajectory), not the launch slot.
  - No SondeHub track is drawn (no telemetry exists). No landing-history
    line.
- Refresh triggers:
  - On entering the no-flight state.
  - Each minute, if the previously requested slot is in the past, request
    the next slot.
  - When the user changes any of `ascent_rate`, `burst_altitude`, or
    `descent_rate` while in the no-flight state.
  - When the user picks a slot from the **Balloon** dropdown (see below).
- Slot picker: in the no-flight state the Balloon dropdown offers two
  options — `11:00 UTC` and `23:00 UTC` — pre-selecting whichever matches
  the currently rendered forecast (defaults to the upcoming slot).
  Selecting the other re-runs Tawhiri for **today's** instance of that
  hour, regardless of whether the hour has already passed today, and
  redraws the trajectory, landing pin, and driving route. The dropdown
  reverts to listing live sonde IDs as soon as a flight starts.
- The OSRM car route from the receiver marker to the predicted landing
  point is drawn the same way as in the live case, and its driving
  distance and duration appear in the side panel's **Drive** field.

## Travelled Track History

The browser fetches SondeHub telemetry history for each active sonde:

```text
GET https://api.v2.sondehub.org/sondes/telemetry?serial={serial}&duration=3d
```

The response is parsed as `{ serial: { timestamp: telemetry_point } }`.

- Points are deduplicated by timestamp rounded to the nearest second.
- Points are sorted chronologically.
- Invalid coordinates and `(0,0)` points are ignored.
- The SondeHub travelled track is drawn as a prominent solid red polyline.
- Locally received APRS points update the current marker and prediction, but no
  separate local receiver track polyline is drawn.
- Fetch cadence is at most once per sonde per 60 seconds.
- The prediction path is drawn as a prominent solid green polyline.
- Only the **current** predicted landing point is shown (yellow marker).
  No history of past predicted landing points is rendered or persisted on
  the frontend; the visual clutter from a long-running flight's drifting
  prediction was not informative. The backend's
  `/api/landing-history/{sonde_id}` endpoints remain available for
  external use but are no longer exercised by this app.

## No-Flight State

The browser determines flight state by querying SondeHub directly — see
"Payerne Probe" below. The backend snapshot is not used for this decision,
because it includes persisted tracks from past flights that would
incorrectly read as "flying."

- **Flying**: the SondeHub probe returns a verified Payerne sonde serial.
- **No-flight**: the probe returns `null` (no Payerne sonde is reporting
  telemetry within the search radius).

In the no-flight state the browser hides every live-balloon overlay —
balloon markers, SondeHub red track polylines, predicted ascent/descent
polylines, burst markers, predicted landing markers, predicted-landing
history (purple) polylines, and the OSRM car route to those landings — and
shows only the pre-flight forecast (see "Pre-flight Forecast" under
"Landing Forecast V1") together with its car route.

Transitions:

- On the probe returning a serial for the first time (or a different
  serial): clear any pre-flight forecast and render the live overlays for
  that serial.
- On the probe returning `null`: clear the live overlays and show the
  pre-flight forecast for the next slot.

Non-Payerne sondes — whether received via local APRS, SondeHub history, or
the backend SSE feed — are never rendered on this map. Only points whose
`id` matches the currently verified Payerne serial are accepted.

## Payerne Probe

The browser determines the currently flying Payerne sonde by querying
SondeHub directly with a single per-site request. The probe runs on page
load and every `PAYERNE_PROBE_INTERVAL_MS` (default 60 s).

- Single call:
  `GET https://api.v2.sondehub.org/sondes/site/06610`.
  Payerne's WMO station ID is `06610`. The response is a map of
  `{ serial: latest_telemetry_frame }` for sondes that SondeHub
  associates with that site. No coordinate filtering, no distance check,
  and no separate launch-site verification step are needed — the site
  endpoint already does the launch-site grouping for us.
- Pick the entry with the freshest `datetime`.
- If the freshest entry's `datetime` is within the last
  `PAYERNE_FRESH_MS` (default 30 min), return that serial. Otherwise
  return `null` — the response can include sondes from previous flights
  that have already landed, so a recency check is required to distinguish
  "currently flying" from "landed earlier today."

By deciding flight state from this fresh SondeHub query rather than from
the backend's persisted snapshot, the page is unaffected by stale
historical tracks left over from previous flights.

### Live updates vs. SondeHub fill-in

For a flying balloon, position updates flow from the SSE stream emitted
by the kytrack backend (local APRS via `udpgate4` and the backend's own
Payerne poller). The frontend updates the balloon marker on every SSE
`point` event whose `id` matches the verified Payerne serial.

SondeHub `/sondes/telemetry?serial=<X>&duration=3d` is used only as a
fill-in:

- **Initial seed**: when a new Payerne serial is first identified, the
  full SondeHub flight history is fetched once to seed the track and
  prediction.
- **Gap recovery**: on each periodic probe, if the latest SSE point in
  `state.tracks` is more than 120 s old, the SondeHub history is
  re-fetched to fill any gap. While SSE is delivering points (latest
  point ≤ 120 s old), the probe does not touch the per-sonde SondeHub
  endpoint.

The launch site coordinates used by the Pre-flight Forecast (lat
46.8117 N, lon 6.9425 E, alt 491 m) are the canonical position of WMO
station `06610` and match SondeHub's `/sites` registry entry for Payerne.

## Car Route Overlay

The browser draws the driving route from the local receiver marker to the
latest predicted landing point. This applies both to live predictions for a
flying balloon and to the pre-flight forecast in the no-flight state.

- Route source: OSRM public demo route endpoint.
- Profile: car/driving.
- Route is fetched directly by the browser.
- The Pi backend does not calculate routing.
- Route is re-fetched on every new prediction tick, so a moving predicted
  landing always has a matching driving line. It is also re-fetched when
  the receiver position changes.
- The route is drawn as a prominent solid dark polyline.
- Driving distance and estimated duration are shown in the side panel's
  **Drive** field for both the selected live sonde and the no-flight
  forecast.

The result is not a meteorological model. It is a live operational estimate
that improves as real descent data arrives.

## HTTP Interface

- `GET /` serves the map.
- `GET /events` streams SSE events.
- `GET /api/snapshot` returns current in-memory tracks.
- `GET /api/health` returns service health.
- `POST /api/ingest` accepts a normalized point for manual testing.
- `POST /api/sonde/refresh` triggers an immediate SondeHub poll for the
  configured launch site, ingests the freshest verified sonde, and returns
  the resulting track (or `null`).
- `GET /api/landing-history/{sonde_id}` returns persisted predicted landing
  points for one sonde.
- `POST /api/landing-history/{sonde_id}` appends a predicted landing point for
  one sonde, deduplicating against the previous point within 100 m.

## Site Sonde Polling

The backend keeps a separate ingest path for the configured launch site so the
page stays useful even when the local receiver doesn't pick up the flight.

- Default site: Payerne (WMO 06610), 46.8117 N / 6.9425 E.
- Adaptive poll cadence based on the age of the latest ingested point:
  - `< 2 min` old → `--payerne-poll-fresh` (default 15 s).
  - `2–30 min` old → `--payerne-poll-stale` (default 300 s).
  - `> 30 min` old or never seen → `--payerne-poll-idle` (default 3600 s).
  This keeps API rate low when nothing is in the air and reacts within ~15 s
  during an active flight.
- Also runnable on demand via `POST /api/sonde/refresh`.
- Step 1 — list candidates: `GET /sondes` near the site (`lat`, `lon`,
  `distance` = `--payerne-search-radius-m`, default 250 km). Sondes are
  sorted by `datetime` descending.
- Step 1b — ground-test filter: candidates broadcasting from within
  `--payerne-ground-test-radius-m` of their reported `uploader_position`
  (default 1 km) are dropped. This rejects recovered/test sondes parked next
  to a receiver from being mistaken for a flying balloon.
- Step 2 — verify each new candidate: `GET /sondes/telemetry?serial=X` and
  check the earliest frame's distance to the site is ≤
  `--payerne-launch-radius-m` (default 15 km). Verification result is cached
  per serial so SondeHub is queried at most once per serial.
- Step 3 — ingest only the freshest verified Payerne sonde, deduped by
  `datetime`. The point uses `source: "sondehub-payerne"` and the SondeHub
  `datetime` as `received_at`. Concurrent calls (periodic + on-demand) are
  serialised by an `asyncio.Lock`.

Configurable via `--payerne-*` flags or `KYTRACK_PAYERNE_*` env vars; can be
disabled with `--no-payerne`.

## Deployment

Recommended Pi path:

```text
/opt/kytrack-web
```

Recommended service:

```text
kytrack-web.service
```

Default service port:

```text
8080
```

Operator URL:

```text
http://192.168.0.209:8080/
```

## SDR Watchdog (kytrack-sdr-watchdog.service)

A separate service running alongside `kytrack-web.service` that detects and
recovers from a wedged `rtl_tcp`. It exists because the dxlAPRS chain has no
internal "bytes are flowing" assertion: when `librtlsdr` fails to submit a
USB bulk transfer at startup, `rtl_tcp`'s worker thread can die silently while
the TCP listener stays up, so process liveness, socket liveness, and PID
checks all show "healthy" — but `sondemod` never sees a frame.

Detection signal:

- Read kernel `tcp_info.bytes_sent` for each `rtl_tcp` listening port via
  `ss -ti`, twice with a sleep in between. Healthy → ~4 MB/s. Wedged → 0.
- This signal is **signal-independent**: an RTL-SDR streams IQ at the
  configured rate regardless of antenna content, so the byte counter ticks
  24/7 even when no sonde is in the air. A "no sonde decoded in N hours"
  check would be wrong because it requires a sonde to be flying.
- `wchar` from `/proc/<pid>/io` is *not* used; on the running platform it
  does not reflect `rtl_tcp`'s actual send path and stays near zero on the
  healthy SDR. `bytes_sent` from `tcp_info` is the kernel's authoritative
  byte counter.

Recovery action:

- Capture the wedged `rtl_tcp`'s argv via `ps -o args=`.
- `kill -INT` then `kill -KILL` the wedged PID.
- Re-issue the same argv into the existing dxlAPRS screen window via
  `screen -S <session> -p rtl_tcp -X stuff "<argv>\n"`. `sdrtst` reconnects
  to the new listener automatically.

Operating envelope:

- Watches every `rtl_tcp` listening port (default: 1234 → SDR-0/`dxl`,
  1235 → SDR-1/`dxl_sdr2`).
- Loop interval: `INTERVAL` (default 30 s).
- Wedge threshold: `MIN_BYTES` (default 1 000 000 B over the interval; healthy
  is ~125 MB).
- Post-restart grace: `GRACE` (default 60 s) so a slow respawn doesn't get
  re-killed.
- Each watched SDR is independent: restarting one does not perturb the other.
- Runs as user `pi` so it can address the existing user-owned screen sessions.

Acceptance criteria:

- When either `rtl_tcp` shows zero TCP throughput for ≥ `INTERVAL`, the
  watchdog logs the wedge to journald, kills the process, and re-issues its
  argv to the matching screen window.
- After respawn, `bytes_sent` resumes at ~4 MB/s and `sondemod` decodes
  frames again on that frequency.
- The other (healthy) SDR is untouched throughout.

## Acceptance Criteria

- The web app loads from the Pi.
- At least one live APRS sonde object appears on the map when `udpgate4` emits
  packets.
- Browser CPU handles map and prediction updates; backend CPU remains low.
- `/api/health` reports whether APRS and UDP sources are active.
- Restarting the web service does not affect dxlAPRS decoding or APRS-IS upload.
- On page load, the freshest sonde launched from the configured site appears
  within a few seconds even before the periodic poll cycle elapses.
- A wedged `rtl_tcp` is detected and respawned automatically within
  `INTERVAL + GRACE` seconds without operator intervention.
- When no Payerne sonde has been ingested, the map shows only the
  pre-flight forecast (dashed grey trajectory from Payerne to the predicted
  landing point) and the OSRM car route from the receiver to that landing.
  No other balloon overlays are visible.
- As soon as the Payerne poller ingests its first `sondehub-payerne` point,
  the pre-flight forecast disappears and is replaced by the live SondeHub
  red track, the green live prediction, the predicted landing marker, and
  the car route for that flight.
- During descent, when the SondeHub flight history goes stationary or
  blacks out, a hollow-ring last-seen marker appears at the last fix while
  the green descent line and the yellow landing pin continue to the
  predicted touchdown. The black driving line ends at the yellow landing
  pin, not at the last-seen marker.
- In the no-flight state the **Balloon** dropdown offers `11:00 UTC` and
  `23:00 UTC`; selecting either re-runs the Tawhiri forecast for today's
  instance of that hour and the new trajectory, landing pin, and driving
  metric appear within a few seconds.
