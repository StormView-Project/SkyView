import { LitElement } from 'lit';
import { M3eSnackbar } from '@m3e/web/snackbar';

/**
 * All app components render into light DOM so one global stylesheet (built on
 * the --md-sys-* tokens <m3e-theme> provides) styles everything consistently.
 */
export class SvElement extends LitElement {
  protected createRenderRoot() {
    return this;
  }
}

export function toast(message: string, action?: string, onAction?: () => void) {
  if (action) {
    M3eSnackbar.open(message, action, true, { duration: 6000, actionCallback: onAction });
  } else {
    M3eSnackbar.open(message, { duration: 4000 });
  }
}

export function openExternal(url: string) {
  window.open(url, '_blank', 'noopener');
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

/** Reads `.value` / `.checked` from M3E form controls in event handlers. */
export const valueOf = (e: Event) => (e.target as unknown as { value: string }).value;
export const checkedOf = (e: Event) => (e.target as unknown as { checked: boolean }).checked;

/**
 * Press feedback for the app's own clickable surfaces (hourly cards, swatches,
 * tiles…), matching Settings → Display → Press animation. "Shape morph" is pure
 * CSS (`[data-press]` on <html> + `:active`); the ripple is drawn here. The
 * ripple is held for a minimum time so even a quick tap shows it finishing.
 */
const PRESSABLE = '.sv-press';
const MIN_RIPPLE_MS = 380;

export function initPressFx() {
  document.addEventListener('pointerdown', (e) => {
    const style = document.documentElement.dataset.press ?? 'morph';
    if (style === 'morph' || e.button !== 0) return;
    const host = (e.target as HTMLElement).closest<HTMLElement>(PRESSABLE);
    if (!host) return;
    const r = host.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const ink = document.createElement('span');
    ink.className = 'sv-ripple';
    ink.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    host.appendChild(ink);
    const born = performance.now();
    const release = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      setTimeout(() => {
        ink.classList.add('out');
        setTimeout(() => ink.remove(), 300);
      }, Math.max(0, MIN_RIPPLE_MS - (performance.now() - born)));
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  });
}

/*
 * Horizontal strips (hourly forecast, the hours inside a 7-day row) scroll
 * sideways with the mouse wheel. Each wheel gesture is latched to whatever it
 * started on: a gesture that starts on a strip keeps scrolling that strip even
 * after it reaches the end (instead of suddenly scrolling the page), and a page
 * scroll that sweeps a strip under the pointer keeps scrolling the page.
 */
const GESTURE_GAP_MS = 200;
let gestureOwner: HTMLElement | 'page' | null = null;
let lastWheel = 0;

window.addEventListener('wheel', () => {
  const now = performance.now();
  if (now - lastWheel > GESTURE_GAP_MS) gestureOwner = null;
  lastWheel = now;
}, { capture: true, passive: true });
// Anything no strip claimed is a page scroll.
window.addEventListener('wheel', () => {
  gestureOwner ??= 'page';
}, { passive: true });

/** Wheel delta in pixels, whatever unit the device reports. */
function px(delta: number, mode: number, el: HTMLElement) {
  return mode === WheelEvent.DOM_DELTA_LINE ? delta * 16 : mode === WheelEvent.DOM_DELTA_PAGE ? delta * el.clientWidth : delta;
}

export function wheelToHorizontal(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (e.ctrlKey || el.scrollWidth <= el.clientWidth) return; // pinch-zoom, or nothing to scroll
  const dx = px(e.deltaX, e.deltaMode, el);
  const dy = px(e.deltaY, e.deltaMode, el);
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const delta = horizontal ? dx : dy;

  if (gestureOwner === null) {
    const canMove = delta < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    gestureOwner = horizontal || canMove ? el : 'page';
  }
  if (gestureOwner !== el) return;
  e.preventDefault();
  el.scrollLeft += delta;
}
