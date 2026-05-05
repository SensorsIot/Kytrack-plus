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
- Detect landing from the SondeHub flight history after the altitude peak:
  - **Blackout**: any gap > 20 min between consecutive points → landing
    point = last point before the gap.
  - **Stationary**: a 20-min sliding window where the per-sample mean
    |Δlat| and |Δlon| are < 0.0001° and the mean |Δalt| is < 0.3 m/sample
    → landing point = window start.
  When detected, draw the landing marker, switch the balloon icon to the
  "landed" style, and freeze further Tawhiri prediction calls for that
  balloon (the ground truth replaces the forecast).

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
- Landing point history is recorded from prediction updates, persisted on the
  Pi keyed by sonde number, and drawn as a purple polyline. New landing points
  are deduplicated when within 25 m of the previous landing point.
- Persistence file: `/var/lib/kytrack-web/landing-history.json`.
- API:
  - `GET /api/landing-history/{sonde_id}`
  - `POST /api/landing-history/{sonde_id}`

## Car Route Overlay

The browser draws the driving route from the local receiver marker to the latest
predicted landing point.

- Route source: OSRM public demo route endpoint.
- Profile: car/driving.
- Route is fetched directly by the browser.
- The Pi backend does not calculate routing.
- Route is refreshed when the receiver position or predicted landing point
  changes.
- The route is drawn as a prominent solid dark polyline.
- Driving distance and estimated duration are shown in the side panel for the
  selected sonde.

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
  one sonde, deduplicating against the previous point within 25 m.

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
