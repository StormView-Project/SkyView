import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { climateFor } from '../../lib/data';
import { currentHourIndex, precipUnit, semantic, speedUnit, tempUnit } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { $, StoreController } from '../../lib/store';
import type { ClimateDay, Hour, NowcastStep, WeatherData } from '../../lib/types';
import { SvElement } from '../../lib/ui';
import { widget } from './common';
import { legend, type Series, type Strip } from './sv-timeseries';
import './sv-timeseries';

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const RAIN = '#4f8ef5';
const SNOW = '#7cc6e8';

/* ================================================ rain in the next hour */

/** Per-15-minute intensity bands, in the user's units (in or mm). */
function bands() {
  return $().units === 'metric' ? { wet: 0.2, moderate: 0.7, heavy: 2 } : { wet: 0.01, moderate: 0.03, heavy: 0.08 };
}

function intensity(v: number) {
  const b = bands();
  return v >= b.heavy ? 'Heavy' : v >= b.moderate ? 'Moderate' : 'Light';
}

/** "Light rain starting around 4:15 PM" and friends. */
function headline(steps: NowcastStep[]) {
  const { wet } = bands();
  const isWet = (s: NowcastStep) => s.precip >= wet;
  const snowy = steps.some((s) => isWet(s) && s.snow);
  const what = snowy ? 'snow' : 'rain';
  const peak = Math.max(...steps.map((s) => s.precip));
  const kind = `${intensity(peak)} ${what}`;
  if (isWet(steps[0])) {
    const stop = steps.findIndex((s) => !isWet(s));
    return stop < 0
      ? { icon: snowy ? 'weather_snowy' : 'rainy', text: `${kind} for the next 2 hours`, wet: true }
      : { icon: snowy ? 'weather_snowy' : 'rainy', text: `${kind} stopping around ${format(steps[stop].time, 'h:mm a')}`, wet: true };
  }
  const start = steps.find(isWet);
  if (start) return { icon: snowy ? 'weather_snowy' : 'rainy_light', text: `${kind} starting around ${format(start.time, 'h:mm a')}`, wet: true };
  return { icon: 'umbrella', text: 'No rain expected for the next 2 hours', wet: false };
}

@customElement('sv-rain-now')
export class SvRainNow extends SvElement {
  private s = new StoreController(this, (s) => [s.nowcast, s.tokens, s.units] as const);
  @state() private picked: number | null = null;

  render() {
    const [nowcast] = this.s.value;
    if (!nowcast) {
      return widget('rainNow', 'Rain in the Next Hour', 'rainy', html`<div class="sv-status"><m3e-loading-indicator class="sv-small-loader"></m3e-loading-indicator>Checking for rain…</div>`);
    }
    const now = Date.now();
    // Start at the 15-minute step that contains "now"; show two hours.
    const steps = nowcast.steps.filter((s) => s.time + 15 * 60_000 > now).slice(0, 9);
    if (steps.length < 2) {
      return widget('rainNow', 'Rain in the Next Hour', 'rainy', html`<p class="sv-body-medium sv-muted">Short-term rain data isn’t available right now.</p>`);
    }
    const h = headline(steps);
    const b = bands();
    // Bars scale to "heavy" so light rain still reads as light.
    const top = Math.max(b.heavy * 1.25, ...steps.map((s) => s.precip));
    const pct = (v: number) => (v <= 0 ? 0 : Math.max(6, (v / top) * 100));
    const rain = semantic(RAIN), snow = semantic(SNOW);
    const sel = this.picked != null ? steps[this.picked] : null;
    return widget('rainNow', 'Rain in the Next Hour', 'rainy', html`
      <div class="sv-rain-head">
        <span class="sv-tile-icon" style="background:${h.wet ? rain.container : 'var(--md-sys-color-surface-container-low)'};color:${h.wet ? rain.onContainer : 'var(--md-sys-color-on-surface-variant)'}">
          <m3e-icon name=${h.icon} filled></m3e-icon>
        </span>
        <div class="sv-title-medium">${h.text}</div>
      </div>
      <div class="sv-rain-chart" role="list">
        <span class="sv-rain-guide" style="bottom:${pct(b.heavy)}%"><span>Heavy</span></span>
        <span class="sv-rain-guide" style="bottom:${pct(b.moderate)}%"><span>Moderate</span></span>
        ${steps.map((s, i) => html`<button class="sv-rain-col ${this.picked === i ? 'picked' : ''}" role="listitem"
            aria-label=${`${format(s.time, 'h:mm a')}: ${s.precip > 0 ? `${s.precip} ${precipUnit()}` : 'dry'}`}
            @click=${() => { this.picked = this.picked === i ? null : i; haptic('tick'); }}>
            <span class="sv-rain-bar" style="height:${pct(s.precip)}%;background:${s.snow ? snow.color : rain.color}"></span>
          </button>`)}
      </div>
      <div class="sv-rain-axis sv-label-small sv-muted">
        <span>Now</span><span>30 min</span><span>1 hr</span><span>1.5 hr</span><span>2 hr</span>
      </div>
      <div class="sv-rain-foot sv-body-small sv-muted">
        ${sel
          ? html`<b>${format(sel.time, 'h:mm a')}</b> · ${sel.precip > 0 ? `${intensity(sel.precip)} ${sel.snow ? 'snow' : 'rain'}, ${sel.precip} ${precipUnit()}` : 'Dry'}${sel.prob != null ? ` · ${sel.prob}% chance` : ''}`
          : html`15-minute forecast · updated ${formatDistanceToNowStrict(nowcast.fetchedAt, { addSuffix: true })}`}
      </div>`);
  }
}

