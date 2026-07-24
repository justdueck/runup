/**
 * PortalSession: one headless-chromium session per server process that logs
 * into the NeedleNine portal once and reads the schedule/roster data the
 * page itself has already decrypted (at its JSON.parse boundary — see
 * site.ts). Site-specific details (routes, selectors, request patterns,
 * capture shapes) all come from site.ts; this file is browser mechanics.
 *
 * Privacy/safety rules enforced here:
 * - playwright is imported lazily, so the server starts without it or a
 *   browser installed;
 * - no tracing/screenshots/video/storage-state on disk; the password is set
 *   through a single in-page DOM call, never typed key-by-key, and never
 *   included in errors (which are our own short strings);
 * - Playwright debug env switches that could echo values (pw:* / '*') are
 *   stripped before import;
 * - read-only automation: the only interactions are the login form, page
 *   navigation, and the schedule's previous/next-day carets;
 * - dispose() closes the browser (also wired to server shutdown).
 */
import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { NeedleNineCredentials } from "./credentials.js";
import {
  buildCaptureInitScript,
  CAPTURE_QUEUE_KEY,
  drainCaptureQueue,
  EMPTY_SCHEDULE_BODY_MAX_BYTES,
  isLoginUrl,
  LOGIN_ERROR_TEXT,
  LOGIN_FORM,
  loginUrl,
  scheduleDateOfRequestUrl,
  SCHEDULE_CONTROLS,
  scheduleUrl,
  setInputValueInPage,
  tenantIdFromPortalUrl,
  type CapturedEntry,
  type PortalIdentity,
  type PortalRosterRecord,
  type PortalScheduleRecord,
} from "./site.js";
import { diffCalendarDays, localDateOf, parseNaiveUtc } from "./time.js";

/** Runtime module type only — the real import happens lazily in loadPlaywright(). */
type PlaywrightModule = typeof import("playwright");

export type PortalErrorCode = "browser-missing" | "browser-launch" | "login-failed" | "timeout" | "site-changed";

/** Concise, secret-free automation failure carrying a remediation hint. */
export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PortalError";
  }
}

export interface PortalSessionOptions {
  portalUrl: string;
  /** IANA timezone the browser context (and the schedule UI) run in. */
  timezone: string;
  /** Skip tenant auto-detection with an explicit /{tenantId}/DT/... segment. */
  tenantId?: string;
  headless?: boolean;
  /** Chromium binary override (env RUNUP_CHROMIUM_PATH). */
  executablePath?: string;
  /** Enable the Chromium renderer sandbox (default: on for macOS/Windows, off for Linux containers). */
  chromiumSandbox?: boolean;
  navigationTimeoutMs?: number;
  loginTimeoutMs?: number;
  /** How long to wait for the app to issue a schedule request after we act. */
  responseTimeoutMs?: number;
  /** How long to wait for the page to JSON.parse a response we saw arrive. */
  captureGraceMs?: number;
  /** Safety valve on previous/next-day clicks per fetch. */
  maxDaySteps?: number;
  /** How long a fetched day / the roster stay cached in memory. */
  dayCacheTtlMs?: number;
  rosterTtlMs?: number;
  /** Diagnostic lines (stderr). Never receives secrets or captured member data. */
  logger?: (line: string) => void;
}

/** What the availability provider needs from a live (or fake) portal session. */
export interface SchedulerSession {
  /** The projected appointment rows for one tenant-local day (cached briefly). */
  fetchScheduleDay(date: string): Promise<PortalScheduleRecord[]>;
  /** The aircraft roster (cached for the session, refreshed after the TTL). */
  roster(): Promise<PortalRosterRecord[]>;
  /** The logged-in member's own id, if the portal exposed it. */
  identity(): PortalIdentity | null;
  isAlive(): boolean;
  dispose(): Promise<void>;
}

interface ScheduleResponseSeen {
  date: string;
  at: number;
  /** Encrypted body size (only used to tell an empty day from a capture failure). */
  bodyLength: Promise<number>;
}

const DEFAULTS = {
  navigationTimeoutMs: 30_000,
  loginTimeoutMs: 25_000,
  responseTimeoutMs: 20_000,
  captureGraceMs: 4_000,
  maxDaySteps: 45,
  dayCacheTtlMs: 5 * 60_000,
  rosterTtlMs: 30 * 60_000,
} as const;

