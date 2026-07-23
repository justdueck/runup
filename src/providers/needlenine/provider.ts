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
import { briefError, PortalError, PortalSession, type SchedulerSession } from "./portal-session.js";
import type { PortalScheduleRecord } from "./site.js";
import { localDateOf, localDatesSpanning } from "./time.js";

export const NEEDLENINE_SOURCE = "needlenine";

/** Windows spanning more local days than this are rejected (each day = one schedule fetch). */
export const MAX_DAYS_PER_QUERY = 14;

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

export class NeedleNineProvider implements AvailabilityProvider {
  readonly name = NEEDLENINE_SOURCE;

  private session: SchedulerSession | null = null;
  private sessionKey: string | null = null;
  private opening: Promise<SchedulerSession> | null = null;
  private creds: NeedleNineCredentials | null = null;

  constructor(private readonly deps: NeedleNineProviderDeps) {}

  /** True when the profile (or environment) configures a NeedleNine scheduler. */
  static isConfigured(profile: Profile, env: NodeJS.ProcessEnv = process.env): boolean {
    return resolveSchedulerConfig(profile, env) !== null;
  }

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

    try {
      const session = await this.ensureSession(cfg);
      const roster = await session.roster();
      const records: PortalScheduleRecord[] = [];
      for (const date of dates) {
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
          `${dates.length} local day${dates.length === 1 ? "" : "s"} checked (${cfg.timezone}). ` +
          "Only your checked-out tails are assessed; other members' details are never captured.",
      ];
      return toAircraftAvailability(window, result, this.name, notes);
    } catch (err) {
      throw this.friendlyError(err);
    }
  }

  /** Close the browser session (server shutdown / config change). Idempotent. */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.sessionKey = null;
    if (session) await session.dispose().catch(() => {});
  }

  // --- internals ----------------------------------------------------------------------

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private async ensureSession(cfg: NeedleNineConfig): Promise<SchedulerSession> {
    const key = `${cfg.email}|${cfg.portalUrl}|${cfg.timezone}|${cfg.tenantId ?? ""}`;
    if (this.session && this.sessionKey === key && this.session.isAlive()) return this.session;
    await this.dispose();
    if (!this.opening) {
      this.opening = (async () => {
        const creds = this.deps.resolveCredentials
          ? await this.deps.resolveCredentials(cfg)
          : await resolveNeedleNineCredentials({
              email: cfg.email,
              env: this.env(),
              ...(this.deps.platform ? { platform: this.deps.platform } : {}),
            });
        this.creds = creds;
        const open = this.deps.openSession ?? this.defaultOpenSession();
        const session = await open(cfg, creds);
        this.session = session;
        this.sessionKey = key;
        return session;
      })().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
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
          ...(this.deps.logger ? { logger: this.deps.logger } : {}),
        },
        creds,
      );
  }

  /** Turn any failure into a short, hint-carrying, secret-free error. */
  private friendlyError(err: unknown): NeedleNineError {
    if (this.session && !this.session.isAlive()) {
      this.session = null;
      this.sessionKey = null;
    }
    let message: string;
    if (err instanceof PortalError) message = `${err.message}${err.hint ? ` — ${err.hint}` : ""}`;
    else if (err instanceof NeedleNineSetupError || err instanceof NeedleNineError) message = err.message;
    else message = `NeedleNine availability lookup failed: ${briefError(err)}`;
    const scrubbed = this.creds ? this.creds.password.scrub(message) : message;
    return new NeedleNineError(scrubbed);
  }
}
