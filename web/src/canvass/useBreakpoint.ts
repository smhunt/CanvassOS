/**
 * The tablet stop, expressed once for TypeScript.
 *
 * CSS lays the door screen out; this hook decides the *semantics* that have to go with the layout —
 * an open door is a modal dialog when it covers the list, and a plain labelled region when it sits
 * beside it. Those two answers must flip at exactly the same width, so this string is the mirror of
 * the 720px tablet stop in `styles.css` and the two have to be changed together.
 *
 * It is a media query and not a device check on purpose: iPadOS Split View hands the same iPad out
 * at roughly 320, 375, 507 or 678px as well as its full 744-1366, and only the live width is true.
 *
 * The height half is not decoration. A phone on its side is 844x390 — wide enough for two panes and
 * nowhere near tall enough to put anything in them, and it is a phone. Every tablet is at least
 * 744px in its short dimension, and no phone in landscape is anywhere near 600, so 600 separates
 * them with room to spare in both directions.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const TABLET_QUERY = '(min-width: 720px) and (min-height: 600px)';

/** The width stops from the header of styles.css, by name. Change them together with the CSS. */
export const COMPACT_QUERY = '(max-width: 479.98px)';
export const TABLET_WIDTH_QUERY = '(min-width: 720px)';
export const DESKTOP_QUERY = '(min-width: 1100px)';
export type Breakpoint = 'phone' | 'compact' | 'tablet' | 'desktop';

/** Which of the four stops the viewport is in right now — a name, never a pixel width. */
export function currentBreakpoint(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'phone';
  if (window.matchMedia(DESKTOP_QUERY).matches) return 'desktop';
  if (window.matchMedia(TABLET_WIDTH_QUERY).matches) return 'tablet';
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact';
  return 'phone';
}

/** Subscribes to a media query so a resize — or a Split View drag — re-renders with the truth. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // No server rendering here, but the third argument is also what a snapshot falls back to in a
    // non-DOM environment: "phone" is the safe default, because the phone path is the complete one.
    () => false,
  );
}

/** True from iPad-mini-portrait width up, where the door screen becomes master–detail. */
export function useIsTablet(): boolean {
  return useMediaQuery(TABLET_QUERY);
}
