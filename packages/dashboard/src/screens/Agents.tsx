import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AgentName,
  Badge,
  Empty,
  ErrorBox,
  Loadable,
  PageHeader,
  RoleChip,
  Skeleton,
  Tabs,
  toast,
  toastError,
} from "../components/ui";
import { api, pp } from "../lib/api";
import { useEvents } from "../lib/live";
import { fmtAgo, fmtElapsed, fmtTime, fmtTokens, toDate } from "../lib/format";
import { roleColor } from "../lib/roles";
import { useAction, useAgents, useRuns, useTasks } from "../lib/queries";
import { href } from "../lib/router";
import { useNow } from "../lib/theme";
import type { Agent, BotssEvent, Run } from "../lib/types";
import { Glyph } from "./Feed";

export function AgentsScreen({ pid }: { pid: string }) {
  const agents = useAgents(pid);
  const runs = useRuns(pid);
  const tasks = useTasks(pid);
  // /agents only carries the current run; idle agents show their most recent run from /runs.
  const lastRun = new Map<string, Run>();
  for (const r of runs.data ?? []) {
    const cur = lastRun.get(r.agent);
    if (!cur || r.started_at > cur.started_at) lastRun.set(r.agent, r);
  }
  const paused = new Set(
    (tasks.data ?? []).filter((t) => t.hold === "paused" && t.assignee).map((t) => t.assignee!),
  );
  return (
    <div>
      <PageHeader title="Agents" kicker="who is working on what, right now">
        {agents.data && (
          <span className="mono text-[12px] text-ink-3">
            {agents.data.filter((a) => a.active).length} active · {agents.data.length} on the team
          </span>
        )}
      </PageHeader>
      <Loadable q={agents} rows={6}>
        {(list) =>
          list.length === 0 ? (
            <Empty title="No agents yet">
              Agents join the team the first time the scheduler gives them work.
            </Empty>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
              {[...list]
                .sort(
                  (a, b) =>
                    Number(b.active) - Number(a.active) ||
                    a.id.localeCompare(b.id, undefined, { numeric: true }),
                )
                .map((a) => (
                  <AgentCard
                    key={a.id}
                    pid={pid}
                    a={a}
                    lastRun={lastRun.get(a.id) ?? null}
                    hasPaused={paused.has(a.id)}
                  />
                ))}
            </div>
          )
        }
      </Loadable>
    </div>
  );
}

