import { execFile } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import { buildRadarWasm } from './scripts/build-radar-wasm.mjs';

/**
 * Dev server: keep generated assets in sync while you edit, then reload the page.
 *  - radar.c saved           → recompile radar.wasm
 *  - any source file saved   → re-cut the icon font if a new icon name appeared
 */
function generatedAssets(): Plugin {
  return {
    name: 'generated-assets',
    apply: 'serve',
    configureServer(server) {
      const log = (m: string) => server.config.logger.info(m, { timestamp: true });
      let iconTimer: NodeJS.Timeout | undefined;
      server.watcher.on('change', (file) => {
        if (file.endsWith('/src/radar-wasm/radar.c')) {
          if (buildRadarWasm({ log }) === 'built') server.ws.send({ type: 'full-reload' });
        } else if (/\/src\/.*\.(ts|html|css)$/.test(file)) {
          clearTimeout(iconTimer);
          iconTimer = setTimeout(() => {
            execFile('python3', ['scripts/build-icon-font.py'], (_err, stdout) => {
              const out = stdout.trim();
              if (out) log(out);
              if (out.includes('built')) server.ws.send({ type: 'full-reload' });
            });
          }, 400);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [generatedAssets()],
  server: { port: 5173 },
  worker: { format: 'es' },
  build: {
    target: ['chrome110', 'safari16', 'firefox115'],
    chunkSizeWarningLimit: 8000,
  },
});
