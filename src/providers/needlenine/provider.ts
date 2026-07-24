/**
 * NeedleNineProvider: aircraft availability from the flight school's
 * NeedleNine portal, on demand and read-only.
 *
 * Flow per query: profile scheduler config -> credentials (keychain/env) ->
 * one lazily-created browser session per server process -> the roster plus
 * one schedule day per tenant-local date the window spans (both cached in
 * memory briefly) -> pure availability math. Failures become concise
 * one-line errors with a remediation hint; the password is scrubbed from
 * anything that could leave the process.
 */
import type { Profile } from "../../profile.js";
import type { AircraftAvailability, TimeWindow } from "../../types.js";
import type { AvailabilityProvider } from "../types.js";
import { computeAvailability, toAircraftAvailability } from "./availability.js";
import type { NeedleNineConfig } from "./config.js";
import { resolveSchedulerConfig } from "./config.js";
import { NeedleNineSetupError, resolveNeedleNineCredentials, type NeedleNineCredentials } from "./credentials.js";
import { briefError, defaultChromiumSandbox, PortalError, PortalSession, type SchedulerSession } from "./portal-session.js";
import type { PortalScheduleRecord } from "./site.js";
import { addDaysToDate, localDateOf, localDatesSpanning } from "./time.js";

export const NEEDLENINE_SOURCE = "needlenine";

/** Windows spanning more local days than this are rejected (each day = one schedule fetch). */
export const MAX_DAYS_PER_QUERY = 14;

/**
 * Extra days fetched BEFORE the window (not counted against the cap): portal
 * payloads are keyed by the day a booking STARTS, so an overnight block that
 * began the previous local day (or a flight dispatched then and still out)
 * lives in that day's payload. Blocks starting earlier than the lookback are
 * still invisible - acceptable for GA bookings, noted on purpose.
 */
export const SCHEDULE_LOOKBACK_DAYS = 1;

export type SessionOpener = (cfg: NeedleNineConfig, creds: NeedleNineCredentials) => Promise<SchedulerSession>;

export interface NeedleNineProviderDeps {
  loadProfile: () => Promise<Profile>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Override credential resolution (tests). */
  resolveCredentials?: (cfg: NeedleNineConfig) => Promise<NeedleNineCredentials>;
  /** Override session creation (tests use a fake or mock-portal session). */
  openSession?: SessionOpener;
  now?: () => number;
  /** Diagnostic sink (stderr). Never receives secrets or member data. */
  logger?: (line: string) => void;
}

/** Friendly one-line error surfaced to tools; never a stack, never the password. */
export class NeedleNineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedleNineError";
  }
}

/** One session slot: which config it was opened for, and the (possibly still pending) open. */
interface SessionSlot {
  key: string;
  promise: Promise<SchedulerSession>;
}

export class NeedleNineProvider implements AvailabilityProvider {
  readonly name = NEEDLENINE_SOURCE;

  /** The single cached session, keyed by the config it was opened for. */
  private slot: SessionSlot | null = null;
  /** Last credentials used, kept only to scrub the password out of error text. */
  private lastCreds: NeedleNineCredentials | null = null;

  constructor(private readonly deps: NeedleNineProviderDeps) {}

  async getAircraftAvailability(window: TimeWindow): Promise<AircraftAvailability> {
    const profile = await this.deps.loadProfile();
    const cfg = resolveSchedulerConfig(profile, this.env());
    if (!cfg) {
      throw new NeedleNineError(
        "NeedleNine is not configured — add a scheduler block to your profile (see get_scheduler_status).",
      );
    }
    return this.availabilityFor(window, profile, cfg);
  }

  /** Main entry: availability for a window given the profile and resolved scheduler config. */
  async availabilityFor(window: TimeWindow, profile: Profile, cfg: NeedleNineConfig): Promise<AircraftAvailability> {
    const tails = profile.aircraft.filter((a) => a.checkedOut).map((a) => a.tail);
    if (tails.length === 0) {
      return {
        window,
        availableTails: [],
        source: this.name,
        notes: ["No aircraft in your profile are marked checked-out, so there is nothing to check at the school."],
        tails: [],
      };
    }

    const now = (this.deps.now ?? Date.now)();
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new NeedleNineError("Invalid time window: start must be before end.");
    }
    const dates = localDatesSpanning(startMs, endMs, cfg.timezone);
    if (dates.length > MAX_DAYS_PER_QUERY) {
      throw new NeedleNineError(
        `That window spans ${dates.length} local days; keep availability queries to ${MAX_DAYS_PER_QUERY} days or fewer.`,
      );
    }
    const fetchDates = [addDaysToDate(dates[0], -SCHEDULE_LOOKBACK_DAYS), ...dates];

