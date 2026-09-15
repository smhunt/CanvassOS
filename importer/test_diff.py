"""Unit tests for importer/diff.py. Pure — no database, no files.

    cd importer && python3 -m pytest -q test_diff.py

Each test is one way a naive re-import loses or misattributes canvass work. The first one is the
reason the module exists.
"""
from __future__ import annotations

import pytest

from diff import (
    DiffError,
    ExistingHousehold,
    ExistingVoter,
    base_key_from_row,
    base_key_from_stored,
    norm_address,
    plan_diff,
)


def hh(hid: str, addr: str) -> dict[str, str]:
    return {"household_id": hid, "property_address": addr}


def vr(hid: str, last: str, first: str, addr: str) -> dict[str, str]:
    return {"household_id": hid, "last_name": last, "first_names": first, "property_address": addr}


def key(last: str, first: str, addr: str, n: int = 1) -> str:
    k = f"{last.lower()}, {first.lower()}|{addr}"
    return k if n == 1 else f"{k}#{n}"


def plan(existing_hh, existing_v, new_hh, new_v, ref_hh=(), ref_v=()):
    return plan_diff(existing_hh, existing_v, new_hh, new_v, set(ref_hh), set(ref_v))


# A three-house street, as currently loaded.
EX_HH = [
    ExistingHousehold("H-KOMOKA-00001", "10 ELM ST"),
    ExistingHousehold("H-KOMOKA-00002", "20 ELM ST"),
    ExistingHousehold("H-KOMOKA-00003", "30 ELM ST"),
]
EX_V = [
    ExistingVoter("v-ann", key("Smith", "Ann", "10 ELM ST"), "H-KOMOKA-00001"),
    ExistingVoter("v-bob", key("Jones", "Bob", "20 ELM ST"), "H-KOMOKA-00002"),
    ExistingVoter("v-cat", key("Lee", "Cat", "30 ELM ST"), "H-KOMOKA-00003"),
]


