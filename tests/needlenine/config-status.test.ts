import { describe, expect, it } from "vitest";
import { defaultProfile, validateProfile, applyProfilePatch, type ProfileValidationError } from "../../src/profile.js";
import { resolveSchedulerConfig } from "../../src/providers/needlenine/config.js";
import { schedulerStatus } from "../../src/providers/needlenine/status.js";
import { ENV_EMAIL, ENV_PASSWORD } from "../../src/providers/needlenine/credentials.js";
import { DEFAULT_PORTAL_URL } from "../../src/providers/needlenine/site.js";

function profileWithScheduler(extra: Record<string, unknown> = {}) {
  return validateProfile({
    ...defaultProfile(),
    scheduler: { provider: "needlenine", email: "pilot@example.com", ...extra },
  });
}

describe("scheduler config resolution", () => {
  it("is null (not configured) by default", () => {
    expect(resolveSchedulerConfig(defaultProfile(), {})).toBeNull();
    expect(resolveSchedulerConfig(validateProfile({ ...defaultProfile(), scheduler: null }), {})).toBeNull();
  });

  it("comes from the profile block with sensible defaults", () => {
    expect(resolveSchedulerConfig(profileWithScheduler(), {})).toEqual({
      provider: "needlenine",
      email: "pilot@example.com",
      portalUrl: DEFAULT_PORTAL_URL,
      timezone: "America/Los_Angeles",
      origin: "profile",
    });
    const custom = resolveSchedulerConfig(
      profileWithScheduler({ portalUrl: "https://beta.needlenine.com/", timezone: "America/Denver", tenantId: "t-1" }),
      {},
    );
    expect(custom).toMatchObject({ portalUrl: "https://beta.needlenine.com/", timezone: "America/Denver", tenantId: "t-1" });
  });

  it("lets the trusted env portal override win over the chat-writable profile value", () => {
    const cfg = resolveSchedulerConfig(profileWithScheduler({ portalUrl: "https://beta.needlenine.com/" }), {
      RUNUP_NEEDLENINE_PORTAL_URL: "https://mock.internal.test/",
    });
    expect(cfg?.portalUrl).toBe("https://mock.internal.test/");
  });

  it("can be enabled from the environment alone", () => {
    const cfg = resolveSchedulerConfig(defaultProfile(), { [ENV_EMAIL]: "env@example.com" });
    expect(cfg).toMatchObject({ email: "env@example.com", origin: "env", portalUrl: DEFAULT_PORTAL_URL });
    expect(resolveSchedulerConfig(defaultProfile(), { [ENV_EMAIL]: "   " })).toBeNull();
  });

  it("validates the profile block (email format, unknown providers rejected)", () => {
    expect(() => validateProfile({ ...defaultProfile(), scheduler: { provider: "needlenine", email: "not-an-email" } })).toThrow(
      /validation/,
    );
    expect(() => validateProfile({ ...defaultProfile(), scheduler: { provider: "other-scheduler", email: "a@b.test" } })).toThrow();
  });

  it("rejects portal URLs off needlenine.com so a profile patch cannot redirect the login (and password)", () => {
    const withPortal = (portalUrl: string) =>
      validateProfile({ ...defaultProfile(), scheduler: { provider: "needlenine", email: "a@b.test", portalUrl } });
    const expectRejected = (portalUrl: string) => {
      let issues = "";
      try {
        withPortal(portalUrl);
      } catch (err) {
        issues = String((err as ProfileValidationError).issues);
      }
      expect(issues, `portalUrl ${portalUrl} should be rejected`).toMatch(/needlenine\.com/);
    };
    expectRejected("https://evil.example.com/");
    expectRejected("https://portal.needlenine.com.evil.example/");
    expectRejected("https://evilneedlenine.com/");
    expectRejected("http://portal.needlenine.com/"); // https only
    expect(withPortal("https://portal.needlenine.com/").scheduler?.portalUrl).toBe("https://portal.needlenine.com/");
    expect(withPortal("https://beta.needlenine.com/").scheduler?.portalUrl).toBe("https://beta.needlenine.com/");
  });

  it("supports adding and clearing the block through profile patches", () => {
    const added = applyProfilePatch(defaultProfile(), { scheduler: { provider: "needlenine", email: "a@b.test" } });
    expect(added.scheduler?.email).toBe("a@b.test");
    const cleared = applyProfilePatch(added, { scheduler: null });
    expect(cleared.scheduler ?? null).toBeNull();
    expect(resolveSchedulerConfig(cleared, {})).toBeNull();
  });
});

describe("schedulerStatus (secret-free)", () => {
  const probeInstalled = async () => ({ installed: true, chromiumPath: "/definitely/missing/chrome" });
  const probeMissing = async () => ({ installed: false, chromiumPath: null });

  it("reports not-configured with setup steps", async () => {
    const status = await schedulerStatus(defaultProfile(), { env: {}, platform: "darwin", probeBrowser: probeInstalled });
    expect(status.configured).toBe(false);
    expect(status.email).toBeNull();
    expect(status.notes.join("\n")).toMatch(/update_profile/);
    expect(status.notes.join("\n")).toMatch(/security add-generic-password/);
    expect(status.credentials.keychain).toBe("available");
    expect(status.browser.playwrightInstalled).toBe(true);
    expect(status.browser.chromiumFound).toBe(false);
    expect(status.notes.join("\n")).toMatch(/playwright install chromium/);
  });

  it("reports the configured account without ever including secret values", async () => {
    const env = { [ENV_PASSWORD]: "s3cr3t-value", RUNUP_CHROMIUM_PATH: "/opt/nowhere/chrome" };
    const status = await schedulerStatus(profileWithScheduler(), { env, platform: "linux", probeBrowser: probeInstalled });
    expect(status.configured).toBe(true);
    expect(status.configuredVia).toBe("profile");
    expect(status.email).toBe("pilot@example.com");
    expect(status.credentials.keychain).toBe("not-macos");
    expect(status.credentials.envPasswordSet).toBe(true);
    expect(status.browser.executablePathOverride).toBe("/opt/nowhere/chrome");
    const text = JSON.stringify(status);
    expect(text).not.toContain("s3cr3t-value");
    expect(text).toContain(ENV_PASSWORD); // variable *name* is fine
  });

  it("notes a missing playwright install", async () => {
    const status = await schedulerStatus(defaultProfile(), { env: {}, platform: "linux", probeBrowser: probeMissing });
    expect(status.browser).toEqual({
      playwrightInstalled: false,
      chromiumPath: null,
      chromiumFound: false,
      executablePathOverride: null,
    });
    expect(status.notes.join("\n")).toMatch(/npm install/);
  });
});
