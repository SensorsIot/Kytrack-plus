from __future__ import annotations

import json
import re
from typing import Any, Optional

from .models import Point, utc_now_iso

APRS_OBJECT_RE = re.compile(
    r"^;(?P<name>.{9})(?P<state>[*_])(?P<time>\d{6}[hz/])"
    r"(?P<lat>\d{4}\.\d{2})(?P<lat_hemi>[NS])(?P<sym_table>.)"
    r"(?P<lon>\d{5}\.\d{2})(?P<lon_hemi>[EW])(?P<symbol>.)"
    r"(?:(?P<course>\d{3})/(?P<speed>\d{3}))?"
    r"(?P<comment>.*)$"
)

APRS_RECEIVER_RE = re.compile(
    r"^[!/=]"
    r"(?P<lat>\d{4}\.\d{2})(?P<lat_hemi>[NS])(?P<sym_table>.)"
    r"(?P<lon>\d{5}\.\d{2})(?P<lon_hemi>[EW])(?P<symbol>.)"
    r"(?:(?P<course>\d{3})/(?P<speed>\d{3}))?"
    r"(?P<comment>.*)$"
)

ALT_RE = re.compile(r"(?:^|[ /])A=(?P<feet>-?\d{1,7})(?:\D|$)")
CLIMB_RE = re.compile(r"\bClb=(?P<climb>-?\d+(?:\.\d+)?)m/s\b")
TYPE_RE = re.compile(r"\bType=(?P<type>[^\s]+)")
FREQ_RE = re.compile(r"\b(?P<freq>\d{3}\.\d{2})MHz\b")
TEMP_RE = re.compile(r"\bt=(?P<temp>-?\d+(?:\.\d+)?)C\b")


def aprs_coord_to_decimal(value: str, hemi: str) -> float:
    dot = value.index(".")
    deg_digits = dot - 2
    degrees = int(value[:deg_digits])
    minutes = float(value[deg_digits:])
    decimal = degrees + minutes / 60
    if hemi in ("S", "W"):
        decimal *= -1
    return decimal


def parse_aprs_line(line: str) -> Optional[Point]:
    raw = line.strip()
    if not raw or raw.startswith("#") or ":" not in raw:
        return None

    header, payload = raw.split(":", 1)
    callsign = header.split(">", 1)[0].strip()

    match = APRS_OBJECT_RE.match(payload)
    receiver_match = None if match else APRS_RECEIVER_RE.match(payload)
    if not match and not receiver_match:
        return None

    packet_match = match or receiver_match
    comment = packet_match.group("comment") or ""
    point_id = match.group("name").strip() if match else callsign
    if not point_id:
        return None

    alt_m = None
    alt_match = ALT_RE.search(comment)
    if alt_match:
        alt_m = int(alt_match.group("feet")) * 0.3048

    climb_mps = None
    climb_match = CLIMB_RE.search(comment)
    if climb_match:
        climb_mps = float(climb_match.group("climb"))

    speed_mps = None
    if packet_match.group("speed"):
        speed_mps = int(packet_match.group("speed")) * 0.514444

    meta: dict[str, Any] = {"callsign": callsign}
    type_match = TYPE_RE.search(comment)
    if type_match:
        meta["type"] = type_match.group("type")
    freq_match = FREQ_RE.search(comment)
    if freq_match:
        meta["frequency_mhz"] = float(freq_match.group("freq"))
    temp_match = TEMP_RE.search(comment)
    if temp_match:
        meta["temperature_c"] = float(temp_match.group("temp"))

    return Point(
        id=point_id,
        source="aprs" if match else "receiver",
        received_at=utc_now_iso(),
        lat=aprs_coord_to_decimal(packet_match.group("lat"), packet_match.group("lat_hemi")),
        lon=aprs_coord_to_decimal(packet_match.group("lon"), packet_match.group("lon_hemi")),
        alt_m=alt_m,
        climb_mps=climb_mps,
        course_deg=float(packet_match.group("course")) if packet_match.group("course") else None,
        speed_mps=speed_mps,
        raw=raw,
        meta=meta,
    )


def parse_sondemod_json(data: bytes) -> Optional[Point]:
    raw_text = data.decode("utf-8", errors="replace").strip()
    if not raw_text:
        return None
    obj = json.loads(raw_text)
    if not isinstance(obj, dict):
        return None

    lat = _first_number(obj, "lat", "latitude")
    lon = _first_number(obj, "long", "lon", "lng", "longitude")
    if lat is None or lon is None:
        return None

    point_id = str(
        obj.get("id")
        or obj.get("name")
        or obj.get("serial")
        or obj.get("ser")
        or obj.get("sonde")
        or obj.get("type")
        or "unknown"
    ).strip()
    if not point_id:
        point_id = "unknown"

    meta = {k: v for k, v in obj.items() if k not in {"lat", "latitude", "long", "lon", "lng", "longitude"}}

    return Point(
        id=point_id,
        source="sondemod-json",
        received_at=utc_now_iso(),
        lat=lat,
        lon=lon,
        alt_m=_first_number(obj, "alt", "alt_m", "altitude"),
        climb_mps=_first_number(obj, "clb", "climb", "climb_mps", "vrate"),
        course_deg=_first_number(obj, "course", "dir", "heading"),
        speed_mps=_first_number(obj, "speed", "speed_mps", "groundspeed"),
        raw=raw_text,
        meta=meta,
    )


def _first_number(obj: dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        value = obj.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None
