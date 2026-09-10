import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDoors, useMyAssignments, useTurfs } from '../api/hooks';
import { RESULT_LABELS, type Door } from '../api/types';
import { isOrganizer } from '../auth';
import { useUser } from '../components/Shell';
import { EmptyState, ErrorBox, LoadingList, fmtDate } from '../components/ui';
import { isIosInstalled } from '../pwa';
import '../print/print.css';

/**
 * The paper fallback (prompt_plan.md phase 3). Rural canvassing loses phones to dead batteries, no
 * signal and rain; a printed sheet always works. So this page is designed for the printer, not the
 * screen — the on-screen view is a preview of the paper, deliberately white even in dark mode.
 */
export function TurfSheetPage() {
  const { turfId } = useParams<{ turfId: string }>();
  const user = useUser();

  // The print rules that strip the shell chrome are scoped behind this class. The stylesheet stays
  // loaded for the rest of the session once this route has been visited, and without the class it
  // would silently break printing every other page.
  useEffect(() => {
    document.body.classList.add('printing-sheet');
    return () => document.body.classList.remove('printing-sheet');
  }, []);

  // Who the turf is assigned to lives on a different endpoint depending on the role, and asking the
  // wrong one costs a 403 plus an audit row — so the branch is a component boundary, not an `if`.
  return isOrganizer(user) ? <OrganizerSheet turfId={turfId} /> : <VolunteerSheet turfId={turfId} name={user.name} />;
}

/** Organiser/admin: `GET /api/turfs` carries the assignees, so the sheet can be printed for someone else. */
function OrganizerSheet({ turfId }: { turfId: string | undefined }) {
  const turfs = useTurfs(true); // archived too: a finished turf may still need re-walking on paper
  const turf = turfs.data?.find((t) => t.id === turfId);
  const assignee = turf?.assignees[0];
  return <Sheet turfId={turfId} assignedTo={turf?.assignees.map((a) => a.name) ?? []} dueDate={assignee?.due_date ?? null} />;
}

/** Volunteer: they may only see their own assignment, and it is the only name that could go on the sheet. */
function VolunteerSheet({ turfId, name }: { turfId: string | undefined; name: string }) {
  const mine = useMyAssignments();
  const assignment = mine.data?.find((a) => a.turf.id === turfId);
  return <Sheet turfId={turfId} assignedTo={assignment ? [name] : []} dueDate={assignment?.due_date ?? null} />;
}

