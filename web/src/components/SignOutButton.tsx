import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLogout } from '../api/hooks';
import { flushNow, reset, track } from '../analytics';
import { useOutbox, usePhotoQueue } from '../offline/useOutbox';

interface Props {
  className?: string;
  /** "menuitem" inside the top-bar menus, so the menu's ARIA stays honest. */
  role?: 'menuitem';
}

/**
 * The one Sign out control, used on the Account page (top and bottom) and in both top-bar menus.
 *
 * Signing out does not empty the phone's queues, and a queued entry carries no user: it replays
 * under whoever holds the session when signal comes back. So on a phone shared between canvassers,
 * a door recorded by one volunteer and still waiting would be credited to the next person to sign
 * in. Hence the second tap when anything is still waiting — a warning, not a block, because an
 * organizer may genuinely need to hand the phone over and deal with the queue afterwards.
 */
export function SignOutButton({ className = 'btn', role }: Props) {
  const logout = useLogout();
  const nav = useNavigate();
  const outbox = useOutbox();
  const photos = usePhotoQueue();
  const [warned, setWarned] = useState(false);

  const results = outbox.pending + outbox.parked;
  const held = photos.photos.length;
  const waiting = results + held > 0;

  const signOut = () => {
    // While the cookie is still valid: after the logout the relay would refuse the batch.
    flushNow();
    logout.mutate(undefined, {
      // The same passed-phone rule as the outbox: nothing buffered follows the next person in.
      onSuccess: () => reset(),
      onSettled: () => nav('/login', { replace: true }),
    });
  };

  const what = [
    results > 0 ? `${results} ${results === 1 ? 'result' : 'results'}` : null,
    held > 0 ? `${held} sign ${held === 1 ? 'photo' : 'photos'}` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <>
      <button
        type="button"
        className={className}
        role={role}
        disabled={logout.isPending}
        onClick={() => {
          if (waiting && !warned) {
            setWarned(true);
            track('sign_out_blocked_by_queue', { n_pending: results, n_photos: held, proceeded: false });
            return;
          }
          if (waiting) track('sign_out_blocked_by_queue', { n_pending: results, n_photos: held, proceeded: true });
          signOut();
        }}
      >
        {logout.isPending ? 'Signing out…' : warned && waiting ? 'Sign out anyway' : 'Sign out'}
      </button>
      {warned && waiting && (
        <p className="signout-warn small" role="alert">
          {what} on this phone {results + held === 1 ? 'has' : 'have'} not reached the campaign yet. If someone
          else signs in here before {results + held === 1 ? 'it sends' : 'they send'}, {results + held === 1 ? 'it' : 'they'}{' '}
          will be recorded as theirs. Best to get signal and let {results + held === 1 ? 'it' : 'them'} sync first.
        </p>
      )}
    </>
  );
}
