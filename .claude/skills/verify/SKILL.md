---
name: verify
description: Build the runup MCP server and drive it over stdio (initialize, tools, resources, profile persistence) to verify a change end-to-end.
---

# Verifying runup

runup's only surface is a stdio MCP server (`dist/index.js`). To verify a
change, build it and speak JSON-RPC to it — do not stop at unit tests.

## Build

```bash
npm install
npm run build      # tsc + esbuild-inlines the profile form into dist/ui/profile-form.html
```

## Launch (isolated)

Always point the profile store at a scratch dir so verification never
touches a real `~/.runup`:

```bash
RUNUP_HOME=$(mktemp -d) node dist/index.js
```

stdout is the protocol channel; the startup line
(`runup vX.Y.Z ready on stdio (profile: ...)`) goes to stderr.

## Drive

Speak newline-delimited JSON-RPC on stdin. Minimal sequence:

1. `initialize` (`protocolVersion: "2025-06-18"`) → expect `serverInfo.name === "runup"`.
2. `notifications/initialized` (no id).
3. `tools/list` → 8 tools: `get_profile`, `update_profile`, `get_free_windows`,
   `get_conditions`, `get_aircraft_availability`, `get_scheduler_status`,
   `plan_routes`, `plan_day` (the two profile tools carry
   `_meta.ui.resourceUri = ui://runup/profile-form.html`).
4. `tools/call get_profile` → default `homeAirports: ["KPAE", "KTIW"]`.
5. `tools/call update_profile` with a patch, then check
   `$RUNUP_HOME/profile.json` on disk and call `get_profile` again → the
   patch persisted (nested objects merge, arrays replace).
6. `resources/read ui://runup/profile-form.html` → single self-contained HTML
   (`text/html;profile=mcp-app`); if it says "form not built", `npm run build`
   didn't inline the View.
7. `get_free_windows` / `plan_routes` / `plan_day` run on fixtures + the
   bundled airport sample. `get_scheduler_status` → `configured: false` with
   setup notes (no secret values), and `get_aircraft_availability` returns
   fixture data whose `notes` include the "No flight-school scheduler is
   configured" pointer (the NeedleNine portal is only driven when the profile
   has a `scheduler` block — do not add one when verifying against a scratch
   profile unless you also mock the portal).

Probe off-happy-path inputs too: an invalid `update_profile` patch (e.g.
negative `ceilingFt`) and a malformed date to `get_free_windows` must come
back as tool errors (`isError: true`), and a garbage line on stdin must not
kill the server.

## Gotchas

- `get_conditions` (and the conditions part of `plan_day`) fetch
  aviationweather.gov live. Offline / behind an egress proxy that blocks it,
  `get_conditions` returns `isError: true` ("fetch failed") and `plan_day`
  still succeeds with a "Weather fetch failed" note per home airport — that is
  the expected degraded behavior, not a regression.
- Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set
  (Node >= 22.21).
- Fixture calendar windows are generated relative to server start time, so
  window timestamps differ between runs.
- The NeedleNine provider imports `playwright` lazily: the server must start
  and answer `tools/list` even when the browser is not installed; the
  browser is only launched by a configured availability query. The mock-portal
  Playwright e2e (`tests/needlenine/portal.e2e.test.ts`) needs a chromium
  binary (`npx playwright install chromium`, or `PLAYWRIGHT_BROWSERS_PATH` /
  `RUNUP_CHROMIUM_PATH` pointing at one) and prints a `SKIPPED` warning if
  none can launch.
