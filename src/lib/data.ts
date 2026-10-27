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

/** "Use my location": the browser's Geolocation API first, then an IP lookup. */
export async function locateMe(): Promise<Place> {
  const fromBrowser = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const timer = setTimeout(() => resolve(null), 20000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 15000, maximumAge: 60000 },
    );
  });
  if (fromBrowser) {
    try {
      return await api.reverseGeocode(fromBrowser.lat, fromBrowser.lon);
    } catch {
      return { ...fromBrowser, name: 'My Location', state: '', country: '' };
    }
  }
  return api.ipLocate();
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
