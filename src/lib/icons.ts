import { M3eIconElement, registerIcon } from '@m3e/web/icon';
import svgIcons from '../assets/icons/material-symbols-rounded.json';
import './icons.css';

/*
 * Icons render as SVG, not font text. As text, the glyph's position depends on
 * each platform's font metrics, and iOS drew every icon up and to the left of
 * its box. An SVG fills its 1em box exactly everywhere. The paths are generated
 * from Material Symbols Rounded by scripts/build-icon-font.py; the subset font in
 * icons.css stays as a fallback for any name that isn't registered.
 */
const viewBox = '0 -960 960 960'; // Material's standard icon box: the font's 960-unit em, y flipped
for (const [name, [outlined, filled]] of Object.entries(svgIcons as unknown as Record<string, [string, string]>)) {
  registerIcon(name, 'rounded', { outlined: { viewBox, path: outlined }, filled: { viewBox, path: filled } });
}

/*
 * <m3e-icon> defaults to the "outlined" variant, but SkyView's icons are
 * Material Symbols *Rounded*. The `variant` setter is wrapped (lifecycle
 * callbacks can't be patched: the custom-element registry caches them at define
 * time), so the constructor's "outlined" default becomes "rounded" for every
 * icon without an explicit `variant` attribute — including icons m3e components
 * render in their own shadow DOM.
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
