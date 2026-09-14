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
  them, REFUSES if any exist, and names exactly what --force would delete. Phase 4 adds a proper
  diff-based re-import (new / removed / moved voters keyed on voter.natural_key) that preserves them.
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
    args = ap.parse_args(argv)

    if not args.database_url:
        ap.error("--database-url or $DATABASE_URL is required")

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
                        "  Re-run with --force to replace the list AND DELETE ALL OF THE ABOVE, or wait for "
                        "the Phase 4 diff-based re-import which preserves them.",
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
