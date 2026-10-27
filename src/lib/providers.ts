/**
 * Every network call the app makes, straight from the browser.
 * Ported from the Rust backend of the old desktop build (weather.rs, services.rs,
 * assistant.rs) — all of these services send permissive CORS headers.
 */
import type {
  AirQuality, Alert, AqiPoint, ChatMessage, Current, Day, Hour, OutlookDay, Place, RadarFrame, WeatherData,
} from './types';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const NWS = 'https://api.weather.gov';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const SEASONAL = 'https://seasonal-api.open-meteo.com/v1/seasonal';
const LIBREWXR_API = 'https://api.librewxr.net/public/weather-maps.json';
const LIBREWXR_HOST = 'https://api.librewxr.net';
const NWS_ACTIVE = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const GEOJSON = 'application/geo+json';

type Units = 'imperial' | 'metric';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/* ------------------------------------------------------------------ http */

/** GET a URL and decode the JSON body, turning non-2xx responses into a readable error. */
async function getJson<T = Json>(url: string, accept?: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: accept ? { Accept: accept } : undefined,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 140).trim()}`);
  }
  return res.json() as Promise<T>;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* --------------------------------------------------------------- helpers */

const WMO: Record<number, string> = {
  0: 'Clear Sky', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Icy Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle', 56: 'Freezing Drizzle', 57: 'Heavy Freezing Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain', 66: 'Freezing Rain', 67: 'Heavy Freezing Rain',
  71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains', 80: 'Light Showers', 81: 'Showers',
  82: 'Violent Showers', 85: 'Snow Showers', 86: 'Heavy Snow Showers', 95: 'Thunderstorm',
  96: 'Thunderstorm w/ Hail', 99: 'Severe Thunderstorm',
};
const wmoDescription = (code: number) => WMO[code] ?? 'Unknown';

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const windLabel = (deg: number) => DIRS[Math.round(deg / 22.5) % 16];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null) => (v == null ? null : Math.round(v));
const at = (o: Json, key: string, i: number) => num(o?.[key]?.[i]);

/** Meters → miles or km, one decimal place. */
function visibility(m: number | null, units: Units) {
  if (m == null) return null;
  return units === 'imperial' ? Math.round((m / 1609.34) * 10) / 10 : Math.round((m / 1000) * 10) / 10;
}

function unitParams(units: Units) {
  return units === 'imperial'
    ? { t: 'fahrenheit', w: 'mph', p: 'inch' }
    : { t: 'celsius', w: 'kmh', p: 'mm' };
}

/* ------------------------------------------------------------ Open-Meteo */

export async function fetchOpenMeteo(lat: number, lon: number, units: Units): Promise<WeatherData> {
  const { t, w, p } = unitParams(units);
  const current = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,' +
    'pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,dew_point_2m,is_day';
  const hourly = 'temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m,' +
    'wind_direction_10m,is_day,uv_index,precipitation,visibility,relative_humidity_2m,surface_pressure';
  const daily = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
    'precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max,' +
    'shortwave_radiation_sum';
  const url = `${OPEN_METEO}?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}&temperature_unit=${t}&wind_speed_unit=${w}` +
    `&precipitation_unit=${p}&timezone=auto&timeformat=unixtime&forecast_days=7&current=${current}&hourly=${hourly}&daily=${daily}`;
  const d = await getJson(url);
  const cu = d.current ?? {};
  const dl = d.daily ?? {};
  const hr = d.hourly ?? {};
  const code = num(cu.weather_code) ?? -1;
  const windDir = num(cu.wind_direction_10m);
  const ms = (v: number | null) => (v == null ? null : v * 1000);

  const cur: Current = {
    temp: round(num(cu.temperature_2m)),
    feelsLike: round(num(cu.apparent_temperature)),
    humidity: num(cu.relative_humidity_2m),
    windSpeed: round(num(cu.wind_speed_10m)),
    windDirection: windDir,
    windDirectionLabel: windDir == null ? null : windLabel(windDir),
    windGusts: round(num(cu.wind_gusts_10m)),
    visibility: visibility(num(cu.visibility), units),
    pressure: round(num(cu.pressure_msl)),
    dewPoint: round(num(cu.dew_point_2m)),
    cloudCover: num(cu.cloud_cover),
    uvIndex: num(cu.uv_index),
    precipProb: null,
    precipitation: num(cu.precipitation),
    condition: wmoDescription(code),
    conditionCode: code,
    isDay: cu.is_day === 1,
    sunrise: ms(at(dl, 'sunrise', 0)),
    sunset: ms(at(dl, 'sunset', 0)),
  };

  const hours: Hour[] = (hr.time ?? []).map((_: unknown, i: number) => {
    const c = at(hr, 'weather_code', i) ?? -1;
    const dir = at(hr, 'wind_direction_10m', i);
    return {
      time: (at(hr, 'time', i) ?? 0) * 1000,
      temp: round(at(hr, 'temperature_2m', i)),
      feelsLike: round(at(hr, 'apparent_temperature', i)),
      precipProb: at(hr, 'precipitation_probability', i) ?? 0,
      precipitation: at(hr, 'precipitation', i) ?? 0,
      conditionCode: c,
      condition: wmoDescription(c),
      windSpeed: round(at(hr, 'wind_speed_10m', i)),
      windDirection: dir,
      windDirectionLabel: dir == null ? null : windLabel(dir),
      uvIndex: at(hr, 'uv_index', i),
      visibility: visibility(at(hr, 'visibility', i) ?? 0, units),
      humidity: at(hr, 'relative_humidity_2m', i),
      pressure: round(at(hr, 'surface_pressure', i)),
      isDay: at(hr, 'is_day', i) === 1,
    };
  });

  const days: Day[] = (dl.time ?? []).map((_: unknown, i: number) => {
    const c = at(dl, 'weather_code', i) ?? -1;
    return {
      date: (at(dl, 'time', i) ?? 0) * 1000,
      tempMax: round(at(dl, 'temperature_2m_max', i)),
      tempMin: round(at(dl, 'temperature_2m_min', i)),
      feelsMax: round(at(dl, 'apparent_temperature_max', i)),
      feelsMin: round(at(dl, 'apparent_temperature_min', i)),
      conditionCode: c,
      condition: wmoDescription(c),
      precipSum: at(dl, 'precipitation_sum', i) ?? 0,
      precipProb: at(dl, 'precipitation_probability_max', i) ?? 0,
      windSpeedMax: round(at(dl, 'wind_speed_10m_max', i)),
      windGustsMax: round(at(dl, 'wind_gusts_10m_max', i)),
      uvIndexMax: at(dl, 'uv_index_max', i),
      sunrise: ms(at(dl, 'sunrise', i)),
      sunset: ms(at(dl, 'sunset', i)),
      shortwaveRadiation: at(dl, 'shortwave_radiation_sum', i),
    };
  });

  return {
    current: cur, hourly: hours, daily: days, alerts: [], source: 'openmeteo', airQuality: null,
    nwsFallback: false, notice: null, location: null, fetchedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------- NWS */

const msOf = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

const convertTempC = (c: number | null, units: Units) =>
  c == null ? null : units === 'imperial' ? Math.round((c * 9) / 5 + 32) : Math.round(c);

const fToUnits = (f: number | null, units: Units) =>
  f == null ? null : units === 'imperial' ? Math.round(f) : Math.round(((f - 32) * 5) / 9);

/** NWS observations come as km/h (`wmoUnit:km_h-1`) or m/s depending on station. */
function obsSpeed(v: Json, units: Units) {
  const val = num(v?.value);
  if (val == null) return null;
  const kmh = String(v?.unitCode ?? '').includes('m_s-1') ? val * 3.6 : val;
  return units === 'imperial' ? Math.round(kmh / 1.609) : Math.round(kmh);
}

const toHpa = (pa: number | null) => (pa == null ? null : pa > 2000 ? Math.round(pa / 100) : Math.round(pa));

/** NWS free-text forecast → WMO-compatible code so icons work the same for both providers. */
export function shortForecastToCode(text: string): number {
  const t = text.toLowerCase();
  const has = (s: string) => t.includes(s);
  if (has('thunder')) return 95;
  if (has('snow') && has('rain')) return 61;
  if (has('blizzard') || has('heavy snow')) return 75;
  if (has('snow')) return 71;
  if (has('ice') || has('sleet')) return 77;
  if (has('freezing rain') || has('freezing drizzle')) return 53;
  if (has('heavy rain') || has('heavy shower')) return 82;
  if (has('rain') || has('showers')) return 61;
  if (has('drizzle')) return 51;
  if (has('fog') || has('mist') || has('haze') || has('smoke')) return 45;
  if (has('mostly cloudy') || has('overcast') || has('cloudy')) return 3;
  if (has('partly cloudy') || has('partly sunny')) return 2;
  if (has('mostly clear') || has('mostly sunny')) return 1;
  if (has('sunny') || has('clear')) return 0;
  return 2;
}

export function normalizeAlert(f: Json): Alert {
  const p = f?.properties ?? {};
  const s = (k: string) => (typeof p[k] === 'string' ? p[k] : '');
  return {
    id: p.id ?? f?.id ?? '',
    title: s('event'),
    headline: s('headline'),
    description: s('description'),
    instruction: s('instruction'),
    severity: p.severity ?? 'Unknown',
    certainty: p.certainty ?? 'Unknown',
    urgency: p.urgency ?? 'Unknown',
    start: msOf(p.onset) ?? msOf(p.sent),
    end: msOf(p.expires) ?? msOf(p.ends),
  };
}

const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const severityRank = (s: string) => {
  const i = SEVERITY.indexOf(s);
  return i < 0 ? 4 : i;
};

/** Active alerts for a single point, most severe first. */
export async function fetchPointAlerts(lat: number, lon: number): Promise<Alert[]> {
  const data = await getJson(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}&status=actual`, GEOJSON);
  const alerts: Alert[] = (data.features ?? []).map(normalizeAlert);
  return alerts.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Midnight of an RFC 3339 timestamp's calendar day, in that timestamp's own UTC offset. */
