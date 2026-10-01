#!/usr/bin/env python3
"""Product-tour screenshots for the public marketing page, with every personal detail blurred.

    python3 tools/tour_shots.py                 # all shots -> web/public/tour/*.png + *.webp
    python3 tools/tour_shots.py door record     # just these
    python3 tools/tour_shots.py --out /tmp/x    # somewhere else (for a look before replacing)

TARGET: ONLY the demo stack, https://dev.ecoworks.ca:3032 (fabricated residents, demo API 3132).
NEVER point this at 3030 or canvass.webarchitecture.ca: that is the real voters list. The script
refuses to run against any other base URL, and every page load is checked against it.

How the blur works (it is baked into the pixels at capture time, not added afterwards):
  1. Before any page is opened, the script signs in as the demo admin and pulls every person-shaped
     string from the demo API: each household's residents and address (/api/households/:id for every
     point), users (name + email), sign requests, website requests, doorstep contacts, follow-ups and
     contact notes. Turf names are left out on purpose.
  2. That list is embedded in an init script that runs in every page. It wraps any DOM text node
     containing one of those names/tokens, an email, a phone number or a "<number> <demo street>"
     address in a <span> with `filter: blur(max(7px, .45em))` (scaled with the font so big headings
     do not leave a readable silhouette). Inputs/textareas/selects whose value matches, SVG <text>,
     and the signed-in user's name/email in the app chrome (.topbar__name, .menu__name, ...) are
     blurred as elements. A MutationObserver re-applies it as the app renders, and
     window.__tourBlur() is called once more right before every screenshot.
  3. The map canvas only draws turf names (map/style.ts), which are allowed; household dots carry
     no names. Popups are DOM and get the same treatment.
After a run, open each image and check it by eye (crop and zoom the text-dense parts): a name that
reaches the screen by a route this script does not know about would not be blurred.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, sync_playwright

BASE = "https://dev.ecoworks.ca:3032"  # the DEMO stack. Do not make this configurable.
if urlparse(BASE).port != 3032:
    sys.exit("tour_shots.py only runs against the demo stack on port 3032")

PASSWORD = "demo-password-1"
ADMIN = "demo@example.com"
ORGANIZER = "priya.demo@example.com"
OUT = Path(__file__).resolve().parent.parent / "public" / "tour"

DESKTOP = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
PHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
MAP_ZOOM = 14.0
ILDERTON = {"latitude": 43.0507, "longitude": -81.3415}

LOCAL_PREFS = {
    "mc.pwa.install-dismissed": "1",
    "mc-canvass.drive-seen": "1",
    "mc-canvass.analytics-off": "1",
    "mc.map.turfs": "on",
}

PERSON_KEYS = {
    "display_name", "full_name", "first_name", "last_name", "middle_names", "name", "email", "phone",
    "address", "mailing_address", "contact_name", "requester_name", "created_by_name", "user_name",
    "by_name", "permission_by", "removed_by_name", "recorded_by", "volunteer", "voter_name", "value", "placed_by_name", "requested_by_name",
    "notes", "note", "comment", "message",
}
NAME_KEYS = {"display_name", "full_name", "first_name", "last_name", "middle_names", "name", "contact_name",
             "requester_name", "created_by_name", "user_name", "by_name", "placed_by_name", "requested_by_name",
             "removed_by_name", "voter_name", "volunteer"}
FREE_TEXT = {"notes", "note", "comment", "message"}


# ------------------------------------------------------------------------------------------------ blur

BLUR_JS = r"""
(() => {
  const DATA = __DATA__;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokens = [...new Set(DATA.tokens)].filter((t) => t && t.length >= 2).sort((a, b) => b.length - a.length);
  const nameRe = tokens.length ? new RegExp('(^|[^A-Za-z])(' + tokens.map(esc).join('|') + ')(?![A-Za-z])', 'i') : null;
  const emailRe = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
  const phoneRe = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const addrRe = new RegExp('\\b\\d{1,5}[A-Z]?\\s+(' + DATA.streets.map(esc).join('|') + ')\\b', 'i');
  const hit = (s) => !!s && ((nameRe && nameRe.test(s)) || emailRe.test(s) || phoneRe.test(s) || addrRe.test(s));
  const CHROME = ['.topbar__name', '.menu__name', '.menu__name + .muted', '.cell-name'];
  const style = (el) => {
    el.style.setProperty('filter', 'blur(max(7px, .45em))', 'important');
    el.dataset.tourBlur = '1';
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'TEXTAREA']);
  function run() {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const n of nodes) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('[data-tour-blur]')) continue;
      if (!hit(n.nodeValue)) continue;
      if (p.closest('svg')) { style(p.closest('text') || p); continue; }
      if (p.tagName === 'OPTION') { style(p.closest('select') || p); continue; }
      const span = document.createElement('span');
      span.style.display = 'inline-block';
      style(span);
      n.parentNode.insertBefore(span, n);
      span.appendChild(n);
    }
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.dataset.tourBlur) continue;
      const v = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).text : el.value;
      if (hit(v) || hit(el.placeholder)) style(el);
    }
    for (const sel of CHROME) for (const el of document.querySelectorAll(sel)) if (!el.dataset.tourBlur) style(el);
  }
  window.__tourBlur = run;
  let queued = false;
  const obs = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; run(); });
  });
  const start = () => { run(); obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('input', run, true);
  const css = document.createElement('style');
  css.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}'
    + '.mc-install,#mc-install,.toast,.toasts,[role=status].toast{display:none!important}';
  (document.head || document.documentElement).appendChild(css);
})();
"""


def collect_pii(ctx: BrowserContext) -> dict:
    """Every person-shaped string in the demo, fetched with the admin's session."""
    req = ctx.request
    found: set[str] = set()
    names: set[str] = set()  # values that are a person's name, split into words below
    notes: list[str] = []
    streets: set[str] = set()

    def get(path: str):
        r = req.get(f"{BASE}{path}")
        if not r.ok:
            print(f"  (skip {path}: {r.status})")
            return None
        try:
            return r.json()
        except Exception:
            return None

    def walk(o, parent_key: str = "") -> None:
        if isinstance(o, dict):
            if "n_households" in o:  # a turf: its name stays readable
                for k, v in o.items():
                    if k not in ("name", "streets"):
                        walk(v, k)
                return
            for k, v in o.items():
                if k == "turfs" and isinstance(v, list):  # turf names stay readable; anything else in them is walked
                    walk([{kk: vv for kk, vv in t.items() if kk != "name"} if isinstance(t, dict) else t for t in v], k)
                    continue
                if isinstance(v, str) and k in PERSON_KEYS and v.strip():
                    (notes if k in FREE_TEXT else []).append(v)
                    if k not in FREE_TEXT:
                        found.add(v.strip())
                        if k in NAME_KEYS:
                            names.add(v.strip())
                    if k in ("address", "mailing_address"):
                        m = re.match(r"^\s*\d+[A-Z]?\s+(.+?)\s*$", v)
                        if m:
                            streets.add(m.group(1))
                else:
                    walk(v, k)
        elif isinstance(o, list):
            for v in o:
                walk(v, parent_key)

    pts = get("/api/households/points") or {}
    ids = [f["properties"]["id"] for f in pts.get("features", [])]
    for hid in ids:
        walk(get(f"/api/households/{hid}"))
        walk(get(f"/api/contacts?household_id={hid}"))
        walk(get(f"/api/voter-contacts?household_id={hid}"))
    turfs = get("/api/turfs") or {}
    walk(turfs)
    for t in turfs.get("turfs", []):
        walk(get(f"/api/turfs/{t['id']}/doors"))
    for path in ["/api/users", "/api/signs", "/api/signs/requests", "/api/signs/pickup", "/api/public/requests",
                 "/api/follow-ups", "/api/activity", "/api/voter-contacts/gotv", "/api/search?q=a",
                 "/api/search?q=e", "/api/search?q=o", "/api/auth/me"]:
        walk(get(path))

    tokens: set[str] = set()
    tokens |= found
    for s in names:
        if "@" in s:
            continue
        # The UI shortens names ("Corncrake household", "Gus C."): blur each part on its own as well.
        for part in re.split(r"[\s,]+", s):
            if len(part) >= 3 and part[0].isupper() and not part.isdigit() and not re.fullmatch(r"\d+[A-Z]?", part):
                tokens.add(part)
    # Street names and the street type are not personal; a street's name must stay readable.
    street_words = {w.lower() for st in streets for w in st.split()}
    tokens = {t for t in tokens if t.lower() not in street_words}
    print(f"  {len(ids)} households, {len(tokens)} blur tokens, {len(notes)} free-text notes, streets: {sorted(streets)}")
    for n in notes:
        print(f"    note: {n!r}")
    return {"tokens": sorted(tokens), "streets": sorted(streets), "notes": notes}


