const map = L.map("map", { zoomControl: true }).setView([47.4738, 7.7593], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const state = {
  tracks: new Map(),
  sondeHubTracks: new Map(),
  sondeHubFetches: new Map(),
  receiverMarker: null,
  receiverPoint: null,
  markers: new Map(),
  sondeHubPolylines: new Map(),
  predictions: new Map(),
  landingHistory: new Map(),
  landingHistoryLines: new Map(),
  routeLines: new Map(),
  routeMetrics: new Map(),
  landingMarkers: new Map(),
  burstMarkers: new Map(),
  predictionAscentLines: new Map(),
  predictionDescentLines: new Map(),
  selectedId: null,
  selectedManual: false,
};

const els = {
  status: document.getElementById("status"),
  select: document.getElementById("balloonSelect"),
  lastSeen: document.getElementById("lastSeen"),
  altitude: document.getElementById("altitude"),
  climb: document.getElementById("climb"),
  speed: document.getElementById("speed"),
  burst: document.getElementById("burst"),
  landing: document.getElementById("landing"),
  drive: document.getElementById("drive"),
  burstAltitude: document.getElementById("burstAltitude"),
  ascentRate: document.getElementById("ascentRate"),
  descentRate: document.getElementById("descentRate"),
};

const balloonIcon = L.divIcon({
  className: "",
  html: '<div class="balloon-marker"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const landingIcon = L.divIcon({
  className: "",
  html: '<div class="landing-marker"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
const burstIcon = L.divIcon({
  className: "",
  html: '<div class="burst-marker"><span>B</span></div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});
const receiverIcon = L.divIcon({
  className: "",
  html: '<div class="receiver-marker">RX</div>',
  iconSize: [34, 24],
  iconAnchor: [17, 12],
});
const worker = new Worker("/static/predictor.js");

worker.onmessage = (event) => {
  const { id, prediction } = event.data;
  if (!prediction) return;
  state.predictions.set(id, prediction);
  drawPrediction(id);
  renderTelemetry();
};

els.select.addEventListener("change", () => {
  const value = els.select.value || null;
  state.selectedId = value;
  state.selectedManual = !!value;
  if (value) panToTrack(value);
  renderTelemetry();
});

for (const input of [els.burstAltitude, els.ascentRate, els.descentRate]) {
  input.addEventListener("change", () => {
    for (const id of state.tracks.keys()) requestPrediction(id);
  });
}

bootstrap();

async function bootstrap() {
  connectEvents();
  try {
    await fetch("/api/sonde/refresh", { method: "POST", cache: "no-store" });
  } catch {
    // SSE will deliver the sonde when the next poll cycle finishes.
  }
}

function connectEvents() {
  const events = new EventSource("/events");
  events.onopen = () => setStatus("live", "live");
  events.onerror = () => setStatus("stale", "reconnecting");
  events.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "snapshot") loadSnapshot(event.tracks);
    if (event.type === "point") addPoint(event.point, true);
    if (event.type === "landing_history") {
      state.landingHistory.set(event.sonde_id, event.points || []);
      drawLandingHistory(event.sonde_id);
    }
  };
}

function loadSnapshot(tracks) {
  for (const [id, points] of Object.entries(tracks || {})) {
    for (const point of points) addPoint(point, false);
    requestPrediction(id);
  }
  fitIfNeeded();
}

function addPoint(point, shouldFit) {
  if (point.source === "receiver") {
    drawReceiver(point);
    return;
  }

  const isNewTrack = !state.tracks.has(point.id);
  if (isNewTrack) state.tracks.set(point.id, []);
  const track = state.tracks.get(point.id);
  track.push(point);
  if (track.length > 300) track.shift();
  drawTrack(point.id);
  fetchSondeHubTrack(point.id);
  loadLandingHistory(point.id);
  requestPrediction(point.id);
  autoSelectFreshest({ pan: isNewTrack });
  updateSelect();
  renderTelemetry();
  if (shouldFit && track.length === 1) fitIfNeeded();
}

function freshestTrackId() {
  let bestId = null;
  let bestTime = -Infinity;
  for (const [id, track] of state.tracks) {
    const last = track[track.length - 1];
    if (!last) continue;
    const t = Date.parse(last.received_at);
    if (Number.isFinite(t) && t > bestTime) {
      bestTime = t;
      bestId = id;
    }
  }
  return bestId;
}

function autoSelectFreshest({ pan = false } = {}) {
  if (state.selectedManual && state.selectedId && state.tracks.has(state.selectedId)) return;
  const freshest = freshestTrackId();
  if (!freshest || freshest === state.selectedId) return;
  state.selectedId = freshest;
  state.selectedManual = false;
  if (pan) panToTrack(freshest);
}

function panToTrack(id) {
  const track = state.tracks.get(id) || [];
  const last = track[track.length - 1];
  if (!last) return;
  map.panTo([last.lat, last.lon]);
}

function drawReceiver(point) {
  state.receiverPoint = point;
  const latlng = [point.lat, point.lon];
  if (!state.receiverMarker) {
    state.receiverMarker = L.marker(latlng, { icon: receiverIcon, zIndexOffset: 900 }).addTo(map);
  } else {
    state.receiverMarker.setLatLng(latlng);
  }
  state.receiverMarker.bindTooltip(point.id || "receiver", { direction: "top" });
  for (const id of state.predictions.keys()) {
    requestRoute(id);
  }
}

async function fetchSondeHubTrack(id, force = false) {
  const now = Date.now();
  const lastFetch = state.sondeHubFetches.get(id) || 0;
  if (!force && now - lastFetch < 60000) return;
  state.sondeHubFetches.set(id, now);

  const url = `https://api.v2.sondehub.org/sondes/telemetry?serial=${encodeURIComponent(id)}&duration=3d`;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    const points = parseSondeHubTelemetry(id, data);
    if (!points.length) {
      state.sondeHubTracks.set(id, []);
      renderTelemetry();
      return;
    }
    state.sondeHubTracks.set(id, points);
    drawSondeHubTrack(id);
    requestPrediction(id);
    renderTelemetry();
  } catch {
    // Keep the local APRS track usable if SondeHub is unreachable.
  }
}

function parseSondeHubTelemetry(id, data) {
  const serialData = data?.[id] || Object.values(data || {})[0] || {};
  const pointsBySecond = new Map();
  for (const [timestamp, value] of Object.entries(serialData)) {
    if (!value || typeof value !== "object") continue;
    const lat = Number(value.lat);
    const lon = Number(value.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const receivedAt = value.datetime || timestamp;
    const second = Math.round(Date.parse(receivedAt) / 1000);
    if (!Number.isFinite(second) || pointsBySecond.has(second)) continue;
    pointsBySecond.set(second, {
      id,
      source: "sondehub",
      received_at: new Date(second * 1000).toISOString(),
      lat,
      lon,
      alt_m: numberOrNull(value.alt),
      climb_mps: numberOrNull(value.vel_v),
      speed_mps: numberOrNull(value.vel_h),
      meta: {
        type: value.type || null,
        frequency_mhz: numberOrNull(value.tx_frequency ?? value.frequency),
      },
    });
  }
  return [...pointsBySecond.values()].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function drawSondeHubTrack(id) {
  const track = state.sondeHubTracks.get(id) || [];
  const latlngs = track.map((p) => [p.lat, p.lon]);
  if (!latlngs.length) return;
  if (!state.sondeHubPolylines.has(id)) {
    state.sondeHubPolylines.set(
      id,
      L.polyline(latlngs, { color: "#d02f44", weight: 6, opacity: 0.95 }).addTo(map)
    );
  } else {
    state.sondeHubPolylines.get(id).setLatLngs(latlngs);
  }
}

function drawTrack(id) {
  const track = state.tracks.get(id) || [];
  const latest = track[track.length - 1];
  if (!latest) return;

  if (!state.markers.has(id)) {
    state.markers.set(id, L.marker([latest.lat, latest.lon], { icon: balloonIcon }).addTo(map));
  } else {
    state.markers.get(id).setLatLng([latest.lat, latest.lon]);
  }
  state.markers.get(id).bindTooltip(id, { direction: "top" });
}

function drawPrediction(id) {
  const prediction = state.predictions.get(id);
  if (!prediction) return;
  recordLandingHistory(id, prediction.landing);
  const latest = latestTrackPoint(id);
  const isDescending = latest && Number.isFinite(latest.climb_mps) && latest.climb_mps < 0;
  const burst = isDescending ? null : prediction.burst;
  const burstIndex = findBurstIndex({ ...prediction, burst });
  const ascent = prediction.path.slice(0, burstIndex + 1).map((p) => [p.lat, p.lon]);
  const descent = prediction.path.slice(Math.max(0, burstIndex)).map((p) => [p.lat, p.lon]);
  setPolyline(state.predictionAscentLines, id, ascent, { color: "#1f9d55", weight: 5, opacity: 0.95 });
  setPolyline(state.predictionDescentLines, id, descent, { color: "#1f9d55", weight: 5, opacity: 0.95 });

  if (burst) {
    const burstLatLng = [burst.lat, burst.lon];
    if (!state.burstMarkers.has(id)) {
      state.burstMarkers.set(id, L.marker(burstLatLng, { icon: burstIcon, zIndexOffset: 1200 }).addTo(map));
    } else {
      state.burstMarkers.get(id).setLatLng(burstLatLng);
      state.burstMarkers.get(id).setZIndexOffset(1200);
    }
    const altitude = Number.isFinite(burst.alt_m) ? `${Math.round(burst.alt_m).toLocaleString()} m` : "";
    state.burstMarkers.get(id).bindTooltip(`${id} burst ${altitude}`, {
      direction: "top",
      permanent: true,
      offset: [0, -16],
      className: "burst-tooltip",
    });
  } else if (state.burstMarkers.has(id)) {
    map.removeLayer(state.burstMarkers.get(id));
    state.burstMarkers.delete(id);
  }

  const landingLatLng = [prediction.landing.lat, prediction.landing.lon];
  if (!state.landingMarkers.has(id)) {
    state.landingMarkers.set(id, L.marker(landingLatLng, { icon: landingIcon }).addTo(map));
  } else {
    state.landingMarkers.get(id).setLatLng(landingLatLng);
  }
  state.landingMarkers.get(id).bindTooltip(`${id} landing`, { direction: "top" });
  requestRoute(id);
}

function latestTrackPoint(id) {
  const track = state.tracks.get(id) || [];
  return track[track.length - 1] || null;
}

async function requestRoute(id) {
  const receiver = state.receiverPoint;
  const prediction = state.predictions.get(id);
  const landing = prediction?.landing;
  if (!receiver || !landing || !Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return;

  const routeKey = `${receiver.lat.toFixed(5)},${receiver.lon.toFixed(5)}:${landing.lat.toFixed(5)},${landing.lon.toFixed(5)}`;
  if (prediction.routeKey === routeKey) return;
  prediction.routeKey = routeKey;

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${receiver.lon},${receiver.lat};${landing.lon},${landing.lat}` +
    `?overview=full&geometries=geojson`;

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    const route = data?.routes?.[0];
    if (!Array.isArray(coords) || coords.length < 2) return;
    const latlngs = coords.map(([lon, lat]) => [lat, lon]);
    state.routeMetrics.set(id, {
      distance_m: Number(route.distance),
      duration_s: Number(route.duration),
    });
    setPolyline(state.routeLines, id, latlngs, { color: "#111827", weight: 5, opacity: 0.9 });
    renderTelemetry();
  } catch {
    // Route overlay is optional; prediction and landing point remain visible.
  }
}

async function loadLandingHistory(id) {
  if (state.landingHistory.has(id)) return;
  try {
    const response = await fetch(`/api/landing-history/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.landingHistory.set(id, Array.isArray(data.points) ? data.points : []);
    drawLandingHistory(id);
  } catch {
    // Landing history persistence is best-effort.
  }
}

async function recordLandingHistory(id, landing) {
  if (!landing || !Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return;
  if (!state.landingHistory.has(id)) state.landingHistory.set(id, []);
  const history = state.landingHistory.get(id);
  const last = history[history.length - 1];
  if (last && distanceMeters(last, landing) < 25) return;
  const point = { lat: landing.lat, lon: landing.lon, alt_m: landing.alt_m ?? null, at: landing.at ?? new Date().toISOString() };
  try {
    const response = await fetch(`/api/landing-history/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(point),
    });
    if (response.ok) {
      const data = await response.json();
      state.landingHistory.set(id, Array.isArray(data.points) ? data.points : []);
      drawLandingHistory(id);
      return;
    }
  } catch {
    // Fall back to local display if persistence fails.
  }
  history.push(point);
  drawLandingHistory(id);
}

function drawLandingHistory(id) {
  const history = state.landingHistory.get(id) || [];
  const latlngs = history.map((p) => [p.lat, p.lon]);
  if (!latlngs.length) return;
  setPolyline(state.landingHistoryLines, id, latlngs, { color: "#8f3ffc", weight: 4, opacity: 0.9 });
}

function distanceMeters(a, b) {
  const radius = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function setPolyline(collection, id, latlngs, options) {
  if (!collection.has(id)) {
    collection.set(id, L.polyline(latlngs, options).addTo(map));
  } else {
    collection.get(id).setLatLngs(latlngs);
    collection.get(id).setStyle(options);
  }
}

function findBurstIndex(prediction) {
  if (!prediction.burst) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  prediction.path.forEach((point, index) => {
    const distance = Math.abs(point.lat - prediction.burst.lat) + Math.abs(point.lon - prediction.burst.lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function requestPrediction(id) {
  const localTrack = state.tracks.get(id) || [];
  const sondeHubTrack = state.sondeHubTracks.get(id) || [];
  const source = sondeHubTrack.length > localTrack.length ? sondeHubTrack : localTrack;
  if (source.length < 2) return;
  const track = source.slice(-50);
  worker.postMessage({
    id,
    track,
    settings: {
      burstAltitude: Number(els.burstAltitude.value),
      ascentRate: Number(els.ascentRate.value),
      descentRate: Number(els.descentRate.value),
    },
  });
}

function updateSelect() {
  const ids = [...state.tracks.keys()].sort();
  const current = els.select.value;
  els.select.replaceChildren(...ids.map((id) => new Option(id, id, false, id === (state.selectedId || current))));
}

function renderTelemetry() {
  const id = state.selectedId;
  const track = id ? state.tracks.get(id) : null;
  const latest = track ? track[track.length - 1] : null;
  if (!latest) {
    els.lastSeen.textContent = "-";
    els.altitude.textContent = "-";
    els.climb.textContent = "-";
    els.speed.textContent = "-";
    els.burst.textContent = "-";
    els.landing.textContent = "-";
    els.drive.textContent = "-";
    return;
  }

  els.lastSeen.textContent = formatAge(latest.received_at);
  els.altitude.textContent = Number.isFinite(latest.alt_m) ? `${Math.round(latest.alt_m).toLocaleString()} m` : "-";
  els.climb.textContent = Number.isFinite(latest.climb_mps) ? `${latest.climb_mps.toFixed(1)} m/s` : "-";
  els.speed.textContent = Number.isFinite(latest.speed_mps) ? `${latest.speed_mps.toFixed(1)} m/s` : "-";
  const prediction = state.predictions.get(id);
  const visibleBurst = latest.climb_mps < 0 ? null : prediction?.burst;
  els.burst.textContent =
    visibleBurst
      ? `${visibleBurst.lat.toFixed(5)}, ${visibleBurst.lon.toFixed(5)}`
      : "-";
  els.landing.textContent = prediction
    ? `${prediction.landing.lat.toFixed(5)}, ${prediction.landing.lon.toFixed(5)}`
    : "-";
  els.drive.textContent = formatRouteMetric(state.routeMetrics.get(id));
}

function fitIfNeeded() {
  const points = [];
  for (const track of state.tracks.values()) {
    for (const point of track) points.push([point.lat, point.lon]);
  }
  for (const track of state.sondeHubTracks.values()) {
    for (const point of track) points.push([point.lat, point.lon]);
  }
  for (const history of state.landingHistory.values()) {
    for (const point of history) points.push([point.lat, point.lon]);
  }
  if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
}

function setStatus(className, text) {
  els.status.className = `status ${className}`;
  els.status.textContent = text;
}

function formatAge(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso || "-";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return new Date(time).toLocaleString();
}

function formatRouteMetric(metric) {
  if (!metric || !Number.isFinite(metric.distance_m)) return "-";
  const km = metric.distance_m / 1000;
  const distance = km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
  if (!Number.isFinite(metric.duration_s)) return distance;
  const minutes = Math.round(metric.duration_s / 60);
  if (minutes < 90) return `${distance}, ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${distance}, ${hours}h ${rest}m`;
}
