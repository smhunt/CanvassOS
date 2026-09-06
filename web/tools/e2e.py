#!/usr/bin/env python3
"""End-to-end smoke run against `vite preview` (4173) + the API (3001) with Playwright.
External hosts (tiles) are blocked; we judge the UI, not the basemap.

    python3 tools/e2e.py
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = "http://localhost:4173"
OUT = Path(__file__).resolve().parent.parent / "screenshots"
OUT.mkdir(exist_ok=True)
ADMIN = ("sean@ecoworks.ca", "changeme-changeme")
KOMOKA = (-81.4208, 42.9576)
KOMOKA_DENSE = (-81.4154, 42.9536)  # Winlow Way

console_errors: list[str] = []
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def wire(page: Page, tag: str) -> None:
    def on_console(msg):
        if msg.type == "error":
            url = (msg.location or {}).get("url", "")
            if "localhost" not in url and url:
                return  # blocked external resource (tiles)
            text = msg.text
            if "ERR_FAILED" in text or "net::ERR" in text:
                return
            console_errors.append(f"[{tag}] {text} @ {url}")

    page.on("console", on_console)
    page.on("pageerror", lambda err: console_errors.append(f"[{tag}] pageerror: {err}"))
    page.route(
        re.compile(r"^https?://(?!localhost)"),
        lambda route: route.abort(),
    )


def login(page: Page, email: str, password: str) -> None:
    page.goto(f"{BASE}/login")
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(password)
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(re.compile(r"^(?!.*/login$).*$"), timeout=15000)
    if not page.url.endswith("/map"):
        page.goto(f"{BASE}/map")


N_FEATURES = (
    "(() => { const s = window.__mcMap && window.__mcMap.getSource('households'); if (!s || !s._data) return 0;"
    " const fc = s._data.geojson || s._data; return fc.features ? fc.features.length : 0; })()"
)


def wait_points_loaded(page: Page) -> None:
    page.wait_for_function(f"() => window.__mcMap && window.__mcMap.isStyleLoaded() && {N_FEATURES} > 0", timeout=30000)
    page.wait_for_function("() => window.__mcMap.isSourceLoaded('households') && !window.__mcMap.isMoving()", timeout=30000)
    page.wait_for_timeout(400)


def settle(page: Page) -> None:
    """Wait for the map to finish moving/rendering (WebGL frames in headless can lag a beat)."""
    page.wait_for_function("() => !window.__mcMap || (window.__mcMap.loaded() && !window.__mcMap.isMoving())", timeout=15000)
    page.wait_for_timeout(350)


def rendered(page: Page, layer: str) -> int:
    return page.evaluate(f"() => window.__mcMap.queryRenderedFeatures({{layers:['{layer}']}}).length")


def jump(page: Page, lon: float, lat: float, zoom: float) -> None:
    page.evaluate(f"() => window.__mcMap.jumpTo({{center:[{lon},{lat}], zoom:{zoom}}})")
    page.wait_for_function("() => window.__mcMap.isSourceLoaded('households') && !window.__mcMap.isMoving()", timeout=30000)
    page.wait_for_timeout(500)


def click_first_point(page: Page) -> dict:
    info = page.evaluate(
        """() => {
          const m = window.__mcMap;
          const fs = m.queryRenderedFeatures({layers:['points']});
          // pick a point near the centre so the card doesn't cover it
          const c = m.getContainer().getBoundingClientRect();
          const cx = c.width/2, cy = c.height/2;
          let best=null, bd=1e9;
          for (const f of fs) { const p = m.project(f.geometry.coordinates); const d=(p.x-cx)**2+(p.y-cy)**2; if (d<bd){bd=d;best={x:p.x,y:p.y,props:f.properties};} }
          return best;
        }"""
    )
    assert info, "no rendered points to click"
    box = page.locator(".map-canvas").bounding_box()
    page.mouse.click(box["x"] + info["x"], box["y"] + info["y"])
    return info["props"]


def run_admin_desktop(browser) -> str:
    print("\n== admin / desktop 1400x900")
    ctx = browser.new_context(viewport={"width": 1400, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    wire(page, "admin-desktop")

    # unauthenticated guard
    page.goto(f"{BASE}/stats")
    page.wait_for_url(re.compile(r"/login$"), timeout=10000)
    check("/login" in page.url, "guard redirects anonymous /stats to /login")

    # bad password
    page.get_by_label("Email").fill(ADMIN[0])
    page.get_by_label("Password").fill("wrong-password-1")
    page.get_by_role("button", name="Sign in").click()
    page.get_by_role("alert").wait_for(timeout=10000)
    check("did not match" in page.get_by_role("alert").inner_text(), "bad credentials show an error")
    page.screenshot(path=str(OUT / "01-login-error.png"))

    page.get_by_label("Password").fill(ADMIN[1])
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(f"{BASE}/stats", timeout=15000)
    check(page.url.endswith("/stats"), "login returns to the page the guard bounced from (/stats)")
    page.goto(f"{BASE}/map")
    wait_points_loaded(page)
    page.wait_for_selector(".pill--counts strong", timeout=15000)
    pill = page.locator(".pill--counts").inner_text()
    print("   counts pill:", pill.replace("\n", " "))
    check("doors" in pill and "voters" in pill, "counts pill renders")
    n_clusters = rendered(page, "clusters")
    print("   rendered clusters:", n_clusters)
    check(n_clusters > 3, "clusters rendered at municipality zoom")
    labels = page.evaluate("() => window.__mcMap.queryRenderedFeatures({layers:['cluster-count']}).length")
    print("   rendered cluster labels:", labels)
    check(labels > 0, "cluster count labels rendered (local glyphs)")
    settle(page)
    page.screenshot(path=str(OUT / "02-map-desktop-clusters.png"))

    # colour modes + base layers exercise
    for mode in ["community", "doors", "quality", "nonres", "ward"]:
        page.get_by_label("Colour households by").select_option(mode)
        page.wait_for_timeout(150)
    check(page.locator(".legend-wrap__toggle").inner_text().endswith("Ward"), "legend follows colour mode")
    page.get_by_role("button", name=re.compile("Base layer")).click()
    page.get_by_role("menuitemradio", name="Satellite").click()
    vis = page.evaluate("() => window.__mcMap.getLayoutProperty('base-esri-imagery','visibility')")
    check(vis == "visible", "satellite base layer toggles on")
    page.get_by_role("button", name=re.compile("Base layer")).click()
    page.get_by_role("menuitemradio", name="Light").click()

    # filters: ward 04 only
    page.get_by_role("button", name=re.compile("^Filters")).click()
    page.get_by_role("dialog", name="Filters").wait_for()
    page.get_by_label(re.compile("^Ward 4")).check()
    page.wait_for_function(
        "() => document.querySelector('.pill--counts')?.textContent.includes('match filters')", timeout=15000
    )
    settle(page)
    page.screenshot(path=str(OUT / "03-map-filters-ward4.png"))
    n_after = page.evaluate(f"() => {N_FEATURES}")
    print("   ward 4 features:", n_after)
    check(n_after == 2411 - 0 or 2300 < n_after < 2411, f"ward filter pushed to API ({n_after} features)")
    page.get_by_role("button", name=re.compile("^Clear")).click()
    page.get_by_role("button", name="Close filters").click()
    page.wait_for_function(f"() => {N_FEATURES} > 7000", timeout=15000)

    # zoom to Komoka
    jump(page, KOMOKA[0], KOMOKA[1], 14)
    n_pts = rendered(page, "points")
    print("   rendered points at z14 Komoka:", n_pts)
    check(n_pts > 50, "individual points visible at zoom 14")
    settle(page)
    page.screenshot(path=str(OUT / "04-map-komoka-z14.png"))

    # click a point → card (Winlow Way: dense subdivision so the shot shows neighbours too)
    jump(page, KOMOKA_DENSE[0], KOMOKA_DENSE[1], 16)
    props = click_first_point(page)
    page.wait_for_selector(".sheet h2:not(.muted)", timeout=15000)
    page.wait_for_selector(".voter-list .voter", timeout=15000)
    addr = page.locator(".sheet h2").inner_text()
    voters = page.locator(".voter-list .voter").count()
    print(f"   card: {addr} — {voters} voters (props n={props.get('n')})")
    check(voters == props.get("n"), "card voter count matches point n")
    check(page.locator(".disclosure summary").count() == 1, "mailing addresses disclosure present")
    page.locator(".disclosure summary").click()
    settle(page)
    page.screenshot(path=str(OUT / "05-household-card.png"))
    page.get_by_role("button", name="Close household card").click()
    check(page.locator(".sheet").count() == 0, "card closes")

    # search
    search = page.get_by_role("combobox", name="Search voters and addresses")
    search.fill("Adams")
    page.wait_for_selector(".search__item", timeout=15000)
    items = page.locator(".search__item").count()
    print("   search items:", items)
    check(items > 0, "search returns results")
    first = page.locator(".search__item").first.inner_text()
    settle(page)
    page.screenshot(path=str(OUT / "06-search-adams.png"))
    page.locator(".search__item").first.click()
    page.wait_for_selector(".voter-list .voter", timeout=15000)
    page.wait_for_function("() => !window.__mcMap.isMoving()", timeout=15000)
    page.wait_for_timeout(400)
    check("Adams" in page.locator(".sheet").inner_text(), "selected search result opens the household card with the voter")
    settle(page)
    page.screenshot(path=str(OUT / "07-search-selected-card.png"))
    print("   first item:", first.replace("\n", " | "))

    # legal list
    page.get_by_role("button", name="Close household card").click()
    page.get_by_role("button", name=re.compile("unmapped parcels")).click()
    page.wait_for_selector(".modal table tbody tr", timeout=15000)
    rows = page.locator(".modal table tbody tr").count()
    print("   legal rows:", rows)
    check(rows == 70, "70 legal-description households listed")
    settle(page)
    page.screenshot(path=str(OUT / "08-unmapped-parcels.png"))
    page.locator(".modal table tbody tr").first.get_by_role("button").click()
    page.wait_for_selector(".voter-list .voter", timeout=15000)
    check("Unmapped parcel" in page.locator(".sheet").inner_text(), "legal household card opens from the list")
    page.get_by_role("button", name="Close household card").click()

    # stats
    page.get_by_role("link", name="Stats").click()
    page.wait_for_selector(".tiles .tile", timeout=15000)
    page.wait_for_selector(".hbars__row", timeout=15000)
    check(page.locator(".tile").count() >= 8, "stats tiles render")
    check("Phase 2" in page.locator(".card--phase2").inner_text(), "canvass section carries Phase 2 label")
    page.screenshot(path=str(OUT / "09-stats.png"), full_page=True)

    # users + invite
    page.get_by_role("link", name="Users").click()
    page.wait_for_selector(".table tbody tr", timeout=15000)
    stamp = int(time.time())
    vol_email = f"vol{stamp}@example.com"
    page.get_by_label("Email").fill(vol_email)
    page.get_by_label("Name").fill("Vera Volunteer")
    page.get_by_label("Role", exact=True).select_option("volunteer")
    page.get_by_role("button", name="Create invite").click()
    page.wait_for_selector(".invite-link", timeout=15000)
    invite_url = page.get_by_label("Invite URL").input_value()
    print("   invite_url:", invite_url)
    check(invite_url.startswith("https://localhost/invite/"), "invite_url returned and displayed")
    page.get_by_role("button", name="Copy link").click()
    page.locator(".table tbody tr", has_text=vol_email).wait_for(timeout=15000)
    check(page.locator(".table tbody tr", has_text=vol_email).count() == 1, "new user appears in the table")
    page.screenshot(path=str(OUT / "10-users-invite.png"))
    # duplicate invite → 409 handled
    page.get_by_label("Email").fill(vol_email)
    page.get_by_label("Name").fill("Dup")
    page.get_by_role("button", name="Create invite").click()
    page.wait_for_selector(".alert--danger", timeout=15000)
    check("already exists" in page.locator(".alert--danger").inner_text(), "duplicate invite shows 409 message")

    # reinvite + role change + deactivate/reactivate on the new user
    row = page.locator(".table tbody tr", has_text=vol_email)
    row.get_by_role("button", name=re.compile("Re-invite|Reset")).click()
    page.wait_for_timeout(800)
    check(page.get_by_label("Invite URL").input_value().startswith("https://localhost/invite/"), "re-invite returns a fresh link")
    invite_url = page.get_by_label("Invite URL").input_value()
    row.get_by_label(re.compile("Role for")).select_option("organizer")
    page.wait_for_function(
        f"() => [...document.querySelectorAll('.table tbody tr')].find(r => r.textContent.includes('{vol_email}'))?.querySelector('select')?.value === 'organizer'",
        timeout=15000,
    )
    check(True, "role change round-trips")
    row.get_by_label(re.compile("Role for")).select_option("volunteer")
    page.wait_for_function(
        f"() => [...document.querySelectorAll('.table tbody tr')].find(r => r.textContent.includes('{vol_email}'))?.querySelector('select')?.value === 'volunteer'",
        timeout=15000,
    )
    # cannot deactivate self (button disabled)
    self_row = page.locator(".table tbody tr", has_text=ADMIN[0])
    check(self_row.get_by_role("button", name="Deactivate").is_disabled(), "cannot deactivate yourself from the UI")

    # audit
    page.get_by_role("link", name="Audit").click()
    page.wait_for_selector(".audit tbody tr", timeout=15000)
    check(page.locator(".audit tbody tr").count() > 5, "audit entries listed")
    page.get_by_label("Action").select_option("view_household")
    page.wait_for_function("() => [...document.querySelectorAll('.audit tbody tr .tag')].every(t => t.textContent === 'view_household')", timeout=15000)
    check(True, "audit action filter applies")
    page.screenshot(path=str(OUT / "11-audit.png"))

    # account
    page.get_by_role("link", name="Account").click()
    page.wait_for_selector(".dl", timeout=15000)
    check("voters list export 2026-09-03" in page.locator(".page").inner_text(), "import label shown on account page")
    page.screenshot(path=str(OUT / "12-account.png"))
    page.get_by_role("button", name="Sign out").click()
    page.wait_for_url(re.compile(r"/login$"), timeout=10000)
    check("/login" in page.url, "logout returns to /login")
    page.goto(f"{BASE}/map")
    page.wait_for_url(re.compile(r"/login$"), timeout=10000)
    check("/login" in page.url, "after logout /map redirects to /login")
    ctx.close()
    return invite_url


def run_admin_mobile(browser) -> None:
    print("\n== admin / mobile 390x844")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    wire(page, "admin-mobile")
    login(page, *ADMIN)
    wait_points_loaded(page)
    page.wait_for_selector(".pill--counts strong", timeout=15000)
    check(page.locator(".topbar__menubtn").is_visible(), "phone menu button visible")
    check(not page.locator(".topbar__nav").is_visible(), "desktop nav hidden on phone")
    settle(page)
    page.screenshot(path=str(OUT / "13-mobile-map.png"))
    page.locator(".topbar__menubtn").click()
    page.wait_for_selector("#mobile-menu")
    settle(page)
    page.screenshot(path=str(OUT / "14-mobile-menu.png"))
    page.keyboard.press("Escape")
    page.get_by_role("button", name=re.compile("^Filters")).click()
    page.get_by_role("dialog", name="Filters").wait_for()
    settle(page)
    page.screenshot(path=str(OUT / "15-mobile-filters.png"))
    page.get_by_role("button", name="Close filters").click()
    jump(page, KOMOKA_DENSE[0], KOMOKA_DENSE[1], 16)
    click_first_point(page)
    page.wait_for_selector(".voter-list .voter", timeout=15000)
    box = page.locator(".sheet").bounding_box()
    check(box is not None and box["y"] > 200, "card is a bottom sheet on phones")
    settle(page)
    page.screenshot(path=str(OUT / "16-mobile-card.png"))
    page.get_by_role("button", name="Close household card").click()
    page.goto(f"{BASE}/stats")
    page.wait_for_selector(".hbars__row", timeout=15000)
    page.screenshot(path=str(OUT / "17-mobile-stats.png"), full_page=True)
    # 375px sanity: no horizontal scroll
    page.set_viewport_size({"width": 375, "height": 700})
    page.wait_for_timeout(300)
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    check(sw <= 375, f"no horizontal overflow at 375px (scrollWidth={sw})")
    ctx.close()


def run_volunteer(browser, invite_url: str) -> None:
    print("\n== volunteer / invite + map 390x844")
    token = invite_url.rsplit("/", 1)[1]
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    wire(page, "volunteer")
    page.goto(f"{BASE}/invite/{token}")
    page.get_by_label("Your name").fill("Vera Volunteer")
    page.locator('input[name="password"]').fill("short")
    page.locator('input[name="confirm"]').fill("short")
    check("more" in page.locator("#pw-hint").inner_text(), "short password hint shown")
    page.locator('input[name="password"]').fill("volunteer-pass-1")
    page.locator('input[name="confirm"]').fill("volunteer-pass-2")
    check(page.locator(".field__hint--error", has_text="do not match").count() == 1, "mismatch hint shown")
    page.locator('input[name="confirm"]').fill("volunteer-pass-1")
    page.screenshot(path=str(OUT / "18-invite-form.png"))
    page.get_by_role("button", name=re.compile("Create account")).click()
    page.wait_for_url(f"{BASE}/map", timeout=15000)
    wait_points_loaded(page)
    page.wait_for_selector(".pill--counts strong", timeout=15000)
    check(page.get_by_role("combobox", name="Search voters and addresses").count() == 0, "volunteer sees no search box")
    opts = page.get_by_label("Colour households by").locator("option").all_inner_texts()
    check("Record quality" not in opts and "Non-resident owners" not in opts, f"volunteer colour modes limited: {opts}")
    check(page.locator(".legend-wrap__legal").count() == 0, "volunteer has no unmapped-parcels link")
    props = page.evaluate("() => { const d = window.__mcMap.getSource('households')._data; return (d.geojson || d).features[0].properties; }")
    check("nonres" not in props and "q" not in props, f"volunteer point props stripped: {list(props)}")
    jump(page, KOMOKA_DENSE[0], KOMOKA_DENSE[1], 16)
    click_first_point(page)
    page.wait_for_selector(".sheet", timeout=15000)
    page.wait_for_timeout(300)
    text = page.locator(".sheet").inner_text()
    check("Volunteer view" in text and "Phase 2" in text, "volunteer card shows Phase 2 note")
    check(not re.search(r"\d+ [A-Z]{2,} (ST|RD|AVE|DR|CRES|LANE)", text), "volunteer card has no street address")
    settle(page)
    page.screenshot(path=str(OUT / "19-volunteer-map-card.png"))
    page.get_by_role("button", name="Close household card").click()
    # volunteer role gate
    page.goto(f"{BASE}/stats")
    page.wait_for_url(f"{BASE}/map", timeout=10000)
    check(page.url.endswith("/map"), "volunteer /stats redirects to /map")
    page.goto(f"{BASE}/admin/users")
    page.wait_for_url(f"{BASE}/map", timeout=10000)
    check(page.url.endswith("/map"), "volunteer /admin/users redirects to /map")
    # reused invite → 410
    page.goto(f"{BASE}/account")
    page.get_by_role("button", name="Sign out").click()
    page.wait_for_url(re.compile(r"/login$"), timeout=10000)
    page.goto(f"{BASE}/invite/{token}")
    page.get_by_label("Your name").fill("Again")
    page.locator('input[name="password"]').fill("volunteer-pass-1")
    page.locator('input[name="confirm"]').fill("volunteer-pass-1")
    page.get_by_role("button", name=re.compile("Create account")).click()
    page.get_by_role("alert").wait_for(timeout=15000)
    check("already been used" in page.get_by_role("alert").inner_text(), "used invite shows 410 message")
    ctx.close()


def run_dark(browser) -> None:
    print("\n== dark scheme")
    ctx = browser.new_context(viewport={"width": 1200, "height": 800}, color_scheme="dark")
    page = ctx.new_page()
    wire(page, "dark")
    login(page, *ADMIN)
    page.goto(f"{BASE}/stats")
    page.wait_for_selector(".hbars__row", timeout=15000)
    page.screenshot(path=str(OUT / "20-stats-dark.png"))
    ctx.close()


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        invite_url = run_admin_desktop(browser)
        run_admin_mobile(browser)
        run_volunteer(browser, invite_url)
        run_dark(browser)
        browser.close()
    print("\n== console errors:", len(console_errors))
    for e in console_errors:
        print("  ", e)
    print("== failures:", len(failures))
    for f in failures:
        print("  ", f)
    print("== screenshots:")
    for f in sorted(OUT.glob("*.png")):
        print("  ", f.name)
    return 1 if failures or console_errors else 0


if __name__ == "__main__":
    sys.exit(main())