# ------------------------------------------------------------------------------------------------ pages

def new_context(browser, pii: dict, **kw) -> BrowserContext:
    ctx = browser.new_context(ignore_https_errors=True, reduced_motion="reduce", **kw)
    prefs = json.dumps(LOCAL_PREFS)
    ctx.add_init_script(
        f"try {{ const p = {prefs}; for (const k in p) localStorage.setItem(k, p[k]); }} catch (e) {{}}"
    )
    ctx.add_init_script(BLUR_JS.replace("__DATA__", json.dumps({"tokens": pii["tokens"], "streets": pii["streets"]})))
    return ctx


def guard(page: Page) -> None:
    def check(frame):
        if frame == page.main_frame:
            u = urlparse(frame.url)
            if u.scheme.startswith("http") and (u.hostname, u.port) != ("dev.ecoworks.ca", 3032):
                raise SystemExit(f"navigated off the demo stack: {frame.url}")
    page.on("framenavigated", check)


def login(ctx: BrowserContext, email: str) -> Page:
    # Through the API rather than the form: the sign-in page's markup changes more often than this script.
    r = ctx.request.post(f"{BASE}/api/auth/login", data={"email": email, "password": PASSWORD})
    if not r.ok:
        raise SystemExit(f"demo sign-in failed for {email}: {r.status} (see demo/README.md 'Accounts')")
    page = ctx.new_page()
    guard(page)
    return page


