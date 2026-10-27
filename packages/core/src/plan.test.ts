import { describe, expect, it } from "vitest";
import { checkPlan, findCycles, parseTaskFile, planStats } from "./plan.ts";

function task(id: string, fields: Record<string, unknown> = {}): { file: string; source: string } {
  const f = {
    title: `Task ${id}`,
    role: "backend",
    after: [],
    owns: [`backend/${id}/**`],
    verify: "true",
    size: "M",
    ...fields,
  };
  const yaml = [`id: ${id}`, ...Object.entries(f).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)].join("\n");
  return { file: `.botss/tasks/${id}.md`, source: `---\n${yaml}\n---\n\n## Goal\nDo ${id}.\n` };
}

describe("parseTaskFile", () => {
  it("parses the template shape", () => {
    const r = parseTaskFile(task("T012", { after: ["T004"], may_touch: ["backend/app/api/router.py"], covers: ["FR-4"] }).source);
    expect(r.problems).toEqual([]);
    expect(r.task).toMatchObject({ id: "T012", role: "backend", after: ["T004"], covers: ["FR-4"], size: "M" });
    expect(r.task!.body).toContain("## Goal");
  });

  it("reports missing fields with the task id", () => {
    const r = parseTaskFile("---\nid: T009\ntitle: x\n---\nbody");
    expect(r.task).toBeUndefined();
    expect(r.problems.map((p) => p.message)).toEqual([
      'T009: required field "role" is missing',
      'T009: required field "owns" is missing',
      'T009: required field "verify" is missing',
    ]);
  });

  it("rejects more than one role", () => {
    const r = parseTaskFile(task("T003", { role: ["backend", "frontend"] }).source);
    expect(r.problems[0]).toMatchObject({ code: "role", tasks: ["T003"] });
  });

  it("rejects files without frontmatter", () => {
    expect(parseTaskFile("# just markdown", "x.md").problems[0]!.code).toBe("parse");
  });
});

describe("checkPlan", () => {
  it("accepts a valid plan", () => {
    const r = checkPlan([
      task("T000", { role: "tech-lead", owns: ["backend/app/main.py", "frontend/package.json"] }),
      task("T001", { role: "devops", after: ["T000"], owns: ["docker-compose.yml"] }),
      task("T002", { after: ["T001"] }),
      task("T003", { role: "frontend", after: ["T001"], owns: ["frontend/src/app/orders/**"] }),
    ]);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("finds unknown after IDs", () => {
    const r = checkPlan([task("T001", { after: ["T999"] })]);
    expect(r.problems).toEqual([{ code: "unknown_after", tasks: ["T001", "T999"], message: "T001: after lists unknown task T999" }]);
  });

  it("finds cycles", () => {
    const r = checkPlan([task("T001", { after: ["T003"] }), task("T002", { after: ["T001"] }), task("T003", { after: ["T002"] })]);
    const cyc = r.problems.filter((p) => p.code === "cycle");
    expect(cyc).toHaveLength(1);
    expect(cyc[0]!.tasks.sort()).toEqual(["T001", "T002", "T003"]);
    expect(cyc[0]!.message).toMatch(/dependency cycle: T00\d -> T00\d -> T00\d -> T00\d/);
  });

  it("finds ownership collisions between parallel tasks only", () => {
    const r = checkPlan([
      task("T001", { owns: ["backend/app/**"] }),
      task("T002", { owns: ["backend/app/api/orders.py"] }),
      task("T003", { after: ["T001"], owns: ["backend/app/models/**"] }),
    ]);
    const col = r.problems.filter((p) => p.code === "collision").map((p) => p.tasks);
    // T001/T002 parallel and overlapping; T003 is ordered after T001 but parallel to T002 with disjoint paths.
    expect(col).toEqual([["T001", "T002"]]);
    expect(r.ok).toBe(false);
  });

  it("finds duplicate ids", () => {
    const r = checkPlan([task("T001"), task("T001")]);
    expect(r.problems.some((p) => p.code === "duplicate_id")).toBe(true);
  });
});

describe("findCycles", () => {
  it("finds a self loop", () => {
    expect(findCycles([{ id: "A", after: ["A"] }])).toEqual([["A", "A"]]);
  });
});

describe("planStats", () => {
  it("computes the critical path and peak lanes", () => {
    const s = planStats([
      { id: "T000", after: [], size: "M", role: "tech-lead" },
      { id: "T001", after: ["T000"], size: "S", role: "devops" },
      { id: "T002", after: ["T001"], size: "M", role: "backend" },
      { id: "T003", after: ["T001"], size: "M", role: "frontend" },
      { id: "T004", after: ["T002"], size: "L", role: "backend" },
      { id: "T005", after: ["T003"], size: "S", role: "frontend" },
    ]);
    expect(s.criticalPath).toEqual(["T000", "T001", "T002", "T004"]);
    expect(s.criticalLength).toBe(8);
    expect(s.peakLanes).toBe(2);
    expect(s.byRole).toEqual({ "tech-lead": 1, devops: 1, backend: 2, frontend: 2 });
  });
});
