import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { formatDistanceToNowStrict } from 'date-fns';
import { refreshWeather } from '../lib/data';
import { semantic, SEVERITY_HUE } from '../lib/format';
import { haptic } from '../lib/haptics';
import { $, store, StoreController, WIDGET_INFO, WIDGET_LABELS, type WidgetId } from '../lib/store';
import type { Alert, WeatherData } from '../lib/types';
import { SvElement } from '../lib/ui';
import {
  alertsWidget, aqiWidget, daylightWidget, feelsLikeWidget, moonWidget, outlookWidget, precipOutlookWidget,
  sunriseWidget, uvWidget, windCompassWidget,
} from './widgets/simple';
import './widgets/rich';
import './widgets/extra';

/** One home-screen section. Also used for previews in the Add widgets sheet. */
export function renderWidget(id: WidgetId, d: WeatherData, alerts: Alert[]) {
  switch (id) {
    case 'alerts': return alertsWidget(alerts);
    case 'hourly': return html`<sv-hourly .data=${d}></sv-hourly>`;
    case 'daily': return html`<sv-daily .data=${d}></sv-daily>`;
    case 'sunrise': return sunriseWidget(d);
    case 'details': return html`<sv-details .data=${d}></sv-details>`;
    case 'aqi': return aqiWidget(d);
    case 'windCompass': return windCompassWidget(d);
    case 'feelsLike': return feelsLikeWidget(d);
    case 'precipOutlook': return precipOutlookWidget(d);
    case 'daylight': return daylightWidget(d);
    case 'uvIndex': return uvWidget(d);
    case 'moonPhase': return moonWidget();
    case 'outlook': return outlookWidget(d);
    case 'futureWeather': return html`<sv-future></sv-future>`;
    case 'monthOutlook': return html`<sv-month-outlook></sv-month-outlook>`;
    case 'rainNow': return html`<sv-rain-now></sv-rain-now>`;
    case 'tempGraph': return html`<sv-temp-graph .data=${d}></sv-temp-graph>`;
    case 'windGusts': return html`<sv-wind-gusts .data=${d}></sv-wind-gusts>`;
    case 'climate': return html`<sv-climate .data=${d}></sv-climate>`;
  }
}

/** The scrollable weather body shared by the desktop sidebar and the compact home page. */
@customElement('sv-weather-content')
export class SvWeatherContent extends SvElement {
  private s = new StoreController(this, (s) =>
    [s.weather, s.weatherLoading, s.weatherError, s.widgets, s.alerts, s.location, s.tokens, s.aqiShowPollutants, s.units, s.editingWidgets] as const);
  /** Phone layout: a live radar preview card sits right below the hero. */
  @property({ type: Boolean, attribute: 'radar-preview' }) radarPreview = false;

  private renderWidget(id: WidgetId, d: WeatherData) {
    return renderWidget(id, d, this.s.value[4].length ? this.s.value[4] : d.alerts);
  }

  /* ------------------------------------------------------------ edit mode */

  /** Order while a drag is in progress (committed to settings on drop). */
  @state() private dragOrder: WidgetId[] | null = null;
  @state() private dragging: WidgetId | null = null;
  private drag: { id: WidgetId; pointer: number; grabOffset: number; lastY: number; scroller: HTMLElement | null; raf: number } | null = null;

  private enabledIds(): WidgetId[] {
    return this.dragOrder ?? $().widgets.filter((w) => w.enabled).map((w) => w.id);
  }

  private item(id: WidgetId) {
    return this.querySelector<HTMLElement>(`.sv-edit-item[data-id="${id}"]`);
  }

  private removeWidget(id: WidgetId) {
    haptic('reject');
    store.set({ widgets: $().widgets.map((w) => (w.id === id ? { ...w, enabled: false } : w)) });
  }

