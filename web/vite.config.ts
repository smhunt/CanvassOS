import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Ports are registered in ~/.claude/PORTS.md: web 3030, API 3130, Postgres 5443.
// Overridable so a second stack can run alongside the first against a different database — the
// demo stack (web 3032, API 3132, canvass_demo) uses this for screenshots and video.
const WEB_PORT = Number(process.env.CANVASS_WEB_PORT ?? 3030);
const API_PORT = Number(process.env.CANVASS_API_PORT ?? 3130);
const API_PROXY = { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false } };

// Shared mkcert cert for *.dev.ecoworks.ca, so dev runs on https://dev.ecoworks.ca:3030 like the
// rest of the machine's projects. Serving TLS in dev also means the session cookie keeps its
// Secure flag (no COOKIE_SECURE=false), which is how production behaves. Falls back to plain
// HTTP when the cert is absent, so the config stays portable.
const certDir = resolve(homedir(), 'Code/.traefik/certs');
const certPath = resolve(certDir, 'cert.pem');
const keyPath = resolve(certDir, 'key.pem');
const https =
  existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

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
      const source = `/* CanvassOS app-shell service worker (generated at build) */
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
  server: { port: WEB_PORT, strictPort: true, host: true, https, proxy: API_PROXY },
  // package.json's `preview` script passes --port explicitly; keep the default here in step
  // with it so the two cannot disagree when CANVASS_WEB_PORT is set.
  preview: { port: Number(process.env.CANVASS_PREVIEW_PORT ?? 4173), strictPort: true, host: true, https, proxy: API_PROXY },
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
