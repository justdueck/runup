#!/usr/bin/env node
/**
 * Register this runup checkout as an MCP server in Claude Desktop.
 *
 * Usage (from the repo root, after `npm install`):
 *   npm run setup                                   # build + register
 *   npm run setup -- --ical-urls "https://...ics"   # also set the calendar feed
 *   npm run setup -- --runup-home /custom/.runup
 *   npm run setup -- --dry-run                      # show what would change
 *
 * What it does:
 *   - locates Claude Desktop's claude_desktop_config.json for this OS
 *     (override with the CLAUDE_DESKTOP_CONFIG env var),
 *   - merges a `runup` entry into `mcpServers` pointing at THIS checkout's
 *     dist/index.js, preserving other servers and everything already on the
 *     runup entry (env, custom fields) except what the flags override,
 *   - writes atomically, keeping one `.backup` of the previous file; a re-run
 *     that changes nothing leaves the file (and backup) untouched.
 *
 * It never prints the iCal URL back - that value is a bearer secret.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "dist", "index.js");

function fail(message) {
  console.error(`setup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { icalUrls: null, runupHome: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    // Accept both "--flag value" and "--flag=value".
    const eq = argv[i].indexOf("=");
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const value = () => {
      const v = eq === -1 ? argv[i + 1] : argv[i].slice(eq + 1);
      if (v === undefined || (eq === -1 && v.startsWith("--"))) fail(`${flag} needs a value`);
      if (eq === -1) i++;
      return v;
    };
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--ical-urls") args.icalUrls = value();
    else if (flag === "--runup-home") args.runupHome = value();
    else fail(`unknown option "${flag}" (supported: --ical-urls <url[,url]>, --runup-home <dir>, --dry-run)`);
  }
  return args;
}

function configPath() {
  if (process.env.CLAUDE_DESKTOP_CONFIG) return process.env.CLAUDE_DESKTOP_CONFIG;
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(serverEntry)) {
  fail(`dist/index.js not found - run "npm run build" first (or use "npm run setup", which builds for you).`);
}

const file = configPath();
let previous = null;
let config = {};
if (existsSync(file)) {
  previous = readFileSync(file, "utf8");
  if (previous.trim().length > 0) {
    try {
      config = JSON.parse(previous);
    } catch (err) {
      // Deliberately not echoing err.message: V8 quotes config text in it,
      // which could include the (secret) iCal URL.
      const at = /position (\d+)/.exec(err.message)?.[0] ?? "";
      fail(`${file} is not valid JSON${at ? ` (${at})` : ""} - fix or remove it, then re-run. Nothing was changed.`);
    }
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    fail(`${file} does not contain a JSON object - fix it, then re-run. Nothing was changed.`);
  }
}

if (config.mcpServers !== undefined && (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers))) {
  fail(`${file} has a non-object "mcpServers" - fix it, then re-run. Nothing was changed.`);
}

// Preserve everything already on the entry; override only what this script
// owns (command/args -> this checkout) and what the flags set. RUNUP_HOME is
// left to the server's own default (~/.runup) unless configured explicitly.
const existing = config.mcpServers?.runup ?? {};
const env = { ...(existing.env ?? {}) };
if (args.runupHome) env.RUNUP_HOME = path.resolve(args.runupHome);
if (args.icalUrls !== null) env.RUNUP_ICAL_URLS = args.icalUrls;

config.mcpServers = {
  ...(config.mcpServers ?? {}),
  // process.execPath: the absolute node binary running this script - GUI apps
  // like Claude Desktop often lack the shell PATH that finds a bare "node".
  runup: { ...existing, command: process.execPath, args: [serverEntry], env },
};

const otherServers = Object.keys(config.mcpServers).filter((name) => name !== "runup");
const hasIcal = typeof env.RUNUP_ICAL_URLS === "string" && env.RUNUP_ICAL_URLS.trim().length > 0;
const summary = [
  `  server:          ${process.execPath} ${serverEntry}`,
  `  RUNUP_HOME:      ${env.RUNUP_HOME ?? "(server default: ~/.runup)"}`,
  `  RUNUP_ICAL_URLS: ${hasIcal ? "(configured - value not shown; it is a secret)" : "(not set)"}`,
  ...(otherServers.length > 0 ? [`  preserved:       ${otherServers.join(", ")}`] : []),
];

const output = `${JSON.stringify(config, null, 2)}\n`;

if (args.dryRun) {
  console.log(previous === output ? `${file} is already up to date:` : `Would write ${file}:`);
  console.log(summary.join("\n"));
  process.exit(0);
}

if (previous === output) {
  console.log(`${file} is already up to date - nothing changed.`);
  console.log(summary.join("\n"));
  process.exit(0);
}

mkdirSync(path.dirname(file), { recursive: true });
if (previous !== null) {
  copyFileSync(file, `${file}.backup`); // one backup of the last version, overwritten each run
  console.log(`Backed up previous config to ${file}.backup`);
}
// Atomic write (temp + rename) so Claude Desktop never sees a partial file.
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, output, "utf8");
renameSync(tmp, file);

console.log(`Registered runup in ${file}`);
console.log(summary.join("\n"));
console.log("");
console.log("Next steps:");
console.log("  1. Fully quit and reopen Claude Desktop - the runup tools should appear.");
if (!hasIcal) {
  console.log("  2. Calendar: copy your Google Calendar \"secret address in iCal format\"");
  console.log('     (see README -> Calendar), then re-run: npm run setup -- --ical-urls "<url>"');
}
console.log(`  ${hasIcal ? "2" : "3"}. NeedleNine scheduler (optional): see README -> Aircraft availability (NeedleNine).`);
