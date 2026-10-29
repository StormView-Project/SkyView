import * as p from './providers';
import type { ChatMessage, Place } from './types';

const SETTINGS_KEY = 'skyview:settings';
const LEGACY_SETTINGS_KEY = 'fluff-weather:settings';

/** The data layer the components talk to — every call goes straight from the browser to the service. */
export const api = {
  weather: (lat: number, lon: number, provider: string, units: string) =>
    p.getWeather(lat, lon, provider, units === 'metric' ? 'metric' : 'imperial'),
  pointAlerts: p.fetchPointAlerts,
  search: p.searchLocation,
  reverseGeocode: p.reverseGeocode,
  ipLocate: (): Promise<Place> => p.ipLocate(),
  airQuality: p.airQuality,
  airQualityBatch: p.airQualityBatch,
  futureRange: (lat: number, lon: number, start: string, end: string, units: string) =>
    p.futureRange(lat, lon, start, end, units === 'metric' ? 'metric' : 'imperial'),
  radarFrames: p.radarFrames,
  nowcast: (lat: number, lon: number, units: string) => p.fetchNowcast(lat, lon, units === 'metric' ? 'metric' : 'imperial'),
  climate: p.fetchClimate,
  activeAlerts: p.activeAlerts,
  zoneGeometries: p.zoneGeometries,
  async loadSettings(): Promise<Record<string, unknown>> {
    try {
      // Carry settings over from before the rename to SkyView.
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(LEGACY_SETTINGS_KEY) ?? '{}');
    } catch {
      return {};
    }
  },
  async saveSettings(settings: object) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[settings] could not save', e);
    }
  },
  async testNotification() {
    notify('SkyView notifications are on', "You'll be alerted about NWS warnings and unhealthy air for your location while SkyView is open.");
  },
  assistantModels: p.assistantModels,
  assistantChat: (provider: string, baseUrl: string, model: string, messages: ChatMessage[], onDelta: (text: string) => void) =>
    p.assistantChat(provider, baseUrl, model, messages, onDelta),
};

export async function notify(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: title };
  // Through the service worker when there is one: Android Chrome only shows
  // notifications that way, and a tap focuses the app.
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg) {
    try {
      await reg.showNotification(title, options);
      return;
    } catch { /* fall back below */ }
  }
  try {
    new Notification(title, options);
  } catch (e) {
    console.warn('[notify]', e);
  }
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
