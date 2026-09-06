/**
 * The GPS fix behind a lawn sign.
 *
 * A sign has to be found again months later, on a rural road where "third gate past the church" is
 * not a location in November. So the fix and its accuracy are the record — which means this module
 * never invents a coordinate. Every failure surfaces as a failure with something the volunteer can
 * actually do about it; there is deliberately no fallback to a map centre, a last-known position or
 * an IP lookup, because a wrong coordinate is worse than none: it sends the pickup crew to the
 * wrong concession while the real sign stays up past the by-law deadline.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface GeoFix {
  lat: number;
  lon: number;
  /** The device's reported horizontal accuracy in metres — the radius somebody has to search. */
  accuracy_m: number | null;
  /** Epoch ms the fix was taken, so the screen can say how stale it is. */
  at: number;
}

export type GeoFailureKind = 'insecure' | 'unsupported' | 'denied' | 'unavailable' | 'timeout' | 'unknown';

export interface GeoFailure {
  kind: GeoFailureKind;
  /** What went wrong and what to do about it, in one string fit to show a volunteer outdoors. */
  message: string;
}

/**
 * Above this the fix is too vague to hand to the pickup crew: a 60 m circle on a rural lot is most
 * of the frontage plus the ditch. Not a hard limit — a poor fix plus a photo still beats no record
 * at all — but it is loud, because accuracy usually improves a lot in the ten seconds after a cold
 * start and re-taking the fix is free.
 */
export const ACCURACY_WARN_M = 30;

/**
 * Middlesex Centre plus a margin, mirroring the server's sanity box (API.md, "Lawn signs"). The API
 * is authoritative and refuses anything outside it with `coordinate_out_of_range`; checking here as
 * well saves a doomed round trip from somebody on one bar of rural LTE.
 */
export const MC_BBOX = { minLat: 42.8, maxLat: 43.2, minLon: -81.7, maxLon: -81.1 };

export function isInMiddlesexCentre(fix: GeoFix): boolean {
  return (
    fix.lat >= MC_BBOX.minLat && fix.lat <= MC_BBOX.maxLat && fix.lon >= MC_BBOX.minLon && fix.lon <= MC_BBOX.maxLon
  );
}

/** Fixed 6 decimals ≈ 0.1 m — enough precision that the string never loses the fix. */
export const formatCoord = (v: number): string => v.toFixed(6);

export function formatAccuracy(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return 'unknown';
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

function describe(err: GeolocationPositionError): GeoFailure {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return {
        kind: 'denied',
        message:
          'Location is blocked for this site. Allow it and tap “Get GPS fix” again — on iPhone: Settings › Privacy & Security › Location Services, and the padlock in Safari’s address bar; on Android Chrome: tap the padlock › Permissions › Location.',
      };
    case err.POSITION_UNAVAILABLE:
      return {
        kind: 'unavailable',
        message:
          'The phone could not get a fix. Step out from under trees or away from the building, make sure Location Services is on, wait a few seconds and try again.',
      };
    case err.TIMEOUT:
      return {
        kind: 'timeout',
        message:
          'The fix took too long. That usually means a cold GPS start — stay outdoors, keep the phone still and try again; the second attempt is normally much faster.',
      };
    default:
      return {
        kind: 'unknown',
        message: `The phone reported a location error${err.message ? `: ${err.message}` : ''}. Try again, and if it keeps failing record the sign from another device.`,
      };
  }
}

/** Refuse before asking, when asking cannot possibly work. */
function preflight(): GeoFailure | null {
  // Browsers only hand out geolocation over https (localhost excepted). Over plain http the
  // permission prompt never appears and the callback either never fires or errors opaquely, so say
  // so plainly rather than letting the volunteer stand in a field tapping a dead button.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      kind: 'insecure',
      message:
        'This page is not on a secure (https) connection, so the browser will not release the phone’s location. Open the campaign site at its https address and sign in again.',
    };
  }
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return {
      kind: 'unsupported',
      message:
        'This browser cannot provide a GPS location. A sign cannot be recorded without a coordinate — use a phone with location services instead.',
    };
  }
  return null;
}

export interface GeoFixState {
  fix: GeoFix | null;
  failure: GeoFailure | null;
  pending: boolean;
  /** How many fixes have been taken this session — drives "re-take" wording and the aria-live text. */
  attempts: number;
  take: () => void;
  clear: () => void;
}

export function useGeoFix(): GeoFixState {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [failure, setFailure] = useState<GeoFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const take = useCallback(() => {
    const blocked = preflight();
    if (blocked) {
      setFailure(blocked);
      return;
    }
    setPending(true);
    setFailure(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!alive.current) return;
        // The newest fix always wins, never the most accurate one: a volunteer who re-takes the fix
        // has usually walked to where the sign actually is, and keeping a tighter-but-older reading
        // would quietly record the wrong spot.
        setFix({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          at: Date.now(),
        });
        setAttempts((a) => a + 1);
        setPending(false);
      },
      (err) => {
        if (!alive.current) return;
        setFailure(describe(err));
        setPending(false);
      },
      {
        enableHighAccuracy: true,
        // 25 s is long, but a cold GPS start outdoors regularly takes 15.
        timeout: 25_000,
        // Never accept a cached position: the last fix is the previous driveway, which is exactly
        // the bug that puts a sign on the wrong lot.
        maximumAge: 0,
      },
    );
  }, []);

  const clear = useCallback(() => {
    setFix(null);
    setFailure(null);
    setAttempts(0);
  }, []);

  return { fix, failure, pending, attempts, take, clear };
}
