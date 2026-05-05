from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Optional

import aiohttp
from aiohttp import web

from .models import Point, utc_now_iso
from .parsers import parse_aprs_line, parse_sondemod_json

SONDEHUB_API = "https://api.v2.sondehub.org"

BASE_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BASE_DIR / "static"


class TrackStore:
    def __init__(self, max_points: int) -> None:
        self._tracks: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=max_points))
        self._latest_at: Optional[str] = None

    @property
    def latest_at(self) -> Optional[str]:
        return self._latest_at

    def add(self, point: Point) -> dict[str, Any]:
        item = point.to_dict()
        self._tracks[point.id].append(item)
        self._latest_at = point.received_at
        return item

    def snapshot(self) -> dict[str, list[dict[str, Any]]]:
        return {track_id: list(points) for track_id, points in self._tracks.items()}


class Hub:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._queues.discard(queue)

    async def publish(self, event: dict[str, Any]) -> None:
        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._queues:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self.unsubscribe(queue)


class LandingHistoryStore:
    def __init__(self, path: Path, max_points: int = 200) -> None:
        self.path = path
        self.max_points = max_points
        self._lock = asyncio.Lock()
        self._items: dict[str, list[dict[str, Any]]] = {}

    async def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(data, dict):
            self._items = {
                str(sonde): [point for point in points if isinstance(point, dict)]
                for sonde, points in data.items()
                if isinstance(points, list)
            }

    async def get(self, sonde_id: str) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._items.get(sonde_id, []))

    async def add(self, sonde_id: str, point: dict[str, Any]) -> list[dict[str, Any]]:
        normalized = {
            "lat": float(point["lat"]),
            "lon": float(point["lon"]),
            "alt_m": _optional_float(point.get("alt_m")),
            "at": str(point.get("at") or utc_now_iso()),
        }
        async with self._lock:
            points = self._items.setdefault(sonde_id, [])
            if points and distance_m(points[-1], normalized) < 25:
                return list(points)
            points.append(normalized)
            del points[:-self.max_points]
            await self._save_locked()
            return list(points)

    async def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._items, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)


class AppState:
    def __init__(self, max_points: int, landing_history_path: Path) -> None:
        self.store = TrackStore(max_points=max_points)
        self.landing_history = LandingHistoryStore(landing_history_path)
        self.hub = Hub()
        self.site_verified: dict[str, bool] = {}
        self.site_last_dt: dict[str, str] = {}
        self.site_poll_lock = asyncio.Lock()
        self.status: dict[str, Any] = {
            "started_at": utc_now_iso(),
            "aprs": {"connected": False, "last_line_at": None, "last_point_at": None, "errors": 0},
            "udp_json": {"listening": False, "last_packet_at": None, "last_point_at": None, "errors": 0},
        }

    async def add_point(self, point: Point) -> None:
        item = self.store.add(point)
        await self.hub.publish({"type": "point", "point": item})


async def aprs_reader(state: AppState, host: str, port: int, enabled: bool) -> None:
    if not enabled:
        return
    while True:
        writer: Optional[asyncio.StreamWriter] = None
        try:
            reader, writer = await asyncio.open_connection(host, port)
            state.status["aprs"]["connected"] = True
            while True:
                line = await reader.readline()
                if not line:
                    break
                state.status["aprs"]["last_line_at"] = utc_now_iso()
                try:
                    point = parse_aprs_line(line.decode("utf-8", errors="replace"))
                except Exception:
                    state.status["aprs"]["errors"] += 1
                    continue
                if point:
                    state.status["aprs"]["last_point_at"] = point.received_at
                    await state.add_point(point)
        except asyncio.CancelledError:
            raise
        except Exception:
            state.status["aprs"]["errors"] += 1
        finally:
            state.status["aprs"]["connected"] = False
            if writer:
                with contextlib.suppress(Exception):
                    writer.close()
        await asyncio.sleep(5)


