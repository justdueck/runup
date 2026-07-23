/**
 * Package/privacy hygiene guards for the NeedleNine integration:
 * - playwright must only ever be imported lazily (dynamic import) or as
 *   types, so the server starts and lists tools without the package or a
 *   browser installed;
 * - no vendor secrets/constants (passphrases, tokens, third-party keys) and
 *   no decryption code may live in the source — we only ship route paths,
 *   DOM selectors, storage key names and payload field names.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("needlenine hygiene", () => {
  it("never statically imports playwright at module top level (lazy import only)", async () => {
    const files = await sourceFiles(path.join(ROOT, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        // Allowed: `import type ... from "playwright"`, `typeof import("playwright")`, `import("playwright")` inside functions.
        if (/^\s*import\s+(?!type\b)[^;]*from\s+["']playwright["']/.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships no vendor secrets, crypto passphrase code, or third-party keys in the provider source", async () => {
    const files = await sourceFiles(path.join(ROOT, "src", "providers", "needlenine"));
    const forbidden = [
      /SecurePassword/, // vendor passphrase config name — never reproduced
      /AES|CryptoJS|crypto\.subtle|createDecipheriv/, // no decryption code shipped
      /pk_live_|AIza[0-9A-Za-z_-]{20,}/, // third-party publishable/API keys
      /api_token"\s*:\s*"[^"]{8,}/, // hard-coded tokens
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)} matched ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
