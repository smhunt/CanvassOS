/**
 * Sign photos.
 *
 * `GET /api/signs/photo/:id` requires the session, and the cookie rides along on a plain `<img>`
 * request, so no fetch/blob dance is needed. Every view is audited server-side (`view_sign_photo`).
 *
 * These are photographs of people's houses, which makes them personal information under the
 * Municipal Elections Act however mundane they look. So there is deliberately no download, no
 * share, no open-in-new-tab and no right-click affordance offered here — the crew can look at the
 * photo to find the sign, and that is all this screen is for.
 */
import { useState } from 'react';

export function PhotoStrip({ ids, describe }: { ids: string[]; describe: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (ids.length === 0) return null;

  return (
    <ul className="sg-photos" aria-label={`Photos of the sign at ${describe}`}>
      {ids.map((id, i) => {
        const open = openId === id;
        const alt =
          ids.length > 1
            ? `Photo ${i + 1} of ${ids.length} of the sign at ${describe}`
            : `Photo of the sign at ${describe}`;
        return (
          <li key={id} className={`sg-photos__item${open ? ' sg-photos__item--open' : ''}`}>
            <button
              type="button"
              className="sg-photo"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : id)}
            >
              <img
                className="sg-photo__img"
                src={`/api/signs/photo/${encodeURIComponent(id)}`}
                alt={alt}
                loading="lazy"
                draggable={false}
              />
              <span className="sg-photo__hint">{open ? 'Tap to shrink' : 'Tap to enlarge'}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
