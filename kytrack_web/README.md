# kytrack-web

Python backend and static browser app for the kytrack Raspberry Pi live balloon
map.

## Features

- Reads the local dxlAPRS/APRS TCP stream from `udpgate4`.
- Shows the kytrack receiver as an `RX` marker.
- Shows the active Payerne sonde by serial number.
- Fetches the travelled sonde path from SondeHub and draws it in red.
- Calls SondeHub Tawhiri directly from the browser for prediction; the
  predicted landing pin (yellow) extrapolates past the last received fix
  to the actual touchdown.
- Draws a hollow-ring **last-seen** pin where SondeHub telemetry stops
  (blackout or stationary detection), distinct from the predicted landing.
- Draws a car route from receiver to predicted landing and shows distance
  and duration in the **Drive** field.
- Pre-flight Payerne forecast in the no-flight state with the same drive
  metric; `11:00 UTC` / `23:00 UTC` slots are user-selectable from the
  **Balloon** dropdown.
- Persists predicted-landing snapshots per sonde on the Pi
  (`/var/lib/kytrack-web/landing-history.json`), de-duplicated at 100 m.
- Frontend is split into shared scaffolding plus `LiveMode` and
  `ForecastMode` objects with a small dispatcher that swaps modes based
  on the SondeHub Payerne probe.

## Run Locally

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m kytrack_web.app --port 8080
```

Open:

```text
http://127.0.0.1:8080/
```

Manual test point:

```bash
curl -X POST http://127.0.0.1:8080/api/ingest \
  -H 'content-type: application/json' \
  -d '{"id":"TEST","lat":47.47,"lon":7.75,"alt_m":12000,"climb_mps":5}'
```

## Pi Deployment

Recommended target:

```text
/opt/kytrack-web
```

Install dependencies:

```bash
cd /opt/kytrack-web
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Install service:

```bash
sudo cp systemd/kytrack-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kytrack-web.service
```

Open:

```text
http://192.168.0.209:8080/
```

## Optional sondemod JSON Feed

The service can listen for `sondemod -J` packets on UDP `127.0.0.1:18600`:

```bash
python -m kytrack_web.app --enable-udp-json
```

To use this in production, add this option to the systemd service and add
`-J 127.0.0.1:18600` to the `sondemod` command in
`/opt/dxlAPRS/scripts/START_SDR_1.sh`.

## Persistence

Predicted landing-point history is persisted per sonde number:

```text
/var/lib/kytrack-web/landing-history.json
```

HTTP API:

```text
GET  /api/landing-history/{sonde_id}
POST /api/landing-history/{sonde_id}
```