function localMidnight(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
  const local = t + offset;
  return local - (((local % 86_400_000) + 86_400_000) % 86_400_000) - offset;
}

export async function fetchNws(lat: number, lon: number, units: Units): Promise<WeatherData> {
  const point = await getJson(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, GEOJSON);
  const p = point.properties ?? {};
  if (!p.forecast) throw new Error('NWS has no forecast for this point');
  if (!p.forecastHourly) throw new Error('NWS has no hourly forecast');
  const rel = p.relativeLocation?.properties ?? {};

  const obsP = (async () => {
    const st = await getJson(`${p.observationStations}?limit=1`, GEOJSON);
    const id = st.features?.[0]?.properties?.stationIdentifier;
    if (!id) throw new Error('no station');
    return (await getJson(`${NWS}/stations/${id}/observations/latest`, GEOJSON)).properties;
  })();
  const [forecast, hourlyFc, alerts, obs] = await Promise.allSettled([
    getJson(p.forecast, GEOJSON),
    getJson(p.forecastHourly, GEOJSON),
    fetchPointAlerts(lat, lon),
    obsP,
  ]);
  if (forecast.status === 'rejected') throw forecast.reason;
  if (hourlyFc.status === 'rejected') throw hourlyFc.reason;
  const o: Json = obs.status === 'fulfilled' ? obs.value ?? {} : {};
  const periods: Json[] = forecast.value.properties?.periods ?? [];
  const p0: Json = periods[0] ?? {};

  const text: string = (o.textDescription || p0.shortForecast || 'Unknown') as string;
  const windDir = num(o.windDirection?.value);
  const cur: Current = {
    temp: convertTempC(num(o.temperature?.value), units),
    feelsLike: null,
    humidity: round(num(o.relativeHumidity?.value)),
    windSpeed: obsSpeed(o.windSpeed, units),
    windDirection: windDir,
    windDirectionLabel: windDir == null ? null : windLabel(windDir),
    windGusts: obsSpeed(o.windGust, units),
    visibility: visibility(num(o.visibility?.value), units),
    pressure: toHpa(num(o.barometricPressure?.value) ?? num(o.seaLevelPressure?.value)),
    dewPoint: convertTempC(num(o.dewpoint?.value), units),
    cloudCover: null,
    uvIndex: null,
    precipProb: null,
    precipitation: null,
    condition: text,
    conditionCode: shortForecastToCode(text),
    isDay: p0.isDaytime ?? true,
    sunrise: null,
    sunset: null,
  };
  // Heat index / wind chill are what "feels like" means for NWS observations.
  cur.feelsLike = convertTempC(num(o.heatIndex?.value) ?? num(o.windChill?.value), units);
  if (cur.temp == null) {
    cur.temp = fToUnits(num(p0.temperature), units);
    if (p0.shortForecast) {
      cur.condition = p0.shortForecast;
      cur.conditionCode = shortForecastToCode(p0.shortForecast);
    }
  }
  if (cur.feelsLike == null) cur.feelsLike = cur.temp;

  const hourly: Hour[] = (hourlyFc.value.properties?.periods ?? []).map((h: Json) => {
    const raw = String(h.windSpeed ?? '0');
    const n = parseFloat(raw.replace(/[^\d.]/g, '')) || 0;
    const mph = raw.toLowerCase().includes('km') ? n / 1.609 : n;
    const sf: string = h.shortForecast ?? '';
    return {
      time: msOf(h.startTime) ?? 0,
      temp: fToUnits(num(h.temperature), units),
      feelsLike: null,
      precipProb: num(h.probabilityOfPrecipitation?.value) ?? 0,
      precipitation: null,
      conditionCode: shortForecastToCode(sf),
      condition: sf,
      windSpeed: units === 'imperial' ? Math.round(mph) : Math.round(mph * 1.609),
      windDirection: null,
      windDirectionLabel: h.windDirection ?? null,
      uvIndex: null,
      visibility: null,
      humidity: round(num(h.relativeHumidity?.value)),
      pressure: null,
      isDay: h.isDaytime ?? true,
    };
  });

  // Group the 12-hourly day/night periods into calendar days (in the location's own offset).
  const byDay = new Map<number, Json[]>();
  for (const per of periods) {
    const mid = localMidnight(per.startTime);
    if (mid == null) continue;
    if (!byDay.has(mid)) byDay.set(mid, []);
    byDay.get(mid)!.push(per);
  }
  const daily: Day[] = [...byDay.entries()].sort((a, b) => a[0] - b[0]).slice(0, 7).map(([date, ps]) => {
    const dayP = ps.find((x) => x.isDaytime === true) ?? ps[0];
    const nightP = ps.find((x) => x.isDaytime === false);
    const hi = fToUnits(num(dayP.temperature), units);
    const lo = nightP ? fToUnits(num(nightP.temperature), units) : null;
    const sf: string = dayP.shortForecast ?? '';
    return {
      date, tempMax: hi, tempMin: lo ?? (hi == null ? null : hi - 10), feelsMax: null, feelsMin: null,
      conditionCode: shortForecastToCode(sf), condition: sf, precipSum: null,
      precipProb: num(dayP.probabilityOfPrecipitation?.value) ?? 0,
      windSpeedMax: null, windGustsMax: null, uvIndexMax: null, sunrise: null, sunset: null, shortwaveRadiation: null,
    };
  });

  return {
    current: cur, hourly, daily, alerts: alerts.status === 'fulfilled' ? alerts.value : [], source: 'nws',
    airQuality: null, nwsFallback: false, notice: null,
    location: { name: rel.city ?? null, state: rel.state ?? null }, fetchedAt: Date.now(),
  };
}

