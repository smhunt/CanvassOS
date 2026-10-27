/**
 * Unit tests for the voted-list matcher (no database). The names here are invented; nothing is a
 * row of the real list.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressMatches, norm, parseEntries, planVotedImport, splitName, type MatchableVoter } from '../src/lib/voted.js';

let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function voter(p: Partial<MatchableVoter> & { first_name: string; last_name: string; address: string }): MatchableVoter {
  const num = /^(\d+)/.exec(p.address)?.[1] ?? null;
  const street = p.address.replace(/^\d+\s*/, '').replace(/\s+(ST|RD|DR|CRES|LN|AVE)(\s+[NSEW])?$/, '');
  const raw = `${p.last_name.toUpperCase()}, ${p.first_name.toUpperCase()}`;
  return {
    id: p.id ?? uuid(),
    natural_key: p.natural_key ?? `${raw.toLowerCase()}|${p.address}`,
    first_name: p.first_name,
    last_name: p.last_name,
    full_name: p.full_name ?? `${p.first_name} ${p.last_name}`,
    name_raw: p.name_raw ?? raw,
    household_id: p.household_id ?? `H-TEST-${p.address.replace(/\W+/g, '')}`,
    address: p.address,
    property_address_raw: p.property_address_raw ?? p.address,
    civic_num: p.civic_num ?? num,
    street: p.street ?? street,
  };
}

const LIST: MatchableVoter[] = [
  voter({ first_name: 'Alma', last_name: 'Ashgrove', address: '12 GEORGE ST' }),
  voter({ first_name: 'Bertie', last_name: 'Ashgrove', address: '12 GEORGE ST' }),
  voter({ first_name: 'Cormac', last_name: 'Dunmore', full_name: 'Cormac Robert Dunmore', address: '40 KING ST' }),
  voter({ first_name: 'Cormac', last_name: 'Dunmore', address: '7 ELM ST' }),
  voter({ first_name: 'Delia', last_name: 'Eastwick', address: '21584 ADELAIDE ST N', property_address_raw: '21584 ADELAIDE ST. N.' }),
  voter({ first_name: 'Robert', last_name: 'Fernbrake', address: '93 STONE FIELD LN UNIT 106', street: 'STONE FIELD' }),
  voter({ first_name: 'Juno', last_name: 'Goldhawk', address: '5 QUEEN ST' }),
  voter({ first_name: 'Juno', last_name: 'Goldhawk', address: '5 QUEEN ST' }), // the same name twice at one door (#2)
  // A parent and child: same surname, same first given name, same door, different middle names.
  voter({ first_name: 'Hattie Rose', last_name: 'Inkpen', name_raw: 'INKPEN, HATTIE ROSE', full_name: 'Hattie Rose Inkpen', address: '8 MEDWAY RD' }),
  voter({ first_name: 'Hattie May', last_name: 'Inkpen', name_raw: 'INKPEN, HATTIE MAY', full_name: 'Hattie May Inkpen', address: '8 MEDWAY RD' }),
  // And a pair the clerk's file writes as "LARKSPUR, ORLA" and "LARKSPUR, ORLA JUNE".
  voter({ first_name: 'Orla', last_name: 'Larkspur', name_raw: 'LARKSPUR, ORLA', address: '3 KING ST' }),
  voter({ first_name: 'Orla June', last_name: 'Larkspur', name_raw: 'LARKSPUR, ORLA JUNE', full_name: 'Orla June Larkspur', address: '3 KING ST' }),
];
const byName = (first: string, last: string, addr?: string) =>
  LIST.find((v) => v.first_name === first && v.last_name === last && (!addr || v.address === addr)) as MatchableVoter;

