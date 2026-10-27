import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { AQI_SCALE, harmonize } from '../lib/format';
import { store, StoreController } from '../lib/store';
import { SvElement } from '../lib/ui';
import './sv-map';
import './sv-scrubber';
import './sv-sidebar';
import './sv-settings';
import './sv-dialogs';
import './sv-assistant';
import './sv-radar-preview';

const NARROW = 760;
const TABS = ['location', 'api', 'display', 'widgets', 'radar', 'alerts', 'assistant'] as const;
const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement).closest?.('input, textarea, m3e-select, m3e-form-field');

@customElement('sv-app')
export class SvApp extends SvElement {
  private s = new StoreController(this, (s) =>
    [s.ready, s.isNarrow, s.compactLayout, s.compactTab, s.mapLayer, s.settingsOpen, s.sidebarPosition, s.showSatellite,
      s.tokens] as const);

  connectedCallback() {
    super.connectedCallback();
    const onResize = () => {
      const narrow = window.innerWidth < NARROW;
      if (narrow !== store.get().isNarrow) store.set({ isNarrow: narrow });
    };
    window.addEventListener('resize', onResize);
    onResize();
    const nextTab = (step: number) => {
      const i = TABS.indexOf(store.get().settingsTab);
      store.set({ settingsTab: TABS[(i + step + TABS.length) % TABS.length] });
    };
    window.addEventListener('keydown', (e) => {
      const st = store.get();
      if ((e.key === ',' && (e.ctrlKey || e.metaKey)) || e.key === 'F2') {
        e.preventDefault();
        store.set({ settingsOpen: !st.settingsOpen });
      } else if (e.key === 'F3' && st.settingsOpen) {
        e.preventDefault();
        nextTab(1);
      } else if (e.key === 'Tab' && e.ctrlKey && st.settingsOpen) {
        e.preventDefault();
        nextTab(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && (st.settingsOpen || st.assistantOpen)) {
        store.set({ settingsOpen: false, assistantOpen: false });
      } else if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      } else if (e.key === '+' || e.key === '=' || e.key === '-') {
        window.dispatchEvent(new CustomEvent('sv-zoom', { detail: e.key === '-' ? -1 : 1 }));
      } else if (e.key === ' ' && (e.target === document.body || (e.target as HTMLElement).tagName === 'SV-APP')) {
        e.preventDefault();
        store.set({ radarPlaying: !st.radarPlaying });
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && st.radarFrames.length && !(e.target as HTMLElement).closest('.sv-timeline')) {
        const idx = Math.max(0, Math.min(st.radarFrames.length - 1, st.radarIdx + (e.key === 'ArrowLeft' ? -1 : 1)));
        store.set({ radarPlaying: false, radarIdx: idx });
      }
    });
  }

  private toolbar(compact: boolean) {
    const [, , , , layer, settingsOpen, , satellite] = this.s.value;
    return html`<m3e-toolbar variant="standard" shape="rounded" elevated class="sv-toolbar ${compact ? 'compact' : ''}">
      ${compact
        ? nothing
        : html`<m3e-button variant="text" size="extra-small" class="sv-beta-btn" @click=${() => store.set({ betaOpen: true })}>BETA</m3e-button>`}
      <m3e-button-group variant="connected" size="small">
        <m3e-icon-button toggle ?selected=${layer === 'radar'} variant="tonal" aria-label="Radar layer"
          @beforeinput=${(e: Event) => layer === 'radar' && e.preventDefault()} @click=${() => store.set({ mapLayer: 'radar' })}>
          <m3e-icon name="radar"></m3e-icon><m3e-icon slot="selected" name="radar" filled></m3e-icon>
        </m3e-icon-button>
        <m3e-icon-button toggle ?selected=${layer === 'aqi'} variant="tonal" aria-label="Air quality layer"
          @beforeinput=${(e: Event) => layer === 'aqi' && e.preventDefault()} @click=${() => store.set({ mapLayer: 'aqi' })}>
          <m3e-icon name="air"></m3e-icon><m3e-icon slot="selected" name="air" filled></m3e-icon>
        </m3e-icon-button>
      </m3e-button-group>
      <m3e-icon-button toggle ?selected=${satellite} aria-label="Satellite imagery" @click=${() => store.set({ showSatellite: !satellite })}>
        <m3e-icon name="satellite_alt"></m3e-icon><m3e-icon slot="selected" name="satellite_alt" filled></m3e-icon>
      </m3e-icon-button>
      ${compact
        ? nothing
        : html`<m3e-icon-button aria-label="Get the apps" title="Get the apps" @click=${() => store.set({ downloadsOpen: true })}>
            <m3e-icon name="download"></m3e-icon>
          </m3e-icon-button>`}
      ${compact
        ? nothing
        : html`<m3e-icon-button variant="filled" width="wide" toggle ?selected=${settingsOpen} aria-label="Settings" @click=${() => store.set({ settingsOpen: !settingsOpen })}>
            <m3e-icon name="settings"></m3e-icon><m3e-icon slot="selected" name="settings" filled></m3e-icon>
          </m3e-icon-button>`}
    </m3e-toolbar>`;
  }

