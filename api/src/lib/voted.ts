/**
 * Matching the clerk's "who has voted" list to electors on the loaded voters list.
 *
 * Pure: it is handed the file (already parsed from JSON) and every voter in memory, and it returns
 * a plan — which voter rows to stamp, which to clear, and what it could not place. routes/voted.ts
 * fetches, audits and applies; nothing in here touches a database, so `test/voted.test.ts` covers
 * the matching rules without one.
 *
 * Why it is forgiving about the file's shape: there is no fixed export format for a voted list in
 * Ontario municipal elections. One clerk's office hands over a spreadsheet of "SURNAME, GIVEN" and
 * the property address, another a PDF somebody re-types, and the campaign is building its own JSON
 * from whichever it got. So `parseEntries` accepts an array (or an object wrapping one) of records
 * whose keys may be camelCase or snake_case, a single `name` or split `last_name`/`first_name`, an
 * optional address, and an optional `hasVoted` flag — and a dry run reports exactly what matched
 * before anything is written.
 *
 * Why the match is conservative: a wrong stamp tells a canvasser to skip somebody who has not
 * voted, which is the one mistake this feature exists to prevent. An entry that could be two
 * people is reported as ambiguous and left alone, never guessed.
 */
import { firstNameVariants } from './nicknames.js';

// ------------------------------------------------------------------ input

/** One record of the file, after the loose key spellings have been reduced to these. */
export interface VotedEntry {
  /** Position in the file, so an unmatched row can be found again. */
  index: number;
  voter_id?: string;
  natural_key?: string;
  name?: string;
  last_name?: string;
  first_name?: string;
  address?: string;
  /** False only when the file says so explicitly (`hasVoted: false`); a bare entry means voted. */
  voted: boolean;
  /** When they voted, if the file says; otherwise the import's own stamp is used. */
  voted_at?: string;
}

/** A voter row as the matcher needs it — a narrow read of `voter` joined to its `household`. */
export interface MatchableVoter {
  id: string;
  natural_key: string;
  first_name: string;
  last_name: string;
  full_name: string;
  name_raw: string;
  household_id: string;
  address: string;
  property_address_raw: string;
  civic_num: string | null;
  street: string | null;
  /** Already stamped. Optional: the plan does not need it, but the route's "would mark" counts do. */
  voted?: boolean;
}

export type MatchHow = 'id' | 'key' | 'name+address' | 'name' | 'name~address';

/**
 * Why an unplaced row could not be placed — the answer to "why are so many unmatched", row by
 * row and in total. `new_address`: nothing on our list lives at that address, so it is a house
 * the list did not have when it was exported. `new_at_door`: the door is ours but nobody of that
 * surname is at it — somebody moved in, or was added at revision. `given_name_differs`: the
 * surname is at that door but no given name agrees, which is a list revision or a spelling the
 * nickname table does not know. `surname_unknown`: no address to go on, and no such surname
 * anywhere. `no_name`: the row carried nothing to match on.
 */
export type UnmatchedWhy = 'new_address' | 'new_at_door' | 'given_name_differs' | 'surname_unknown' | 'no_name';

export type Outcome =
  | { kind: 'matched'; voter_id: string; how: MatchHow }
  | { kind: 'unmatched'; reason: 'no_candidate' | 'nothing_to_match_on'; why: UnmatchedWhy }
  | { kind: 'ambiguous'; candidates: number };

export interface EntryResult {
  index: number;
  /** Echoed back for the operator — their own file, never a row of ours. */
  name: string | null;
  address: string | null;
  outcome: Outcome;
}

export interface VotedPlan {
  results: EntryResult[];
  /** voter id → the entry that decided it (the last one in file order wins a repeat). */
  mark: Map<string, VotedEntry>;
  clear: Map<string, VotedEntry>;
  counts: {
    entries: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
    /** Matched on name alone while the file's address did NOT agree — worth a look. */
    address_differs: number;
    by_how: Record<MatchHow, number>;
    unmatched_by: Record<UnmatchedWhy, number>;
  };
}

const MAX_ENTRIES = 50_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Key spellings accepted for each field, lower-cased with `_`/`-`/spaces removed. */
const KEYS = {
  voter_id: ['voterid', 'voter', 'id', 'uuid'],
  natural_key: ['naturalkey', 'key'],
  name: ['name', 'fullname', 'elector', 'electorname', 'votername', 'nameraw'],
  last_name: ['lastname', 'surname', 'last', 'familyname'],
  first_name: ['firstname', 'givenname', 'given', 'first', 'givennames'],
  address: ['address', 'propertyaddress', 'civicaddress', 'streetaddress', 'qualifyingaddress', 'addr'],
  voted: ['hasvoted', 'voted', 'didvote', 'isvoted', 'ballotcast'],
  voted_at: ['votedat', 'voteddate', 'date', 'when', 'votedon', 'timestamp'],
} as const;

