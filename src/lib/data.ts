import { api, errorText, notify } from './api';
import { $, store } from './store';
import type { Alert, Place } from './types';

const WEATHER_REFRESH = 10 * 60 * 1000;
const ALERTS_REFRESH = 90 * 1000;
const RADAR_REFRESH = 10 * 60 * 1000; // matches LibreWXR's fetch interval
const FRAME_MS: Record<number, number> = { 0.5: 600, 1: 400, 2: 200 };

let weatherSeq = 0;
let allFrames: Awaited<ReturnType<typeof api.radarFrames>> = [];

export async function refreshWeather() {
  const s = $();
  if (!s.location) return;
  const seq = ++weatherSeq;
  store.set({ weatherLoading: true, weatherError: null });
  try {
    const data = await api.weather(s.location.lat, s.location.lon, s.weatherAPI, s.units);
    if (seq !== weatherSeq) return;
    store.set({ weather: data, weatherLoading: false, weatherError: data.notice });
  } catch (e) {
    if (seq !== weatherSeq) return;
    store.set({ weatherLoading: false, weatherError: errorText(e) || 'Failed to fetch weather data.' });
  }
}

/* ---------------------------------------------------------- notifications */

// Browser stand-in for the desktop app's background monitor: while the page is
// open, new NWS alerts and unhealthy air raise system notifications.
const SEEN_KEY = 'skyview:notified-alerts';
const AQI_EVERY = 30 * 60 * 1000;
const AQI_UNHEALTHY = 200;
const AQI_RENOTIFY = 12 * 60 * 60 * 1000;
let lastAqiCheck = 0;
let lastAqiNotice = 0;

function placeName() {
  return $().location?.name ?? 'your location';
}

function notifyNewAlerts(alerts: Alert[]) {
  const s = $();
  if (!s.notificationsEnabled || !s.notifNws) return;
  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
  } catch { /* start fresh */ }
  const seenSet = new Set(seen);
  for (const a of alerts) {
    if (!a.id || seenSet.has(a.id)) continue;
    notify(`⚠ ${a.title}`, a.headline || `Active for ${placeName()}`);
  }
  // Forget expired alerts so the list can't grow forever.
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(alerts.map((a) => a.id).filter(Boolean)));
  } catch { /* storage unavailable */ }
}

async function checkAirQuality() {
  const s = $();
  if (!s.notificationsEnabled || !s.notifAqi || !s.location) return;
  if (Date.now() - lastAqiCheck < AQI_EVERY) return;
  lastAqiCheck = Date.now();
  try {
    const aq = await api.airQuality(s.location.lat, s.location.lon);
    if ((aq.us_aqi ?? 0) >= AQI_UNHEALTHY && Date.now() - lastAqiNotice > AQI_RENOTIFY) {
      lastAqiNotice = Date.now();
      notify('Unhealthy air quality', `The US AQI near ${placeName()} is ${Math.round(aq.us_aqi!)}. Limit time outdoors.`);
    }
  } catch { /* try again next time */ }
}

export async function refreshAlerts() {
  const loc = $().location;
  if (!loc) return store.set({ alerts: [] });
  checkAirQuality();
  try {
    const alerts = await api.pointAlerts(loc.lat, loc.lon);
    notifyNewAlerts(alerts);
    store.set({ alerts });
  } catch {
    // Outside the US or NWS unavailable — hide the banner silently, like the web app.
    store.set({ alerts: [] });
  }
}

function applyFrameFilter() {
  const frames = $().showNowcast ? allFrames : allFrames.filter((f) => f.type === 'past');
  let idx = frames.length - 1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === 'past') {
      idx = i;
      break;
    }
  }
  store.set({ radarFrames: frames, radarIdx: Math.max(0, idx) });
}

export async function refreshRadar() {
  store.set({ radarLoading: true });
  try {
    allFrames = await api.radarFrames();
    applyFrameFilter();
  } catch (e) {
    console.error('[radar] failed to load frames', e);
  } finally {
    store.set({ radarLoading: false });
  }
}

export function jumpToNow() {
  const frames = $().radarFrames;
  let idx = frames.length - 1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].type === 'past') {
      idx = i;
      break;
    }
  }
  store.set({ radarIdx: Math.max(0, idx), radarPlaying: false });
}

export function setLocation(place: Place) {
  store.set({ location: place, weather: null, alerts: [] });
}

/** How long to wait for a position once the browser has permission. */
const GEO_FIX_MS = 5_000;
/** How long to wait for someone to answer the browser's location prompt. */
const GEO_PROMPT_MS = 30_000;

/** The browser's position, or null if it's blocked, unavailable or too slow. */
async function browserPosition(): Promise<{ lat: number; lon: number } | null> {
  if (!('geolocation' in navigator)) return null;
  let state: PermissionState | 'unknown' = 'unknown';
  try {
    state = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch { /* Permissions API unsupported (older Safari) */ }
  if (state === 'denied') return null;
  return new Promise((resolve) => {
    // Only a pending prompt gets the long wait — the person is deciding.
    const timer = setTimeout(() => resolve(null), state === 'granted' ? GEO_FIX_MS + 500 : GEO_PROMPT_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      // City-level accuracy is plenty for weather, and a recent cached fix is instant.
      { enableHighAccuracy: false, timeout: GEO_FIX_MS, maximumAge: 30 * 60_000 },
    );
  });
}

/**
 * "Use my location": the browser's position, named via reverse geocoding. The
 * IP lookup starts at the same time, so if the browser's position is blocked or
 * slow, the fallback is already (nearly) done instead of starting from scratch.
 */
export async function locateMe(): Promise<Place> {
  const fromIp = api.ipLocate();
  fromIp.catch(() => {}); // only awaited if the browser can't help
  const pos = await browserPosition();
  if (!pos) return fromIp;
  try {
    return await api.reverseGeocode(pos.lat, pos.lon);
  } catch {
    // Nominatim slow or down: use the IP lookup's place name if it's the same area.
    const ip = await Promise.race([fromIp, new Promise<null>((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
    const near = ip && Math.abs(ip.lat - pos.lat) < 0.5 && Math.abs(ip.lon - pos.lon) < 0.5;
    return near ? { ...ip, ...pos } : { ...pos, name: 'My Location', state: '', country: '' };
  }
}

/** Starts every poller and reacts to the settings that invalidate data. */
export function startData() {
  let playTimer: number | undefined;

  const restartPlayback = () => {
    clearInterval(playTimer);
    const s = $();
    if (!s.radarPlaying || s.radarFrames.length === 0) return;
    playTimer = window.setInterval(() => {
      const st = $();
      store.set({ radarIdx: (st.radarIdx + 1) % st.radarFrames.length });
    }, FRAME_MS[s.radarSpeed] ?? 400);
  };

  store.subscribe((s, prev) => {
    if (s.location !== prev.location || s.weatherAPI !== prev.weatherAPI || s.units !== prev.units) {
      refreshWeather();
    }
    if (s.location !== prev.location) refreshAlerts();
    if (s.showNowcast !== prev.showNowcast) applyFrameFilter();
    if (
      s.radarPlaying !== prev.radarPlaying || s.radarSpeed !== prev.radarSpeed ||
      s.radarFrames.length !== prev.radarFrames.length
    ) restartPlayback();
  });

  refreshWeather();
  refreshAlerts();
  refreshRadar();
  setInterval(refreshWeather, WEATHER_REFRESH);
  setInterval(refreshAlerts, ALERTS_REFRESH);
  setInterval(refreshRadar, RADAR_REFRESH);
}
