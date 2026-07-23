/**
 * Local mock of the NeedleNine portal for tests (never the live site).
 *
 * It mimics only what the automation depends on, using the same element ids,
 * storage key, request paths and data path the real SPA uses:
 *  - /login: form with #email / #password / #loginSubmit; on submit it POSTs
 *    /api/user/login, passes the response *text* through JSON.parse (the
 *    parse boundary the capture hook watches), stores the token under
 *    localStorage["apitoken"], and navigates to /{tenant}/DT/dashboard;
 *    a bad login shows the "Invalid email or password." toast text;
 *  - /{tenant}/DT/schedule: reads the token (redirects to /login without
 *    it), POSTs /api/user/info and /api/schedule/calendar/aircraft, then GETs
 *    /api/schedule?...&scheduledate=<today>...; the i.pi-caret-left/right
 *    controls step the day and refetch; every response body goes through
 *    JSON.parse; booking/check-in/cancel buttons exist and must never be
 *    triggered (recorded in `mutations`).
 * Payloads use the raw IA_ / FI_ field shapes so the in-page projection runs for real.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockPortalOptions {
  email: string;
  password: string;
  tenantId?: string;
  userId?: number;
  /** Raw roster rows (FI_* fields). */
  roster: unknown[];
  /** Raw appointment rows keyed by tenant-local date; missing dates return []. */
  schedules?: Record<string, unknown[]>;
  /** IANA timezone label displayed on the page (informational only). */
  timezone?: string;
}

export interface MockRequestLog {
  method: string;
  path: string;
}

export interface MockPortal {
  url: string;
  tenantId: string;
  userId: number;
  requests: MockRequestLog[];
  /** Requests to booking/check-in/cancel/delete endpoints — must stay empty. */
  mutations: MockRequestLog[];
  close(): Promise<void>;
}

export const MOCK_TOKEN = "mock-api-token-not-a-secret";
export const DEFAULT_TENANT_ID = "b2f6c1de-7c4a-4f6b-9a8e-1234567890ab";
export const DEFAULT_USER_ID = 90099;

const MUTATION_PATHS = /\/api\/schedule\/(creation|deleteappointment|checkin)|\/api\/schedule\/\d+$/i;