describe('voted.parseEntries', () => {
  it('takes a bare array, a wrapped array, snake_case, camelCase and plain strings', () => {
    const a = parseEntries([{ last_name: 'Ashgrove', first_name: 'Alma' }, 'Dunmore, Cormac']);
    assert.equal(a.error, undefined);
    assert.deepEqual(a.entries, [
      { index: 0, voted: true, last_name: 'Ashgrove', first_name: 'Alma' },
      { index: 1, voted: true, name: 'Dunmore, Cormac' },
    ]);
    const b = parseEntries({ voters: [{ lastName: 'Eastwick', firstName: 'Delia', propertyAddress: '21584 Adelaide St N', hasVoted: 'Y' }] });
    assert.deepEqual(b.entries, [{ index: 0, voted: true, last_name: 'Eastwick', first_name: 'Delia', address: '21584 Adelaide St N' }]);
  });

  it('reads an explicit not-voted flag, a date, our own ids, and ignores a clerk elector number', () => {
    const { entries } = parseEntries([
      { name: 'Alma Ashgrove', hasVoted: false },
      { name: 'Alma Ashgrove', voted: 'no' },
      { name: 'Alma Ashgrove', voted_at: '2026-10-17T14:00:00-04:00' },
      { voter_id: '00000000-0000-4000-8000-000000000001' },
      { id: '12345', name: 'Alma Ashgrove' },
      { natural_key: 'ashgrove, alma|12 GEORGE ST' },
    ]);
    assert.equal(entries[0]?.voted, false);
    assert.equal(entries[1]?.voted, false);
    assert.equal(entries[2]?.voted_at, '2026-10-17T18:00:00.000Z');
    assert.equal(entries[3]?.voter_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(entries[4]?.voter_id, undefined);
    assert.equal(entries[5]?.natural_key, 'ashgrove, alma|12 GEORGE ST');
  });

  it('refuses what is not a list', () => {
    assert.match(parseEntries({ hello: 1 }).error ?? '', /array/);
    assert.match(parseEntries('x').error ?? '', /array/);
    assert.equal(parseEntries([null, 7, '']).entries.length, 0);
  });
});

describe('voted.norm / splitName / addressMatches', () => {
  it('normalises case, accents and punctuation', () => {
    assert.equal(norm('  Côté-Smith, Jr. '), 'COTE SMITH JR');
    assert.equal(norm(null), '');
  });

  it('splits "LAST, FIRST MIDDLE", "First Last", split fields and a bare surname', () => {
    assert.deepEqual(splitName({ name: 'DUNMORE, CORMAC ROBERT' }), { last: 'DUNMORE', first: 'CORMAC', given: ['CORMAC', 'ROBERT'] });
    assert.deepEqual(splitName({ name: 'Cormac R. Dunmore Jr' }), { last: 'DUNMORE', first: 'CORMAC', given: ['CORMAC', 'R'] });
    assert.deepEqual(splitName({ last_name: 'Dunmore', first_name: 'Cormac Robert' }), { last: 'DUNMORE', first: 'CORMAC', given: ['CORMAC', 'ROBERT'] });
    assert.deepEqual(splitName({ name: 'Dunmore' }), { last: 'DUNMORE', first: null, given: [] });
    assert.equal(splitName({}), null);
  });

  it('reads an export wrapper: the array under `voters`, and its exported_at as the default stamp', () => {
    const r = parseEntries({
      source: 'Intelivote Election Manager – Candidate View',
      exported_at: '2026-10-27T17:52:16.781Z',
      totals: { voters: 2, voted: 1 },
      voters: [
        { id: '100001', name: 'ASHGROVE, ALMA ROSE', address: '12 GEORGE ST 4', voted: false, tagged: false },
        { id: '100002', name: 'DUNMORE, CORMAC', address: '40 KING ST', voted: true, tagged: false },
      ],
    });
    assert.equal(r.error, undefined);
    assert.equal(r.exported_at, '2026-10-27T17:52:16.781Z');
    assert.deepEqual(r.entries, [
      { index: 0, voted: false, name: 'ASHGROVE, ALMA ROSE', address: '12 GEORGE ST 4' },
      { index: 1, voted: true, name: 'DUNMORE, CORMAC', address: '40 KING ST' },
    ]);
    assert.equal(parseEntries([{ name: 'x' }]).exported_at, undefined);
  });

  it('matches an address exactly, through punctuation, and by civic number + street words', () => {
    const v = byName('Delia', 'Eastwick');
    assert.equal(addressMatches('21584 Adelaide St N', v), true);
    assert.equal(addressMatches('21584 ADELAIDE ST. N.', v), true);
    assert.equal(addressMatches('21584 Adelaide Street North', v), true); // civic + "ADELAIDE"
    assert.equal(addressMatches('21585 Adelaide St N', v), false);
    assert.equal(addressMatches('21584 King St', v), false);
    const unit = byName('Robert', 'Fernbrake');
    assert.equal(addressMatches('93 Stone Field Lane, Unit 106', unit), true);
    assert.equal(addressMatches('93 Stone Field Ln #106', unit), true);
  });
});

describe('voted.planVotedImport', () => {
  it('matches by id, by key, by name+address, and by name alone when the name is unique', () => {
    const alma = byName('Alma', 'Ashgrove');
    const plan = planVotedImport(
      parseEntries([
        { voter_id: alma.id },
        { natural_key: byName('Bertie', 'Ashgrove').natural_key },
        { name: 'Dunmore, Cormac', address: '7 Elm St' },
        { name: 'Delia Eastwick' },
      ]).entries,
      LIST,
    );
    assert.deepEqual(
      plan.results.map((r) => r.outcome),
      [
        { kind: 'matched', voter_id: alma.id, how: 'id' },
        { kind: 'matched', voter_id: byName('Bertie', 'Ashgrove').id, how: 'key' },
        { kind: 'matched', voter_id: byName('Cormac', 'Dunmore', '7 ELM ST').id, how: 'name+address' },
        { kind: 'matched', voter_id: byName('Delia', 'Eastwick').id, how: 'name' },
      ],
    );
    assert.equal(plan.counts.matched, 4);
    assert.equal(plan.mark.size, 4);
    assert.equal(plan.clear.size, 0);
  });

  it('never guesses between two people of one name: ambiguous without an address, placed with one', () => {
    const noAddr = planVotedImport(parseEntries([{ name: 'Cormac Dunmore' }]).entries, LIST);
    assert.deepEqual(noAddr.results[0]?.outcome, { kind: 'ambiguous', candidates: 2 });
    assert.equal(noAddr.mark.size, 0);
    const withAddr = planVotedImport(parseEntries([{ name: 'Cormac Dunmore', address: '40 King St' }]).entries, LIST);
    assert.equal(withAddr.results[0]?.outcome.kind, 'matched');
    // Two of the same name at the SAME door stay ambiguous even with the address.
    const twins = planVotedImport(parseEntries([{ name: 'Juno Goldhawk', address: '5 Queen St' }]).entries, LIST);
    assert.deepEqual(twins.results[0]?.outcome, { kind: 'ambiguous', candidates: 2 });
  });

  it('tells two people of one first name at one door apart by their full given names, and only then', () => {
    const full = planVotedImport(parseEntries([{ name: 'INKPEN, HATTIE MAY', address: '8 Medway Rd' }]).entries, LIST);
    assert.deepEqual(full.results[0]?.outcome, { kind: 'matched', voter_id: byName('Hattie May', 'Inkpen').id, how: 'name+address' });
    const noAddr = planVotedImport(parseEntries([{ name: 'INKPEN, HATTIE ROSE' }]).entries, LIST);
    assert.deepEqual(noAddr.results[0]?.outcome, { kind: 'matched', voter_id: byName('Hattie Rose', 'Inkpen').id, how: 'name' });
    // The first name alone, or a middle name neither of them has, singles nobody out.
    for (const name of ['INKPEN, HATTIE', 'INKPEN, HATTIE JANE']) {
      const r = planVotedImport(parseEntries([{ name, address: '8 Medway Rd' }]).entries, LIST);
      assert.deepEqual(r.results[0]?.outcome, { kind: 'ambiguous', candidates: 2 }, name);
    }
    // But "LARKSPUR, ORLA" is exactly one of the two Orla Larkspurs, as the list writes them.
    const one = planVotedImport(parseEntries([{ name: 'LARKSPUR, ORLA', address: '3 King St' }, { name: 'LARKSPUR, ORLA JUNE', address: '3 King St' }]).entries, LIST);
    assert.deepEqual(one.results.map((r) => (r.outcome as { voter_id?: string }).voter_id), [byName('Orla', 'Larkspur').id, byName('Orla June', 'Larkspur').id]);
  });

  it('flags a unique name whose address does not agree, rather than dropping or trusting it silently', () => {
    const plan = planVotedImport(parseEntries([{ name: 'Delia Eastwick', address: '1 Nowhere Rd' }]).entries, LIST);
    assert.equal(plan.results[0]?.outcome.kind, 'matched');
    assert.equal((plan.results[0]?.outcome as { how: string }).how, 'name~address');
    assert.equal(plan.counts.address_differs, 1);
  });

  it('finds a given name among the middle names and a nickname of it', () => {
    // "Robert Dunmore" is Cormac Robert Dunmore at 40 King — the only Dunmore with ROBERT in his name.
    const middle = planVotedImport(parseEntries([{ name: 'Robert Dunmore' }]).entries, LIST);
    assert.equal(middle.results[0]?.outcome.kind, 'matched');
    assert.equal((middle.results[0]?.outcome as { voter_id: string }).voter_id, byName('Cormac', 'Dunmore', '40 KING ST').id);
    const nick = planVotedImport(parseEntries([{ name: 'Bob Fernbrake' }]).entries, LIST);
    assert.equal(nick.results[0]?.outcome.kind, 'matched');
    assert.equal((nick.results[0]?.outcome as { voter_id: string }).voter_id, byName('Robert', 'Fernbrake').id);
  });

  it('reports unmatched rows with what the file said, and an explicit not-voted flag goes to clear', () => {
    const plan = planVotedImport(
      parseEntries([{ name: 'Nobody Here', address: '1 Main St' }, { name: 'Alma Ashgrove', hasVoted: false }, {}]).entries,
      LIST,
    );
    assert.deepEqual(plan.results[0], {
      index: 0,
      name: 'Nobody Here',
      address: '1 Main St',
      outcome: { kind: 'unmatched', reason: 'no_candidate' },
    });
    assert.deepEqual(plan.results[2]?.outcome, { kind: 'unmatched', reason: 'nothing_to_match_on' });
    assert.equal(plan.counts.unmatched, 2);
    assert.equal(plan.clear.size, 1);
    assert.equal(plan.mark.size, 0);
  });

  it('counts a person listed twice once, and lets the later line decide', () => {
    const plan = planVotedImport(parseEntries([{ name: 'Alma Ashgrove' }, { name: 'Alma Ashgrove', voted: false }]).entries, LIST);
    assert.equal(plan.counts.matched, 2);
    assert.equal(plan.mark.size, 0);
    assert.equal(plan.clear.size, 1);
  });
});
