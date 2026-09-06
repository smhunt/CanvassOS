# Demo stack

A second, entirely **fabricated** database (`canvass_demo`) that runs alongside the real one, for
screenshots, video, training and any UI work that needs more than one user.

Nothing here comes from the voters list. Street names and coordinates are Middlesex County's public
open address data; every resident, and every account below, is invented. **Anything captured against
this stack can be published anywhere** — which is the whole reason it exists, because the real app is
full of electors' names and a screenshot of it is a disclosure.

## Build it

```bash
make demo            # drops and rebuilds canvass_demo: schema, migrations, fabricated residents
```

Then run the stack beside the real one (ports registered in `~/.claude/PORTS.md`):

```bash
cd api && set -a && . ../.env.demo && set +a && npx tsx watch src/server.ts   # API on 3132
cd web && CANVASS_WEB_PORT=3032 CANVASS_API_PORT=3132 npm run dev            # web on 3032
```

Open <https://dev.ecoworks.ca:3032>.

## Accounts

All use the password `demo-password-1`. They are created through the invite flow after seeding, not
by the seed script — `make demo` rebuilds the data, so recreate them afterwards if you need them.

| Email | Role | For testing |
|---|---|---|
| `demo@example.com` | admin | Everything; created on first boot from `.env.demo` |
| `priya.demo@example.com` | organizer | Turf building, assigning, reports |
| `rosa.demo@example.com` | volunteer | The door screen, offline queue, scoping |
| `aziz.demo@example.com` | volunteer | Moving a turf between two walkers |

## What is in it

48 households, 114 residents, on Elm/George/Glendon/Queen/Jefferies/Ilderton/Medway. A turf
"Ilderton village core" (18 doors) assigned to `demo`, with eight recorded results including a
follow-up note, and two lawn signs with GPS fixes.

## Rules

- **Never point a browser or a recording at `https://dev.ecoworks.ca:3030`.** That is the real
  voters list. Use 3032.
- Do not import real CSVs into `canvass_demo`.
- If you add fabricated surnames, check they do not collide with the real list first — the seed
  script does not check for you.
