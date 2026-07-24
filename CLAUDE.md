# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`runup` is a personal, local TypeScript **MCP server over stdio** for general-aviation
flight planning by one renter pilot. It keeps a pilot profile with personal minimums,
pulls METARs/TAFs from aviationweather.gov and scores them against those minimums, and
composes calendar / aircraft-availability / route providers into planning tools
(`plan_day` and friends). Two profile tools also ship an MCP Apps View (an inline profile
& minimums form). Node >= 20, ESM (`"type": "module"`), strict TypeScript, zod v4,
`@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps`.

## Commands

- `npm install` — `package-lock.json` is committed, with every `resolved` URL pointing at
  public `registry.npmjs.org`; keep it that way (see sandbox notes below).
- `npm run typecheck` — both projects, `--noEmit`: `tsconfig.json` (server, NodeNext,
  excludes `src/ui`) and `tsconfig.ui.json` (browser View, DOM lib).
- `npm run setup` — build, then register this checkout in Claude Desktop's
  `claude_desktop_config.json` (`scripts/setup-claude-desktop.mjs`; merge-safe, keeps one
  `.backup`, `CLAUDE_DESKTOP_CONFIG` overrides the config path, never echoes iCal URLs).
- `npm run build` — `tsc` to `dist/`, then `node scripts/build-ui.mjs` esbuild-bundles
  `src/ui/profile-form.ts` and inlines it into `dist/ui/profile-form.html`.
- `npm test` — `vitest run` (no vitest config file; defaults pick up `tests/*.test.ts`).
  Single file: `npx vitest run tests/scoring.test.ts`; single test: add `-t "<name>"`.
- `npm start` — `node dist/index.js`; build first. stdout is the MCP protocol channel.
- End-to-end verification lives in `.claude/skills/verify/SKILL.md` (`/verify`): build,
  launch with `RUNUP_HOME=$(mktemp -d) node dist/index.js`, drive JSON-RPC over stdin.
  Use it for any change with a runtime surface — do not stop at unit tests.

## Architecture

- `src/index.ts` — stdio entry point; connects `createServer()` to `StdioServerTransport`.
  Never write to stdout — log with `console.error`.
- `src/server.ts` — `createServer(deps)`: registers the 9 tools (`get_profile`,
  `update_profile`, `get_free_windows`, `get_conditions`, `get_aircraft_availability`,
  `get_scheduler_status`, `plan_routes`, `plan_day`, `export_foreflight`) plus the
  `ui://runup/profile-form.html` App resource. Deps
  (profile path, providers, weather client, UI loader, ICS fetcher, env) are injectable so
  tests construct the server on fixtures. `jsonResult()` = text + `structuredContent`;
  `errorResult()` = `isError: true`. The calendar source is selected per request:
  the iCal provider when `RUNUP_ICAL_URLS` or the profile's `calendar.icalUrls` is set,
  the fixture provider (with a setup note) otherwise. iCal URLs are bearer secrets:
  redacted from every tool result, and error text is scrubbed before it leaves the server.
- `src/providers/ical-calendar.ts` + `src/tz.ts` + `src/daylight.ts` — ICS feed download
  and recurrence expansion (node-ical), IANA-zone date math, and day/night/mixed window
  tagging (suncalc).
- `src/providers/needlenine/` — read-only NeedleNine portal automation (Playwright) behind
  `SchedulerAvailabilityProvider`; all portal-specific knowledge lives in `site.ts`.
  Credentials: email in the profile `scheduler` block, password in the macOS keychain or
  `RUNUP_NEEDLENINE_PASSWORD`. The profile's `scheduler.portalUrl` is allowlisted to https
  needlenine.com hosts (credential-exfiltration guard); `RUNUP_NEEDLENINE_PORTAL_URL` is
  the trusted operator override and takes precedence.
- `src/profile.ts` — zod schemas, defaults, and the store at
  `${RUNUP_HOME:-~/.runup}/profile.json` (missing file loads as defaults). Patch semantics:
  objects deep-merge, arrays/scalars replace, `schemaVersion` is not patchable, the patch
  schema is `.strict()`. Exception: keys in `REPLACE_WHOLESALE_KEYS` (currently
  `scheduler`) are connection descriptors replaced wholesale, never deep-merged —
  a stale tenantId/portalUrl must not survive an account switch. Writes are validated, atomic (temp file + rename), and serialized
  per file through a save queue. Credentials go to the OS keychain, never in the
  profile — see `resolveNeedleNineCredentials()` in `src/providers/needlenine/credentials.ts`.
- `src/weather.ts` — aviationweather.gov Data API client behind the `HttpJsonFetcher`
  interface (`NodeFetcher` = global fetch with a 10 s timeout), tolerant `looseObject`
  schemas, METAR to `ConditionSummary`, TAF summary, crosswind and flight-category helpers.
