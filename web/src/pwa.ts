/**
 * PWA plumbing: the app-shell service worker plus the "add to home screen" path.
 *
 * Volunteers should be able to launch this like an app — full screen, one tap from the home
 * screen, shell already cached — rather than hunting for a bookmark on a rural road with one bar
 * of signal. Everything here is plain DOM: `main.tsx` calls `registerServiceWorker()` once, and it
 * is owned elsewhere, so this module keeps a single entry point and mounts its own UI.
 */

/** Remembering a "no" matters more than the install: a banner that comes back is a banner people learn to hate. */
const LS_DISMISSED = 'mc.pwa.install-dismissed';

/** Chrome/Edge fire this; it is not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let started = false;

/** Register the build-generated app-shell service worker and offer the install prompt. */
export function registerServiceWorker(): void {
  if (started) return;
  started = true;
  registerAppShell();
  setupInstall();
}

/** Production only; the worker is emitted by the build (see vite.config.ts) and never caches `/api/*`. */
function registerAppShell(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Offline install is a convenience, never a blocker.
    });
  });
}

// ------------------------------------------------------------------ install affordance

function dismissed(): boolean {
  try {
    return localStorage.getItem(LS_DISMISSED) === '1';
  } catch {
    return false; // private mode: no memory, but no crash either
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(LS_DISMISSED, '1');
  } catch {
    /* private mode etc. */
  }
}

/**
 * Running as an app added to an iPhone's home screen.
 *
 * `navigator.standalone` is iOS-only, which is exactly the discrimination needed: iOS silently
 * ignores `window.print()` in an installed web app — no dialog, no error, nothing — while Android's
 * standalone mode prints perfectly well. So this is not "is it installed", it is "is printing
 * impossible here", and only the turf sheet cares.
 */
export function isIosInstalled(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Already launched from the home screen — there is nothing to offer. */
function installed(): boolean {
  return isIosInstalled() || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * iOS Safari never fires `beforeinstallprompt` — and iPhones are most of the phones this runs on —
 * so those users get written instructions instead of a button. iPadOS 13+ reports itself as a Mac,
 * hence the touch-points check.
 */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Signing in or accepting an invite is not the moment to ask. */
function badMoment(): boolean {
  const p = window.location.pathname;
  return p.startsWith('/login') || p.startsWith('/invite');
}

function setupInstall(): void {
  if (installed()) return;

  window.addEventListener('appinstalled', () => {
    rememberDismissed(); // installed once is a permanent "stop asking"
    remove();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the browser's own mini-infobar out of the way and offer it on our terms instead.
    e.preventDefault();
    if (dismissed() || badMoment()) return;
    show({ kind: 'prompt', event: e as BeforeInstallPromptEvent });
  });

  if (isIOS() && !dismissed()) {
    // No event to wait for, so wait for the volunteer to be somewhere useful first.
    window.setTimeout(() => {
      if (!dismissed() && !badMoment() && !installed()) show({ kind: 'ios' });
    }, 8000);
  }

  // `beforeinstallprompt` cannot fire in `vite dev` (no service worker is registered there), so the
  // banner would otherwise be unreviewable until production. DEV-only, stripped from the build.
  if (import.meta.env.DEV) {
    const preview = new URLSearchParams(window.location.search).get('pwa-preview');
    if (preview === 'ios') show({ kind: 'ios' });
    if (preview === 'prompt') show({ kind: 'prompt', event: null });
  }
}

type Offer = { kind: 'prompt'; event: BeforeInstallPromptEvent | null } | { kind: 'ios' };

const ROOT_ID = 'mc-install';

function remove(): void {
  document.getElementById(ROOT_ID)?.remove();
}

function show(offer: Offer): void {
  if (document.getElementById(ROOT_ID)) return;
  injectStyles();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'mc-install';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Add CanvassOS to your home screen');

  const text = document.createElement('div');
  text.className = 'mc-install__text';
  const title = document.createElement('strong');
  title.textContent = 'Add CanvassOS to your home screen';
  const body = document.createElement('p');
  body.textContent =
    offer.kind === 'ios'
      ? 'Tap Share, then “Add to Home Screen”. It opens full screen and starts faster at the door.'
      : 'It opens full screen, starts faster, and the app itself keeps working when the signal drops.';
  text.append(title, body);

  const actions = document.createElement('div');
  actions.className = 'mc-install__actions';

  if (offer.kind === 'prompt') {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mc-install__btn mc-install__btn--primary';
    add.textContent = 'Add';
    add.addEventListener('click', () => {
      const e = offer.event;
      remove();
      if (!e) return; // dev preview
      void e.prompt().then(() => e.userChoice.then((c) => c.outcome === 'dismissed' && rememberDismissed()));
    });
    actions.append(add);
  }

  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'mc-install__btn';
  no.textContent = offer.kind === 'ios' ? 'Got it' : 'Not now';
  no.addEventListener('click', () => {
    rememberDismissed();
    remove();
  });
  actions.append(no);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mc-install__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    rememberDismissed();
    remove();
  });

  root.append(text, actions, close);
  document.body.append(root);
}

function injectStyles(): void {
  if (document.getElementById('mc-install-style')) return;
  const style = document.createElement('style');
  style.id = 'mc-install-style';
  // Self-contained: this UI lives outside the React tree and outside styles.css, so it carries its
  // own light/dark colours and its own print rule rather than borrowing custom properties.
  style.textContent = `
.mc-install {
  position: fixed;
  z-index: 60;
  left: 0.75rem;
  right: 0.75rem;
  bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
  max-width: 30rem;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding: 0.75rem 2rem 0.75rem 0.9rem;
  border: 1px solid #c8d2dc;
  border-radius: 12px;
  background: #ffffff;
  color: #10202f;
  box-shadow: 0 8px 28px rgba(10, 20, 30, 0.22);
  font: inherit;
}
.mc-install__text { flex: 1 1 14rem; }
.mc-install__text strong { display: block; font-size: 0.92rem; }
.mc-install__text p { margin: 0.15rem 0 0; font-size: 0.82rem; opacity: 0.8; }
.mc-install__actions { display: flex; gap: 0.5rem; }
.mc-install__btn {
  font: inherit;
  font-size: 0.85rem;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid #c8d2dc;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.mc-install__btn--primary { background: #1f4e79; border-color: #1f4e79; color: #fff; }
.mc-install__close {
  position: absolute;
  top: 0.15rem;
  right: 0.35rem;
  font-size: 1.25rem;
  line-height: 1;
  padding: 0.25rem;
  border: 0;
  background: none;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}
@media (prefers-color-scheme: dark) {
  .mc-install { background: #16222f; color: #e7eef5; border-color: #2b3d4f; }
  .mc-install__btn { border-color: #3a4d60; }
  .mc-install__btn--primary { background: #4a90d9; border-color: #4a90d9; color: #06121d; }
}
@media print { .mc-install { display: none !important; } }
`;
  document.head.append(style);
}
