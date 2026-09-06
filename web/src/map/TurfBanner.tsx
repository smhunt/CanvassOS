import { Link } from 'react-router-dom';
import { Spinner, n } from '../components/ui';
import './turf.css';

interface Props {
  /** Doors the API returned for this turf, mapped and unmapped together. */
  doors: number;
  /** Selected doors with no coordinates (legal descriptions). They cannot be dots, so they are
   *  named here — otherwise the map silently shows fewer doors than the turf card promised. */
  unmapped: number;
  name: string | null;
  loading: boolean;
  error: unknown;
  onDismiss: () => void;
}

/**
 * The "you are looking at one turf" banner for /map?turf=<id>.
 *
 * It is the only thing on screen that says which turf the rings belong to, so it carries the name,
 * the honest door count and the way back to the turf it came from — and dismissing it is what
 * returns the map to normal, which is why the close button is a real, labelled control rather than
 * a bare glyph.
 */
export function TurfBanner({ doors, unmapped, name, loading, error, onDismiss }: Props) {
  return (
    <div className="turf-banner card" role="status" aria-live="polite">
      <div className="turf-banner__body">
        {loading ? (
          <span className="turf-banner__loading">
            <Spinner size={14} /> Loading turf…
          </span>
        ) : error ? (
          <span className="turf-banner__error">This turf could not be loaded.</span>
        ) : (
          <>
            <strong className="turf-banner__name">{name ?? 'Turf'}</strong>
            <span className="turf-banner__counts">
              {' '}
              · <strong>{n(doors)}</strong> {doors === 1 ? 'door' : 'doors'}
              {unmapped > 0 && (
                <span className="turf-banner__unmapped">
                  {' '}
                  · {n(unmapped)} not on the map (legal {unmapped === 1 ? 'description' : 'descriptions'})
                </span>
              )}
            </span>
          </>
        )}
      </div>
      <Link className="linkbtn turf-banner__link" to="/turfs">
        All turfs
      </Link>
      <button type="button" className="btn btn--small turf-banner__close" onClick={onDismiss}>
        Clear
      </button>
    </div>
  );
}
