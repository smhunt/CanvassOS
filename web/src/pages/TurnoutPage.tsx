import { useRef, useState, type ChangeEvent } from 'react';
import { isApiError } from '../api/client';
import { useTurnout, useVotedImport, useVotedImports } from '../api/hooks';
import type { VotedImportMode, VotedImportResult } from '../api/types';
import { isAdmin } from '../auth';
import { HBars } from '../components/Bars';
import { useUser } from '../components/Shell';
import { EmptyState, ErrorBox, LoadingTable, LoadingTiles, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';

/**
 * Who has voted: the clerk's strike-off list, imported, and the turnout it adds up to.
 *
 * Organizers see the counts. Admins also import the file — always as a dry run first, because
 * there is no standard shape for a voted list and the only way to know whether "SMITH, J" at
 * "12 King" found the right person is to be shown how many rows matched, how, and which did not,
 * before anything is written. A row the matcher could not place with certainty is left alone and
 * listed here; nothing is ever guessed.
 */
export function TurnoutPage() {
  const user = useUser();
  const admin = isAdmin(user);
  const turnout = useTurnout();

  return (
    <div className="page">
      <header className="page__head">
        <h1>Turnout</h1>
        <p className="muted">
          Who has already voted, from the clerk’s list. A voter marked here shows as “Voted” on their door everywhere in
          the app, so nobody is asked to vote twice, and the map can show where the remaining voters are.
        </p>
      </header>

      {turnout.isPending && <LoadingTiles count={5} label="Loading the turnout…" />}
      {turnout.isError && <ErrorBox title="Could not load the turnout" error={turnout.error} onRetry={() => void turnout.refetch()} />}
      {turnout.data && <Summary data={turnout.data} />}

      {admin && <ImportPanel />}
      {admin && <History />}
    </div>
  );
}

function Summary({ data }: { data: NonNullable<ReturnType<typeof useTurnout>['data']> }) {
  const t = data.totals;
  const share = t.voters ? (t.voted / t.voters) * 100 : 0;
  return (
    <>
      <section className="tiles" aria-label="Turnout so far">
        <Tile label="Have voted" value={t.voted} />
        <Tile label="On the list" value={t.voters} />
        <Tile label="Turnout" value={share} format={(v) => `${v.toFixed(1)}%`} note="of electors on the list" />
        <Tile label="Doors finished" value={t.households_all} note="everyone there has voted" />
        <Tile label="Doors with a voter" value={t.households_any} note="at least one has voted" />
      </section>
      {data.last_import ? (
        <p className="muted small">
          Last file: <strong>{data.last_import.label}</strong>, {fmtDate(data.last_import.at)}
          {data.last_import.user_name ? ` by ${data.last_import.user_name}` : ''} — {n(data.last_import.n_matched)} of{' '}
          {n(data.last_import.n_entries)} rows matched.
        </p>
      ) : (
        <p className="muted small">No voted list has been imported yet, so nobody is marked as having voted.</p>
      )}
      <div className="grid-2">
        <section className="card" aria-labelledby="turnout-ward-h">
          <h2 id="turnout-ward-h">By ward</h2>
          <HBars
            title="Voters and voted by ward"
            series={['On the list', 'Have voted']}
            data={data.by_ward.map((w) => ({
              label: wardLabel(w.ward),
              value: w.voters,
              value2: w.voted,
              colour: wardColour(w.ward),
              note: w.voters ? `${((w.voted / w.voters) * 100).toFixed(1)}%` : '—',
            }))}
          />
        </section>
        <section className="card" aria-labelledby="turnout-community-h">
          <h2 id="turnout-community-h">By community</h2>
          <HBars
            title="Voters and voted by community"
            series={['On the list', 'Have voted']}
            data={data.by_community.slice(0, 12).map((c) => ({
              label: c.community ? titleCase(c.community) : 'No community (legal descriptions)',
              value: c.voters,
              value2: c.voted,
              note: c.voters ? `${((c.voted / c.voters) * 100).toFixed(1)}%` : '—',
            }))}
          />
        </section>
      </div>
      {data.by_day.length > 0 && (
        <section className="card" aria-labelledby="turnout-day-h">
          <h2 id="turnout-day-h">By day</h2>
          <p className="muted small">The day a voter was recorded as having voted, Ontario time, as the files gave it.</p>
          <HBars title="Voted by day" series={['Have voted']} data={data.by_day.map((d) => ({ label: d.day, value: d.voted }))} />
        </section>
      )}
    </>
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

// ---------------------------------------------------------------- the import (admin)

interface LoadedFile {
  name: string;
  entries: unknown;
  rows: number;
}

/** How many rows the loaded JSON holds, by the same rule the API uses to find the array. */
function countRows(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') {
    for (const k of ['voters', 'voted', 'entries', 'records', 'data', 'rows', 'items']) {
      const v = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return 0;
}

const HOW_LABELS: Record<keyof VotedImportResult['counts']['by_how'], string> = {
  id: 'by voter id',
  key: 'by list key',
  'name+address': 'by name and address',
  name: 'by name alone (only one of that name)',
  'name~address': 'by name alone, address did not agree',
};

function ImportPanel() {
  const run = useVotedImport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<VotedImportMode>('merge');
  const [result, setResult] = useState<VotedImportResult | null>(null);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setResult(null);
    setFileError(null);
    if (!f) {
      setFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(String(reader.result));
        const rows = countRows(parsed);
        if (rows === 0) {
          setFileError('That file holds no list of voters. It should be a JSON array, or an object with one under "voters".');
          setFile(null);
          return;
        }
        setFile({ name: f.name, entries: parsed, rows });
        if (!label) setLabel(f.name.replace(/\.json$/i, ''));
      } catch {
        setFileError('That file is not valid JSON.');
        setFile(null);
      }
    };
    reader.onerror = () => setFileError('Could not read that file.');
    reader.readAsText(f);
  };

  const go = (dry: boolean) => {
    if (!file || run.isPending) return;
    run.mutate(
      { label: label.trim() || file.name, mode, dry_run: dry, entries: file.entries },
      {
        onSuccess: (r) => {
          setResult(r);
          if (!r.dry_run) {
            // Applied: the file is spent. Clear it so the same button cannot apply it twice.
            setFile(null);
            if (fileRef.current) fileRef.current.value = '';
          }
        },
      },
    );
  };

  const canApply = !!file && !!result?.dry_run && result.counts.matched > 0;

  return (
    <section className="card turnout-import" aria-labelledby="turnout-import-h">
      <h2 id="turnout-import-h">Import the clerk’s voted list</h2>
      <p className="muted small">
        A JSON file of the people who have voted. Each row needs a name (<code>name</code> as “SURNAME, GIVEN”, or{' '}
        <code>last_name</code> and <code>first_name</code>) and, ideally, the property address; a row may also say{' '}
        <code>hasVoted: false</code> to clear a mark. Check the file first — nothing is written until you apply it, and a
        row that could be two people is left alone and listed below.
      </p>

      <div className="turnout-import__form">
        <label className="field">
          <span className="field__label">File</span>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={onFile} />
          {file && (
            <span className="muted small">
              {file.name} — {n(file.rows)} {file.rows === 1 ? 'row' : 'rows'}
            </span>
          )}
          {fileError && <span className="field__error">{fileError}</span>}
        </label>
        <label className="field">
          <span className="field__label">Label</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="advance poll day 2" />
        </label>
        <fieldset className="fs">
          <legend>This file is…</legend>
          <label className="check">
            <input type="radio" name="voted-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            <span className="check__label">Only the new voters (add to what is marked already)</span>
          </label>
          <label className="check">
            <input type="radio" name="voted-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span className="check__label">Everyone who has voted so far (anyone marked but missing from it is un-marked)</span>
          </label>
        </fieldset>
        <div className="row turnout-import__actions">
          <button type="button" className="btn" disabled={!file || run.isPending} onClick={() => go(true)}>
            {run.isPending && run.variables?.dry_run ? 'Checking…' : 'Check the file'}
          </button>
          <button type="button" className="btn btn--primary" disabled={!canApply || run.isPending} onClick={() => go(false)}>
            {run.isPending && run.variables && !run.variables.dry_run ? 'Applying…' : 'Apply this file'}
          </button>
          {!canApply && file && !result && <span className="muted small">Check the file first.</span>}
        </div>
      </div>

      {run.isError && (
        <ErrorBox
          title={isApiError(run.error, 400) ? 'The file could not be used' : 'The import failed'}
          error={run.error}
          compact
        />
      )}
      {result && <ImportResult r={result} />}
    </section>
  );
}

function ImportResult({ r }: { r: VotedImportResult }) {
  const c = r.counts;
  return (
    <div className="turnout-result" role="status">
      <h3 className="sheet__h3">{r.dry_run ? 'What this file would do' : `Applied: ${r.import?.label ?? ''}`}</h3>
      <div className="tiles tiles--inline">
        <Tile label="Rows" value={c.entries} />
        <Tile label="Matched" value={c.matched} />
        <Tile label="Not found" value={c.unmatched} />
        <Tile label="Ambiguous" value={c.ambiguous} note="left alone" />
        {r.dry_run ? (
          <>
            <Tile label="Would mark" value={c.would_mark} />
            <Tile label="Would un-mark" value={c.would_clear} />
          </>
        ) : (
          <>
            <Tile label="Newly marked" value={r.import?.n_marked ?? 0} />
            <Tile label="Un-marked" value={r.import?.n_cleared ?? 0} />
          </>
        )}
      </div>
      <ul className="muted small turnout-result__how">
        {(Object.keys(c.by_how) as (keyof typeof c.by_how)[])
          .filter((k) => c.by_how[k] > 0)
          .map((k) => (
            <li key={k}>
              {n(c.by_how[k])} {HOW_LABELS[k]}
            </li>
          ))}
        {c.address_differs > 0 && (
          <li className="turnout-result__warn">
            {n(c.address_differs)} matched on the name alone while the address in the file did not agree with the list — worth a look.
          </li>
        )}
      </ul>
      {r.unmatched.length > 0 && (
        <details className="disclosure" open={r.unmatched.length <= 20}>
          <summary>
            {n(r.unmatched.length)} {r.unmatched.length === 1 ? 'row' : 'rows'} not placed
          </summary>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Row</th>
                <th>Name in file</th>
                <th>Address in file</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {r.unmatched.map((u) => (
                <tr key={u.index}>
                  <td className="num">{u.index + 1}</td>
                  <td>{u.name ?? <span className="muted">—</span>}</td>
                  <td>{u.address ?? <span className="muted">—</span>}</td>
                  <td>
                    {u.reason === 'ambiguous'
                      ? `${u.candidates ?? 'several'} people of that name — add the address`
                      : u.reason === 'nothing_to_match_on'
                        ? 'no name in the row'
                        : 'nobody of that name on the list'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function History() {
  const imports = useVotedImports();
  return (
    <section className="card" aria-labelledby="turnout-history-h">
      <h2 id="turnout-history-h">Files imported</h2>
      {imports.isPending && <LoadingTable rows={3} label="Loading the import history…" />}
      {imports.isError && <ErrorBox title="Could not load the history" error={imports.error} compact />}
      {imports.data && imports.data.length === 0 && <EmptyState title="Nothing imported yet" />}
      {imports.data && imports.data.length > 0 && (
        <table className="table table--compact">
          <thead>
            <tr>
              <th>When</th>
              <th>File</th>
              <th>Mode</th>
              <th className="num">Rows</th>
              <th className="num">Matched</th>
              <th className="num">Marked</th>
              <th className="num">Un-marked</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {imports.data.map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{fmtDate(i.at)}</td>
                <td>{i.label}</td>
                <td>{i.mode === 'replace' ? 'everyone so far' : 'new voters'}</td>
                <td className="num">{n(i.n_entries)}</td>
                <td className="num">{n(i.n_matched)}</td>
                <td className="num">{n(i.n_marked)}</td>
                <td className="num">{n(i.n_cleared)}</td>
                <td>{i.user_name ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
