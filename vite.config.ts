import { defineConfig, type Plugin } from 'vite';
import { buildRadarWasm } from './scripts/build-radar-wasm.mjs';

/** Dev server: recompile radar.wasm whenever radar.c is saved, then reload the page. */
function radarWasm(): Plugin {
  return {
    name: 'radar-wasm',
    apply: 'serve',
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (!file.endsWith('/src/radar-wasm/radar.c')) return;
        const log = (m: string) => server.config.logger.info(m, { timestamp: true });
        if (buildRadarWasm({ log }) === 'built') server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

export default defineConfig({
  plugins: [radarWasm()],
  server: { port: 5173 },
  worker: { format: 'es' },
  build: {
    target: ['chrome110', 'safari16', 'firefox115'],
    chunkSizeWarningLimit: 8000,
  },
});