- `src/scoring.ts` — pure personal-minimums scoring: per-limit pass/fail/unknown/skipped
  with margins; missing data is `unknown` and forces `no-go`; crosswind is only `skipped`
  (non-blocking) when no runway heading was supplied.
- `src/planning.ts` — `planDay` composition (windows, availability, conditions at every
  home airport, routes), `resolveAircraftPerformance`, `dateSpan`/`dayRange`.
- `src/foreflight.ts` — ForeFlight handoff: `foreflightmobile://` deep links and Garmin
  `.fpl` generation. `RouteCandidate` stays vendor-free; candidates are decorated with
  their `foreflight` block only at the tool-output boundary (`withForeflight` in the
  `plan_routes` handler and inside `planDay`) — keep it that way for any new EFB target.
- `src/providers/` — `CalendarProvider` / `AvailabilityProvider` / `RoutePlanner`
  interfaces (`types.ts`) with `FixtureCalendarProvider`, `FixtureAvailabilityProvider`,
  `NaiveRoutePlanner`; `NeedleNineProvider` is a documented stub that throws.
- `src/data/airports.json` (+ `airports.ts` loader) — 16-airport Puget Sound PLACEHOLDER
  sample (home fields KPAE/KTIW), no runway data; slated for replacement with FAA NASR
  data. Don't build anything that trusts its distances, or invent runway headings.
- `src/ui/profile-form.html` + `profile-form.ts` (MCP Apps `App` from
  `@modelcontextprotocol/ext-apps/app-with-deps`) + `profile-patch.ts` (DOM-free patch
  builder, unit-tested); `scripts/build-ui.mjs` inlines the bundle at the
  `<!-- APP_SCRIPT -->` marker into one self-contained `dist/ui/profile-form.html`
  (sandboxed iframe, no external fetches). Unbuilt, the server serves a "form not built"
  fallback page.
- `src/types.ts`, `src/geo.ts`, `src/util.ts` — shared domain types, haversine, rounding.

## Conventions that are easy to get wrong

- Tests never touch the network or a real `~/.runup`: inject fetchers/providers
  (`tests/helpers.ts` `FixtureFetcher`/`fixtureWeatherClient`, fixture providers,
  `InMemoryTransport`), read `tests/fixtures/*.json`, and use `mkdtemp` dirs for profiles.
- Keep pure logic pure and unit-tested: `scoring.ts`, `geo.ts`, `util.ts`,
  `ui/profile-patch.ts` do no I/O.
- Profile arrays (`homeAirports`, `aircraft`) and the `scheduler` block are replaced
  wholesale by a patch; other nested objects merge. Keep those semantics identical in
  `profile.ts` and the View patch builder.
- No secrets — calendar iCal URLs, scheduler credentials, tokens — in the repo,
  `profile.json` (beyond the redacted `calendar.icalUrls` fallback), logs, tool output, or
  error messages. Scheduler credentials belong in the OS keychain behind
  `resolveNeedleNineCredentials()` (`src/providers/needlenine/credentials.ts`).
- Keep provider/site-specific code inside its adapter module under `src/providers/`; the
  server and planner see only the interfaces in `providers/types.ts`.
- Tool errors are one-line, human-readable `isError: true` results (`errorResult`,
  `formatIssues`) — no stack dumps to the model.
- ESM + `moduleResolution: NodeNext`: import TS modules with a `.js` extension
  (`./scoring.js`). zod is v4 (`z.iso.datetime`, `z.looseObject`, `.meta()`).

## Working from Anthropic's Claude Code remote sandbox

Environment-specific — none of this applies on the developer's Mac.

- npm may be routed through a sandbox mirror/proxy (in some sessions public npmjs is
  blocked outright). The committed `package-lock.json` must keep every `resolved` URL on
  public `registry.npmjs.org`: after any `npm install` that touches it, check
  `git diff package-lock.json` (or grep the `resolved` hosts) before committing, and never
  commit entries that point at an internal mirror.
- aviationweather.gov and most external hosts are proxy-blocked, so live-API code is
  exercised only through fixtures; `get_conditions` returning `isError: true` ("fetch
  failed") and `plan_day` carrying a "Weather fetch failed" note is expected here.
- Playwright's chromium is preinstalled at `/opt/pw-browsers` (for the in-flight
  availability-provider work) — never run `playwright install`.
- GitHub access varies by session: some remote sessions have GitHub MCP tools (can open
  PRs directly), others can only push. Without API access, push the branch and hand the
  developer a compare link
  (`https://github.com/justdueck/runup/compare/main...<branch>`).