    try {
      const session = await this.ensureSession(cfg);
      const roster = await session.roster();
      const records: PortalScheduleRecord[] = [];
      for (const date of fetchDates) {
        // Sequential on purpose: one page, one day at a time (polite, cache-friendly).
        records.push(...(await session.fetchScheduleDay(date)));
      }
      const identity = session.identity();
      const result = computeAvailability({
        window,
        tails,
        roster,
        records,
        timeZone: cfg.timezone,
        ownUserId: identity?.userId ?? null,
        nowMs: now,
        // Judge maintenance expirations as of the flight day (never before today).
        checkDateLocal: localDateOf(Math.max(now, startMs), cfg.timezone),
      });
      const notes = [
        `Live from the NeedleNine portal (${new URL(cfg.portalUrl).host}) as ${cfg.email}, read-only; ` +
          `${dates.length} local day${dates.length === 1 ? "" : "s"} checked plus one lookback day for overnight blocks (${cfg.timezone}). ` +
          "Only your checked-out tails are assessed; other members' details are never captured.",
      ];
      return toAircraftAvailability(window, result, this.name, notes);
    } catch (err) {
      throw this.friendlyError(err);
    }
  }

  /** Close the browser session (server shutdown / config change). Idempotent. */
  async dispose(): Promise<void> {
    const slot = this.slot;
    this.slot = null;
    if (!slot) return;
    // If the open is still in flight, wait for it so the browser it produces
    // is actually closed rather than orphaned.
    try {
      const session = await slot.promise;
      await session.dispose().catch(() => {});
    } catch {
      // The open itself failed; there is no session to close.
    }
  }

  // --- internals ----------------------------------------------------------------------

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private async ensureSession(cfg: NeedleNineConfig): Promise<SchedulerSession> {
    const key = `${cfg.email}|${cfg.portalUrl}|${cfg.timezone}|${cfg.tenantId ?? ""}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A slot opened for a different config (profile edited since) is stale:
      // dispose it (fire-and-forget - dispose clears the slot synchronously and
      // closes whatever session the open eventually produces), so a login
      // racing a config change can never serve the old account.
      if (this.slot && this.slot.key !== key) void this.dispose();
      if (!this.slot) {
        const slot: SessionSlot = { key, promise: this.openFor(cfg) };
        this.slot = slot;
        // A failed open must not wedge the slot; the next call retries.
        slot.promise.catch(() => {
          if (this.slot === slot) this.slot = null;
        });
      }
      const slot = this.slot;
      const session = await slot.promise;
      if (this.slot !== slot) {
        // The slot changed while we awaited. If a concurrent same-config call
        // merely replaced a dead session, loop and join its fresh slot;
        // otherwise (dispose or config change) the session we got is being
        // closed by whoever replaced it - fail rather than use it.
        if (this.slot?.key === key) continue;
        throw new NeedleNineError("The portal session was closed while opening (configuration changed?) — try again.");
      }
      if (session.isAlive()) return session;
      this.slot = null; // browser died since it was opened; retry
    }
    throw new NeedleNineError("Could not keep a NeedleNine portal session open — try again.");
  }

  /** Resolve credentials and open a session for `cfg` (the slot's promise body). */
  private async openFor(cfg: NeedleNineConfig): Promise<SchedulerSession> {
    const creds = this.deps.resolveCredentials
      ? await this.deps.resolveCredentials(cfg)
      : await resolveNeedleNineCredentials({
          email: cfg.email,
          env: this.env(),
          ...(this.deps.platform ? { platform: this.deps.platform } : {}),
        });
    this.lastCreds = creds;
    const open = this.deps.openSession ?? this.defaultOpenSession();
    return open(cfg, creds);
  }

  private defaultOpenSession(): SessionOpener {
    const env = this.env();
    return (cfg, creds) =>
      PortalSession.open(
        {
          portalUrl: cfg.portalUrl,
          timezone: cfg.timezone,
          ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}),
          ...(env.RUNUP_CHROMIUM_PATH ? { executablePath: env.RUNUP_CHROMIUM_PATH } : {}),
          headless: env.RUNUP_HEADLESS !== "0",
          chromiumSandbox: defaultChromiumSandbox(env, this.deps.platform),
          ...(this.deps.logger ? { logger: this.deps.logger } : {}),
        },
        creds,
      );
  }

  /** Turn any failure into a short, hint-carrying, secret-free error. */
  private friendlyError(err: unknown): NeedleNineError {
    let message: string;
    if (err instanceof PortalError) message = `${err.message}${err.hint ? ` — ${err.hint}` : ""}`;
    else if (err instanceof NeedleNineSetupError || err instanceof NeedleNineError) message = err.message;
    else message = `NeedleNine availability lookup failed: ${briefError(err)}`;
    const scrubbed = this.lastCreds ? this.lastCreds.password.scrub(message) : message;
    return new NeedleNineError(scrubbed);
  }
}
