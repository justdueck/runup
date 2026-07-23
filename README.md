# runup

A personal flight-planning [MCP](https://modelcontextprotocol.io) server for a
general-aviation renter pilot. From Claude Desktop / claude.ai it can:

1. find free windows in your calendar,
2. check which rental aircraft look available at the school,
3. score current conditions against **your personal minimums** using free
   aviation weather (aviationweather.gov METAR/TAF),
4. propose candidate out-and-back routes sized to a window,
5. and compose all of that for a whole day (`plan_day`).

Your pilot profile (home airports, aircraft, day/night minimums, currency
goals, preferences) persists on the server side in a JSON file, so it survives
across chats. Two of the tools also ship an **MCP Apps** View — an editable
profile & minimums form that renders inline in hosts that support the
MCP Apps extension.

> Status: first scaffold. Calendar and aircraft availability are fixture
> (canned) providers behind pluggable interfaces; the route planner uses a
> small bundled Puget Sound airport sample (placeholder data). See
> [Not yet implemented](#not-yet-implemented).

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `get_profile` *(UI)* | – | Full pilot profile. Renders the profile & minimums form in MCP Apps hosts. |
| `update_profile` *(UI)* | `patch` – partial profile (deep merge; arrays replace) | Updated profile, persisted to disk. |
| `get_free_windows` | `startDate`, `endDate?` (YYYY-MM-DD), `minDurationHours?` | Free windows from the calendar provider. |
| `get_conditions` | `airports?` (ICAO ids, 1–10; defaults to your home airports), `runwayHeadingDeg?`, `timeOfDay?` | Per-airport METAR summary (ceiling, vis, wind/gust, crosswind, flight category) + go/no-go score vs your minimums, plus TAF summaries. |
| `get_aircraft_availability` | `start`, `end` (ISO) | Tails free for the window (fixture provider for now). |
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
                   "maxDistanceNm": 250, "budgetPerFlightUsd": 300 }
}
```

**No secrets in this file.** Flight-school scheduler credentials will live in
the OS keychain (macOS Keychain / Windows Credential Manager / libsecret) —
`getSchedulerCredentials()` in `src/profile.ts` is a documented TODO stub.

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
npm test          # vitest (fixtures only, no network)
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
  index.ts            stdio entry point
  server.ts           tool + UI-resource registration (createServer)
  profile.ts          profile store, zod schema, defaults, patch merge
  weather.ts          aviationweather.gov client + METAR/TAF summaries
  scoring.ts          personal-minimums scoring (pure)
  planning.ts         plan_day composition + aircraft resolution
  geo.ts              great-circle helper
  types.ts            shared domain types
  data/airports.json  small Puget Sound airport sample (placeholder; swap in FAA data)
  providers/          CalendarProvider, AvailabilityProvider, RoutePlanner + fixtures
  ui/                 profile & minimums View (HTML template + App script)
scripts/build-ui.mjs  esbuild bundling of the View into a single HTML file
tests/                vitest suites + recorded-shape weather fixtures
```

## Not yet implemented

- **Calendar source** — `FixtureCalendarProvider` only; Google Calendar
  (freebusy + OAuth, token in keychain) is a TODO.
- **Aircraft availability (NeedleNine)** — `NeedleNineProvider` is a stub.
  NeedleNine has no public API; the plan is to authenticate against the
  portal's JSON backend and reuse the schedule endpoints it calls (Playwright
  grid-reading as a fallback), with credentials in the OS keychain.
- **Real airport data** — `src/data/airports.json` is a hand-maintained
  16-airport Puget Sound / Pacific Northwest placeholder set (coordinates and
  elevations transcribed from public sources noted per airport, no runway
  data); swap in FAA NASR data and per-runway headings before trusting it.
- **Route balancing across home airports** — the naive planner pools
  candidates departing every home airport and appends a local option per
  field; it does not yet know which field the aircraft is actually at.
- **Forecast-aware scoring** — scoring uses the *current* METAR; matching
  TAF change groups to each future window is not done yet.
- **Credentials** — OS keychain storage is a documented stub.
- **Second View** — a "day plan" card for `plan_day` is the next UI candidate;
  only the profile & minimums form exists today.

## Notes

- Weather fixtures in `tests/fixtures/` are hand-written in the documented
  aviationweather.gov JSON shape; record real responses once the server has
  network access.
- Distances/times are great-circle at cruise TAS with fixed allowances
  (`PLANNING_ALLOWANCES` in `src/providers/routes.ts`); no wind, terrain,
  airspace, or weight-and-balance. Planning aid only — you are PIC.
