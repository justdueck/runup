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

> Status: the calendar leg is real — free windows come from your private
> Google Calendar iCal feed (see [Calendar](#calendar-google-calendar-secret-ical-address)),
> tagged with daylight at your home airports. Aircraft availability is real
> once the NeedleNine scheduler is configured (portal automation, read-only).
> The route planner uses a small bundled Puget Sound airport sample
> (placeholder data). See
> [Not yet implemented](#not-yet-implemented).

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `get_profile` *(UI)* | – | Full pilot profile (iCal feed URLs redacted). Renders the profile & minimums form in MCP Apps hosts. |
| `update_profile` *(UI)* | `patch` – partial profile (deep merge; arrays replace) | Updated profile (redacted), persisted to disk. |
| `get_free_windows` | `startDate`, `endDate?` (YYYY-MM-DD, profile time zone), `minDurationHours?` | Free windows from your iCal feed (busy events buffered + subtracted from your flyable hours), each tagged `day` / `night` / `mixed` with sun times per home airport; canned fixture windows plus a "no calendar configured" note when no feed is set. |
| `get_conditions` | `airports?` (ICAO ids, 1–10; defaults to your home airports), `runwayHeadingDeg?`, `timeOfDay?` | Per-airport METAR summary (ceiling, vis, wind/gust, crosswind, flight category) + go/no-go score vs your minimums, plus TAF summaries. |
| `get_aircraft_availability` | `start`, `end` (ISO) | Tails free for the whole window, plus per-tail free intervals, the bookings/maintenance blocking each tail (no member identities), and airworthiness flags. NeedleNine when configured, fixture data otherwise. |
| `get_scheduler_status` | – | Whether the NeedleNine scheduler is configured (email, portal, timezone), where credentials come from (macOS keychain / env — names only), whether a Playwright browser is installed, and setup steps. Never returns secrets. |
| `plan_routes` | `start`, `end` (ISO), `tail?`, `maxCandidates?` | Out-and-back candidates departing each home airport whose round trip fits the window, plus a local-practice option per home field. |
| `plan_day` | `date` (YYYY-MM-DD), `timeOfDay?`, `runwayHeadingDeg?`, `minWindowHours?` | Windows → availability → conditions (at every home airport) → routes in one structured result. |
| `export_foreflight` | `route` (identifiers in flying order), `routeName?`, `save?` | ForeFlight handoff: a `foreflightmobile://` deep link that opens the route in ForeFlight, plus a Garmin `.fpl` file written to `${RUNUP_HOME}/exports/` for import. |

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
                   "maxDistanceNm": 250, "budgetPerFlightUsd": 300,
                   // IANA zone your calendar days / flyable hours are read in, plus those hours.
                   "timezone": "America/Los_Angeles",
                   "earliestLocalTime": "07:00", "latestLocalTime": "21:00" },
  "calendar": {
    // Fallback iCal feed URLs - prefer the RUNUP_ICAL_URLS env var (see below).
    // BEARER SECRETS: always redacted ("***configured***") in tool output.
    "icalUrls": [],
    "allDayEventsBlock": false,   // whether all-day events block the whole day
    "bufferBeforeMinutes": 60,    // keep this much clear before each event...
    "bufferAfterMinutes": 30,     // ...and after
    "minDurationHours": 2.5       // drop free windows shorter than this
  },
  // Optional flight-school scheduler connection (NeedleNine). Email only — the
  // password lives in the macOS keychain, never here.
  "scheduler": { "provider": "needlenine", "email": "you@example.com" }
}
```

Older `profile.json` files without the `calendar` / time-zone / `scheduler`
fields keep working — the schema fills them with defaults (scheduler simply
stays unconfigured).

**Secrets:** the scheduler block carries only your NeedleNine login *email*
(plus optional `portalUrl`, `timezone`, `tenantId` overrides); the password is
read at runtime from the macOS keychain (service `runup-needlenine`, account =
your email) or, off macOS, from the `RUNUP_NEEDLENINE_PASSWORD` environment
variable — see `src/providers/needlenine/credentials.ts`. The one sensitive
value the profile *may* hold is `calendar.icalUrls`; prefer the
`RUNUP_ICAL_URLS` environment variable instead, and if you do use the profile
field remember `profile.json` is a plain-text file (it lives outside the repo
and is gitignored — never copy it into version control). Every tool result —
including the profile & minimums View payload — redacts the URLs to
`***configured***`, and error messages never contain them.

**Portal URL is allowlisted.** Because the profile can be edited from any
chat (`update_profile`) and the login flow types your password into whatever
page `portalUrl` points at, the profile only accepts https `needlenine.com`
URLs, and the browser refuses to enter credentials on any other origin (e.g.
after an unexpected redirect). To point at a staging or local mock portal,
set the trusted `RUNUP_NEEDLENINE_PORTAL_URL` environment variable on the
server instead.

## Calendar (Google Calendar secret iCal address)

`get_free_windows` and `plan_day` read your calendar through Google
Calendar's **secret address in iCal format** — a private ICS feed URL that
grants read access to whoever has it (treat it exactly like a password).

**Get the URL** (Google Calendar, web):

1. Settings (gear) → **Settings** → in the left sidebar under *Settings for
   my calendars*, click the calendar you want.
2. Scroll to **Integrate calendar**.
3. Copy **Secret address in iCal format** (the `.../private-.../basic.ics`
   URL). Do *not* use the public address unless the calendar is public.
   ("Reset" on that page rotates the secret if it ever leaks.)

**Configure it** in the MCP server's environment, e.g. the Claude Desktop
config `env` block (comma-separate several feeds — work + personal):

```json
{
  "mcpServers": {
    "runup": {
      "command": "node",
      "args": ["/absolute/path/to/runup/dist/index.js"],
      "env": {
        "RUNUP_HOME": "/Users/you/.runup",
        "RUNUP_ICAL_URLS": "https://calendar.google.com/calendar/ical/you%40gmail.com/private-XXXXXXXX/basic.ics"
      }
    }
  }
}
```

> **Warning:** the iCal URL is a bearer secret — never commit it, paste it
> into chats, or share this config file. runup never logs it, redacts it from
> every tool result, and reports feed problems by number ("iCal feed #2"),
> never by URL. `RUNUP_ICAL_URLS` takes precedence over the profile's
> `calendar.icalUrls`.

**How windows are computed:** every non-cancelled, non-"Free" (`TRANSP:TRANSPARENT`)
event becomes a busy block; recurring events are expanded within the query
range with node-ical (RRULE, EXDATE and RECURRENCE-ID overrides honored),
`calendar.bufferBeforeMinutes` / `bufferAfterMinutes` are added around each
timed event, overlaps are merged, and the busy time is subtracted from each
local day's flyable hours (`preferences.earliestLocalTime`–`latestLocalTime`
in `preferences.timezone`). Windows shorter than `calendar.minDurationHours`
(or the tool's `minDurationHours` override) are dropped. All-day events only
count when `calendar.allDayEventsBlock` is true (then they block the whole
local day, unbuffered).

**Daylight tagging:** each window carries `daylight: "day" | "night" | "mixed"`
plus sunrise / sunset / civil-twilight times per home airport (suncalc, using
the bundled airport coordinates). Nothing is filtered by daylight — a night
window is still a window (night currency), it is just labeled.

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
`RUNUP_HEADLESS=0` (show the browser while debugging),
`RUNUP_CHROMIUM_SANDBOX=1|0` (renderer sandbox; on by default on macOS), and
the profile's `scheduler.timezone` (default `America/Los_Angeles`, the
school's zone).

## ForeFlight handoff

Plan in chat, fly from ForeFlight. Every route candidate from `plan_routes` /
`plan_day` carries a `foreflight` block:

```jsonc
"foreflight": {
  "route": "KPAE KAWO KPAE",
  "openUrl": "foreflightmobile://maps/search?q=KPAE%20KAWO%20KPAE"
}
```

Tap `openUrl` on the iPhone/iPad that has ForeFlight installed and the route
opens in ForeFlight's Maps view (ForeFlight registers the
`foreflightmobile://` URL scheme and resolves the identifiers against its own
nav database). From there use **Send To → Flights** to save it — ForeFlight
sync then makes the flight available on your other devices, so you can plan on
the phone and fly it from the iPad.

