#!/usr/bin/env python3
"""Load the pipeline CSVs (voters_final.csv + households.csv) into the canvass database.

    python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
        --label "voters list export 2026-09-03" --database-url $DATABASE_URL

Behaviour
- Computes the sha256 of both files and records an import_run row.
- Idempotent: if the most recent finished import_run has the same two hashes and the
  household table is populated, nothing is done (exit 0).
- A new file replaces the data: household/voter are truncated and reloaded inside ONE
  transaction, so readers never see a half-loaded list.
- Safety: TRUNCATE household CASCADE empties every table with a foreign key to household, so a
  re-import can destroy far more than the list — canvass contacts, lawn signs and their photo rows,
  doorstep phone/email records with their consent, and turf membership. The importer counts all of
  them, REFUSES if any exist, and names exactly what --force would delete.
- --diff (Phase 4) is the safe way to take a newer list. It matches households on the pipeline's
  address key — never on household.id, which the pipeline renumbers — and voters on a normalised
  natural_key, then updates the list IN PLACE so everything referencing it stays attached to the
  same door. Without --apply it is a dry run that writes nothing. The planning logic is in diff.py,
  pure and unit-tested; this file only fetches, prints and applies.
- Verifies row counts after loading and prints a summary (per ward, per community, legal,
  institutions, non-residents). Any mismatch raises and rolls the transaction back.

Field mapping is documented next to each column below and in README.md.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable, Optional

import psycopg

from diff import DiffError, ExistingHousehold, ExistingVoter, Plan, plan_diff

# ----------------------------------------------------------------------------- helpers

LEADING_INT = re.compile(r"^\s*(\d+)")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def nz(s: Optional[str]) -> Optional[str]:
    """Empty string -> None, otherwise stripped string."""
    if s is None:
        return None
    s = s.strip()
    return s if s else None


def to_bool(s: str, *, field: str) -> bool:
    v = (s or "").strip().lower()
    if v in ("true", "t", "1", "yes"):
        return True
    if v in ("false", "f", "0", "no", ""):
        return False
    raise ValueError(f"unexpected boolean value {s!r} in column {field}")


def to_int(s: str, default: int = 0) -> int:
    s = (s or "").strip()
    return int(s) if s else default


def to_float(s: str) -> Optional[float]:
    s = (s or "").strip()
    return float(s) if s else None


def leading_int(s: Optional[str]) -> Optional[int]:
    if not s:
        return None
    m = LEADING_INT.match(s)
    return int(m.group(1)) if m else None


def read_csv(path: str) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ----------------------------------------------------------------------------- mapping

HOUSEHOLD_COLS = (
    "id", "import_run_id", "ward", "community", "postal", "locality", "address",
    "property_address_raw", "civic_num", "street", "street_type", "street_dir", "unit",
    "lat", "lon", "addr_match", "record_quality", "is_legal", "is_institution",
    "n_voters", "n_nonresident", "n_po_box", "street_sort", "num_sort",
)

VOTER_COLS = (
    "import_run_id", "household_id", "ward", "first_name", "middle_names", "last_name",
    "suffix", "display_name", "full_name", "name_raw", "resident_class", "mail_kind",
    "mail_same_property", "mail_differs_real", "mailing_address", "mail_city", "mail_postal",
    "record_quality", "natural_key",
)


def map_household(r: dict[str, str], run_id: int) -> tuple:
    hid = r["household_id"].strip()
    addr_match = r["addr_match"].strip()
    hh_flag = (r.get("hh_flag") or "").lower()
    street, stype, sdir = nz(r["street"]), nz(r["type"]), nz(r["dir"])
    street_sort = " ".join(p for p in (street, stype, sdir) if p) or None
    is_legal = hid.startswith("H-LEGAL") or addr_match == "legal"
    return (
        hid,
        run_id,
        r["ward"].strip(),
        nz(r["community"]),
        nz(r["postal"]),
        nz(r["locality"]),
        r["address_clean"].strip(),
        r["property_address"].strip(),
        nz(r["num"]),
        street,
        stype,
        sdir,
        nz(r["unit"]),
        to_float(r["lat"]),
        to_float(r["lon"]),
        addr_match,
        r["record_quality"].strip(),
        is_legal,
        "institution" in hh_flag,
        to_int(r["n_voters"]),
        to_int(r["n_nonresident"]),
        to_int(r["n_mail_po_box"]),
        street_sort,
        leading_int(nz(r["num"])),
    )


def natural_key(r: dict[str, str]) -> str:
    # lower(last_name)||', '||lower(first_names)||'|'||property_address  (raw list columns)
    return f"{r['last_name'].strip().lower()}, {r['first_names'].strip().lower()}|{r['property_address'].strip()}"


def map_voter(r: dict[str, str], run_id: int, key: str) -> tuple:
    return (
        run_id,
        r["household_id"].strip(),
        r["ward"].strip(),
        r["first_name"].strip(),
        nz(r["middle_names"]),
        r["last_name_clean"].strip(),
        nz(r["suffix"]),
        r["display_name"].strip(),
        r["full_name"].strip(),
        f"{r['last_name'].strip()}, {r['first_names'].strip()}",
        r["resident_class"].strip(),
        r["mail_kind"].strip(),
        to_bool(r["mail_same_property"], field="mail_same_property"),
        to_bool(r["mail_differs_real"], field="mail_differs_real"),
        nz(r["mailing_address"]),
        nz(r["mail_city"]),
        nz(r["mail_postal"]),
        r["record_quality"].strip(),
        key,
    )


def dedupe_keys(rows: Iterable[dict[str, str]]) -> tuple[list[str], list[tuple[str, int]]]:
    """The voters list occasionally lists the same person twice at the same property
    (e.g. once with a PO box mailing address and once with the street address). The
    schema requires voter.natural_key to be UNIQUE, so the 2nd, 3rd ... occurrence gets a
    deterministic '#2', '#3' suffix (file order). Both rows are kept so counts match the CSV."""
    seen: Counter[str] = Counter()
    keys: list[str] = []
    dups: list[tuple[str, int]] = []
    for r in rows:
        k = natural_key(r)
        seen[k] += 1
        if seen[k] > 1:
            dups.append((k, seen[k]))
            k = f"{k}#{seen[k]}"
        keys.append(k)
    return keys, dups


# ----------------------------------------------------------------------------- diff re-import

# Tables whose rows must survive a re-import, and so whose references keep a household or voter
# alive. Deleting what they point at would either cascade the row away or NULL its pointer — losing
# which door it was about either way. match_candidate is deliberately absent: it is a rebuildable
# suggestion cache, and its natural_key is re-pointed rather than protected.
HOUSEHOLD_REFERENCES = (
    ("contact", "household_id"),
    ("sign", "household_id"),
    ("voter_contact", "household_id"),
    ("turf_household", "household_id"),
    ("public_request", "household_id"),
)
VOTER_REFERENCES = (
    ("contact", "voter_id"),
    ("voter_contact", "voter_id"),
)
# Counted before and after an apply. A single one going DOWN means the apply broke its own promise,
# and the whole transaction is rolled back rather than committed with a warning.
SURVIVORS = ("contact", "sign", "sign_photo", "voter_contact", "turf_household", "public_request")


def table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (table,))
    return bool(cur.fetchone()[0])


def fetch_referenced(cur) -> tuple[set[str], set[str]]:
    def collect(sources) -> set[str]:
        out: set[str] = set()
        for table, col in sources:
            if not table_exists(cur, table):
                continue
            # table/column names come from the literal tuples above, never from input
            cur.execute(f"SELECT DISTINCT {col}::text FROM {table} WHERE {col} IS NOT NULL")
            out.update(r[0] for r in cur.fetchall())
        return out
    return collect(HOUSEHOLD_REFERENCES), collect(VOTER_REFERENCES)


def survivor_counts(cur) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in SURVIVORS:
        if table_exists(cur, table):
            cur.execute(f"SELECT count(*) FROM {table}")
            counts[table] = cur.fetchone()[0]
    if table_exists(cur, "contact"):
        # A deleted voter NULLs contact.voter_id rather than deleting the contact, so the row count
        # alone would not notice a result losing the person it was about.
        cur.execute("SELECT count(*) FROM contact WHERE voter_id IS NOT NULL")
        counts["contact.voter_id"] = cur.fetchone()[0]
    return counts


def print_plan(plan: Plan, last, n_existing_voters: int) -> None:
    label = f"import_run #{last[0]} ({last[3]!r})" if last else "the loaded list"
    print(f"\ndiff against {label}:")
    print(f"  households {len(plan.hh_update):>8,} matched  "
          f"({plan.renumbered:,} renumbered by the new export — database ids kept)")
    print(f"             {len(plan.hh_insert):>8,} new      "
          f"({len(plan.reissued):,} given a fresh id because the export's was already taken)")
    print(f"             {len(plan.hh_delete):>8,} removed, deleted  (nothing references them)")
    print(f"             {len(plan.hh_keep):>8,} removed, KEPT     (still referenced by canvass work)")
    print(f"  voters     {len(plan.v_update):>8,} matched  "
          f"({len(plan.v_rekey):,} re-keyed: same person, address spelled differently)")
    print(f"             {len(plan.v_insert):>8,} new")
    print(f"             {len(plan.v_delete):>8,} removed, deleted")
    print(f"             {len(plan.v_keep):>8,} removed, KEPT     (a contact or consent record cites them)")
    if plan.possible_moves:
        # Reported, never linked: nothing on the list says it is the same person.
        print(f"  possible moves, reported only — nothing is linked: {len(plan.possible_moves):,}")
        for name, old, new in plan.possible_moves[:10]:
            print(f"      {name}: {old}  ->  {new}")
        if len(plan.possible_moves) > 10:
            print(f"      ... and {len(plan.possible_moves) - 10:,} more")
    if plan.hh_keep:
        print("  kept households (off the list, but canvass work points at them):")
        for hid in plan.hh_keep[:10]:
            print(f"      {hid}")
        if len(plan.hh_keep) > 10:
            print(f"      ... and {len(plan.hh_keep) - 10:,} more")
    if plan.v_keep or plan.hh_keep:
        print("  NOTE: kept rows still count in map and stats totals until someone deals with them.")


def apply_plan(cur, args, plan: Plan, hh_rows, v_rows, keys, voters_sha: str, households_sha: str) -> None:
    before = survivor_counts(cur)

    cur.execute(
        """INSERT INTO import_run (source_label, voters_sha256, households_sha256, notes)
           VALUES (%s, %s, %s, %s) RETURNING id""",
        (args.label, voters_sha, households_sha,
         f"diff apply; voters={os.path.basename(args.voters)} households={os.path.basename(args.households)}"),
    )
    run_id = cur.fetchone()[0]
    print(f"\nimport_run #{run_id} (diff apply)")

    # 1. Voters that left the list and that nothing cites.
    if plan.v_delete:
        cur.execute("DELETE FROM voter WHERE id = ANY(%s::uuid[])", (plan.v_delete,))

    # 2. Re-key in two phases. natural_key is UNIQUE and a re-key can chain (a #2 reshuffle), so
    #    every affected row is parked on a key that cannot collide before any final value is written.
    if plan.v_rekey:
        olds = sorted(plan.v_rekey)
        news = [plan.v_rekey[o] for o in olds]
        ids = [plan.v_update[n] for n in news]
        cur.execute("UPDATE voter SET natural_key = '~rekey~' || id::text WHERE id = ANY(%s::uuid[])", (ids,))
        cur.execute(
            "UPDATE voter v SET natural_key = m.new FROM unnest(%s::uuid[], %s::text[]) AS m(id, new) WHERE v.id = m.id",
            (ids, news),
        )
        # The subscriber ledger keys on natural_key — "the one identity that survives re-imports" —
        # so it follows the person to the new spelling, or an organiser's confirmed match orphans.
        if table_exists(cur, "subscriber_link"):
            cur.execute(
                """UPDATE subscriber_link t SET natural_key = m.new
                   FROM unnest(%s::text[], %s::text[]) AS m(old, new)
                   WHERE t.natural_key = m.old
                     AND NOT EXISTS (SELECT 1 FROM subscriber_link u
                                     WHERE u.source = t.source AND u.external_id = t.external_id
                                       AND u.natural_key = m.new)""",
                (olds, news),
            )
        if table_exists(cur, "match_candidate"):
            cur.execute(
                """UPDATE match_candidate t SET natural_key = m.new
                   FROM unnest(%s::text[], %s::text[]) AS m(old, new)
                   WHERE t.natural_key = m.old
                     AND NOT EXISTS (SELECT 1 FROM match_candidate u
                                     WHERE u.public_request_id = t.public_request_id
                                       AND u.natural_key = m.new)""",
                (olds, news),
            )

    # 3. Households: stage every row under the id the plan chose, then update what matched and
    #    insert what did not. A matched row is written under its EXISTING id, whatever the export
    #    numbered it — that is the whole defence against the renumbering trap.
    cols = ", ".join(HOUSEHOLD_COLS)
    cur.execute(f"CREATE TEMP TABLE stage_household ON COMMIT DROP AS SELECT {cols} FROM household WITH NO DATA")
    with cur.copy(f"COPY stage_household ({cols}) FROM STDIN") as cp:
        for r in hh_rows:
            row = list(map_household(r, run_id))
            row[0] = plan.hh_map[r["household_id"].strip()]
            cp.write_row(row)
    set_cols = ", ".join(f"{c} = s.{c}" for c in HOUSEHOLD_COLS if c != "id")
    cur.execute(f"UPDATE household h SET {set_cols} FROM stage_household s WHERE h.id = s.id")
    n_hh_updated = cur.rowcount
    cur.execute(
        f"INSERT INTO household ({cols}) SELECT {cols} FROM stage_household s "
        f"WHERE NOT EXISTS (SELECT 1 FROM household h WHERE h.id = s.id)"
    )
    n_hh_inserted = cur.rowcount

    # 4. Voters: matched ones keep their uuid (contact.voter_id points at it); new ones get one.
    #    household_id is routed through hh_map — the export's value is the export's numbering.
    vcols = ", ".join(VOTER_COLS)
    cur.execute(f"CREATE TEMP TABLE stage_voter ON COMMIT DROP AS SELECT id, {vcols} FROM voter WITH NO DATA")
    with cur.copy(f"COPY stage_voter (id, {vcols}) FROM STDIN") as cp:
        for r, key in zip(v_rows, keys):
            row = list(map_voter(r, run_id, key))
            row[1] = plan.hh_map[r["household_id"].strip()]  # VOTER_COLS[1] is household_id
            cp.write_row([plan.v_update.get(key), *row])
    vset = ", ".join(f"{c} = s.{c}" for c in VOTER_COLS)
    cur.execute(f"UPDATE voter v SET {vset} FROM stage_voter s WHERE s.id IS NOT NULL AND v.id = s.id")
    n_v_updated = cur.rowcount
    cur.execute(f"INSERT INTO voter ({vcols}) SELECT {vcols} FROM stage_voter WHERE id IS NULL")
    n_v_inserted = cur.rowcount

    # 5. Households that left the list and that nothing references. Their voters are already gone.
    if plan.hh_delete:
        cur.execute("DELETE FROM household WHERE id = ANY(%s)", (plan.hh_delete,))

    # 6. A kept household's n_voters describes the rows it still has, not the list it left.
    if plan.hh_keep:
        cur.execute(
            """UPDATE household h SET n_voters = (SELECT count(*) FROM voter v WHERE v.household_id = h.id)
               WHERE h.id = ANY(%s)""",
            (plan.hh_keep,),
        )

    # 7. Verify — any failure raises, and the connection's context manager rolls everything back.
    cur.execute("SELECT count(*) FROM household WHERE import_run_id = %s", (run_id,))
    if (n := cur.fetchone()[0]) != len(hh_rows):
        raise RuntimeError(f"household rows on this run: {n}, expected {len(hh_rows)}")
    cur.execute("SELECT count(*) FROM voter WHERE import_run_id = %s", (run_id,))
    if (n := cur.fetchone()[0]) != len(v_rows):
        raise RuntimeError(f"voter rows on this run: {n}, expected {len(v_rows)}")
    cur.execute("SELECT count(*) FROM household")
    if (n := cur.fetchone()[0]) != len(hh_rows) + len(plan.hh_keep):
        raise RuntimeError(f"households total {n}, expected {len(hh_rows)} + {len(plan.hh_keep)} kept")
    cur.execute("SELECT count(*) FROM voter")
    if (n := cur.fetchone()[0]) != len(v_rows) + len(plan.v_keep):
        raise RuntimeError(f"voters total {n}, expected {len(v_rows)} + {len(plan.v_keep)} kept")
    cur.execute(
        """SELECT count(*) FROM household h WHERE h.import_run_id = %s AND h.n_voters <>
             (SELECT count(*) FROM voter v WHERE v.household_id = h.id AND v.import_run_id = %s)""",
        (run_id, run_id),
    )
    if bad := cur.fetchone()[0]:
        raise RuntimeError(f"{bad} households whose n_voters does not match this list's voters")

    after = survivor_counts(cur)
    lost = {t: before[t] - after.get(t, 0) for t in before if after.get(t, 0) < before[t]}
    if lost:
        raise RuntimeError(f"REFUSING to commit: the apply would have lost canvass work {lost}")

    cur.execute(
        """UPDATE import_run SET finished_at = now(), n_voters = %s, n_households = %s,
                  notes = notes || %s WHERE id = %s""",
        (len(v_rows), len(hh_rows),
         f"; households updated {n_hh_updated} inserted {n_hh_inserted} deleted {len(plan.hh_delete)} "
         f"kept {len(plan.hh_keep)} renumbered {plan.renumbered} reissued {len(plan.reissued)}; "
         f"voters updated {n_v_updated} inserted {n_v_inserted} deleted {len(plan.v_delete)} "
         f"kept {len(plan.v_keep)} rekeyed {len(plan.v_rekey)}",
         run_id),
    )
    print(f"  households updated {n_hh_updated:,}, inserted {n_hh_inserted:,}, "
          f"deleted {len(plan.hh_delete):,}, kept {len(plan.hh_keep):,}")
    print(f"  voters     updated {n_v_updated:,}, inserted {n_v_inserted:,}, "
          f"deleted {len(plan.v_delete):,}, kept {len(plan.v_keep):,}")
    print("  every contact, sign, photo, consent record, turf membership and sign-up survived:")
    for t, n in after.items():
        print(f"      {t:<18} {before.get(t, 0):>7,} -> {n:,}")


def run_diff(conn, cur, args, hh_rows, v_rows, voters_sha, households_sha, n_existing, last) -> int:
    if n_existing == 0:
        print("REFUSING --diff: the database has no list loaded to compare against. Use a plain import.",
              file=sys.stderr)
        return 2

    cur.execute("SELECT id, property_address_raw FROM household")
    existing_hh = [ExistingHousehold(r[0], r[1]) for r in cur.fetchall()]
    cur.execute("SELECT id::text, natural_key, household_id FROM voter")
    existing_v = [ExistingVoter(r[0], r[1], r[2]) for r in cur.fetchall()]
    ref_hh, ref_v = fetch_referenced(cur)

    keys, _dups = dedupe_keys(v_rows)
    try:
        plan = plan_diff(existing_hh, existing_v, hh_rows, list(zip(keys, v_rows)), ref_hh, ref_v)
    except DiffError as e:
        print(f"REFUSING --diff: {e}", file=sys.stderr)
        return 2

    print_plan(plan, last, len(existing_v))

    if not args.apply:
        print("\nDRY RUN — nothing was written. Apply it with:  make import-apply LABEL=...")
        return 0

    apply_plan(cur, args, plan, hh_rows, v_rows, keys, voters_sha, households_sha)
    conn.commit()
    print("done.")
    return 0


# ----------------------------------------------------------------------------- main

@dataclass
class Summary:
    n_households: int
    n_voters: int


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--voters", required=True, help="voters_final.csv")
    ap.add_argument("--households", required=True, help="households.csv")
    ap.add_argument("--label", required=True, help='source label, e.g. "voters list export 2026-09-03"')
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"), help="postgresql://... (default: $DATABASE_URL)")
    ap.add_argument("--force", action="store_true", help="replace the list even though contacts/signs/consent records reference it (ALL are DELETED)")
    ap.add_argument("--diff", action="store_true", help="compare a newer list with the loaded one and report what would change; writes nothing without --apply")
    ap.add_argument("--apply", action="store_true", help="with --diff: apply the change IN PLACE, keeping contacts, signs, consent records and turfs")
    args = ap.parse_args(argv)

    if not args.database_url:
        ap.error("--database-url or $DATABASE_URL is required")
    if args.apply and not args.diff:
        ap.error("--apply only makes sense with --diff")
    if args.diff and args.force:
        # They are opposites: --force destroys what references the list, --diff exists to keep it.
        ap.error("--diff and --force cannot be combined")

    voters_sha = sha256_file(args.voters)
    households_sha = sha256_file(args.households)
    print(f"voters     {args.voters}  sha256={voters_sha}")
    print(f"households {args.households}  sha256={households_sha}")

    hh_rows = read_csv(args.households)
    v_rows = read_csv(args.voters)
    print(f"read {len(hh_rows):,} household rows, {len(v_rows):,} voter rows")

    # hh_flag values actually present (reported so the is_institution rule can be checked)
    flag_counts = Counter((r.get("hh_flag") or "").strip() for r in hh_rows)
    print("hh_flag values:")
    for val, n in flag_counts.most_common():
        print(f"  {n:6,}  {val!r}")

    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            # --- idempotency: same hashes as the latest finished run and data present -> no-op
            cur.execute(
                """SELECT id, voters_sha256, households_sha256, source_label, finished_at
                   FROM import_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1"""
            )
            last = cur.fetchone()
            cur.execute("SELECT count(*) FROM household")
            n_existing = cur.fetchone()[0]
            if last and last[1] == voters_sha and last[2] == households_sha and n_existing > 0:
                print(
                    f"no-op: import_run #{last[0]} ({last[3]!r}, finished {last[4]:%Y-%m-%d %H:%M}) "
                    f"already loaded files with identical sha256; {n_existing:,} households present."
                )
                return 0

            if args.diff:
                return run_diff(conn, cur, args, hh_rows, v_rows, voters_sha, households_sha, n_existing, last)

            # --- Safety: never silently destroy work that references the list.
            #
            # `TRUNCATE household CASCADE` empties EVERY table with a foreign key to household,
            # regardless of its ON DELETE rule — so it is not only contacts at risk. Counting just
            # `contact` (as this did originally) let --force quietly destroy lawn signs and the
            # doorstep consent records too. Everything that would go is counted and named here.
            dependents = [
                ("contact", "canvass results"),
                ("sign", "lawn signs"),
                ("sign_photo", "sign photos (files on the volume would be orphaned)"),
                ("voter_contact", "doorstep phone/email records, with their consent"),
                ("turf_household", "turf membership"),
                # Phase 8: public_request has an FK to household, so TRUNCATE CASCADE empties it and
                # (transitively) match_candidate. The website sign-up queue and every fuzzy
                # suggestion are destroyed; website-sourced rows re-sync within 5 minutes and
                # accepted links are re-applied from subscriber_link (which has NO FK and survives),
                # but DIRECT public-form submissions and their verbatim consent_text are gone for
                # good. Named here so an operator is never surprised by it.
                ("public_request", "website/public sign-ups (direct-form ones are NOT recoverable)"),
                ("match_candidate", "voter-match suggestions (rebuilt by the matcher after re-sync)"),
            ]
            counts: list[tuple[str, str, int]] = []
            for table, label in dependents:
                # A table may not exist yet on a database that predates its migration.
                cur.execute("SELECT to_regclass(%s) IS NOT NULL", (table,))
                if not cur.fetchone()[0]:
                    continue
                cur.execute(f"SELECT count(*) FROM {table}")  # table names are from the literal list above
                n = cur.fetchone()[0]
                if n:
                    counts.append((table, label, n))
            n_contacts = next((n for t, _l, n in counts if t == "contact"), 0)

            if n_existing > 0:
                if counts and not args.force:
                    print("REFUSING to re-import: replacing the list would destroy data that references it.",
                          file=sys.stderr)
                    for _t, label, n in counts:
                        print(f"    {n:>7,}  {label}", file=sys.stderr)
                    print(
                        "  Use the diff instead, which keeps all of it:  make import-diff  then  make import-apply\n"
                        "  (--force replaces the list AND DELETES ALL OF THE ABOVE.)",
                        file=sys.stderr,
                    )
                    return 2
                if counts:
                    print(f"replacing existing data ({n_existing:,} households) and DELETING:")
                    for _t, label, n in counts:
                        print(f"    {n:>7,}  {label}")
                    if any(t == "sign_photo" for t, _l, _n in counts):
                        print("  NOTE: sign photo FILES are not removed from the volume by this import; "
                              "their database rows go, so they become unreferenced. Clean them up separately.")
                else:
                    print(f"replacing existing data ({n_existing:,} households, nothing references it)")

            # --- single transaction from here on
            cur.execute(
                """INSERT INTO import_run (source_label, voters_sha256, households_sha256, notes)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                (args.label, voters_sha, households_sha,
                 f"voters={os.path.basename(args.voters)} households={os.path.basename(args.households)}"),
            )
            run_id = cur.fetchone()[0]
            print(f"import_run #{run_id}")

            if n_existing > 0 or n_contacts > 0:
                # Cascades to voter and to everything counted in the --force guard above.
                cur.execute("TRUNCATE household CASCADE")

            # households
            with cur.copy(f"COPY household ({', '.join(HOUSEHOLD_COLS)}) FROM STDIN") as cp:
                for r in hh_rows:
                    cp.write_row(map_household(r, run_id))

            # voters
            keys, dups = dedupe_keys(v_rows)
            if dups:
                print(f"{len(dups)} duplicate natural_key(s) in the voters list (kept, suffixed '#n'):")
                for k, n in dups:
                    print(f"  {k!r} -> #{n}")
            with cur.copy(f"COPY voter ({', '.join(VOTER_COLS)}) FROM STDIN") as cp:
                for r, key in zip(v_rows, keys):
                    cp.write_row(map_voter(r, run_id, key))

            # --- verify
            cur.execute("SELECT count(*) FROM household")
            n_hh = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM voter")
            n_v = cur.fetchone()[0]
            if n_hh != len(hh_rows) or n_v != len(v_rows):
                raise RuntimeError(f"count mismatch after load: household {n_hh} vs {len(hh_rows)}, voter {n_v} vs {len(v_rows)}")

            cur.execute(
                """SELECT count(*) FROM household h
                   WHERE h.n_voters <> (SELECT count(*) FROM voter v WHERE v.household_id = h.id)"""
            )
            bad = cur.fetchone()[0]
            if bad:
                raise RuntimeError(f"{bad} households whose n_voters does not match the loaded voters")

            cur.execute(
                """UPDATE import_run SET finished_at = now(), n_voters = %s, n_households = %s,
                          notes = notes || %s
                   WHERE id = %s""",
                (n_v, n_hh, f"; duplicate natural keys suffixed: {len(dups)}", run_id),
            )

            # --- summary (from the DB, i.e. what the API will serve)
            print()
            print(f"loaded {n_hh:,} households and {n_v:,} voters")
            cur.execute(
                """SELECT ward, count(*), sum(n_voters), sum(n_nonresident),
                          count(*) FILTER (WHERE is_legal), count(*) FILTER (WHERE is_institution)
                   FROM household GROUP BY ward ORDER BY ward"""
            )
            print(f"  {'ward':<10}{'households':>12}{'voters':>10}{'nonres':>8}{'legal':>7}{'inst':>6}")
            for ward, nh, nv, nnr, nl, ni in cur.fetchall():
                print(f"  {ward:<10}{nh:>12,}{nv:>10,}{nnr:>8,}{nl:>7,}{ni:>6,}")
            cur.execute(
                """SELECT coalesce(community, '(legal, no community)'), count(*), sum(n_voters), sum(n_nonresident)
                   FROM household GROUP BY community ORDER BY count(*) DESC"""
            )
            print(f"  {'community':<24}{'households':>12}{'voters':>10}{'nonres':>8}")
            for comm, nh, nv, nnr in cur.fetchall():
                print(f"  {comm:<24}{nh:>12,}{nv:>10,}{nnr:>8,}")
            cur.execute(
                """SELECT count(*) FILTER (WHERE is_legal), count(*) FILTER (WHERE is_institution),
                          count(*) FILTER (WHERE lat IS NOT NULL), sum(n_nonresident), sum(n_po_box)
                   FROM household"""
            )
            n_legal, n_inst, n_pts, n_nonres_hh, n_pobox = cur.fetchone()
            cur.execute("SELECT resident_class, count(*) FROM voter GROUP BY 1 ORDER BY 2 DESC")
            rc = dict(cur.fetchall())
            cur.execute("SELECT record_quality, count(*) FROM household GROUP BY 1 ORDER BY 2 DESC")
            rq = dict(cur.fetchall())
            print()
            print(f"  legal (no civic address) households : {n_legal:,}")
            print(f"  institution households (hh_flag)     : {n_inst:,}")
            print(f"  households with coordinates          : {n_pts:,}")
            print(f"  voters by resident_class             : {rc}")
            print(f"  household n_nonresident total        : {n_nonres_hh:,}  (pipeline counts non-resident + unknown)")
            print(f"  voters with PO box mailing           : {n_pobox:,}")
            print(f"  household record_quality             : {rq}")
        conn.commit()
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