def map_idle(page: Page, timeout: int = 30000) -> None:
    page.wait_for_function("() => !!window.__mcMap && window.__mcMap.isStyleLoaded()", timeout=timeout)
    page.wait_for_function(
        "() => window.__mcMap.loaded() && window.__mcMap.areTilesLoaded() && !window.__mcMap.isMoving()",
        timeout=timeout,
    )
    page.wait_for_timeout(800)


def settle(page: Page, ms: int = 600) -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass
    page.evaluate("() => document.fonts.ready")
    page.wait_for_timeout(ms)


def shoot(page: Page, out: Path, name: str, **kw) -> Path:
    page.evaluate("() => document.fonts.ready")
    page.evaluate("() => window.__tourBlur && window.__tourBlur()")
    page.wait_for_timeout(150)
    path = out / f"{name}.png"
    page.screenshot(path=str(path), **kw)
    print(f"  saved {path}")
    return path


def first_turf(page: Page) -> str:
    r = page.request.get(f"{BASE}/api/turfs")
    return r.json()["turfs"][0]["id"]


# ------------------------------------------------------------------------------------------------ shots

def shot_map(browser, pii, out):
    ctx = new_context(browser, pii, **DESKTOP)
    page = login(ctx, ADMIN)
    page.goto(f"{BASE}/map")
    map_idle(page)
    # Frame the Ilderton turf and its doors.
    page.evaluate("() => window.__mcMap.jumpTo({ center: [-81.3405, 43.0515], zoom: MAP_ZOOM })".replace("MAP_ZOOM", str(MAP_ZOOM)))
    map_idle(page)
    settle(page)
    shoot(page, out, "map")
    ctx.close()


def shot_turfs(browser, pii, out):
    ctx = new_context(browser, pii, **DESKTOP)
    page = login(ctx, ORGANIZER)
    page.goto(f"{BASE}/turfs")
    settle(page)
    page.get_by_role("button", name="New turf").click()
    settle(page, 1000)
    # Pick two streets that are not in a turf yet so the shape map fills in. Never press Create.
    page.get_by_placeholder("e.g. Komoka — north of Glendon").fill("Komoka — Queen and Jefferies")
    for street in ("Queen St", "Jefferies Rd"):
        page.get_by_role("checkbox", name=re.compile(street)).first.check()
    settle(page, 1500)
    try:
        map_idle(page, 10000)
    except Exception:
        pass
    shoot(page, out, "turfs")
    ctx.close()