function AgentCard({
  pid,
  a,
  lastRun,
  hasPaused,
}: {
  pid: string;
  a: Agent;
  lastRun: Run | null;
  hasPaused: boolean;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(1000, a.active);
  const pause = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/pause`, ["agents", "tasks"]);
  const resume = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/resume`, ["agents", "tasks"]);
  const run = a.run ?? lastRun;
  const started = toDate(run?.started_at)?.getTime();
  const tokens = run ? run.input_tokens + run.output_tokens + run.cache_creation_tokens : 0;
  const lastAction = (a.active ? (run?.last_action ?? a.last_action) : a.last_action) ?? null;
  const lastFile = (a.active ? (run?.last_file ?? a.last_file) : a.last_file) ?? null;

  return (
    <article
      className="flex flex-col border border-rule bg-surface"
      style={{ boxShadow: `inset 3px 0 0 ${roleColor(a.role)}` }}
      data-testid={`agent-${a.id}`}
    >
      <header className="flex items-center gap-2 px-4 pt-3">
        <AgentName id={a.id} className="text-[14px]" />
        <RoleChip role={a.role} short />
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px]">
          <span
            className={`h-2 w-2 rounded-full ${a.active ? "pulse-dot" : ""}`}
            style={{ background: a.active ? "var(--ok)" : "var(--rule-strong)" }}
            aria-hidden
          />
          <span className={a.active ? "text-ok" : "text-ink-3"}>{a.active ? "working" : a.status}</span>
        </span>
      </header>
      <div className="px-4 py-2">
        <div className="mono flex items-center gap-2 text-[11.5px] text-ink-3">
          {a.current_task ? (
            <a
              className="font-medium text-ink underline-offset-2 hover:underline"
              href={href(pid, "board", a.current_task)}
            >
              {a.current_task}
            </a>
          ) : (
            <span>no task</span>
          )}
          {run && <span>· {run.stage}</span>}
          {run && <span>· {run.id}</span>}
          <span className="ml-auto">ports {a.port_block}+</span>
        </div>
        <div className="mt-2 min-h-[38px] border-l-2 border-rule-strong pl-2.5">
          <div className="truncate text-[13px]" title={lastAction ?? undefined} data-testid="agent-action">
            {lastAction ?? <span className="text-ink-3">idle</span>}
          </div>
          {lastFile && <div className="mono truncate text-[11.5px] text-ink-3">{lastFile}</div>}
        </div>
      </div>
      <div className="grid grid-cols-3 border-t border-rule">
        <Metric
          label="elapsed"
          value={
            run && started
              ? fmtElapsed((run.ended_at ? (toDate(run.ended_at)?.getTime() ?? now) : now) - started)
              : "-"
          }
        />
        <Metric label="tokens" value={fmtTokens(tokens)} />
        <Metric label="turns" value={String(run?.turns ?? 0)} />
      </div>
      <footer className="flex items-center gap-2 border-t border-rule px-3 py-2">
        <button className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide activity" : "Show activity"}
        </button>
        {run?.ended_at && (
          <span className="mono text-[11px] text-ink-3">last run {fmtAgo(run.ended_at)}</span>
        )}
        <span className="ml-auto" />
        {a.active ? (
          <button
            className="btn btn-sm"
            onClick={() =>
              pause.mutate(undefined, {
                onSuccess: () => toast(`${a.id} paused; its task is on hold`),
                onError: toastError,
              })
            }
            disabled={pause.isPending}
          >
            Pause
          </button>
        ) : (
          hasPaused && (
            <button
              className="btn btn-sm"
              onClick={() =>
                resume.mutate(undefined, { onSuccess: () => toast(`${a.id} resumed`), onError: toastError })
              }
              disabled={resume.isPending}
            >
              Resume
            </button>
          )
        )}
      </footer>
      {open && <AgentActivity pid={pid} a={a} />}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-rule px-3 py-1.5 last:border-r-0">
      <div className="mono text-[10px] text-ink-3">{label}</div>
      <div className="mono text-[13px] font-semibold tabular">{value}</div>
    </div>
  );
}

function AgentActivity({ pid, a }: { pid: string; a: Agent }) {
  const [tab, setTab] = useState<"events" | "stream">("events");
  const { events } = useEvents(pid);
  const runId = a.current_run ?? a.run?.id ?? null;
  const mine: BotssEvent[] = events
    .filter((e) => e.actor === a.id)
    .slice(-40)
    .reverse();
  const stream = useQuery({
    queryKey: ["p", pid, "runs", "stream", runId],
    queryFn: () => api<{ lines: string[] }>("GET", pp(pid, `/runs/${runId}/stream`)),
    enabled: tab === "stream" && Boolean(runId),
    refetchInterval: a.active ? 3000 : false,
  });
  return (
    <div className="border-t border-rule bg-paper px-3 py-2">
      <Tabs
        label={`${a.id} activity`}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "events", label: "Recent events" },
          { id: "stream", label: "Raw stream" },
        ]}
      />
      <div className="max-h-72 overflow-y-auto pt-2">
        {tab === "events" ? (
          mine.length ? (
            <ol>
              {mine.map((e) => (
                <li
                  key={e.id}
                  className="grid grid-cols-[58px_16px_minmax(0,1fr)] items-baseline gap-1.5 py-0.5 text-[12px]"
                >
                  <span className="mono text-[10.5px] text-ink-3">{fmtTime(e.ts)}</span>
                  <Glyph type={e.type} />
                  <span className="truncate text-ink-2" title={e.summary}>
                    {e.summary}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-ink-3">No events from {a.id} in the loaded history.</p>
          )
        ) : !runId ? (
          <p className="text-[12px] text-ink-3">No run yet.</p>
        ) : stream.error ? (
          <ErrorBox error={stream.error} />
        ) : !stream.data ? (
          <Skeleton rows={4} />
        ) : (
          <pre className="mono text-[10.5px] leading-snug whitespace-pre-wrap text-ink-2">
            {stream.data.lines.slice(-120).join("\n") || "(empty)"}
          </pre>
        )}
      </div>
      <div className="pt-1">
        <Badge>{runId ?? "no run"}</Badge>
      </div>
    </div>
  );
}