export async function startMockPortal(opts: MockPortalOptions): Promise<MockPortal> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const userId = opts.userId ?? DEFAULT_USER_ID;
  const requests: MockRequestLog[] = [];
  const mutations: MockRequestLog[] = [];
  const schedules = opts.schedules ?? {};

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ method, path: `${url.pathname}${url.search}` });

    const send = (status: number, body: string, contentType = "text/plain; charset=utf-8"): void => {
      res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
      res.end(body);
    };
    const readBody = (): Promise<string> =>
      new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => {
          data += String(chunk);
        });
        req.on("end", () => resolve(data));
      });
    const authorized = (): boolean => req.headers["apitoken"] === MOCK_TOKEN;

    const isMutation =
      MUTATION_PATHS.test(url.pathname) || (url.pathname === "/api/schedule" && method !== "GET");
    if (isMutation) {
      mutations.push({ method, path: url.pathname });
      send(500, "mock: mutation endpoints must never be called by the automation");
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (method === "GET" && url.pathname === "/login") {
      send(200, loginPage(tenantId), "text/html; charset=utf-8");
      return;
    }
    if (method === "POST" && url.pathname === "/api/user/login") {
      void readBody().then((raw) => {
        let creds: { email?: string; password?: string } = {};
        try {
          creds = JSON.parse(raw) as { email?: string; password?: string };
        } catch {
          creds = {};
        }
        if (creds.email === opts.email && creds.password === opts.password) {
          send(200, JSON.stringify({ type: 1, api_token: MOCK_TOKEN, TENANT_UUID: tenantId, USER_TYPE: 1 }));
        } else {
          send(200, JSON.stringify({ type: 0, message: "Invalid email or password." }));
        }
      });
      return;
    }
    if (method === "GET" && new RegExp(`^/${escapeRegex(tenantId)}/DT/(dashboard|schedule)$`).test(url.pathname)) {
      send(200, schedulePage(userId, opts.timezone ?? "America/Los_Angeles"), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/user/info" && method === "POST") {
      if (!authorized()) return send(401, "Unauthorized token.");
      void readBody().then(() =>
        send(
          200,
          JSON.stringify({
            USER_ID: userId,
            USER_UUID: "mock-user-uuid-90099",
            USER_EMAIL: opts.email,
            USER_TYPE: 1,
            USER_LOCATION_ID: "loc-uuid-1",
            userinfo: { UI_FIRST_NAME: "Test", UI_LAST_NAME: "Pilot" },
          }),
        ),
      );
      return;
    }
    if (url.pathname === "/api/schedule/calendar/aircraft" && method === "POST") {
      if (!authorized()) return send(401, "Unauthorized token.");
      void readBody().then(() => send(200, JSON.stringify(opts.roster)));
      return;
    }
    if (url.pathname === "/api/schedule" && method === "GET") {
      if (!authorized()) return send(401, "Unauthorized token.");
      const date = url.searchParams.get("scheduledate") ?? "";
      const records = schedules[date] ?? [];
      send(200, JSON.stringify(records));
      return;
    }
    send(404, "mock: not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    tenantId,
    userId,
    requests,
    mutations,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- pages (self-contained; no external assets) --------------------------------------

const BASE_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .pi { display: inline-block; width: 18px; height: 18px; background: #cbd5e1; border-radius: 3px; cursor: pointer; vertical-align: middle; }
  .toolbar button { margin-right: 6px; }
  .row { border-bottom: 1px solid #eee; padding: 4px 0; }
  .scheduler_default_event { display: inline-block; background: #dbeafe; margin-left: 8px; padding: 2px 6px; }
`;

function loginPage(tenantId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Welcome to NeedleNine (mock)</title><style>${BASE_STYLE}</style></head>
<body>
<app-login>
  <h1>Welcome to NeedleNine</h1>
  <form name="form" id="loginForm" autocomplete="off">
    <p><input type="email" id="email" name="email" formcontrolname="email" class="nn-login-input p-inputtext w-full" required>
       <label for="email">Email</label></p>
    <p><input type="password" id="password" name="password" formcontrolname="password" class="nn-login-input p-inputtext w-full" required>
       <label for="passwod">Password</label></p>
    <p><label><input type="checkbox" id="rememberme" name="rememberme" value="rememberme"> Remember Me</label></p>
    <button type="submit" id="loginSubmit" class="p-button w-full">LOG IN</button>
  </form>
  <div class="p-toast p-toast-top-right"><div class="p-toast-message"><span class="p-toast-detail" id="errorDetail" hidden></span></div></div>
</app-login>
<script>
  var TENANT = ${JSON.stringify(tenantId)};
  document.getElementById('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = document.getElementById('email').value;
    var password = document.getElementById('password').value;
    fetch('/api/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, isRemember: 0 })
    }).then(function (res) { return res.text(); }).then(function (text) {
      var data = JSON.parse(text); // the real SPA decrypts, then JSON.parse's — same boundary
      if (data.type === 1) {
        localStorage.setItem('apitoken', data.api_token);
        localStorage.setItem('currentLocation', 'loc-uuid-1');
        location.href = '/' + (data.TENANT_UUID || TENANT) + '/DT/dashboard';
      } else {
        var el = document.getElementById('errorDetail');
        el.textContent = data.message || 'Invalid email or password.';
        el.hidden = false;
      }
    });
  });
</script>
</body></html>`;
}

function schedulePage(userId: number, timezone: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>NeedleNine schedule (mock)</title><style>${BASE_STYLE}</style></head>
<body>
<app-schedule><app-reservation>
  <!-- Decoy caret icons OUTSIDE the date toolbar (a menu expander): clicking one would
       hit a mutation endpoint, proving the automation only uses the toolbar-scoped carets. -->
  <div class="p-panelmenu" style="margin-bottom: 8px">
    <i class="pi pi-caret-right" id="decoyExpander" title="Expand menu"></i>
    <i class="pi pi-caret-left" id="decoyCollapse" title="Collapse menu"></i>
    <span>side menu</span>
  </div>
  <div class="date-selection">
    <i class="pi pi-caret-left" id="prevDay" title="Previous day"></i>
    <span id="dateLabel"></span>
    <i class="pi pi-caret-right" id="nextDay" title="Next day"></i>
    <span class="p-calendar"><input id="icon" type="text" readonly></span>
    <small id="tz">${timezone}</small>
  </div>
  <div class="toolbar">
    <button id="findTime">Find a Time</button>
    <button id="bookNow">Book aircraft</button>
    <button id="checkIn">Check In</button>
    <button id="cancelBooking">Cancel Reservation</button>
  </div>
  <div class="event-scheduler"><div id="rows"></div><div id="events"></div></div>
</app-reservation></app-schedule>
<script>
  var USER_ID = ${JSON.stringify(userId)};
  var token = localStorage.getItem('apitoken');
  if (!token) { location.replace('/login'); }
  var headers = { 'apitoken': token || '', 'location-uuid': localStorage.getItem('currentLocation') || '', 'content-type': 'application/json' };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(dateStr, days) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days, 12, 0, 0);
    return ymd(d);
  }
  var current = ymd(new Date()); // tenant-local "today" (browser context timezone is the tenant zone)
  function api(path, init) {
    return fetch(path, Object.assign({ headers: headers }, init || {})).then(function (res) {
      if (res.status === 401) { location.replace('/login'); throw new Error('unauthorized'); }
      return res.text();
    }).then(function (text) {
      return JSON.parse(text); // decrypt -> JSON.parse boundary in the real SPA
    });
  }
  function loadDay(dateStr) {
    document.getElementById('dateLabel').textContent = dateStr;
    document.getElementById('icon').value = dateStr;
    var q = '/api/schedule?userid=mock-user-uuid&usertype=1&aircrafts=all&instructors=all&aircraftsgrp=all'
      + '&scheduleof=date&scheduledate=' + encodeURIComponent(dateStr) + '&schedulemonth=&kiosk=0';
    return api(q).then(function (records) {
      var container = document.getElementById('events');
      container.textContent = '';
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var div = document.createElement('div');
        div.className = 'scheduler_default_event';
        div.setAttribute('data-schedule-id', String(r.IA_ID));
        var tail = (r.aircraft && r.aircraft.FI_TAIL_NUMBER) ? r.aircraft.FI_TAIL_NUMBER : 'aircraft ' + r.IA_AIRCRAFT_ID;
        div.textContent = tail + ' ' + r.IA_START_TIME + '-' + r.IA_END_TIME;
        container.appendChild(div);
      }
    });
  }
  function boot() {
    api('/api/user/info', { method: 'POST', body: JSON.stringify({ userId: USER_ID }) })
      .then(function () { return api('/api/schedule/calendar/aircraft', { method: 'POST', body: '{}' }); })
      .then(function (roster) {
        var container = document.getElementById('rows');
        container.textContent = '';
        for (var i = 0; i < roster.length; i++) {
          var row = document.createElement('div');
          row.className = 'row scheduler_default_rowheader';
          row.textContent = String(roster[i].FI_TAIL_NUMBER);
          container.appendChild(row);
        }
        return loadDay(current);
      });
  }
  document.getElementById('prevDay').addEventListener('click', function () { current = addDays(current, -1); loadDay(current); });
  document.getElementById('nextDay').addEventListener('click', function () { current = addDays(current, 1); loadDay(current); });
  // Controls the automation must NEVER touch (they hit mutation endpoints):
  document.getElementById('decoyExpander').addEventListener('click', function () { fetch('/api/schedule/checkin', { method: 'POST', headers: headers, body: '{"decoy":true}' }); });
  document.getElementById('decoyCollapse').addEventListener('click', function () { fetch('/api/schedule/deleteappointment', { method: 'POST', headers: headers, body: '{"decoy":true}' }); });
  document.getElementById('bookNow').addEventListener('click', function () { fetch('/api/schedule/creation/aircraft', { method: 'POST', headers: headers, body: '{}' }); });
  document.getElementById('checkIn').addEventListener('click', function () { fetch('/api/schedule/checkin', { method: 'POST', headers: headers, body: '{}' }); });
  document.getElementById('cancelBooking').addEventListener('click', function () { fetch('/api/schedule/deleteappointment', { method: 'POST', headers: headers, body: '{}' }); });
  if (token) boot();
</script>
</body></html>`;
}
