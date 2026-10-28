import { useState } from "react";
import { IdleCard, ProgressBar, roleTitleOf, WorkingCard } from "../components/AgentCards";
import { Empty, Loadable, PageHeader } from "../components/ui";
import { useAgents, useProject, useRuns, useTasks } from "../lib/queries";
import type { Run, Task } from "../lib/types";

// "The team at work": one visual card per working agent (status line, plan checklist, stage track, files, recent
// moments); the raw transcript sits behind each card's Details toggle. Idle agents are compact.

export function AgentsScreen({ pid }: { pid: string }) {
  const agents = useAgents(pid);
  const runs = useRuns(pid);
  const tasks = useTasks(pid);
  const project = useProject(pid);
  const [inspect, setInspect] = useState<string | null>(null);
  const lastRun = new Map<string, Run>();
  for (const r of runs.data ?? []) {
    const cur = lastRun.get(r.agent);
    if (!cur || r.started_at > cur.started_at) lastRun.set(r.agent, r);
  }
  const byId = new Map<string, Task>((tasks.data ?? []).map((t) => [t.id, t]));
  const paused = new Set(
    (tasks.data ?? []).filter((t) => t.hold === "paused" && t.assignee).map((t) => t.assignee!),
  );
  const build = (tasks.data ?? []).filter((t) => t.kind === "build");
  const doneBuild = build.filter((t) => t.status === "done").length;
  const inReview = (tasks.data ?? []).filter((t) => t.status === "review").length;
  const blocked = (tasks.data ?? []).filter((t) => t.status === "blocked").length;
  const roles = project.data?.roles;

  return (
    <div>
      <PageHeader title="The team at work" kicker="agents" />
      <Loadable q={agents} rows={6}>
        {(list) => {
          const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          const active = sorted.filter((a) => a.active);
          const idle = sorted.filter((a) => !a.active);
          const inspected = idle.find((a) => a.id === inspect) ?? null;
          return (
            <div className="flex flex-col gap-6">
              <section
                className="grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-center gap-6 border border-rule bg-surface px-5 py-3.5 max-[1100px]:grid-cols-1"
                data-testid="team-summary"
              >
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[14px]">
                  <span>
                    <b className="text-[20px]">{active.length}</b> {active.length === 1 ? "agent" : "agents"}{" "}
                    working
                  </span>
                  <span className="text-ink-2">
                    <b className="text-ink">{inReview}</b> waiting for review
                  </span>
                  <span className={blocked ? "text-danger" : "text-ink-2"}>
                    <b>{blocked}</b> blocked
                  </span>
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-[12px]">
                    <span className="font-semibold">Build progress</span>
                    <span className="mono text-ink-3">
                      {doneBuild} of {build.length} tasks done
                    </span>
                  </div>
                  <ProgressBar
                    done={doneBuild}
                    total={build.length}
                    color="var(--ok)"
                    label={`${doneBuild} of ${build.length} build tasks done`}
                  />
                </div>
              </section>

              {active.length === 0 ? (
                <Empty title="Nobody is working right now">
                  When the scheduler starts an agent, its card appears here with its plan and what it is
                  doing, in plain words.
                </Empty>
              ) : (
                <div
                  className={`grid gap-4 ${active.length === 1 ? "grid-cols-1" : "grid-cols-2 max-[1100px]:grid-cols-1"}`}
                  data-testid="working-agents"
                >
                  {active.map((a) => {
                    const run = a.run ?? lastRun.get(a.id) ?? null;
                    const task = byId.get(a.current_task ?? run?.task ?? "") ?? null;
                    return (
                      <WorkingCard
                        key={a.id}
                        pid={pid}
                        a={a}
                        run={run}
                        task={task}
                        roleTitle={roleTitleOf(roles, a.role)}
                        live
                        large={active.length <= 2}
                      />
                    );
                  })}
                </div>
              )}

              {idle.length > 0 && (
                <section aria-labelledby="idle-h">
                  <h2 id="idle-h" className="section-title mb-2">
                    NOT WORKING · {idle.length}
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
                    {idle.map((a) => (
                      <IdleCard
                        key={a.id}
                        pid={pid}
                        a={a}
                        last={lastRun.get(a.id) ?? null}
                        roleTitle={roleTitleOf(roles, a.role)}
                        hasPaused={paused.has(a.id)}
                        selected={inspect === a.id}
                        onDetails={() => setInspect(inspect === a.id ? null : a.id)}
                      />
                    ))}
                  </div>
                  {inspected && (
                    <div className="mt-3">
                      <WorkingCard
                        pid={pid}
                        a={inspected}
                        run={lastRun.get(inspected.id) ?? null}
                        task={byId.get(lastRun.get(inspected.id)?.task ?? "") ?? null}
                        roleTitle={roleTitleOf(roles, inspected.role)}
                        live={false}
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
