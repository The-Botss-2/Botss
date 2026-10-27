import { describe, expect, it } from "vitest";
import type { BotssEvent } from "../lib/types";
import { eventsToItems } from "./LiveTranscript";

let n = 0;
const ev = (type: string, summary: string, data: Record<string, unknown> = {}): BotssEvent => ({
  id: ++n,
  ts: "2026-10-27T10:00:00.000Z",
  type,
  actor: "backend-1",
  role: "backend",
  task: "T001",
  run_id: "R-00001",
  summary,
  data,
});

describe("eventsToItems", () => {
  it("pairs results with their tool calls by toolUseId, keeps Edit inputs, and flags guard blocks", () => {
    const items = eventsToItems([
      ev("run.text", "Plan…", { text: "Plan: edit the handler, then run tests." }),
      ev("run.tool", "Editing `src/a.ts`", { tool: "Edit", file: "src/a.ts", input: { old_string: "a", new_string: "b" }, toolUseId: "t1" }),
      ev("run.tool", "Running `pnpm test`", { tool: "Bash", input: { command: "pnpm test" }, toolUseId: "t2" }),
      ev("run.result", "ok", { toolUseId: "t1", isError: false, text: "edited" }),
      ev("run.result", "✗ Botss guard", { toolUseId: "t2", isError: true, text: "Botss guard: blocked" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["text", "tool", "tool"]);
    expect(items[0]!.text).toContain("run tests");
    expect(items[1]!.input).toEqual({ old_string: "a", new_string: "b" });
    expect(items[1]!.results?.map((r) => r.text)).toEqual(["edited"]);
    expect(items[2]!.results?.[0]).toMatchObject({ isError: true, text: "Botss guard: blocked" });
  });
});
