#!/usr/bin/env python3
"""Rebuild the importer's inputs (voters_final.csv + households.csv) from the raw sources.

    python3 pipeline/build_lists.py \
        --xlsx ~/Code/election-website-2026/voter-data/voter-data-sep3.xlsx \
        --addresses ~/Code/election-website-2026/voter-data/Address.geojson \
        --out-dir data

Inputs
  xlsx        the clerk's list, 4 columns: Name / Property Address / Mailing Address (Single Line) / Ward
  addresses   Middlesex County open address points (we keep MUNCODE == MIDC)

Both outputs are personal information under the Municipal Elections Act — they are git-ignored,
and `make purge` shreds them after the election.

The original pipeline that produced these files was lost; this is a reconstruction from the same
raw inputs. Every derived column is documented at the function that produces it, and `--report`
prints the counts to compare against README.md.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable, Optional

# ----------------------------------------------------------------------------- normalisation

# The county file spells types inconsistently (AVE/AVENUE/AV, DR/DRIVE/Dr). Canonical form is the
# short one the voters list uses, so both sides normalise to the same token before matching.
TYPE_CANON = {
    "AV": "AVE", "AVE": "AVE", "AVENUE": "AVE",
    "BLVD": "BLVD", "BOULEVARD": "BLVD",
    "CIR": "CIR", "CIRCLE": "CIR",
    "CL": "CLOSE", "CLOSE": "CLOSE",
    "CRES": "CRES", "CRESCENT": "CRES",
    "CRT": "CT", "COURT": "CT", "CT": "CT",
    "DR": "DR", "DRIVE": "DR",
    "GDNS": "GDNS", "GARDENS": "GDNS",
    "GT": "GATE", "GATE": "GATE",
    "HTS": "HTS", "HEIGHTS": "HTS",
    "HWY": "HWY", "HIGHWAY": "HWY",
    "LANE": "LN", "LN": "LN",
    "LINE": "LINE",
    "PKWY": "PKWY", "PARKWAY": "PKWY",
    "PL": "PL", "PLACE": "PL",
    "RD": "RD", "ROAD": "RD",
    "ST": "ST", "STREET": "ST",
    "TERR": "TERR", "TERRACE": "TERR",
    "TR": "TRAIL", "TRAIL": "TRAIL",
    "WAY": "WAY", "WALK": "WALK", "PATH": "PATH", "PASS": "PASS",
    "END": "END", "GREEN": "GREEN", "RIDGE": "RIDGE", "BRNE": "BRNE",
}
DIR_CANON = {"N": "N", "NORTH": "N", "S": "S", "SOUTH": "S",
             "E": "E", "EAST": "E", "W": "W", "WEST": "W",
             # Delaware St runs N/C/S through the village; the county writes Central as "C".
             "C": "C", "CENTRAL": "C"}

UNIT_WORDS = ("UNIT", "APT", "SUITE", "STE", "#")
# A property address with no leading civic number is a concession/lot description.
LEADING_NUM = re.compile(r"^\s*(\d+)")
# "45B RAILWAY AVE" — the letter belongs to the civic number, not the street name.
NUM_SUFFIX = re.compile(r"^([A-Z])(?=\s)")
POSTAL = re.compile(r"\b([A-Z]\d[A-Z])\s*(\d[A-Z]\d)\b")


def squash(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def norm_type(t: str) -> Optional[str]:
    t = squash(t).upper().rstrip(".")
    return TYPE_CANON.get(t, t or None)


def norm_dir(d: str) -> Optional[str]:
    d = squash(d).upper().rstrip(".")
    return DIR_CANON.get(d)  # anything else in the county's DIR column is a stray type; drop it


def norm_street(name: Optional[str]) -> str:
    """Apostrophes and periods differ between the two sources ("ST JOHN'S DR" vs "ST JOHNS DR"),
    so street names are compared with them removed."""
    return re.sub(r"[^A-Z0-9 ]", "", squash(name or "").upper())


def street_key(street: Optional[str], stype: Optional[str], sdir: Optional[str]) -> str:
    return "|".join(x or "" for x in (norm_street(street), stype, sdir))


# ----------------------------------------------------------------------------- names

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}


def parse_name(raw: str) -> dict:
    """"ADAMS, JEFF JOHN" -> the display/sort fields the schema wants.

    The list is uppercase; the app shows title case, but `name_raw` keeps the original so a
    volunteer can always be shown exactly what the clerk's list said.
    """
    raw = squash(raw)
    last_raw, _, first_raw = raw.partition(",")
    last_raw, first_raw = squash(last_raw), squash(first_raw)

    parts = first_raw.split()
    suffix = None
    if parts and parts[-1].rstrip(".").upper() in SUFFIXES:
        suffix = parts.pop().rstrip(".").upper()
    first = parts[0] if parts else ""
    middles = " ".join(parts[1:]) if len(parts) > 1 else None

    tc = lambda s: " ".join(w.capitalize() if w.isalpha() else w for w in s.split()) if s else s
    last_clean = tc(last_raw)
    return {
        "last_name": last_raw,          # raw, as printed on the list
        "first_names": first_raw,       # raw
        "last_name_clean": last_clean,
        "first_name": tc(first),
        "middle_names": tc(middles) if middles else "",
        "suffix": suffix or "",
        "display_name": squash(f"{tc(first)} {last_clean}"),
        "full_name": squash(f"{tc(first)} {tc(middles) or ''} {last_clean}"),
    }


# ----------------------------------------------------------------------------- addresses

def parse_property(addr: str) -> dict:
    """Split "93 STONE FIELD LN UNIT 106" into its civic parts.

    Returns is_legal=True when there is no leading civic number — those rows are concession/lot
    descriptions ("PT LOT 12 CON 4"), which have no point on the map.
    """
    a = squash(addr).upper()
    out = {"num": "", "street": "", "type": "", "dir": "", "unit": "", "is_legal": False}
    if not a:
        out["is_legal"] = True
        return out

    m = LEADING_NUM.match(a)
    if not m:
        out["is_legal"] = True
        return out

    rest = a[m.end():].strip()
    out["num"] = a[m.start():m.end()].strip()
    sfx = NUM_SUFFIX.match(rest)
    if sfx:
        out["num"] += sfx.group(1)
        rest = rest[sfx.end():].strip()
    # a fractional civic number ("122 1/2 KING ST") stays in num
    frac = re.match(r"^(\d+/\d+)\s+", rest)
    if frac:
        out["num"] = f"{out['num']} {frac.group(1)}"
        rest = rest[frac.end():]

    toks = rest.split()
    # trailing unit
    for i, t in enumerate(toks):
        if t in UNIT_WORDS or t.startswith("#"):
            out["unit"] = squash(" ".join(toks[i + 1:]).lstrip("#")) or squash(t.lstrip("#"))
            toks = toks[:i]
            break

    # trailing direction, then trailing street type
    if toks and norm_dir(toks[-1]):
        out["dir"] = norm_dir(toks[-1]) or ""
        toks = toks[:-1]
    if toks and len(toks) > 1 and norm_type(toks[-1]) in TYPE_CANON.values():
        out["type"] = norm_type(toks[-1]) or ""
        toks = toks[:-1]

    out["street"] = " ".join(toks)
    if not out["street"]:
        out["is_legal"] = True
    return out


def parse_mailing(mail: str, property_addr: str) -> dict:
    """Single-line mail: "<street address> <CITY> ON  <POSTAL>" — no delimiters.

    The city has no separator before it, so we anchor on the postal code and the province token,
    then peel the city off the end. Where the mail line starts with the property address (85% of
    the list) the remainder IS the city, which is how the city vocabulary is bootstrapped.
    """
    m = squash(mail).upper()
    out = {"mailing_address": "", "mail_city": "", "mail_postal": "", "street_part": ""}
    if not m:
        return out

    pm = POSTAL.search(m)
    if pm:
        out["mail_postal"] = f"{pm.group(1)} {pm.group(2)}"
        m = m[: pm.start()].strip()
    m = re.sub(r"\bON\b\s*$", "", m).strip()  # province

    prop = squash(property_addr).upper()
    if prop and m.startswith(prop):
        out["street_part"] = prop
        out["mail_city"] = m[len(prop):].strip()
    else:
        out["street_part"] = m  # city split refined later against the vocabulary
    out["mailing_address"] = squash(mail)
    return out


def split_city(street_and_city: str, vocab: set[str]) -> tuple[str, str]:
    """Peel a known city off the end of "<street> <CITY>" (longest match wins)."""
    toks = street_and_city.split()
    for n in (3, 2, 1):
        if len(toks) > n:
            cand = " ".join(toks[-n:])
            if cand in vocab:
                return " ".join(toks[:-n]), cand
    return street_and_city, ""


# ----------------------------------------------------------------------------- geocoding

class Geocoder:
    """Address points for Middlesex Centre, indexed for a four-tier match.

    Tiers (recorded in addr_match, and collapsed into record_quality):
      exact             number + street + type + dir + unit
      normalized        number + street + type + dir
      unit-stripped     number + street name only (type/dir disagreed)
      nearest-on-street same street, closest civic number  -> approx, the point is a neighbour's
      legal             concession/lot row, no point at all
    """

    def __init__(self, features: Iterable[dict]):
        self.by_full: dict[tuple, tuple[float, float]] = {}
        self.by_numstreet: dict[tuple, tuple[float, float]] = {}
        self.by_street: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
        self.street_names: dict[str, str] = {}

        for feat in features:
            p = feat["properties"]
            lon, lat = p.get("POINT_X"), p.get("POINT_Y")
            if lon is None or lat is None:
                geom = feat.get("geometry") or {}
                if geom.get("type") != "Point":
                    continue
                lon, lat = geom["coordinates"][:2]
            num = squash(str(p.get("MUNNUMBER") or "")).upper()
            street = norm_street(p.get("STREET_NAM"))
            stype = norm_type(p.get("STREET_TYP") or "")
            sdir = norm_dir(p.get("STREET_DIR") or "")
            unit = squash(p.get("STREET_UNI") or "").upper()
            if not street or not num:
                continue

            self.by_full[(num, street, stype or "", sdir or "", unit)] = (lat, lon)
            self.by_numstreet.setdefault((num, street), (lat, lon))
            self.by_full.setdefault((num, street, stype or "", sdir or "", ""), (lat, lon))
            n = LEADING_NUM.match(num)
            if n:
                self.by_street[street].append((int(n.group(1)), lat, lon))
            self.street_names[street] = street

        for k in self.by_street:
            self.by_street[k].sort()

    def match(self, num: str, street: str, stype: str, sdir: str, unit: str):
        """-> (lat, lon, addr_match) or (None, None, 'check')."""
        num, street = num.upper(), norm_street(street)
        if not street:
            return None, None, "check"

        hit = self.by_full.get((num, street, stype or "", sdir or "", unit or ""))
        if hit:
            return hit[0], hit[1], "exact"
        hit = self.by_full.get((num, street, stype or "", sdir or "", ""))
        if hit:
            return hit[0], hit[1], "normalized"
        hit = self.by_numstreet.get((num, street))
        if hit:
            return hit[0], hit[1], "unit-stripped"
        bare = LEADING_NUM.match(num)
        if bare and bare.group(1) != num:
            hit = self.by_numstreet.get((bare.group(1), street))
            if hit:
                return hit[0], hit[1], "unit-stripped"

        # nearest civic number on the same street
        n = LEADING_NUM.match(num)
        if n and street in self.by_street and self.by_street[street]:
            target = int(n.group(1))
            best = min(self.by_street[street], key=lambda t: abs(t[0] - target))
            # Urban numbering runs door to door, so a far-off number means we found the wrong
            # street; rural numbering is distance-based (22893 HIGHBURY AVE N) and neighbours can
            # be hundreds apart. Scale the tolerance accordingly.
            window = 500 if target >= 1000 else 30
            if abs(best[0] - target) <= window:
                return best[1], best[2], "nearest-on-street"
        return None, None, "check"


QUALITY = {"exact": "good", "normalized": "good", "unit-stripped": "approx",
           "nearest-on-street": "approx", "legal": "legal", "check": "check"}


# ----------------------------------------------------------------------------- boundary

def point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > lat) != (y2 > lat):
            xin = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < xin:
                inside = not inside
    return inside


def load_boundary(path: Optional[str]):
    if not path or not Path(path).exists():
        return None
    geom = json.load(open(path))
    if geom.get("type") == "Polygon":
        return geom["coordinates"]
    if geom.get("type") == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    return None


# ----------------------------------------------------------------------------- main build

# Communities inside Middlesex Centre. A mailing city outside this set means the owner receives
# mail somewhere else, which is what drives resident_class below.
MC_COMMUNITIES = {
    "KOMOKA", "KILWORTH", "ILDERTON", "DELAWARE", "ARVA", "DENFIELD", "BRYANSTON",
    "POPLAR HILL", "LOBO", "COLDSTREAM", "MELROSE", "BIRR", "ELGINFIELD", "BALLYMOTE",
    "VANNECK", "GRANTON", "THORNDALE", "MOSSLEY",
}


def build(args) -> int:
    import openpyxl

    # ---- voters ------------------------------------------------------------------
    wb = openpyxl.load_workbook(args.xlsx, read_only=True)
    ws = wb[wb.sheetnames[0]]
    raw = [r for r in ws.iter_rows(min_row=2, values_only=True) if r and r[0]]
    print(f"list rows: {len(raw):,}")

    voters = []
    for name, prop, mail, ward in ((r[0], r[1], r[2], r[3]) for r in raw):
        prop_raw = squash(prop)
        v = parse_name(str(name))
        v["property_address"] = prop_raw
        v["ward"] = str(ward).strip().zfill(2)
        v.update(parse_mailing(str(mail or ""), prop_raw))
        voters.append(v)

    # City vocabulary: bootstrapped from the rows whose mail line starts with the property
    # address, so the leftover token IS the city. Frequent leftovers become the vocabulary.
    seen_cities = Counter(v["mail_city"] for v in voters if v["mail_city"])
    vocab = {c for c, n in seen_cities.items() if n >= 3 and len(c) <= 24}
    vocab |= MC_COMMUNITIES
    for v in voters:
        if not v["mail_city"] and v["street_part"]:
            street, city = split_city(v["street_part"], vocab)
            v["street_part"], v["mail_city"] = street, city
    print(f"cities resolved: {sum(1 for v in voters if v['mail_city']):,} / {len(voters):,}"
          f"  ({len(vocab)} in vocabulary)")

    # ---- households: group by the raw property address ---------------------------
    groups: dict[str, list[dict]] = defaultdict(list)
    for v in voters:
        groups[norm_street(v["property_address"])].append(v)
    print(f"distinct property addresses: {len(groups):,}")

    # ---- geocode -----------------------------------------------------------------
    gj = json.load(open(args.addresses))
    mc = [f for f in gj["features"] if (f["properties"].get("MUNCODE") or "").strip().upper() == "MIDC"]
    print(f"address points: {len(gj['features']):,} total, {len(mc):,} in Middlesex Centre")
    geo = Geocoder(mc)
    boundary = load_boundary(args.boundary)

    households = {}
    seq = Counter()
    for key, members in sorted(groups.items()):
        parts = parse_property(key)
        if parts["is_legal"]:
            lat = lon = None
            addr_match = "legal"
        else:
            lat, lon, addr_match = geo.match(parts["num"], parts["street"],
                                             parts["type"], parts["dir"], parts["unit"])

        # community/postal come from the members who receive mail at this property: for them the
        # mail city IS the Canada Post community for the door.
        resident_mail = [v for v in members if v["mail_city"] and
                         norm_street(v["street_part"]) == key]
        pool = resident_mail or [v for v in members if v["mail_city"]]
        community = Counter(v["mail_city"] for v in pool).most_common(1)[0][0] if pool else ""
        postal = Counter(v["mail_postal"] for v in pool if v["mail_postal"]).most_common(1)
        postal = postal[0][0] if postal else ""
        if community not in MC_COMMUNITIES:
            # owner-occupied elsewhere: fall back to any member whose mail is local
            local = [v["mail_city"] for v in members if v["mail_city"] in MC_COMMUNITIES]
            community = local[0] if local else community

        is_legal = addr_match == "legal"
        slug = "LEGAL" if is_legal else (re.sub(r"[^A-Z]", "", community.upper()) or "MC")
        seq[slug] += 1
        hid = f"H-{slug}-{seq[slug]:05d}" if not is_legal else f"H-LEGAL-{seq[slug]:04d}"

        ward = Counter(v["ward"] for v in members).most_common(1)[0][0]
        addr_clean = squash(" ".join(x for x in (
            parts["num"], parts["street"], parts["type"], parts["dir"]) if x))
        if parts["unit"]:
            addr_clean += f" UNIT {parts['unit']}"

        households[key] = {
            "household_id": hid,
            "ward": ward,
            "community": community,
            "postal": postal,
            "locality": community.title() if community else "",
            "address_clean": addr_clean or key,
            "property_address": members[0]["property_address"],
            "num": parts["num"], "street": parts["street"], "type": parts["type"],
            "dir": parts["dir"], "unit": parts["unit"],
            "lat": f"{lat:.6f}" if lat is not None else "",
            "lon": f"{lon:.6f}" if lon is not None else "",
            "addr_match": addr_match,
            "record_quality": QUALITY[addr_match],
            "hh_flag": "",
            "n_voters": len(members),
            "n_nonresident": 0,
            "n_mail_po_box": 0,
        }
        for v in members:
            v["household_id"] = hid

    # ---- residency ---------------------------------------------------------------
    # resident      mail arrives at this property, or in a Middlesex Centre community
    # non-resident  mail goes to a city outside the municipality (typically London owners)
    # unknown       no usable mailing address on the list
    def mail_is_local(v) -> bool:
        parts = parse_property(v["street_part"])
        if parts["is_legal"] or not parts["street"]:
            return v["mail_city"] in MC_COMMUNITIES
        lat, _, _m = geo.match(parts["num"], parts["street"], parts["type"],
                               parts["dir"], parts["unit"])
        return lat is not None

    for key, members in groups.items():
        hh = households[key]
        for v in members:
            same = bool(v["street_part"]) and norm_street(v["street_part"]) == key
            v["mail_same_property"] = "true" if same else "false"
            if not v["mailing_address"]:
                v["resident_class"] = "unknown"
            elif same or v["mail_city"] in MC_COMMUNITIES or mail_is_local(v):
                # Mail arrives at this door, in one of the municipality's own communities, or at
                # another address that geocodes inside Middlesex Centre — all resident electors.
                v["resident_class"] = "resident"
            else:
                v["resident_class"] = "non-resident"
            v["mail_differs_real"] = "true" if (not same and v["mailing_address"]) else "false"
            low = v["mailing_address"].upper()
            v["mail_kind"] = ("none" if not low else
                              "po_box" if re.search(r"\bP\.?O\.? ?BOX|\bBOX \d", low) else
                              "rural_route" if re.search(r"\bR\.?R\.? ?#? ?\d", low) else
                              "general_delivery" if "GENERAL DELIVERY" in low or "GEN DEL" in low else
                              "street")
            v["record_quality"] = hh["record_quality"]
        hh["n_nonresident"] = sum(1 for v in members if v["resident_class"] in ("non-resident", "unknown"))
        hh["n_mail_po_box"] = sum(1 for v in members if v["mail_kind"] == "po_box")
        if hh["addr_match"] == "legal":
            hh["hh_flag"] = "legal description, no civic address"
        elif len(members) >= 8:
            hh["hh_flag"] = ("large (8+ voters at one address, likely multi-unit / institution "
                             "without unit numbers)")

    # ---- write -------------------------------------------------------------------
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    hh_cols = ["household_id", "ward", "community", "postal", "locality", "address_clean",
               "property_address", "num", "street", "type", "dir", "unit", "lat", "lon",
               "addr_match", "record_quality", "hh_flag", "n_voters", "n_nonresident",
               "n_mail_po_box"]
    v_cols = ["household_id", "ward", "first_name", "middle_names", "last_name_clean", "suffix",
              "display_name", "full_name", "last_name", "first_names", "property_address",
              "resident_class", "mail_kind", "mail_same_property", "mail_differs_real",
              "mailing_address", "mail_city", "mail_postal", "record_quality"]

    with open(out / "households.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=hh_cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(households[k] for k in sorted(households))
    with open(out / "voters_final.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=v_cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(voters)

    report(voters, households, boundary)
    print(f"\nwrote {out/'voters_final.csv'} and {out/'households.csv'}")
    return 0


def report(voters, households, boundary):
    hh = list(households.values())
    print("\n--- summary (compare with README.md) ---")
    print(f"  voters                {len(voters):,}")
    print(f"  households            {len(hh):,}")
    q = Counter(h["record_quality"] for h in hh)
    print(f"  quality               {dict(q)}")
    print(f"  legal (no coords)     {sum(1 for h in hh if h['addr_match'] == 'legal')}")
    print(f"  institutions (8+)     {sum(1 for h in hh if 'institution' in h['hh_flag'])}")
    print(f"  with coordinates      {sum(1 for h in hh if h['lat']):,}")
    rc = Counter(v["resident_class"] for v in voters)
    print(f"  resident_class        {dict(rc)}")
    print(f"  mail_kind             {dict(Counter(v['mail_kind'] for v in voters))}")
    print(f"  wards                 {dict(sorted(Counter(h['ward'] for h in hh).items()))}")
    if boundary:
        outside = sum(1 for h in hh if h["lat"] and
                      not any(point_in_ring(float(h["lon"]), float(h["lat"]), r) for r in boundary))
        print(f"  points outside the municipal boundary: {outside}")
    dupes = Counter((v["last_name"].lower(), v["first_names"].lower(), v["property_address"])
                    for v in voters)
    print(f"  duplicate list entries: {sum(1 for c in dupes.values() if c > 1)}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--addresses", required=True)
    ap.add_argument("--boundary", default="data/mc_boundary.json")
    ap.add_argument("--out-dir", default="data")
    return build(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
