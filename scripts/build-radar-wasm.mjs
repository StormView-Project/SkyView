#!/usr/bin/env node
// Rebuilds src/radar-wasm/radar.wasm from radar.c — only when radar.c changed.
//
//   node scripts/build-radar-wasm.mjs           rebuild if radar.c changed
//   node scripts/build-radar-wasm.mjs --force   always rebuild
//
// Runs automatically before `npm run dev` / `npm run build`, and the dev server
// re-runs it whenever radar.c is saved. The compiled .wasm is committed next to
// a hash of the source it came from, so machines without the toolchain still
// build the site with the committed binary.
//
// Needs clang with the wasm32 target plus wasm-ld:
//   Arch: pacman -S clang lld    Debian/Ubuntu: apt install clang lld    macOS: brew install llvm lld
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/radar-wasm/', import.meta.url));
const SRC = `${dir}radar.c`;
const OUT = `${dir}radar.wasm`;
const STAMP = `${dir}radar.wasm.sha256`;

const hash = () => createHash('sha256').update(readFileSync(SRC)).digest('hex');

/** Returns 'built' | 'fresh' | 'stale' (changed, but no toolchain to rebuild with). */
export function buildRadarWasm({ force = false, log = console.log } = {}) {
  const sum = hash();
  const upToDate = existsSync(OUT) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === sum;
  if (upToDate && !force) return 'fresh';

  const tmp = `${OUT}.tmp`;
  try {
    execFileSync('clang', [
      '--target=wasm32', '-O3', '-msimd128', '-mbulk-memory', '-nostdlib',
      '-Wall', '-Wextra',
      '-Wl,--no-entry', '-Wl,--export=__heap_base', '-Wl,--strip-all',
      '-o', tmp, SRC,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    const missing = e.code === 'ENOENT';
    log(`[radar-wasm] ${missing ? 'clang not found' : 'compile failed'} — keeping the existing radar.wasm` +
      (missing ? ' (install clang + lld to rebuild it)' : ''));
    if (!missing && !existsSync(OUT)) throw e;
    return 'stale';
  }
  // Swap in place only once the compile succeeded, so a broken edit never leaves a half-written binary.
  renameSync(tmp, OUT);
  writeFileSync(STAMP, `${sum}\n`);
  log(`[radar-wasm] built radar.wasm (${statSync(OUT).size} bytes)`);
  return 'built';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = buildRadarWasm({ force: process.argv.includes('--force') });
  if (result === 'fresh') console.log('[radar-wasm] radar.wasm is up to date');
}