class JsonDatagramProtocol(asyncio.DatagramProtocol):
    def __init__(self, state: AppState) -> None:
        self.state = state

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        self.state.status["udp_json"]["last_packet_at"] = utc_now_iso()
        asyncio.create_task(self._handle(data))

    async def _handle(self, data: bytes) -> None:
        try:
            point = parse_sondemod_json(data)
        except Exception:
            self.state.status["udp_json"]["errors"] += 1
            return
        if point:
            self.state.status["udp_json"]["last_point_at"] = point.received_at
            await self.state.add_point(point)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    from math import asin, cos, radians, sin, sqrt

    radius = 6371000
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return 2 * radius * asin(sqrt(a))


async def site_sonde_poller(
    state: AppState,
    session: aiohttp.ClientSession,
    cfg: argparse.Namespace,
) -> None:
    if not cfg.payerne_enabled or cfg.payerne_poll_interval <= 0:
        return
    while True:
        try:
            await _poll_site_once(state, session, cfg)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        try:
            await asyncio.sleep(cfg.payerne_poll_interval)
        except asyncio.CancelledError:
            raise


async def _poll_site_once(
    state: AppState,
    session: aiohttp.ClientSession,
    cfg: argparse.Namespace,
) -> None:
    async with state.site_poll_lock:
        params = {
            "last": str(int(cfg.payerne_lookback_seconds)),
            "lat": f"{cfg.payerne_lat}",
            "lon": f"{cfg.payerne_lon}",
            "distance": str(int(cfg.payerne_search_radius_m)),
        }
        timeout = aiohttp.ClientTimeout(total=15)
        async with session.get(f"{SONDEHUB_API}/sondes", params=params, timeout=timeout) as resp:
            if resp.status != 200:
                return
            data = await resp.json()
        if not isinstance(data, dict):
            return
        candidates: list[tuple[str, str, dict[str, Any]]] = []
        for serial, info in data.items():
            if not isinstance(info, dict):
                continue
            dt = info.get("datetime")
            if not dt:
                continue
            candidates.append((str(dt), str(serial), info))
        candidates.sort(reverse=True)
        for dt, serial, info in candidates:
            if state.site_verified.get(serial) is False:
                continue
            if serial not in state.site_verified:
                ok = await _verify_launch_site(session, serial, cfg)
                state.site_verified[serial] = ok
                if not ok:
                    continue
            if state.site_last_dt.get(serial) == dt:
                return
            state.site_last_dt[serial] = dt
            await _ingest_site_point(state, serial, info, cfg)
            return


async def _verify_launch_site(
    session: aiohttp.ClientSession,
    serial: str,
    cfg: argparse.Namespace,
) -> bool:
    timeout = aiohttp.ClientTimeout(total=15)
    params = {"serial": serial, "duration": "12h"}
    try:
        async with session.get(f"{SONDEHUB_API}/sondes/telemetry", params=params, timeout=timeout) as resp:
            if resp.status != 200:
                return False
            data = await resp.json()
    except Exception:
        return False
    serial_data = data.get(serial) if isinstance(data, dict) else None
    if not isinstance(serial_data, dict) or not serial_data:
        return False
    first_key = min(serial_data)
    first = serial_data[first_key]
    try:
        lat = float(first["lat"])
        lon = float(first["lon"])
    except (KeyError, ValueError, TypeError):
        return False
    return _haversine_m(lat, lon, cfg.payerne_lat, cfg.payerne_lon) <= cfg.payerne_launch_radius_m


async def _ingest_site_point(
    state: AppState,
    serial: str,
    info: dict[str, Any],
    cfg: argparse.Namespace,
) -> None:
    try:
        lat = float(info["lat"])
        lon = float(info["lon"])
    except (KeyError, ValueError, TypeError):
        return
    point = Point(
        id=serial,
        source="sondehub-payerne",
        received_at=str(info.get("datetime") or utc_now_iso()),
        lat=lat,
        lon=lon,
        alt_m=_optional_float(info.get("alt")),
        climb_mps=_optional_float(info.get("vel_v")),
        course_deg=_optional_float(info.get("heading")),
        speed_mps=_optional_float(info.get("vel_h")),
        meta={
            "subtype": info.get("subtype"),
            "frequency_mhz": _optional_float(info.get("tx_frequency") or info.get("frequency")),
            "launch_site": cfg.payerne_site_name,
            "uploader_callsign": info.get("uploader_callsign"),
        },
    )
    await state.add_point(point)


