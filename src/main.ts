// Typefaces: Google Sans Flex (the M3 Expressive brand face, variable weight/width/roundness)
// and Material Symbols Rounded (variable FILL/weight icon font used by <m3e-icon>, see lib/icons.ts).
import '@fontsource-variable/google-sans-flex/full.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// Material 3 Expressive components.
import '@m3e/web/theme';
import '@m3e/web/button';
import '@m3e/web/button-group';
import '@m3e/web/icon';
import './lib/icons'; // before any component renders an icon
import '@m3e/web/icon-button';
import '@m3e/web/toolbar';
import '@m3e/web/card';
import '@m3e/web/shape';
import '@m3e/web/dialog';
import '@m3e/web/tabs';
import '@m3e/web/switch';
import '@m3e/web/segmented-button';
import '@m3e/web/slider';
import '@m3e/web/select';
import '@m3e/web/option';
import '@m3e/web/form-field';
import '@m3e/web/list';
import '@m3e/web/chips';
import '@m3e/web/callout';
import '@m3e/web/loading-indicator';
import '@m3e/web/progress-indicator';
import '@m3e/web/menu';
import '@m3e/web/divider';
import '@m3e/web/snackbar';
import '@m3e/web/fab';
import '@m3e/web/nav-bar';
import '@m3e/web/skeleton';
import '@m3e/web/heading';
import '@m3e/web/date-input';
import '@m3e/web/datepicker';
import '@m3e/web/checkbox';

import './styles/app.css';
import { errorText } from './lib/api';
import { startData } from './lib/data';
import { store } from './lib/store';
import { initTheme } from './lib/theme';
import { initHaptics } from './lib/haptics';
import { initPressFx, openExternal, toast } from './lib/ui';
import './components/sv-app';

// Launched from the iOS home screen (Safari's non-standard flag); see the standalone CSS.
if ((navigator as Navigator & { standalone?: boolean }).standalone) document.documentElement.classList.add('ios-standalone');

// The map has its own context menu; don't stack the browser's on top of it.
document.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('sv-map')) e.preventDefault();
});

// Runtime errors surface as a snackbar (the web app's ErrorReporter), at most once per message per minute.
const recentErrors = new Map<string, number>();
function reportError(err: unknown) {
  console.error('[SkyView]', err);
  const msg = errorText(err) || 'Unknown error';
  const now = Date.now();
  if (now - (recentErrors.get(msg) ?? 0) < 60_000) return;
  recentErrors.set(msg, now);
  toast(`Something went wrong: ${msg.slice(0, 120)}`, 'Report', () =>
    openExternal('https://github.com/arc360alt/StormView-Rewrite/issues'));
}
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
window.addEventListener('error', (e) => reportError(e.error ?? e.message));

(async () => {
  await store.hydrate();
  initTheme();
  initPressFx();
  initHaptics();
  // Press animation style + browser chrome color follow the settings/theme.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const sync = () => {
    const s = store.get();
    document.documentElement.dataset.press = s.pressStyle;
    if (meta && s.tokens.surface) meta.content = s.tokens.surface;
  };
  store.subscribe((s, prev) => {
    if (s.pressStyle !== prev.pressStyle || s.tokens !== prev.tokens) sync();
  });
  sync();
  startData();
})();

// Offline support + notifications on Android (see public/sw.js). Not in dev, where
// a cached app shell would fight Vite's hot reload.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw] registration failed', e));
  });
}
