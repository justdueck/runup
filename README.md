# runup

A personal flight-planning [MCP](https://modelcontextprotocol.io) server for a
general-aviation renter pilot. From Claude Desktop / claude.ai it can:

1. find free windows in your calendar,
2. check which of your checked-out rental aircraft are actually free at the
   school (live from the NeedleNine portal, or fixture data until you connect it),
3. score current conditions against **your personal minimums** using free
   aviation weather (aviationweather.gov METAR/TAF),
4. propose candidate out-and-back routes sized to a window,
5. and compose all of that for a whole day (`plan_day`).

Your pilot profile (home airports, aircraft, day/night minimums, currency
goals, preferences) persists on the server side in a JSON file, so it survives
across chats. Two of the tools also ship an **MCP Apps** View — an editable
profile & minimums form that renders inline in hosts that support the
MCP Apps extension.

> Status: calendar and routes are still fixture/naive providers behind
> pluggable interfaces; aircraft availability is real once the NeedleNine
> scheduler is configured (portal automation, read-only); the route planner
> uses a small bundled Puget Sound airport sample (placeholder data). See
> [Not yet implemented](#not-yet-implemented).

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `get_profile` *(UI)* | – | Full pilot profile. Renders the profile & minimums form in MCP Apps hosts. |
| `update_profile` *(UI)* | `patch` – partial profile (deep merge; arrays replace) | Updated profile, persisted to disk. |
| `get_free_windows` | `startDate`, `endDate?` (YYYY-MM-DD), `minDurationHours?` | Free windows from the calendar provider. |
| `get_conditions` | `airports?` (ICAO ids, 1–10; defaults to your home airports), `runwayHeadingDeg?`, `timeOfDay?` | Per-airport METAR summary (ceiling, vis, wind/gust, crosswind, flight category) + go/no-go score vs your minimums, plus TAF summaries. |
| `get_aircraft_availability` | `start`, `end` (ISO) | Tails free for the whole window, plus per-tail free intervals, the bookings/maintenance blocking each tail (no member identities), and airworthiness flags. NeedleNine when configured, fixture data otherwise. |
| `get_scheduler_status` | – | Whether the NeedleNine scheduler is configured (email, portal, timezone), where credentials come from (macOS keychain / env — names only), whether a Playwright browser is installed, and setup steps. Never returns secrets. |
| `plan_routes` | `start`, `end` (ISO), `tail?`, `maxCandidates?` | Out-and-back candidates departing each home airport whose round trip fits the window, plus a local-practice option per home field. |
| `plan_day` | `date` (YYYY-MM-DD), `timeOfDay?`, `runwayHeadingDeg?`, `minWindowHours?` | Windows → availability → conditions (at every home airport) → routes in one structured result. |

All tools return JSON as text content **and** as `structuredContent`, so both
plain chat clients and MCP Apps Views can consume them.

## Profile & minimums

Stored at `${RUNUP_HOME:-~/.runup}/profile.json`
(created with sane defaults on first save; validated with zod). Schema:

```jsonc
{
  "schemaVersion": 1,
  // Home airports, ICAO/FAA ids: at least one, first is the primary field.
  // Default: KPAE (Paine Field, Everett WA) + KTIW (Tacoma Narrows WA).
  "homeAirports": ["KPAE", "KTIW"],
  "aircraft": [
    { "tail": "N678SP", "type": "C172S", "checkedOut": true,
      "cruiseKtas": 115, "fuelBurnGph": 9.5, "usableFuelGal": 53, "notes": "" }
  ],
  "minimums": {
    "day":   { "ceilingFt": 3000, "visSm": 5, "windKt": 20, "gustSpreadKt": 10, "crosswindKt": 8 },
    "night": { "ceilingFt": 5000, "visSm": 7, "windKt": 15, "gustSpreadKt": 8,  "crosswindKt": 6 }
  },
  "currencyGoals": { "nightLandings": true, "ifrApproaches": false, "passengerCurrency": true, "notes": "" },
  "preferences": { "typicalFlightKinds": ["local practice", "cross-country", "food run"],
                   "maxDistanceNm": 250, "budgetPerFlightUsd": 300 },
  // Optional flight-school scheduler connection (NeedleNine). Email only — the
  // password lives in the macOS keychain, never here.
  "scheduler": { "provider": "needlenine", "email": "you@example.com" }
}
```

**No secrets in this file.** The scheduler block carries only your NeedleNine
login *email* (plus optional `portalUrl`, `timezone`, `tenantId` overrides). The
password is read at runtime from the macOS keychain (service
`runup-needlenine`, account = your email) or, off macOS, from the
`RUNUP_NEEDLENINE_PASSWORD` environment variable — see
`src/providers/needlenine/credentials.ts`.

## Aircraft availability (NeedleNine)

The flight school runs [NeedleNine](https://needlenine.com), which has no public
API. `get_aircraft_availability` therefore drives the member portal the way you
would: a headless Chromium (Playwright) logs into `portal.needlenine.com` as
you, opens the reservation calendar for each local day the window spans, and
reads the schedule and aircraft roster **that the page has already decrypted
for display** (an init script observes the app's own `JSON.parse` calls and
keeps only ids, times and status codes — no other members' names or emails
ever leave the browser). The result is per checked-out tail: free
sub-intervals, the bookings/maintenance blocks that break them up, and roster
flags (open discrepancies, overdue dispatch-required maintenance). It is
strictly **read-only**: it never clicks book, cancel or check-in, and it never
stores anything from the portal on disk.

All portal-specific knowledge (routes, login-form ids, the schedule's day
controls, storage key names, payload field names) lives in one adapter,
`src/providers/needlenine/site.ts`, so a portal redesign is a one-file fix.

### First-run setup (macOS)

```bash
npm install                       # includes playwright
npx playwright install chromium   # the browser binary (~100 MB, once)

# Store your NeedleNine password in the login keychain
# (prompts for the password; -w with no value keeps it off the command line):
security add-generic-password -a "you@example.com" -s runup-needlenine -w
```

Then tell runup which account to use — from a chat, via `update_profile`:

```json
{ "patch": { "scheduler": { "provider": "needlenine", "email": "you@example.com" } } }
```

`get_scheduler_status` confirms the configuration and that Chromium is found.
The first availability query logs into the portal as you (one session per
running server, closed when the server exits). Non-macOS hosts can set
`RUNUP_NEEDLENINE_EMAIL` / `RUNUP_NEEDLENINE_PASSWORD` in the server
environment instead (less safe: the password sits in the process env). Other
knobs: `RUNUP_CHROMIUM_PATH` (use an existing Chromium binary),
`RUNUP_HEADLESS=0` (show the browser while debugging), and the profile's
`scheduler.timezone` (default `America/Los_Angeles`, the school's zone).

## Minimums scoring

`src/scoring.ts` is a pure function: condition summary + your minimums (day
or night block) → per-limit `pass` / `fail` / `unknown` / `skipped` with a
margin in the limit's own unit, an overall `go` / `no-go`, and a short
`reasons` array. It is conservative: missing data (`unknown`) makes the
verdict `no-go`; crosswind is only `skipped` (non-blocking) when you did not
supply a runway heading.

## MCP Apps View (profile & minimums form)

`get_profile` and `update_profile` declare `_meta.ui.resourceUri =
ui://runup/profile-form.html` (via `registerAppTool` from
`@modelcontextprotocol/ext-apps/server`). The matching resource is a single
self-contained HTML page (`text/html;profile=mcp-app`) whose script uses the
`App` class from `@modelcontextprotocol/ext-apps` to receive the tool result and
to call `update_profile` when you press Save. `npm run build` bundles
`src/ui/profile-form.ts` with esbuild and inlines it into
`dist/ui/profile-form.html`. Hosts without MCP Apps support just get the JSON
text — UI is a progressive enhancement.

## Run it

```bash
npm install
npm run build     # tsc + bundles the View into dist/ui/profile-form.html
npm test          # vitest: unit tests + a Playwright run against a local mock portal (no network)
npm start         # node dist/index.js (MCP over stdio)
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "runup": {
      "command": "node",
      "args": ["/absolute/path/to/runup/dist/index.js"],
      "env": { "RUNUP_HOME": "/Users/you/.runup" }
    }
  }
}
```

Restart Claude Desktop after editing. The server logs to stderr; stdout is the
protocol channel.

## Project layout

```
src/
  index.ts            stdio entry point (provider cleanup on exit)
  server.ts           tool + UI-resource registration (createServer)
  profile.ts          profile store, zod schema, defaults, patch merge
  weather.ts          aviationweather.gov client + METAR/TAF summaries
  scoring.ts          personal-minimums scoring (pure)
  planning.ts         plan_day composition + aircraft resolution
  geo.ts              great-circle helper
  types.ts            shared domain types
  data/airports.json  small Puget Sound airport sample (placeholder; swap in FAA data)
  providers/          CalendarProvider, AvailabilityProvider, RoutePlanner + fixtures
    needlenine/       NeedleNine scheduler: site adapter, Playwright session, availability math,
                      keychain credentials, config/status
  ui/                 profile & minimums View (HTML template + App script)
scripts/build-ui.mjs  esbuild bundling of the View into a single HTML file
tests/                vitest suites + recorded-shape weather fixtures
  needlenine/         availability math, capture-hook, credentials, provider, and e2e suites
  mock-portal/        local NeedleNine-shaped portal used by the Playwright e2e test
```

## Not yet implemented

- **Calendar source** — `FixtureCalendarProvider` only; Google Calendar
  (freebusy + OAuth, token in keychain) is a TODO.
- **NeedleNine, next steps** — the schedule is read a day at a time by
  stepping the calendar (fine for windows within a couple of weeks); a
  month-view fetch, the portal's own "check availability" endpoints, and the
  DayPilot DOM fallback documented in `site.ts` are not implemented; the
  tenant timezone is a profile setting rather than read from the portal; the
  profile View form does not edit the scheduler block yet (use
  `update_profile`).
- **Real airport data** — `src/data/airports.json` is a hand-maintained
  16-airport Puget Sound / Pacific Northwest placeholder set (coordinates and
  elevations transcribed from public sources noted per airport, no runway
  data); swap in FAA NASR data and per-runway headings before trusting it.
- **Route balancing across home airports** — the naive planner pools
  candidates departing every home airport and appends a local option per
  field; it does not yet know which field the aircraft is actually at.
- **Forecast-aware scoring** — scoring uses the *current* METAR; matching
  TAF change groups to each future window is not done yet.
- **Second View** — a "day plan" card for `plan_day` is the next UI candidate;
  only the profile & minimums form exists today.

## Notes

- Weather fixtures in `tests/fixtures/` are hand-written in the documented
  aviationweather.gov JSON shape; record real responses once the server has
  network access.
- The NeedleNine integration is personal-use, on-demand automation of your own
  member login: low volume (a handful of page loads per query, cached for a
  few minutes), read-only, and it discards other members' data at the source.
- Distances/times are great-circle at cruise TAS with fixed allowances
  (`PLANNING_ALLOWANCES` in `src/providers/routes.ts`); no wind, terrain,
  airspace, or weight-and-balance. Planning aid only — you are PIC.
