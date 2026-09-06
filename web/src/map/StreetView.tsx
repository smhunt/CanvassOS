/**
 * Street-level view of a door.
 *
 * A canvasser standing at the end of a long rural driveway needs to know whether this is the house
 * behind the hedge, whether there are steps, and whether there is a gate — before they walk up it.
 * That is the whole job of this component.
 *
 * Three things about it are deliberate:
 *
 * 1. **It is a plain `<img>` pointed at our own API.** The session cookie rides along on the image
 *    request, so no fetch/blob dance is needed, and the browser's own cache honours the
 *    short `Cache-Control: private` the endpoint sets — a volunteer scrolling back to a door they
 *    just looked at does not re-bill the campaign, and that window is deliberately short because
 *    Google's terms forbid treating the imagery as something to keep. Nothing about the provider,
 *    and no API key, exists in this file: `GET /api/households/:id/streetview` proxies it, and only
 *    coordinates ever leave the server.
 *
 * 2. **It renders NOTHING when there is no picture.** The endpoint answers 503 when the campaign
 *    has not configured the feature (which is the default) and 404 where the provider has never
 *    driven past — common on concession roads. Both arrive here as a plain image error, and both
 *    mean the same thing to the canvasser: there is no photo, so do not take up any space, do not
 *    show a broken frame, and do not show an apology for a feature they may not know exists.
 *
 * 3. **There is no download, share, or open-in-new-tab affordance**, matching the stance taken for
 *    sign photos: this is a photograph of an elector's house, personal information under the
 *    *Municipal Elections Act* however mundane it looks. Look at it to find the door; that is all.
 */
import { useEffect, useState } from 'react';
import './streetview.css';

/**
 * One size for every caller, and never the device pixel ratio. Each distinct pixel size is a
 * separately billed image and a separate entry in the browser's cache, so varying it by screen
 * would multiply the cost for no visible gain. 640 is the provider's unsigned maximum; 640×400 is
 * a wide-ish ratio that suits a house, and CSS scales it to whatever the embedding card is.
 */
const W = 640;
const H = 400;

type State = 'loading' | 'shown' | 'none';

export interface StreetViewProps {
  /** Household id, e.g. `H-KOMOKA-1234`. */
  householdId: string;
  /**
   * Address (or similar) for the alt text, when the caller has one to hand. Optional because
   * volunteers outside their turf never see an address, and this component must work either way.
   */
  describe?: string;
  /** Extra class on the root, for callers that need to place it in their own grid. */
  className?: string;
}

export function StreetView({ householdId, describe, className }: StreetViewProps) {
  const src = `/api/households/${encodeURIComponent(householdId)}/streetview?w=${W}&h=${H}`;
  const [state, setState] = useState<State>('loading');

  // A new door reuses the same <img> element, so the previous door's outcome has to be cleared
  // explicitly — otherwise a door with no imagery would keep the last door's photo on screen.
  useEffect(() => setState('loading'), [src]);

  if (state === 'none') return null;

  const alt = describe ? `Street-level view of ${describe}` : 'Street-level view of this door';

  return (
    <figure className={`sv${className ? ` ${className}` : ''}`} data-state={state}>
      <div className="sv__frame">
        {/* The skeleton sits behind the image rather than being swapped for it, so there is one
            box of a fixed aspect ratio from first paint to last and nothing reflows underneath. */}
        {state === 'loading' && <span className="sv__skeleton" aria-hidden="true" />}
        <img
          className="sv__img"
          src={src}
          alt={alt}
          width={W}
          height={H}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('shown')}
          onError={() => setState('none')}
        />
      </div>
      {/* Attribution is REQUIRED, not decorative. Google's Street View policies say attribution
          must be shown in the app whenever Maps Platform content is displayed outside a Google
          map, and accept either the Google Maps logo or the words "Google Maps" — hence the exact
          wording below, and `translate="no"` so a browser's page translation cannot mangle a
          brand name we are contractually obliged to render. The image may or may not also carry a
          watermark; that is not something to depend on, and obscuring it would breach §3.2.2(b).
          The "may be years old" half is ours: it tells the canvasser this is an old drive-by, not
          the campaign's own photograph of their house. */}
      <figcaption className="sv__credit">
        <span className="sv__attr" translate="no">
          Google Maps
        </span>{' '}
        Street View — may be several years old
      </figcaption>
    </figure>
  );
}
