import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  describeCredentialSources,
  ENV_EMAIL,
  ENV_PASSWORD,
  keychainAddCommand,
  KEYCHAIN_SERVICE,
  NeedleNineSetupError,
  readKeychainPassword,
  resolveNeedleNineCredentials,
  Secret,
  shellQuote,
  type ExecFileFn,
} from "../../src/providers/needlenine/credentials.js";

const PASSWORD = "hunter2-Correct Horse!";

describe("Secret", () => {
  it("redacts itself in every accidental serialization path", () => {
    const secret = new Secret(PASSWORD);
    expect(String(secret)).toBe("[redacted]");
    expect(`interpolated ${secret}`).toBe("interpolated [redacted]");
    expect(JSON.stringify({ password: secret })).toBe('{"password":"[redacted]"}');
    expect(inspect(secret)).toBe("[redacted]");
    expect(inspect({ nested: [secret] })).not.toContain(PASSWORD);
    expect(secret.reveal()).toBe(PASSWORD);
    expect(secret.length).toBe(PASSWORD.length);
  });

  it("scrubs the value (and its URI-encoded form) out of arbitrary text", () => {
    const secret = new Secret(PASSWORD);
    const message = `Error: fill('${PASSWORD}') failed at https://x.test/?p=${encodeURIComponent(PASSWORD)}`;
    const scrubbed = secret.scrub(message);
    expect(scrubbed).not.toContain(PASSWORD);
    expect(scrubbed).not.toContain(encodeURIComponent(PASSWORD));
    expect(scrubbed).toContain("[redacted]");
  });
});

describe("shell display helpers", () => {
  it("quotes hostile emails safely for the documented keychain command", () => {
    const hostile = `we"ird$(rm -rf /)';x@example.com`;
    expect(shellQuote(hostile)).toBe(`'we"ird$(rm -rf /)'\\'';x@example.com'`);
    expect(keychainAddCommand("me@example.com")).toBe(
      "security add-generic-password -a 'me@example.com' -s runup-needlenine -w",
    );
  });
});

describe("readKeychainPassword", () => {
  it("invokes the security CLI with an argument array (no shell) and trims the trailing newline only", async () => {
    const email = `we"ird$(touch /tmp/pwn)';x@example.com`;
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: `${PASSWORD}\n`, stderr: "" }));
    const secret = await readKeychainPassword(email, { execFile });
    expect(secret?.reveal()).toBe(PASSWORD);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe("security");
    // The email is one discrete argv entry - never interpolated into a command string.
    expect(args).toEqual(["find-generic-password", "-a", email, "-s", KEYCHAIN_SERVICE, "-w"]);
  });

  it("preserves inner whitespace of the stored value", async () => {
    const execFile: ExecFileFn = async () => ({ stdout: " lead and trail \n", stderr: "" });
    expect((await readKeychainPassword("a@b.test", { execFile }))?.reveal()).toBe(" lead and trail ");
  });

  it("returns null when the item does not exist or the CLI is missing", async () => {
    const notFound: ExecFileFn = async () => {
      throw Object.assign(new Error("security: item could not be found"), { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." });
    };
    expect(await readKeychainPassword("a@b.test", { execFile: notFound })).toBeNull();

    const missingBinary: ExecFileFn = async () => {
      throw Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" });
    };
    expect(await readKeychainPassword("a@b.test", { execFile: missingBinary })).toBeNull();

    const empty: ExecFileFn = async () => ({ stdout: "\n", stderr: "" });
    expect(await readKeychainPassword("a@b.test", { execFile: empty })).toBeNull();
  });

  it("wraps other failures without leaking process output or the secret", async () => {
    const weird: ExecFileFn = async () => {
      throw Object.assign(new Error(`Command failed: security ... -w\nSecret stdout: ${PASSWORD}`), {
        code: 45,
        stdout: PASSWORD,
        stderr: `some stderr mentioning ${PASSWORD}`,
      });
    };
    await expect(readKeychainPassword("a@b.test", { execFile: weird })).rejects.toBeInstanceOf(NeedleNineSetupError);
    await readKeychainPassword("a@b.test", { execFile: weird }).catch((err: Error) => {
      expect(err.message).not.toContain(PASSWORD);
      expect(err.message).toContain("code 45");
    });

    const denied: ExecFileFn = async () => {
      throw Object.assign(new Error("denied"), { code: 51 });
    };
    await readKeychainPassword("a@b.test", { execFile: denied }).catch((err: Error) => {
      expect(err.message).toMatch(/denied/i);
    });

    const timedOut: ExecFileFn = async () => {
      throw Object.assign(new Error("timed out"), { killed: true, code: null });
    };
    await readKeychainPassword("a@b.test", { execFile: timedOut }).catch((err: Error) => {
      expect(err.message).toMatch(/Timed out/);
    });
  });
});

