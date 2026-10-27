/**
 * WebAssembly-backed decode + render for raw LibreWXR radar tiles.
 * Environment-agnostic (worker or Node) so it can be tested headlessly; the
 * worker in radarWorker.ts adds fetching, caching and messaging.
 */
import { RAIN_COLOR_TABLES } from './colorTables';

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const DEFAULT_SCHEME = 7; // LibreWXR falls back to Rainbow @ Selex SI
const BASE_SMOOTH_RADIUS = 1.0; // LibreWXR settings.smooth_radius default

/** Marker for a neighbour tile known to be fully transparent. */
export const EMPTY = new Uint8Array(0);

/** A decoded raw tile: one value byte per pixel (dBZ = v/2 - 32). `values` is EMPTY when transparent. */
export interface RawTile {
  size: number;
  values: Uint8Array;
  block: number;
}

interface Png {
  w: number;
  h: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  idat: Uint8Array[];
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

interface RadarExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  png_unfilter(data: number, out: number, stride: number, h: number, bpp: number): number;
  png_to_values(scan: number, out: number, w: number, h: number, stride: number, colorType: number, bitDepth: number, map: number): number;
  estimate_block(v: number, w: number, h: number): number;
  build_padded(tiles: number, w: number, pad: number, out: number): void;
  render_tile(vals: number, pw: number, pad: number, lut: number, radius: number, out: number, bufA: number, bufB: number): void;
}

/** Splits a PNG into the chunks we need. Returns null if it isn't a PNG. */
function parsePng(bytes: Uint8Array): Png | null {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png: Png = { w: 0, h: 0, bitDepth: 0, colorType: -1, interlace: 0, idat: [], plte: null, trns: null };
  for (let o = 8; o + 8 <= bytes.length;) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      png.w = dv.getUint32(o + 8);
      png.h = dv.getUint32(o + 12);
      png.bitDepth = data[8];
      png.colorType = data[9];
      png.interlace = data[12];
    } else if (type === 'PLTE') png.plte = data;
    else if (type === 'tRNS') png.trns = data;
    else if (type === 'IDAT') png.idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  return png;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Whether the wasm decoder handles this PNG layout (else use the fallback). */
function decodable(png: Png | null): png is Png {
  if (!png || png.interlace || !png.idat.length || !(png.colorType in CHANNELS)) return false;
  return png.colorType === 0 || png.colorType === 3 ? png.bitDepth <= 8 : png.bitDepth === 8;
}

/** sample -> raw value table for palette / grayscale images */
function sampleMap(png: Png) {
  const map = new Uint8Array(256);
  if (png.colorType === 3 && png.plte) {
    for (let i = 0; i < png.plte.length / 3; i++) {
      const alpha = png.trns && i < png.trns.length ? png.trns[i] : 255;
      map[i] = alpha ? png.plte[i * 3] : 0;
    }
  } else if (png.colorType === 0) {
    const max = (1 << png.bitDepth) - 1;
    const key = png.trns ? (png.trns[0] << 8) | png.trns[1] : -1;
    for (let i = 0; i <= max; i++) map[i] = i === key ? 0 : Math.round((i * 255) / max);
  }
  return map;
}