async def udp_json_listener(state: AppState, host: str, port: int, enabled: bool) -> None:
    if not enabled:
        return
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: JsonDatagramProtocol(state),
        local_addr=(host, port),
    )
    state.status["udp_json"]["listening"] = True
    try:
        await asyncio.Future()
    finally:
        state.status["udp_json"]["listening"] = False
        transport.close()


async def events(request: web.Request) -> web.StreamResponse:
    state: AppState = request.app["state"]
    queue = state.hub.subscribe()
    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)

    await write_sse(response, {"type": "snapshot", "tracks": state.store.snapshot()})
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20)
                await write_sse(response, event)
            except asyncio.TimeoutError:
                await write_sse(response, {"type": "heartbeat", "at": utc_now_iso()})
    except (asyncio.CancelledError, ConnectionResetError, RuntimeError):
        pass
    finally:
        state.hub.unsubscribe(queue)
    return response


async def write_sse(response: web.StreamResponse, event: dict[str, Any]) -> None:
    payload = json.dumps(event, separators=(",", ":"))
    await response.write(f"data: {payload}\n\n".encode("utf-8"))


async def snapshot(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    return web.json_response({"tracks": state.store.snapshot(), "latest_at": state.store.latest_at})


async def health(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    return web.json_response(
        {
            "ok": True,
            "latest_point_at": state.store.latest_at,
            "status": state.status,
        }
    )


async def ingest(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    body = await request.json()
    point = Point(
        id=str(body["id"]),
        source=str(body.get("source", "manual")),
        received_at=str(body.get("received_at") or utc_now_iso()),
        lat=float(body["lat"]),
        lon=float(body["lon"]),
        alt_m=_optional_float(body.get("alt_m")),
        climb_mps=_optional_float(body.get("climb_mps")),
        course_deg=_optional_float(body.get("course_deg")),
        speed_mps=_optional_float(body.get("speed_mps")),
        raw=body.get("raw"),
        meta=dict(body.get("meta") or {}),
    )
    await state.add_point(point)
    return web.json_response({"ok": True, "point": point.to_dict()})


async def refresh_sonde(request: web.Request) -> web.Response:
    cfg: argparse.Namespace = request.app["config"]
    state: AppState = request.app["state"]
    session: Optional[aiohttp.ClientSession] = request.app.get("http_session")
    if not cfg.payerne_enabled or session is None:
        return web.json_response({"ok": False, "error": "payerne disabled"}, status=503)
    try:
        await _poll_site_once(state, session, cfg)
    except Exception:
        pass
    snapshot = state.store.snapshot()
    payerne_track: Optional[dict[str, Any]] = None
    for track_id, points in snapshot.items():
        if points and points[-1].get("source") == "sondehub-payerne":
            payerne_track = {"id": track_id, "points": points}
            break
    return web.json_response({"ok": True, "track": payerne_track})


async def get_landing_history(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    sonde_id = request.match_info["sonde_id"]
    return web.json_response({"sonde_id": sonde_id, "points": await state.landing_history.get(sonde_id)})


async def add_landing_history(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    sonde_id = request.match_info["sonde_id"]
    body = await request.json()
    points = await state.landing_history.add(sonde_id, body)
    await state.hub.publish({"type": "landing_history", "sonde_id": sonde_id, "points": points})
    return web.json_response({"ok": True, "sonde_id": sonde_id, "points": points})


def _optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def distance_m(a: dict[str, Any], b: dict[str, Any]) -> float:
    from math import asin, cos, radians, sin, sqrt

    radius = 6371000
    lat1 = radians(float(a["lat"]))
    lat2 = radians(float(b["lat"]))
    d_lat = radians(float(b["lat"]) - float(a["lat"]))
    d_lon = radians(float(b["lon"]) - float(a["lon"]))
    h = sin(d_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(d_lon / 2) ** 2
    return 2 * radius * asin(sqrt(h))


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def on_startup(app: web.Application) -> None:
    cfg = app["config"]
    state = app["state"]
    await state.landing_history.load()
    session = aiohttp.ClientSession()
    app["http_session"] = session
    app["tasks"] = [
        asyncio.create_task(aprs_reader(state, cfg.aprs_host, cfg.aprs_port, cfg.aprs_enabled)),
        asyncio.create_task(udp_json_listener(state, cfg.udp_host, cfg.udp_port, cfg.udp_enabled)),
        asyncio.create_task(site_sonde_poller(state, session, cfg)),
    ]


async def on_cleanup(app: web.Application) -> None:
    tasks: list[asyncio.Task[Any]] = app["tasks"]
    for task in tasks:
        task.cancel()
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=3)
    session: Optional[aiohttp.ClientSession] = app.get("http_session")
    if session is not None:
        await session.close()


def make_app(config: argparse.Namespace) -> web.Application:
    app = web.Application()
    app["config"] = config
    app["state"] = AppState(
        max_points=config.max_points,
        landing_history_path=Path(config.landing_history_path),
    )
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    app.router.add_get("/", index)
    app.router.add_get("/events", events)
    app.router.add_get("/api/snapshot", snapshot)
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/ingest", ingest)
    app.router.add_post("/api/sonde/refresh", refresh_sonde)
    app.router.add_get("/api/landing-history/{sonde_id}", get_landing_history)
    app.router.add_post("/api/landing-history/{sonde_id}", add_landing_history)
    app.router.add_static("/static/", STATIC_DIR, show_index=False)
    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="kytrack browser map backend")
    parser.add_argument("--host", default=os.getenv("KYTRACK_WEB_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("KYTRACK_WEB_PORT", "8080")))
    parser.add_argument("--aprs-host", default=os.getenv("KYTRACK_APRS_HOST", "127.0.0.1"))
    parser.add_argument("--aprs-port", type=int, default=int(os.getenv("KYTRACK_APRS_PORT", "14580")))
    parser.add_argument("--no-aprs", dest="aprs_enabled", action="store_false", default=True)
    parser.add_argument("--udp-host", default=os.getenv("KYTRACK_UDP_HOST", "127.0.0.1"))
    parser.add_argument("--udp-port", type=int, default=int(os.getenv("KYTRACK_UDP_PORT", "18600")))
    parser.add_argument("--enable-udp-json", dest="udp_enabled", action="store_true", default=False)
    parser.add_argument("--max-points", type=int, default=int(os.getenv("KYTRACK_MAX_POINTS", "300")))
    parser.add_argument(
        "--landing-history-path",
        default=os.getenv("KYTRACK_LANDING_HISTORY_PATH", "/var/lib/kytrack-web/landing-history.json"),
    )
    parser.add_argument("--no-payerne", dest="payerne_enabled", action="store_false", default=True)
    parser.add_argument(
        "--payerne-lat",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_LAT", "46.8117")),
    )
    parser.add_argument(
        "--payerne-lon",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_LON", "6.9425")),
    )
    parser.add_argument(
        "--payerne-poll-interval",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_POLL_INTERVAL", "120")),
    )
    parser.add_argument(
        "--payerne-lookback-seconds",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_LOOKBACK_SECONDS", "21600")),
    )
    parser.add_argument(
        "--payerne-search-radius-m",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_SEARCH_RADIUS_M", "250000")),
    )
    parser.add_argument(
        "--payerne-launch-radius-m",
        type=float,
        default=float(os.getenv("KYTRACK_PAYERNE_LAUNCH_RADIUS_M", "15000")),
    )
    parser.add_argument(
        "--payerne-site-name",
        default=os.getenv("KYTRACK_PAYERNE_SITE_NAME", "Payerne (06610)"),
    )
    return parser.parse_args()


def main() -> None:
    config = parse_args()
    app = make_app(config)
    web.run_app(app, host=config.host, port=config.port, handle_signals=True)


if __name__ == "__main__":
    main()
