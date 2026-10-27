import fs from "node:fs";
import path from "node:path";

/**
 * Resolve `rel` inside `base`, refusing absolute paths, `..` escapes, and symlinks that point outside.
 * Returns null when the path is not safe.
 */
export function safeJoin(base: string, rel: string): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const clean = rel.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
  if (clean.split("/").some((seg) => seg === "..")) return null;
  const baseReal = fs.existsSync(base) ? fs.realpathSync(base) : path.resolve(base);
  const full = path.resolve(baseReal, clean);
  if (!within(full, baseReal)) return null;
  // Resolve symlinks on the deepest existing ancestor.
  let probe = full;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (!within(real, baseReal)) return null;
  return full;
}

function within(p: string, base: string): boolean {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(base).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