async function inflate(chunks: Uint8Array[]) {
  // PNG IDAT is a zlib stream, which is what the "deflate" format means here.
  const stream = new Blob(chunks as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Scheme ID -> 256-entry RGBA LUT indexed by raw value (as LibreWXR's get_lut). */
const lutCache = new Map<number, Uint8Array>();
export function lutFor(scheme: number) {
  const id = RAIN_COLOR_TABLES[scheme] ? scheme : DEFAULT_SCHEME;
  let lut = lutCache.get(id);
  if (!lut) {
    const hex = RAIN_COLOR_TABLES[id];
    lut = new Uint8Array(1024);
    for (let v = 0; v < 256; v++) {
      const row = v >> 1;
      for (let c = 0; c < 4; c++) lut[v * 4 + c] = parseInt(hex.substr(row * 8 + c * 2, 2), 16);
    }
    lutCache.set(id, lut);
  }
  return lut;
}

/**
 * LibreWXR's compute_blur_radius(): a quarter of the source-pixel block size,
 * never below the base radius, capped at tile_size / 32.
 */
export function blurRadiusFor(block: number, tileSize: number) {
  return Math.min(BASE_SMOOTH_RADIUS * Math.max(1, block * 0.25), tileSize / 32);
}

export function createRadarCore(instance: WebAssembly.Instance) {
  const wasm = instance.exports as unknown as RadarExports;
  const heapBase = ((wasm.__heap_base.value as number) + 15) & ~15;

  /** Bump-allocates `sizes` from heap base, growing memory as needed. */
  function arena(...sizes: number[]) {
    const ptrs: number[] = [];
    let p = heapBase;
    for (const s of sizes) {
      ptrs.push(p);
      p = (p + s + 15) & ~15;
    }
    const short = p - wasm.memory.buffer.byteLength;
    if (short > 0) wasm.memory.grow(Math.ceil(short / 65536));
    return ptrs;
  }
  const mem = () => new Uint8Array(wasm.memory.buffer);

  return {
    /**
     * Decodes a raw (scheme 255) tile PNG. Returns null when the PNG needs the
     * canvas fallback decoder.
     */
    async decode(bytes: Uint8Array): Promise<RawTile | null> {
      const png = parsePng(bytes);
      if (!decodable(png) || png.w !== png.h) return null;
      const { w, h, colorType, bitDepth } = png;

      const inflated = await inflate(png.idat);
      const stride = Math.ceil((w * CHANNELS[colorType] * bitDepth) / 8);
      if (inflated.length < h * (stride + 1)) throw new Error('truncated PNG data');
      const bpp = Math.max(1, (CHANNELS[colorType] * bitDepth) >> 3);

      const [pData, pScan, pVals, pMap] = arena(inflated.length, h * stride, w * h, 256);
      mem().set(inflated, pData);
      mem().set(sampleMap(png), pMap);
      if (wasm.png_unfilter(pData, pScan, stride, h, bpp) !== 0) throw new Error('bad PNG filter');
      const nonzero = wasm.png_to_values(pScan, pVals, w, h, stride, colorType, bitDepth, pMap);
      if (!nonzero) return { size: w, values: EMPTY, block: 0 };

      return {
        size: w,
        values: mem().slice(pVals, pVals + w * h),
        block: wasm.estimate_block(pVals, w, h),
      };
    },

    /**
     * Colorizes + smooths one tile.
     * @param neighbours 3x3 grid (row-major, [4] = centre) of value grids;
     *   `null` = unknown (edge-replicated), `EMPTY` = known transparent.
     * @returns RGBA, size*size*4
     */
    render(neighbours: (Uint8Array | null)[], size: number, scheme: number, radius: number) {
      const pad = radius >= 0.5 ? Math.floor(radius * 3) : 0;
      const pw = size + 2 * pad;
      const n = size * size;
      const [pTiles, pZero, pGrid, pLut, pOut, pA, pB, ...pN] = arena(
        36, n, pw * pw, 1024, n * 4, pw * pw * 4, pw * pw * 4, ...neighbours.map(() => n),
      );
      const m = mem();
      m.fill(0, pZero, pZero + n);
      const ptrs = neighbours.map((t, i) => {
        if (t === null) return 0;
        if (t === EMPTY) return pZero;
        m.set(t, pN[i]);
        return pN[i];
      });
      new Uint32Array(wasm.memory.buffer, pTiles, 9).set(ptrs);
      m.set(lutFor(scheme), pLut);

      wasm.build_padded(pTiles, size, pad, pGrid);
      wasm.render_tile(pGrid, pw, pad, pLut, radius, pOut, pA, pB);
      return new Uint8ClampedArray(wasm.memory.buffer.slice(pOut, pOut + n * 4));
    },
  };
}

export type RadarCore = ReturnType<typeof createRadarCore>;
