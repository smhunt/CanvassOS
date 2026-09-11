/**
 * Why part of the list cannot be reached, and what to do about each reason.
 *
 * The numbers come from GET /api/stats/reachability, which returns aggregates only — no name,
 * address or id — so this screen is a report *about* the list rather than a read *of* it. That is
 * also what would make it safe to hand to an advice provider later; `advice` is rendered when the
 * server supplies it and the written guidance below stands in until then.
 *
 * The one thing this screen must not do is imply a single "unreachable" number. A PO-box mailing
 * address blocks lettermail and nothing else; a non-resident owner can be reached by post but never
 * by knocking that door; a do-not-knock is a standing instruction. Grouping by CHANNEL is the whole
 * point — a candidate with six weeks left needs to know which of those six weeks' tactics is ruled
 * out, not that "5% is unreachable".
 */
import { useMemo } from 'react';
import { useReachability } from '../api/hooks';
import type { ReachCategory } from '../api/types';
import { ErrorBox, LoadingCards, LoadingTiles, n, wardLabel } from '../components/ui';
import './reachability.css';

/** Written guidance per category. Domain knowledge, not generated — stable enough to be content. */
const ADVICE: Record<string, { label: string; why: string; do: string }> = {
  no_map_point: {
    label: 'No point on the map',
    why: 'The list gives no civic address that could be matched to a location, so these doors cannot be put in a turf or drawn on the map. This is the parent of the two rows below it, not an extra count.',
    do: 'Work them from a printed list rather than the map. The two causes below need different fixes.',
  },
  legal_description: {
    label: 'Legal description instead of an address',
    why: 'The clerk’s list carries a concession and lot description — common for farms and unassigned rural parcels — with no street number to visit.',
    do: 'Cross-reference the assessment roll or MPAC to get a civic address, or ask someone who knows the concession. Fix it in the source list so the next import carries it.',
  },
  geocode_failed: {
    label: 'Address would not geocode',
    why: 'There is a street address but it did not match the county address file — usually a typo, a new build, or a street renamed since the file was published.',
    do: 'Small enough to fix by hand. Check each against the county address data and correct the source list before the next import.',
  },
  institution: {
    label: 'Institution',
    why: 'A care home or apartment block: many electors behind one entrance, and cold-knocking is usually refused and sometimes prohibited.',
    do: 'Contact the administrator for permission and a time. Arranged properly this is often the highest yield per hour on the whole list — treat it as an appointment, not a door.',
  },
  po_box_only: {
    label: 'PO box mailing address',
    why: 'Every elector at this door takes mail at a PO box, so addressed lettermail to the residence will not arrive. This blocks MAIL ONLY — the door itself is perfectly knockable.',
    do: 'Do not exclude these from canvassing. For a mail drop, use the PO box; for GOTV, prefer the door or the phone.',
  },
  non_resident: {
    label: 'Non-resident owner',
    why: 'Entitled to vote here because they own property, but they live somewhere else. Knocking this address will not find them — whoever answers may not be on the list at all.',
    do: 'Reach them by post or phone at the address the clerk holds. Treat the property as a separate door with its own occupants. Note the pipeline is a reconstruction and this class is indicative — confirm at the door.',
  },
  class_unknown: {
    label: 'Residency unknown',
    why: 'The pipeline could not classify these electors as resident or non-resident.',
    do: 'Too few to matter statistically. Treat as resident and confirm at the door.',
  },
  do_not_knock: {
    label: 'Asked not to be called on',
    why: 'Someone at this door explicitly asked not to be canvassed. It is a standing instruction, not a mood on the day.',
    do: 'Do not knock again this cycle. Re-knocking is the quickest way to turn a soft no into a complaint to the clerk.',
  },
  inaccessible: {
    label: 'Could not get to the door',
    why: 'A locked gate, a dog, a long private lane, or an apartment entry with no answer.',
    do: 'Try a different time of day, or reach them by phone or post instead. Worth one more attempt before writing off.',
  },
  moved: { label: 'Moved away', why: 'The occupant named on the list no longer lives here.', do: 'Record it. The list is fixed at its export date and will not correct itself — this is evidence for the next import.' },
  deceased: { label: 'Deceased', why: 'Reported at the door.', do: 'Record it and do not contact again. Repeat contact after a death is the single most damaging doorstep error a campaign makes.' },
  refused: {
    label: 'Refused at the door',
    why: 'Declined to talk. Not the same as a do-not-knock: no standing instruction was given.',
    do: 'Do not re-canvass this cycle, but they are still a valid mail and phone target.',
  },
};

const CHANNEL = { door: 'Blocks door-knocking', mail: 'Blocks addressed mail', gatekeeper: 'Needs permission first' };