`export_foreflight` does the same for any waypoint sequence and additionally
writes a Garmin FlightPlan (`.fpl`) file — ForeFlight's import format — to
`${RUNUP_HOME:-~/.runup}/exports/`. AirDrop/email the file to the device (or
open it from the Files app) and choose "Open in ForeFlight" if you prefer
importing over the link. The `.fpl` needs coordinates, so it is only generated
when every waypoint is in the bundled airport sample; the deep link works
regardless.

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

Claude Desktop config (`claude_desktop_config.json`) — see the
[Calendar](#calendar-google-calendar-secret-ical-address) section for adding
`RUNUP_ICAL_URLS` to this `env` block:

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
  profile.ts          profile store, zod schema, defaults, patch merge, secret redaction
  http.ts             tiny fetch layer (timeouts, injectable, URL-redacting errors)
  tz.ts               IANA time-zone helpers (zoned midnight, ISO with offset)
  daylight.ts         sunrise/sunset/civil-twilight tagging (suncalc)
  weather.ts          aviationweather.gov client + METAR/TAF summaries
  scoring.ts          personal-minimums scoring (pure)
  planning.ts         plan_day composition + aircraft resolution
  foreflight.ts       ForeFlight deep links + Garmin .fpl generation
  geo.ts              great-circle helper
  types.ts            shared domain types
  data/airports.json  small Puget Sound airport sample (placeholder; swap in FAA data)
  providers/          CalendarProvider (iCal + fixture), AvailabilityProvider, RoutePlanner
    needlenine/       NeedleNine scheduler: site adapter, Playwright session, availability math,
                      keychain credentials, config/status
  ui/                 profile & minimums View (HTML template + App script)
scripts/build-ui.mjs  esbuild bundling of the View into a single HTML file
tests/                vitest suites + fixtures (weather JSON, iCal .ics files)
  needlenine/         availability math, capture-hook, credentials, provider, and e2e suites
  mock-portal/        local NeedleNine-shaped portal used by the Playwright e2e test
```

## Not yet implemented

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
- **Calendar (partly)** — the iCal provider covers Google Calendar (and any
  ICS feed); a native freebusy/OAuth integration and per-event categories
  ("flying" vs "busy") are not built. Known parser limits: Google "working
  location" / focus-time entries are ordinary events and count as busy; all-day
  events are date-based (whole local days when they block); events with no
  DTEND/DURATION are zero-length (their buffers still apply); floating times
  (no `TZID` and no trailing `Z` — never emitted by Google's feed) are read in
  the server host's zone rather than the profile zone; one URL per feed.

## Notes

- Weather fixtures in `tests/fixtures/` are hand-written in the documented
  aviationweather.gov JSON shape; record real responses once the server has
  network access. The `tests/fixtures/ical-*.ics` files are synthetic calendars
  (plain timed event, weekly RRULE with an EXDATE and a moved instance, an
  all-day event, a TZID event) served by in-memory fetchers — tests never hit
  the network.
- The NeedleNine integration is personal-use, on-demand automation of your own
  member login: low volume (a handful of page loads per query, cached for a
  few minutes), read-only, and it discards other members' data at the source.
- Distances/times are great-circle at cruise TAS with fixed allowances
  (`PLANNING_ALLOWANCES` in `src/providers/routes.ts`); no wind, terrain,
  airspace, or weight-and-balance. Planning aid only — you are PIC.
