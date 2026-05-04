# kytrack

Remote-management workspace for **kytrack** — a Raspberry Pi 4 APRS balloon-tracking gateway.

## Target host

- Host: `192.168.0.209` (hostname `kytrack`)
- OS: Raspbian GNU/Linux 11 (bullseye), aarch64
- SSH: `ssh -i ~/.ssh/id_ed25519 pi@192.168.0.209`
- Env vars in container: `KYTRACK_HOST`, `KYTRACK_USER`

## What runs on kytrack

- **dxlAPRS toolchain** in `/opt/dxlAPRS/` (`bin/`, `config/`, `log/`, `scripts/`, `setup/`)
- `udpgate4` — APRS-IS UDP gateway, listens on `0.0.0.0:14580`
- `rtl_tcp` x2 — RTL-SDR receivers on `127.0.0.1:1234` and `127.0.0.1:1235`
- `mosquitto` — local MQTT broker on `127.0.0.1:1883`
- `~/liveSignal.sh` — cron every 10 min: publishes Pi `vcgencmd measure_temp` and `get_throttled` to MQTT topics `balloon-gateway/temp/` and `balloon-gateway/throttle/` on the IOTstack hub (192.168.0.203)
- Desktop autostart shortcuts: `APRSMAP`, `EDIT_APRS`, `EDIT_FREQUENCY`, `EDIT_USERINFO`

No source-code project lives on the Pi — it's a configured appliance with Bash helpers.

## Workspace layout

This devcontainer is for writing helper scripts (Bash / Python) that run *against* the kytrack Pi over SSH/MQTT, plus any local FSDs/notes. Anything that should run *on* the Pi gets deployed there via `rsync`/`scp`.

## Related infrastructure

- IOTstack hub: `192.168.0.203` (mosquitto broker, InfluxDB, Grafana). See `~/.claude/skills/remote-connections/SKILL.md`.
