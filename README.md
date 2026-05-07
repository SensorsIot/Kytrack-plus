# kytrack

## What It Is

kytrack is a browser map for following high-altitude balloon radiosondes from a
Raspberry Pi receiver.

It turns the Pi's local APRS or sondemod feed into a live web dashboard you can
open from a phone, tablet, or laptop while chasing a balloon. The map shows the
receiver, the active balloon, its travelled track, the predicted flight path,
the predicted landing point, and the driving route from the receiver to that
landing. When no flight is in progress, it instead shows a pre-flight forecast
for the next Payerne launch slot (selectable between `11:00 UTC` and
`23:00 UTC` from the **Balloon** dropdown) so you can plan a chase before
launch.

Most users will run kytrack on the Raspberry Pi connected to the receiver, then
open the dashboard at `http://<pi-ip-address>:8080/` from another device.

## What You Get

- Live balloon positions from the Pi's local `udpgate4` APRS stream.
- Optional `sondemod -J` JSON input over UDP.
- A browser map with balloon selection, altitude, climb, speed, burst estimate,
  landing estimate, and drive distance/time.
- SondeHub path lookup for the travelled balloon track.
- Browser-side Tawhiri prediction through SondeHub, refreshed for every new
  fix and continued past the last received telemetry until ground level.
- A separate **last-seen** marker (hollow ring) at the last received fix —
  radiosondes typically lose telemetry well above ground, so the predicted
  landing pin marks the actual touchdown, not the last reported position.
- A purple landing-history polyline showing how the predicted landing point
  has moved between predictions (de-duplicated at 100 m).
- Pre-flight Payerne forecast (`11:00 UTC` / `23:00 UTC` slots) with full
  trajectory and driving route when no balloon is in the air.
- Backend log of every predicted landing per sonde (de-duplicated at 100 m)
  in `/var/lib/kytrack-web/landing-history.json`.
- A systemd service for running the web app on a Raspberry Pi.

## Requirements

- Python 3.9 or newer.
- The kytrack Raspberry Pi connected to the balloon receiver.
- For live APRS data, `udpgate4` listening on TCP port `14580` by default.
- Internet access from the browser for map tiles, Leaflet, SondeHub, and routing.

## Install On The kytrack Raspberry Pi

The included service expects the app to live at `/opt/kytrack-web`.

```bash
sudo mkdir -p /opt/kytrack-web
sudo rsync -a kytrack_web/ /opt/kytrack-web/
cd /opt/kytrack-web
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Install and start the service:

```bash
sudo cp systemd/kytrack-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kytrack-web.service
```

Then open the Pi from another device on the same network:

```text
http://<pi-ip-address>:8080/
```

## Data Feeds

By default, kytrack connects to APRS data at:

```text
127.0.0.1:14580
```

You can override this when starting the app:

```bash
python -m kytrack_web.app --aprs-host 192.168.0.209 --aprs-port 14580
```

To use `sondemod -J` JSON packets instead, start kytrack with UDP JSON enabled:

```bash
python -m kytrack_web.app --enable-udp-json
```

Then configure `sondemod` to send JSON to:

```text
127.0.0.1:18600
```

For the systemd service, add `--enable-udp-json` to `ExecStart` in
`/etc/systemd/system/kytrack-web.service`, then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kytrack-web.service
```

## Useful Commands

Check whether the service is running:

```bash
systemctl status kytrack-web.service
```

Follow logs:

```bash
journalctl -u kytrack-web.service -f
```

Check app health:

```bash
curl http://127.0.0.1:8080/api/health
```

## Configuration

Command-line options can also be set with environment variables:

| Option | Environment variable | Default |
| --- | --- | --- |
| `--host` | `KYTRACK_WEB_HOST` | `0.0.0.0` |
| `--port` | `KYTRACK_WEB_PORT` | `8080` |
| `--aprs-host` | `KYTRACK_APRS_HOST` | `127.0.0.1` |
| `--aprs-port` | `KYTRACK_APRS_PORT` | `14580` |
| `--udp-host` | `KYTRACK_UDP_HOST` | `127.0.0.1` |
| `--udp-port` | `KYTRACK_UDP_PORT` | `18600` |
| `--max-points` | `KYTRACK_MAX_POINTS` | `300` |
| `--landing-history-path` | `KYTRACK_LANDING_HISTORY_PATH` | `/var/lib/kytrack-web/landing-history.json` |

Predicted landing history is stored at:

```text
/var/lib/kytrack-web/landing-history.json
```

## Project Layout

```text
kytrack_web/
  kytrack_web/        Python backend
  static/             Browser map
  systemd/            Raspberry Pi service file
  tests/              Parser tests
  requirements.txt    Python dependencies
```

## Development

Run tests from the web app directory:

```bash
cd kytrack_web
pip install pytest
python -m pytest
```
