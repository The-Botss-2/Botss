import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Empty, PageHeader, Skeleton } from "../components/ui";
import { useEvents } from "../lib/live";
import { fmtTime } from "../lib/format";
import { ROLE_CODES, roleColor, roleOf } from "../lib/roles";
import { href, navigate } from "../lib/router";
import { ROLES, type BotssEvent } from "../lib/types";

// Glyph + tone per event type. Typographic glyphs (no emoji) so the feed reads like an engineering log.
const GLYPHS: [RegExp, string, string, string][] = [
  [/^merge\.ok/, "⊕", "var(--ok)", "merged"],
  [/^merge\./, "⊗", "var(--danger)", "merge problem"],
  [/^qa\.pass/, "✓", "var(--ok)", "QA passed"],
  [/^qa\.fail/, "✗", "var(--danger)", "QA failed"],
  [/^bug\./, "✗", "var(--danger)", "bug"],
  [/^review\.verdict/, "◎", "var(--role-reviewer)", "review verdict"],
  [/^review\./, "✎", "var(--role-reviewer)", "review comment"],
  [/^guard\.|^run\.blocked/, "⊘", "var(--danger)", "guard blocked"],
  [/^checks\.failed/, "✗", "var(--danger)", "checks failed"],
  [/^phase\./, "§", "var(--ink)", "phase change"],
  [/^decision\./, "◆", "var(--accent)", "decision"],
  [/^ask\./, "?", "var(--warn)", "question"],
  [/^answer\./, "↩", "var(--ok)", "answer"],
  [/^msg\./, "→", "var(--ink-2)", "message"],
  [/^progress\./, "¶", "var(--ink)", "progress note"],
  [/^handoff\./, "⇥", "var(--ink)", "handoff"],
  [/^task\.created/, "+", "var(--ink-3)", "task created"],
  [/^task\.status/, "▸", "var(--ink-2)", "status change"],
  [/^task\./, "▪", "var(--ink-2)", "task"],
  [/^run\.started/, "▶", "var(--ink-2)", "run started"],
  [/^run\.(ended|finished|done)/, "■", "var(--ink-3)", "run ended"],
  [/^run\.tool/, "·", "var(--ink-3)", "tool call"],
  [/^run\.text/, "“", "var(--ink-3)", "agent text"],
  [/^run\./, "○", "var(--ink-3)", "run"],
  [/^doc\./, "≡", "var(--accent)", "document"],
  [/^quota\./, "%", "var(--warn)", "quota"],
  [/^alert\./, "!", "var(--warn)", "alert"],
  [/^plan\./, "⌗", "var(--role-tech-lead)", "plan"],
  [/^project\.killed/, "■", "var(--danger)", "kill switch"],
  [/^project\./, "■", "var(--ink-2)", "project"],
  [/^idea\./, "✦", "var(--ink)", "idea"],
  [/^design\./, "◐", "var(--role-designer)", "design"],
  [/^agent\./, "○", "var(--ink-2)", "agent"],
];

export function glyphFor(type: string): { g: string; color: string; label: string } {
  for (const [re, g, color, label] of GLYPHS) if (re.test(type)) return { g, color, label };
  return { g: "·", color: "var(--ink-3)", label: type };
}

export function Glyph({ type, summary }: { type: string; summary?: string }) {
  // Direct workspace: merge.ok means "finished: N files changed", not a git merge.
  const finished = type === "merge.ok" && summary !== undefined && / finished/.test(summary);
  const { g, color, label } = finished ? { g: "✓", color: "var(--ok)", label: "finished" } : glyphFor(type);
  return (
    <span
      className="mono inline-block w-4 text-center text-[12px] font-semibold"
      style={{ color }}
      title={label}
      aria-label={label}
    >
      {g}
    </span>
  );
}

const CHATTER = new Set(["run.tool", "run.text", "run.init", "run.retry", "run.result"]);
const ROW = 30;

function isImportant(e: BotssEvent): boolean {
  return /^(merge\.|phase\.|qa\.|review\.verdict|guard\.|bug\.|project\.killed|decision\.|checks\.failed|alert\.)/.test(
    e.type,
  );
}

