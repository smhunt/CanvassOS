/** React bindings for the queues. They are plain TypeScript so they can run without React at all. */
import { useMemo, useSyncExternalStore } from 'react';
import type { ContactResult } from '../api/types';
import { getSnapshot, subscribe, type OutboxSnapshot } from './outbox';
import { getPhotoSnapshot, subscribePhotos, type PendingPhoto, type PhotoQueueSnapshot } from './photoQueue';

/** Subscribing also starts the queue (listeners, first flush), so mounting the pill is enough. */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Sign photos still on the phone. Subscribing starts that queue, exactly as `useOutbox` does. */
export function usePhotoQueue(): PhotoQueueSnapshot {
  return useSyncExternalStore(subscribePhotos, getPhotoSnapshot, getPhotoSnapshot);
}

/** The held photos for one sign — the placing screen only ever cares about the one in front of it. */
export function usePendingPhotosFor(snapshot: PhotoQueueSnapshot, clientId: string): PendingPhoto[] {
  return useMemo(() => snapshot.photos.filter((p) => p.client_id === clientId), [snapshot.photos, clientId]);
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
