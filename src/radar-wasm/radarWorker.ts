/**
 * Radar tile worker: fetches raw LibreWXR tiles, decodes + renders them with
 * WebAssembly (radarCore.ts), and posts back ready-to-draw ImageBitmaps.
 *
 * Raw tiles are cached here by URL, independent of color scheme and smoothing,
 * so switching schemes or replaying frames re-renders locally with no network
 * traffic.
 *
 * Messages in:   { type: 'render', id, template, z, x, y, scheme, smooth }
 *                { type: 'cancel', id }
 * Messages out:  { type: 'ready' } | { type: 'failed', message }
 *                { type: 'tile', id, bitmap }   (bitmap null = transparent)
 *                { type: 'error', id, message }
 */
import wasmUrl from './radar.wasm?url';
import { blurRadiusFor, createRadarCore, EMPTY, type RadarCore, type RawTile } from './radarCore';

interface RenderMsg {
  type: 'render';
  id: number;
  template: string;
  z: number;
  x: number;
  y: number;
  scheme: number;
  smooth: boolean;
}
type InMsg = RenderMsg | { type: 'cancel'; id: number };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
};

const CACHE_BUDGET = 64 * 1024 * 1024; // decoded raw values, bytes

let core: RadarCore | null = null;
const coreReady = (async () => {
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl)));
  } catch {
    // Some hosts serve .wasm without application/wasm; compile from bytes instead.
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes));
  }
  core = createRadarCore(instance);
})();

coreReady.then(
  () => scope.postMessage({ type: 'ready' }),
  (err) => scope.postMessage({ type: 'failed', message: String(err?.message ?? err) }),
);

/* ---- Raw tile cache: url -> RawTile (LRU by insertion order) ---- */

const cache = new Map<string, RawTile>();
let cacheBytes = 0;

function cacheGet(url: string) {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
  }
  return hit;
}

function cachePut(url: string, tile: RawTile) {
  cache.set(url, tile);
  cacheBytes += tile.values.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_BUDGET) break;
    cache.delete(k);
    cacheBytes -= v.values.length;
  }
}

/* ---- In-flight fetches, shared between requests for the same URL ---- */

interface Inflight {
  promise: Promise<RawTile>;
  controller: AbortController;
  refs: number;
}
const inflight = new Map<string, Inflight>();

async function decodeFallback(blob: Blob): Promise<RawTile> {
  // Interlaced / 16-bit PNGs: let the browser decode, then read the R channel.
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  const values = new Uint8Array(bmp.width * bmp.height);
  let nonzero = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] = rgba[i * 4 + 3] ? rgba[i * 4] : 0;
    if (values[i]) nonzero++;
  }
  return { size: bmp.width, values: nonzero ? values : EMPTY, block: 0 };
}

async function fetchRaw(url: string, signal: AbortSignal): Promise<RawTile> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  await coreReady;
  return (await core!.decode(new Uint8Array(buf))) ?? (await decodeFallback(new Blob([buf])));
}

/** Starts (or joins) the fetch for `url`. `own` requests can cancel it. */
function loadRaw(url: string, own: boolean) {
  const hit = cacheGet(url);
  if (hit) return Promise.resolve(hit);
  let entry = inflight.get(url);
  if (!entry) {
    const controller = new AbortController();
    const e: Inflight = { controller, refs: 0, promise: undefined as unknown as Promise<RawTile> };
    e.promise = fetchRaw(url, controller.signal)
      .then((tile) => {
        cachePut(url, tile);
        return tile;
      })
      .finally(() => {
        if (inflight.get(url) === e) inflight.delete(url);
      });
    inflight.set(url, e);
    entry = e;
  }
  if (own) entry.refs++;
  return entry.promise;
}

function release(url: string) {
  const entry = inflight.get(url);
  if (entry && --entry.refs <= 0) {
    entry.controller.abort();
    inflight.delete(url);
  }
}

/* ---- Rendering ---- */

const tileUrl = (template: string, z: number, x: number, y: number) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Last block-size estimate per zoom, for tiles too sparse to measure. */
const blockByZoom = new Map<number, number>();

/**
 * Value grid for a neighbour: cached -> use it; being fetched (usually by
 * another tile in the same view) -> wait for it; otherwise unknown (null),
 * which edge-replicates. Off the top/bottom of the world it's empty.
 */
async function neighbour(template: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
  const n = 1 << z;
  if (y < 0 || y >= n) return EMPTY;
  const url = tileUrl(template, z, ((x % n) + n) % n, y);
  const hit = cacheGet(url);
  if (hit) return hit.values;
  const pending = inflight.get(url);
  if (!pending) return null;
  try {
    return (await pending.promise).values;
  } catch {
    return null;
  }
}

const live = new Map<number, string>(); // request id -> url

async function render({ id, template, z, x, y, scheme, smooth }: RenderMsg) {
  const url = tileUrl(template, z, x, y);
  live.set(id, url);
  try {
    const tile = await loadRaw(url, true);
    if (!live.has(id)) return;
    if (tile.values === EMPTY) {
      scope.postMessage({ type: 'tile', id, bitmap: null });
      return;
    }

    // Yield once so render messages for neighbouring tiles queued behind this
    // one get to start their fetches; then stitch whatever is available.
    let neighbours: (Uint8Array | null)[] = [null, null, null, null, tile.values, null, null, null, null];
    if (smooth) {
      await new Promise((r) => setTimeout(r, 0));
      const grid: Promise<Uint8Array | null>[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          grid.push(dx || dy ? neighbour(template, z, x + dx, y + dy) : Promise.resolve(tile.values));
        }
      }
      neighbours = await Promise.all(grid);
      if (!live.has(id)) return;
    }

    if (tile.block) blockByZoom.set(z, tile.block);
    const block = tile.block || blockByZoom.get(z) || 1;
    const radius = smooth ? blurRadiusFor(block, tile.size) : 0;
    const rgba = core!.render(neighbours, tile.size, scheme, radius);
    const bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, tile.size, tile.size));
    if (!live.has(id)) {
      bitmap.close();
      return;
    }
    scope.postMessage({ type: 'tile', id, bitmap }, [bitmap]);
  } catch (err) {
    if (live.has(id)) scope.postMessage({ type: 'error', id, message: String((err as Error)?.message ?? err) });
  } finally {
    live.delete(id);
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === 'render') {
    render(data);
  } else if (data.type === 'cancel') {
    const url = live.get(data.id);
    if (url) {
      live.delete(data.id);
      release(url);
    }
  }
};
