import { html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { format } from 'date-fns';
import { haptic } from '../../lib/haptics';
import { SvElement } from '../../lib/ui';

/**
 * A small hourly chart: one y-axis shared by every line (same unit), plus an
 * optional strip of bars underneath for a second measure on its own 0–100
 * scale (never a second y-axis on the same plot). A crosshair snaps to the
 * nearest hour and shows every value there.
 */
export interface Series {
  label: string;
  /** CSS color for the mark (a theme role). Text never uses it. */
  color: string;
  values: (number | null)[];
  dashed?: boolean;
  /** Faint wash under the line. */
  area?: boolean;
}

export interface Strip {
  label: string;
  color: string;
  values: (number | null)[]; // 0..100
  unit: string;
}

const PLOT_H = 132;
const STRIP_H = 34;
const PAD_L = 30;
const PAD_R = 10;
const PAD_T = 12;
const AXIS_H = 20;

@customElement('sv-timeseries')
export class SvTimeseries extends SvElement {
  @property({ attribute: false }) times: number[] = [];
  @property({ attribute: false }) series: Series[] = [];
  @property({ attribute: false }) strip: Strip | null = null;
  /** Formats a y value for ticks and the tooltip (e.g. `v => v + '°'`). */
  @property({ attribute: false }) fmt: (v: number) => string = (v) => String(Math.round(v));
  /** Extra row under the axis (e.g. wind direction arrows), one cell per point. */
  @property({ attribute: false }) below: ((i: number, x: number) => TemplateResult | typeof nothing) | null = null;
  @property({ attribute: false }) belowHeight = 0;

  @state() private width = 0;
  @state() private hover: number | null = null;
  private ro?: ResizeObserver;

  connectedCallback() {
    super.connectedCallback();
    this.ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w !== this.width) this.width = w;
    });
    this.ro.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }

  private x(i: number) {
    const n = Math.max(1, this.times.length - 1);
    return PAD_L + ((this.width - PAD_L - PAD_R) * i) / n;
  }

  private onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const n = this.times.length;
    if (!n) return;
    const frac = (e.clientX - r.left - PAD_L) / Math.max(1, r.width - PAD_L - PAD_R);
    const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    if (i !== this.hover) {
      if (e.pointerType === 'touch' && this.hover != null) haptic('drag');
      this.hover = i;
    }
  }

  render() {
    const w = this.width;
    const n = this.times.length;
    if (!w || n < 2) return html`<div style="height:${PLOT_H + AXIS_H + PAD_T}px"></div>`;

    // One shared y-scale with a little headroom, ticks on whole numbers.
    const all = this.series.flatMap((s) => s.values).filter((v): v is number => v != null);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
    const span = hi - lo;
    lo -= span * 0.12; hi += span * 0.12;
    const y = (v: number) => PAD_T + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
    const ticks = [Math.ceil(lo + (hi - lo) * 0.15), Math.round((lo + hi) / 2), Math.floor(hi - (hi - lo) * 0.15)];

    const stripTop = PAD_T + PLOT_H + 8;
    const axisTop = stripTop + (this.strip ? STRIP_H + 6 : 0);
    const total = axisTop + AXIS_H + this.belowHeight;

    const path = (vals: (number | null)[]) => {
      let d = '', pen = false;
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    // Label every 3rd/6th hour depending on width; never crowd.
    const every = w / n < 14 ? 6 : 3;
    const h = this.hover;
    const barW = Math.min(10, Math.max(3, (w - PAD_L - PAD_R) / n - 2));

    return html`
      <div class="sv-ts" style="height:${total}px">
        <svg width=${w} height=${total} role="img" aria-label=${this.series.map((s) => s.label).join(', ')}
          @pointermove=${this.onMove} @pointerdown=${this.onMove} @pointerleave=${() => (this.hover = null)}>
          ${ticks.map((t) => svg`
            <line class="sv-ts-grid" x1=${PAD_L} x2=${w - PAD_R} y1=${y(t)} y2=${y(t)}></line>
            <text class="sv-ts-tick" x=${PAD_L - 6} y=${y(t)} text-anchor="end" dominant-baseline="central">${this.fmt(t)}</text>`)}
          ${this.series.map((s) => {
            const d = path(s.values);
            const first = s.values.findIndex((v) => v != null);
            const last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null);
            return svg`
              ${s.area && first >= 0 ? svg`<path d=${`${d}L${this.x(last)} ${PAD_T + PLOT_H}L${this.x(first)} ${PAD_T + PLOT_H}Z`} fill=${s.color} opacity="0.1"></path>` : nothing}
              <path d=${d} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
                stroke-dasharray=${s.dashed ? '5 4' : 'none'}></path>`;
          })}
          ${this.strip
            ? svg`
              <text class="sv-ts-tick" x=${PAD_L - 6} y=${stripTop + STRIP_H / 2} text-anchor="end" dominant-baseline="central">${this.strip.unit}</text>
              ${this.strip.values.map((v, i) => {
                const bh = v ? Math.max(2, (v / 100) * STRIP_H) : 0;
                return svg`<rect x=${this.x(i) - barW / 2} y=${stripTop + STRIP_H - bh} width=${barW} height=${bh} rx="2" fill=${this.strip!.color}
                  opacity=${h == null || h === i ? 1 : 0.55}></rect>`;
              })}
              <line class="sv-ts-grid" x1=${PAD_L} x2=${w - PAD_R} y1=${stripTop + STRIP_H} y2=${stripTop + STRIP_H}></line>`
            : nothing}
          ${this.times.map((t, i) => (i % every === 0 && i < n - 1
            ? svg`<text class="sv-ts-tick" x=${this.x(i)} y=${axisTop + 12} text-anchor="middle">${i === 0 ? 'Now' : format(t, 'ha').toLowerCase()}</text>`
            : nothing))}
          ${h != null
            ? svg`
              <line class="sv-ts-cross" x1=${this.x(h)} x2=${this.x(h)} y1=${PAD_T} y2=${axisTop}></line>
              ${this.series.map((s) => (s.values[h] != null
                ? svg`<circle cx=${this.x(h)} cy=${y(s.values[h]!)} r="5" fill=${s.color} class="sv-ts-dot"></circle>`
                : nothing))}`
            : nothing}
          <rect x="0" y="0" width=${w} height=${axisTop} fill="transparent"></rect>
        </svg>
        ${this.below ? html`<div class="sv-ts-below" style="top:${axisTop + AXIS_H}px;height:${this.belowHeight}px">
          ${this.times.map((_, i) => this.below!(i, this.x(i)))}</div>` : nothing}
        ${h != null ? this.tooltip(h) : nothing}
      </div>`;
  }

  private tooltip(i: number) {
    // Inside the plot, on whichever side of the crosshair has room.
    const x = this.x(i);
    const side = x > this.width / 2 ? `right:${this.width - x + 10}px` : `left:${x + 10}px`;
    return html`<div class="sv-ts-tip" style=${side}>
      <div class="sv-label-medium sv-strong">${i === 0 ? 'Now' : format(this.times[i], 'EEE h a')}</div>
      ${this.series.map((s) => html`<div class="sv-ts-tip-row"><i style="background:${s.color}" class=${s.dashed ? 'dashed' : ''}></i>${s.label}<b>${s.values[i] == null ? '—' : this.fmt(s.values[i]!)}</b></div>`)}
      ${this.strip ? html`<div class="sv-ts-tip-row"><i class="bar" style="background:${this.strip.color}"></i>${this.strip.label}<b>${this.strip.values[i] ?? '—'}${this.strip.unit}</b></div>` : nothing}
    </div>`;
  }
}

/** Legend row: always shown for two or more series. */
export function legend(series: Series[], strip?: Strip | null) {
  return html`<div class="sv-ts-legend sv-label-medium">
    ${series.map((s) => html`<span><i style="background:${s.color}" class=${s.dashed ? 'dashed' : ''}></i>${s.label}</span>`)}
    ${strip ? html`<span><i class="bar" style="background:${strip.color}"></i>${strip.label}</span>` : nothing}
  </div>`;
}
