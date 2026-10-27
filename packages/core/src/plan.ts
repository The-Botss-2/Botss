import YAML from "yaml";
import { globsOverlap } from "./globs.ts";
import { isRole, type PlanProblem, type Role, type TaskSpec } from "./types.ts";

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const data = YAML.parse(m[1]!) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return { data: data as Record<string, unknown>, body: m[2] ?? "" };
}

function strList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

export interface ParsedTask {
  task?: TaskSpec;
  problems: PlanProblem[];
}

/** Parse one task file. Problems are reported rather than thrown so the whole plan can be checked at once. */
export function parseTaskFile(source: string, file?: string): ParsedTask {
  const label = file ?? "task file";
  let fm: ReturnType<typeof splitFrontmatter>;
  try {
    fm = splitFrontmatter(source);
  } catch (e) {
    return { problems: [{ code: "parse", tasks: [], message: `${label}: invalid YAML frontmatter (${(e as Error).message})` }] };
  }
  if (!fm) return { problems: [{ code: "parse", tasks: [], message: `${label}: missing --- frontmatter ---` }] };
  const d = fm.data;
  const id = d.id === undefined ? "" : String(d.id);
  const problems: PlanProblem[] = [];
  const ref = id ? [id] : [];
  for (const field of ["id", "title", "role", "owns", "verify"]) {
    const v = d[field];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) problems.push({ code: "missing_field", tasks: ref, message: `${id || label}: required field "${field}" is missing` });
  }
  let role = d.role;
  if (Array.isArray(role)) {
    problems.push({ code: "role", tasks: ref, message: `${id}: a task has exactly one role, got [${role.join(", ")}]` });
    role = role[0];
  } else if (role !== undefined && (typeof role !== "string" || !isRole(role))) {
    problems.push({ code: "role", tasks: ref, message: `${id}: unknown role "${String(role)}"` });
  }
  const size = String(d.size ?? "M").toUpperCase();
  if (problems.length > 0) return { problems };
  return {
    problems,
    task: {
      id,
      title: String(d.title),
      role: role as Role,
      story: d.story === undefined ? undefined : String(d.story),
      covers: strList(d.covers),
      after: strList(d.after),
      owns: strList(d.owns),
      may_touch: strList(d.may_touch),
      verify: String(d.verify),
      size: size === "S" || size === "L" ? size : "M",
      body: fm.body.trim(),
      source,
      file,
    },
  };
}

/** For every task, the set of tasks it transitively depends on. Assumes no cycles (cycles are ignored safely). */
export function ancestors(tasks: Pick<TaskSpec, "id" | "after">[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue;
      out.add(dep);
      for (const x of visit(dep, stack)) out.add(x);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const t of tasks) visit(t.id, new Set());
  return memo;
}

export function findCycles(tasks: Pick<TaskSpec, "id" | "after">[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const path: string[] = [];
  const dfs = (id: string) => {
    color.set(id, 1);
    path.push(id);
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue;
      const c = color.get(dep) ?? 0;
      if (c === 0) dfs(dep);
      else if (c === 1) {
        const cyc = path.slice(path.indexOf(dep));
        const key = [...cyc].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cyc, dep]);
        }
      }
    }
    path.pop();
    color.set(id, 2);
  };
  for (const t of tasks) if ((color.get(t.id) ?? 0) === 0) dfs(t.id);
  return cycles;
}

export interface PlanCheckResult {
  ok: boolean;
  tasks: TaskSpec[];
  problems: PlanProblem[];
}

export function checkPlan(files: { file: string; source: string }[], repoFiles: string[] = []): PlanCheckResult {
  const problems: PlanProblem[] = [];
  const tasks: TaskSpec[] = [];
  for (const f of files) {
    const r = parseTaskFile(f.source, f.file);
    problems.push(...r.problems);
    if (r.task) tasks.push(r.task);
  }
  const ids = new Map<string, number>();
  for (const t of tasks) ids.set(t.id, (ids.get(t.id) ?? 0) + 1);
  for (const [id, n] of ids) {
    if (n > 1) problems.push({ code: "duplicate_id", tasks: [id], message: `${id}: defined in ${n} task files` });
  }
  for (const t of tasks) {
    for (const dep of t.after) {
      if (!ids.has(dep)) problems.push({ code: "unknown_after", tasks: [t.id, dep], message: `${t.id}: after lists unknown task ${dep}` });
    }
  }
  for (const cyc of findCycles(tasks)) {
    problems.push({ code: "cycle", tasks: [...new Set(cyc)], message: `dependency cycle: ${cyc.join(" -> ")}` });
  }
  problems.push(...findCollisions(tasks, repoFiles));
  return { ok: problems.length === 0, tasks, problems };
}

