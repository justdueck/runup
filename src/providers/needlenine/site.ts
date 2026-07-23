/**
 * NeedleNine portal SITE ADAPTER — every portal-specific fact lives here.
 *
 * If the real portal drifts from what the reconnaissance found (routes,
 * form ids, the schedule date control, storage key names, payload field
 * names), this is the one file to edit; the session driver
 * (portal-session.ts) and the availability math (availability.ts) are
 * site-agnostic.
 *
 * How data is read (v1): the portal is an Angular SPA whose API responses
 * are encrypted in transit and decrypted client-side, but the decrypted text
 * always becomes objects through `window.JSON.parse` on the main thread.
 * We install an init script (before any app script runs) that wraps
 * JSON.parse, shape-checks every parsed value, and stashes a *projected*
 * copy (only the fields the availability math needs — never other
 * members' names/emails, never the API token) into a small in-page queue
 * that the session drains via page.evaluate. We ship none of the vendor's
 * crypto, constants, or code.
 *
 * Documented fallback (NOT implemented in v1): if the JSON.parse boundary
 * ever stops working (e.g. decryption moves into a worker), DayPilot renders
 * every reservation as `div.scheduler_default_event` whose element carries
 * an `.event.data` object ({resource, start, end, tags:{type, scheduleId}})
 * readable via page.evaluate — a second in-page tap that needs no
 * decryption. See the recon notes referenced in the README.
 *
 * Functions in the "in-page" section below are serialized with
 * Function.prototype.toString() into the browser page, so each must be a
 * self-contained top-level function declaration: no imports, no closures
 * over module scope, no nested function expressions, and only ES2019
 * syntax. (Running the test suite under coverage instrumentation would
 * rewrite these bodies; do not enable coverage for the needlenine e2e.)
 */

// --- Portal / routes ------------------------------------------------------------

/** Public portal origin (SPA and JSON API live on the same origin). */
export const DEFAULT_PORTAL_URL = "https://portal.needlenine.com";

/** SPA route of the login page; landing here also clears the app's stored session. */
export const LOGIN_PATH = "/login";

/** localStorage key the SPA writes its API token to after a successful login (name only). */
export const TOKEN_STORAGE_KEY = "apitoken";

/** Device code segment of app routes: DT = desktop scheduler, TB = tablet, MB = mobile. */
export const DEVICE_CODE = "DT";

export function loginUrl(portalUrl: string): string {
  return new URL(LOGIN_PATH, portalUrl).toString();
}

/** The desktop reservation calendar: /{tenantUuid}/DT/schedule. */
export function scheduleUrl(portalUrl: string, tenantId: string): string {
  return new URL(`/${encodeURIComponent(tenantId)}/${DEVICE_CODE}/schedule`, portalUrl).toString();
}

export function isLoginUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").toLowerCase() === LOGIN_PATH;
  } catch {
    return false;
  }
}

/**
 * After login the SPA routes to /{tenantUuid}/{deviceCode}/dashboard (or
 * .../schedule on mobile layouts). Pull the tenant id out of any in-app URL.
 * Returns null for role-specific landings that carry no tenant segment
 * (/course, /tenant) — the caller should then require an explicit tenantId.
 */
export function tenantIdFromPortalUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /^\/([^/]+)\/(DT|TB|MB)(\/|$)/i.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// --- Login form -----------------------------------------------------------------

/** Resilient selectors for the login form (formControlName / id / type fallbacks). */
export const LOGIN_FORM = {
  email: '#email, input[formcontrolname="email"], input[type="email"], input[name="email"]',
  password: '#password, input[formcontrolname="password"], input[type="password"]',
  submit: '#loginSubmit, button[type="submit"], input[type="submit"]',
} as const;

/** The failed-login message the portal shows in a toast (case-insensitive match). */
export const LOGIN_ERROR_TEXT = /invalid email or password/i;

// --- Schedule page ----------------------------------------------------------------

