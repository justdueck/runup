/** NeedleNine flight-school scheduler integration (portal automation). */
export { NeedleNineProvider, NeedleNineError, NEEDLENINE_SOURCE, MAX_DAYS_PER_QUERY } from "./provider.js";
export type { NeedleNineProviderDeps, SessionOpener } from "./provider.js";
export { resolveSchedulerConfig, NEEDLENINE_PROVIDER, ENV_PORTAL_URL } from "./config.js";
export type { NeedleNineConfig } from "./config.js";
export {
  Secret,
  NeedleNineSetupError,
  resolveNeedleNineCredentials,
  readKeychainPassword,
  keychainAddCommand,
  shellQuote,
  describeCredentialSources,
  KEYCHAIN_SERVICE,
  ENV_EMAIL,
  ENV_PASSWORD,
} from "./credentials.js";
export type { NeedleNineCredentials, ExecFileFn, CredentialSource } from "./credentials.js";
export { PortalSession, PortalError, loadPlaywright, sanitizeDebugEnv } from "./portal-session.js";
export type { PortalSessionOptions, SchedulerSession, PortalErrorCode } from "./portal-session.js";
export { schedulerStatus } from "./status.js";
export type { SchedulerStatus } from "./status.js";
export * from "./availability.js";
export * from "./time.js";
export * from "./site.js";