/* ================================================ temperature graph */

@customElement('sv-temp-graph')
export class SvTempGraph extends SvElement {
  @property({ attribute: false }) data!: WeatherData;
  protected watch = new StoreController(this, (s) => [s.tokens, s.units] as const);

  render() {
    const start = currentHourIndex(this.data.hourly);
    const hours = this.data.hourly.slice(start, start + 25);
    if (hours.length < 2) return nothing;
    const tu = tempUnit();
    const series: Series[] = [
      { label: 'Temperature', color: 'var(--md-sys-color-primary)', values: hours.map((h) => h.temp), area: true },
    ];
    if (hours.some((h) => h.feelsLike != null && h.feelsLike !== h.temp)) {
      series.push({ label: 'Feels like', color: 'var(--md-sys-color-tertiary)', values: hours.map((h) => h.feelsLike), dashed: true });
    }
    const strip: Strip | null = hours.some((h) => (h.precipProb ?? 0) > 0)
      ? { label: 'Rain chance', color: semantic(RAIN).color, values: hours.map((h) => h.precipProb), unit: '%' }
      : null;
    const temps = hours.map((h, i) => [h.temp, i] as const).filter((t): t is [number, number] => t[0] != null);
    const hi = temps.reduce((a, b) => (b[0] > a[0] ? b : a));
    const lo = temps.reduce((a, b) => (b[0] < a[0] ? b : a));
    const when = (i: number) => (i === 0 ? 'now' : format(hours[i].time, 'h a'));
    return widget('tempGraph', 'Temperature', 'show_chart', html`
      <div class="sv-body-medium">High <b>${hi[0]}${tu}</b> ${when(hi[1])} · Low <b>${lo[0]}${tu}</b> ${when(lo[1])}</div>
      ${series.length > 1 || strip ? legend(series, strip) : nothing}
      <sv-timeseries .times=${hours.map((h) => h.time)} .series=${series} .strip=${strip} .fmt=${(v: number) => `${Math.round(v)}°`}></sv-timeseries>`);
  }
}

/* ================================================ wind & gusts */

function windDeg(h: Hour): number | null {
  if (h.windDirection != null) return h.windDirection;
  const i = h.windDirectionLabel ? DIRS.indexOf(h.windDirectionLabel) : -1;
  return i < 0 ? null : i * 22.5;
}

@customElement('sv-wind-gusts')
export class SvWindGusts extends SvElement {
  @property({ attribute: false }) data!: WeatherData;
  protected watch = new StoreController(this, (s) => [s.tokens, s.units] as const);

  render() {
    const start = currentHourIndex(this.data.hourly);
    const hours = this.data.hourly.slice(start, start + 25);
    if (hours.length < 2 || hours.every((h) => h.windSpeed == null)) return nothing;
    const su = speedUnit();
    const series: Series[] = [
      { label: 'Wind', color: 'var(--md-sys-color-primary)', values: hours.map((h) => h.windSpeed), area: true },
    ];
    const hasGusts = hours.some((h) => h.windGusts != null);
    if (hasGusts) series.push({ label: 'Gusts', color: 'var(--md-sys-color-tertiary)', values: hours.map((h) => h.windGusts), dashed: true });
    const peakOf = (pick: (h: Hour) => number | null) => hours
      .map((h, i) => [pick(h), i] as const)
      .filter((t): t is [number, number] => t[0] != null)
      .reduce((a, b) => (b[0] > a[0] ? b : a), [-1, 0] as [number, number]);
    const peak = peakOf((h) => (hasGusts ? h.windGusts : h.windSpeed));
    const every = 3;
    return widget('windGusts', 'Wind & Gusts', 'wind_power', html`
      <div class="sv-body-medium">${hasGusts ? 'Strongest gusts' : 'Strongest wind'} <b>${peak[0]} ${su}</b> ${peak[1] === 0 ? 'now' : `around ${format(hours[peak[1]].time, 'h a')}`}</div>
      ${series.length > 1 ? legend(series) : nothing}
      <sv-timeseries .times=${hours.map((h) => h.time)} .series=${series} .fmt=${(v: number) => String(Math.round(v))}
        .belowHeight=${26}
        .below=${(i: number, x: number) => {
          const deg = windDeg(hours[i]);
          if (i % every || deg == null || i === hours.length - 1) return nothing;
          // Arrows point where the wind is blowing (from + 180°).
          return html`<m3e-icon class="sv-wind-arrow" name="arrow_upward" style="left:${x}px;transform:translateX(-50%) rotate(${deg + 180}deg)"
            title=${`From ${DIRS[Math.round(deg / 22.5) % 16]}`}></m3e-icon>`;
        }}></sv-timeseries>
      <div class="sv-label-small sv-muted">${su} · arrows show where the wind is blowing</div>`);
  }
}

