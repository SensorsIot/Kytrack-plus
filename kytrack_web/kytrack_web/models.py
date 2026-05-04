from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class Point:
    id: str
    source: str
    received_at: str
    lat: float
    lon: float
    alt_m: Optional[float] = None
    climb_mps: Optional[float] = None
    course_deg: Optional[float] = None
    speed_mps: Optional[float] = None
    raw: Optional[str] = None
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
