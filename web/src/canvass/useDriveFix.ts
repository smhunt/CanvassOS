/**
 * A position feed tuned for a moving vehicle.
 *
 * This deliberately does not reuse useNearMe, for the same reason nearMe.ts declined to reuse
 * signs/geolocation.ts and said so: the defaults are opposite. Near-me accepts a fifteen-second-old
 * position because nobody walks 10 m while a list opens. At 80 km/h a fifteen-second-old position is
 * 330 m stale and points at the wrong door, so nothing cached is acceptable here. Near-me's 10 m
 * re-sort threshold is dropped entirely — at speed it is crossed twice a second, and stability comes
 * from the hysteresis in drive.ts, not from ignoring movement.
 */
import { useEffect, useState } from 'react';
import type { DriveFix } from './drive';
import { describeGeolocationFailure, preflightGeolocation, type NearFailure } from './nearMe';

export interface DriveFixState {
  fix: DriveFix | null;
  failure: NearFailure | null;
  pending: boolean;
}

export function useDriveFix(active: boolean): DriveFixState {
  const [state, setState] = useState<DriveFixState>({ fix: null, failure: null, pending: false });

  useEffect(() => {
    if (!active) {
      setState({ fix: null, failure: null, pending: false });
      return;
    }
    const blocked = preflightGeolocation();
    if (blocked) {
      setState({ fix: null, failure: blocked, pending: false });
      return;
    }
    setState((s) => ({ ...s, pending: true, failure: null }));
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const h = pos.coords.heading;
        setState({
          fix: {
            at: { lat: pos.coords.latitude, lon: pos.coords.longitude },
            // null when stationary, and on desktops that have no course at all — drive.ts falls
            // back to nearest-first rather than showing an empty card. Negative is rejected too:
            // native iOS reports an invalid course as -1 rather than as null, and -1 is a finite
            // number, so without this the projection would run against a heading of 359 degrees and
            // confidently name a door behind the car.
            heading: h !== null && Number.isFinite(h) && h >= 0 ? h : null,
            speed_mps: Number.isFinite(pos.coords.speed) ? (pos.coords.speed as number) : null,
          },
          failure: null,
          pending: false,
        });
      },
      (err) => setState({ fix: null, failure: describeGeolocationFailure(err), pending: false }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);

  return state;
}
