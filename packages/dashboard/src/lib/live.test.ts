import { describe, expect, it } from "vitest";
import { EventStore } from "./live";
import { parseHash } from "./router";
import type { BotssEvent } from "./types";

const ev = (id: number): BotssEvent => ({
  id,
  ts: "2026-10-27T10:00:00.000Z",
  type: "task.status",
  actor: null,
  role: null,
  task: "T001",
  run_id: null,
  summary: `e${id}`,
  data: {},
});

describe("EventStore", () => {
  it("appends in order, drops duplicates, and folds in an initial load that arrives late", () => {
    const s = new EventStore();
    let notified = 0;
    s.subscribe(() => notified++);
    s.add([ev(5), ev(6)]);
    s.add([ev(6), ev(7)]);
    expect(s.events.map((e) => e.id)).toEqual([5, 6, 7]);
    // The HTTP backfill (older events) lands after the first WebSocket batch.
    s.add([ev(1), ev(2), ev(5)], true);
    expect(s.events.map((e) => e.id)).toEqual([1, 2, 5, 6, 7]);
    expect(s.loaded).toBe(true);
    expect(s.lastId).toBe(7);
    expect(notified).toBeGreaterThanOrEqual(3);
    expect(s.snapshot().events).toBe(s.events);
  });
});

describe("parseHash", () => {
  it("parses project routes, nested doc names, and the projects page", () => {
    expect(parseHash("#/")).toMatchObject({ pid: null, screen: "projects" });
    expect(parseHash("#/p/abc123/board/T001")).toMatchObject({
      pid: "abc123",
      screen: "board",
      rest: ["T001"],
    });
    expect(parseHash("#/p/abc123/docs/contracts/openapi.yaml")).toMatchObject({
      screen: "docs",
      rest: ["contracts", "openapi.yaml"],
    });
    expect(parseHash("#/p/abc123")).toMatchObject({ pid: "abc123", screen: "" });
  });
});
