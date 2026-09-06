#!/usr/bin/env python3
"""Build a DEMO database of entirely fabricated residents, for screenshots, training and video.

    python3 demo/seed_demo.py --database-url postgresql://.../canvass_demo

Nothing here comes from the voters list. Street names and coordinates are real Middlesex Centre
open data (public), but every person, phone number and email is invented. That separation is the
point: anything recorded or shared from this database can go anywhere, and nothing about a real
elector is ever in a file we cannot recall.
"""
from __future__ import annotations

import argparse
import random
import uuid

import psycopg

# Deliberately fictional-sounding. These were checked by hand against the real list when written
# (no surname below appears in it); the script does NOT re-check, so if you add names, verify them.
FIRST = ["Alma", "Bertie", "Cormac", "Delia", "Eamon", "Fenna", "Gus", "Hattie", "Ivo", "Juno",
         "Kester", "Lorne", "Marnie", "Nils", "Orla", "Pim", "Quill", "Rosalind", "Sable", "Tobias",
         "Ursa", "Vesper", "Wendell", "Xanthe", "Yarrow", "Zeb"]
LAST = ["Ashgrove", "Bellweather", "Corncrake", "Dunmore", "Eastwick", "Fernbrake", "Goldhawk",
        "Harrowgate", "Inkpen", "Jessamine", "Kilnwood", "Larkspur", "Mossbank", "Nettlefold",
        "Oxley", "Pennyroyal", "Quarrington", "Rushmere", "Stonebarrow", "Thornapple"]
# Real public street names in Middlesex Centre, with plausible in-boundary coordinates.
STREETS = [
    ("GEORGE ST", "ILDERTON", "01", 43.0530, -81.3390),
    ("KING ST", "ILDERTON", "01", 43.0545, -81.3365),
    ("ELM ST", "ILDERTON", "01", 43.0512, -81.3402),
    ("GLENDON DR", "KOMOKA", "04", 42.9540, -81.4180),
    ("QUEEN ST", "KOMOKA", "04", 42.9562, -81.4210),
    ("JEFFERIES RD", "KOMOKA", "04", 42.9585, -81.4150),
    ("ILDERTON RD", "ARVA", "02", 43.0180, -81.2960),
    ("MEDWAY RD", "ARVA", "02", 43.0205, -81.2915),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", required=True)
    ap.add_argument("--households", type=int, default=48)
    args = ap.parse_args()
    rng = random.Random(20261026)  # deterministic: the same demo every time

    with psycopg.connect(args.database_url, autocommit=False) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM household")
        if (cur.fetchone() or [0])[0]:
            print("demo database already has households — refusing to double-seed")
            return 1

        cur.execute(
            "INSERT INTO import_run (source_label, voters_sha256, households_sha256, n_voters, n_households, finished_at)"
            " VALUES ('DEMO DATA — fabricated, not the voters list', 'demo', 'demo', 0, 0, now()) RETURNING id")
        run_id = (cur.fetchone() or [None])[0]

        n_voters = 0
        for i in range(args.households):
            street, community, ward, blat, blon = STREETS[i % len(STREETS)]
            num = 100 + i * 7
            name, stype = street.rsplit(" ", 1)
            hid = f"H-{community}-{i + 1:05d}"
            lat = blat + rng.uniform(-0.004, 0.004)
            lon = blon + rng.uniform(-0.006, 0.006)
            addr = f"{num} {street}"
            size = rng.choices([1, 2, 3, 4, 5], weights=[22, 40, 18, 14, 6])[0]
            cur.execute(
                """INSERT INTO household (id, import_run_id, ward, community, postal, locality, address,
                     property_address_raw, civic_num, street, street_type, lat, lon, addr_match,
                     record_quality, n_voters, street_sort, num_sort)
                   VALUES (%s,%s,%s,%s,'N0L 1X0',%s,%s,%s,%s,%s,%s,%s,%s,'exact','good',%s,%s,%s)""",
                (hid, run_id, ward, community, community.title(), addr, addr, str(num), name, stype,
                 lat, lon, size, f"{name} {stype}", num))
            surname = LAST[i % len(LAST)]
            for j in range(size):
                first = FIRST[(i * 3 + j) % len(FIRST)]
                cur.execute(
                    """INSERT INTO voter (import_run_id, household_id, ward, first_name, last_name,
                         display_name, full_name, name_raw, resident_class, mail_kind,
                         mail_same_property, mail_differs_real, record_quality, natural_key)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'resident','street',true,false,'good',%s)""",
                    (run_id, hid, ward, first, surname, f"{first} {surname}", f"{first} {surname}",
                     f"{surname.upper()}, {first.upper()}", f"demo|{hid}|{j}"))
                n_voters += 1

        cur.execute("UPDATE import_run SET n_voters=%s, n_households=%s WHERE id=%s",
                    (n_voters, args.households, run_id))
        conn.commit()
        print(f"seeded {args.households} fabricated households / {n_voters} fabricated residents")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
