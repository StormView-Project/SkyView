import { html, nothing } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import * as maplibregl from 'maplibre-gl';
import { format } from 'date-fns';
import { radarTileUrl, recolorMap, themedBaseStyle } from './sv-map';
import { $, store, StoreController } from '../lib/store';
import type { RadarFrame } from '../lib/types';
import { SvElement } from '../lib/ui';

const RADAR = 'sv-preview-radar';

/** Latest observed frame — the preview never shows nowcast, it's a "right now" glance. */
function latestPast(frames: RadarFrame[]) {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].type === 'past') return frames[i];
  return frames[frames.length - 1];
}

/**
 * Phone layout: a small, non-interactive live radar map below the hero, like
 * the mobile web app's radar preview. Tapping it opens the Radar tab.
 */
@customElement('sv-radar-preview')
export class SvRadarPreview extends SvElement {
  private s = new StoreController(this, (s) =>
    [s.location, s.radarFrames, s.tokens, s.mapStyle, s.radarColorScheme, s.radarSmooth, s.radarSnow, s.radarOpacity, s.isDark,
      s.radarRenderer, s.radarWasmFailed, s.showArrows] as const);

  @query('.sv-preview-map') private container!: HTMLDivElement;
  private map: maplibregl.Map | null = null;
  private marker: maplibregl.Marker | null = null;
  private ready = false;
  private styleKind = '';
  private frameUrl = '';

  render() {
    const [location, frames] = this.s.value;
    if (!location) return nothing;
    const f = latestPast(frames);
    return html`
      <m3e-card variant="filled" actionable class="sv-preview-card sv-press" @click=${() => store.set({ compactTab: 'radar' })}>
        <div class="sv-preview-inner">
          <div class="sv-preview-map" aria-hidden="true"></div>
          <div class="sv-preview-overlay">
            <span class="sv-chip sv-chip--surface sv-preview-label"><m3e-icon name="radar" filled></m3e-icon>Radar</span>
            ${f ? html`<span class="sv-chip sv-chip--surface sv-preview-time">${format(f.time * 1000, 'h:mm a')}</span>` : nothing}
            <span class="sv-spacer"></span>
            <span class="sv-chip sv-chip--primary sv-preview-cta">Open<m3e-icon name="arrow_forward"></m3e-icon></span>
          </div>
        </div>
      </m3e-card>
    `;
  }

  updated() {
    const loc = $().location;
    if (!loc || !this.container) return;
    if (!this.map) {
      this.map = new maplibregl.Map({
        container: this.container,
        style: { version: 8, sources: {}, layers: [] },
        center: [loc.lon, loc.lat],
        zoom: 6.4,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
      });
      this.map.on('style.load', () => {
        this.ready = true;
        this.frameUrl = '';
        this.sync();
      });
      new ResizeObserver(() => this.map?.resize()).observe(this.container);
    }
    if ($().mapStyle !== this.styleKind) this.loadStyle();
    else this.sync();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.map?.remove();
    this.map = null;
    this.marker = null;
    this.lastTokens = null;
    this.ready = false;
    this.styleKind = '';
  }

  private async loadStyle() {
    this.styleKind = $().mapStyle;
    try {
      const style = await themedBaseStyle($().mapStyle);
      this.ready = false;
      this.map?.setStyle(style, { diff: false });
    } catch (e) {
      console.warn('[preview] style failed', e);
    }
  }

  private lastTokens: unknown = null;

  private sync() {
    const map = this.map;
    const s = $();
    if (!map || !this.ready || !s.location) return;
    if (this.styleKind === 'material' && this.lastTokens !== s.tokens) {
      this.lastTokens = s.tokens;
      recolorMap(map);
    }
    map.jumpTo({ center: [s.location.lon, s.location.lat] });

    const f = latestPast(s.radarFrames);
    const url = f ? radarTileUrl(f) : '';
    if (url !== this.frameUrl) {
      this.frameUrl = url;
      if (map.getLayer(RADAR)) map.removeLayer(RADAR);
      if (map.getSource(RADAR)) map.removeSource(RADAR);
      if (url) {
        const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
        map.addSource(RADAR, { type: 'raster', tiles: [url], tileSize: 512, maxzoom: 12 });
        map.addLayer({ id: RADAR, type: 'raster', source: RADAR, paint: { 'raster-opacity': s.radarOpacity, 'raster-fade-duration': 0 } }, firstSymbol);
      }
    } else if (map.getLayer(RADAR)) {
      map.setPaintProperty(RADAR, 'raster-opacity', s.radarOpacity);
    }

    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'sv-pin';
      el.innerHTML = '<span class="sv-pin-halo"></span><m3e-shape class="sv-pin-shape" name="very-sunny"></m3e-shape>';
      this.marker = new maplibregl.Marker({ element: el }).setLngLat([s.location.lon, s.location.lat]).addTo(map);
    } else {
      this.marker.setLngLat([s.location.lon, s.location.lat]);
    }
  }
}
