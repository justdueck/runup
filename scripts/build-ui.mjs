#!/usr/bin/env node
/**
 * Build the MCP Apps View: bundle src/ui/profile-form.ts (which imports the
 * SDK's prebuilt browser bundle) and inline it into src/ui/profile-form.html,
 * producing a single self-contained dist/ui/profile-form.html.
 *
 * Views run in a sandboxed iframe with no origin to fetch from, so every
 * script/style must be inline (this is what vite-plugin-singlefile does in
 * the ext-apps examples; esbuild keeps the toolchain smaller here).
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(root, "src", "ui", "profile-form.html");
const entryPath = path.join(root, "src", "ui", "profile-form.ts");
const outDir = path.join(root, "dist", "ui");
const outFile = path.join(outDir, "profile-form.html");
const MARKER = "<!-- APP_SCRIPT -->";

const result = await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});

// Escape "</script" so the inline module cannot terminate its own tag.
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(templatePath, "utf8");
if (!template.includes(MARKER)) throw new Error(`marker ${MARKER} missing from ${templatePath}`);
const html = template.replace(MARKER, () => `<script type="module">\n${js}\n</script>`);

await mkdir(outDir, { recursive: true });
await writeFile(outFile, html, "utf8");
console.error(`[build-ui] wrote ${path.relative(root, outFile)} (${(html.length / 1024).toFixed(1)} KiB)`);