/* ================================================ historical climate */

@customElement('sv-climate')
export class SvClimate extends SvElement {
  @property({ attribute: false }) data!: WeatherData;
  protected watch = new StoreController(this, (s) => [s.location, s.units, s.tokens] as const);
  @state() private days: ClimateDay[] | null = null;
  @state() private error = false;
  private loadedFor = '';

  willUpdate() {
    const loc = $().location;
    const key = loc ? `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}` : '';
    if (!loc || key === this.loadedFor) return;
    this.loadedFor = key;
    this.days = null;
    this.error = false;
    climateFor(loc).then(
      (days) => { if (this.loadedFor === key) this.days = days; },
      () => { if (this.loadedFor === key) this.error = true; },
    );
  }

  render() {
    if (this.error) {
      return widget('climate', 'Historical Climate', 'history', html`<p class="sv-body-medium sv-muted">Couldn’t load climate history for this location.</p>`);
    }
    if (!this.days) {
      return widget('climate', 'Historical Climate', 'history', html`<div class="sv-status"><m3e-loading-indicator class="sv-small-loader"></m3e-loading-indicator>Loading 30+ years of history…</div>`);
    }
    const now = new Date();
    const doy = Math.round((Date.UTC(2000, now.getMonth(), now.getDate()) - Date.UTC(2000, 0, 1)) / 86_400_000);
    const c = this.days[doy];
    if (!c || !Number.isFinite(c.normalHigh)) return nothing;
    const metric = $().units === 'metric';
    const t = (v: number) => Math.round(metric ? v : (v * 9) / 5 + 32);
    const tu = tempUnit();
    const today = this.data.daily[0];
    const fHi = today?.tempMax ?? null, fLo = today?.tempMin ?? null;
    const nHi = t(c.normalHigh), nLo = t(c.normalLow), rHi = t(c.recordHigh), rLo = t(c.recordLow);
    // Range strip from record low to record high (and today's forecast, if it's outside).
    const min = Math.min(rLo, fLo ?? rLo), max = Math.max(rHi, fHi ?? rHi);
    const pos = (v: number) => ((v - min) / Math.max(1, max - min)) * 100;
    let line = '';
    if (fHi != null) {
      const d = fHi - nHi;
      line = Math.abs(d) <= 2 ? `Today’s high of ${fHi}° is about normal.`
        : `Today’s high of ${fHi}° is ${Math.abs(d)}° ${d > 0 ? 'above' : 'below'} normal.`;
      if (fHi >= rHi) line += ' That would tie or break the record!';
    }
    const precip = metric ? `${c.normalPrecip.toFixed(1)} mm` : `${(c.normalPrecip / 25.4).toFixed(2)} in`;
    return widget('climate', 'Historical Climate', 'history', html`
      ${line ? html`<div class="sv-title-small">${line}</div>` : nothing}
      <div class="sv-climate-range" aria-hidden="true">
        <div class="sv-climate-track"></div>
        <div class="sv-climate-normal" style="left:${pos(nLo)}%;width:${pos(nHi) - pos(nLo)}%"></div>
        ${fLo != null && fHi != null ? html`<div class="sv-climate-today" style="left:${pos(fLo)}%;width:${Math.max(0.5, pos(fHi) - pos(fLo))}%"></div>` : nothing}
      </div>
      <div class="sv-climate-legend sv-label-small sv-muted">
        <span><i class="normal"></i>Normal range</span>
        ${fHi != null ? html`<span><i class="today"></i>Today’s forecast</span>` : nothing}
      </div>
      <div class="sv-climate-stats">
        <div><span class="sv-label-medium sv-muted">Normal high</span><b class="sv-title-large">${nHi}${tu}</b></div>
        <div><span class="sv-label-medium sv-muted">Normal low</span><b class="sv-title-large">${nLo}${tu}</b></div>
        <div><span class="sv-label-medium sv-muted">Record high</span><b class="sv-title-large">${rHi}${tu}</b><span class="sv-label-small sv-muted">in ${c.recordHighYear}</span></div>
        <div><span class="sv-label-medium sv-muted">Record low</span><b class="sv-title-large">${rLo}${tu}</b><span class="sv-label-small sv-muted">in ${c.recordLowYear}</span></div>
      </div>
      <div class="sv-label-small sv-muted">${format(now, 'MMMM d')} · ${c.years} years (1991–${now.getFullYear() - 1}) · normal precipitation ${precip}</div>`);
  }
}