const flatKey = (k: string): string => k.toLowerCase().replace(/[\s_-]+/g, '');

function pickString(rec: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const [k, v] of Object.entries(rec)) {
    if (!names.includes(flatKey(k))) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickFlag(rec: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  for (const [k, v] of Object.entries(rec)) {
    if (!names.includes(flatKey(k))) continue;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['y', 'yes', 'true', '1', 'voted', 'x', '✓'].includes(s)) return true;
      if (['n', 'no', 'false', '0', 'not voted', ''].includes(s)) return false;
    }
  }
  return undefined;
}

/**
 * Reduce whatever JSON the operator uploaded to `VotedEntry[]`, or say why it cannot be.
 *
 * Accepts: a bare array; an object with one array under `voters`, `voted`, `entries`, `records`,
 * `data`, `rows` or `items`; items that are objects (keys as in KEYS) or plain strings (a name).
 */
export function parseEntries(raw: unknown): { entries: VotedEntry[]; exported_at?: string; error?: string } {
  let list: unknown;
  let exportedAt: string | undefined;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['voters', 'voted', 'entries', 'records', 'data', 'rows', 'items']) {
      if (Array.isArray(o[k])) {
        list = o[k];
        break;
      }
    }
    // An export's own timestamp (Intelivote writes `exported_at`) is the honest default stamp for
    // rows that carry no date: the file says who had voted as of then, not as of the upload.
    const at = pickString(o, ['exportedat', 'exported', 'generatedat', 'asof', 'asat', 'timestamp', 'date']);
    if (at && !Number.isNaN(Date.parse(at))) exportedAt = new Date(at).toISOString();
  }
  if (!Array.isArray(list)) return { entries: [], error: 'expected a JSON array of voters, or an object holding one' };
  if (list.length > MAX_ENTRIES) return { entries: [], error: `too many entries (${list.length}; the limit is ${MAX_ENTRIES})` };

  const entries: VotedEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item === 'string') {
      if (item.trim()) entries.push({ index: i, name: item.trim(), voted: true });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const voterId = pickString(rec, KEYS.voter_id);
    const e: VotedEntry = { index: i, voted: pickFlag(rec, KEYS.voted) ?? true };
    // `id` is only a voter id when it is one of ours; a clerk's own elector number is ignored
    // rather than mistaken for a key.
    if (voterId && UUID_RE.test(voterId)) e.voter_id = voterId.toLowerCase();
    const key = pickString(rec, KEYS.natural_key);
    if (key) e.natural_key = key;
    const name = pickString(rec, KEYS.name);
    if (name) e.name = name;
    const last = pickString(rec, KEYS.last_name);
    if (last) e.last_name = last;
    const first = pickString(rec, KEYS.first_name);
    if (first) e.first_name = first;
    const addr = pickString(rec, KEYS.address);
    if (addr) e.address = addr;
    const at = pickString(rec, KEYS.voted_at);
    if (at && !Number.isNaN(Date.parse(at))) e.voted_at = new Date(at).toISOString();
    entries.push(e);
  }
  return exportedAt ? { entries, exported_at: exportedAt } : { entries };
}

// ------------------------------------------------------------------ normalisation

/** Upper-case ASCII letters and digits separated by single spaces; accents and punctuation gone. */
export function norm(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);

/** Split a typed name into the surname and the first given name, the two tokens the list indexes on. */
export function splitName(
  e: Pick<VotedEntry, 'name' | 'last_name' | 'first_name'>,
): { last: string; first: string | null; given: string[] } | null {
  const givenOf = (s: string): string[] => norm(s).split(' ').filter((t) => t && !SUFFIXES.has(t));
  if (e.last_name) {
    const last = norm(e.last_name);
    if (!last) return null;
    const given = givenOf(e.first_name ?? '');
    return { last, first: given[0] ?? null, given };
  }
  if (!e.name) return null;
  const comma = e.name.indexOf(',');
  if (comma >= 0) {
    // "ADAMS, JEFF JOHN" — the list's own `name_raw` shape.
    const last = norm(e.name.slice(0, comma));
    const given = givenOf(e.name.slice(comma + 1));
    return last ? { last, first: given[0] ?? null, given } : null;
  }
  const tokens = givenOf(e.name);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return { last: tokens[0] as string, first: null, given: [] };
  return { last: tokens[tokens.length - 1] as string, first: tokens[0] as string, given: tokens.slice(0, -1) };
}

/** A voter's given names as the list wrote them: everything after the comma of `name_raw`. */
function givenOfVoter(v: Pick<MatchableVoter, 'name_raw' | 'first_name'>): string[] {
  const comma = v.name_raw.indexOf(',');
  const src = comma >= 0 ? v.name_raw.slice(comma + 1) : v.first_name;
  return norm(src).split(' ').filter((t) => t && !SUFFIXES.has(t));
}