def same_list():
    return (
        [hh("H-KOMOKA-00001", "10 ELM ST"), hh("H-KOMOKA-00002", "20 ELM ST"), hh("H-KOMOKA-00003", "30 ELM ST")],
        [
            (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
            (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00002", "Jones", "Bob", "20 ELM ST")),
            (key("Lee", "Cat", "30 ELM ST"), vr("H-KOMOKA-00003", "Lee", "Cat", "30 ELM ST")),
        ],
    )


def test_identical_list_changes_nothing():
    new_hh, new_v = same_list()
    p = plan(EX_HH, EX_V, new_hh, new_v)
    assert p.unchanged_shape
    assert p.renumbered == 0
    assert p.v_update == {key("Smith", "Ann", "10 ELM ST"): "v-ann",
                          key("Jones", "Bob", "20 ELM ST"): "v-bob",
                          key("Lee", "Cat", "30 ELM ST"): "v-cat"}
    assert not p.v_rekey


def test_a_new_house_early_in_the_sort_does_not_move_history_to_the_wrong_door():
    """THE trap. The pipeline numbers houses sequentially in sort order, so a new house at 5 ELM ST
    takes 00001 and every existing house shifts up one. Matching on the id would hand Ann's canvass
    history to the new house and Bob's to Ann's door."""
    new_hh = [
        hh("H-KOMOKA-00001", "5 ELM ST"),   # new
        hh("H-KOMOKA-00002", "10 ELM ST"),  # was 00001
        hh("H-KOMOKA-00003", "20 ELM ST"),  # was 00002
        hh("H-KOMOKA-00004", "30 ELM ST"),  # was 00003
    ]
    new_v = [
        (key("New", "Dee", "5 ELM ST"), vr("H-KOMOKA-00001", "New", "Dee", "5 ELM ST")),
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00002", "Smith", "Ann", "10 ELM ST")),
        (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00003", "Jones", "Bob", "20 ELM ST")),
        (key("Lee", "Cat", "30 ELM ST"), vr("H-KOMOKA-00004", "Lee", "Cat", "30 ELM ST")),
    ]
    p = plan(EX_HH, EX_V, new_hh, new_v)

    # Every existing door keeps its database id, whatever the export called it.
    assert p.hh_map["H-KOMOKA-00002"] == "H-KOMOKA-00001"  # 10 ELM ST is still 00001
    assert p.hh_map["H-KOMOKA-00003"] == "H-KOMOKA-00002"
    assert p.hh_map["H-KOMOKA-00004"] == "H-KOMOKA-00003"
    assert p.renumbered == 3

    # The new house's export id (00001) is taken, so it gets a fresh one rather than stealing it.
    assert p.hh_insert == ["H-KOMOKA-00001"]
    assert p.hh_map["H-KOMOKA-00001"] == "H-KOMOKA-00004"
    assert p.reissued == [("H-KOMOKA-00001", "H-KOMOKA-00004")]
    assert not p.hh_delete and not p.hh_keep


def test_an_id_is_never_reused_even_when_its_house_left_the_list():
    """audit_log.target stores household ids as text; reusing one rewrites what past rows mean."""
    new_hh = [hh("H-KOMOKA-00001", "10 ELM ST"), hh("H-KOMOKA-00002", "20 ELM ST"),
              hh("H-KOMOKA-00003", "99 OAK AVE")]  # 30 ELM ST gone, a different house takes its id
    new_v = [
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
        (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00002", "Jones", "Bob", "20 ELM ST")),
        (key("Ray", "Eve", "99 OAK AVE"), vr("H-KOMOKA-00003", "Ray", "Eve", "99 OAK AVE")),
    ]
    p = plan(EX_HH, EX_V, new_hh, new_v)
    assert p.hh_delete == ["H-KOMOKA-00003"]
    assert p.hh_map["H-KOMOKA-00003"] != "H-KOMOKA-00003", "a deleted house's id must not be handed on"
    assert p.hh_map["H-KOMOKA-00003"] == "H-KOMOKA-00004"


def test_a_household_that_left_the_list_is_kept_when_anything_references_it():
    new_hh = [hh("H-KOMOKA-00001", "10 ELM ST"), hh("H-KOMOKA-00002", "20 ELM ST")]
    new_v = [
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
        (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00002", "Jones", "Bob", "20 ELM ST")),
    ]
    kept = plan(EX_HH, EX_V, new_hh, new_v, ref_hh={"H-KOMOKA-00003"})
    assert kept.hh_keep == ["H-KOMOKA-00003"] and not kept.hh_delete

    gone = plan(EX_HH, EX_V, new_hh, new_v)
    assert gone.hh_delete == ["H-KOMOKA-00003"] and not gone.hh_keep


def test_a_kept_voter_forces_its_household_to_be_kept():
    """Deleting the household would cascade to the voter the plan just promised to keep."""
    new_hh = [hh("H-KOMOKA-00001", "10 ELM ST"), hh("H-KOMOKA-00002", "20 ELM ST")]
    new_v = [
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
        (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00002", "Jones", "Bob", "20 ELM ST")),
    ]
    p = plan(EX_HH, EX_V, new_hh, new_v, ref_v={"v-cat"})
    assert p.v_keep == ["v-cat"]
    assert p.hh_keep == ["H-KOMOKA-00003"] and not p.hh_delete


def test_a_whitespace_or_punctuation_change_does_not_detach_a_voter():
    """The stored natural_key embeds the raw address string. The clerk's export tidying 'ST.' to
    'ST' must not make Ann look removed and re-added — that would drop her contact history."""
    existing_hh = [ExistingHousehold("H-KOMOKA-00001", "10  Elm St.")]
    existing_v = [ExistingVoter("v-ann", key("Smith", "Ann", "10  Elm St."), "H-KOMOKA-00001")]
    new_hh = [hh("H-KOMOKA-00001", "10 ELM ST")]
    new_v = [(key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST"))]
    p = plan(existing_hh, existing_v, new_hh, new_v)
    assert p.unchanged_shape
    assert p.v_update == {key("Smith", "Ann", "10 ELM ST"): "v-ann"}
    # Re-keyed, so the stored key — and anything keyed on it — can be moved to the new spelling.
    assert p.v_rekey == {key("Smith", "Ann", "10  Elm St."): key("Smith", "Ann", "10 ELM ST")}


def test_a_reshuffled_duplicate_is_not_a_removal_and_an_addition():
    """The list sometimes carries one person twice at a property. `#2` follows file order, which
    can change between exports; that must not look like churn."""
    existing_v = [
        ExistingVoter("v-a1", key("Smith", "Ann", "10 ELM ST"), "H-KOMOKA-00001"),
        ExistingVoter("v-a2", key("Smith", "Ann", "10 ELM ST", 2), "H-KOMOKA-00001"),
    ]
    new_v = [
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
        (key("Smith", "Ann", "10 ELM ST", 2), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
    ]
    p = plan([EX_HH[0]], existing_v, [hh("H-KOMOKA-00001", "10 ELM ST")], new_v)
    assert p.unchanged_shape
    assert sorted(p.v_update.values()) == ["v-a1", "v-a2"]


def test_a_person_at_a_new_address_is_reported_as_a_possible_move_and_never_linked():
    new_hh = [hh("H-KOMOKA-00001", "10 ELM ST"), hh("H-KOMOKA-00002", "20 ELM ST"),
              hh("H-KOMOKA-00003", "30 ELM ST"), hh("H-KOMOKA-00004", "40 ELM ST")]
    new_v = [
        (key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00001", "Smith", "Ann", "10 ELM ST")),
        (key("Jones", "Bob", "20 ELM ST"), vr("H-KOMOKA-00002", "Jones", "Bob", "20 ELM ST")),
        (key("Lee", "Cat", "40 ELM ST"), vr("H-KOMOKA-00004", "Lee", "Cat", "40 ELM ST")),  # Cat moved
    ]
    p = plan(EX_HH, EX_V, new_hh, new_v)
    assert p.possible_moves == [("lee, cat", "30 ELM ST", "40 ELM ST")]
    # Reported only: her old voter row leaves, and a new one arrives. Nothing is merged.
    assert "v-cat" in p.v_delete
    assert key("Lee", "Cat", "40 ELM ST") in p.v_insert


def test_a_matched_voter_is_written_under_the_database_household_id_not_the_export_id():
    """The export's voter.household_id is the export's (renumbered) id. The importer must route it
    through hh_map, or a voter lands in the wrong house."""
    new_hh = [hh("H-KOMOKA-00009", "10 ELM ST")]  # export renumbered 00001 -> 00009
    new_v = [(key("Smith", "Ann", "10 ELM ST"), vr("H-KOMOKA-00009", "Smith", "Ann", "10 ELM ST"))]
    p = plan([EX_HH[0]], [EX_V[0]], new_hh, new_v)
    assert p.hh_map["H-KOMOKA-00009"] == "H-KOMOKA-00001"


def test_an_ambiguous_address_key_refuses_rather_than_guesses():
    existing = [ExistingHousehold("H-KOMOKA-00001", "10 ELM ST"),
                ExistingHousehold("H-KOMOKA-00002", "10 ELM ST.")]
    with pytest.raises(DiffError, match="share the address key"):
        plan(existing, [], [hh("H-KOMOKA-00001", "10 ELM ST")], [])


def test_dry_run_and_apply_mint_the_same_ids():
    """Both runs plan from the same database and files, and must agree on every fresh id — a report
    that promised 00004 and an apply that wrote 00005 would make the report a lie."""
    new_hh = [hh("H-KOMOKA-00001", "5 ELM ST"), hh("H-KOMOKA-00002", "7 ELM ST"),
              hh("H-KOMOKA-00003", "10 ELM ST"), hh("H-KOMOKA-00004", "20 ELM ST"),
              hh("H-KOMOKA-00005", "30 ELM ST")]
    first = plan(EX_HH, EX_V, new_hh, [])
    second = plan(EX_HH, EX_V, list(reversed(new_hh)), [])
    assert first.hh_map == second.hh_map
    assert first.reissued == second.reissued


def test_normalisation_matches_the_pipeline_rule():
    assert norm_address("St. John's  Dr") == "ST JOHNS DR"
    assert base_key_from_stored("o'brien, sean|12 Main St.#2") == base_key_from_row(
        vr("x", "O'Brien", "Sean", "12 MAIN ST")
    )