/** Full forecast + air quality. If NWS fails (e.g. outside the US) it falls back to Open-Meteo. */
export async function getWeather(lat: number, lon: number, provider: string, units: Units): Promise<WeatherData> {
  const aqP = airQuality(lat, lon).catch(() => null);
  let data: WeatherData;
  if (provider === 'nws') {
    try {
      data = await fetchNws(lat, lon, units);
    } catch (e) {
      console.warn('NWS failed, falling back to Open-Meteo:', e);
      data = await fetchOpenMeteo(lat, lon, units);
      data.nwsFallback = true;
      data.notice = 'NWS is only available in the US. Showing Open-Meteo data instead.';
    }
  } else {
    data = await fetchOpenMeteo(lat, lon, units);
  }
  data.airQuality = await aqP;
  return data;
}

/* -------------------------------------------------------------- geocoding */

function placeFromNominatim(r: Json, lat: number, lon: number): Place {
  const a = r.address ?? {};
  const name = ['city', 'town', 'village', 'hamlet', 'municipality', 'county'].map((k) => a[k]).find(Boolean) ?? r.name ?? 'Unknown';
  return {
    lat, lon, name,
    state: a.state ?? a.region ?? '',
    country: String(a.country_code ?? '').toUpperCase(),
    display: r.display_name,
  };
}

