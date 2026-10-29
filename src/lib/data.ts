import { api, errorText, notify } from './api';
import { $, store } from './store';
import { format } from 'date-fns';
import type { Alert, ClimateDay, Place, WeatherData } from './types';

const WEATHER_REFRESH = 10 * 60 * 1000;
const ALERTS_REFRESH = 90 * 1000;
const RADAR_REFRESH = 10 * 60 * 1000; // matches LibreWXR's fetch interval
const NOWCAST_REFRESH = 5 * 60 * 1000;
const FRAME_MS: Record<number, number> = { 0.5: 600, 1: 400, 2: 200 };

let weatherSeq = 0;
let allFrames: Awaited<ReturnType<typeof api.radarFrames>> = [];

/* ------------------------------------------------- last-known forecast */

// The last forecast is kept so the app opens instantly, and still shows
// something useful with no connection.
const LAST_KEY = 'skyview:last-weather';
const placeKey = (p: Place) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
const weatherKey = () => {
  const s = $();
  return s.location ? `${placeKey(s.location)}|${s.weatherAPI}|${s.units}` : '';
};

/** Forecasts for the last few places viewed, newest first, so switching saved places is instant. */
const LAST_MAX = 6;
type LastWeather = { key: string; data: WeatherData }[];

function readLast(): LastWeather {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveLastWeather(data: WeatherData) {
  const key = weatherKey();
  const list = [{ key, data }, ...readLast().filter((e) => e.key !== key)].slice(0, LAST_MAX);
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(list));
  } catch { /* storage full or blocked */ }
}

/** The saved forecast, if there is one for the current location and units. */
function lastWeather(): WeatherData | null {
  const key = weatherKey();
  return readLast().find((e) => e.key === key)?.data ?? null;
}

export async function refreshWeather() {
  const s = $();
  if (!s.location) return;
  const seq = ++weatherSeq;
  store.set({ weatherLoading: true, weatherError: null });
  try {
    const data = await api.weather(s.location.lat, s.location.lon, s.weatherAPI, s.units);
    if (seq !== weatherSeq) return;
    store.set({ weather: data, weatherLoading: false, weatherError: data.notice, offline: false });
    saveLastWeather(data);
  } catch (e) {
    if (seq !== weatherSeq) return;
    const shown = $().weather ?? lastWeather();
    if (shown) {
      // Keep the last forecast on screen and say how old it is.
      const age = format(shown.fetchedAt, "EEE 'at' h:mm a");
      store.set({
        weather: shown, weatherLoading: false, offline: true,
        weatherError: `${navigator.onLine ? "Couldn't reach the weather service" : "You're offline"} — showing the forecast from ${age}.`,
      });
    } else {
      store.set({ weatherLoading: false, weatherError: errorText(e) || 'Failed to fetch weather data.' });
    }
  }
}

/* ------------------------------------------------------- 15-minute nowcast */

const RAIN_NOTICE_KEY = 'skyview:rain-notice';
/** Rain this soon gets a notification... */
const RAIN_SOON_MS = 45 * 60 * 1000;
/** ...when at least this much falls in a 15-minute step (in or mm). */
const rainThreshold = () => ($().units === 'metric' ? 0.2 : 0.01);

export async function refreshNowcast() {
  const loc = $().location;
  if (!loc) return store.set({ nowcast: null });
  try {
    const nowcast = await api.nowcast(loc.lat, loc.lon, $().units);
    if ($().location !== loc) return;
    store.set({ nowcast });
    notifyRainSoon();
  } catch {
    // Keep the previous nowcast; the widget says how old it is.
  }
}

/** "Rain starting around 4:15 PM" — once per rain event, only while it's dry now. */
function notifyRainSoon() {
  const s = $();
  if (!s.notificationsEnabled || !s.notifRain || !s.nowcast) return;
  const now = Date.now();
  const steps = s.nowcast.steps.filter((st) => st.time + 15 * 60_000 > now);
  const wet = (st: { precip: number }) => st.precip >= rainThreshold();
  if (!steps.length || wet(steps[0])) return;
  const start = steps.find((st) => st.time - now <= RAIN_SOON_MS && wet(st));
  if (!start) return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(RAIN_NOTICE_KEY) ?? 0);
  } catch { /* storage blocked */ }
  if (now - last < 2 * 60 * 60_000) return; // one notification per rain event
  try {
    localStorage.setItem(RAIN_NOTICE_KEY, String(now));
  } catch { /* storage blocked */ }
  const what = start.snow ? 'Snow' : 'Rain';
  notify(`${what} starting around ${format(start.time, 'h:mm a')}`, `${what} is expected near ${placeName()} in the next ${Math.max(15, Math.round((start.time - now) / 60_000 / 5) * 5)} minutes.`);
}

/* ------------------------------------------------------- historical climate */

const CLIMATE_TTL = 30 * 24 * 60 * 60_000;
const climateMemo = new Map<string, Promise<ClimateDay[]>>();

/** Day-of-year normals and records for a place, cached in localStorage for a month. */
export function climateFor(place: Place): Promise<ClimateDay[]> {
  const key = `skyview:climate:${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  const hit = climateMemo.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (saved && Date.now() - saved.at < CLIMATE_TTL) return saved.days as ClimateDay[];
    } catch { /* fetch below */ }
    const days = await api.climate(place.lat, place.lon);
    try {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), days }));
    } catch { /* still works without the cache */ }
    return days;
  })();
  p.catch(() => climateMemo.delete(key));
  climateMemo.set(key, p);
  return p;
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
  store.set({ location: place, weather: null, alerts: [], nowcast: null, offline: false });
  // Show this place's saved forecast (if any) while the fresh one loads.
  const cached = lastWeather();
  if (cached) store.set({ weather: cached });
}

/* ------------------------------------------------------------ saved places */

const samePlace = (a: Place, b: Place) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

export function isSaved(place: Place | null) {
  return !!place && $().savedLocations.some((p) => samePlace(p, place));
}

export function saveLocation(place: Place) {
  if (isSaved(place)) return;
  store.set({ savedLocations: [...$().savedLocations, place] });
}

export function removeSavedLocation(place: Place) {
  store.set({ savedLocations: $().savedLocations.filter((p) => !samePlace(p, place)) });
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
    if (s.location !== prev.location || s.units !== prev.units) refreshNowcast();
    if (s.showNowcast !== prev.showNowcast) applyFrameFilter();
    if (
      s.radarPlaying !== prev.radarPlaying || s.radarSpeed !== prev.radarSpeed ||
      s.radarFrames.length !== prev.radarFrames.length
    ) restartPlayback();
  });

  // Open instantly with the last forecast for this place; the fresh one replaces it.
  const cached = lastWeather();
  if (cached) store.set({ weather: cached });

  const refreshAll = () => {
    refreshWeather();
    refreshAlerts();
    refreshRadar();
    refreshNowcast();
  };
  refreshAll();
  window.addEventListener('online', refreshAll);
  setInterval(refreshWeather, WEATHER_REFRESH);
  setInterval(refreshAlerts, ALERTS_REFRESH);
  setInterval(refreshRadar, RADAR_REFRESH);
  setInterval(refreshNowcast, NOWCAST_REFRESH);
}