/**
 * Day navigation on the reservation calendar: the date toolbar
 * (div.date-selection) has caret icons that step one day back/forward, each
 * triggering a fresh schedule fetch for the new tenant-local day. (There is
 * also a p-calendar picker; stepping day-by-day and reading the app's own
 * request URLs is the more robust automation path, so v1 only uses the
 * carets.) Each entry lists selectors in preference order: the toolbar-scoped
 * one first so a caret icon elsewhere on the page can never be clicked, the
 * bare icon class as a fallback.
 */
export const SCHEDULE_CONTROLS = {
  previousDay: [".date-selection i.pi-caret-left", "i.pi-caret-left"],
  nextDay: [".date-selection i.pi-caret-right", "i.pi-caret-right"],
} as const;

/**
 * The day-schedule API call is `GET /api/schedule?...&scheduledate=YYYY-MM-DD&...`.
 * Returns that date when `url` is such a request, else null. (Other
 * endpoints share the /api/schedule/ prefix — reservation, calendar/aircraft,
 * getfiltersearchdata — hence the exact pathname test.)
 */
export function scheduleDateOfRequestUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.pathname.replace(/\/+$/, "") !== "/api/schedule") return null;
  const date = u.searchParams.get("scheduledate");
  return date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * Below this many response bytes we treat a schedule payload that produced
 * no captured object as an empty day (an encrypted "[]" is tiny; a real day
 * for a busy school is hundreds of kilobytes). Above it, a missing capture
 * means the parse boundary changed and we fail loudly instead of guessing.
 */
export const EMPTY_SCHEDULE_BODY_MAX_BYTES = 1024;

// --- Code tables --------------------------------------------------------------

/** IA_FLIGHT_TYPE values (client enum) and their neutral labels. */
export const FLIGHT_TYPE = {
  DISCOVERY: 1,
  LEISURE: 2,
  MAINTENANCE: 3,
  PROFICIENCY: 4,
  TRAINING: 5,
  TIME_OFF: 6,
  CHECKRIDE: 7,
  ADMIN: 8,
  STAGE_CHECK: 9,
} as const;

export const FLIGHT_TYPE_LABELS: Readonly<Record<number, string>> = {
  1: "discovery flight",
  2: "leisure booking",
  3: "maintenance block",
  4: "proficiency flight",
  5: "training booking",
  6: "time off",
  7: "checkride",
  8: "admin block",
  9: "stage check",
};

/** IA_APPOINTMENT_STATUS: 1 normal, 5 maintenance block, 2 cancelled/deleted (does not block). */
export const APPOINTMENT_STATUS = { NORMAL: 1, CANCELLED: 2, MAINTENANCE: 5 } as const;

/** checkout.CA_STATUS: 1 or 3 = aircraft currently dispatched (checked out), 2 = checked back in. */
export const CHECKOUT_DISPATCHED_STATUSES: ReadonlySet<number> = new Set([1, 3]);

/** FI_STATUS: 1 = active aircraft on the roster. */
export const AIRCRAFT_ACTIVE_STATUS = 1;

// --- Payload types (our normalized projection of the portal shapes) -------------

/** One appointment row from the day schedule (IA_* record), projected. */
export interface PortalScheduleRecord {
  /** IA_ID */
  id: number | null;
  /** IA_AIRCRAFT_ID (0/null = no aircraft); joins the roster's FI_ID. */
  aircraftId: number | null;
  /** IA_INSTRUCTOR_ID (0 = none). */
  instructorId: number | null;
  /** IA_USER_ID — the booking member's internal id (used only to spot the logged-in user's own bookings). */
  userId: number | null;
  /** IA_START_TIME, naive UTC "YYYY-MM-DD HH:mm:ss" (aircraft interval start). */
  start: string | null;
  /** IA_END_TIME, naive UTC. */
  end: string | null;
  /** IA_FLIGHT_TYPE (1..9). */
  flightType: number | null;
  /** IA_APPOINTMENT_STATUS (1 normal, 5 maintenance, 2 cancelled). */
  appointmentStatus: number | null;
  /** IA_APPOINTMENT_CHECK_IN_STATUS (0 not dispatched, 1 out, 2 back in). */
  checkInStatus: number | null;
  /** IA_POTENTIAL_STATUS (tentative flag). */
  potentialStatus: number | null;
  /** True when IA_DELETE_APPOINTMENT_REASON is populated (cancelled/deleted row). */
  deleted: boolean;
  /** aircraft.FI_TAIL_NUMBER display string when embedded, else null. */
  tailDisplay: string | null;
  /** aircraft.FI_SIMULATOR === 1. */
  simulator: boolean;
  /** checkout.CA_STATUS when a dispatch record is attached. */
  checkoutStatus: number | null;
}