  private startDrag(e: PointerEvent, id: WidgetId) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = this.item(id);
    if (!el) return;
    // Follow the pointer on window, not with pointer capture: reordering moves the
    // dragged card's DOM node, and moving a node drops its pointer capture.
    window.addEventListener('pointermove', this.winMove);
    window.addEventListener('pointerup', this.winUp);
    window.addEventListener('pointercancel', this.winUp);
    const r = el.getBoundingClientRect();
    this.drag = { id, pointer: e.pointerId, grabOffset: e.clientY - r.top, lastY: e.clientY, scroller: this.closest('.sv-scroll'), raf: 0 };
    this.dragOrder = this.enabledIds();
    this.dragging = id;
    haptic('click');
    this.autoScroll();
  }

  private winMove = (e: PointerEvent) => this.onDragMove(e);
  private winUp = (e: PointerEvent) => this.endDrag(e);

  private onDragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    d.lastY = e.clientY;
    this.followPointer();
  }

  /** Keeps the dragged card under the finger and swaps it past neighbours' midpoints. */
  private followPointer() {
    const d = this.drag;
    if (!d || !this.dragOrder) return;
    const el = this.item(d.id);
    if (!el) return;
    el.style.transform = '';
    const natural = el.getBoundingClientRect().top;
    el.style.transform = `translateY(${d.lastY - d.grabOffset - natural}px)`;

    const order = this.dragOrder;
    const from = order.indexOf(d.id);
    const center = d.lastY - d.grabOffset + el.offsetHeight / 2;
    let to = from;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === d.id) continue;
      const r = this.item(order[i])?.getBoundingClientRect();
      if (!r) continue;
      const mid = r.top + r.height / 2;
      if (i < from && center < mid) { to = i; break; }
      if (i > from && center > mid) to = i;
    }
    if (to === from) return;
    // FLIP: remember where everyone was, reorder, then slide them from there.
    const before = new Map(order.map((id) => [id, this.item(id)?.getBoundingClientRect().top ?? 0]));
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to, 0, d.id);
    this.dragOrder = next;
    haptic('drag');
    this.updateComplete.then(() => {
      for (const id of next) {
        if (id === d.id) continue;
        const it = this.item(id);
        const dy = (before.get(id) ?? 0) - (it?.getBoundingClientRect().top ?? 0);
        if (it && dy) it.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      }
      this.followPointer();
    });
  }

  /** Scrolls the page while the card is held near its top or bottom edge. */
  private autoScroll = () => {
    const d = this.drag;
    if (!d) return;
    const sc = d.scroller;
    if (sc) {
      const r = sc.getBoundingClientRect();
      const edge = 72;
      const v = d.lastY < r.top + edge ? -(r.top + edge - d.lastY) / 4 : d.lastY > r.bottom - edge ? (d.lastY - (r.bottom - edge)) / 4 : 0;
      if (v) {
        sc.scrollTop += Math.max(-18, Math.min(18, v));
        this.followPointer();
      }
    }
    d.raf = requestAnimationFrame(this.autoScroll);
  };

  private endDrag(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    window.removeEventListener('pointermove', this.winMove);
    window.removeEventListener('pointerup', this.winUp);
    window.removeEventListener('pointercancel', this.winUp);
    cancelAnimationFrame(d.raf);
    const el = this.item(d.id);
    if (el) {
      // Settle into its slot.
      const from = el.style.transform;
      el.style.transform = '';
      if (from) el.animate([{ transform: from }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    const order = this.dragOrder ?? [];
    const enabled = new Set(order);
    const rest = $().widgets.filter((w) => !enabled.has(w.id));
    store.set({ widgets: [...order.map((id) => ({ id, enabled: true })), ...rest] });
    this.drag = null;
    this.dragOrder = null;
    this.dragging = null;
    haptic('confirm');
  }

  private editItem(id: WidgetId, d: WeatherData) {
    const content = this.renderWidget(id, d);
    const empty = content === nothing;
    return html`<div class="sv-edit-item ${this.dragging === id ? 'dragging' : ''}" data-id=${id}>
      <div class="sv-edit-bar">
        <button class="sv-edit-handle" aria-label=${`Drag to move ${WIDGET_LABELS[id]}`}
          @pointerdown=${(e: PointerEvent) => this.startDrag(e, id)}>
          <m3e-icon name="drag_indicator"></m3e-icon>
        </button>
        <span class="sv-label-large sv-edit-name">${WIDGET_LABELS[id]}</span>
        <m3e-icon-button size="small" class="sv-edit-remove" aria-label=${`Remove ${WIDGET_LABELS[id]}`} @click=${() => this.removeWidget(id)}>
          <m3e-icon name="remove_circle" filled></m3e-icon>
        </m3e-icon-button>
      </div>
      <div class="sv-edit-body" inert>
        ${empty
          ? html`<div class="sv-edit-empty"><m3e-icon name=${WIDGET_INFO[id].icon}></m3e-icon><span class="sv-body-small">Shows up when there’s something to show (e.g. active alerts).</span></div>`
          : content}
      </div>
    </div>`;
  }

  /** Marks edit previews that hit the height limit, so only those fade out. */
  updated() {
    if (!this.s.value[9]) return;
    requestAnimationFrame(() => {
      for (const el of this.querySelectorAll<HTMLElement>('.sv-edit-body')) {
        el.classList.toggle('clipped', el.scrollHeight > el.clientHeight + 1);
      }
    });
  }

  private editFooter() {
    return html`<div class="sv-edit-footer">
      <m3e-button variant="tonal" @click=${() => store.set({ addWidgetsOpen: true })}>
        <m3e-icon slot="icon" name="add"></m3e-icon>Add widgets
      </m3e-button>
      <m3e-button variant="filled" @click=${() => store.set({ editingWidgets: false })}>
        <m3e-icon slot="icon" name="check"></m3e-icon>Done
      </m3e-button>
    </div>`;
  }

  render() {
    const [weather, loading, error, widgets, , location] = this.s.value;
    if (!location) {
      return html`<div class="sv-empty">
        <m3e-shape name="pentagon" style="--m3e-shape-size:96px;--m3e-shape-container-color:var(--md-sys-color-tertiary-container);color:var(--md-sys-color-on-tertiary-container)">
          <m3e-icon name="location_on" filled style="--m3e-icon-size:44px"></m3e-icon>
        </m3e-shape>
        <div class="sv-title-large">Set a location to see weather</div>
        <m3e-button variant="filled" @click=${() => store.set({ settingsOpen: true, settingsTab: 'location' })}>
          <m3e-icon slot="icon" name="search"></m3e-icon>Choose location
        </m3e-button>
      </div>`;
    }
    if (!weather && loading) {
      return html`<div class="sv-skeletons">
        <m3e-skeleton shape="rounded" style="height:168px"></m3e-skeleton>
        <m3e-skeleton shape="rounded" style="height:132px"></m3e-skeleton>
        <m3e-skeleton shape="rounded" style="height:280px"></m3e-skeleton>
      </div>`;
    }
    if (!weather) {
      return html`<div class="sv-empty">
        <m3e-icon name="cloud_off" style="--m3e-icon-size:48px"></m3e-icon>
        <div class="sv-title-medium">${error ?? 'No weather data'}</div>
        <m3e-button variant="tonal" @click=${refreshWeather}><m3e-icon slot="icon" name="refresh"></m3e-icon>Try again</m3e-button>
      </div>`;
    }
    const editing = this.s.value[9];
    if (editing) {
      return html`
        <div class="sv-edit-intro">
          <m3e-icon name="dashboard_customize" filled></m3e-icon>
          <div><div class="sv-title-small">Editing home screen</div>
          <div class="sv-body-small sv-muted">Drag <m3e-icon name="drag_indicator" class="sv-inline-icon"></m3e-icon> to reorder, or remove sections you don’t need.</div></div>
        </div>
        <div class="sv-edit-locked"><sv-current .data=${weather}></sv-current></div>
        <div class="sv-edit-list">
          ${repeat(this.enabledIds(), (id) => id, (id) => this.editItem(id, weather))}
        </div>
        ${this.enabledIds().length ? nothing : html`<p class="sv-body-medium sv-muted sv-edit-none">No sections on your home screen yet.</p>`}
        ${this.editFooter()}
      `;
    }
    return html`
      ${error ? html`<m3e-callout variant="tertiary" class="sv-notice"><m3e-icon slot="icon" name="info"></m3e-icon>${error}</m3e-callout>` : nothing}
      <sv-current .data=${weather}></sv-current>
      ${this.radarPreview ? html`<sv-radar-preview></sv-radar-preview>` : nothing}
      ${widgets.filter((w) => w.enabled).map((w) => html`<div class="sv-widget-slot" data-id=${w.id}>${this.renderWidget(w.id, weather)}</div>`)}
      <m3e-button variant="text" class="sv-edit-open" @click=${() => store.set({ editingWidgets: true })}>
        <m3e-icon slot="icon" name="edit"></m3e-icon>Edit home screen
      </m3e-button>
      <div class="sv-attrib sv-label-small sv-muted">
        ${weather.source === 'nws' ? 'National Weather Service' : 'Open-Meteo'}${weather.nwsFallback ? ' (NWS unavailable here)' : ''} · updated
        ${formatDistanceToNowStrict(weather.fetchedAt, { addSuffix: true })}
      </div>
    `;
  }
}

/** Rotating banner for active NWS alerts at this location. */
@customElement('sv-alert-banner')
export class SvAlertBanner extends SvElement {
  private s = new StoreController(this, (s) => [s.alerts, s.tokens] as const);
  @state() private idx = 0;

  render() {
    const [alerts] = this.s.value;
    if (!alerts.length) return nothing;
    const i = Math.min(this.idx, alerts.length - 1);
    const a = alerts[i];
    const c = semantic(SEVERITY_HUE[a.severity] ?? SEVERITY_HUE.Unknown);
    const multi = alerts.length > 1;
    return html`<div class="sv-banner" style="background:${c.container};color:${c.onContainer}">
      <m3e-icon name="warning" filled style="color:${c.color}"></m3e-icon>
      <span class="sv-banner-title">${a.title}</span>
      ${multi
        ? html`<m3e-icon-button size="extra-small" aria-label="Previous alert" @click=${() => (this.idx = (i - 1 + alerts.length) % alerts.length)}><m3e-icon name="chevron_left"></m3e-icon></m3e-icon-button>
            <span class="sv-label-small">${i + 1}/${alerts.length}</span>
            <m3e-icon-button size="extra-small" aria-label="Next alert" @click=${() => (this.idx = (i + 1) % alerts.length)}><m3e-icon name="chevron_right"></m3e-icon></m3e-icon-button>`
        : nothing}
      <m3e-button size="extra-small" variant="filled" style="--m3e-filled-button-container-color:${c.color};--m3e-filled-button-label-text-color:${c.container}" @click=${() => store.set({ alertDialog: alerts })}>
        ${multi ? 'See all' : 'Details'}
      </m3e-button>
    </div>`;
  }
}

/** Location + provider + refresh row, shared by the sidebar and the compact home page. */
@customElement('sv-location-header')
export class SvLocationHeader extends SvElement {
  private s = new StoreController(this, (s) =>
    [s.location, s.weatherLoading, s.editingWidgets, s.savedLocations.length] as const);

  render() {
    const [location, loading, editing, saved] = this.s.value;
    return html`
      <header class="sv-sidebar-head">
        <m3e-button variant="text" class="sv-loc-btn" aria-label="Places"
          @click=${() => store.set(location ? { locationsOpen: true } : { settingsOpen: true, settingsTab: 'location' })}>
          <m3e-icon slot="icon" name="location_on" filled></m3e-icon>
          ${location ? html`<span class="sv-loc-name">${location.name}</span>${location.state ? html`<span class="sv-loc-state">${location.state}</span>` : nothing}` : 'Set your location'}
          ${location ? html`<m3e-icon slot="trailing-icon" name=${saved ? 'unfold_more' : 'expand_more'} class="sv-loc-more"></m3e-icon>` : nothing}
        </m3e-button>
        <span class="sv-spacer"></span>
        ${location && !editing
          ? html`<m3e-icon-button aria-label="Refresh weather" @click=${refreshWeather} ?disabled=${loading}>
              ${loading ? html`<m3e-loading-indicator class="sv-small-loader"></m3e-loading-indicator>` : html`<m3e-icon name="refresh"></m3e-icon>`}
            </m3e-icon-button>`
          : nothing}
        ${location
          ? html`<m3e-icon-button aria-label=${editing ? 'Done editing' : 'Edit home screen'} variant=${editing ? 'filled' : 'standard'}
              @click=${() => store.set({ editingWidgets: !editing })}>
              <m3e-icon name=${editing ? 'check' : 'edit'}></m3e-icon>
            </m3e-icon-button>`
          : nothing}
      </header>
    `;
  }
}

@customElement('sv-sidebar')
export class SvSidebar extends SvElement {
  private s = new StoreController(this, (s) => [s.sidebarPosition] as const);

  render() {
    return html`
      <aside class="sv-sidebar sv-surface-float" data-side=${this.s.value[0]}>
        <sv-location-header></sv-location-header>
        <sv-alert-banner></sv-alert-banner>
        <div class="sv-sidebar-body sv-scroll">
          <sv-weather-content></sv-weather-content>
        </div>
      </aside>
    `;
  }
}
