/**
 * Scheduler configuration resolution (secret-free): which NeedleNine account
 * and portal the provider should use. The profile's `scheduler` block is the
 * primary source; RUNUP_NEEDLENINE_EMAIL alone can enable the provider for
 * hosts that prefer environment configuration.
 */
import type { Profile } from "../../profile.js";
import { ENV_EMAIL } from "./credentials.js";
import { DEFAULT_PORTAL_URL } from "./site.js";
import { DEFAULT_TENANT_TIMEZONE } from "./time.js";

export const ENV_PORTAL_URL = "RUNUP_NEEDLENINE_PORTAL_URL";
export const NEEDLENINE_PROVIDER = "needlenine";

export interface NeedleNineConfig {
  provider: typeof NEEDLENINE_PROVIDER;
  email: string;
  portalUrl: string;
  timezone: string;
  tenantId?: string;
  /** Where the configuration came from (profile block or environment). */
  origin: "profile" | "env";
}

/** Resolve the scheduler config; null means "not configured" (fixture availability instead). */
export function resolveSchedulerConfig(profile: Profile, env: NodeJS.ProcessEnv = process.env): NeedleNineConfig | null {
  const block = profile.scheduler ?? null;
  if (block && block.provider === NEEDLENINE_PROVIDER) {
    return {
      provider: NEEDLENINE_PROVIDER,
      email: block.email,
      // Trusted operator env override first: the profile is writable from any
      // chat, so it must never shadow where the operator pointed the portal.
      portalUrl: nonEmpty(env[ENV_PORTAL_URL]) ?? block.portalUrl ?? DEFAULT_PORTAL_URL,
      timezone: block.timezone ?? DEFAULT_TENANT_TIMEZONE,
      ...(block.tenantId ? { tenantId: block.tenantId } : {}),
      origin: "profile",
    };
  }
  const email = nonEmpty(env[ENV_EMAIL]);
  if (email) {
    return {
      provider: NEEDLENINE_PROVIDER,
      email,
      portalUrl: nonEmpty(env[ENV_PORTAL_URL]) ?? DEFAULT_PORTAL_URL,
      timezone: DEFAULT_TENANT_TIMEZONE,
      origin: "env",
    };
  }
  return null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