export interface PortalRosterMaintenance {
  /** MAI_NAME, e.g. "100 Hour" / "Annual". */
  name: string | null;
  /** MAI_EXPIRATION_DATE, tenant-local "YYYY-MM-DD" or null. */
  expirationDate: string | null;
  /** MAI_HOURS_REMAINING (negative = overdue by that many hours). */
  hoursRemaining: number | null;
  /** MAI_REQ_FOR_DISPATCH === 1 (blocks dispatch when expired). */
  requiredForDispatch: boolean;
}

export interface PortalRosterDiscrepancy {
  /** DIS_TYPE. */
  type: string | null;
  /** DIS_RESTRICTIONS (operational restriction text about the aircraft). */
  restrictions: string | null;
  /** DIS_STATUS. */
  status: number | null;
}

/** One aircraft row from the scheduler roster (FI_* record), projected. */
export interface PortalRosterRecord {
  /** FI_ID — the aircraft id used by schedule records. */
  id: number | null;
  /** FI_TAIL_NUMBER display string, e.g. "N556ND (RFS720)" or "Frasca - 15551" for simulators. */
  tailDisplay: string | null;
  /** FI_GROP — aircraft group id. */
  groupId: number | null;
  /** flightgroup.AG_NAME — model/type label. */
  groupName: string | null;
  /** FI_MODEL_CODE. */
  modelCode: string | null;
  /** FI_STATUS (1 = active). */
  status: number | null;
  /** FI_LOCATION_ID — home location id. */
  locationId: string | null;
  /** AS_SEQUENCE_NUMBER — scheduler row order. */
  sequence: number | null;
  maintenance: PortalRosterMaintenance[];
  discrepancies: PortalRosterDiscrepancy[];
  /** A location change / relocation is pending. */
  relocating: boolean;
}

/** The logged-in member's own id (from the user-info response) — used to mark "your" bookings. */
export interface PortalIdentity {
  userId: number | null;
}

export type PortalPayloadKind = "schedule" | "roster" | "identity";

/** One entry in the in-page capture queue. */
export interface CapturedEntry<T = unknown> {
  kind: PortalPayloadKind;
  seq: number;
  /** Date.now() in the page when the payload was parsed. */
  at: number;
  payload: T;
}

// --- In-page functions (serialized into the browser; keep self-contained) -------

/** window property holding the capture queue (array of CapturedEntry). */
export const CAPTURE_QUEUE_KEY = "__runupCaptured";
/** Cap on retained entries so a long session never grows page memory. */
export const CAPTURE_QUEUE_MAX = 40;

/** Plain (JSON) object check used in-page. */
export function isPlainRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Number-ish -> number, else null (portal ids sometimes arrive as strings). */
export function numOrNull(value: unknown): number | null {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** Non-empty string -> string, numbers -> their decimal string, else null. */
export function strOrNull(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && isFinite(value)) return String(value);
  return null;
}

/**
 * Which of the portal payloads (if any) a JSON.parse result is.
 * Shape-based, cheap, and defensive: the same JSON.parse also handles
 * cached values, third-party proxies (weather/sun), error bodies and
 * library internals. Empty arrays are unclassifiable by shape — the
 * session infers empty schedule days from the (tiny) response size instead.
 */
export function classifyPortalPayload(value: unknown): PortalPayloadKind | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0];
    if (!isPlainRecord(first)) return null;
    const record = first as Record<string, unknown>;
    if ("IA_ID" in record && "IA_START_TIME" in record) return "schedule";
    if ("FI_ID" in record && "FI_TAIL_NUMBER" in record) return "roster";
    return null;
  }
  if (isPlainRecord(value)) {
    const record = value as Record<string, unknown>;
    // The login response (which also carries USER_TYPE) exposes the API token; never capture it.
    if ("api_token" in record) return null;
    if ("USER_ID" in record && "USER_UUID" in record) return "identity";
  }
  return null;
}