export async function searchLocation(query: string): Promise<Place[]> {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=6&accept-language=en-US,en`;
  const data: Json[] = await getJson(url);
  return data
    .map((r) => ({ r, lat: parseFloat(r.lat), lon: parseFloat(r.lon) }))
    .filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon))
    .map(({ r, lat, lon }) => placeFromNominatim(r, lat, lon));
}

export async function reverseGeocode(lat: number, lon: number): Promise<Place> {
  const r = await getJson(`${NOMINATIM}/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=en-US,en`);
  if (r.error) throw new Error('No place found at these coordinates');
  const p = placeFromNominatim(r, lat, lon);
  delete p.display;
  return p;
}

/** Approximate location from the network, used when the browser's Geolocation is denied. */
export async function ipLocate(): Promise<Place> {
  let place: Place | null = null;
  try {
    const v = await getJson('https://ipwho.is/');
    if (v.success && num(v.latitude) != null && num(v.longitude) != null) {
      place = { lat: v.latitude, lon: v.longitude, name: v.city || 'My Location', state: v.region || '', country: v.country_code || '' };
    }
  } catch { /* try the next service */ }
  if (!place) {
    const v = await getJson('https://ipapi.co/json/');
    if (num(v.latitude) == null || num(v.longitude) == null) throw new Error("Couldn't determine your location from your network.");
    place = { lat: v.latitude, lon: v.longitude, name: v.city || 'My Location', state: v.region || '', country: v.country_code || '' };
  }
  // Prefer Nominatim's naming so it matches places picked from search.
  try {
    const p = await reverseGeocode(place.lat, place.lon);
    place = { ...place, name: p.name, state: p.state, country: p.country };
  } catch { /* keep the IP service's naming */ }
  return place;
}

/* ------------------------------------------------------------ air quality */

export async function airQuality(lat: number, lon: number): Promise<AirQuality> {
  const v = await getJson(`${AIR_QUALITY}?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}&timezone=auto` +
    '&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide');
  return v.current ?? {};
}

/** US AQI for many grid points; Open-Meteo accepts coordinate lists, chunked to stay under URL limits. */
export async function airQualityBatch(points: { lat: number; lon: number }[]): Promise<AqiPoint[]> {
  const chunks: { lat: number; lon: number }[][] = [];
  for (let i = 0; i < points.length; i += 100) chunks.push(points.slice(i, i + 100));
  const results = await pool(chunks, 3, async (chunk) => {
    const lats = chunk.map((p) => p.lat.toFixed(4)).join(',');
    const lons = chunk.map((p) => p.lon.toFixed(4)).join(',');
    try {
      const v = await getJson(`${AIR_QUALITY}?latitude=${lats}&longitude=${lons}&current=us_aqi&timezone=auto`);
      const arr: Json[] = Array.isArray(v) ? v : [v];
      return chunk.map((p, i) => ({ lat: p.lat, lon: p.lon, aqi: num(arr[i]?.current?.us_aqi) }));
    } catch {
      return [];
    }
  });
  return results.flat();
}

/* ---------------------------------------------------- seasonal (long range) */

function classifyPrecip(rain: number | null, showers: number | null, snow: number | null, total: number | null): OutlookDay['precipType'] {
  if (rain == null && showers == null && snow == null && total == null) return null;
  const pos = (v: number | null) => (v ?? 0) > 0;
  if (pos(snow)) return 'snow';
  if (pos(showers)) return 'showers';
  if (pos(rain) || pos(total)) return 'rain';
  return 'none';
}

export async function futureRange(lat: number, lon: number, start: string, end: string, units: Units): Promise<OutlookDay[]> {
  const { t, w, p } = unitParams(units);
  const vars = 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,rain_sum,showers_sum,' +
    'snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,relative_humidity_2m_mean,cloud_cover_mean';
  const v = await getJson(`${SEASONAL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=${vars}` +
    `&start_date=${start}&end_date=${end}&temperature_unit=${t}&wind_speed_unit=${w}&precipitation_unit=${p}&timezone=auto`);
  const d = v.daily ?? {};
  const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
  return (d.time ?? [])
    .map((date: string, i: number): OutlookDay => {
      const rain = at(d, 'rain_sum', i);
      const showers = at(d, 'showers_sum', i);
      const snow = at(d, 'snowfall_sum', i);
      const total = at(d, 'precipitation_sum', i);
      return {
        date,
        tempMax: round(at(d, 'temperature_2m_max', i)),
        tempMin: round(at(d, 'temperature_2m_min', i)),
        tempMean: round(at(d, 'temperature_2m_mean', i)),
        precipSum: r2(total),
        rainSum: rain,
        showersSum: showers,
        snowfallSum: snow,
        precipType: classifyPrecip(rain, showers, snow, total),
        windSpeedMax: round(at(d, 'wind_speed_10m_max', i)),
        windGustsMax: round(at(d, 'wind_gusts_10m_max', i)),
        humidityMean: round(at(d, 'relative_humidity_2m_mean', i)),
        cloudCoverMean: round(at(d, 'cloud_cover_mean', i)),
      };
    })
    // Dates at the edge of the model's range come back present but empty.
    .filter((x: OutlookDay) => x.tempMax != null || x.tempMin != null || x.precipSum != null);
}

/* ---------------------------------------------------------------- radar */

/** LibreWXR mirrors the RainViewer v2 API. Its `host` field can point at a LAN address, so tiles always use the public host. */
export async function radarFrames(): Promise<RadarFrame[]> {
  const v = await getJson(LIBREWXR_API);
  const frames: RadarFrame[] = [];
  for (const kind of ['past', 'nowcast'] as const) {
    for (const f of v.radar?.[kind] ?? []) {
      if (typeof f.time === 'number' && typeof f.path === 'string') frames.push({ time: f.time, path: f.path, host: LIBREWXR_HOST, type: kind });
    }
  }
  return frames.sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------ NWS alert geometry */

/** The national active-alert feed (GeoJSON FeatureCollection), passed through as-is. */
export const activeAlerts = () => getJson<GeoJSON.FeatureCollection>(NWS_ACTIVE, GEOJSON);

/** Zone boundaries are static admin shapes, so results (misses too) are cached for the session. */
const zoneCache = new Map<string, GeoJSON.Geometry | null>();

export async function zoneGeometries(ids: string[]): Promise<Record<string, GeoJSON.Geometry>> {
  const out: Record<string, GeoJSON.Geometry> = {};
  const toFetch: string[] = [];
  for (const id of ids) {
    if (!zoneCache.has(id)) toFetch.push(id);
    else if (zoneCache.get(id)) out[id] = zoneCache.get(id)!;
  }
  await pool(toFetch, 6, async (id) => {
    // UGC format: SSZ000 (forecast/fire zone) or SSC000 (county).
    const kind = id[2] === 'C' ? 'county' : 'forecast';
    let geo: GeoJSON.Geometry | null = null;
    try {
      geo = (await getJson(`${NWS}/zones/${kind}/${id}`, GEOJSON)).geometry ?? null;
    } catch { /* cache the miss */ }
    zoneCache.set(id, geo);
    if (geo) out[id] = geo;
  });
  return out;
}

/* ------------------------------------------------------------ assistant */

const base = (url: string) => url.replace(/\/+$/, '');

function unreachable(b: string, e: unknown) {
  const why = e instanceof Error ? e.message : String(e);
  return new Error(
    `Couldn't reach the model server at ${b} — is it running, and does it allow requests from this site? ` +
    `For Ollama, start it with OLLAMA_ORIGINS="*". (${why})`,
  );
}