  /** M3 navigation bar: an expressive pill indicator slides behind the selected icon. */
  private navBar(tab: 'home' | 'radar', settingsOpen: boolean) {
    const current = settingsOpen ? 'settings' : tab;
    const items = [
      { id: 'home', label: 'Home', icon: 'home' },
      { id: 'radar', label: 'Radar', icon: 'radar' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
    ] as const;
    return html`<nav class="sv-navbar" aria-label="Main">
      ${items.map((it) => html`<button
        class="sv-nav-item ${current === it.id ? 'active' : ''}"
        aria-current=${current === it.id ? 'page' : 'false'}
        @click=${() => (it.id === 'settings'
          ? store.set({ settingsOpen: !settingsOpen })
          : store.set({ compactTab: it.id, settingsOpen: false }))}
      >
        <span class="sv-nav-pill"><m3e-icon name=${it.icon} ?filled=${current === it.id}></m3e-icon></span>
        <span class="sv-nav-label">${it.label}</span>
      </button>`)}
    </nav>`;
  }

  private aqiLegend() {
    return html`<div class="sv-aqi-legend sv-surface-float">
      <div class="sv-title-small">US Air Quality Index</div>
      <div class="sv-aqi-ramp" style="background:linear-gradient(90deg, ${AQI_SCALE.map((c) => harmonize(c.hue)).join(', ')})"></div>
      <div class="sv-row-between sv-label-small sv-muted"><span>Good</span><span>Moderate</span><span>Unhealthy</span><span>Hazardous</span></div>
      <div class="sv-label-small sv-muted">Click the map for exact readings</div>
    </div>`;
  }

  render() {
    const [ready, narrow, compactPref, compactTab, layer, settingsOpen, side] = this.s.value;
    const compact = narrow && compactPref;
    return html`
      <div class="sv-app" data-side=${side} data-compact=${compact} data-tab=${compactTab} data-ready=${ready}>
        <sv-map></sv-map>
        ${compact
          ? html`
              ${compactTab === 'home'
                ? html`<div class="sv-compact-home sv-scroll">
                    <sv-location-header class="sv-compact-head"></sv-location-header>
                    <sv-alert-banner></sv-alert-banner>
                    <sv-weather-content radar-preview></sv-weather-content>
                  </div>`
                : html`<div class="sv-compact-radar">
                    <div class="sv-compact-radar-top">
                      <m3e-button variant="tonal" class="sv-back-btn" @click=${() => store.set({ compactTab: 'home' })}>
                        <m3e-icon slot="icon" name="arrow_back"></m3e-icon>Back
                      </m3e-button>
                      ${this.toolbar(true)}
                    </div>
                    ${layer === 'radar' ? html`<sv-scrubber></sv-scrubber>` : this.aqiLegend()}
                  </div>`}
              ${this.navBar(compactTab, settingsOpen)}
            `
          : html`
              <sv-sidebar></sv-sidebar>
              <div class="sv-top-corner">${this.toolbar(false)}</div>
              <div class="sv-bottom-dock">${layer === 'radar' ? html`<sv-scrubber></sv-scrubber>` : this.aqiLegend()}</div>
            `}
        <sv-assistant></sv-assistant>
        <sv-settings></sv-settings>
        <sv-dialogs></sv-dialogs>
        ${ready ? nothing : html`<div class="sv-splash"><m3e-loading-indicator variant="contained"></m3e-loading-indicator></div>`}
      </div>
    `;
  }
}