/** Project raw appointment rows to the fields the availability math uses (no PII kept). */
export function projectScheduleRecords(records: unknown): PortalScheduleRecord[] {
  const out: PortalScheduleRecord[] = [];
  if (!Array.isArray(records)) return out;
  for (const raw of records) {
    if (!isPlainRecord(raw)) continue;
    const r = raw as Record<string, unknown>;
    const aircraft = isPlainRecord(r.aircraft) ? (r.aircraft as Record<string, unknown>) : null;
    const checkout = isPlainRecord(r.checkout) ? (r.checkout as Record<string, unknown>) : null;
    out.push({
      id: numOrNull(r.IA_ID),
      aircraftId: numOrNull(r.IA_AIRCRAFT_ID),
      instructorId: numOrNull(r.IA_INSTRUCTOR_ID),
      userId: numOrNull(r.IA_USER_ID),
      start: strOrNull(r.IA_START_TIME),
      end: strOrNull(r.IA_END_TIME),
      flightType: numOrNull(r.IA_FLIGHT_TYPE),
      appointmentStatus: numOrNull(r.IA_APPOINTMENT_STATUS),
      checkInStatus: numOrNull(r.IA_APPOINTMENT_CHECK_IN_STATUS),
      potentialStatus: numOrNull(r.IA_POTENTIAL_STATUS),
      deleted: strOrNull(r.IA_DELETE_APPOINTMENT_REASON) !== null,
      tailDisplay: aircraft ? strOrNull(aircraft.FI_TAIL_NUMBER) : null,
      simulator: aircraft ? numOrNull(aircraft.FI_SIMULATOR) === 1 : false,
      checkoutStatus: checkout ? numOrNull(checkout.CA_STATUS) : null,
    });
  }
  return out;
}

/** Project raw roster rows to the fields the tail-matching / airworthiness flags use. */
export function projectRosterRecords(records: unknown): PortalRosterRecord[] {
  const out: PortalRosterRecord[] = [];
  if (!Array.isArray(records)) return out;
  for (const raw of records) {
    if (!isPlainRecord(raw)) continue;
    const r = raw as Record<string, unknown>;
    const maintenance: PortalRosterMaintenance[] = [];
    if (Array.isArray(r.maintenance)) {
      for (const item of r.maintenance) {
        if (!isPlainRecord(item)) continue;
        const m = item as Record<string, unknown>;
        maintenance.push({
          name: strOrNull(m.MAI_NAME),
          expirationDate: strOrNull(m.MAI_EXPIRATION_DATE),
          hoursRemaining: numOrNull(m.MAI_HOURS_REMAINING),
          requiredForDispatch: numOrNull(m.MAI_REQ_FOR_DISPATCH) === 1,
        });
      }
    }
    const discrepancies: PortalRosterDiscrepancy[] = [];
    if (Array.isArray(r.opendiscrepancies)) {
      for (const item of r.opendiscrepancies) {
        if (!isPlainRecord(item)) continue;
        const d = item as Record<string, unknown>;
        discrepancies.push({
          type: strOrNull(d.DIS_TYPE),
          restrictions: strOrNull(d.DIS_RESTRICTIONS),
          status: numOrNull(d.DIS_STATUS),
        });
      }
    }
    const group = isPlainRecord(r.flightgroup) ? (r.flightgroup as Record<string, unknown>) : null;
    out.push({
      id: numOrNull(r.FI_ID),
      tailDisplay: strOrNull(r.FI_TAIL_NUMBER),
      groupId: numOrNull(r.FI_GROP),
      groupName: group ? strOrNull(group.AG_NAME) : null,
      modelCode: strOrNull(r.FI_MODEL_CODE),
      status: numOrNull(r.FI_STATUS),
      locationId: strOrNull(r.FI_LOCATION_ID),
      sequence: numOrNull(r.AS_SEQUENCE_NUMBER),
      maintenance,
      discrepancies,
      relocating: isPlainRecord(r.changelocation) || isPlainRecord(r.relocatelocation),
    });
  }
  return out;
}