/**
 * Two people with the same surname and first given name at one door — a parent and child, usually
 * — can still be told apart when the file carries the full given names ("SMITH, JOHN A" and
 * "SMITH, JOHN B"). Returns the one candidate whose given names are exactly the file's, or null
 * when that does not single anyone out (then the row stays ambiguous).
 */
function refineByGivenNames(candidates: MatchableVoter[], given: string[]): MatchableVoter | null {
  // One token still discriminates: "LARKSPUR, ORLA" beside "LARKSPUR, ORLA JUNE" at one door is two
  // people, and the clerk's file writes names exactly as the list does — it is the same list.
  if (given.length === 0) return null;
  const want = given.join(' ');
  const exact = candidates.filter((v) => givenOfVoter(v).join(' ') === want);
  return exact.length === 1 ? (exact[0] as MatchableVoter) : null;
}

/** The leading civic number of a typed address, if any ("21584 Adelaide St N" → "21584"). */
const civicOf = (a: string): string | null => /^(\d+)/.exec(a)?.[1] ?? null;

/**
 * Does the file's address name this household? Exact (normalised) against either stored form
 * first; failing that, the same civic number and every word of the street name present — which
 * is what survives "ST." vs "ST", a missing "N", or a unit written differently.
 */
export function addressMatches(typed: string, v: Pick<MatchableVoter, 'address' | 'property_address_raw' | 'civic_num' | 'street'>): boolean {
  const a = norm(typed);
  if (!a) return false;
  if (a === norm(v.address) || a === norm(v.property_address_raw)) return true;
  const num = civicOf(a);
  if (!num || !v.civic_num || norm(v.civic_num) !== num) return false;
  const streetWords = norm(v.street).split(' ').filter(Boolean);
  if (streetWords.length === 0) return false;
  const typedWords = new Set(a.split(' '));
  return streetWords.every((w) => typedWords.has(w));
}

// ------------------------------------------------------------------ the plan

interface Index {
  byId: Map<string, MatchableVoter>;
  byKey: Map<string, MatchableVoter>;
  /** `LAST|FIRST` → voters; FIRST is the first token of the stored given names. */
  byName: Map<string, MatchableVoter[]>;
  /** `LAST` → voters, for a surname-only entry or a given name that only appears among the middle names. */
  byLast: Map<string, MatchableVoter[]>;
  /** One voter per household, as the address to test an unplaced row against (why it failed). */
  households: MatchableVoter[];
  /** `CIVIC` → the households with that civic number, so an address lookup is not 7k tests. */
  byCivic: Map<string, MatchableVoter[]>;
}

export function indexVoters(voters: MatchableVoter[]): Index {
  const byId = new Map<string, MatchableVoter>();
  const byKey = new Map<string, MatchableVoter>();
  const byName = new Map<string, MatchableVoter[]>();
  const byLast = new Map<string, MatchableVoter[]>();
  const seenHousehold = new Set<string>();
  const households: MatchableVoter[] = [];
  const byCivic = new Map<string, MatchableVoter[]>();
  const push = (m: Map<string, MatchableVoter[]>, k: string, v: MatchableVoter) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const v of voters) {
    byId.set(v.id.toLowerCase(), v);
    byKey.set(v.natural_key, v);
    const last = norm(v.last_name);
    const first = norm(v.first_name).split(' ')[0] ?? '';
    push(byName, `${last}|${first}`, v);
    push(byLast, last, v);
    if (!seenHousehold.has(v.household_id)) {
      seenHousehold.add(v.household_id);
      households.push(v);
      if (v.civic_num) push(byCivic, norm(v.civic_num), v);
    }
  }
  return { byId, byKey, byName, byLast, households, byCivic };
}

/** The households on our list at a typed address (normally one; several for an unnumbered road). */
function householdsAt(idx: Index, typed: string): Set<string> {
  const out = new Set<string>();
  const civic = civicOf(norm(typed));
  const pool = civic ? (idx.byCivic.get(civic) ?? []) : idx.households;
  for (const h of pool) if (addressMatches(typed, h)) out.add(h.household_id);
  return out;
}

/** Why a row with no candidate could not be placed (see UnmatchedWhy). */
function whyUnmatched(idx: Index, e: VotedEntry, last: string): UnmatchedWhy {
  if (!e.address) return 'surname_unknown';
  const doors = householdsAt(idx, e.address);
  if (doors.size === 0) return 'new_address';
  const surnameAtDoor = (idx.byLast.get(last) ?? []).some((v) => doors.has(v.household_id));
  return surnameAtDoor ? 'given_name_differs' : 'new_at_door';
}

