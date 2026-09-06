import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API_PROXY = { '/api': { target: 'http://localhost:3001', changeOrigin: false } };

/** Files copied verbatim from public/ that belong to the app shell (not part of the Rollup bundle). */
const PUBLIC_SHELL_FILES = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/Sans Bold/0-255.pbf',
  '/fonts/Sans Regular/0-255.pbf',
];

/**
 * Emits `sw.js` at build time with the exact list of hashed bundle files, so the service worker
 * precaches the app shell only (index.html, JS/CSS, fonts, icons). `/api/*` is never cached.
 * Hand-rolled instead of a workbox dependency: ~40 lines, no runtime library.
 */
function appShellServiceWorker(): Plugin {
  return {
    name: 'mc-app-shell-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .map((f) => `/${f}`);
      const assets = ['/', ...files, ...PUBLIC_SHELL_FILES].map((p) => encodeURI(p));
      let h = 0;
      for (const ch of assets.join('|')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const source = `/* MC Canvass app-shell service worker (generated at build) */
const CACHE = 'mc-canvass-shell-${h.toString(16)}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // map tiles etc.: browser cache only
  if (url.pathname.startsWith('/api/')) return;            // data is never cached in Phase 1
  if (req.mode === 'navigate') {
    // shell document: network first so deploys show up, cached index.html when offline
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), appShellServiceWorker()],
  server: { port: 5173, proxy: API_PROXY },
  preview: { port: 4173, proxy: API_PROXY },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200, // maplibre-gl alone is ~1 MB minified; it is code-split behind /map
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
});
