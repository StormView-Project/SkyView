import * as maplibregl from 'maplibre-gl';

/**
 * Main-thread side of the WebAssembly radar renderer: one shared worker
 * (radarWorker.ts) plus a `wxr://` MapLibre protocol that hands its rendered
 * ImageBitmaps straight to the map (no re-encode, no main-thread pixel work).
 *
 * URL shape: wxr://<scheme>/<smooth 0|1>/<raw tile URL without https://>
 * where the raw URL is a LibreWXR scheme-255 (raw reflectivity) tile.
 */

export const PROTOCOL = 'wxr';

type Pending = { resolve: (b: ImageBitmap | null) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let failed = false;
let registered = false;
let nextId = 1;
const pending = new Map<number, Pending>();
const failureListeners = new Set<() => void>();

/** Feature check: everything the worker path needs, including wasm SIMD. */
export const radarWasmSupported = (() => {
  try {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' ||
      typeof DecompressionStream === 'undefined' || typeof createImageBitmap === 'undefined' ||
      typeof OffscreenCanvas === 'undefined') return false;
    // Smallest module using a v128 instruction: (func (result v128) v128.const 0)
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0,
      253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
    ]));
  } catch {
    return false;
  }
})();

export function isRadarWasmAvailable() {
  return radarWasmSupported && !failed;
}

/** Called once if the worker can't start; callers switch to server tiles. */
export function onRadarWasmFailure(cb: () => void) {
  failureListeners.add(cb);
  return () => failureListeners.delete(cb);
}

function fail(message: string) {
  if (failed) return;
  failed = true;
  console.error(`Radar: WebAssembly renderer unavailable, using server tiles (${message})`);
  pending.forEach(({ reject }) => reject(new Error(message)));
  pending.clear();
  worker?.terminate();
  worker = null;
  failureListeners.forEach((cb) => cb());
}

function getWorker() {
  if (!worker && !failed) {
    worker = new Worker(new URL('./radarWorker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => fail(e.message || 'worker error');
    worker.onmessage = ({ data }) => {
      if (data.type === 'failed') return fail(data.message);
      const req = pending.get(data.id);
      if (!req) {
        data.bitmap?.close();
        return;
      }
      pending.delete(data.id);
      if (data.type === 'tile') req.resolve(data.bitmap);
      else if (data.type === 'error') req.reject(new Error(data.message));
    };
  }
  return worker;
}

/** The raw (scheme 255, unsmoothed, no snow mask) tile template for a LibreWXR frame. */
export function rawTileTemplate(host: string, path: string, size: number) {
  return `${host}${path}/${size}/{z}/{x}/{y}/255/0_0.png`;
}

/** A MapLibre tile URL that renders `rawTemplate` on-device. */
export function wasmTileUrl(rawTemplate: string, scheme: number, smooth: boolean) {
  return `${PROTOCOL}://${scheme}/${smooth ? 1 : 0}/${rawTemplate.replace(/^https?:\/\//, '')}`;
}

const URL_RE = /^wxr:\/\/(\d+)\/([01])\/(.+)\/(\d+)\/(\d+)\/(\d+)\/255\/0_0\.png$/;

let blank: Promise<ImageBitmap> | null = null;
/** Fully transparent tile. MapLibre stretches it, so 1×1 is enough. */
const transparent = () => (blank ??= createImageBitmap(new ImageData(1, 1)));

/** Registers the `wxr://` protocol with MapLibre (once). */
export function registerRadarProtocol() {
  if (registered || !radarWasmSupported) return;
  registered = true;
  maplibregl.addProtocol(PROTOCOL, (params, abort) => {
    const m = URL_RE.exec(params.url);
    if (!m) return Promise.reject(new Error(`bad radar URL ${params.url}`));
    const [, scheme, smooth, base, z, x, y] = m;
    const w = getWorker();
    if (!w) return Promise.reject(new Error('WebAssembly renderer unavailable'));
    const id = nextId++;
    return new Promise<ImageBitmap | null>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      abort.signal.addEventListener('abort', () => {
        if (!pending.delete(id)) return;
        worker?.postMessage({ type: 'cancel', id });
        reject(new DOMException('Aborted', 'AbortError'));
      });
      w.postMessage({
        type: 'render', id, template: `https://${base}/{z}/{x}/{y}/255/0_0.png`,
        z: Number(z), x: Number(x), y: Number(y), scheme: Number(scheme), smooth: smooth === '1',
      });
    }).then(async (bitmap) => {
      // Fresh copy of the blank bitmap per tile, since MapLibre may release what it's given.
      const data = bitmap ?? (await createImageBitmap(await transparent()));
      return { data };
    });
  });
}