/** The voters an entry's name could mean, widening step by step and stopping at the first step that finds anyone. */
function nameCandidates(idx: Index, last: string, first: string | null): MatchableVoter[] {
  const surname = idx.byLast.get(last) ?? [];
  if (surname.length === 0) return [];
  if (!first) return surname;
  const exact = idx.byName.get(`${last}|${first}`);
  if (exact && exact.length) return exact;
  // "JOHN ADAMS" for a voter listed as "ADAMS, JEFF JOHN" — the given name is among the middle names.
  const anyToken = surname.filter((v) => norm(v.full_name).split(' ').includes(first));
  if (anyToken.length) return anyToken;
  // "BOB" for "ROBERT" and the like (lib/nicknames.ts).
  const variants = new Set(firstNameVariants(first.toLowerCase()).map((n) => n.toUpperCase()));
  variants.delete(first);
  if (variants.size === 0) return [];
  return surname.filter((v) => norm(v.full_name).split(' ').some((t) => variants.has(t)));
}

export function planVotedImport(entries: VotedEntry[], voters: MatchableVoter[]): VotedPlan {
  const idx = indexVoters(voters);
  const results: EntryResult[] = [];
  const mark = new Map<string, VotedEntry>();
  const clear = new Map<string, VotedEntry>();
  const counts: VotedPlan['counts'] = {
    entries: entries.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    address_differs: 0,
    by_how: { id: 0, key: 0, 'name+address': 0, name: 0, 'name~address': 0 },
    unmatched_by: { new_address: 0, new_at_door: 0, given_name_differs: 0, surname_unknown: 0, no_name: 0 },
  };

  for (const e of entries) {
    const outcome = resolve(idx, e);
    if (outcome.kind === 'unmatched') counts.unmatched_by[outcome.why]++;
    const label = e.name ?? [e.last_name, e.first_name].filter(Boolean).join(', ');
    results.push({ index: e.index, name: label || null, address: e.address ?? null, outcome });
    if (outcome.kind === 'matched') {
      counts.matched++;
      counts.by_how[outcome.how]++;
      if (outcome.how === 'name~address') counts.address_differs++;
      // The same person twice in one file: the later line decides, and is counted once.
      mark.delete(outcome.voter_id);
      clear.delete(outcome.voter_id);
      (e.voted ? mark : clear).set(outcome.voter_id, e);
    } else if (outcome.kind === 'ambiguous') counts.ambiguous++;
    else counts.unmatched++;
  }
  return { results, mark, clear, counts };
}

function resolve(idx: Index, e: VotedEntry): Outcome {
  if (e.voter_id) {
    const v = idx.byId.get(e.voter_id);
    return v ? { kind: 'matched', voter_id: v.id, how: 'id' } : { kind: 'unmatched', reason: 'no_candidate', why: 'no_name' };
  }
  if (e.natural_key) {
    const v = idx.byKey.get(e.natural_key);
    if (v) return { kind: 'matched', voter_id: v.id, how: 'key' };
    // A key that no longer exists falls through to the name — the diff re-import re-keys voters
    // whose address spelling changed, and the file may predate that.
  }
  const parts = splitName(e);
  if (!parts) return { kind: 'unmatched', reason: 'nothing_to_match_on', why: 'no_name' };
  const candidates = nameCandidates(idx, parts.last, parts.first);
  if (candidates.length === 0) return { kind: 'unmatched', reason: 'no_candidate', why: whyUnmatched(idx, e, parts.last) };

  if (e.address) {
    const atAddress = candidates.filter((v) => addressMatches(e.address as string, v));
    if (atAddress.length === 1) return { kind: 'matched', voter_id: (atAddress[0] as MatchableVoter).id, how: 'name+address' };
    if (atAddress.length > 1) {
      const one = refineByGivenNames(atAddress, parts.given);
      return one ? { kind: 'matched', voter_id: one.id, how: 'name+address' } : { kind: 'ambiguous', candidates: atAddress.length };
    }
    // Nobody of that name at that address. One person of that name on the whole list is still
    // them — the clerk's address formatting is not ours — but it is flagged, not silent.
    if (candidates.length === 1) return { kind: 'matched', voter_id: (candidates[0] as MatchableVoter).id, how: 'name~address' };
    return { kind: 'ambiguous', candidates: candidates.length };
  }
  if (candidates.length === 1) return { kind: 'matched', voter_id: (candidates[0] as MatchableVoter).id, how: 'name' };
  // Two of the same name at the SAME door (a parent and child, say) cannot be told apart without
  // more than a name; two at different doors need the address the file did not give. The full
  // given names are the one more thing a file may carry.
  const one = refineByGivenNames(candidates, parts.given);
  return one ? { kind: 'matched', voter_id: one.id, how: 'name' } : { kind: 'ambiguous', candidates: candidates.length };
}
