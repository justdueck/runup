#!/usr/bin/env node
/**
 * Entry point: run the runup MCP server over stdio.
 *
 * stdout is reserved for the MCP protocol - everything else goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { profilePath } from "./profile.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (profile: ${profilePath()})`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
