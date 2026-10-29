# SkyView

Live radar, forecasts and alerts on the web, in Material 3 Expressive. Every color comes from Google's Material You dynamic-color algorithm.

It started as the website from the old Tauri build of StormView (`legacy-tauri`). The Tauri backend is gone. Every service is called straight from the browser, and the features from the native Rust rewrite have been added.

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/ — host it anywhere
```

## Layouts

- **Desktop**: the full-screen map, a floating weather sidebar, a toolbar, and the radar scrubber.
- **Phone** (narrower than 760 px): a scrollable home page with a live radar preview card, a full-screen radar view with a Back button, and an M3 bottom navigation bar (Home, Radar, Settings). You can turn it off under Settings → Display → Layout → Phone layout.

## Apps & install

**Get the apps** opens from the desktop toolbar or the Settings header. It links to the latest releases of the native apps for Windows/Linux, macOS and Android. For iPhone and iPad it shows how to add SkyView to the Home Screen.

The site is installable. `public/icons/` holds opaque PNG icons, which iOS needs because it ignores SVG and transparency: `apple-touch-icon.png` (180 px) for iOS, plus regular and maskable icons for Android/Chrome. To regenerate them from `public/app-icon.svg`, render it with `rsvg-convert` and composite it onto a `#d7e2ff` square.

## Features at a glance

- **Home screen editing:** tap the pencil in the header, or *Edit home screen* at the bottom of the list. Drag sections by their handle, remove them, and use **Add widgets** to open a picker with live previews.
- **Saved places:** tap the location name to open *Places*. Star the current place to save it, then switch between saved places with one tap. The forecasts for the last six places are cached, so switching is instant.
- **New widgets:**
  - *Rain in the Next Hour*: Open-Meteo's 15-minute precipitation, with a plain-language headline.
  - *Temperature Graph*: 24 hours of temperature and feels-like, with rain chance shown as a separate strip.
  - *Wind & Gusts*: speed, gusts and direction for 24 hours.
  - *Historical Climate*: normals and records since 1991 from Open-Meteo's ERA5 archive. It's about 360 KB, fetched once a month per place, and only the condensed table is stored.
- **Lightning:** live strikes from the last 15 minutes, from the Blitzortung.org community network (toolbar ⚡ or Settings → Radar). The connection is only open while the layer is on and the tab is visible.
- **Seasonal scenes:** petals in spring, light motes and fireflies in summer, falling leaves in fall, and icicles with frost sparkle in winter. Winter never uses falling snow, so it doesn't look like it's snowing. Set it under Settings → Display → Weather scene; Automatic follows the date and your hemisphere.
- **Haptics:** a light tick on presses, a firmer one for toggles, double pulses for confirmations, and ticks while dragging or scrubbing. Android uses the Vibration API; iOS 18+ uses the system switch haptic. Turn it off in Settings → Display → Touch.
- **Offline:** `public/sw.js` caches the app, and the last forecast is kept locally, so the installed app opens with no connection and says how old the data is. The service worker also delivers notifications on Android.
- **Rain starting soon:** with notifications on, you get one heads-up per rain event when rain or snow is due within 45 minutes.

## Data

Open-Meteo (forecast, air quality, seasonal), the NWS (forecast, alerts, warning polygons), Nominatim (search), ipwho.is / ipapi.co (approximate location), and LibreWXR (radar). They all allow cross-origin requests, so the site needs no server. All of these calls live in `src/lib/providers.ts`.

Settings are saved in `localStorage`. Notifications use the browser Notification API and are checked every 90 seconds while a tab is open.

The assistant can run against Ollama or an OpenAI-compatible server on your machine. Start Ollama with `OLLAMA_ORIGINS="*" ollama serve` so the site can reach it. It can also run in the browser with WebGPU.

## Radar renderer (WebAssembly)

By default, LibreWXR radar is rendered on the device (Settings → Radar → Rendering → Device). A worker in [`src/radar-wasm/`](src/radar-wasm/) handles it:

1. Fetches raw reflectivity tiles (color scheme 255, no server smoothing). These are about 5× smaller, and one download serves every color scheme.
2. Decodes the PNG and colors and smooths it in WebAssembly (`radar.c`). The smoothing matches LibreWXR's own Gaussian blur, stitched across neighbouring tiles.
3. Passes the finished `ImageBitmap` to MapLibre through a `wxr://` protocol.

Raw tiles are cached in the worker, so changing the color scheme or smoothing, or replaying frames, needs no new downloads.

The server renderer is used when storm arrows are on (the server draws them), when the browser lacks WebAssembly SIMD, or when you pick it. Snow only gets snow colors with server tiles.

**Rebuilding `radar.wasm`**: `scripts/build-radar-wasm.mjs` compiles `radar.c` with clang (wasm32 + SIMD) and swaps the result into place. It rebuilds only when the source's hash differs from `radar.wasm.sha256`. It runs before `npm run dev` / `npm run build`, and the dev server re-runs it (and reloads the page) whenever you save `radar.c`. Use `npm run build:wasm` to force a rebuild. It needs `clang` and `lld`; without them, the committed `radar.wasm` is used. `npm run gen:radar-colors` regenerates `colorTables.ts` from LibreWXR's color table.

## Icon font

Icons are **Material Symbols Rounded**, drawn as **SVG** rather than font text. Font glyphs are positioned by each platform's text engine, and iOS drew every icon slightly up and to the left. An SVG fills its box exactly everywhere.

`scripts/build-icon-font.py` scans `src/` for icon names. It extracts each icon's outlined and filled shapes from the font into `src/assets/icons/material-symbols-rounded.json`, which `src/lib/icons.ts` registers with `<m3e-icon>`. It also writes a cut-down font, `src/assets/fonts/material-symbols-rounded.woff2` (about 190 KB instead of 5.3 MB), as a fallback for any icon that isn't registered.

`src/lib/icons.ts` also makes `<m3e-icon>` default to Rounded. The component otherwise defaults to "Outlined", which only works on machines that have that font installed.

The script rebuilds both files whenever a new icon name appears in `src/`. It runs before `npm run dev` / `npm run build`, and the dev server re-runs it when you save a file. Use `npm run build:icons` to force a rebuild. It needs fontTools and the `woff2` tools (`pacman -S python-fonttools woff2`); without them the committed font is kept.

## Keyboard

`Ctrl+,` or `F2` opens settings. `F3` / `Ctrl+Tab` moves to the next settings tab. `Space` plays or pauses the radar. `←` / `→` step through radar frames. `+` / `-` zoom. `Esc` closes panels. Right-click or long-press the map for the context menu.

## Layout

- `src/lib/providers.ts`: every network call (ported from the Rust backend)
- `src/lib/api.ts`, `data.ts`, `store.ts`, `theme.ts`: data, polling, notifications, settings, Material You
- `src/components/sv-app.ts`: the desktop and phone shells
- `src/components/sv-scene.ts`: the animated weather scene behind the temperature
- `src/components/sv-radar-preview.ts`: the phone layout's live radar card
- `src/components/sv-map.ts`: the MapLibre map, radar, AQI overlay and alert polygons
- `src/styles/app.css`: all styles, built on the `--md-sys-color-*` roles
