import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { errorText } from '../lib/api';
import { isSaved, locateMe, removeSavedLocation, saveLocation, setLocation } from '../lib/data';
import { haptic } from '../lib/haptics';
import { $, store, StoreController, WIDGET_INFO, WIDGET_LABELS, type WidgetId } from '../lib/store';
import type { Place } from '../lib/types';
import { SvElement, toast } from '../lib/ui';
import { renderWidget } from './sv-sidebar';

/** Widgets whose preview would start a network request; they get an icon tile instead. */
const NO_LIVE_PREVIEW = new Set<WidgetId>(['climate', 'futureWeather', 'monthOutlook']);

/**
 * A modal sheet: slides up from the bottom on phones (like Android's widget
 * picker), a centered panel on wider screens. Escape or the scrim closes it.
 */
function sheet(open: boolean, onClose: () => void, title: string, icon: string, body: TemplateResult, cls = '') {
  return html`
    <div class="sv-modal-scrim ${open ? 'open' : ''}" @click=${onClose}></div>
    <section class="sv-modal ${cls} ${open ? 'open' : ''}" role="dialog" aria-modal="true" aria-label=${title} ?inert=${!open}
      @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && onClose()}>
      <div class="sv-modal-grip" aria-hidden="true"></div>
      <header class="sv-modal-head">
        <m3e-icon name=${icon} filled></m3e-icon>
        <span class="sv-title-large">${title}</span>
        <span class="sv-spacer"></span>
        <m3e-icon-button aria-label="Close" @click=${onClose}><m3e-icon name="close"></m3e-icon></m3e-icon-button>
      </header>
      <div class="sv-modal-body sv-scroll">${open ? body : nothing}</div>
    </section>`;
}

/* ===================================================== add widgets */

@customElement('sv-add-widgets')
export class SvAddWidgets extends SvElement {
  private s = new StoreController(this, (s) => [s.addWidgetsOpen, s.widgets, s.weather, s.alerts, s.tokens, s.units] as const);
  @state() private query = '';

  private close = () => {
    store.set({ addWidgetsOpen: false });
    this.query = '';
  };

  private add(id: WidgetId) {
    const widgets = $().widgets;
    const enabled = widgets.filter((w) => w.enabled);
    const rest = widgets.filter((w) => !w.enabled && w.id !== id);
    store.set({ widgets: [...enabled, { id, enabled: true }, ...rest], addWidgetsOpen: false });
    this.query = '';
    haptic('confirm');
    toast(`Added ${WIDGET_LABELS[id]}`);
    // Bring the new section into view and flash it, like Android does after a drop.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.sv-edit-item[data-id="${id}"], .sv-widget-slot[data-id="${id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.animate(
        [{ boxShadow: '0 0 0 0 var(--md-sys-color-primary)' }, { boxShadow: '0 0 0 4px var(--md-sys-color-primary)' }, { boxShadow: '0 0 0 0 var(--md-sys-color-primary)' }],
        { duration: 1400, easing: 'ease-in-out' },
      );
    }));
  }

  render() {
    const [open, widgets, weather, alerts] = this.s.value;
    const q = this.query.trim().toLowerCase();
    const available = widgets
      .filter((w) => !w.enabled)
      .map((w) => w.id)
      .filter((id) => !q || WIDGET_LABELS[id].toLowerCase().includes(q) || WIDGET_INFO[id].desc.toLowerCase().includes(q));
    const body = html`
      <m3e-form-field variant="filled" class="sv-field sv-add-search" hide-subscript="always">
        <m3e-icon slot="prefix" name="search"></m3e-icon>
        <label slot="label" for="widget-search">Search widgets</label>
        <input id="widget-search" autocomplete="off" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
      </m3e-form-field>
      ${available.length
        ? html`<div class="sv-add-grid">
            ${available.map((id) => {
              const preview = weather && !NO_LIVE_PREVIEW.has(id) ? renderWidget(id, weather, alerts.length ? alerts : weather.alerts) : nothing;
              return html`<button class="sv-add-card sv-press" @click=${() => this.add(id)} aria-label=${`Add ${WIDGET_LABELS[id]}`}>
                <div class="sv-add-preview" aria-hidden="true">
                  ${preview !== nothing
                    ? html`<div class="sv-add-preview-inner" inert>${preview}</div>`
                    : html`<m3e-shape name="soft-burst" class="sv-add-icon"><m3e-icon name=${WIDGET_INFO[id].icon} filled></m3e-icon></m3e-shape>`}
                </div>
                <div class="sv-add-text">
                  <div class="sv-title-small">${WIDGET_LABELS[id]}</div>
                  <div class="sv-body-small sv-muted">${WIDGET_INFO[id].desc}</div>
                </div>
                <span class="sv-add-plus"><m3e-icon name="add"></m3e-icon></span>
              </button>`;
            })}
          </div>`
        : html`<div class="sv-empty"><m3e-icon name=${q ? 'search_off' : 'done_all'} style="--m3e-icon-size:40px"></m3e-icon>
            <div class="sv-body-medium">${q ? 'No widgets match your search.' : 'Every widget is already on your home screen.'}</div></div>`}
    `;
    return sheet(open, this.close, 'Add widgets', 'widgets', body, 'sv-modal--widgets');
  }
}