describe("resolveNeedleNineCredentials", () => {
  it("uses the keychain on macOS", async () => {
    const execFile: ExecFileFn = async () => ({ stdout: `${PASSWORD}\n`, stderr: "" });
    const creds = await resolveNeedleNineCredentials({ email: "me@example.com", platform: "darwin", env: {}, execFile });
    expect(creds.source).toBe("keychain");
    expect(creds.email).toBe("me@example.com");
    expect(creds.password.reveal()).toBe(PASSWORD);
  });

  it("falls back to the env password when the keychain has no item, and on non-macOS skips the keychain", async () => {
    const notFound: ExecFileFn = async () => {
      throw Object.assign(new Error("nope"), { code: 44 });
    };
    const fromEnv = await resolveNeedleNineCredentials({
      email: "me@example.com",
      platform: "darwin",
      env: { [ENV_PASSWORD]: "env-pw" },
      execFile: notFound,
    });
    expect(fromEnv.source).toBe("env");
    expect(fromEnv.password.reveal()).toBe("env-pw");

    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: `${PASSWORD}\n`, stderr: "" }));
    const linux = await resolveNeedleNineCredentials({
      email: "me@example.com",
      platform: "linux",
      env: { [ENV_PASSWORD]: "env-pw" },
      execFile,
    });
    expect(linux.source).toBe("env");
    expect(execFile).not.toHaveBeenCalled(); // no keychain probing off macOS
  });

  it("takes the email from the environment when the profile block has none", async () => {
    const creds = await resolveNeedleNineCredentials({
      platform: "linux",
      env: { [ENV_EMAIL]: " me@example.com ", [ENV_PASSWORD]: "env-pw" },
    });
    expect(creds.email).toBe("me@example.com");
  });

  it("fails with actionable, secret-free setup errors", async () => {
    await expect(resolveNeedleNineCredentials({ platform: "linux", env: {} })).rejects.toThrow(/not configured/i);
    await expect(
      resolveNeedleNineCredentials({ email: "me@example.com", platform: "linux", env: {} }),
    ).rejects.toThrow(/security add-generic-password -a 'me@example.com' -s runup-needlenine -w/);
    const notFound: ExecFileFn = async () => {
      throw Object.assign(new Error("nope"), { code: 44 });
    };
    await resolveNeedleNineCredentials({ email: "me@example.com", platform: "darwin", env: {}, execFile: notFound }).catch(
      (err: Error) => {
        expect(err).toBeInstanceOf(NeedleNineSetupError);
        expect(err.message).toMatch(/keychain/);
        expect(err.message).toMatch(new RegExp(ENV_PASSWORD));
      },
    );
  });
});

describe("describeCredentialSources", () => {
  it("reports availability without values", () => {
    expect(describeCredentialSources({ [ENV_PASSWORD]: "x" }, "darwin")).toEqual({
      keychain: "available",
      envPasswordSet: true,
      envEmailSet: false,
    });
    expect(describeCredentialSources({}, "linux")).toEqual({
      keychain: "not-macos",
      envPasswordSet: false,
      envEmailSet: false,
    });
  });
});
