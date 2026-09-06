/** Register the build-generated app-shell service worker (production only; see vite.config.ts). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Offline install is a convenience, never a blocker.
    });
  });
}