/** Project the user-info object to the single id we need (no email, name, uuid, or token kept). */
export function projectIdentity(value: unknown): PortalIdentity {
  if (!isPlainRecord(value)) return { userId: null };
  const r = value as Record<string, unknown>;
  return { userId: numOrNull(r.USER_ID) };
}

/**
 * In-page: inspect one JSON.parse result and, if it is a portal payload,
 * push a projected entry onto the capture queue. Configuration is read from
 * globalThis (installed by installJsonParseCapture) so this function stays
 * a top-level, closure-free declaration.
 */
export function runupInspectParsed(value: unknown): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const cfg = g.__runupCaptureConfig;
  if (!cfg) return;
  const kind = classifyPortalPayload(value);
  if (kind === null) return;
  let payload: unknown;
  if (kind === "schedule") payload = projectScheduleRecords(value);
  else if (kind === "roster") payload = projectRosterRecords(value);
  else payload = projectIdentity(value);
  const queue = Array.isArray(g[cfg.queueKey]) ? g[cfg.queueKey] : (g[cfg.queueKey] = []);
  cfg.seq += 1;
  queue.push({ kind, seq: cfg.seq, at: Date.now(), payload });
  while (queue.length > cfg.maxEntries) queue.shift();
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** In-page: Proxy `apply` trap for JSON.parse — call through, then inspect the result (never disturbing the app). */
export function runupJsonParseApply(target: unknown, thisArg: unknown, args: unknown[]): unknown {
  const value = Reflect.apply(target as (text: string, reviver?: unknown) => unknown, thisArg, args as [string]);
  try {
    runupInspectParsed(value);
  } catch {
    /* capture must never break the app */
  }
  return value;
}

/**
 * In-page: wrap window.JSON.parse exactly once. A Proxy keeps the wrapper
 * transparent (name/length/toString) to anything probing the built-in.
 */
export function installJsonParseCapture(config: { queueKey: string; maxEntries: number }): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  if (g.__runupCaptureConfig) return;
  g.__runupCaptureConfig = { queueKey: config.queueKey, maxEntries: config.maxEntries, seq: 0 };
  g.JSON.parse = new Proxy(g.JSON.parse, { apply: runupJsonParseApply });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** In-page: return and clear the queued captures. */
export function drainCaptureQueue(queueKey: string): unknown[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const queue = Array.isArray(g[queueKey]) ? g[queueKey] : [];
  g[queueKey] = [];
  return queue;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * In-page: set an input's value the way Angular reactive forms and
 * PrimeNG observe it (focus + input/change/blur events). Used for the
 * password so the secret is set through one DOM call instead of flowing
 * through Playwright's keyboard/typing APIs.
 */
export function setInputValueInPage(element: unknown, value: string): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const input = element as any;
  input.focus();
  input.value = value;
  input.dispatchEvent(new g.Event("input", { bubbles: true }));
  input.dispatchEvent(new g.Event("change", { bubbles: true }));
  input.dispatchEvent(new g.Event("blur", { bubbles: true }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Source text of the capture hook for `context.addInitScript(...)`. Built
 * from the real function objects above so the in-page logic is exactly the
 * unit-tested logic.
 */
export function buildCaptureInitScript(): string {
  const helpers: Array<(...args: never[]) => unknown> = [
    isPlainRecord,
    numOrNull,
    strOrNull,
    classifyPortalPayload,
    projectScheduleRecords,
    projectRosterRecords,
    projectIdentity,
    runupInspectParsed,
    runupJsonParseApply,
    installJsonParseCapture,
  ];
  const config = JSON.stringify({ queueKey: CAPTURE_QUEUE_KEY, maxEntries: CAPTURE_QUEUE_MAX });
  return `(() => {\n${helpers.map((fn) => fn.toString()).join("\n\n")}\n\ninstallJsonParseCapture(${config});\n})();`;
}
