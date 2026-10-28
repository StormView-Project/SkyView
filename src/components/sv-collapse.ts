import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const DURATION = 380; // ms for a full open/close, like the native app
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'; // M3 emphasized
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Slides its content open and closed. The animation always starts from the
 * height currently on screen, so toggling mid-animation reverses smoothly
 * instead of jumping, and nothing inside (child transitions, ripples) can end
 * it early.
 */
@customElement('sv-collapse')
export class SvCollapse extends LitElement {
  static styles = css`
    :host { display: block; overflow: hidden; }
    :host(:not([open])) { height: 0; }
    .content { transition: opacity 300ms; }
    :host(:not([open])) .content { opacity: 0; transition-duration: 150ms; }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  private anim: Animation | null = null;
  /** Height on screen just before `open` changed (mid-animation if one is running). */
  private from = 0;

  render() {
    return html`<div class="content" part="content"><slot></slot></div>`;
  }

  protected willUpdate(changed: PropertyValues<this>) {
    // Measure before the [open] attribute flips, which changes the CSS height.
    if (changed.has('open')) this.from = this.getBoundingClientRect().height;
  }

  protected updated(changed: PropertyValues<this>) {
    if (!changed.has('open')) return;
    // Closed content shouldn't be reachable with Tab or by screen readers.
    this.inert = !this.open;
    if (changed.get('open') === undefined) return; // first render: no animation

    const from = this.from;
    this.anim?.cancel();
    const to = this.open ? this.scrollHeight : 0;
    if (reducedMotion.matches || from === to) return;

    // A partial reversal takes proportionally less time than a full slide.
    const full = Math.max(this.scrollHeight, 1);
    const duration = Math.max(140, DURATION * Math.min(1, Math.abs(to - from) / full));
    const anim = this.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration, easing: EASING });
    this.anim = anim;
    anim.onfinish = anim.oncancel = () => {
      if (this.anim === anim) this.anim = null;
    };
  }
}

/** Click handler for a header that toggles the `sv-collapse` inside its `.sv-collapsible` container. */
export function toggleCollapse(e: Event) {
  const host = (e.currentTarget as HTMLElement).closest('.sv-collapsible');
  const body = host?.querySelector<SvCollapse>(':scope > sv-collapse');
  if (!host || !body) return;
  body.open = !body.open;
  host.classList.toggle('open', body.open);
  (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(body.open));
}

declare global {
  interface HTMLElementTagNameMap {
    'sv-collapse': SvCollapse;
  }
}
