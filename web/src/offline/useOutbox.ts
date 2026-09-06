/** React bindings for the outbox. The queue itself is plain TypeScript so it can run without one. */
import { useMemo, useSyncExternalStore } from 'react';
import type { ContactResult } from '../api/types';
import { getSnapshot, subscribe, type OutboxSnapshot } from './outbox';

/** Subscribing also starts the queue (listeners, first flush), so mounting the pill is enough. */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Door results still sitting in the queue, keyed by household.
 *
 * Derived from the snapshot rather than read from the queue directly, because this is what lets a
 * volunteer reload the app in a dead spot and still see which doors they have already knocked.
 */
export function useQueuedResults(snapshot: OutboxSnapshot): Record<string, ContactResult> {
  return useMemo(() => {
    const out: Record<string, ContactResult> = {};
    for (const e of snapshot.entries) {
      if (e.endpoint !== '/contacts' || !e.household_id || !e.result) continue;
      out[e.household_id] = e.result;
    }
    return out;
  }, [snapshot.entries]);
}