export async function assistantModels(provider: string, baseUrl: string): Promise<string[]> {
  const b = base(baseUrl);
  try {
    if (provider === 'ollama') {
      const v = await getJson(`${b}/api/tags`);
      return (v.models ?? []).map((m: Json) => m.name).filter(Boolean);
    }
    const v = await getJson(`${b}/v1/models`);
    return (v.data ?? []).map((m: Json) => m.id).filter(Boolean);
  } catch (e) {
    throw unreachable(b, e);
  }
}

/** Streams a chat completion: Ollama sends NDJSON, OpenAI-compatible servers send SSE `data:` lines. */
export async function assistantChat(
  provider: string, baseUrl: string, model: string, messages: ChatMessage[], onDelta: (t: string) => void,
) {
  const b = base(baseUrl);
  const ollama = provider === 'ollama';
  let res: Response;
  try {
    res = await fetch(ollama ? `${b}/api/chat` : `${b}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (e) {
    throw unreachable(b, e);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Model server returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const payload = ollama ? line : line.startsWith('data:') ? line.slice(5).trim() : '';
      if (payload === '[DONE]') return;
      let v: Json;
      try {
        v = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof v.error === 'string') throw new Error(v.error);
      const delta = ollama ? v.message?.content : v.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
      if (ollama && v.done) return;
    }
  }
}
