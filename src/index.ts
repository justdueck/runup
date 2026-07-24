#!/usr/bin/env node
/**
 * Entry point: run the runup MCP server over stdio.
 *
 * stdout is reserved for the MCP protocol - everything else goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, defaultProviders, disposeProviders, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { profilePath } from "./profile.js";

async function main(): Promise<void> {
  const profileFile = profilePath();
  const providers = defaultProviders(profileFile);
  const server = createServer({ profilePath: profileFile, providers });
  const transport = new StdioServerTransport();

  // Close provider resources (the NeedleNine browser session, if one was
  // opened) whenever the host disconnects or the process is asked to stop,
  // so no chromium process outlives the server. A wedged browser must not
  // make the process unkillable: cap the dispose wait, and let a second
  // signal exit immediately.
  const DISPOSE_TIMEOUT_MS = 5_000;
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(code), DISPOSE_TIMEOUT_MS);
    void disposeProviders(providers).finally(() => {
      clearTimeout(deadline);
      process.exit(code);
    });
  };
  // stdin emits BOTH "end" and "close" on a normal host disconnect, so stream
  // events must never take the force-exit path - only a repeated user signal
  // (e.g. double Ctrl+C) should exit before dispose finishes.
  const signalShutdown = (code: number): void => {
    if (shuttingDown) {
      process.exit(code);
    }
    shutdown(code);
  };
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.on("SIGINT", () => signalShutdown(0));
  process.on("SIGTERM", () => signalShutdown(0));
  process.on("SIGHUP", () => signalShutdown(0));

  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (profile: ${profileFile})`);
}

main().catch((err) => {
  // Full error (with stack) - this goes to the host's stderr log, not the model.
  console.error("fatal:", err);
  process.exit(1);
});
