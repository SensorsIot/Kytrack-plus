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
- `GET /api/landing-history/{sonde_id}` returns persisted predicted landing
  points for one sonde.
- `POST /api/landing-history/{sonde_id}` appends a predicted landing point for
  one sonde, deduplicating against the previous point within 25 m.

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

## Acceptance Criteria

- The web app loads from the Pi.
- At least one live APRS sonde object appears on the map when `udpgate4` emits
  packets.
- Browser CPU handles map and prediction updates; backend CPU remains low.
- `/api/health` reports whether APRS and UDP sources are active.
- Restarting the web service does not affect dxlAPRS decoding or APRS-IS upload.
