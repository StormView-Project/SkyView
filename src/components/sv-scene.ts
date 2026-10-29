import { html } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { argbFromHex, Blend, Hct, hexFromArgb } from '@material/material-color-utilities';
import { weatherVisual } from '../lib/format';
import { $ } from '../lib/store';
import { SvElement } from '../lib/ui';

/*
 * Animated weather scene behind the hero (like the Pixel Weather app): sun,
 * moon and stars, drifting clouds, rain, snow, hail, fog and lightning. Every
 * color is an HCT tone of a hue harmonized toward the theme's primary, so the
 * scene follows the Material You scheme in light and dark mode.
 */

const SUN = '#f2b705';
const RAIN = '#4f8ef5';
const NIGHT = '#5b5bd6';
const FPS = 30;
/** The scene is laid out for a hero at least this wide; narrower heroes scale it down. */
const DESIGN_WIDTH = 360;

type Kind =
  | 'clear-day' | 'clear-night' | 'partly-day' | 'partly-night' | 'cloudy' | 'fog'
  | 'rain' | 'sleet' | 'snow' | 'storm' | 'hail';

interface SceneInfo {
  kind: Kind;
  intensity: number;
  wind: number;
  skyTop: string;
  skyBottom: string;
  sun: string;
  glow: string;
  moon: string;
  cloud: string;
  cloudBack: string;
  drop: string;
  flake: string;
  star: string;
  bolt: string;
}

/** (kind, intensity 0..1) for a WMO code. */
function kindOf(code: number, isDay: boolean): [Kind, number] {
  const sky = (d: Kind, n: Kind) => (isDay ? d : n);
  switch (code) {
    case 0: return [sky('clear-day', 'clear-night'), 0];
    case 1: return [sky('clear-day', 'clear-night'), 0.3];
    case 2: return [sky('partly-day', 'partly-night'), 0.5];
    case 3: return ['cloudy', 0.6];
    case 45: case 48: return ['fog', 0.7];
    case 51: case 53: case 55: return ['rain', 0.2];
    case 56: case 57: case 66: case 67: return ['sleet', 0.5];
    case 61: case 80: return ['rain', 0.45];
    case 63: case 81: return ['rain', 0.7];
    case 65: case 82: return ['rain', 1];
    case 71: case 85: return ['snow', 0.4];
    case 73: case 77: return ['snow', 0.65];
    case 75: case 86: return ['snow', 1];
    case 95: return ['storm', 0.8];
    case 96: case 99: return ['hail', 0.9];
    default: return ['cloudy', 0.5];
  }
}

function sceneInfo(code: number, isDay: boolean, windMph: number, primary: string, dark: boolean): SceneInfo {
  const [kind, intensity] = kindOf(code, isDay);
  const hue = (hex: string) => Hct.fromInt(Blend.harmonize(argbFromHex(hex), argbFromHex(primary))).hue;
  const c = (h: number, chroma: number, tone: number) => hexFromArgb(Hct.from(h, chroma, tone).toInt());
  const alpha = (hex: string, a: number) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
  const gloomy = kind === 'storm' || kind === 'hail' || (kind === 'rain' && intensity > 0.6);
  const night = !isDay;
  const skyHue = night ? hue(NIGHT) : kind === 'clear-day' || kind === 'partly-day' ? hue(RAIN) : hue(weatherVisual(code, isDay).hue);
  const skyChroma = gloomy || kind === 'fog' ? 10 : kind === 'cloudy' || kind === 'snow' || kind === 'sleet' ? 16 : 32;
  const [top, bottom] =
    dark ? (gloomy ? [20, 14] : night ? [22, 14] : [34, 20])
      : gloomy ? [72, 86] : night ? [70, 88] : kind === 'snow' || kind === 'sleet' ? [74, 86] : [84, 95];
  const [front, back] =
    dark ? (gloomy ? [34, 26] : [night ? 40 : 52, night ? 32 : 44])
      : gloomy ? [58, 50] : [99, 92];
  return {
    kind,
    intensity,
    wind: Math.max(0, Math.min(1, windMph / 30)),
    skyTop: c(skyHue, skyChroma, top),
    skyBottom: c(skyHue, skyChroma * 0.6, bottom),
    sun: c(hue(SUN), 70, dark ? 82 : 80),
    glow: alpha(c(hue(SUN), 50, dark ? 70 : 90), 0.45),
    moon: c(hue(SUN), 12, 94),
    cloud: c(skyHue, 6, front),
    cloudBack: c(skyHue, 8, back),
    drop: c(hue(RAIN), 48, dark ? 76 : gloomy ? 30 : 52),
    flake: c(skyHue, 4, dark ? 96 : 99),
    star: c(hue(SUN), 8, 96),
    bolt: c(hue(SUN), 80, 88),
  };
}

