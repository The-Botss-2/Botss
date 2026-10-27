import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, pp } from "../lib/api";
import { fmtTime, toDate } from "../lib/format";
import { useEvents } from "../lib/live";
import { useTranscript } from "../lib/queries";
import { roleColor } from "../lib/roles";
import { useNow } from "../lib/theme";
import type { BotssEvent, TranscriptItem } from "../lib/types";

// A live, chat/terminal hybrid view of one agent run. Active runs are built from run.* events (HTTP backfill by
// run id + the live WebSocket store); finished runs use GET /runs/:rid/transcript.

export interface LiveItem {
  key: string;
  kind: "text" | "tool" | "result" | "init" | "final" | "note";
  ts?: string;
  text?: string;
  tool?: string;
  input?: Record<string, unknown> | null;
  file?: string | null;
  isError?: boolean;
  toolUseId?: string | null;
  results?: LiveItem[];
}

const MAX_ITEMS = 300;
const GUARD = /Botss guard/i;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

/** Attach each result to its tool call (by toolUseId, else the latest call without a result). */
function pair(raw: LiveItem[]): LiveItem[] {
  const out: LiveItem[] = [];
  const byId = new Map<string, LiveItem>();
  let lastOpen: LiveItem | null = null;
  for (const it of raw) {
    if (it.kind === "tool") {
      const t = { ...it, results: [] as LiveItem[] };
      if (it.toolUseId) byId.set(it.toolUseId, t);
      lastOpen = t;
      out.push(t);
    } else if (it.kind === "result") {
      const host: LiveItem | null = (it.toolUseId ? byId.get(it.toolUseId) : undefined) ?? lastOpen;
      if (host) {
        host.results = [...(host.results ?? []), it];
        if (host === lastOpen) lastOpen = null;
      } else out.push(it);
    } else out.push(it);
  }
  return out;
}

export function eventsToItems(evs: BotssEvent[]): LiveItem[] {
  const raw: LiveItem[] = [];
  for (const e of evs) {
    const d = e.data ?? {};
    const key = `e${e.id}`;
    if (e.type === "run.text") raw.push({ key, kind: "text", ts: e.ts, text: str(d.text) || e.summary });
    else if (e.type === "run.tool")
      raw.push({
        key,
        kind: "tool",
        ts: e.ts,
        tool: str(d.tool) || "tool",
        input: (d.input as Record<string, unknown> | undefined) ?? null,
        file: (d.file as string | null | undefined) ?? null,
        text: e.summary,
        toolUseId: (d.toolUseId as string | undefined) ?? null,
      });
    else if (e.type === "run.result")
      raw.push({
        key,
        kind: "result",
        ts: e.ts,
        text: str(d.text) || e.summary,
        isError: Boolean(d.isError),
        toolUseId: (d.toolUseId as string | undefined) ?? null,
      });
    else if (e.type === "run.blocked" || e.type === "guard.blocked")
      raw.push({ key, kind: "result", ts: e.ts, text: e.summary, isError: true });
    else if (e.type === "run.init") raw.push({ key, kind: "init", ts: e.ts, text: e.summary });
    else if (
      e.type === "run.started" ||
      /^run\.(ended|finished|done|failed|interrupted|exit)/.test(e.type) ||
      e.type === "progress.note"
    )
      raw.push({ key, kind: e.type === "progress.note" ? "note" : "final", ts: e.ts, text: e.summary });
  }
  return pair(raw);
}

export function transcriptToItems(items: TranscriptItem[]): LiveItem[] {
  return pair(
    items.map((it, i) => ({
      key: `t${i}`,
      kind: it.kind,
      ts: it.ts,
      text: it.text,
      tool: it.tool,
      input: it.input ?? null,
      file: it.file ?? null,
      isError: it.isError,
      toolUseId: it.toolUseId ?? null,
    })),
  );
}

