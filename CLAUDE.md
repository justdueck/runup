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

- `npm install` — no lockfile is committed; keep it that way (see sandbox notes below).
- `npm run typecheck` — both projects, `--noEmit`: `tsconfig.json` (server, NodeNext,
  excludes `src/ui`) and `tsconfig.ui.json` (browser View, DOM lib).
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
- `src/server.ts` — `createServer(deps)`: registers the 7 tools (`get_profile`,
  `update_profile`, `get_free_windows`, `get_conditions`, `get_aircraft_availability`,
  `plan_routes`, `plan_day`) plus the `ui://runup/profile-form.html` App resource. Deps
  (profile path, providers, weather client, UI loader) are injectable so tests construct
  the server on fixtures. `jsonResult()` = text + `structuredContent`; `errorResult()` =
  `isError: true`.
- `src/profile.ts` — zod schemas, defaults, and the store at
  `${RUNUP_HOME:-~/.runup}/profile.json` (missing file loads as defaults). Patch semantics:
  objects deep-merge, arrays/scalars replace, `schemaVersion` is not patchable, the patch
  schema is `.strict()`. Writes are validated, atomic (temp file + rename), and serialized
  per file through a save queue. `getSchedulerCredentials()` is a deliberate stub —
  credentials go to the OS keychain, never in the profile.
- `src/weather.ts` — aviationweather.gov Data API client behind the `HttpJsonFetcher`
  interface (`NodeFetcher` = global fetch with a 10 s timeout), tolerant `looseObject`
  schemas, METAR to `ConditionSummary`, TAF summary, crosswind and flight-category helpers.
- `src/scoring.ts` — pure personal-minimums scoring: per-limit pass/fail/unknown/skipped
  with margins; missing data is `unknown` and forces `no-go`; crosswind is only `skipped`
  (non-blocking) when no runway heading was supplied.
- `src/planning.ts` — `planDay` composition (windows, availability, conditions at every
  home airport, routes), `resolveAircraftPerformance`, `dateSpan`/`dayRange`.
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
- Profile arrays (`homeAirports`, `aircraft`) are replaced wholesale by a patch; nested
  objects merge. Keep those semantics identical in `profile.ts` and the View patch builder.
- No secrets — calendar iCal URLs, scheduler credentials, tokens — in the repo,
  `profile.json`, logs, tool output, or error messages. Credentials belong in the OS
  keychain behind `getSchedulerCredentials()`.
- Keep provider/site-specific code inside its adapter module under `src/providers/`; the
  server and planner see only the interfaces in `providers/types.ts`.
- Tool errors are one-line, human-readable `isError: true` results (`errorResult`,
  `formatIssues`) — no stack dumps to the model.
- ESM + `moduleResolution: NodeNext`: import TS modules with a `.js` extension
  (`./scoring.js`). zod is v4 (`z.iso.datetime`, `z.looseObject`, `.meta()`).

## In-flight work (not on main)

An iCal calendar provider (branch `calendar-ical`) and a NeedleNine/Playwright availability
provider (branch `needlenine-availability`) are in progress on their own branches; do not
document or depend on them from `main` until merged.

## Working from Anthropic's Claude Code remote sandbox

Environment-specific — none of this applies on the developer's Mac.

- Public npmjs is blocked (403). Install through the sandbox's internal npm mirror (its
  registry URL is provided in the session environment) with `--no-package-lock`, and never
  commit a lockfile generated against it; if a lockfile is ever added, generate it against
  public npmjs from a machine that can reach it.
- aviationweather.gov and most external hosts are proxy-blocked, so live-API code is
  exercised only through fixtures; `get_conditions` returning `isError: true` ("fetch
  failed") and `plan_day` carrying a "Weather fetch failed" note is expected here.
- Playwright's chromium is preinstalled at `/opt/pw-browsers` (for the in-flight
  availability-provider work) — never run `playwright install`.
- This session can push branches but has no `gh`/GitHub API access to open PRs: push the
  branch and hand the developer a compare link
  (`https://github.com/justdueck/runup/compare/main...<branch>`).
