import picomatch from "picomatch";

// Conservative ownership-overlap test. A false positive only adds an ordering to the plan; a false negative
// lets two parallel agents edit the same file and causes a merge conflict. So: report an overlap unless the
// two patterns are provably disjoint.

const GLOB_CHARS = /[*?[\]{}!()]/;

export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.slice(1);
  if (s.endsWith("/")) s = `${s}**`;
  return s;
}

export function isGlob(p: string): boolean {
  return GLOB_CHARS.test(p);
}

/** Literal directory prefix of a glob: the segments before the first one containing glob characters. */
export function literalBase(glob: string): string {
  const segs = normalizePath(glob).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (isGlob(s)) break;
    out.push(s);
  }
  return out.join("/");
}

function isAncestorOrSame(dir: string, path: string): boolean {
  if (dir === "") return true;
  return path === dir || path.startsWith(`${dir}/`);
}

const matcherCache = new Map<string, (p: string) => boolean>();
export function globMatcher(glob: string): (p: string) => boolean {
  const g = normalizePath(glob);
  let m = matcherCache.get(g);
  if (!m) {
    if (isGlob(g)) {
      m = picomatch(g, { dot: true });
    } else {
      // A literal path owns itself and, if it is a directory, everything under it.
      m = (p: string) => p === g || p.startsWith(`${g}/`);
    }
    matcherCache.set(g, m);
  }
  return m;
}

export function matchesAny(globs: string[], path: string): boolean {
  const p = normalizePath(path);
  return globs.some((g) => globMatcher(g)(p));
}

type Tail = { kind: "ext"; ext: string } | { kind: "name"; name: string } | { kind: "unknown" };

function tailOf(glob: string): Tail {
  const segs = normalizePath(glob).split("/");
  const last = segs[segs.length - 1] ?? "";
  if (last === "**" || last === "*") return { kind: "unknown" };
  const ext = /^\*\.([A-Za-z0-9_-]+)$/.exec(last);
  if (ext) return { kind: "ext", ext: ext[1]!.toLowerCase() };
  if (!isGlob(last)) return { kind: "name", name: last };
  return { kind: "unknown" };
}

function tailsDisjoint(a: Tail, b: Tail): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return false;
  if (a.kind === "ext" && b.kind === "ext") return a.ext !== b.ext;
  if (a.kind === "name" && b.kind === "name") return a.name !== b.name;
  const name = a.kind === "name" ? a.name : (b as { name: string }).name;
  const ext = a.kind === "ext" ? a.ext : (b as { ext: string }).ext;
  return !name.toLowerCase().endsWith(`.${ext}`);
}

/** A literal path whose last segment has an extension is treated as a file, otherwise as a directory. */
function looksLikeFile(literal: string): boolean {
  const last = literal.split("/").pop() ?? "";
  return /\.[A-Za-z0-9_-]+$/.test(last) || /^[A-Z][A-Za-z]*file$/.test(last) || last === "Dockerfile";
}

export interface OverlapResult {
  overlap: boolean;
  reason: string;
}

export function globsOverlap(a0: string, b0: string, repoFiles: string[] = []): OverlapResult {
  const a = normalizePath(a0);
  const b = normalizePath(b0);
  const ma = globMatcher(a);
  const mb = globMatcher(b);

  const shared = repoFiles.find((f) => {
    const p = normalizePath(f);
    return ma(p) && mb(p);
  });
  if (shared) return { overlap: true, reason: `both match existing file ${shared}` };

  if (a === b) return { overlap: true, reason: "identical patterns" };

  const aLit = !isGlob(a);
  const bLit = !isGlob(b);
  if (aLit && bLit) {
    if (isAncestorOrSame(a, b) || isAncestorOrSame(b, a)) return { overlap: true, reason: "same path or nested" };
    return { overlap: false, reason: "different literal paths" };
  }
  if (aLit || bLit) {
    const lit = aLit ? a : b;
    const glob = aLit ? b : a;
    const mg = aLit ? mb : ma;
    if (mg(lit)) return { overlap: true, reason: `${glob} matches ${lit}` };
    if (looksLikeFile(lit)) return { overlap: false, reason: `${glob} cannot match file ${lit}` };
    // A literal directory owns everything below it: compare as `dir/**`.
    return globsOverlap(`${lit}/**`, glob, []);
  }

  const baseA = literalBase(a);
  const baseB = literalBase(b);
  if (!isAncestorOrSame(baseA, baseB) && !isAncestorOrSame(baseB, baseA)) {
    return { overlap: false, reason: "disjoint base directories" };
  }
  if (tailsDisjoint(tailOf(a), tailOf(b))) return { overlap: false, reason: "different fixed file names or extensions" };
  return { overlap: true, reason: `base directory ${baseA || "(root)"} / ${baseB || "(root)"} may overlap` };
}