/** Coalesce rapid updates to one render per animation frame. */
function useFrame<T>(value: T): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = requestAnimationFrame(() => setV(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return v;
}

export function useRunItems(
  pid: string,
  runId: string | null,
  active: boolean,
): { items: LiveItem[]; lastTs: number; loading: boolean } {
  const { events } = useEvents(pid);
  const backfill = useQuery({
    queryKey: ["run-events", pid, runId],
    queryFn: () =>
      api<BotssEvent[]>("GET", pp(pid, `/events?run=${encodeURIComponent(runId ?? "")}&limit=2000`)),
    enabled: Boolean(runId),
    staleTime: Infinity,
  });
  const transcript = useTranscript(pid, runId, active);
  const mine = useMemo(() => {
    if (!runId) return [] as BotssEvent[];
    const seen = new Set<number>();
    const out: BotssEvent[] = [];
    for (const e of backfill.data ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.run_id === runId && !seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }, [events, backfill.data, runId]);
  const frameEvents = useFrame(mine);
  return useMemo(() => {
    const fromEvents = eventsToItems(frameEvents);
    const rich = fromEvents.some((i) => i.kind === "tool" || i.kind === "text");
    const items =
      !active && transcript.data?.items.length && !rich
        ? transcriptToItems(transcript.data.items)
        : fromEvents;
    const last = frameEvents.at(-1);
    return {
      items: items.slice(-MAX_ITEMS),
      lastTs: toDate(last?.ts)?.getTime() ?? 0,
      loading: Boolean(runId) && backfill.isLoading,
    };
  }, [frameEvents, active, transcript.data, runId, backfill.isLoading]);
}

// --------------------------------------------------------------------------------------------- render

function lines(s: string, max: number): { shown: string[]; more: number } {
  const all = s.replace(/\r\n/g, "\n").split("\n");
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

function MiniDiff({ oldS, newS }: { oldS: string; newS: string }) {
  const o = lines(oldS, 10);
  const n = lines(newS, 12);
  return (
    <div
      className="mono mt-1 overflow-x-auto border border-rule text-[11px] leading-[1.45]"
      data-testid="mini-diff"
    >
      {o.shown.map((l, i) => (
        <div key={`o${i}`} className="bg-danger-soft px-2 whitespace-pre text-danger">
          - {l}
        </div>
      ))}
      {o.more > 0 && <div className="px-2 text-ink-3"> … {o.more} more removed</div>}
      {n.shown.map((l, i) => (
        <div key={`n${i}`} className="bg-ok-soft px-2 whitespace-pre text-ok">
          + {l}
        </div>
      ))}
      {n.more > 0 && <div className="px-2 text-ink-3"> … {n.more} more added</div>}
    </div>
  );
}

function Result({ r, collapsed }: { r: LiveItem; collapsed: boolean }) {
  const text = r.text ?? "";
  const guard = GUARD.test(text);
  if (guard)
    return (
      <div
        className="mono mt-1 border border-l-4 border-[color-mix(in_srgb,var(--danger)_40%,transparent)] border-l-[var(--danger)] bg-danger-soft px-2 py-1 text-[11px] text-danger"
        data-testid="guard-block"
      >
        ⊘ {text.slice(0, 600)}
      </div>
    );
  if (!text.trim()) return null;
  const body = (
    <pre
      className={`mono max-h-48 overflow-auto px-2 py-1 text-[11px] whitespace-pre-wrap ${r.isError ? "text-danger" : "text-ink-2"}`}
    >
      {text}
    </pre>
  );
  if (!collapsed || r.isError)
    return (
      <div className={`mt-1 border ${r.isError ? "border-danger bg-danger-soft" : "border-rule bg-sunken"}`}>
        {body}
      </div>
    );
  const first = text.split("\n")[0]!.slice(0, 120);
  return (
    <details className="mt-1 border border-rule bg-sunken">
      <summary className="mono cursor-pointer truncate px-2 py-0.5 text-[11px] text-ink-3">
        ↳ {first}
        {text.length > first.length ? " …" : ""}
      </summary>
      {body}
    </details>
  );
}

const ToolRow = memo(function ToolRow({ it }: { it: LiveItem }) {
  const inp = it.input ?? {};
  const tool = it.tool ?? "tool";
  const file = str(it.file ?? inp.file_path ?? inp.path ?? "");
  let body: ReactNode = null;
  if (/^(Edit|MultiEdit)$/.test(tool) && (inp.old_string !== undefined || inp.new_string !== undefined)) {
    body = <MiniDiff oldS={str(inp.old_string)} newS={str(inp.new_string)} />;
  } else if (tool === "Write" && inp.content !== undefined) {
    const l = lines(str(inp.content), 8);
    body = (
      <pre className="mono mt-1 overflow-x-auto border border-rule bg-sunken px-2 py-1 text-[11px] text-ink-2">
        {l.shown.join("\n")}
        {l.more > 0 ? `\n… ${l.more} more lines` : ""}
      </pre>
    );
  } else if (tool === "Bash") {
    body = (
      <div className="mono mt-0.5 text-[11.5px]">
        <span className="text-ink-3">$ </span>
        <span className="font-medium break-all text-ink">{str(inp.command) || it.text}</span>
        {inp.description ? <span className="ml-2 text-ink-3"># {str(inp.description)}</span> : null}
      </div>
    );
  } else if (/^(Grep|Glob)$/.test(tool)) {
    body = (
      <div className="mono mt-0.5 text-[11.5px] text-ink-2">
        {[str(inp.pattern), str(inp.path ?? inp.glob ?? "")].filter(Boolean).join("  in  ")}
      </div>
    );
  } else if (!file) {
    body = <div className="mt-0.5 truncate text-[12px] text-ink-2">{it.text}</div>;
  }
  return (
    <div className="py-1" data-testid="live-tool" data-tool={tool}>
      <div className="flex items-baseline gap-2">
        <span className="mono shrink-0 rounded-[2px] border border-rule-strong px-1 text-[10.5px] font-semibold text-ink-2">
          {tool}
        </span>
        {file && <span className="mono min-w-0 truncate text-[11.5px] text-ink">{file}</span>}
        <span className="mono ml-auto shrink-0 text-[10px] text-ink-3">{fmtTime(it.ts)}</span>
      </div>
      {body}
      {(it.results ?? []).map((r) => (
        <Result
          key={r.key}
          r={r}
          collapsed={tool === "Bash" || tool === "Read" || tool === "Grep" || tool === "Glob"}
        />
      ))}
    </div>
  );
});

function Bubble({ it, color }: { it: LiveItem; color: string }) {
  const [full, setFull] = useState(false);
  const text = it.text ?? "";
  const long = text.length > 900;
  return (
    <div
      className="my-1.5 max-w-[92%] border border-rule bg-surface px-3 py-2 text-[13px] leading-relaxed"
      style={{ borderLeft: `3px solid ${color}` }}
      data-testid="live-text"
    >
      <div className="whitespace-pre-wrap">{long && !full ? `${text.slice(0, 900)}…` : text}</div>
      {long && (
        <button className="mt-1 text-[11.5px] text-ink-3 underline" onClick={() => setFull((f) => !f)}>
          {full ? "show less" : "show all"}
        </button>
      )}
    </div>
  );
}

export function TranscriptView({
  items,
  active,
  lastTs,
  role,
  loading,
  className = "",
  emptyText = "Waiting for the first action…",
}: {
  items: LiveItem[];
  active: boolean;
  lastTs: number;
  role: string;
  loading?: boolean;
  className?: string;
  emptyText?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const now = useNow(1000, active);
  const thinking = active && lastTs > 0 && now - lastTs < 3000;
  const color = roleColor(role);
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items, follow, thinking]);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={box}
        className={`h-full overflow-y-auto px-3 py-2 ${className}`}
        role="log"
        aria-live="off"
        aria-label="Live transcript"
        data-testid="live-transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {items.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-3">{loading ? "Loading…" : emptyText}</p>
        ) : (
          items.map((it) =>
            it.kind === "text" ? (
              <Bubble key={it.key} it={it} color={color} />
            ) : it.kind === "tool" ? (
              <ToolRow key={it.key} it={it} />
            ) : it.kind === "result" ? (
              <Result key={it.key} r={it} collapsed={false} />
            ) : (
              <div
                key={it.key}
                className={`mono my-1 flex items-center gap-2 text-[10.5px] ${it.kind === "note" ? "text-ink" : "text-ink-3"}`}
              >
                <span className="h-px flex-1 bg-rule" />
                <span className="max-w-[80%] truncate">
                  {it.kind === "note" ? "¶ " : ""}
                  {it.text}
                </span>
                <span className="h-px flex-1 bg-rule" />
              </div>
            ),
          )
        )}
        {active && (
          <div
            className="mono flex items-center gap-1.5 py-1 text-[11px] text-ink-3"
            aria-live="polite"
            data-testid="thinking"
          >
            <span className="inline-block h-3 w-1.5 animate-pulse" style={{ background: color }} />
            {thinking ? "working…" : "thinking…"}
          </div>
        )}
      </div>
      {!follow && (
        <button
          className="btn btn-sm btn-primary absolute right-3 bottom-2 shadow"
          onClick={() => {
            setFollow(true);
            if (box.current) box.current.scrollTop = box.current.scrollHeight;
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

/** Self-contained live transcript for a run id (used by the task drawer). */
export function RunTranscript({
  pid,
  runId,
  active,
  role,
}: {
  pid: string;
  runId: string | null;
  active: boolean;
  role: string;
}) {
  const { items, lastTs, loading } = useRunItems(pid, runId, active);
  if (!runId) return <p className="text-[13px] text-ink-3">No run yet for this task.</p>;
  return (
    <div className="flex h-[62vh] flex-col border border-rule bg-paper">
      <TranscriptView
        items={items}
        active={active}
        lastTs={lastTs}
        role={role}
        loading={loading}
        emptyText={active ? "Waiting for the first action…" : "No transcript for this run."}
      />
    </div>
  );
}