def shot_door(browser, pii, out):
    ctx = new_context(browser, pii, **PHONE, geolocation=ILDERTON, permissions=["geolocation"])
    page = login(ctx, ORGANIZER)
    tid = first_turf(page)
    page.goto(f"{BASE}/canvass/{tid}")
    settle(page, 1200)
    shoot(page, out, "door")
    ctx.close()


def shot_record(browser, pii, out):
    ctx = new_context(browser, pii, **PHONE, geolocation=ILDERTON, permissions=["geolocation"])
    page = login(ctx, ORGANIZER)
    tid = first_turf(page)
    page.goto(f"{BASE}/canvass/{tid}")
    settle(page, 1000)
    page.locator(".cv-door").nth(2).click()
    settle(page, 800)
    page.locator(".cv-results button", has_text="Spoke").first.click()
    settle(page, 800)
    # Fill the form the way a canvasser would, but never submit it: the demo data stays as seeded.
    pills = page.locator(".cv-pills button")
    if pills.count() > 1:
        pills.nth(1).click()
    page.locator(".cv-support__btn", has_text="4").first.click()
    page.locator("textarea").first.fill("Likes the sidewalk plan for Glendon Dr. Call back after the debate.")
    page.locator(".cv-spoke__intro").scroll_into_view_if_needed()
    settle(page, 600)
    shoot(page, out, "record")
    ctx.close()


def shot_drive(browser, pii, out):
    ctx = new_context(browser, pii, **PHONE, geolocation=ILDERTON, permissions=["geolocation"])
    page = login(ctx, ORGANIZER)
    tid = first_turf(page)
    page.goto(f"{BASE}/canvass/{tid}/drive")
    settle(page, 2500)
    shoot(page, out, "drive")
    ctx.close()


def shot_signs(browser, pii, out):
    ctx = new_context(browser, pii, **DESKTOP)
    page = login(ctx, ORGANIZER)
    page.goto(f"{BASE}/signs")
    settle(page, 1000)
    page.get_by_role("tab", name="Map").click()
    settle(page, 1500)
    try:
        map_idle(page, 10000)
    except Exception:
        pass
    shoot(page, out, "signs")
    ctx.close()


def shot_reports(browser, pii, out):
    ctx = new_context(browser, pii, **DESKTOP)
    page = login(ctx, ORGANIZER)
    page.goto(f"{BASE}/reports?tab=coverage")
    settle(page, 1500)
    shoot(page, out, "reports")
    ctx.close()


def shot_sheet(browser, pii, out):
    ctx = new_context(browser, pii, **DESKTOP)
    page = login(ctx, ORGANIZER)
    tid = first_turf(page)
    page.goto(f"{BASE}/turfs/{tid}/sheet")
    settle(page, 1500)
    try:
        map_idle(page, 10000)
    except Exception:
        pass
    shoot(page, out, "sheet")
    ctx.close()


SHOTS = {
    "map": shot_map,
    "turfs": shot_turfs,
    "door": shot_door,
    "record": shot_record,
    "drive": shot_drive,
    "signs": shot_signs,
    "reports": shot_reports,
    "sheet": shot_sheet,
}


def to_webp(png: Path) -> None:
    webp = png.with_suffix(".webp")
    for q in (82, 75, 68, 60):
        if shutil.which("cwebp"):
            subprocess.run(["cwebp", "-quiet", "-q", str(q), "-m", "6", str(png), "-o", str(webp)], check=True)
        else:
            from PIL import Image
            Image.open(png).save(webp, "WEBP", quality=q, method=6)
        if webp.stat().st_size <= 250_000:
            break
    print(f"  {webp.name}: {webp.stat().st_size // 1024} KB")


def main(argv: list[str]) -> int:
    out = OUT
    if "--out" in argv:
        i = argv.index("--out")
        out = Path(argv[i + 1])
        del argv[i : i + 2]
    out.mkdir(parents=True, exist_ok=True)
    names = argv or list(SHOTS)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        admin = browser.new_context(ignore_https_errors=True)
        login(admin, ADMIN).close()
        print("collecting names to blur")
        pii = collect_pii(admin)
        admin.close()
        for name in names:
            print(name)
            SHOTS[name](browser, pii, out)
            to_webp(out / f"{name}.png")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
