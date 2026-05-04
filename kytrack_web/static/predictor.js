function toRad(value) {
  return (value * Math.PI) / 180;
}

function toDeg(value) {
  return (value * 180) / Math.PI;
}

function haversineMeters(a, b) {
  const radius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function destination(start, bearing, distanceM) {
  const radius = 6371000;
  const angular = distanceM / radius;
  const brng = toRad(bearing);
  const lat1 = toRad(start.lat);
  const lon1 = toRad(start.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(brng));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

function secondsBetween(a, b) {
  const ta = Date.parse(a.received_at);
  const tb = Date.parse(b.received_at);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const seconds = (tb - ta) / 1000;
  return seconds > 0 ? seconds : null;
}

function estimateMotion(track) {
  const usable = track.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (usable.length < 2) return null;
  const latest = usable[usable.length - 1];
  let previous = usable[Math.max(0, usable.length - 6)];
  if (previous === latest) previous = usable[usable.length - 2];
  const dt = secondsBetween(previous, latest) || 60;
  const distance = haversineMeters(previous, latest);
  const horizontalMps = distance / dt;
  const bearing = bearingDeg(previous, latest);
  let verticalMps = Number.isFinite(latest.climb_mps) ? latest.climb_mps : null;
  if (verticalMps === null && Number.isFinite(previous.alt_m) && Number.isFinite(latest.alt_m)) {
    verticalMps = (latest.alt_m - previous.alt_m) / dt;
  }
  return { latest, horizontalMps, bearing, verticalMps };
}

async function predict(track, settings) {
  const tawhiri = await predictWithTawhiri(track, settings);
  if (tawhiri) return tawhiri;
  return predictWithExtrapolation(track, settings);
}

async function predictWithTawhiri(track, settings) {
  const motion = estimateMotion(track);
  if (!motion || !Number.isFinite(motion.latest.alt_m)) return null;

  const latest = motion.latest;
  const verticalMps = Number.isFinite(motion.verticalMps) ? motion.verticalMps : Number(latest.climb_mps) || 0;
  const ascentRate = Math.max(0.1, Math.abs(Number(settings.ascentRate) || 5));
  const settingsDescentRate = Math.max(0.1, Math.abs(Number(settings.descentRate) || 5));
  const descentRate =
    verticalMps < 0 && latest.alt_m < 10000 ? Math.max(0.1, Math.abs(verticalMps)) : settingsDescentRate;
  const configuredBurstAltitude = Number(settings.burstAltitude) || 35000;
  const burstAltitude = verticalMps >= 0 ? Math.max(configuredBurstAltitude, latest.alt_m + 100) : latest.alt_m + 10;
  const showBurst = verticalMps >= 0;
  const launchTime = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    launch_latitude: latest.lat.toFixed(4),
    launch_longitude: latest.lon.toFixed(4),
    launch_datetime: launchTime,
    ascent_rate: ascentRate.toFixed(2),
    burst_altitude: burstAltitude.toFixed(1),
    descent_rate: descentRate.toFixed(2),
    launch_altitude: latest.alt_m.toFixed(1),
    profile: "standard_profile",
    format: "json",
  });

  try {
    const response = await fetch(`https://api.v2.sondehub.org/tawhiri?${params.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = await response.json();
    return parseTawhiriPrediction(data, showBurst);
  } catch {
    return null;
  }
}

function parseTawhiriPrediction(data, showBurst = true) {
  const stages = Array.isArray(data.prediction) ? data.prediction : [];
  const ascent = stages.find((stage) => String(stage.stage || "").toLowerCase() === "ascent");
  const descent = stages.find((stage) => String(stage.stage || "").toLowerCase() === "descent");
  const ascentTrajectory = Array.isArray(ascent?.trajectory) ? ascent.trajectory : [];
  const descentTrajectory = Array.isArray(descent?.trajectory) ? descent.trajectory : [];
  if (!ascentTrajectory.length || !descentTrajectory.length) return null;

  const toPoint = (point) => ({
    lat: Number(point.latitude),
    lon: Number(point.longitude),
    alt_m: Number(point.altitude),
    at: point.datetime || null,
  });
  const path = stages.flatMap((stage) => (Array.isArray(stage.trajectory) ? stage.trajectory.map(toPoint) : []));
  const burst = showBurst ? toPoint(ascentTrajectory[ascentTrajectory.length - 1]) : null;
  const landing = toPoint(descentTrajectory[descentTrajectory.length - 1]);
  if (!Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return null;
  return { path, burst, landing, source: "tawhiri" };
}

function predictWithExtrapolation(track, settings) {
  const motion = estimateMotion(track);
  if (!motion || !Number.isFinite(motion.latest.alt_m)) return null;

  const burstAltitude = Number(settings.burstAltitude) || 35000;
  const descentRate = Math.max(1, Math.abs(Number(settings.descentRate) || 5));
  const landingAltitude = 0;
  const stepSeconds = 60;
  const path = [{ lat: motion.latest.lat, lon: motion.latest.lon, alt_m: motion.latest.alt_m }];
  let current = { ...path[0] };
  let vertical = motion.verticalMps;
  const showBurst = !(Number.isFinite(vertical) && vertical < 0);
  let burst = showBurst && current.alt_m >= burstAltitude ? { ...current } : null;

  if (!Number.isFinite(vertical) || Math.abs(vertical) < 0.2) {
    vertical = current.alt_m >= burstAltitude ? -descentRate : 5;
  }

  for (let i = 0; i < 360; i += 1) {
    if (current.alt_m <= landingAltitude) break;
    let nextVertical = vertical;
    if (current.alt_m >= burstAltitude || vertical < 0) {
      if (showBurst && !burst) burst = { ...current };
      nextVertical = -descentRate;
    }
    const nextAlt = current.alt_m + nextVertical * stepSeconds;
    const moved = destination(current, motion.bearing, motion.horizontalMps * stepSeconds);
    current = { lat: moved.lat, lon: moved.lon, alt_m: nextAlt };
    path.push(current);
    if (showBurst && !burst && current.alt_m >= burstAltitude) {
      burst = { ...current, alt_m: Math.max(current.alt_m, burstAltitude) };
    }
    vertical = nextVertical;
    if (path.length > 1 && nextAlt <= landingAltitude) break;
  }

  const landing = path[path.length - 1];
  return { path, burst, landing, source: "extrapolation" };
}

self.onmessage = async (event) => {
  const { id, track, settings } = event.data;
  self.postMessage({ id, prediction: await predict(track, settings) });
};