export function FeedScreen({ pid }: { pid: string }) {
  const { events, loaded } = useEvents(pid);
  const [hideChatter, setHideChatter] = useState(true);
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [task, setTask] = useState("");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);

  const tasks = useMemo(
    () =>
      [...new Set(events.map((e) => e.task).filter(Boolean) as string[])].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    [events],
  );
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return events.filter(
      (e) =>
        (!hideChatter || !CHATTER.has(e.type)) &&
        (!roles.size || roles.has(roleOf(e.role ?? e.actor))) &&
        (!task || e.task === task) &&
        (!s || e.summary.toLowerCase().includes(s) || (e.actor ?? "").includes(s)),
    );
  }, [events, hideChatter, roles, task, search]);

  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  });

  // Follow the tail while the reader is at the bottom.
  useEffect(() => {
    if (follow && filtered.length) v.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [filtered.length, follow, v]);

  const toggleRole = (r: string) =>
    setRoles((cur) => {
      const n = new Set(cur);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[480px] flex-col">
      <PageHeader title="Team feed" kicker="everything the team does, as it happens">
        <span className="mono text-[11.5px] text-ink-3" data-testid="feed-count">
          {filtered.length.toLocaleString()} of {events.length.toLocaleString()} events
        </span>
      </PageHeader>

      <div className="mb-2 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Feed filters">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by role">
          {[...ROLES, "human"].map((r) => {
            const on = roles.has(r);
            return (
              <button
                key={r}
                aria-pressed={on}
                onClick={() => toggleRole(r)}
                className="mono h-6 border px-1.5 text-[11px] font-medium"
                style={{
                  color: on ? "var(--paper)" : roleColor(r),
                  background: on ? roleColor(r) : "transparent",
                  borderColor: `color-mix(in srgb, ${roleColor(r)} 50%, transparent)`,
                }}
                title={`Only ${r}`}
              >
                {ROLE_CODES[r] ?? r}
              </button>
            );
          })}
        </div>
        <select
          className="field mono w-auto py-0.5 text-[12px]"
          aria-label="Filter by task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        >
          <option value="">all tasks</option>
          {tasks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="field w-48 py-0.5 text-[12px]"
          type="search"
          placeholder="search…"
          aria-label="Search the feed"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
          <input
            type="checkbox"
            checked={hideChatter}
            onChange={(e) => setHideChatter(e.target.checked)}
            data-testid="hide-chatter"
          />
          Hide tool chatter
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>

      {!loaded && !events.length ? (
        <Skeleton rows={12} />
      ) : !filtered.length ? (
        <Empty title={events.length ? "No events match these filters" : "The team has not started yet"}>
          {events.length
            ? "Clear the role or task filter, or show tool chatter."
            : "Submit an idea or approve the plan; every message, decision, review and merge streams in here."}
        </Empty>
      ) : (
        <div
          ref={parentRef}
          className="relative min-h-0 flex-1 overflow-y-auto border border-rule bg-surface"
          data-testid="feed"
          role="log"
          aria-label="Team feed"
          aria-live="off"
          onWheel={(e) => {
            if (e.deltaY < 0 && follow) setFollow(false);
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (!follow && el.scrollHeight - el.scrollTop - el.clientHeight < 4) setFollow(true);
          }}
        >
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((item) => {
              const e = filtered[item.index]!;
              return <FeedRow key={e.id} e={e} top={item.start} pid={pid} />;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const FeedRow = memo(function FeedRow({ e, top, pid }: { e: BotssEvent; top: number; pid: string }) {
  const actor = e.actor ?? (e.role ? e.role : "botss");
  const role = roleOf(e.role ?? e.actor);
  const important = isImportant(e);
  const chatter = CHATTER.has(e.type);
  return (
    <div
      className={`absolute right-0 left-0 grid grid-cols-[66px_18px_128px_60px_minmax(0,1fr)] items-center gap-2 border-b border-rule/60 px-3 text-[12.5px] ${important ? "bg-[color-mix(in_srgb,var(--sunken)_60%,transparent)]" : ""}`}
      style={{ top, height: ROW }}
      data-type={e.type}
      title={`${e.type} · ${e.summary}`}
    >
      <span className="mono text-[11px] text-ink-3 tabular">{fmtTime(e.ts)}</span>
      <Glyph type={e.type} summary={e.summary} />
      <span
        className="mono truncate text-[11.5px] font-medium"
        style={{ color: roleColor(role === "system" ? null : actor) }}
      >
        {actor}
      </span>
      {e.task ? (
        <button
          className="mono truncate text-left text-[11.5px] text-ink-2 hover:underline"
          onClick={() => navigate(href(pid, "board", e.task!))}
        >
          {e.task}
        </button>
      ) : (
        <span />
      )}
      <span
        className={`truncate ${chatter ? "mono text-[11.5px] text-ink-3" : important ? "font-medium text-ink" : "text-ink-2"}`}
      >
        {e.summary}
      </span>
    </div>
  );
});
