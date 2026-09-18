/**
 * Hold the screen on. A display that sleeps every thirty seconds makes a glanceable screen
 * pointless, and the driver must not have to touch the phone to wake it — that is the offence the
 * whole design avoids. Re-acquired on visibilitychange because the lock is dropped whenever the tab
 * is hidden, including a passing phone call. Unsupported on some iOS versions: feature-detected and
 * degraded silently, because a missing wake lock is a worse screen, not a broken one.
 */
import { useEffect } from 'react';

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let dropped = false;
    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        // Cleanup can run while the request is in flight (StrictMode's double-invoke, or a fast
        // back-navigation); without this check the sentinel lands in a dead closure and the lock
        // outlives the component instead of being released below.
        if (dropped) {
          void sentinel.release();
        } else {
          lock = sentinel;
        }
      } catch {
        // Denied (battery saver, no user gesture). Nothing to do but carry on.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !dropped) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      dropped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [active]);
}