/* ------------------------------------------------------------- drawing */

const DEG = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * DEG);

/** Cheap deterministic hash in [0, 1). */
function hash(n: number) {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}
const fade = (p: number) => Math.min(1, p * 8) * Math.min(1, (1 - p) * 4);
const fract = (v: number) => v - Math.floor(v);

/** M3 "sunny" silhouette in a 100×100 box. */
const SUNNY = (() => {
  const p = new Path2D();
  for (let i = 0; i <= 180; i++) {
    const th = (i / 180) * Math.PI * 2;
    const r = 50 * (0.9 + 0.1 * Math.cos(8 * th));
    const x = 50 + r * Math.cos(th - Math.PI / 2), y = 50 + r * Math.sin(th - Math.PI / 2);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
})();
const CRESCENT = new Path2D('M 72 12 A 44 44 0 1 0 72 88 A 40 40 0 0 1 72 12 Z');
const BOLT = new Path2D('M 22 0 L 4 44 L 18 44 L 10 80 L 36 30 L 22 30 L 30 0 Z');

/** Flat cloud: one opaque color, so the overlapping circles read as one shape. */
function cloud(g: CanvasRenderingContext2D, x: number, y: number, w: number, fill: string) {
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x, y + w * 0.3, w, w * 0.26, w * 0.13);
  for (const [cx, cy, d] of [[0.11, 0.13, 0.34], [0.31, 0.01, 0.48], [0.64, 0.19, 0.28]]) {
    g.moveTo(x + w * (cx + d), y + w * (cy + d / 2));
    g.arc(x + w * (cx + d / 2), y + w * (cy + d / 2), (w * d) / 2, 0, Math.PI * 2);
  }
  g.fill();
}

function radial(g: CanvasRenderingContext2D, cx: number, cy: number, size: number, stops: [number, string][]) {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(cx - size / 2, cy - size / 2, size, size);
}

const withAlpha = (hex: string, a: number) => hex.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, '0');

