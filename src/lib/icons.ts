import { M3eIconElement } from '@m3e/web/icon';
import './icons.css';

/*
 * <m3e-icon> defaults to the "Material Symbols Outlined" font, but SkyView ships
 * (and is designed around) Material Symbols *Rounded*. Without this, icons only
 * worked on machines that happen to have Outlined installed system-wide; phones
 * showed the icon's text name ("bedtime" → "be") instead.
 *
 * The `variant` setter is wrapped (lifecycle callbacks can't be patched: the
 * custom-element registry caches them at define time), so the constructor's
 * "outlined" default becomes "rounded" for every icon without an explicit
 * `variant` attribute — including icons m3e components render in their own
 * shadow DOM.
 */
const proto = M3eIconElement.prototype;
const desc = Object.getOwnPropertyDescriptor(proto, 'variant');
if (desc?.set && desc.get) {
  Object.defineProperty(proto, 'variant', {
    ...desc,
    set(this: M3eIconElement, v: M3eIconElement['variant']) {
      desc.set!.call(this, v === 'outlined' && !this.hasAttribute('variant') ? 'rounded' : v);
    },
  });
} else {
  console.warn('[icons] m3e-icon has no variant accessor; icons may use the wrong font');
}
