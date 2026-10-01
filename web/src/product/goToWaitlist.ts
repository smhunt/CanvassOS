import type { RefObject } from 'react';

/**
 * Bring the waitlist form into view and put the cursor in its first field. Smooth only for
 * people who have not asked for less motion. Its own module so the sign-in page can use it
 * without pulling in the lazily loaded product page.
 */
export function goToWaitlist(field: RefObject<HTMLInputElement>) {
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('waitlist')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  field.current?.focus({ preventScroll: true });
}
