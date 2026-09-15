"""Plan a diff-based re-import of the voters list. Pure functions — no database, no files.

WHY THIS EXISTS
---------------
`import.py --force` replaces the list with `TRUNCATE household CASCADE`, which also empties every
table that references it: canvass results, lawn signs, doorstep consent records, turf membership,
the website sign-up queue. If the clerk issues a corrected list before election day, that is every
door knocked so far, gone. This module works out what actually changed so the importer can update
the list in place instead.

THE TRAP IT IS BUILT AROUND
---------------------------
`household.id` is NOT a stable identity. `pipeline/build_lists.py` assigns `H-{community}-{seq:05d}`
sequentially, in sort order of the grouping key — so one new house early in a community's sort
shifts the id of every house after it. A diff keyed on the id would silently re-attach canvass
results, signs and consent records to the wrong doors, which is strictly worse than `--force`: that
at least destroys them loudly.

So households are matched on the pipeline's own grouping key, `norm_address(property_address)`, and
a matched household KEEPS ITS DATABASE ID whatever the new export numbered it. Everything that points
at that id stays pointed at the same door.

The other rules, each one a way a naive diff loses or corrupts real work:

- **An id is never reused.** `audit_log.target` stores household ids as text. Handing a deleted
  house's id to a different new house would silently change what past audit rows are about. A new
  household whose pipeline id is already taken gets a fresh one past the highest ever seen.
- **Voters match on a normalised key.** The stored `natural_key` embeds the raw address string, so a
  whitespace or punctuation change between exports would make the same person look removed and
  re-added, detaching their canvass history. Case, whitespace and punctuation are normalised; names
  are only case- and whitespace-normalised, because "O'Brien" and "OBrien" may be two people.
- **Referenced rows are kept, not deleted.** A voter or household that has left the list but is
  cited by a contact, sign, consent record, turf or sign-up stays — history is not the list's to
  delete. Unreferenced leavers are deleted. A kept voter forces its household to be kept, because
  deleting the household would cascade to the voter anyway.
- **It never guesses identity.** A person at a new address looks like one removal and one addition,
  because nothing on the list says it is the same person. Likely moves are *reported*, never linked.

Dry-run and apply must produce the same ids, so every iteration that mints something is sorted.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Optional

# ----------------------------------------------------------------------------- normalisation

def squash(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def norm_address(s: Optional[str]) -> str:
    """The pipeline's `norm_street()`, copied rather than imported: the importer image does not
    contain `pipeline/`. Apostrophes and periods differ between sources ("ST JOHN'S DR" vs
    "ST JOHNS DR"), so they are removed. If the pipeline's rule changes, this must change with it or
    every household will look replaced."""
    return re.sub(r"[^A-Z0-9 ]", "", squash(s).upper())


SUFFIX = re.compile(r"#\d+$")
HID = re.compile(r"^H-([A-Z]+)-(\d+)$")


def name_part(last: str, first_names: str) -> str:
    return squash(f"{last.strip().lower()}, {first_names.strip().lower()}")


def base_key_from_stored(natural_key: str) -> str:
    """`lower(last), lower(first)|raw address[#n]` -> the normalised comparison key."""
    k = SUFFIX.sub("", natural_key)
    name, _, addr = k.partition("|")
    return f"{squash(name).lower()}|{norm_address(addr)}"


def base_key_from_row(r: dict[str, str]) -> str:
    return f"{name_part(r['last_name'], r['first_names'])}|{norm_address(r['property_address'])}"


# ----------------------------------------------------------------------------- inputs / outputs

@dataclass(frozen=True)
class ExistingHousehold:
    id: str
    property_address_raw: str


@dataclass(frozen=True)
class ExistingVoter:
    id: str
    natural_key: str
    household_id: str


@dataclass
class Plan:
    # households — keyed by the NEW export's household_id unless noted
    hh_map: dict[str, str] = field(default_factory=dict)          # new hid -> db id to write under
    hh_update: list[str] = field(default_factory=list)             # new hids that matched a row
    hh_insert: list[str] = field(default_factory=list)             # new hids with no row
    hh_delete: list[str] = field(default_factory=list)             # DB ids: left the list, unreferenced
    hh_keep: list[str] = field(default_factory=list)               # DB ids: left the list, referenced
    renumbered: int = 0                                            # matched, but the export renumbered it
    reissued: list[tuple[str, str]] = field(default_factory=list)  # (export id, fresh id) on collision

    # voters — keyed by the NEW export's natural_key unless noted
    v_update: dict[str, str] = field(default_factory=dict)         # new key -> existing voter id
    v_insert: list[str] = field(default_factory=list)              # new keys with no row
    v_delete: list[str] = field(default_factory=list)              # voter ids: left the list, unreferenced
    v_keep: list[str] = field(default_factory=list)                # voter ids: left the list, referenced
    v_rekey: dict[str, str] = field(default_factory=dict)          # stored key -> new key (same person)
    possible_moves: list[tuple[str, str, str]] = field(default_factory=list)  # (name, old addr, new addr)

    @property
    def unchanged_shape(self) -> bool:
        """Nothing enters or leaves the list. Field-level changes may still exist."""
        return not (self.hh_insert or self.hh_delete or self.hh_keep
                    or self.v_insert or self.v_delete or self.v_keep)


class DiffError(RuntimeError):
    """The inputs cannot be diffed safely. Raised rather than guessed around."""


# ----------------------------------------------------------------------------- planning

def _unique_by(items: Iterable, key, what: str) -> dict:
    out: dict = {}
    for it in items:
        k = key(it)
        if k in out:
            # Two houses normalising to one address means the match key is ambiguous, and an
            # ambiguous match is exactly how history ends up on the wrong door. Refuse.
            raise DiffError(f"two {what} share the address key {k!r}; cannot match safely")
        out[k] = it
    return out


def _mint(export_id: str, reserved: set[str]) -> str:
    """A fresh household id in the same community series, past everything ever reserved."""
    m = HID.match(export_id)
    if not m:
        raise DiffError(f"unrecognised household id {export_id!r}")
    slug, digits = m.group(1), m.group(2)
    width = len(digits)
    highest = max(
        (int(mm.group(2)) for rid in reserved if (mm := HID.match(rid)) and mm.group(1) == slug),
        default=0,
    )
    fresh = f"H-{slug}-{highest + 1:0{width}d}"
    reserved.add(fresh)
    return fresh


def plan_diff(
    existing_households: list[ExistingHousehold],
    existing_voters: list[ExistingVoter],
    new_household_rows: list[dict[str, str]],
    new_voter_rows: list[tuple[str, dict[str, str]]],
    referenced_households: set[str],
    referenced_voters: set[str],
) -> Plan:
    """Work out an in-place re-import.

    `new_voter_rows` pairs each export row with the natural_key the importer would store for it
    (`dedupe_keys` output). `referenced_*` are DB ids cited by anything that must survive — the
    caller decides what counts, in SQL, so this stays free of the schema.
    """
    plan = Plan()

    # ---- households ----------------------------------------------------------------
    existing_by_addr = _unique_by(existing_households, lambda h: norm_address(h.property_address_raw),
                                  "existing households")
    new_by_addr = _unique_by(new_household_rows, lambda r: norm_address(r["property_address"]),
                             "households in the new export")

    reserved = {h.id for h in existing_households}
    matched_db_ids: set[str] = set()
    needs_id: list[dict[str, str]] = []

    for addr in sorted(new_by_addr):
        row = new_by_addr[addr]
        new_hid = row["household_id"].strip()
        found = existing_by_addr.get(addr)
        if found:
            plan.hh_map[new_hid] = found.id
            plan.hh_update.append(new_hid)
            matched_db_ids.add(found.id)
            if found.id != new_hid:
                plan.renumbered += 1
        else:
            needs_id.append(row)

    # New households: keep the export's id only if no row has ever held it.
    for row in sorted(needs_id, key=lambda r: r["household_id"].strip()):
        new_hid = row["household_id"].strip()
        if new_hid in reserved:
            fresh = _mint(new_hid, reserved)
            plan.reissued.append((new_hid, fresh))
            plan.hh_map[new_hid] = fresh
        else:
            reserved.add(new_hid)
            plan.hh_map[new_hid] = new_hid
        plan.hh_insert.append(new_hid)

    leaving_households = sorted(h.id for h in existing_households if h.id not in matched_db_ids)

    # ---- voters --------------------------------------------------------------------
    # Grouped rather than keyed one-to-one: the list sometimes carries the same person twice at one
    # property (`#2`), and those suffixes follow file order, which can change between exports.
    # Pairing positionally inside a group makes a reshuffled duplicate a no-op instead of a
    # removal and an addition.
    existing_groups: dict[str, list[ExistingVoter]] = defaultdict(list)
    for v in sorted(existing_voters, key=lambda v: v.natural_key):
        existing_groups[base_key_from_stored(v.natural_key)].append(v)

    new_groups: dict[str, list[tuple[str, dict[str, str]]]] = defaultdict(list)
    for key, row in sorted(new_voter_rows, key=lambda kr: kr[0]):
        new_groups[base_key_from_row(row)].append((key, row))

    leaving_voters: list[ExistingVoter] = []
    arriving: list[tuple[str, dict[str, str]]] = []

    for base in sorted(set(existing_groups) | set(new_groups)):
        olds = existing_groups.get(base, [])
        news = new_groups.get(base, [])
        for old, (new_key, _row) in zip(olds, news):
            plan.v_update[new_key] = old.id
            if old.natural_key != new_key:
                plan.v_rekey[old.natural_key] = new_key
        leaving_voters.extend(olds[len(news):])
        arriving.extend(news[len(olds):])

    plan.v_insert = sorted(k for k, _r in arriving)

    kept_voter_households: set[str] = set()
    for v in sorted(leaving_voters, key=lambda v: v.id):
        if v.id in referenced_voters:
            plan.v_keep.append(v.id)
            kept_voter_households.add(v.household_id)
        else:
            plan.v_delete.append(v.id)

    # A household whose voter is being kept cannot be deleted: the household FK cascades to voter.
    for hid in leaving_households:
        if hid in referenced_households or hid in kept_voter_households:
            plan.hh_keep.append(hid)
        else:
            plan.hh_delete.append(hid)

    # ---- likely moves: reported, never linked ---------------------------------------
    leaving_by_name: dict[str, list[str]] = defaultdict(list)
    for v in leaving_voters:
        name, _, addr = SUFFIX.sub("", v.natural_key).partition("|")
        leaving_by_name[squash(name).lower()].append(addr)
    arriving_by_name: dict[str, list[str]] = defaultdict(list)
    for _key, row in arriving:
        arriving_by_name[name_part(row["last_name"], row["first_names"])].append(row["property_address"].strip())
    for name in sorted(leaving_by_name):
        olds, news = leaving_by_name[name], arriving_by_name.get(name, [])
        # Only an unambiguous one-for-one is worth mentioning; "John Smith" left two houses and
        # arrived at three is not a move anybody can act on.
        if len(olds) == 1 and len(news) == 1:
            plan.possible_moves.append((name, olds[0], news[0]))

    return plan