function draw(g: CanvasRenderingContext2D, W: number, H: number, s: SceneInfo, t: number) {
  const k = s.kind;
  const sunny = k === 'clear-day' || k === 'partly-day';
  const moony = k === 'clear-night' || k === 'partly-night';
  const partly = k === 'partly-day' || k === 'partly-night';
  const overcast = ['cloudy', 'rain', 'snow', 'sleet', 'storm', 'hail'].includes(k);
  const wet = ['rain', 'sleet', 'storm', 'hail'].includes(k);
  const icy = k === 'snow' || k === 'sleet';
  const drops = !wet ? 0 : k === 'storm' ? 36 : k === 'sleet' ? 14 : k === 'hail' ? 12 : Math.round(10 + 28 * s.intensity);
  const flakes = k === 'snow' ? Math.round(14 + 22 * s.intensity) : k === 'sleet' ? 12 : 0;
  const pellets = k === 'hail' ? 18 : 0;
  // Precipitation falls from under the clouds on the right.
  const px0 = W - 236, pw = 210, py0 = 96;
  // Lightning: a double flash every 5.5 s.
  const ph = t % 5.5;
  const flash = k === 'storm' && (ph < 0.09 || (ph > 0.2 && ph < 0.3));

  g.clearRect(0, 0, W, H);

  if (moony) {
    g.fillStyle = s.star;
    for (let i = 0; i < 16; i++) {
      const u = hash(i + 1.7), v = hash(i + 9.1);
      const d = 2 + 2 * hash(i + 4.4);
      g.globalAlpha = 0.25 + 0.75 * (0.5 + 0.5 * sin(t * (40 + 60 * v) + u * 360));
      g.beginPath();
      g.arc(W * (0.3 + 0.68 * u) + d / 2, H * 0.75 * v + d / 2, d / 2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  if (sunny) {
    const cx = W - (partly ? 92 : 78), cy = partly ? 56 : 70, size = partly ? 72 : 92;
    const halo = size * 2.4 + 18 * sin(t * 60);
    radial(g, cx, cy, halo, [[0, s.glow], [0.3, s.glow], [0.7, withAlpha(s.glow, 0)], [1, withAlpha(s.glow, 0)]]);
    g.save();
    g.translate(cx, cy);
    g.rotate(t * 10 * DEG);
    g.scale(size / 100, size / 100);
    g.translate(-50, -50);
    g.fillStyle = s.sun;
    g.fill(SUNNY);
    g.restore();
  }

  if (moony) {
    const cx = W - (partly ? 96 : 80), cy = (partly ? 54 : 66) + 4 * sin(t * 30);
    radial(g, cx, cy, 170 + 12 * sin(t * 45), [[0, withAlpha(s.moon, 0.2)], [0.65, withAlpha(s.moon, 0)], [1, withAlpha(s.moon, 0)]]);
    const size = partly ? 60 : 72;
    g.save();
    g.translate(cx, cy);
    g.rotate(-18 * DEG);
    g.scale(size / 100, size / 100);
    g.translate(-50, -50);
    g.fillStyle = s.moon;
    g.fill(CRESCENT);
    g.restore();
  }

  if (partly) cloud(g, W - 92 + 6 * sin(t * 16 + 200), 92, 84, s.cloudBack);
  if (overcast) cloud(g, W - 140 + 9 * sin(t * 14), 20 + 2 * sin(t * 25), 124, s.cloudBack);

  if (drops > 0) {
    g.fillStyle = s.drop;
    const fall = H - py0 + 24, len = 8 + 10 * s.intensity;
    for (let i = 0; i < drops; i++) {
      const u = hash(i + 0.31), v = hash(i + 7.77);
      const p = fract(t / (0.85 - 0.35 * s.intensity + 0.3 * v) + u);
      const x = px0 + pw * hash(i + 3.3) + s.wind * 0.5 * fall * p;
      const y = py0 + fall * p - len;
      g.globalAlpha = fade(p) * (0.6 + 0.4 * v);
      g.save();
      g.translate(x + 1.25, y + len / 2);
      g.rotate(-26 * s.wind * DEG);
      g.beginPath();
      g.roundRect(-1.25, -len / 2, 2.5, len, 1.25);
      g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
  }
  if (flakes > 0) {
    g.fillStyle = s.flake;
    const fall = H - py0 + 16;
    for (let i = 0; i < flakes; i++) {
      const u = hash(i + 2.13), v = hash(i + 5.71);
      const p = fract(t / (5.5 - 2.2 * s.intensity + 2 * v) + u);
      const d = 3 + 4 * v;
      const x = px0 + pw * hash(i + 8.8) + 9 * sin(t * (70 + 50 * u) + v * 360) + s.wind * 0.4 * fall * p;
      const y = py0 + fall * p - d;
      g.globalAlpha = fade(p);
      g.beginPath();
      g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  if (pellets > 0) {
    g.fillStyle = s.flake;
    const fall = H - py0 + 12;
    for (let i = 0; i < pellets; i++) {
      const p = fract(t / (0.55 + 0.25 * hash(i + 6.6)) + hash(i + 4.04));
      const x = px0 + pw * hash(i + 1.1) + s.wind * 0.3 * fall * p;
      const y = py0 + fall * p - 5;
      g.globalAlpha = fade(p);
      g.beginPath();
      g.arc(x + 2.5, y + 2.5, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  if (flash) {
    g.save();
    g.translate(W - 150, 104);
    g.scale(30 / 40, 60 / 80);
    g.fillStyle = s.bolt;
    g.fill(BOLT);
    g.restore();
  }

  if (partly) cloud(g, W - 186 + 8 * sin(t * 12), 66 + 2 * sin(t * 22 + 40), 122, s.cloud);
  if (overcast) cloud(g, W - 222 + 11 * sin(t * 11 + 120), 46 + 2 * sin(t * 20 + 90), 156, s.cloud);
  if (overcast && !wet && !icy) cloud(g, W - 96 + 6 * sin(t * 17 + 220), 84 + 2 * sin(t * 24), 82, s.cloud);

  if (k === 'fog') {
    for (let i = 0; i < 10; i++) {
      const u = hash(i + 3.9), v = hash(i + 6.2);
      const size = 150 + 90 * v;
      const cx = W * (0.18 + 0.72 * u) + 30 * sin(t * (7 + 6 * v) + i * 70);
      const cy = H * (0.1 + 0.8 * hash(i + 2.5));
      g.globalAlpha = 0.7 + 0.3 * sin(t * 18 + i * 50);
      radial(g, cx, cy, size, [[0, withAlpha(s.cloud, 0.7)], [0.68, withAlpha(s.cloud, 0)], [1, withAlpha(s.cloud, 0)]]);
    }
    g.globalAlpha = 1;
  }

  // The flash lights the whole sky for an instant.
  if (flash) {
    g.fillStyle = 'rgb(255 255 255 / 0.18)';
    g.fillRect(0, 0, W, H);
  }
}

/* ------------------------------------------------------------- element */

/* ------------------------------------------------------------ seasons */

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

/** The season for a setting value: 'auto' follows the date and hemisphere. */
export function resolveSeason(setting: string, lat: number | undefined, date = new Date()): Season | null {
  if (setting === 'off') return null;
  if (setting !== 'auto') return setting as Season;
  const seasons: Season[] = ['winter', 'spring', 'summer', 'fall'];
  let i = Math.floor(((date.getMonth() + 1) % 12) / 3); // Dec–Feb = 0 (northern winter)
  if ((lat ?? 0) < 0) i = (i + 2) % 4; // southern hemisphere: opposite seasons
  return seasons[i];
}

interface SeasonPalette {
  petal: string; petalDark: string;
  leaves: string[];
  firefly: string; mote: string;
  ice: string; iceEdge: string; glint: string; frost: string;
}

function seasonPalette(primary: string, dark: boolean): SeasonPalette {
  const hue = (hex: string) => Hct.fromInt(Blend.harmonize(argbFromHex(hex), argbFromHex(primary))).hue;
  const c = (hex: string, chroma: number, tone: number) => hexFromArgb(Hct.from(hue(hex), chroma, tone).toInt());
  return {
    petal: c('#f6a6c1', 40, dark ? 82 : 88),
    petalDark: c('#f6a6c1', 50, dark ? 70 : 76),
    leaves: [c('#e8590c', 70, dark ? 62 : 58), c('#c92a2a', 64, dark ? 56 : 50), c('#f59f00', 72, dark ? 72 : 70), c('#a0522d', 44, dark ? 52 : 46)],
    firefly: c('#d8f36a', 70, 90),
    mote: c('#ffb84d', dark ? 40 : 60, dark ? 86 : 74),
    ice: c('#bfe6ff', 18, dark ? 86 : 96),
    iceEdge: c('#bfe6ff', 26, dark ? 66 : 78),
    glint: '#ffffff',
    frost: c('#dff3ff', 12, dark ? 94 : 99),
  };
}

const LEAF = new Path2D('M 0 -10 C 7 -6 8 4 0 10 C -8 4 -7 -6 0 -10 Z M 0 10 L 0 14');
const SPARKLE = new Path2D('M 0 -5 L 1.2 -1.2 L 5 0 L 1.2 1.2 L 0 5 L -1.2 1.2 L -5 0 L -1.2 -1.2 Z');

/** The seasonal layer, drawn over the weather. Subtle on purpose: it's decoration. */
function drawSeason(g: CanvasRenderingContext2D, W: number, H: number, season: Season, night: boolean, wind: number, t: number, p: SeasonPalette) {
  if (season === 'spring') {
    // Cherry blossom petals flutter down and across with the wind.
    for (let i = 0; i < 14; i++) {
      const u = hash(i + 11.3), v = hash(i + 4.9);
      const period = 9 + 6 * v;
      const q = fract(t / period + u);
      // Kept to the right of the temperature so the numbers are never covered.
      const x = W * 0.42 + ((u * W * 0.7 + q * W * (0.2 + wind * 0.3) + 14 * sin(t * (50 + 30 * v) + i * 40)) % (W * 0.6 + 20)) - 10;
      const y = -12 + q * (H + 24);
      g.save();
      g.globalAlpha = 0.85 * fade(q);
      g.translate(x, y);
      g.rotate((t * (60 + 80 * v) + i * 47) * DEG);
      g.scale(Math.cos((t * (120 + 90 * u) + i * 30) * DEG), 1); // flutter
      g.fillStyle = i % 3 ? p.petal : p.petalDark;
      g.beginPath();
      g.ellipse(0, 0, 4.5, 2.6, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  } else if (season === 'summer') {
    if (night) {
      // Fireflies wander and pulse.
      for (let i = 0; i < 12; i++) {
        const u = hash(i + 2.2), v = hash(i + 8.8);
        const x = W * (0.45 + 0.5 * u) + 22 * sin(t * (9 + 7 * v) + i * 60) + 10 * sin(t * 23 + i * 13);
        const y = H * (0.35 + 0.55 * v) + 14 * sin(t * (11 + 6 * u) + i * 90);
        const glow = Math.max(0, sin(t * (70 + 50 * u) + i * 77)) ** 2;
        if (glow < 0.02) continue;
        radial(g, x, y, 22, [[0, withAlpha(p.firefly, 0.55 * glow)], [1, withAlpha(p.firefly, 0)]]);
        g.globalAlpha = glow;
        g.fillStyle = p.firefly;
        g.beginPath();
        g.arc(x, y, 1.8, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
    } else {
      // Warm motes of light drift slowly upward.
      for (let i = 0; i < 14; i++) {
        const u = hash(i + 6.1), v = hash(i + 1.4);
        const q = fract(t / (14 + 8 * v) + u);
        const x = W * (0.45 + 0.52 * u) + 10 * sin(t * 15 + i * 50);
        const y = H * (1.05 - q * 1.1);
        g.globalAlpha = 0.85 * fade(q) * (0.6 + 0.4 * sin(t * 40 + i * 30));
        radial(g, x, y, 14, [[0, p.mote], [0.35, withAlpha(p.mote, 0.6)], [1, withAlpha(p.mote, 0)]]);
      }
      g.globalAlpha = 1;
    }
  } else if (season === 'fall') {
    // Leaves tumble down, swaying side to side.
    for (let i = 0; i < 10; i++) {
      const u = hash(i + 3.7), v = hash(i + 9.4);
      const period = 10 + 7 * v;
      const q = fract(t / period + u);
      const x = W * 0.42 + ((W * 0.6 * u + q * W * wind * 0.3 + 26 * sin(t * (28 + 20 * v) + i * 70)) % (W * 0.6 + 20)) - 10;
      const y = -16 + q * (H + 32);
      const size = 0.75 + 0.5 * v;
      g.save();
      g.globalAlpha = 0.9 * fade(q);
      g.translate(x, y);
      g.rotate((40 * sin(t * (40 + 30 * u) + i * 50) + i * 37) * DEG);
      g.scale(size * Math.cos((t * (80 + 60 * v) + i * 25) * DEG), size); // 3D tumble
      g.fillStyle = p.leaves[i % p.leaves.length];
      g.strokeStyle = p.leaves[(i + 3) % p.leaves.length];
      g.lineWidth = 1;
      g.fill(LEAF);
      g.stroke(LEAF);
      g.restore();
    }
  } else if (season === 'winter') {
    // Frosted corners — winter without implying snowfall.
    radial(g, 0, 0, Math.min(W, H) * 0.9, [[0, withAlpha(p.frost, 0.32)], [0.6, withAlpha(p.frost, 0.08)], [1, withAlpha(p.frost, 0)]]);
    radial(g, W, H, Math.min(W, H) * 0.8, [[0, withAlpha(p.frost, 0.22)], [0.6, withAlpha(p.frost, 0.05)], [1, withAlpha(p.frost, 0)]]);
    // Icicles along the top edge, with glints sliding down and the odd drip.
    const n = Math.max(8, Math.round(W / 26));
    for (let i = 0; i < n; i++) {
      const u = hash(i + 5.5), v = hash(i + 7.3);
      const x = (i + 0.5) * (W / n) + (u - 0.5) * 8;
      const len = 10 + 26 * v * v;
      const w = 4 + 4 * u;
      const grad = g.createLinearGradient(x, 0, x, len);
      grad.addColorStop(0, withAlpha(p.ice, 0.95));
      grad.addColorStop(1, withAlpha(p.iceEdge, 0.7));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x - w / 2, 0);
      g.quadraticCurveTo(x - w / 4, len * 0.6, x, len);
      g.quadraticCurveTo(x + w / 4, len * 0.6, x + w / 2, 0);
      g.closePath();
      g.fill();
      // Glint sliding down every few seconds.
      const gq = fract(t / (3.5 + 3 * u) + v);
      if (gq < 0.4) {
        const gy = (gq / 0.4) * len * 0.85;
        g.globalAlpha = Math.sin((gq / 0.4) * Math.PI) * 0.9;
        g.fillStyle = p.glint;
        g.beginPath();
        g.ellipse(x - w * 0.12, gy, 0.9, 2.4, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
      // A drip now and then from the longer ones.
      if (len > 24) {
        const dq = fract(t / (6 + 5 * u) + u);
        if (dq < 0.25) {
          const dy = len + (dq / 0.25) ** 2 * (H - len) * 0.5;
          g.globalAlpha = 1 - dq / 0.25;
          g.fillStyle = p.iceEdge;
          g.beginPath();
          g.ellipse(x, dy, 1.4, 2.2, 0, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 1;
        }
      }
    }
    // Frost sparkles twinkling low in the scene.
    for (let i = 0; i < 10; i++) {
      const u = hash(i + 12.1), v = hash(i + 3.3);
      const tw = Math.max(0, sin(t * (45 + 40 * v) + i * 63)) ** 3;
      if (tw < 0.05) continue;
      g.save();
      g.globalAlpha = tw;
      g.translate(W * (0.04 + 0.92 * u), H * (0.62 + 0.34 * v));
      g.rotate((t * 20 + i * 30) * DEG);
      g.scale(0.6 + 0.6 * tw, 0.6 + 0.6 * tw);
      g.fillStyle = p.glint;
      g.fill(SPARKLE);
      g.restore();
    }
  }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

@customElement('sv-scene')
export class SvScene extends SvElement {
  @property({ type: Number }) code = 0;
  @property({ type: Boolean }) day = true;
  @property({ type: Number }) windMph = 0;
  /** Changes whenever the theme does, so colors are recomputed. */
  @property({ attribute: false }) tokens: Record<string, string> = {};
  /** Seasonal touches layered over the weather, or null for none. */
  @property({ attribute: false }) season: Season | null = null;
  private palette: SeasonPalette | null = null;

  @query('canvas') private canvas!: HTMLCanvasElement;
  private info: SceneInfo | null = null;
  private raf = 0;
  private last = 0;
  private start = performance.now();
  private visible = true;
  private io?: IntersectionObserver;
  private ro?: ResizeObserver;

  render() {
    const s = this.info;
    return html`<canvas
      aria-hidden="true"
      style=${s ? `background:linear-gradient(200deg, ${s.skyTop} 0%, ${s.skyBottom} 100%)` : ''}
    ></canvas>`;
  }

  willUpdate() {
    this.info = sceneInfo(this.code, this.day, this.windMph, $().tokens.primary ?? '#4f8ef5', $().isDark);
    this.palette = this.season ? seasonPalette($().tokens.primary ?? '#4f8ef5', $().isDark) : null;
  }

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this.io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.loop();
    });
    this.io.observe(this);
    document.addEventListener('visibilitychange', this.loop);
    this.resize();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.io?.disconnect();
    document.removeEventListener('visibilitychange', this.loop);
  }

  updated() {
    this.frame(true);
  }

  private resize() {
    const r = this.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.frame(true);
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (this.visible && !document.hidden && !reducedMotion.matches) this.raf = requestAnimationFrame(this.tick);
  };

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (now - this.last < 1000 / FPS - 2) return;
    this.last = now;
    this.frame();
  };

  private frame(force = false) {
    if (!this.canvas || !this.info) return;
    if (force) this.loop();
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const dpr = this.canvas.width / Math.max(1, this.getBoundingClientRect().width);
    const cssW = this.canvas.width / dpr, cssH = this.canvas.height / dpr;
    // On narrow phones (or with Display Zoom) the sun and clouds would run into the
    // temperature; shrink the whole scene uniformly instead.
    const k = Math.min(1, cssW / DESIGN_WIDTH);
    g.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    const t = reducedMotion.matches ? 2 : (performance.now() - this.start) / 1000;
    draw(g, cssW / k, cssH / k, this.info, t);
    if (this.season && this.palette) drawSeason(g, cssW / k, cssH / k, this.season, !this.day, this.info.wind, t, this.palette);
  }
}