/* ===================================================== places */

@customElement('sv-places')
export class SvPlaces extends SvElement {
  private s = new StoreController(this, (s) => [s.locationsOpen, s.location, s.savedLocations] as const);
  @state() private locating = false;

  private close = () => store.set({ locationsOpen: false });

  private pick(p: Place) {
    haptic('click');
    setLocation(p);
    store.set({ locationsOpen: false });
  }

  private async useMyLocation() {
    this.locating = true;
    try {
      setLocation(await locateMe());
      store.set({ locationsOpen: false });
    } catch (e) {
      toast(errorText(e) || 'Couldn’t find your location.');
    } finally {
      this.locating = false;
    }
  }

  private label(p: Place) {
    return `${p.name}${p.state ? `, ${p.state}` : ''}`;
  }

  render() {
    const [open, location, saved] = this.s.value;
    const starred = isSaved(location);
    const body = html`
      ${location
        ? html`<div class="sv-place-current">
            <m3e-shape name="sunny"><m3e-icon name="location_on" filled></m3e-icon></m3e-shape>
            <div class="sv-grow">
              <div class="sv-label-medium">Showing weather for</div>
              <div class="sv-title-medium">${this.label(location)}</div>
            </div>
            <m3e-icon-button toggle ?selected=${starred} aria-label=${starred ? 'Remove from saved places' : 'Save this place'}
              @beforeinput=${(e: Event) => e.preventDefault()}
              @click=${() => {
                if (starred) { removeSavedLocation(location); toast('Removed from saved places'); } else { saveLocation(location); haptic('confirm'); toast('Saved'); }
              }}>
              <m3e-icon name="star"></m3e-icon><m3e-icon slot="selected" name="star" filled></m3e-icon>
            </m3e-icon-button>
          </div>`
        : nothing}
      <div class="sv-place-actions">
        <m3e-button variant="tonal" ?disabled=${this.locating} @click=${this.useMyLocation}>
          ${this.locating ? html`<m3e-loading-indicator slot="icon" class="sv-small-loader"></m3e-loading-indicator>` : html`<m3e-icon slot="icon" name="my_location"></m3e-icon>`}
          Use my location
        </m3e-button>
        <m3e-button variant="tonal" @click=${() => store.set({ locationsOpen: false, settingsOpen: true, settingsTab: 'location' })}>
          <m3e-icon slot="icon" name="search"></m3e-icon>Search
        </m3e-button>
      </div>
      <h3 class="sv-set-label">Saved places</h3>
      ${saved.length
        ? html`<div class="sv-place-list">
            ${saved.map((p) => {
              const active = !!location && Math.abs(p.lat - location.lat) < 0.01 && Math.abs(p.lon - location.lon) < 0.01;
              return html`<div class="sv-place-row ${active ? 'active' : ''}">
                <button class="sv-place-pick sv-press" @click=${() => this.pick(p)} aria-current=${active ? 'true' : 'false'}>
                  <m3e-icon name=${active ? 'location_on' : 'location_city'} ?filled=${active}></m3e-icon>
                  <span class="sv-grow"><span class="sv-body-large">${p.name}</span>${p.state ? html`<span class="sv-body-small sv-muted"> ${p.state}</span>` : nothing}</span>
                  ${active ? html`<span class="sv-chip sv-chip--primary">Now</span>` : nothing}
                </button>
                <m3e-icon-button size="small" aria-label=${`Remove ${p.name}`} @click=${() => { removeSavedLocation(p); haptic('reject'); }}>
                  <m3e-icon name="close"></m3e-icon>
                </m3e-icon-button>
              </div>`;
            })}
          </div>`
        : html`<p class="sv-body-medium sv-muted sv-place-empty">Tap <m3e-icon name="star" class="sv-inline-icon"></m3e-icon> to save places you check often, then switch between them here.</p>`}
    `;
    return sheet(open, this.close, 'Places', 'location_on', body, 'sv-modal--places');
  }
}