/** Poll interval while waiting for the page to hand over parsed payloads. */
const CAPTURE_POLL_MS = 120;
/** Once a response is known to be tiny, this long without a capture means an empty day. */
const EMPTY_DAY_PARSE_GRACE_MS = 700;
/** Small pause after a day step so we never hammer the calendar controls. */
const STEP_SETTLE_MS = 200;

let playwrightPromise: Promise<PlaywrightModule> | null = null;

/**
 * Lazily import playwright. Debug switches that would make Playwright log
 * API-call arguments or raw protocol messages are removed first so nothing
 * can echo the values we set in the page.
 */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightPromise) {
    sanitizeDebugEnv(process.env);
    playwrightPromise = import("playwright").catch((err: unknown) => {
      playwrightPromise = null;
      throw new PortalError(
        "browser-missing",
        `The playwright package is not available (${briefError(err)}).`,
        "Run `npm install` in the runup folder, then `npx playwright install chromium`.",
      );
    });
  }
  return playwrightPromise;
}

/**
 * Whether to run Chromium with its renderer sandbox: on for macOS/Windows
 * hosts, off for Linux (containers/root often can't use it), overridable
 * with RUNUP_CHROMIUM_SANDBOX=1/0.
 */
export function defaultChromiumSandbox(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const override = env.RUNUP_CHROMIUM_SANDBOX;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return platform === "darwin" || platform === "win32";
}

/** Remove Playwright debug tokens (pw:*, playwright*, "*") from DEBUG and unset PWDEBUG. */
export function sanitizeDebugEnv(env: NodeJS.ProcessEnv): void {
  const debug = env.DEBUG;
  if (typeof debug === "string" && debug.length > 0) {
    const kept = debug
      .split(/[\s,]+/)
      .filter((token) => token.length > 0)
      .filter((token) => !/^-?(\*|pw($|:)|playwright)/i.test(token));
    if (kept.length === 0) delete env.DEBUG;
    else env.DEBUG = kept.join(",");
  }
  delete env.PWDEBUG;
}

