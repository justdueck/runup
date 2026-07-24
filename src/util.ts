/** Small helpers shared across the server. */
import { promises as fs } from "node:fs";
import path from "node:path";

/** Round to 1 decimal place (normalizes -0 to 0). */
export function round1(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** Round to 2 decimal places (normalizes -0 to 0). */
export function round2(n: number): number {
  const rounded = Math.round(n * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** Monotonic per-process counter so overlapping writes never share a temp filename. */
let tmpCounter = 0;

/**
 * Atomic file write: contents go to a unique temp file in the target
 * directory (created if missing), then rename over `filePath` so readers
 * never see a partial write.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  tmpCounter += 1;
  const tmp = `${filePath}.tmp-${process.pid}-${tmpCounter}`;
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
