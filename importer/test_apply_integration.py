"""Integration test for `import.py --diff --apply`, against a throwaway copy of canvass_test.

    CANVASS_TEST_DESTRUCTIVE=1 \\
    IMPORT_TEST_ADMIN_URL=postgresql://canvass:$POSTGRES_PASSWORD@localhost:5443/postgres \\
      python3 -m pytest -q test_apply_integration.py

Skipped unless both are set. It creates `canvass_difftest` from `canvass_test` as a template, seeds
real canvass work into it, applies a deliberately awkward changed list, and asserts every piece of
that work is still attached to the same STREET ADDRESS — the only thing a volunteer would recognise.
Then it drops the copy. It refuses to run if either name is `canvass`.

The unit tests in test_diff.py prove the plan is right. This proves the SQL does what the plan says,
on the real 7,140-household list, which is the part a pure test cannot reach.
"""
from __future__ import annotations

import csv
import importlib.util
import os
import re
import sys
import uuid
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

import psycopg
import pytest

from diff import norm_address

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("CANVASS_DATA_DIR", HERE.parent / "data"))
TEMPLATE = os.environ.get("IMPORT_TEST_TEMPLATE", "canvass_test")
CLONE = "canvass_difftest"
ADMIN_URL = os.environ.get("IMPORT_TEST_ADMIN_URL")

# The same rail the API suite has, for the same reason: a test once wiped a live admin account.
if "canvass" in (TEMPLATE, CLONE):
    raise RuntimeError("refusing: this test must never template from or write to the database named `canvass`")

pytestmark = pytest.mark.skipif(
    os.environ.get("CANVASS_TEST_DESTRUCTIVE") != "1" or not ADMIN_URL,
    reason="set CANVASS_TEST_DESTRUCTIVE=1 and IMPORT_TEST_ADMIN_URL to run",
)

# `import` is a keyword, so the importer is loaded by path. It must be registered in sys.modules
# BEFORE it executes: @dataclass resolves postponed annotations through sys.modules[cls.__module__],
# and an unregistered module there is None.
_spec = importlib.util.spec_from_file_location("canvass_import", HERE / "import.py")
importer = importlib.util.module_from_spec(_spec)
sys.modules["canvass_import"] = importer
_spec.loader.exec_module(importer)

HID = re.compile(r"^H-([A-Z]+)-(\d+)$")

# Tables whose rows keep a household alive. Mirrors HOUSEHOLD_REFERENCES in import.py; used only to
# choose a house that is genuinely unreferenced in the clone, so "it was deleted" is a real assertion.
REFERENCING = ("contact", "sign", "voter_contact", "turf_household", "public_request")


# ----------------------------------------------------------------------------- fixtures

@pytest.fixture
def clone_url():
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{CLONE}"')
        admin.execute(f'CREATE DATABASE "{CLONE}" TEMPLATE "{TEMPLATE}"')
    try:
        yield urlparse(ADMIN_URL)._replace(path=f"/{CLONE}").geturl()
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{CLONE}" WITH (FORCE)')