/** Two tasks with no dependency path between them must not own overlapping files. */
export function findCollisions(tasks: Pick<TaskSpec, "id" | "after" | "owns">[], repoFiles: string[] = []): PlanProblem[] {
  const anc = ancestors(tasks);
  const out: PlanProblem[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (a.id === b.id) continue;
      if (anc.get(a.id)?.has(b.id) || anc.get(b.id)?.has(a.id)) continue;
      for (const ga of a.owns) {
        const hit = b.owns.map((gb) => ({ gb, r: globsOverlap(ga, gb, repoFiles) })).find((x) => x.r.overlap);
        if (hit) {
          out.push({
            code: "collision",
            tasks: [a.id, b.id],
            message: `${a.id} and ${b.id} can run in parallel but both own overlapping paths: "${ga}" and "${hit.gb}" (${hit.r.reason}). Add an "after" between them or merge them.`,
          });
          break;
        }
      }
    }
  }
  return out;
}

const SIZE_WEIGHT = { S: 1, M: 2, L: 3 } as const;

export interface PlanStats {
  criticalPath: string[];
  criticalLength: number;
  peakLanes: number;
  byRole: Record<string, number>;
  /** Peak concurrent tasks per role in an unconstrained schedule. Useful as a team-size ceiling. */
  peakByRole: Record<string, number>;
}

/** Critical path (by size weight) and peak parallelism of an as-soon-as-possible schedule. */
export function planStats(tasks: Pick<TaskSpec, "id" | "after" | "size" | "role">[]): PlanStats {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const finish = new Map<string, { end: number; prev?: string }>();
  const visiting = new Set<string>();
  const calc = (id: string): { end: number; prev?: string } => {
    const done = finish.get(id);
    if (done) return done;
    const t = byId.get(id)!;
    if (visiting.has(id)) return { end: 0 };
    visiting.add(id);
    let start = 0;
    let prev: string | undefined;
    for (const d of t.after) {
      if (!byId.has(d)) continue;
      const f = calc(d);
      if (f.end > start) {
        start = f.end;
        prev = d;
      }
    }
    visiting.delete(id);
    const r = { end: start + SIZE_WEIGHT[t.size], prev };
    finish.set(id, r);
    return r;
  };
  let last: string | undefined;
  let best = 0;
  for (const t of tasks) {
    const f = calc(t.id);
    if (f.end > best) {
      best = f.end;
      last = t.id;
    }
  }
  const criticalPath: string[] = [];
  for (let cur = last; cur; cur = finish.get(cur)?.prev) criticalPath.unshift(cur);

  const byRole: Record<string, number> = {};
  for (const t of tasks) byRole[t.role] = (byRole[t.role] ?? 0) + 1;

  // Sweep over the intervals [end - weight, end).
  const points: { at: number; delta: number; role: string }[] = [];
  for (const t of tasks) {
    const end = finish.get(t.id)!.end;
    points.push({ at: end - SIZE_WEIGHT[t.size], delta: 1, role: t.role }, { at: end, delta: -1, role: t.role });
  }
  points.sort((x, y) => x.at - y.at || x.delta - y.delta);
  let cur = 0;
  let peak = 0;
  const curRole: Record<string, number> = {};
  const peakByRole: Record<string, number> = {};
  for (const p of points) {
    cur += p.delta;
    curRole[p.role] = (curRole[p.role] ?? 0) + p.delta;
    peak = Math.max(peak, cur);
    peakByRole[p.role] = Math.max(peakByRole[p.role] ?? 0, curRole[p.role]!);
  }
  return { criticalPath, criticalLength: best, peakLanes: peak, byRole, peakByRole };
}
