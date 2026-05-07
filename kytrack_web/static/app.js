// =====================================================================
// Map, constants, DOM, icons, worker, helpers (shared across modes)
// =====================================================================

const map = L.map("map", { zoomControl: true }).setView([47.4738, 7.7593], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const PREDICTION_CACHE_MAX = 50;
const STALE_THRESHOLD_MS = 3000;
const FORECAST_ID = "__payerne_forecast__";
const PAYERNE_WMO = "06610";
const PAYERNE_LAUNCH = { lat: 46.8117, lon: 6.9425, alt_m: 491 };
const PAYERNE_SLOT_HOURS_UTC = [11, 23];
const PAYERNE_FRESH_MS = 30 * 60 * 1000;
const PAYERNE_PROBE_INTERVAL_MS = 60000;

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
const lastSeenIcon = L.divIcon({
  className: "",
  html: '<div class="last-seen-marker"></div>',
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
const forecastLaunchIcon = L.divIcon({
  className: "",
  html: '<div class="forecast-launch-marker"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const worker = new Worker("/static/predictor.js");

const receiver = { point: null, marker: null };

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

function setStatus(className, text) {
  els.status.className = `status ${className}`;
  els.status.textContent = text;
}

function setLiveRowsVisible(visible) {
  const display = visible ? "" : "none";
  for (const dd of [els.lastSeen, els.altitude, els.climb, els.speed, els.burst, els.landing]) {
    dd.parentElement.style.display = display;
  }
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

function formatUtcHm(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
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

function predictionCacheKey(id, point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const lat = point.lat.toFixed(2);
  const lon = point.lon.toFixed(2);
  const altBucket = Number.isFinite(point.alt_m) ? Math.round(point.alt_m / 100) : "x";
  const tBucket = Math.floor(Date.now() / 300000);
  return `${id}|${lat}|${lon}|${altBucket}|${tBucket}`;
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

function detectLastSeenFromTrack(track) {
  if (!Array.isArray(track) || track.length < 20) return null;
  let peakIdx = 0;
  for (let i = 1; i < track.length; i++) {
    if (Number(track[i].alt_m) > Number(track[peakIdx].alt_m)) peakIdx = i;
  }
  if (peakIdx >= track.length - 5) return null;
  const minGapMs = 1200 * 1000;
  for (let i = peakIdx + 1; i < track.length - 1; i++) {
    const gap = Date.parse(track[i + 1].received_at) - Date.parse(track[i].received_at);
    if (Number.isFinite(gap) && gap > minGapMs) {
      return { lat: track[i].lat, lon: track[i].lon, alt_m: track[i].alt_m, reason: "blackout" };
    }
  }
  const minWindowMs = 1200 * 1000;
  for (let start = peakIdx; start < track.length - 1; start++) {
    let end = start;
    while (
      end < track.length - 1 &&
      Date.parse(track[end].received_at) - Date.parse(track[start].received_at) < minWindowMs
    ) {
      end++;
    }
    if (end - start < 5) continue;
    const window = track.slice(start, end + 1);
    let dlat = 0;
    let dlon = 0;
    let dalt = 0;
    let altSamples = 0;
    for (let i = 1; i < window.length; i++) {
      dlat += Math.abs(window[i].lat - window[i - 1].lat);
      dlon += Math.abs(window[i].lon - window[i - 1].lon);
      if (Number.isFinite(window[i].alt_m) && Number.isFinite(window[i - 1].alt_m)) {
        dalt += Math.abs(window[i].alt_m - window[i - 1].alt_m);
        altSamples++;
      }
    }
    const n = window.length - 1;
    const dlatMean = dlat / n;
    const dlonMean = dlon / n;
    const daltMean = altSamples ? dalt / altSamples : 0;
    if (dlatMean < 0.0001 && dlonMean < 0.0001 && daltMean < 0.3) {
      return {
        lat: window[0].lat,
        lon: window[0].lon,
        alt_m: window[0].alt_m,
        reason: "stationary",
      };
    }
  }
  return null;
}

function motionAdjustedDescentRate(track) {
  if (!Array.isArray(track) || track.length < 3) return null;
  const now = Date.parse(track[track.length - 1].received_at);
  if (!Number.isFinite(now)) return null;
  const samples = [];
  for (let i = track.length - 1; i > 0; i--) {
    const t = Date.parse(track[i].received_at);
    if (!Number.isFinite(t) || now - t > 60000) break;
    const prev = track[i - 1];
    const dt = (Date.parse(track[i].received_at) - Date.parse(prev.received_at)) / 1000;
    if (!(dt > 0)) continue;
    const da = Number(track[i].alt_m) - Number(prev.alt_m);
    if (!Number.isFinite(da)) continue;
    samples.push(da / dt);
  }
  if (samples.length < 3) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function drawReceiver(point) {
  receiver.point = point;
  const latlng = [point.lat, point.lon];
  if (!receiver.marker) {
    receiver.marker = L.marker(latlng, { icon: receiverIcon, zIndexOffset: 900 }).addTo(map);
  } else {
    receiver.marker.setLatLng(latlng);
  }
  receiver.marker.bindTooltip(point.id || "receiver", { direction: "top" });
  activeMode?.onReceiverUpdate?.();
}

// =====================================================================
// LiveMode — flight in progress: tracks, predictions, last-seen, drive
// =====================================================================

const LiveMode = {
  name: "live",
  serial: null,

  tracks: new Map(),
  sondeHubTracks: new Map(),
  sondeHubFetches: new Map(),

  markers: new Map(),
  sondeHubPolylines: new Map(),
  predictionAscentLines: new Map(),
  predictionDescentLines: new Map(),
  burstMarkers: new Map(),
  landingMarkers: new Map(),
  lastSeenMarkers: new Map(),
  routeLines: new Map(),
  landingHistoryLines: new Map(),
  landingHistoryDots: new Map(),

  predictions: new Map(),
  routeMetrics: new Map(),
  predictionCache: new Map(),
  lastSeenPoints: new Map(),
  landingHistory: new Map(),
  landingHistoryFetches: new Map(),
  lastPostedLanding: new Map(),

  selectedId: null,
  selectedManual: false,

  intervals: [],

  // ---- Lifecycle ---------------------------------------------------

  async enter(serial) {
    this.serial = serial;
    this.loadLandingHistory(serial);
    await this.fetchSondeHubTrack(serial, true);
    if (activeMode !== this) return;
    const sondeHub = this.sondeHubTracks.get(serial) || [];
    if (sondeHub.length) {
      this.tracks.set(serial, sondeHub.slice(-300));
      this.drawTrack(serial);
      this.autoSelectFreshest({ pan: true });
      this.populateSelect();
      this.requestPrediction(serial);
      this.render();
    }
    this.intervals.push(setInterval(() => this.tick1s(), 1000));
  },

  exit() {
    for (const t of this.intervals) clearInterval(t);
    this.intervals = [];
    this.clearOverlays();
    this.tracks.clear();
    this.sondeHubTracks.clear();
    this.sondeHubFetches.clear();
    this.predictions.clear();
    this.lastSeenPoints.clear();
    this.routeMetrics.clear();
    this.landingHistory.clear();
    this.landingHistoryFetches.clear();
    this.lastPostedLanding.clear();
    this.selectedId = null;
    this.selectedManual = false;
    this.serial = null;
  },

  async refresh(serial) {
    const track = this.tracks.get(serial) || [];
    const last = track[track.length - 1];
    const lastMs = last ? Date.parse(last.received_at) : 0;
    if (!Number.isFinite(lastMs) || Date.now() - lastMs > 120000) {
      await this.fetchSondeHubTrack(serial, true);
    }
  },

  // ---- Mode interface ---------------------------------------------

  onPoint(point, shouldFit) {
    if (point.id !== this.serial) return;
    const isNewTrack = !this.tracks.has(point.id);
    if (isNewTrack) {
      this.tracks.set(point.id, []);
      this.loadLandingHistory(point.id);
    }
    const track = this.tracks.get(point.id);
    track.push(point);
    if (track.length > 300) track.shift();
    this.drawTrack(point.id);
    this.fetchSondeHubTrack(point.id);
    this.requestPrediction(point.id);
    this.autoSelectFreshest({ pan: isNewTrack });
    this.populateSelect();
    this.render();
    if (shouldFit && track.length === 1) this.fitIfNeeded();
  },

  onSelect(value) {
    this.selectedId = value;
    this.selectedManual = !!value;
    if (value) this.panToTrack(value);
    this.render();
  },

  onPrediction({ id, prediction, cacheKey }) {
    if (activeMode !== this) return;
    if (!prediction) return;
    if (cacheKey) this.cachePrediction(cacheKey, prediction);
    this.predictions.set(id, prediction);
    this.drawPrediction(id);
    this.recordLanding(id, prediction);
    this.render();
  },

  onReceiverUpdate() {
    for (const id of this.predictions.keys()) this.requestRoute(id);
  },

  onSettingsChanged() {
    for (const id of this.tracks.keys()) this.requestPrediction(id);
  },

  tick1s() {
    for (const id of this.tracks.keys()) this.applyStaleStyling(id);
    if (this.selectedId) this.render();
  },

  populateSelect() {
    const ids = [...this.tracks.keys()].sort();
    const current = els.select.value;
    els.select.replaceChildren(...ids.map((id) => new Option(id, id, false, id === (this.selectedId || current))));
  },

  render() {
    const id = this.selectedId;
    const track = id ? this.tracks.get(id) : null;
    const latest = track ? track[track.length - 1] : null;
    if (!latest) {
      setLiveRowsVisible(false);
      els.drive.textContent = "-";
      return;
    }
    setLiveRowsVisible(true);
    els.lastSeen.textContent = formatAge(latest.received_at);
    els.altitude.textContent = Number.isFinite(latest.alt_m) ? `${Math.round(latest.alt_m).toLocaleString()} m` : "-";
    els.climb.textContent = Number.isFinite(latest.climb_mps) ? `${latest.climb_mps.toFixed(1)} m/s` : "-";
    els.speed.textContent = Number.isFinite(latest.speed_mps) ? `${latest.speed_mps.toFixed(1)} m/s` : "-";
    const prediction = this.predictions.get(id);
    const visibleBurst = latest.climb_mps < 0 ? null : prediction?.burst;
    els.burst.textContent = visibleBurst
      ? `${visibleBurst.lat.toFixed(5)}, ${visibleBurst.lon.toFixed(5)}`
      : "-";
    els.landing.textContent = prediction
      ? `${prediction.landing.lat.toFixed(5)}, ${prediction.landing.lon.toFixed(5)}`
      : "-";
    els.drive.textContent = formatRouteMetric(this.routeMetrics.get(id));
  },

  // ---- Internals --------------------------------------------------

  async fetchSondeHubTrack(id, force = false) {
    const now = Date.now();
    const lastFetch = this.sondeHubFetches.get(id) || 0;
    if (!force && now - lastFetch < 60000) return;
    this.sondeHubFetches.set(id, now);

    const url = `https://api.v2.sondehub.org/sondes/telemetry?serial=${encodeURIComponent(id)}&duration=3d`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (activeMode !== this) return;
      const points = parseSondeHubTelemetry(id, data);
      if (!points.length) {
        this.sondeHubTracks.set(id, []);
        this.render();
        return;
      }
      this.sondeHubTracks.set(id, points);
      this.drawSondeHubTrack(id);
      this.markLastSeen(id, points);
      this.requestPrediction(id);
      this.render();
    } catch {
      // Keep the local APRS track usable if SondeHub is unreachable.
    }
  },

  markLastSeen(id, track) {
    const lastSeen = detectLastSeenFromTrack(track);
    if (!lastSeen) return;
    this.lastSeenPoints.set(id, lastSeen);
    if (!this.lastSeenMarkers.has(id)) {
      this.lastSeenMarkers.set(id, L.marker([lastSeen.lat, lastSeen.lon], { icon: lastSeenIcon }).addTo(map));
    } else {
      this.lastSeenMarkers.get(id).setLatLng([lastSeen.lat, lastSeen.lon]);
    }
    this.lastSeenMarkers
      .get(id)
      .bindTooltip(`${id} last seen (${lastSeen.reason})`, { direction: "top", permanent: true, offset: [0, -10] });
    this.applyStaleStyling(id);
  },

  drawSondeHubTrack(id) {
    const track = this.sondeHubTracks.get(id) || [];
    const latlngs = track.map((p) => [p.lat, p.lon]);
    if (!latlngs.length) return;
    if (!this.sondeHubPolylines.has(id)) {
      this.sondeHubPolylines.set(
        id,
        L.polyline(latlngs, { color: "#d02f44", weight: 6, opacity: 0.95 }).addTo(map),
      );
    } else {
      this.sondeHubPolylines.get(id).setLatLngs(latlngs);
    }
  },

  drawTrack(id) {
    const track = this.tracks.get(id) || [];
    const latest = track[track.length - 1];
    if (!latest) return;
    if (!this.markers.has(id)) {
      this.markers.set(id, L.marker([latest.lat, latest.lon], { icon: balloonIcon }).addTo(map));
    } else {
      this.markers.get(id).setLatLng([latest.lat, latest.lon]);
    }
    this.markers.get(id).bindTooltip(id, { direction: "top" });
    this.applyStaleStyling(id);
  },

  isTrackStale(id) {
    const track = this.tracks.get(id) || [];
    const latest = track[track.length - 1];
    if (!latest) return false;
    const t = Date.parse(latest.received_at);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t > STALE_THRESHOLD_MS;
  },

  applyStaleStyling(id) {
    const marker = this.markers.get(id);
    if (!marker) return;
    const el = marker.getElement();
    if (!el) return;
    const dot = el.querySelector(".balloon-marker");
    if (!dot) return;
    const stale = this.isTrackStale(id);
    const lastSeen = this.lastSeenPoints.has(id);
    dot.classList.toggle("balloon-marker-stale", stale && !lastSeen);
    dot.classList.toggle("balloon-marker-landed", lastSeen);
  },

  drawPrediction(id) {
    const prediction = this.predictions.get(id);
    if (!prediction) return;
    const latest = this.latestTrackPoint(id);
    const isDescending = latest && Number.isFinite(latest.climb_mps) && latest.climb_mps < 0;
    const burst = isDescending ? null : prediction.burst;
    const burstIndex = findBurstIndex({ ...prediction, burst });
    const ascent = prediction.path.slice(0, burstIndex + 1).map((p) => [p.lat, p.lon]);
    const descent = prediction.path.slice(Math.max(0, burstIndex)).map((p) => [p.lat, p.lon]);
    setPolyline(this.predictionAscentLines, id, ascent, { color: "#1f9d55", weight: 5, opacity: 0.95 });
    setPolyline(this.predictionDescentLines, id, descent, { color: "#1f9d55", weight: 5, opacity: 0.95 });

    if (burst) {
      const burstLatLng = [burst.lat, burst.lon];
      if (!this.burstMarkers.has(id)) {
        this.burstMarkers.set(id, L.marker(burstLatLng, { icon: burstIcon, zIndexOffset: 1200 }).addTo(map));
      } else {
        this.burstMarkers.get(id).setLatLng(burstLatLng);
        this.burstMarkers.get(id).setZIndexOffset(1200);
      }
      const altitude = Number.isFinite(burst.alt_m) ? `${Math.round(burst.alt_m).toLocaleString()} m` : "";
      this.burstMarkers.get(id).bindTooltip(`${id} burst ${altitude}`, {
        direction: "top",
        permanent: true,
        offset: [0, -16],
        className: "burst-tooltip",
      });
    } else if (this.burstMarkers.has(id)) {
      map.removeLayer(this.burstMarkers.get(id));
      this.burstMarkers.delete(id);
    }

    const landingLatLng = [prediction.landing.lat, prediction.landing.lon];
    if (!this.landingMarkers.has(id)) {
      this.landingMarkers.set(id, L.marker(landingLatLng, { icon: landingIcon }).addTo(map));
    } else {
      this.landingMarkers.get(id).setLatLng(landingLatLng);
    }
    this.landingMarkers.get(id).bindTooltip(`${id} landing`, { direction: "top" });
    this.requestRoute(id);
  },

  latestTrackPoint(id) {
    const track = this.tracks.get(id) || [];
    return track[track.length - 1] || null;
  },

  requestPrediction(id) {
    const localTrack = this.tracks.get(id) || [];
    const sondeHubTrack = this.sondeHubTracks.get(id) || [];
    const source = sondeHubTrack.length > localTrack.length ? sondeHubTrack : localTrack;
    if (source.length < 2) return;
    const track = source.slice(-50);
    const latest = track[track.length - 1];
    const cacheKey = predictionCacheKey(id, latest);
    if (cacheKey && this.predictionCache.has(cacheKey)) {
      const cached = this.predictionCache.get(cacheKey);
      this.predictionCache.delete(cacheKey);
      this.predictionCache.set(cacheKey, cached);
      this.predictions.set(id, cached);
      this.drawPrediction(id);
      this.render();
      return;
    }
    worker.postMessage({
      id,
      track,
      cacheKey,
      settings: {
        burstAltitude: Number(els.burstAltitude.value),
        ascentRate: Number(els.ascentRate.value),
        descentRate: Number(els.descentRate.value),
        adjustedDescentRate: motionAdjustedDescentRate(track),
      },
    });
  },

  cachePrediction(key, prediction) {
    if (this.predictionCache.has(key)) this.predictionCache.delete(key);
    this.predictionCache.set(key, prediction);
    while (this.predictionCache.size > PREDICTION_CACHE_MAX) {
      const oldest = this.predictionCache.keys().next().value;
      this.predictionCache.delete(oldest);
    }
  },

  async requestRoute(id) {
    const r = receiver.point;
    const prediction = this.predictions.get(id);
    const landing = prediction?.landing;
    if (!r || !landing || !Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return;

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${r.lon},${r.lat};${landing.lon},${landing.lat}` +
      `?overview=full&geometries=geojson`;

    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (activeMode !== this) return;
      const route = data?.routes?.[0];
      const coords = route?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const latlngs = coords.map(([lon, lat]) => [lat, lon]);
      this.routeMetrics.set(id, {
        distance_m: Number(route.distance),
        duration_s: Number(route.duration),
      });
      setPolyline(this.routeLines, id, latlngs, { color: "#111827", weight: 5, opacity: 0.9 });
      this.render();
    } catch {
      // Route overlay is optional; prediction and landing point remain visible.
    }
  },

  async loadLandingHistory(id) {
    if (this.landingHistoryFetches.get(id)) return;
    this.landingHistoryFetches.set(id, true);
    try {
      const response = await fetch(`/api/landing-history/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (activeMode !== this) return;
      const points = Array.isArray(data?.points) ? data.points : [];
      this.landingHistory.set(id, points);
      this.drawLandingHistory(id);
    } catch {
      // Best-effort — history polyline is optional.
    }
  },

  applyLandingHistory(id, points) {
    this.landingHistory.set(id, Array.isArray(points) ? points : []);
    this.drawLandingHistory(id);
  },

  async recordLanding(id, prediction) {
    const landing = prediction?.landing;
    if (!landing || !Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return;
    const last = this.lastPostedLanding.get(id);
    if (last && distanceMeters(last, landing) < 100) return;
    this.lastPostedLanding.set(id, { lat: landing.lat, lon: landing.lon });
    try {
      const response = await fetch(`/api/landing-history/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: landing.lat,
          lon: landing.lon,
          alt_m: Number.isFinite(landing.alt_m) ? landing.alt_m : null,
          at: landing.at || new Date().toISOString(),
        }),
      });
      if (!response.ok) return;
      const data = await response.json();
      if (activeMode !== this) return;
      this.applyLandingHistory(id, data?.points);
    } catch {
      // Server publishes a landing_history SSE event on success; failures here
      // just mean the polyline updates on the next prediction tick.
    }
  },

  drawLandingHistory(id) {
    const history = this.landingHistory.get(id) || [];
    if (this.landingHistoryDots.has(id)) {
      map.removeLayer(this.landingHistoryDots.get(id));
      this.landingHistoryDots.delete(id);
    }
    if (history.length < 2) {
      if (this.landingHistoryLines.has(id)) {
        map.removeLayer(this.landingHistoryLines.get(id));
        this.landingHistoryLines.delete(id);
      }
    } else {
      const latlngs = history.map((p) => [p.lat, p.lon]);
      setPolyline(this.landingHistoryLines, id, latlngs, {
        color: "#8f3ffc",
        weight: 4,
        opacity: 0.9,
      });
    }
    if (history.length) {
      const dots = L.layerGroup(
        history.map((p) =>
          L.circleMarker([p.lat, p.lon], {
            radius: 3,
            color: "#8f3ffc",
            weight: 1,
            fillColor: "#8f3ffc",
            fillOpacity: 1,
          }),
        ),
      ).addTo(map);
      this.landingHistoryDots.set(id, dots);
    }
  },

  freshestTrackId() {
    let bestId = null;
    let bestTime = -Infinity;
    for (const [id, track] of this.tracks) {
      const last = track[track.length - 1];
      if (!last) continue;
      const t = Date.parse(last.received_at);
      if (Number.isFinite(t) && t > bestTime) {
        bestTime = t;
        bestId = id;
      }
    }
    return bestId;
  },

  autoSelectFreshest({ pan = false } = {}) {
    if (this.selectedManual && this.selectedId && this.tracks.has(this.selectedId)) return;
    const freshest = this.freshestTrackId();
    if (!freshest || freshest === this.selectedId) return;
    this.selectedId = freshest;
    this.selectedManual = false;
    if (pan) this.panToTrack(freshest);
  },

  panToTrack(id) {
    const track = this.tracks.get(id) || [];
    const last = track[track.length - 1];
    if (!last) return;
    map.panTo([last.lat, last.lon]);
  },

  fitIfNeeded() {
    const points = [];
    for (const track of this.tracks.values()) {
      for (const point of track) points.push([point.lat, point.lon]);
    }
    for (const track of this.sondeHubTracks.values()) {
      for (const point of track) points.push([point.lat, point.lon]);
    }
    if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
  },

  clearOverlays() {
    for (const layerMap of [
      this.markers,
      this.sondeHubPolylines,
      this.predictionAscentLines,
      this.predictionDescentLines,
      this.burstMarkers,
      this.landingMarkers,
      this.lastSeenMarkers,
      this.routeLines,
      this.landingHistoryLines,
      this.landingHistoryDots,
    ]) {
      for (const layer of layerMap.values()) map.removeLayer(layer);
      layerMap.clear();
    }
  },
};

// =====================================================================
// ForecastMode — no flight: scheduled Payerne trajectory + drive route
// =====================================================================

const ForecastMode = {
  name: "forecast",
  slot: null,
  layers: [],
  lastPrediction: null,
  didFit: false,
  routeMetric: null,
  intervals: [],

  // ---- Lifecycle --------------------------------------------------

  enter() {
    this.requestForecast();
    this.intervals.push(setInterval(() => this.tickRollover(), 60000));
  },

  exit() {
    for (const t of this.intervals) clearInterval(t);
    this.intervals = [];
    this.clear();
  },

  refresh() {
    if (!this.layers.length) this.requestForecast();
  },

  // ---- Mode interface --------------------------------------------

  onPoint() {
    // Sonde points are irrelevant when no flight is active; the
    // dispatcher already handles the receiver beacon separately.
  },

  onSelect(value) {
    const hour = Number(value);
    if (Number.isFinite(hour)) this.selectSlot(hour);
  },

  onPrediction({ prediction }) {
    if (activeMode !== this) return;
    this.draw(prediction);
  },

  onReceiverUpdate() {
    if (this.lastPrediction) this.requestRoute(this.lastPrediction);
  },

  onSettingsChanged() {
    this.requestForecast();
  },

  tickRollover() {
    if (!this.slot || Date.now() >= this.slot.getTime()) this.requestForecast();
  },

  populateSelect() {
    const slotHour = this.slot ? this.slot.getUTCHours() : null;
    const options = PAYERNE_SLOT_HOURS_UTC.map((h) => {
      const label = `${String(h).padStart(2, "0")}:00 UTC`;
      return new Option(label, String(h), false, h === slotHour);
    });
    els.select.replaceChildren(...options);
  },

  render() {
    setLiveRowsVisible(false);
    els.drive.textContent = formatRouteMetric(this.routeMetric);
  },

  // ---- Internals --------------------------------------------------

  nextSlot() {
    const now = new Date();
    for (const hour of PAYERNE_SLOT_HOURS_UTC) {
      const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
      if (slot.getTime() > now.getTime()) return slot;
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, PAYERNE_SLOT_HOURS_UTC[0], 0, 0));
  },

  selectSlot(hourUtc) {
    const now = new Date();
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
    this.didFit = false;
    this.routeMetric = null;
    this.post(slot);
    this.render();
  },

  requestForecast() {
    this.post(this.nextSlot());
  },

  post(slot) {
    this.slot = slot;
    worker.postMessage({
      id: FORECAST_ID,
      mode: "scheduled",
      launch: { ...PAYERNE_LAUNCH, at: slot.toISOString() },
      settings: {
        burstAltitude: Number(els.burstAltitude.value),
        ascentRate: Number(els.ascentRate.value),
        descentRate: Number(els.descentRate.value),
      },
    });
    this.populateSelect();
  },

  draw(prediction) {
    for (const layer of this.layers) map.removeLayer(layer);
    this.layers = [];
    this.lastPrediction = prediction || null;
    if (!prediction || !prediction.path?.length) return;

    const slot = this.slot;
    const slotLabel = slot ? `${String(slot.getUTCHours()).padStart(2, "0")}:00 UTC` : "next slot";
    const burstIndex = findBurstIndex(prediction);
    const ascent = prediction.path.slice(0, burstIndex + 1).map((p) => [p.lat, p.lon]);
    const descent = prediction.path.slice(Math.max(0, burstIndex)).map((p) => [p.lat, p.lon]);
    const style = { color: "#6b7280", weight: 4, opacity: 0.85, dashArray: "8,8" };

    const ascentLine = L.polyline(ascent, style).addTo(map);
    const descentLine = L.polyline(descent, style).addTo(map);
    this.layers.push(ascentLine, descentLine);

    const launchMarker = L.marker([PAYERNE_LAUNCH.lat, PAYERNE_LAUNCH.lon], { icon: forecastLaunchIcon })
      .addTo(map)
      .bindTooltip(`Payerne forecast — launch ${slotLabel}`, { direction: "top", permanent: true, offset: [0, -10] });
    this.layers.push(launchMarker);

    if (prediction.burst && Number.isFinite(prediction.burst.lat) && Number.isFinite(prediction.burst.lon)) {
      const altitude = Number.isFinite(prediction.burst.alt_m)
        ? `${Math.round(prediction.burst.alt_m).toLocaleString()} m`
        : "";
      const burstMarker = L.marker([prediction.burst.lat, prediction.burst.lon], { icon: burstIcon })
        .addTo(map)
        .bindTooltip(`Forecast burst ${altitude}`.trim(), { direction: "top" });
      this.layers.push(burstMarker);
    }
    if (prediction.landing && Number.isFinite(prediction.landing.lat) && Number.isFinite(prediction.landing.lon)) {
      const landingLabel = formatUtcHm(prediction.landing.at) || slotLabel;
      const landingMarker = L.marker([prediction.landing.lat, prediction.landing.lon], { icon: landingIcon })
        .addTo(map)
        .bindTooltip(`Forecast landing ${landingLabel}`, { direction: "top" });
      this.layers.push(landingMarker);
    }

    if (!this.didFit && ascent.length + descent.length) {
      map.fitBounds([...ascent, ...descent], { padding: [40, 40], maxZoom: 11 });
      this.didFit = true;
    }

    this.requestRoute(prediction);
  },

  async requestRoute(prediction) {
    const r = receiver.point;
    const landing = prediction?.landing;
    if (!r || !landing || !Number.isFinite(landing.lat) || !Number.isFinite(landing.lon)) return;
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${r.lon},${r.lat};${landing.lon},${landing.lat}` +
      `?overview=full&geometries=geojson`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (activeMode !== this) return;
      const route = data?.routes?.[0];
      const coords = route?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const latlngs = coords.map(([lon, lat]) => [lat, lon]);
      const line = L.polyline(latlngs, { color: "#111827", weight: 5, opacity: 0.9 }).addTo(map);
      this.layers.push(line);
      this.routeMetric = { distance_m: Number(route.distance), duration_s: Number(route.duration) };
      this.render();
    } catch {
      // Forecast route is best-effort; the trajectory and landing remain visible.
    }
  },

  clear() {
    for (const layer of this.layers) map.removeLayer(layer);
    this.layers = [];
    this.slot = null;
    this.lastPrediction = null;
    this.didFit = false;
    this.routeMetric = null;
  },
};

// =====================================================================
// Dispatcher — picks the active mode based on Payerne site freshness
// =====================================================================

let activeMode = null;
let probing = false;

async function probePayerne() {
  if (probing) return;
  probing = true;
  try {
    const serial = await fetchCurrentPayerneSerial();
    await applyMode(serial);
  } finally {
    probing = false;
  }
}

async function applyMode(serial) {
  if (serial) {
    if (activeMode === LiveMode && LiveMode.serial === serial) {
      await LiveMode.refresh(serial);
      return;
    }
    if (activeMode) activeMode.exit();
    activeMode = LiveMode;
    await LiveMode.enter(serial);
    return;
  }
  if (activeMode === ForecastMode) {
    ForecastMode.refresh();
    return;
  }
  if (activeMode) activeMode.exit();
  activeMode = ForecastMode;
  ForecastMode.enter();
}

async function fetchCurrentPayerneSerial() {
  const url = `https://api.v2.sondehub.org/sondes/site/${PAYERNE_WMO}`;
  let payload;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  let bestSerial = null;
  let bestMs = -Infinity;
  for (const [serial, t] of Object.entries(payload)) {
    if (!t || !Number.isFinite(Number(t.lat)) || !Number.isFinite(Number(t.lon))) continue;
    const ms = Date.parse(String(t.datetime || ""));
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      bestSerial = serial;
    }
  }
  if (!bestSerial || Date.now() - bestMs > PAYERNE_FRESH_MS) return null;
  return bestSerial;
}

// =====================================================================
// SSE / worker / DOM wiring
// =====================================================================

function connectEvents() {
  const events = new EventSource("/events");
  events.onopen = () => setStatus("live", "live");
  events.onerror = () => setStatus("stale", "reconnecting");
  events.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "snapshot") loadSnapshot(event.tracks);
    if (event.type === "point") dispatchPoint(event.point, true);
    if (event.type === "landing_history" && activeMode === LiveMode) {
      LiveMode.applyLandingHistory(event.sonde_id, event.points);
    }
  };
}

function loadSnapshot(tracks) {
  if (!tracks || typeof tracks !== "object") return;
  for (const points of Object.values(tracks)) {
    if (!Array.isArray(points)) continue;
    for (const point of points) dispatchPoint(point, false);
  }
  if (activeMode === LiveMode && LiveMode.serial && LiveMode.tracks.has(LiveMode.serial)) {
    LiveMode.requestPrediction(LiveMode.serial);
    LiveMode.fitIfNeeded();
  }
}

function dispatchPoint(point, shouldFit) {
  if (point.source === "receiver") {
    drawReceiver(point);
    return;
  }
  activeMode?.onPoint?.(point, shouldFit);
}

worker.onmessage = (event) => {
  const { id, mode, prediction, cacheKey } = event.data;
  if (mode === "scheduled" || id === FORECAST_ID) {
    ForecastMode.onPrediction({ prediction });
    return;
  }
  LiveMode.onPrediction({ id, prediction, cacheKey });
};

els.select.addEventListener("change", () => {
  activeMode?.onSelect?.(els.select.value || null);
});

for (const input of [els.burstAltitude, els.ascentRate, els.descentRate]) {
  input.addEventListener("change", () => {
    activeMode?.onSettingsChanged?.();
  });
}

// =====================================================================
// Bootstrap
// =====================================================================

async function bootstrap() {
  connectEvents();
  await probePayerne();
  setInterval(probePayerne, PAYERNE_PROBE_INTERVAL_MS);
  try {
    await fetch("/api/sonde/refresh", { method: "POST", cache: "no-store" });
  } catch {
    // SSE will deliver the sonde when the next poll cycle finishes.
  }
}

bootstrap();