def read(name: str) -> tuple[list[str], list[dict[str, str]]]:
    with open(DATA / name, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        return list(r.fieldnames or []), list(r)


def write(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def renumber(hh_rows: list[dict[str, str]], v_rows: list[dict[str, str]]) -> None:
    """Re-run the pipeline's id assignment on the changed list: per community, sequential in sorted
    address order. A changed list is only dangerous because the pipeline renumbers it, so the test
    list is renumbered the way a real re-export would be. Mutates the rows it is given — which is why
    the test only ever hands it COPIES."""
    by_slug: dict[str, list[dict[str, str]]] = defaultdict(list)
    for r in hh_rows:
        by_slug[HID.match(r["household_id"]).group(1)].append(r)
    remap: dict[str, str] = {}
    for slug, rows in by_slug.items():
        width = len(HID.match(rows[0]["household_id"]).group(2))
        for i, r in enumerate(sorted(rows, key=lambda r: norm_address(r["property_address"])), 1):
            remap[r["household_id"]] = f"H-{slug}-{i:0{width}d}"
    for r in hh_rows:
        r["household_id"] = remap[r["household_id"]]
    for v in v_rows:
        v["household_id"] = remap[v["household_id"]]


def unreferenced(cur, household_id: str) -> bool:
    for table in REFERENCING:
        cur.execute(f"SELECT 1 FROM {table} WHERE household_id = %s LIMIT 1", (household_id,))
        if cur.fetchone():
            return False
    return True


# ----------------------------------------------------------------------------- the test

def test_a_changed_list_keeps_every_piece_of_canvass_work_on_the_same_door(clone_url, tmp_path):
    # The originals are never mutated. Everything that describes "what was loaded" — the ids and
    # addresses the assertions check against — is read from them.
    hh_fields, orig_hh = read("households.csv")
    v_fields, orig_vs = read("voters_final.csv")
    voters_of: dict[str, list[dict[str, str]]] = defaultdict(list)
    for v in orig_vs:
        voters_of[v["household_id"]].append(v)

    # A busy community, in the order the pipeline numbers it.
    slug = max(
        (HID.match(r["household_id"]).group(1) for r in orig_hh if not r["household_id"].startswith("H-LEGAL")),
        key=lambda s: sum(1 for r in orig_hh if r["household_id"].startswith(f"H-{s}-")),
    )
    street = sorted((r for r in orig_hh if r["household_id"].startswith(f"H-{slug}-")),
                    key=lambda r: norm_address(r["property_address"]))
    multi = [r for r in street[60:] if len(voters_of[r["household_id"]]) >= 2]
    mover_from, mover_to = multi[0], multi[1]
    mover = voters_of[mover_from["household_id"]][0]
    respelled = street[20]

    with psycopg.connect(clone_url) as conn, conn.cursor() as cur:
        # Left the list, nothing cites it: must be genuinely unreferenced in the clone, or "it was
        # deleted" would be asserting the wrong thing.
        gone = next(r for r in street[30:60] if unreferenced(cur, r["household_id"]))
    kept_away = street[25]
    fixed = {r["household_id"] for r in (gone, kept_away, respelled, mover_from, mover_to)}

    # ---- build the changed list, on copies ----------------------------------------------------
    hh = [dict(r) for r in orig_hh if r["household_id"] not in (kept_away["household_id"], gone["household_id"])]
    vs = [dict(v) for v in orig_vs if v["household_id"] not in (kept_away["household_id"], gone["household_id"])]

    # A new house that sorts first in the community, so ids after it shift.
    new_house = dict(street[0], household_id=f"H-{slug}-99999", property_address="0 AAAA DIFFTEST RD",
                     address_clean="0 AAAA DIFFTEST RD", num="0", street="AAAA DIFFTEST", type="RD",
                     dir="", unit="", n_voters="1")
    hh.append(new_house)
    vs.append(dict(voters_of[street[0]["household_id"]][0], household_id=new_house["household_id"],
                   last_name="Difftest", last_name_clean="Difftest", first_names="Newcomer",
                   first_name="Newcomer", display_name="Newcomer Difftest", full_name="Newcomer Difftest",
                   property_address="0 AAAA DIFFTEST RD"))

    # The same door, punctuated differently — in the household row and every voter row.
    respelled_addr = respelled["property_address"] + "."
    for r in hh:
        if r["household_id"] == respelled["household_id"]:
            r["property_address"] = respelled_addr
    for v in vs:
        if v["household_id"] == respelled["household_id"]:
            v["property_address"] = respelled_addr

    # One person moves to another house on the list.
    for v in vs:
        if (v["household_id"] == mover_from["household_id"] and v["last_name"] == mover["last_name"]
                and v["first_names"] == mover["first_names"]):
            v["household_id"] = mover_to["household_id"]
            v["property_address"] = mover_to["property_address"]
            break
    for r in hh:
        if r["household_id"] == mover_from["household_id"]:
            r["n_voters"] = str(int(r["n_voters"]) - 1)
        elif r["household_id"] == mover_to["household_id"]:
            r["n_voters"] = str(int(r["n_voters"]) + 1)

    renumber(hh, vs)

    # Seed the house the renumbering actually moved. Chosen AFTER renumbering, because a fixed
    # position can land back on its own old id and then the trap is not being tested at all.
    new_id_at = {norm_address(r["property_address"]): r["household_id"] for r in hh}
    shifted = next(
        r for r in street[1:]
        if r["household_id"] not in fixed
        and new_id_at.get(norm_address(r["property_address"])) not in (None, r["household_id"])
    )
    assert new_id_at[norm_address(shifted["property_address"])] != shifted["household_id"]

    # ---- seed real canvass work into the copy, under the ORIGINAL ids -------------------------
    seeded: dict[str, str] = {}
    with psycopg.connect(clone_url) as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO app_user (email, name, role) VALUES (%s, 'Diff Test', 'organizer') RETURNING id",
                    (f"difftest+{uuid.uuid4().hex[:8]}@test.local",))
        user_id = cur.fetchone()[0]
        cur.execute("INSERT INTO turf (name) VALUES ('diff test turf') RETURNING id")
        turf_id = cur.fetchone()[0]

        cur.execute("SELECT id FROM voter WHERE household_id = %s ORDER BY natural_key LIMIT 1",
                    (shifted["household_id"],))
        shifted_voter = cur.fetchone()[0]
        cur.execute("SELECT id FROM voter WHERE household_id = %s ORDER BY natural_key LIMIT 1",
                    (respelled["household_id"],))
        respelled_voter = cur.fetchone()[0]

        def one(sql: str, params: tuple) -> str:
            cur.execute(sql + " RETURNING id", params)
            return str(cur.fetchone()[0])

        seeded["door contact"] = one(
            "INSERT INTO contact (household_id, user_id, result) VALUES (%s, %s, 'spoke')",
            (shifted["household_id"], user_id))
        seeded["named contact"] = one(
            "INSERT INTO contact (household_id, voter_id, user_id, result) VALUES (%s, %s, %s, 'spoke')",
            (shifted["household_id"], shifted_voter, user_id))
        seeded["kept contact"] = one(
            "INSERT INTO contact (household_id, user_id, result) VALUES (%s, %s, 'not_home')",
            (kept_away["household_id"], user_id))
        seeded["sign"] = one(
            "INSERT INTO sign (household_id, status) VALUES (%s, 'placed')", (shifted["household_id"],))
        seeded["phone"] = one(
            "INSERT INTO voter_contact (household_id, voter_id, channel, value) VALUES (%s, %s, 'phone', %s)",
            (shifted["household_id"], shifted_voter, "+15195550100"))
        seeded["respelled email"] = one(
            "INSERT INTO voter_contact (household_id, voter_id, channel, value) VALUES (%s, %s, 'email', %s)",
            (respelled["household_id"], respelled_voter, "difftest@example.invalid"))
        cur.execute("INSERT INTO turf_household (turf_id, household_id) VALUES (%s, %s)",
                    (turf_id, shifted["household_id"]))
        cur.execute("SELECT count(*) FROM import_run")
        runs_before = cur.fetchone()[0]
        cur.execute("SELECT id FROM household")
        ids_before = {r[0] for r in cur.fetchall()}
        conn.commit()

    write(tmp_path / "households.csv", hh_fields, hh)
    write(tmp_path / "voters_final.csv", v_fields, vs)
    argv = ["--voters", str(tmp_path / "voters_final.csv"), "--households", str(tmp_path / "households.csv"),
            "--label", "diff integration test", "--database-url", clone_url, "--diff"]

    # ---- a dry run writes nothing -------------------------------------------------------------
    assert importer.main(argv) == 0
    with psycopg.connect(clone_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM import_run")
        assert cur.fetchone()[0] == runs_before, "a dry run must not record an import"
        cur.execute("SELECT id FROM household")
        assert {r[0] for r in cur.fetchall()} == ids_before, "a dry run must not change a single household"

    # ---- apply --------------------------------------------------------------------------------
    assert importer.main(argv + ["--apply"]) == 0

    with psycopg.connect(clone_url) as conn, conn.cursor() as cur:
        def address_of(table: str, row_id: str) -> str:
            cur.execute(f"SELECT h.property_address_raw FROM {table} t JOIN household h ON h.id = t.household_id "
                        f"WHERE t.id = %s", (row_id,))
            row = cur.fetchone()
            assert row, f"{table} {row_id} did not survive the re-import"
            return row[0]

        # THE assertion: canvass work is still at the door it was recorded at, even though the
        # export renumbered that door.
        assert address_of("contact", seeded["door contact"]) == shifted["property_address"]
        assert address_of("contact", seeded["named contact"]) == shifted["property_address"]
        assert address_of("sign", seeded["sign"]) == shifted["property_address"]
        assert address_of("voter_contact", seeded["phone"]) == shifted["property_address"]
        cur.execute("SELECT h.property_address_raw FROM turf_household th JOIN household h ON h.id = th.household_id "
                    "WHERE th.turf_id = %s", (turf_id,))
        assert cur.fetchone()[0] == shifted["property_address"], "turf membership moved to another door"

        # The renumbered door kept its database id.
        cur.execute("SELECT id FROM household WHERE property_address_raw = %s", (shifted["property_address"],))
        assert cur.fetchone()[0] == shifted["household_id"]

        # A contact that named a person still names that person, at that door.
        cur.execute("SELECT v.id, h.property_address_raw FROM contact c JOIN voter v ON v.id = c.voter_id "
                    "JOIN household h ON h.id = v.household_id WHERE c.id = %s", (seeded["named contact"],))
        voter_id, addr = cur.fetchone()
        assert voter_id == shifted_voter and addr == shifted["property_address"]

        # The respelled door matched, and its voter was re-keyed rather than replaced.
        cur.execute("SELECT v.id, v.natural_key FROM voter_contact vc JOIN voter v ON v.id = vc.voter_id "
                    "WHERE vc.id = %s", (seeded["respelled email"],))
        voter_id, key = cur.fetchone()
        assert voter_id == respelled_voter, "a punctuation change must not replace the person"
        assert key.endswith(respelled_addr), "the stored key should move to the new spelling"

        # Left the list but cited: kept, with its contact. Left the list and uncited: gone.
        assert address_of("contact", seeded["kept contact"]) == kept_away["property_address"]
        cur.execute("SELECT count(*) FROM household WHERE id = %s", (gone["household_id"],))
        assert cur.fetchone()[0] == 0, "an unreferenced house that left the list should be deleted"

        # The new house exists under an id nobody has ever held.
        cur.execute("SELECT id FROM household WHERE property_address_raw = '0 AAAA DIFFTEST RD'")
        new_id = cur.fetchone()[0]
        assert new_id not in ids_before, "a new house must never inherit an id another house held"

        # The mover is now listed at the new address.
        cur.execute("SELECT count(*) FROM voter v JOIN household h ON h.id = v.household_id "
                    "WHERE v.natural_key LIKE %s AND h.property_address_raw = %s",
                    (f"{mover['last_name'].strip().lower()}, {mover['first_names'].strip().lower()}|%",
                     mover_to["property_address"]))
        assert cur.fetchone()[0] >= 1

        cur.execute("SELECT count(*) FROM household")
        assert cur.fetchone()[0] == len(hh) + 1, "every list house plus the one kept for its contact"
        cur.execute("SELECT count(*) FROM import_run")
        assert cur.fetchone()[0] == runs_before + 1

    # Re-applying identical files is a no-op, not a second rewrite.
    assert importer.main(argv + ["--apply"]) == 0
    with psycopg.connect(clone_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM import_run")
        assert cur.fetchone()[0] == runs_before + 1, "applying identical files twice must not import twice"