function pct(x: number): string {
  if (x === 0) return '0%';
  return x < 0.001 ? '<0.1%' : `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
}

/** Wards carrying a category at more than 1.5x the municipality's own rate — where to look first. */
function outliers(c: ReachCategory): { ward: string; share: number }[] {
  if (c.share <= 0) return [];
  return c.by_ward.filter((w) => w.count > 0 && w.share > c.share * 1.5).sort((a, b) => b.share - a.share);
}

function Category({ c }: { c: ReachCategory }) {
  const a = ADVICE[c.code];
  const hot = outliers(c);
  return (
    <li className={`rx-cat${c.parent ? ' rx-cat--child' : ''}`}>
      <div className="rx-cat__head">
        <div>
          <strong>{a?.label ?? c.code}</strong>
          <div className="rx-cat__tags">
            {c.blocks.map((b) => (
              <span key={b} className={`rx-tag rx-tag--${b}`}>
                {CHANNEL[b]}
              </span>
            ))}
          </div>
        </div>
        <div className="rx-cat__num">
          <strong>{n(c.count)}</strong>
          <span className="muted small">
            {c.scope === 'voter' ? 'electors' : 'doors'} · {pct(c.share)}
          </span>
        </div>
      </div>
      {a && (
        <>
          <p className="small rx-cat__why">{a.why}</p>
          <p className="small rx-cat__do">
            <strong>What to do:</strong> {a.do}
          </p>
        </>
      )}
      {hot.length > 0 && (
        <p className="small muted rx-cat__wards">
          Concentrated in {hot.map((w) => `${wardLabel(w.ward)} (${pct(w.share)})`).join(', ')} — well above the
          municipal rate of {pct(c.share)}.
        </p>
      )}
    </li>
  );
}

export function UnreachablePanel() {
  const qy = useReachability();

  const groups = useMemo(() => {
    const cats = qy.data?.categories ?? [];
    // Parents immediately before their own causes, so "no map point" is never read as a peer of the
    // two things that add up to it.
    const order = (list: ReachCategory[]) => {
      const out: ReachCategory[] = [];
      for (const c of list.filter((x) => !x.parent)) {
        out.push(c);
        out.push(...list.filter((x) => x.parent === c.code));
      }
      return out;
    };
    return {
      structural: order(cats.filter((c) => c.kind === 'structural')),
      behavioural: order(cats.filter((c) => c.kind === 'behavioural')),
    };
  }, [qy.data]);

  if (qy.isPending) {
    // Two headline figures, then a stack of category cards.
    return (
      <>
        <LoadingTiles count={2} label="Working out what is unreachable…" />
        <LoadingCards count={4} label={null} />
      </>
    );
  }
  if (qy.isError) {
    return <ErrorBox title="Could not work out what is unreachable" error={qy.error} onRetry={() => void qy.refetch()} />;
  }
  const d = qy.data;
  if (!d) return null;

  const behaviouralTotal = groups.behavioural.reduce((a, c) => a + c.count, 0);

  return (
    <div className="rx">
      <div className="card rx-summary">
        <div className="rx-summary__figs">
          <div>
            <strong className="rx-big">{n(d.combined.households_blocked)}</strong>
            <span className="muted small">doors cannot be knocked · {pct(d.combined.share)}</span>
          </div>
          <div>
            <strong className="rx-big">{n(d.combined.mail_blocked)}</strong>
            <span className="muted small">cannot take addressed mail · {pct(d.combined.mail_share)}</span>
          </div>
        </div>
        <p className="small muted rx-summary__note">
          Out of {n(d.totals.households)} doors and {n(d.totals.voters)} electors. These two figures are separate
          problems with separate fixes and deliberately do not add up — a PO box blocks the post but not the door.
          Categories below overlap, so the figures here are de-duplicated rather than the sum of the rows.
        </p>
      </div>

      {d.advice && (
        <div className="card rx-advice">
          <h3 className="sheet__h3">Advice</h3>
          <p className="small">{d.advice}</p>
        </div>
      )}

      <section aria-labelledby="rx-struct-h">
        <h3 id="rx-struct-h" className="sheet__h3">
          Known before you leave the house
        </h3>
        <p className="muted small">
          These come off the list itself, so they can be planned around rather than discovered at the door.
        </p>
        <ul className="rx-cats">
          {groups.structural.map((c) => (
            <Category key={c.code} c={c} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="rx-behav-h">
        <h3 id="rx-behav-h" className="sheet__h3">
          Learned at the door
        </h3>
        <p className="muted small">
          {behaviouralTotal === 0
            ? 'Nothing yet — these appear as canvassers record results, and are a property of the visit rather than of the record.'
            : 'Recorded by canvassers. These describe the visit, not the list, and they change as the campaign goes on.'}
        </p>
        {behaviouralTotal > 0 && (
          <ul className="rx-cats">
            {groups.behavioural.map((c) => (
              <Category key={c.code} c={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
