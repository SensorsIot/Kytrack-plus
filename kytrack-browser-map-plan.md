# kytrack Browser Map + Landing Forecast Plan

## Current System Readout

Local workspace contains configuration notes only, not an application source tree.
The Raspberry Pi at `192.168.0.209` runs dxlAPRS from `/opt/dxlAPRS`.

Observed live data path:

```text
RTL-SDR x2
  -> rtl_tcp on 127.0.0.1:1234 / 1235
  -> sdrtst
  -> sondeudp
  -> sondemod on UDP 4000
  -> udpgate4 on UDP 4010
  -> local APRS TCP server on 0.0.0.0:14580
  -> APRS-IS upload
```

Relevant existing capabilities:

- `udpgate4` already publishes a local APRS-IS-compatible TCP stream on port
  `14580`.
- A read test on `127.0.0.1:14580` returned both the station beacon and a live
  sonde object packet.
- `sondemod` supports decoded JSON output directly with `-J <ip>:<port>` and
  JSON file/pipe output with `-j <filename>`.
- Current dxlAPRS launch scripts do not enable `sondemod -J` yet.
- There is no persistent sonde decode log today; screen scrollback is volatile.

## Goal

Build a local web map on the Raspberry Pi showing received balloon tracks and a
real-time forecast landing point for one or more balloons.

The Pi should not perform heavy prediction loops, map rendering, track
smoothing, or UI state management. It should decode radio packets as it already
does, expose a small browser-safe feed, and serve static files. Browsers do the
forecast calculation and rendering.

## Recommended Architecture

```text
dxlAPRS decoder/gateway
  -> preferred feed: sondemod JSON UDP via -J 127.0.0.1:<port>
  -> fallback feed: APRS TCP stream from udpgate4 127.0.0.1:14580
  -> tiny kytrack-web bridge
       - receives JSON UDP or parses APRS lines
       - keeps a short in-memory recent packet buffer
       - serves static web app
       - streams packets to browsers over WebSocket or SSE
  -> browser app
       - stores per-balloon tracks
       - renders map and telemetry
       - computes predicted descent path and landing point
```

Use `sondemod -J` as the primary source. It avoids APRS text parsing and should
carry cleaner fields such as `lat`, `long`, altitude, climb rate, type, serial,
temperature, and frequency when decoded. Keep APRS parsing as a fallback because
port `14580` already exists and works.

## Backend Scope

Keep the server intentionally boring:

- Static file serving for `index.html`, JS, CSS, and icons.
- One WebSocket endpoint, for example `/ws`, or one SSE endpoint, for example
  `/events`.
- A UDP listener for `sondemod -J` JSON packets.
- Optional APRS TCP fallback reader from `127.0.0.1:14580`.
- Small ring buffer per balloon, for example last 200 points or last 6 hours.
- Health endpoint returning bridge status and latest packet age.

Avoid on the Pi:

- Forecast integration.
- Tile rendering.
- Large historical queries.
- Server-side map state.
- Server-side weather-model processing unless a later requirement proves it is
  necessary.

Best implementation fit on Raspberry Pi Bullseye:

- Python `aiohttp` or `fastapi` + `uvicorn` for a small async bridge.
- No broad database for v1. Predicted landing-point history is persisted as
  JSON keyed by sonde number; a JSONL append-only log can be added later for
  diagnostics.
- Run under `systemd` as `kytrack-web.service`.

## Browser Scope

Use a static browser app:

- Leaflet or OpenLayers for the map.
- OpenStreetMap tiles by default; optionally point at a local tile cache later.
- Web Worker for prediction math so UI stays responsive.
- Per-balloon state keyed by sonde serial/object name.
- SondeHub travelled track polyline in red, current marker, landing-point
  history polyline, ascent/descent state, burst marker if detected, predicted
  path polyline in green, landing marker, car route from RX to predicted
  landing, stale/offline styling.
- Multi-balloon selector and auto-fit controls.

The browser receives raw decoded points and computes derived values:

- Ground speed and heading from recent positions.
- Vertical rate from recent altitude samples.
- Smoothed ascent/descent state.
- Estimated burst detection from vertical-rate sign change and altitude peak.
- Forecast descent path and landing point.
- Driving route distance and duration from RX to predicted landing point.

## Landing Prediction Strategy

Implement prediction in layers so useful behavior arrives early:

1. **Tawhiri prediction v1**
   - Browser calls SondeHub's Tawhiri endpoint directly.
   - Request uses latest balloon lat/lon/altitude, browser time + 60 seconds,
     ascent rate, burst altitude, descent rate, `standard_profile`, and JSON
     format.
   - If ascending, burst altitude is max(configured burst altitude, current
     altitude + 100 m).
   - If descending, burst altitude is current altitude + 10 m.
   - If descending below 10,000 m and live vertical speed is available, use the
     absolute live vertical speed as descent rate; otherwise use configured
     descent rate.
   - Received APRS altitude is parsed from `A=` in feet and converted to metres.
   - Burst point is last point in the Tawhiri ascent trajectory.
   - Burst marker is hidden after latest local telemetry turns descending.
   - Landing point is last point in the Tawhiri descent trajectory.
   - Default settings: burst altitude 35,000 m, ascent 5 m/s, descent 5 m/s.

2. **Local extrapolation fallback**
   - Use recent observed drift vectors and vertical rate only if Tawhiri is
     unavailable.

3. **Terrain-aware landing v3**
   - Add client-side terrain lookup for the predicted region.
   - Stop descent when predicted altitude reaches terrain altitude.

## dxlAPRS Changes

Minimal preferred change:

- Add a `SONDEMOD_JSON_PORT`, for example `18600`, to
  `/opt/dxlAPRS/scripts/START_SDR_1.sh`.
- Add `-J 127.0.0.1:${SONDEMOD_JSON_PORT}` to `SONDEMOD_RUN`.
- Restart dxlAPRS during a maintenance window.

This change only duplicates decoded data to the local bridge and does not alter
APRS-IS upload behavior.

Fallback with no dxlAPRS restart:

- Have `kytrack-web` connect to `127.0.0.1:14580`, read APRS lines, and parse
  object packets like:

```text
HB9BLA-14>APLWS2,qAU,HB9BLA-15:;W4150594 *123415h4706.08N/00721.87EO099/012/A=089396...
```

This is useful for bootstrapping, but JSON is the cleaner long-term feed.

## Delivery Phases

### Phase 1: Live Map MVP

- Create `kytrack-web` bridge.
- Feed it from APRS TCP first, because it is already live.
- Serve a Leaflet app.
- Render current sonde marker, track polyline, latest telemetry, and stale state.
- Render RX marker separately from sonde markers.
- Add systemd service.

Acceptance:

- Opening `http://kytrack.local:<port>/` or `http://192.168.0.209:<port>/`
  shows live received balloon positions.
- Server CPU stays low because the backend only relays lines and static files.

### Phase 2: Browser Landing Forecast

- Move prediction logic into a browser Web Worker.
- Add predicted path and landing marker.
- Add persisted landing-point history keyed by sonde number.
- Add car route from RX to predicted landing with distance/duration.
- Support multiple balloons independently.
- Add user-adjustable assumptions for burst altitude and descent rate.

Acceptance:

- Forecast updates when new packets arrive without backend computation.
- Multiple active sondes each show their own predicted landing point.

### Phase 3: Native JSON Feed

- Enable `sondemod -J` JSON UDP output.
- Switch bridge primary parser to JSON.
- Keep APRS parser as fallback.
- Add JSONL diagnostic log rotation.

Acceptance:

- New decoded packets arrive as structured JSON in the browser.
- APRS-IS upload behavior remains unchanged.

### Phase 4: Better Forecast Inputs

- Add optional browser-side wind forecast fetch.
- Add terrain lookup.
- Cache enough data in browser storage to avoid repeated heavy downloads.

Acceptance:

- Forecast improves when network weather data is available.
- The app still works in degraded mode using received track extrapolation.

## Risks and Decisions

- Browsers cannot directly consume `udpgate4` TCP or `sondemod` UDP, so a tiny
  bridge is unavoidable.
- APRS parsing is brittle compared with `sondemod -J`; use APRS only to get the
  first map running quickly.
- External weather APIs may have CORS, rate-limit, or availability constraints.
  Keep direct browser fetch optional.
- Local tile caching can be added later, but should not be part of the first
  predictor milestone.
- Existing daily log deletion should eventually be replaced with `logrotate`,
  especially once map diagnostics are added.

## Immediate Next Step

Build Phase 1 locally in this workspace as a deployable helper app, then rsync
it to the Pi and run it as a `systemd` service. Use APRS TCP first for zero
decoder changes, then enable `sondemod -J` after the UI and bridge are proven.