export class PortalSession implements SchedulerSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private disposed = false;
  private loggedIn = false;
  private schedulePageOpen = false;
  private tenantId: string | null;
  /** The date the schedule page currently shows (learned from the app's own request URLs). */
  private currentDate: string | null = null;

  private rosterRecords: { records: PortalRosterRecord[]; at: number } | null = null;
  private identityRecord: PortalIdentity | null = null;
  private readonly dayCache = new Map<string, { records: PortalScheduleRecord[]; at: number }>();

  private responseWaiters: Array<(seen: ScheduleResponseSeen) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();

  private readonly cfg: Required<
    Pick<
      PortalSessionOptions,
      | "navigationTimeoutMs"
      | "loginTimeoutMs"
      | "responseTimeoutMs"
      | "captureGraceMs"
      | "maxDaySteps"
      | "dayCacheTtlMs"
      | "rosterTtlMs"
    >
  >;

  private constructor(
    private readonly opts: PortalSessionOptions,
    private readonly creds: NeedleNineCredentials,
  ) {
    this.tenantId = opts.tenantId ?? null;
    this.cfg = {
      navigationTimeoutMs: opts.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs,
      loginTimeoutMs: opts.loginTimeoutMs ?? DEFAULTS.loginTimeoutMs,
      responseTimeoutMs: opts.responseTimeoutMs ?? DEFAULTS.responseTimeoutMs,
      captureGraceMs: opts.captureGraceMs ?? DEFAULTS.captureGraceMs,
      maxDaySteps: opts.maxDaySteps ?? DEFAULTS.maxDaySteps,
      dayCacheTtlMs: opts.dayCacheTtlMs ?? DEFAULTS.dayCacheTtlMs,
      rosterTtlMs: opts.rosterTtlMs ?? DEFAULTS.rosterTtlMs,
    };
  }

  /** Launch chromium, install the capture hook, and log in. */
  static async open(opts: PortalSessionOptions, creds: NeedleNineCredentials): Promise<PortalSession> {
    const session = new PortalSession(opts, creds);
    try {
      await session.launch();
      await session.login();
    } catch (err) {
      await session.dispose().catch(() => {});
      throw err;
    }
    return session;
  }

  isAlive(): boolean {
    return !this.disposed && this.browser !== null && this.browser.isConnected();
  }

  identity(): PortalIdentity | null {
    return this.identityRecord;
  }

  async roster(): Promise<PortalRosterRecord[]> {
    return this.exclusive(async () => {
      this.requireAlive();
      const now = Date.now();
      if (this.rosterRecords && now - this.rosterRecords.at < this.cfg.rosterTtlMs) return this.rosterRecords.records;
      // The roster loads with the schedule page; (re)open it to trigger a fresh fetch.
      this.schedulePageOpen = false;
      await this.ensureScheduleOpen();
      const roster = await this.waitForRoster();
      return roster;
    });
  }

  async fetchScheduleDay(date: string): Promise<PortalScheduleRecord[]> {
    return this.exclusive(async () => {
      this.requireAlive();
      const cached = this.dayCache.get(date);
      const now = Date.now();
      if (cached && now - cached.at < this.cfg.dayCacheTtlMs) return cached.records;
      this.dayCache.delete(date);
      if (this.currentDate === date) {
        // The calendar already shows this day, so stepping would fire no new
        // request: reload the schedule page to make the app re-fetch it.
        this.schedulePageOpen = false;
      }

      await this.ensureScheduleOpen();
      let steps = 0;
      while (this.currentDate !== date) {
        if (steps++ >= this.cfg.maxDaySteps) {
          throw new PortalError(
            "timeout",
            `Could not reach ${date} on the schedule after ${this.cfg.maxDaySteps} day steps.`,
            "Query a window closer to today, or check that the schedule's date controls still work.",
          );
        }
        const delta = this.currentDate ? diffCalendarDays(this.currentDate, date) : 1;
        await this.stepDay(delta > 0 ? "forward" : "back");
      }
      const day = this.dayCache.get(date);
      if (!day) {
        throw new PortalError(
          "site-changed",
          `The schedule for ${date} loaded but its data was not observed.`,
          "The portal may have changed how it delivers schedule data; see src/providers/needlenine/site.ts.",
        );
      }
      return day.records;
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.responseWaiters = [];
    const context = this.context;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    try {
      await context?.close();
    } catch {
      /* already closed */
    }
    try {
      await browser?.close();
    } catch {
      /* already closed */
    }
  }

  // --- launch & login -------------------------------------------------------------

  private async launch(): Promise<void> {
    const pw = await loadPlaywright();
    const plan = chromiumLaunchPlan({ override: this.opts.executablePath ?? null });
    const failures: string[] = [];
    let browser: Browser | null = null;
    for (const choice of plan) {
      try {
        browser = await pw.chromium.launch({
          headless: this.opts.headless ?? true,
          chromiumSandbox: this.opts.chromiumSandbox ?? defaultChromiumSandbox(),
          ...(choice.executablePath ? { executablePath: choice.executablePath } : {}),
          ...(choice.channel ? { channel: choice.channel } : {}),
          args: ["--disable-blink-features=AutomationControlled"],
        });
        if (choice.source !== "playwright" && choice.source !== "override") {
          this.log(`using the system browser (${choice.executablePath ?? `channel ${choice.channel}`})`);
        }
        break;
      } catch (err) {
        failures.push(`${choice.source}: ${briefError(err)}`);
        this.log(`browser launch failed (${choice.source}), ${plan.indexOf(choice) < plan.length - 1 ? "trying next option" : "no options left"}`);
      }
    }
    if (!browser) throw browserLaunchError(plan, failures);
    this.browser = browser;
    this.browser.on("disconnected", () => {
      this.disposed = true;
      this.log("browser disconnected");
    });
    const version = safeBrowserVersion(this.browser);
    this.context = await this.browser.newContext({
      timezoneId: this.opts.timezone,
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    });
    this.context.setDefaultTimeout(this.cfg.navigationTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.cfg.navigationTimeoutMs);
    // The JSON.parse capture hook must exist before any app script runs.
    await this.context.addInitScript(buildCaptureInitScript());
    this.page = await this.context.newPage();
    this.page.on("response", (response) => this.onResponse(response));
    this.log(`browser ready (chromium ${version})`);
  }

  /**
   * Fail closed if the browser is not on the configured portal's origin —
   * credentials must never be entered into a page a redirect (compromised
   * portal, captive portal, DNS games) navigated to.
   */
  private assertOnConfiguredPortal(page: Page): void {
    const expected = new URL(this.opts.portalUrl).origin;
    const actual = new URL(page.url()).origin;
    if (actual !== expected) {
      throw new PortalError(
        "site-changed",
        `The login page is on ${actual}, not the configured portal ${expected}; refusing to enter credentials.`,
        "If the school moved portals, update the scheduler portal URL explicitly.",
      );
    }
  }

  private async login(): Promise<void> {
    const page = this.requirePage();
    this.loggedIn = false;
    this.schedulePageOpen = false;
    this.log("logging in");
    try {
      await page.goto(loginUrl(this.opts.portalUrl), { waitUntil: "domcontentloaded" });
    } catch (err) {
      throw new PortalError(
        "timeout",
        `Could not open the NeedleNine login page at ${new URL(this.opts.portalUrl).origin} (${briefError(err)}).`,
        "Check the portal URL in your profile's scheduler block and your network connection.",
      );
    }

    this.assertOnConfiguredPortal(page);

    const emailInput = page.locator(LOGIN_FORM.email).first();
    try {
      await emailInput.waitFor({ state: "visible", timeout: this.cfg.navigationTimeoutMs });
    } catch {
      throw new PortalError(
        "site-changed",
        "The NeedleNine login form did not appear.",
        "The login page layout may have changed; see LOGIN_FORM in src/providers/needlenine/site.ts.",
      );
    }
    await emailInput.fill(this.creds.email);

    const passwordInput = page.locator(LOGIN_FORM.password).first();
    await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
    // The page may have redirected while we waited; re-check before the secret goes in.
    this.assertOnConfiguredPortal(page);
    // Set the secret through one in-page DOM call (not fill/type) so it never
    // travels through Playwright's typed-input APIs; errors below are ours.
    await passwordInput.evaluate(setInputValueInPage, this.creds.password.reveal());

    const submit = page.locator(LOGIN_FORM.submit).first();
    if (await submit.count().then((n) => n > 0, () => false)) {
      await submit.click();
    } else {
      await passwordInput.press("Enter");
    }

    const timeout = this.cfg.loginTimeoutMs;
    const succeeded = page
      .waitForURL((u) => !isLoginUrl(u.toString()), { timeout })
      .then(() => "ok" as const, () => "timeout" as const);
    const rejected = page
      .getByText(LOGIN_ERROR_TEXT)
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => "rejected" as const, () => "timeout" as const);
    const outcome = await Promise.race([succeeded, rejected]);

    if (outcome === "rejected") {
      throw new PortalError(
        "login-failed",
        `NeedleNine rejected the login for ${this.creds.email} (invalid email or password).`,
        this.creds.source === "keychain"
          ? "Update the stored password: security add-generic-password -a <email> -s runup-needlenine -w (adds/replaces after confirmation)."
          : "Check RUNUP_NEEDLENINE_PASSWORD.",
      );
    }
    if (outcome !== "ok" && isLoginUrl(page.url())) {
      throw new PortalError(
        "timeout",
        "Timed out waiting for the NeedleNine login to complete.",
        "The portal may be slow or the post-login navigation changed; try again in a moment.",
      );
    }

    this.loggedIn = true;
    if (!this.tenantId) this.tenantId = await this.detectTenantId();
    await this.drainCaptures(null);
    this.log(`logged in as ${this.creds.email}`);
  }

  private async detectTenantId(): Promise<string> {
    const page = this.requirePage();
    let tenantId = tenantIdFromPortalUrl(page.url());
    if (!tenantId) {
      // The router may still be moving to the landing page; give it a moment.
      await page
        .waitForURL((u) => tenantIdFromPortalUrl(u.toString()) !== null, { timeout: 8_000 })
        .catch(() => {});
      tenantId = tenantIdFromPortalUrl(page.url());
    }
    if (!tenantId) {
      throw new PortalError(
        "site-changed",
        "Logged in, but could not detect the school (tenant) id from the portal URL.",
        'Set scheduler.tenantId in your profile (the "/{tenantId}/DT/schedule" path segment shown in your browser).',
      );
    }
    return tenantId;
  }

  // --- schedule navigation ---------------------------------------------------------

  private async ensureLoggedIn(): Promise<void> {
    if (!this.isAlive()) {
      throw new PortalError("browser-launch", "The browser session is no longer running.", "Retry the request to start a fresh session.");
    }
    if (this.loggedIn && !isLoginUrl(this.requirePage().url())) return;
    await this.login();
  }

  /** Open the reservation calendar and learn its initial (tenant-local today) date. */
  private async ensureScheduleOpen(): Promise<void> {
    await this.ensureLoggedIn();
    if (this.schedulePageOpen && this.currentDate) return;
    const page = this.requirePage();
    for (let attempt = 0; attempt < 2; attempt++) {
      const firstResponse = this.nextScheduleResponse(this.cfg.responseTimeoutMs);
      try {
        await page.goto(scheduleUrl(this.opts.portalUrl, this.requireTenantId()), { waitUntil: "domcontentloaded" });
      } catch (err) {
        firstResponse.catch(() => {});
        throw new PortalError("timeout", `Could not open the schedule page (${briefError(err)}).`);
      }
      if (isLoginUrl(page.url())) {
        // Session token expired: the SPA bounced us to /login. Re-login once.
        firstResponse.catch(() => {});
        this.log("session expired; logging in again");
        await this.login();
        continue;
      }
      let seen: ScheduleResponseSeen;
      try {
        seen = await firstResponse;
      } catch {
        if (isLoginUrl(page.url()) && attempt === 0) {
          await this.login();
          continue;
        }
        throw new PortalError(
          "site-changed",
          "The schedule page loaded but never requested a day's schedule.",
          "The schedule route or its data request may have changed; see scheduleUrl/scheduleDateOfRequestUrl in site.ts.",
        );
      }
      this.currentDate = seen.date;
      this.schedulePageOpen = true;
      await this.settleCaptures(seen);
      this.log(`schedule open at ${seen.date}`);
      return;
    }
    throw new PortalError("timeout", "Could not open the schedule page after logging in again.", "Retry the request in a moment.");
  }

  /** Click the previous/next-day caret once and consume the resulting schedule payload. */
  private async stepDay(direction: "forward" | "back"): Promise<void> {
    const page = this.requirePage();
    const candidates = direction === "forward" ? SCHEDULE_CONTROLS.nextDay : SCHEDULE_CONTROLS.previousDay;
    try {
      await page.locator(candidates.join(", ")).first().waitFor({ state: "visible", timeout: this.cfg.navigationTimeoutMs });
    } catch {
      throw new PortalError(
        "site-changed",
        "The schedule's previous/next-day controls were not found.",
        "The date toolbar may have changed; see SCHEDULE_CONTROLS in src/providers/needlenine/site.ts.",
      );
    }
    // Prefer the toolbar-scoped selector so a caret icon elsewhere on the page is never clicked.
    let control = page.locator(candidates[0]).first();
    for (const selector of candidates) {
      const scoped = page.locator(selector);
      if ((await scoped.count()) > 0) {
        control = scoped.first();
        break;
      }
    }
    const responsePromise = this.nextScheduleResponse(this.cfg.responseTimeoutMs);
    try {
      await control.click();
    } catch (err) {
      responsePromise.catch(() => {});
      throw new PortalError("site-changed", `Could not click the schedule's day control (${briefError(err)}).`);
    }
    const seen = await responsePromise.catch((err: unknown) => {
      throw err instanceof PortalError
        ? new PortalError("timeout", "The schedule did not load the next day after clicking the day control.", err.hint)
        : err;
    });
    this.currentDate = seen.date;
    await this.settleCaptures(seen);
    await sleep(STEP_SETTLE_MS);
  }

  /**
   * After the app fetched a day's schedule, wait until the page's JSON.parse
   * hook has handed the projected records over. A response whose data never
   * shows up is an empty day when the body was tiny, otherwise a hard
   * "parse boundary changed" error (we never guess).
   */
  private async settleCaptures(seen: ScheduleResponseSeen): Promise<void> {
    // Track the body size in the background: a tiny response with no capture
    // after a short parse grace is an empty day, so we do not have to sit out
    // the full capture grace for quiet days.
    let bodyLength: number | null = null;
    void seen.bodyLength.then(
      (length) => (bodyLength = length),
      () => (bodyLength = -1),
    );
    const started = Date.now();
    const looksEmpty = (): boolean =>
      bodyLength !== null &&
      bodyLength >= 0 &&
      bodyLength <= EMPTY_SCHEDULE_BODY_MAX_BYTES &&
      Date.now() - started >= EMPTY_DAY_PARSE_GRACE_MS;
    await this.pollCaptures(() => this.dayCache.has(seen.date) || looksEmpty(), seen.date);
    if (this.dayCache.has(seen.date)) return;
    const finalLength: number = bodyLength ?? (await seen.bodyLength);
    if (finalLength >= 0 && finalLength <= EMPTY_SCHEDULE_BODY_MAX_BYTES) {
      this.dayCache.set(seen.date, { records: [], at: Date.now() });
      return;
    }
    throw new PortalError(
      "site-changed",
      `The schedule for ${seen.date} arrived but the page's parsed data was not observed.`,
      "The portal may have changed how it decodes schedule data; see the documented fallback in src/providers/needlenine/site.ts.",
    );
  }

  private async waitForRoster(): Promise<PortalRosterRecord[]> {
    const isFresh = (): boolean => this.rosterRecords !== null && Date.now() - this.rosterRecords.at < this.cfg.rosterTtlMs;
    if (await this.pollCaptures(isFresh, null)) return this.rosterRecords!.records;
    throw new PortalError(
      "site-changed",
      "The aircraft roster was not observed on the schedule page.",
      "The portal may load the roster differently now; see classifyPortalPayload in src/providers/needlenine/site.ts.",
    );
  }

  /** Drain in-page captures until `ready()` holds or the grace period lapses. */
  private async pollCaptures(ready: () => boolean, attributionDate: string | null): Promise<boolean> {
    const deadline = Date.now() + this.cfg.captureGraceMs;
    for (;;) {
      await this.drainCaptures(attributionDate);
      if (ready()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(CAPTURE_POLL_MS);
    }
  }

  /** Move every queued in-page capture into node-side caches. */
  private async drainCaptures(attributionDate: string | null): Promise<void> {
    const page = this.requirePage();
    let entries: CapturedEntry[];
    try {
      entries = (await page.evaluate(drainCaptureQueue, CAPTURE_QUEUE_KEY)) as CapturedEntry[];
    } catch (err) {
      throw new PortalError("browser-launch", `Lost the browser page while reading captured data (${briefError(err)}).`);
    }
    const now = Date.now();
    for (const entry of entries) {
      if (entry.kind === "roster") {
        this.rosterRecords = { records: entry.payload as PortalRosterRecord[], at: now };
      } else if (entry.kind === "identity") {
        const identity = entry.payload as PortalIdentity;
        if (identity && identity.userId !== null) this.identityRecord = identity;
      } else if (entry.kind === "schedule") {
        const records = entry.payload as PortalScheduleRecord[];
        const date = attributeScheduleDate(records, this.opts.timezone, attributionDate);
        if (date) this.dayCache.set(date, { records, at: now });
      }
    }
  }

  // --- response tracking ---------------------------------------------------------------

  private onResponse(response: Response): void {
    let date: string | null = null;
    try {
      date = scheduleDateOfRequestUrl(response.url());
    } catch {
      return;
    }
    if (!date) return;
    const seen: ScheduleResponseSeen = {
      date,
      at: Date.now(),
      bodyLength: response
        .body()
        .then((body) => body.length)
        .catch(() => -1),
    };
    const waiters = this.responseWaiters;
    this.responseWaiters = [];
    for (const waiter of waiters) waiter(seen);
  }

  /** Resolves with the next day-schedule response the page receives (register before acting). */
  private nextScheduleResponse(timeoutMs: number): Promise<ScheduleResponseSeen> {
    return new Promise<ScheduleResponseSeen>((resolve, reject) => {
      const waiter = (seen: ScheduleResponseSeen): void => {
        clearTimeout(timer);
        resolve(seen);
      };
      const timer = setTimeout(() => {
        this.responseWaiters = this.responseWaiters.filter((w) => w !== waiter);
        reject(new PortalError("timeout", "Timed out waiting for the schedule data request."));
      }, timeoutMs);
      this.responseWaiters.push(waiter);
    });
  }

  // --- utilities --------------------------------------------------------------------------

  /** Serialize session operations: one page is driven, one action at a time. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private requireAlive(): void {
    if (!this.isAlive()) {
      throw new PortalError("browser-launch", "The browser session is not running.", "Retry the request to start a fresh session.");
    }
  }

  private requirePage(): Page {
    if (this.disposed || !this.page) {
      throw new PortalError("browser-launch", "The browser session is not running.", "Retry the request to start a fresh session.");
    }
    return this.page;
  }

  private requireTenantId(): string {
    if (!this.tenantId) {
      throw new PortalError("site-changed", "The school (tenant) id is unknown.", "Set scheduler.tenantId in your profile.");
    }
    return this.tenantId;
  }

  private log(line: string): void {
    this.opts.logger?.(`needlenine: ${line}`);
  }
}

// --- helpers ----------------------------------------------------------------------------

/**
 * Which tenant-local day a captured schedule payload belongs to: the
 * dominant local start date across its records; fall back to the date of
 * the response we just watched arrive.
 */
export function attributeScheduleDate(
  records: readonly PortalScheduleRecord[],
  timeZone: string,
  fallbackDate: string | null,
): string | null {
  const counts = new Map<string, number>();
  let dated = 0;
  for (const record of records) {
    const start = parseNaiveUtc(record.start);
    if (start === null) continue;
    dated += 1;
    const date = localDateOf(start, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [date, count] of counts) {
    if (count > bestCount) {
      best = date;
      bestCount = count;
    }
  }
  if (best !== null && dated > 0 && bestCount * 2 >= dated) return best;
  return fallbackDate ?? best;
}

/**
 * Well-known system Chromium/Chrome locations, tried when Playwright's own
 * chromium is not installed and no RUNUP_CHROMIUM_PATH override is set.
 */
export function findSystemChromium(platform: NodeJS.Platform = process.platform): string | null {
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Playwright's expected chromium path (may not exist on disk), or null when unknown. */
export function bundledChromiumPath(pw: PlaywrightModule): string | null {
  try {
    return pw.chromium.executablePath();
  } catch {
    return null;
  }
}

/** One browser-launch attempt: which binary/channel and why. */
export interface ChromiumChoice {
  source: "override" | "playwright" | "system-path" | "system-channel";
  /** Explicit binary (override / detected system browser). Absent = playwright resolves. */
  executablePath?: string;
  /** Playwright distribution channel (system fallback when no known path exists). */
  channel?: string;
}

/**
 * THE chromium policy, as an ordered list of launch attempts:
 * - RUNUP_CHROMIUM_PATH override is authoritative (no fallback - a configured
 *   path that fails must surface, not be silently papered over);
 * - otherwise playwright's own browser first, then the signed system Chrome
 *   (by known path, else playwright's "chrome" channel discovery).
 * Attempt-based on purpose: a binary can exist on disk yet fail to run
 * (binary-authorization SIGKILL, missing headless shell), so existence checks
 * cannot decide what will actually launch - trying can.
 */
export function chromiumLaunchPlan(opts: {
  override: string | null;
  platform?: NodeJS.Platform;
  probeSystemBrowser?: (platform: NodeJS.Platform) => string | null;
}): ChromiumChoice[] {
  if (opts.override) return [{ source: "override", executablePath: opts.override }];
  const system = (opts.probeSystemBrowser ?? findSystemChromium)(opts.platform ?? process.platform);
  return [
    { source: "playwright" },
    system ? { source: "system-path", executablePath: system } : { source: "system-channel", channel: "chrome" },
  ];
}

function browserLaunchError(plan: ChromiumChoice[], failures: string[]): PortalError {
  if (plan[0]?.source === "override") {
    return new PortalError(
      "browser-missing",
      `The browser at RUNUP_CHROMIUM_PATH (${plan[0].executablePath}) could not be launched (${failures[0] ?? "unknown error"}).`,
      "Fix or unset RUNUP_CHROMIUM_PATH - it takes precedence over every other browser.",
    );
  }
  return new PortalError(
    "browser-missing",
    `No usable browser: every launch attempt failed (${failures.join("; ")}).`,
    "Run `npx playwright install chromium`, install Google Chrome, or point RUNUP_CHROMIUM_PATH at a working Chromium binary.",
  );
}

function safeBrowserVersion(browser: Browser): string {
  try {
    const v = browser.version();
    return /^[\d.]+$/.test(v) ? v : "141.0.0.0";
  } catch {
    return "141.0.0.0";
  }
}

/** First line of an error message, truncated — never a stack dump. */
export function briefError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
