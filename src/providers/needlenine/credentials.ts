/**
 * NeedleNine login credentials.
 *
 * The password never lives in profile.json, files, logs, errors, or tool
 * output. Resolution order:
 *   1. macOS keychain via the `security` CLI (service "runup-needlenine",
 *      account = your NeedleNine email) — invoked with execFile (no shell),
 *      so an unusual email address cannot inject shell syntax;
 *   2. RUNUP_NEEDLENINE_PASSWORD in the server's environment (the
 *      documented, less-safe fallback for non-macOS hosts).
 * The email is not secret (it is shown in status output); only the password
 * is wrapped in {@link Secret}, whose every serialization path redacts.
 */
import { execFile as execFileCb } from "node:child_process";
import { inspect, promisify } from "node:util";

export const KEYCHAIN_SERVICE = "runup-needlenine";
export const ENV_EMAIL = "RUNUP_NEEDLENINE_EMAIL";
export const ENV_PASSWORD = "RUNUP_NEEDLENINE_PASSWORD";
export const REDACTED = "[redacted]";

/** Wrapper that keeps a secret out of string interpolation, JSON, and util.inspect output. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw value — call only at the point of use (the login form). */
  reveal(): string {
    return this.#value;
  }

  /** Defense in depth: remove the secret (and its URI-encoded form) from any text about to leave the process. */
  scrub(text: string): string {
    let out = text;
    for (const needle of [this.#value, encodeURIComponent(this.#value)]) {
      if (needle.length >= 3 && out.includes(needle)) out = out.split(needle).join(REDACTED);
    }
    return out;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export type CredentialSource = "keychain" | "env";

export interface NeedleNineCredentials {
  email: string;
  password: Secret;
  source: CredentialSource;
}

/** Friendly, secret-free setup problem (missing/denied credentials). */
export class NeedleNineSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedleNineSetupError";
  }
}

/** Injectable `execFile` (promisified) so tests never touch a real keychain. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean; encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(execFileCb) as unknown as ExecFileFn;

/** `security` exit code when no matching keychain item exists. */
const SECURITY_ITEM_NOT_FOUND = 44;
/** `security` exit codes for a denied/cancelled keychain prompt. */
const SECURITY_ACCESS_DENIED = new Set([51, 128]);

/** Quote a string for a POSIX shell command line (for messages shown to the user). */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The exact command a user runs (interactively) to store the password in the macOS keychain. */
export function keychainAddCommand(email: string): string {
  return `security add-generic-password -a ${shellQuote(email)} -s ${KEYCHAIN_SERVICE} -w`;
}

/**
 * Read the stored password from the macOS keychain (`security
 * find-generic-password -w`). Returns null when there is no such item or no
 * `security` binary. Never includes command output in thrown errors.
 */
export async function readKeychainPassword(
  email: string,
  deps: { execFile?: ExecFileFn; timeoutMs?: number } = {},
): Promise<Secret | null> {
  const run = deps.execFile ?? defaultExecFile;
  try {
    const { stdout } = await run("security", ["find-generic-password", "-a", email, "-s", KEYCHAIN_SERVICE, "-w"], {
      timeout: deps.timeoutMs ?? 60_000,
      windowsHide: true,
      encoding: "utf8",
    });
    const value = stdout.replace(/\r?\n$/, "");
    return value.length > 0 ? new Secret(value) : null;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    const killed = (err as { killed?: boolean }).killed;
    if (code === SECURITY_ITEM_NOT_FOUND || code === "ENOENT") return null;
    if (typeof code === "number" && SECURITY_ACCESS_DENIED.has(code)) {
      throw new NeedleNineSetupError(
        `Access to the macOS keychain entry "${KEYCHAIN_SERVICE}" for ${email} was denied — allow it in the keychain prompt and try again.`,
      );
    }
    if (killed) {
      throw new NeedleNineSetupError(
        `Timed out reading the macOS keychain entry "${KEYCHAIN_SERVICE}" for ${email} (approve the keychain prompt, then retry).`,
      );
    }
    // Do not surface stdout/stderr or the process error text: build our own message from the exit code.
    throw new NeedleNineSetupError(
      `Could not read the macOS keychain entry "${KEYCHAIN_SERVICE}" for ${email} (security exited with code ${String(code)}).`,
    );
  }
}

export interface ResolveCredentialsOptions {
  /** Email from the profile's scheduler block (falls back to RUNUP_NEEDLENINE_EMAIL). */
  email?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
}

/** Resolve the NeedleNine login: keychain first (macOS), then the env var; friendly error otherwise. */
export async function resolveNeedleNineCredentials(opts: ResolveCredentialsOptions = {}): Promise<NeedleNineCredentials> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const email = (opts.email ?? env[ENV_EMAIL] ?? "").trim();
  if (!email) {
    throw new NeedleNineSetupError(
      "NeedleNine is not configured: add a scheduler block to your profile " +
        '(update_profile {"scheduler": {"provider": "needlenine", "email": "you@example.com"}}) and store the ' +
        "password in the macOS keychain (see the README's NeedleNine setup).",
    );
  }

  const checked: string[] = [];
  if (platform === "darwin") {
    const secret = await readKeychainPassword(email, { execFile: opts.execFile });
    if (secret) return { email, password: secret, source: "keychain" };
    checked.push(`the macOS keychain (service "${KEYCHAIN_SERVICE}", account "${email}")`);
  }
  const fromEnv = env[ENV_PASSWORD];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { email, password: new Secret(fromEnv), source: "env" };
  }
  checked.push(`the ${ENV_PASSWORD} environment variable`);
  throw new NeedleNineSetupError(
    `No NeedleNine password found (checked ${checked.join(" and ")}). ` +
      `Store it in the keychain with: ${keychainAddCommand(email)}` +
      (platform === "darwin" ? "" : ` — or set ${ENV_PASSWORD} in the server environment (non-macOS fallback)`) +
      ".",
  );
}

/** Secret-free description of which credential sources are usable here (for status output). */
export function describeCredentialSources(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { keychain: "available" | "not-macos"; envPasswordSet: boolean; envEmailSet: boolean } {
  return {
    keychain: platform === "darwin" ? "available" : "not-macos",
    envPasswordSet: typeof env[ENV_PASSWORD] === "string" && env[ENV_PASSWORD]!.length > 0,
    envEmailSet: typeof env[ENV_EMAIL] === "string" && env[ENV_EMAIL]!.trim().length > 0,
  };
}
