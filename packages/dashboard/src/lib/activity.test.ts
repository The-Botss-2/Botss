import { describe, expect, it } from "vitest";
import { deriveInsight, stageOf, todoProgress } from "./activity";
import type { BotssEvent, Task } from "./types";

let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}, summary = ""): BotssEvent => ({
  id: ++n,
  ts: "2026-10-28T10:00:00.000Z",
  type,
  actor: "backend-1",
  role: "backend",
  task: "T001",
  run_id: "R-00001",
  summary,
  data,
});

describe("deriveInsight", () => {
  it("builds status, plan, files and human moments from run events", () => {
    const i = deriveInsight(
      [
        ev("run.tool", { tool: "TodoWrite", input: { todos: [{ content: "Write orders.py", status: "completed" }, { content: "Run tests", status: "in_progress", activeForm: "Running the tests" }] } }),
        ev("run.tool", { tool: "Write", file: "orders.py", activity: "writing", label: "Writing orders.py" }),
        ev("run.tool", { tool: "Bash", activity: "testing", label: "Running the tests" }),
        ev("run.result", { isError: false, text: "3 passed" }),
      ],
      null,
    );
    expect(i.label).toBe("Running the tests");
    expect(i.activity).toBe("testing");
    expect(todoProgress(i.todos)).toMatchObject({ done: 1, total: 2, current: { activeForm: "Running the tests" } });
    expect(i.files).toEqual([{ path: "orders.py", wrote: true }]);
    expect(i.moments.map((m) => m.text)).toEqual(["Tests passed ✓", "Running the tests", "Wrote orders.py"]);
  });

  it("maps task status to the stage track", () => {
    expect(stageOf({ status: "in_progress" } as Task)).toBe(0);
    expect(stageOf({ status: "review" } as Task)).toBe(1);
    expect(stageOf({ status: "qa" } as Task)).toBe(2);
    expect(stageOf({ status: "done" } as Task)).toBe(3);
  });
});
