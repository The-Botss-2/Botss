import { useState } from "react";
import { TranscriptView, useRunItems } from "../components/LiveTranscript";
import {
  AgentName,
  Badge,
  Empty,
  Icon,
  Loadable,
  Modal,
  PageHeader,
  RoleChip,
  toast,
  toastError,
} from "../components/ui";
import { fmtAgo, fmtElapsed, fmtTokens, toDate } from "../lib/format";
import { roleColor } from "../lib/roles";
import { useAction, useAgents, useRuns, useTasks } from "../lib/queries";
import { href } from "../lib/router";
import { useNow } from "../lib/theme";
import type { Agent, Run } from "../lib/types";

// "The office": every working agent is a live panel with its transcript streaming in; idle agents sit in a row.

export function AgentsScreen({ pid }: { pid: string }) {
  const agents = useAgents(pid);
  const runs = useRuns(pid);
  const tasks = useTasks(pid);
  const [focus, setFocus] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
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
      <PageHeader title="Agents" kicker="watch the team work, live">
        {agents.data && (
          <span className="mono text-[12px] text-ink-3" data-testid="agents-count">
            {agents.data.filter((a) => a.active).length} working · {agents.data.length} on the team
          </span>
        )}
      </PageHeader>
      <Loadable q={agents} rows={6}>
        {(list) => {
          if (!list.length)
            return (
              <Empty title="No agents yet">
                Agents join the team the first time the scheduler gives them work.
              </Empty>
            );
          const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          const active = sorted.filter((a) => a.active);
          const idle = sorted.filter((a) => !a.active);
          const focused = active.find((a) => a.id === focus) ?? null;
          const others = focused ? active.filter((a) => a !== focused) : active;
          const inspected = idle.find((a) => a.id === inspect) ?? null;
          return (
            <div className="flex flex-col gap-6">
              {active.length === 0 ? (
                <Empty title="Nobody is working right now">
                  When the scheduler starts a run, the agent's panel appears here and its thinking, edits and
                  commands stream in live.
                </Empty>
              ) : (
                <>
                  {focused && (
                    <AgentPanel
                      key={`f-${focused.id}`}
                      pid={pid}
                      a={focused}
                      run={focused.run}
                      live
                      focused
                      onFocus={() => setFocus(null)}
                      height="h-[68vh]"
                    />
                  )}
                  {others.length > 0 && (
                    <div
                      className={`grid gap-3 ${others.length === 1 ? "grid-cols-1" : "grid-cols-2 max-[1100px]:grid-cols-1"}`}
                      data-testid="live-panels"
                    >
                      {others.map((a) => (
                        <AgentPanel
                          key={a.id}
                          pid={pid}
                          a={a}
                          run={a.run}
                          live
                          focused={false}
                          onFocus={() => setFocus(a.id)}
                          height={others.length <= 2 && !focused ? "h-[62vh]" : "h-[440px]"}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {idle.length > 0 && (
                <section aria-labelledby="idle-h">
                  <h2 id="idle-h" className="section-title mb-2">
                    IDLE · {idle.length}
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {idle.map((a) => (
                      <IdleChip
                        key={a.id}
                        pid={pid}
                        a={a}
                        last={lastRun.get(a.id) ?? null}
                        hasPaused={paused.has(a.id)}
                        selected={inspect === a.id}
                        onSelect={() => setInspect(inspect === a.id ? null : a.id)}
                      />
                    ))}
                  </div>
                  {inspected && (
                    <div className="mt-3">
                      <AgentPanel
                        pid={pid}
                        a={inspected}
                        run={lastRun.get(inspected.id) ?? null}
                        live={false}
                        focused
                        onFocus={() => setInspect(null)}
                        height="h-[52vh]"
                      />
                    </div>
                  )}
                </section>
              )}
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}

function AgentPanel({
  pid,
  a,
  run,
  live,
  focused,
  onFocus,
  height,
}: {
  pid: string;
  a: Agent;
  run: Run | null;
  live: boolean;
  focused: boolean;
  onFocus: () => void;
  height: string;
}) {
  const now = useNow(1000, live);
  const [kill, setKill] = useState(false);
  const pause = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/pause`, ["agents", "tasks"]);
  const killA = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/kill`, ["agents", "tasks"]);
  const { items, lastTs, loading } = useRunItems(pid, run?.id ?? null, live);
  const started = toDate(run?.started_at)?.getTime();
  const ended = toDate(run?.ended_at)?.getTime();
  const tokens = run ? run.input_tokens + run.output_tokens + run.cache_creation_tokens : 0;
  const color = roleColor(a.role);
  return (
    <article
      className={`flex flex-col border border-rule bg-surface ${height}`}
      data-testid={`agent-${a.id}`}
      aria-label={`${a.id} live panel`}
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2"
        style={{ boxShadow: `inset 0 3px 0 ${color}` }}
      >
        <AgentName id={a.id} className="text-[14px]" />
        <RoleChip role={a.role} short />
        {(a.current_task ?? run?.task) && (
          <a
            className="mono text-[12px] font-medium underline-offset-2 hover:underline"
            href={href(pid, "board", (a.current_task ?? run?.task)!)}
          >
            {a.current_task ?? run?.task}
          </a>
        )}
        {run && <span className="mono text-[11px] text-ink-3">{run.stage}</span>}
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px]">
          <span
            className={`h-2 w-2 rounded-full ${live ? "pulse-dot" : ""}`}
            style={{ background: live ? "var(--ok)" : "var(--rule-strong)" }}
            aria-hidden
          />
          <span className={live ? "text-ok" : "text-ink-3"}>
            {live ? "working" : run?.ended_at ? `ended ${fmtAgo(run.ended_at)}` : a.status}
          </span>
        </span>
        <span className="mono text-[11.5px] tabular" title="elapsed">
          {started ? fmtElapsed((ended ?? now) - started) : "-"}
        </span>
        <span className="mono text-[11.5px] text-ink-3 tabular" title="tokens">
          {fmtTokens(tokens)} tok
        </span>
        {live && (
          <>
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
              <Icon name="pause" size={12} /> Pause
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setKill(true)}>
              Kill
            </button>
          </>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={onFocus}
          aria-label={focused ? "Back to all agents" : `Focus ${a.id}`}
          title={focused ? "Back to grid" : "Focus"}
        >
          {focused ? <Icon name="close" size={12} /> : "⤢"}
        </button>
      </header>
      <TranscriptView
        items={items}
        active={live}
        lastTs={lastTs}
        role={a.role}
        loading={loading}
        emptyText={run ? "Waiting for the first action…" : "No runs yet."}
      />
      <Modal
        open={kill}
        onClose={() => setKill(false)}
        title={`Kill ${a.id}'s run?`}
        footer={
          <>
            <button className="btn" onClick={() => setKill(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() =>
                killA.mutate(undefined, {
                  onSuccess: () => {
                    setKill(false);
                    toast(`${a.id} stopped`);
                  },
                  onError: toastError,
                })
              }
            >
              Kill run
            </button>
          </>
        }
      >
        The Claude Code process is stopped now. Its task goes on hold with the work kept in the worktree;
        Resume picks it up on the same session.
      </Modal>
    </article>
  );
}

function IdleChip({
  pid,
  a,
  last,
  hasPaused,
  selected,
  onSelect,
}: {
  pid: string;
  a: Agent;
  last: Run | null;
  hasPaused: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const resume = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/resume`, ["agents", "tasks"]);
  return (
    <div
      className={`flex items-center gap-2 border bg-surface px-2.5 py-1.5 text-[12px] ${selected ? "border-ink" : "border-rule"}`}
      style={{ boxShadow: `inset 3px 0 0 ${roleColor(a.role)}` }}
      data-testid={`agent-${a.id}`}
    >
      <button
        className="flex items-center gap-2 text-left"
        onClick={onSelect}
        aria-expanded={selected}
        title="Show the last run"
      >
        <AgentName id={a.id} className="text-[12px]" />
        <span className="max-w-[220px] truncate text-ink-3">{a.last_action ?? "idle"}</span>
        {last?.ended_at && <span className="mono text-[10.5px] text-ink-3">{fmtAgo(last.ended_at)}</span>}
      </button>
      {hasPaused ? (
        <>
          <Badge tone="warn">paused</Badge>
          <button
            className="btn btn-sm"
            onClick={() =>
              resume.mutate(undefined, { onSuccess: () => toast(`${a.id} resumed`), onError: toastError })
            }
          >
            Resume
          </button>
        </>
      ) : (
        <span className="mono text-[10.5px] text-ink-3">idle</span>
      )}
    </div>
  );
}
