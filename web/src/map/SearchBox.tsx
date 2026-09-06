import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useSearch } from '../api/hooks';
import type { SearchResult } from '../api/types';
import { Spinner, titleCase, wardLabel } from '../components/ui';

export type SearchPick =
  | { kind: 'voter'; householdId: string; label: string }
  | { kind: 'household'; householdId: string; label: string };

interface Props {
  onPick: (pick: SearchPick) => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Item = { key: string; pick: SearchPick; primary: string; secondary: string };

function toItems(r: SearchResult | undefined): Item[] {
  if (!r) return [];
  const v: Item[] = r.voters.map((x) => ({
    key: `v-${x.id}`,
    pick: { kind: 'voter', householdId: x.household_id, label: x.display_name },
    primary: x.display_name,
    secondary: `${x.address}${x.community ? ` · ${titleCase(x.community)}` : ''} · ${wardLabel(x.ward)}`,
  }));
  const h: Item[] = r.households.map((x) => ({
    key: `h-${x.id}`,
    pick: { kind: 'household', householdId: x.id, label: x.address },
    primary: x.address,
    secondary: `${x.community ? `${titleCase(x.community)} · ` : ''}${wardLabel(x.ward)} · ${x.n_voters} ${x.n_voters === 1 ? 'voter' : 'voters'}`,
  }));
  return [...h, ...v];
}

export function SearchBox({ onPick }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q, 300);
  const search = useSearch(debounced, open);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = toItems(search.data);
  const term = debounced.trim();
  const showList = open && term.length >= 2;

  useEffect(() => setActive(0), [search.data]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (it: Item) => {
    onPick(it.pick);
    setOpen(false);
    setQ(it.primary);
    inputRef.current?.blur();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (open) setOpen(false);
      else setQ('');
      return;
    }
    if (!showList || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[active];
      if (it) choose(it);
    }
  };

  return (
    <div className="search" ref={rootRef}>
      <svg className="search__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        className="search__input"
        placeholder="Search a name or address"
        aria-label="Search voters and addresses"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={showList && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {search.isFetching && (
        <span className="search__spin">
          <Spinner size={14} />
        </span>
      )}
      {showList && (
        <ul className="card search__list" id={listId} role="listbox" aria-label="Search results">
          {search.isError && <li className="search__msg search__msg--error">Search failed. Try again.</li>}
          {!search.isError && search.isPending && <li className="search__msg muted">Searching…</li>}
          {!search.isError && !search.isPending && items.length === 0 && (
            <li className="search__msg muted">No voters or addresses match “{term}”.</li>
          )}
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search__item${i === active ? ' search__item--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(it)}
            >
              <span className={`search__kind search__kind--${it.pick.kind}`} aria-hidden="true">
                {it.pick.kind === 'voter' ? 'V' : 'H'}
              </span>
              <span className="search__text">
                <span className="search__primary">{it.primary}</span>
                <span className="search__secondary muted">{it.secondary}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
