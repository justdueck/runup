/**
 * Secret-free scheduler status for the get_scheduler_status tool: what is
 * configured, where credentials would come from, and whether a browser
 * runtime looks available. Never resolves the password, never launches a
 * browser.
 */
import { existsSync } from "node:fs";
import type { Profile } from "../../profile.js";
import { resolveSchedulerConfig } from "./config.js";
import { describeCredentialSources, ENV_EMAIL, ENV_PASSWORD, keychainAddCommand, KEYCHAIN_SERVICE } from "./credentials.js";
import { loadPlaywright } from "./portal-session.js";

export interface SchedulerStatus {
  configured: boolean;
  provider: "needlenine" | null;
  configuredVia: "profile" | "env" | null;
  email: string | null;
  portalUrl: string | null;
  timezone: string | null;
  credentials: {
    keychain: "available" | "not-macos";
    keychainService: string;
    envPasswordVariable: string;
    envPasswordSet: boolean;
    envEmailVariable: string;
    envEmailSet: boolean;
  };
  browser: {
    playwrightInstalled: boolean;
    chromiumPath: string | null;
    chromiumFound: boolean;
    executablePathOverride: string | null;
  };
  notes: string[];
}

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable playwright probe (tests): returns the chromium executable path. */
  probeBrowser?: () => Promise<{ installed: boolean; chromiumPath: string | null }>;
}

export async function schedulerStatus(profile: Profile, opts: StatusOptions = {}): Promise<SchedulerStatus> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cfg = resolveSchedulerConfig(profile, env);
  const sources = describeCredentialSources(env, platform);
  const browser = await (opts.probeBrowser ?? defaultProbeBrowser)();
  const override = env.RUNUP_CHROMIUM_PATH ? env.RUNUP_CHROMIUM_PATH : null;
  const chromiumFound = override !== null ? existsSync(override) : browser.chromiumPath !== null && existsSync(browser.chromiumPath);

  const notes: string[] = [];
  if (!cfg) {
    notes.push(
      "Not configured — availability tools fall back to placeholder (fixture) data.",
      'Configure: update_profile with {"scheduler": {"provider": "needlenine", "email": "you@example.com"}}, ' +
        `then store the portal password with: ${keychainAddCommand("you@example.com")} ` +
        `(non-macOS: set ${ENV_PASSWORD} in the server environment).`,
    );
  } else {
    notes.push(
      `Availability queries log into ${cfg.portalUrl} as ${cfg.email} in a headless browser and only read the schedule (never book, cancel, or check in).`,
    );
    if (platform === "darwin") {
      notes.push(`Password lookup: macOS keychain service "${KEYCHAIN_SERVICE}", account "${cfg.email}" (store with: ${keychainAddCommand(cfg.email)}).`);
    } else if (!sources.envPasswordSet) {
      notes.push(`No ${ENV_PASSWORD} is set for this server and this host has no macOS keychain — queries will fail until one is provided.`);
    }
  }
  if (!browser.installed) {
    notes.push("The playwright package is not installed: run `npm install` in the runup folder.");
  } else if (!chromiumFound) {
    notes.push("Chromium is not installed for Playwright: run `npx playwright install chromium` (or set RUNUP_CHROMIUM_PATH).");
  }

  return {
    configured: cfg !== null,
    provider: cfg ? "needlenine" : null,
    configuredVia: cfg?.origin ?? null,
    email: cfg?.email ?? null,
    portalUrl: cfg?.portalUrl ?? null,
    timezone: cfg?.timezone ?? null,
    credentials: {
      keychain: sources.keychain,
      keychainService: KEYCHAIN_SERVICE,
      envPasswordVariable: ENV_PASSWORD,
      envPasswordSet: sources.envPasswordSet,
      envEmailVariable: ENV_EMAIL,
      envEmailSet: sources.envEmailSet,
    },
    browser: {
      playwrightInstalled: browser.installed,
      chromiumPath: browser.chromiumPath,
      chromiumFound,
      executablePathOverride: override,
    },
    notes,
  };
}

async function defaultProbeBrowser(): Promise<{ installed: boolean; chromiumPath: string | null }> {
  try {
    const pw = await loadPlaywright();
    let chromiumPath: string | null = null;
    try {
      chromiumPath = pw.chromium.executablePath();
    } catch {
      chromiumPath = null;
    }
    return { installed: true, chromiumPath };
  } catch {
    return { installed: false, chromiumPath: null };
  }
}
