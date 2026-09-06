import { useStats } from '../api/hooks';
import { HBars, Histogram } from '../components/Bars';
import { ErrorBox, LoadingRows, n, titleCase, wardLabel } from '../components/ui';
import { QUALITY_COLOURS, wardColour } from '../map/palette';

export function StatsPage() {
  const stats = useStats();

  return (
    <div className="page">
      <header className="page__head">
        <h1>Stats</h1>
        <p className="muted">Voters list overview for Middlesex Centre. Canvass figures fill in once door-knocking starts (Phase 2).</p>
      </header>

      {stats.isPending && (
        <div className="card">
          <LoadingRows rows={6} />
        </div>
      )}
      {stats.isError && <ErrorBox title="Could not load stats" error={stats.error} onRetry={() => void stats.refetch()} />}

      {stats.data && (
        <>
          <section className="tiles" aria-label="Totals">
            <Tile label="Households" value={stats.data.totals.households} />
            <Tile label="Voters" value={stats.data.totals.voters} />
            <Tile label="Residents" value={stats.data.totals.residents} />
            <Tile label="Non-resident" value={stats.data.totals.nonresidents} note="owners on the list" />
            <Tile label="Institutions" value={stats.data.totals.institutions} note="multi-unit / care" />
            <Tile label="Unmapped parcels" value={stats.data.totals.legal} note="legal descriptions" />
            <Tile label="PO-box-only doors" value={stats.data.totals.po_box_only} note="no street mail" />
            <Tile
              label="Voters per door"
              value={stats.data.totals.households ? stats.data.totals.voters / stats.data.totals.households : 0}
              format={(v) => v.toFixed(2)}
            />
          </section>

          <div className="grid-2">
            <section className="card" aria-labelledby="ward-h">
              <h2 id="ward-h">By ward</h2>
              <HBars
                title="Households and voters by ward"
                series={['Households', 'Voters']}
                data={stats.data.by_ward.map((w) => ({
                  label: wardLabel(w.ward),
                  value: w.households,
                  value2: w.voters,
                  colour: wardColour(w.ward),
                  note: `${w.avg_voters_per_door.toFixed(2)} / door · ${n(w.nonresidents)} non-res.`,
                }))}
              />
            </section>

            <section className="card" aria-labelledby="comm-h">
              <h2 id="comm-h">By community</h2>
              <HBars
                title="Households and voters by community"
                series={['Households', 'Voters']}
                data={stats.data.by_community.map((c) => ({
                  label: titleCase(c.community),
                  value: c.households,
                  value2: c.voters,
                  note: c.nonresidents ? `${n(c.nonresidents)} non-res.` : undefined,
                }))}
              />
            </section>

            <section className="card" aria-labelledby="size-h">
              <h2 id="size-h">Voters per door</h2>
              <Histogram
                title="Households by number of voters"
                data={stats.data.household_size.map((s) => ({ label: s.size, value: s.households }))}
              />
              <p className="muted small">Number of households with 1, 2, 3 … voters at the address.</p>
            </section>

            <section className="card" aria-labelledby="q-h">
              <h2 id="q-h">Record quality</h2>
              <HBars
                title="Households by record quality"
                series={['Households']}
                data={[
                  { label: 'Good', value: stats.data.quality.good, colour: QUALITY_COLOURS.good, note: 'exact address match' },
                  { label: 'Approximate', value: stats.data.quality.approx, colour: QUALITY_COLOURS.approx, note: 'nearest on street' },
                  { label: 'Legal', value: stats.data.quality.legal, colour: QUALITY_COLOURS.legal, note: 'no civic address' },
                  { label: 'Check', value: stats.data.quality.check, colour: QUALITY_COLOURS.check, note: 'needs review' },
                ]}
              />
            </section>
          </div>

          <section className="card card--phase2" aria-labelledby="canvass-h">
            <div className="row row--between">
              <h2 id="canvass-h">Canvass</h2>
              <span className="tag tag--neutral">Phase 2</span>
            </div>
            <div className="tiles tiles--inline">
              <Tile label="Doors contacted" value={stats.data.canvass.contacted_households} />
              <Tile label="Contacts today" value={stats.data.canvass.contacts_today} />
              <Tile label="Contacts, last 7 days" value={stats.data.canvass.contacts_7d} />
            </div>
            <h3 className="muted small">Support (1–5)</h3>
            <Histogram
              title="Support distribution"
              compact
              colour="var(--bar-2)"
              data={stats.data.canvass.support_hist.map((v, i) => ({ label: String(i + 1), value: v }))}
            />
            <p className="muted small">Results, support and issue tags appear here once turfs and the door screen ship.</p>
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, note, format = n }: { label: string; value: number; note?: string; format?: (v: number) => string }) {
  return (
    <div className="tile">
      <span className="tile__value num">{format(value)}</span>
      <span className="tile__label">{label}</span>
      {note && <span className="tile__note muted small">{note}</span>}
    </div>
  );
}
