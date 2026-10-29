import { $ } from './store';

/**
 * Haptic feedback, in the spirit of Google's Material You apps: a light tick on
 * every press, a firmer click for toggles, a double pulse to confirm, and a
 * short buzz to reject.
 *
 * - Android (Chrome): the Vibration API with very short pulses, which feel like
 *   the system's own crisp haptics rather than a phone-call buzz.
 * - iOS 18+ (Safari): there's no vibration API, but tapping a native
 *   `<input type="checkbox" switch>` plays the system haptic. A hidden switch is
 *   toggled through its <label> from inside the user's tap.
 */
export type HapticKind = 'tick' | 'click' | 'toggle' | 'confirm' | 'reject' | 'drag';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 6,          // ordinary press
  click: 10,        // primary/filled buttons, FAB
  toggle: 12,       // switches, chips, segments
  confirm: [10, 60, 14],
  reject: [24, 40, 24],
  drag: 4,          // each step while dragging or scrubbing
};

const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

let iosLabel: HTMLLabelElement | null = null;
function iosTap() {
  if (!iosLabel) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'sv-haptic-switch';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    iosLabel = document.createElement('label');
    iosLabel.htmlFor = input.id;
    iosLabel.setAttribute('aria-hidden', 'true');
    iosLabel.dataset.haptic = 'internal';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:-10px';
    box.append(input, iosLabel);
    document.body.append(box);
  }
  iosLabel.click();
}

let lastAt = 0;

export function haptic(kind: HapticKind = 'tick') {
  if (!$().haptics) return;
  // Never stack pulses: rapid events (scrubbing, double taps) get one each 35 ms.
  const now = performance.now();
  if (now - lastAt < 35) return;
  lastAt = now;
  if (canVibrate) {
    try {
      navigator.vibrate(PATTERNS[kind]);
    } catch { /* blocked until the first user gesture */ }
  } else if (isIOS) {
    // iOS plays one fixed tap; for a confirm, a second one makes it feel distinct.
    iosTap();
    if (kind === 'confirm') setTimeout(iosTap, 90);
  }
}

/** Which haptic a pressed element gets, or null for none. */
function kindFor(el: Element): HapticKind | null {
  const tag = el.tagName;
  if (tag === 'M3E-SWITCH' || tag === 'M3E-CHECKBOX' || tag === 'M3E-FILTER-CHIP' || tag === 'M3E-BUTTON-SEGMENT') return 'toggle';
  if (tag === 'M3E-FAB') return 'click';
  if (tag === 'M3E-BUTTON' || tag === 'M3E-ICON-BUTTON') {
    const v = el.getAttribute('variant');
    if (el.hasAttribute('toggle')) return 'toggle';
    return v === 'filled' ? 'click' : 'tick';
  }
  return 'tick';
}

const PRESSABLE = [
  'm3e-button', 'm3e-icon-button', 'm3e-fab', 'm3e-switch', 'm3e-checkbox', 'm3e-button-segment',
  'm3e-filter-chip', 'm3e-suggestion-chip', 'm3e-tab', 'm3e-option', 'm3e-list-action', 'm3e-menu-item',
  '.sv-press', '.sv-nav-item', '.sv-collapsible > button', '.sv-swatch', '.sv-scheme', '.sv-haptic',
].join(',');

/** One delegated listener gives every button, switch, chip and tab its haptic. */
export function initHaptics() {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (!target || (target as HTMLElement).dataset?.haptic === 'internal' || target.id === 'sv-haptic-switch') return;
    const el = e.composedPath().find((n): n is Element => n instanceof Element && n.matches(PRESSABLE));
    if (!el || el.hasAttribute('disabled')) return;
    const kind = kindFor(el);
    if (kind) haptic(kind);
  }, { capture: true });
}