function Sheet({ turfId, assignedTo, dueDate }: { turfId: string | undefined; assignedTo: string[]; dueDate: string | null }) {
  const doors = useDoors(turfId);

  if (doors.isPending) return <LoadingList rows={10} label="Building the sheet…" />;
  if (doors.isError) {
    return (
      <div className="page page--narrow">
        <ErrorBox title="Could not load this turf" error={doors.error} onRetry={() => void doors.refetch()} />
        <p>
          <Link to="/canvass">Back to your turfs</Link>
        </p>
      </div>
    );
  }

  const { turf, doors: rows } = doors.data;
  const iosInstalled = isIosInstalled();
  const voters = rows.reduce((sum, d) => sum + d.n_voters, 0);
  const printedOn = new Date().toLocaleDateString('en-CA', { dateStyle: 'long' });

  return (
    <div className="page ts-page">
      {/* Screen only — none of this is on the paper. */}
      <div className="ts-toolbar">
        <div className="ts-toolbar__links">
          <Link to={`/canvass/${turf.id}`}>← Door screen</Link>
          <Link to="/turfs">All turfs</Link>
        </div>
        {/* iOS ignores window.print() in an installed web app — silently, which is worse than an
            error: the button looks broken. window.open() from a standalone PWA hands the URL to
            Safari, where Share > Print works, so on an iPhone that is what the button does and
            says. Android's standalone mode prints fine, hence the iOS-only check. */}
        {iosInstalled ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.open(window.location.href, '_blank', 'noopener')}
          >
            Open in Safari to print
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => window.print()}>
            Print this sheet
          </button>
        )}
        <p className="muted small ts-toolbar__note">
          {iosInstalled && (
            <>
              <strong>iPhone can’t print from an installed app.</strong> That button opens this sheet in Safari — then
              use Share → Print.{' '}
            </>
          )}
          {rows.length} doors on {estimatePages(rows.length)} page{estimatePages(rows.length) === 1 ? '' : 's'}. Print
          one-sided, portrait, A4 or Letter. Take the paper out only for this canvass — bring it back and enter the
          results, then it gets shredded.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="This turf has no doors">
          Nothing to print yet. Add streets or redraw the turf, then come back.
        </EmptyState>
      ) : (
        <div className="ts-paper">
          <table className="ts-sheet">
            {/* `table-layout: fixed` takes its column widths from the first row, and that row is the
                banner spanning all six columns — so the widths have to live in a colgroup or the
                header and the doors below it drift out of alignment. */}
            <colgroup>
              <col className="ts-col-num" />
              <col className="ts-col-addr" />
              <col className="ts-col-names" />
              <col className="ts-col-result" />
              <col className="ts-col-support" />
              <col className="ts-col-note" />
            </colgroup>
            {/* thead repeats on every printed page, so the turf name, the canvasser and the Municipal
                Elections Act line are on every sheet of paper, not only the first. */}
            <thead>
              <tr className="ts-sheet__banner">
                <th colSpan={6}>
                  <div className="ts-sheet__title">
                    <span className="ts-sheet__name">{turf.name}</span>
                    <span className="ts-sheet__printed">Printed {printedOn}</span>
                  </div>
                  <div className="ts-sheet__meta">
                    {turf.ward ? `Ward ${turf.ward}` : 'No ward'} · {rows.length} doors · {voters} voters ·{' '}
                    {assignedTo.length > 0 ? `Canvasser: ${assignedTo.join(', ')}` : 'Canvasser: ______________________'}
                    {dueDate ? ` · Due ${fmtDate(dueDate, false)}` : ''}
                  </div>
                  <div className="ts-sheet__legal">
                    From the voters&rsquo; list under the <em>Municipal Elections Act</em>. Election use only. Do not
                    photocopy it, do not post or share it, and do not leave it in a vehicle.
                  </div>
                </th>
              </tr>
              <tr className="ts-sheet__labels">
                <th className="ts-col-num">#</th>
                <th className="ts-col-addr">Address</th>
                <th className="ts-col-names">Who lives here</th>
                <th className="ts-col-result">Result (tick one)</th>
                <th className="ts-col-support">Support 1–5</th>
                <th className="ts-col-note">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((door, i) => (
                <DoorPrintRow key={door.household_id} door={door} index={i + 1} />
              ))}
            </tbody>
            {/* Last in the markup so it sits at the foot on screen; `table-footer-group` still
                repeats it on every printed page, and the rule for handing the paper back belongs
                on every page. */}
            <tfoot>
              <tr>
                <td colSpan={6}>
                  <span className="ts-sheet__return">
                    Return this sheet to your organiser after the canvass, or shred it. Do not keep it.
                  </span>
                  <span className="ts-sheet__entered">
                    Entered into the app by <span className="ts-rule ts-rule--name" /> on <span className="ts-rule ts-rule--date" />
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/** One door, in walking order. Nothing here may depend on colour — this gets printed in greyscale. */
function DoorPrintRow({ door, index }: { door: Door; index: number }) {
  const names = door.voters.map((v) => v.display_name);
  return (
    <tr className="ts-door">
      <td className="ts-col-num">{index}</td>
      <td className="ts-col-addr">
        <span className="ts-door__addr">{door.address}</span>
        {door.community && <span className="ts-door__community">{door.community}</span>}
        {door.last_result && (
          <span className="ts-door__prev">
            Last: {RESULT_LABELS[door.last_result]}
            {door.last_contact_at ? ` · ${fmtDate(door.last_contact_at, false)}` : ''}
          </span>
        )}
      </td>
      <td className="ts-col-names">
        <span className="ts-door__count">{door.n_voters === 1 ? '1 voter' : `${door.n_voters} voters`}</span>
        <ol className="ts-door__names">
          {names.map((name, i) => (
            <li key={`${door.household_id}-${i}`}>{name}</li>
          ))}
        </ol>
      </td>
      <td className="ts-col-result">
        <div className="ts-ticks">
          {['Spoke', 'Not home', 'Refused', 'Literature'].map((label) => (
            <span className="ts-tick" key={label}>
              <span className="ts-tick__box" aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </td>
      <td className="ts-col-support">
        <div className="ts-scale" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((v) => (
            <span className="ts-scale__n" key={v}>
              {v}
            </span>
          ))}
        </div>
        <span className="ts-rule ts-rule--full" />
      </td>
      <td className="ts-col-note">
        <span className="ts-rule ts-rule--full" />
        <span className="ts-rule ts-rule--full" />
      </td>
    </tr>
  );
}

/** Rough page count for the on-screen hint only; the printer decides for real. */
function estimatePages(doors: number): number {
  // Measured in Chrome against the printable height: 13 doors fit an A4 page, 12 a (shorter) US
  // Letter page. Take the smaller so the hint never promises fewer pages than come out.
  const PER_PAGE = 12;
  return Math.max(1, Math.ceil(doors / PER_PAGE));
}
