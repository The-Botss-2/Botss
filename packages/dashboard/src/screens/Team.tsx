import { useEffect, useMemo, useState } from "react";
import { Dag } from "../components/Dag";
import { Empty, ErrorBox, Loadable, PageHeader, RoleChip, toast, toastError } from "../components/ui";
import { fmtMinutes, fmtTokens } from "../lib/format";
import { ROLE_LABELS, roleColor } from "../lib/roles";
import { useAction, usePlan, useProject } from "../lib/queries";
import { href, navigate } from "../lib/router";
import type { PlanInfo, ProjectInfo } from "../lib/types";

const MODEL_SUGGESTIONS = ["opus", "sonnet", "haiku", "fable"];
const SIZE_W: Record<string, number> = { S: 1, M: 2, L: 3 };
const MIN_PER_UNIT = 10;

export function TeamScreen({ pid }: { pid: string }) {
  const plan = usePlan(pid);
  const project = useProject(pid);
  return (
    <div>
      <PageHeader title="Team builder" kicker="plan · staffing · estimate" />
      <Loadable q={plan} rows={8}>
        {(pl) =>
          !pl.tasks.length || !project.data ? (
            <Empty title="No tasks yet">
              The plan appears here after the tech lead submits it. You then choose how many agents work in
              parallel per role and start the build.
            </Empty>
          ) : (
            <TeamBuilder pid={pid} plan={pl} project={project.data} />
          )
        }
      </Loadable>
    </div>
  );
}

function TeamBuilder({ pid, plan, project }: { pid: string; plan: PlanInfo; project: ProjectInfo }) {
  const stats = plan.stats;
  const roles = useMemo(() => {
    const rs = new Set<string>([...Object.keys(stats?.byRole ?? {}), ...Object.keys(plan.estimate.byRole)]);
    const order = [
      "tech-lead",
      "backend",
      "frontend",
      "devops",
      "designer",
      "security",
      "pm",
      "reviewer",
      "qa",
    ];
    return [...rs].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [stats, plan.estimate.byRole]);

  const maxFor = (r: string) =>
    Math.max(stats?.peakByRole[r] ?? (stats?.byRole[r] ? 1 : Math.min(stats?.peakLanes ?? 1, 4)), 1);
  const initial = useMemo(
    () =>
      Object.fromEntries(
        roles.map((r) => [r, Math.min(maxFor(r), plan.team[r] ?? project.roles[r]?.max_parallel ?? 1)]),
      ),
    [roles],
  );
  const [team, setTeam] = useState<Record<string, number>>(initial);
  useEffect(() => setTeam((t) => ({ ...initial, ...t })), [initial]);

  const saveModel = useAction<{ models: Record<string, string> }>(pid, "PATCH", "/settings", ["project"]);
  const approve = useAction<{ team: Record<string, number> }>(pid, "POST", "/gates/plan/approve", [
    "project",
    "tasks",
    "docs",
  ]);
  const canApprove = project.phase === "plan_review";

  const totalWeight = plan.tasks.reduce((n, t) => n + (SIZE_W[t.size] ?? 2), 0);
  const buildAgents = Object.keys(stats?.byRole ?? {}).reduce((n, r) => n + (team[r] ?? 0), 0);
  const lanes = Math.max(
    1,
    Math.min(stats?.peakLanes ?? 1, buildAgents, project.settings.max_concurrent_agents),
  );
  const units = Math.max(stats?.criticalLength ?? 0, Math.ceil(totalWeight / lanes));
  const missing = Object.keys(stats?.byRole ?? {}).filter((r) => !team[r]);

  return (
    <div className="flex flex-col gap-8">
      <div
        className="grid grid-cols-4 border border-rule bg-surface max-[1100px]:grid-cols-2"
        data-testid="plan-summary"
      >
        <Stat label="tasks" value={String(plan.tasks.length)} />
        <Stat
          label="critical path"
          value={`${stats?.criticalPath.length ?? 0} tasks`}
          sub={stats?.criticalPath.join(" → ")}
        />
        <Stat
          label="estimated tokens"
          value={fmtTokens(plan.estimate.totalTokens)}
          sub={`${fmtTokens(project.quota.allowance ?? 0)} / day allowance`}
        />
        <Stat
          label="rough time"
          value={fmtMinutes(units * MIN_PER_UNIT)}
          sub={`${lanes} lane${lanes === 1 ? "" : "s"} in parallel`}
        />
      </div>

      <section aria-labelledby="roles-h">
        <h2 id="roles-h" className="section-title mb-3">
          STAFFING
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] border-t border-l border-rule">
          {roles.map((r) => {
            const def = project.roles[r];
            const est = plan.estimate.byRole[r];
            const max = maxFor(r);
            const n = team[r] ?? 0;
            return (
              <div
                key={r}
                className="flex flex-col gap-2 border-r border-b border-rule bg-surface p-4"
                data-testid={`role-${r}`}
                style={{ boxShadow: `inset 3px 0 0 ${roleColor(r)}` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[14px] font-semibold">{def?.title ?? ROLE_LABELS[r] ?? r}</div>
                    <RoleChip role={r} />
                  </div>
                  <div
                    className="flex items-center border border-rule-strong"
                    role="group"
                    aria-label={`${r} agents`}
                  >
                    <button
                      className="h-7 w-7 text-[15px] hover:bg-sunken disabled:opacity-40"
                      aria-label={`Fewer ${r} agents`}
                      disabled={n <= 0}
                      onClick={() => setTeam((t) => ({ ...t, [r]: Math.max(0, n - 1) }))}
                    >
                      −
                    </button>
                    <span
                      className="mono w-7 text-center text-[13px] font-semibold"
                      aria-live="polite"
                      data-testid={`count-${r}`}
                    >
                      {n}
                    </span>
                    <button
                      className="h-7 w-7 text-[15px] hover:bg-sunken disabled:opacity-40"
                      aria-label={`More ${r} agents`}
                      disabled={n >= max}
                      onClick={() => setTeam((t) => ({ ...t, [r]: Math.min(max, n + 1) }))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="mono text-[11.5px] text-ink-3">
                  {stats?.byRole[r] ?? est?.tasks ?? 0} tasks · max useful {max} ·{" "}
                  {fmtTokens(est?.tokens ?? 0)} tok
                </div>
                <label className="flex items-center gap-2 text-[12px] text-ink-2">
                  model
                  <input
                    className="field mono py-1 text-[12px]"
                    list="model-suggestions"
                    defaultValue={project.settings.models[r] ?? ""}
                    placeholder="default"
                    aria-label={`Model for ${r}`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v === (project.settings.models[r] ?? "")) return;
                      const models = { ...project.settings.models };
                      if (v) models[r] = v;
                      else delete models[r];
                      saveModel.mutate(
                        { models },
                        { onSuccess: () => toast(`${r} model: ${v || "default"}`), onError: toastError },
                      );
                    }}
                  />
                </label>
                {def?.skills?.length ? (
                  <div className="mono truncate text-[10.5px] text-ink-3" title={def.skills.join(", ")}>
                    skills: {def.skills.join(", ")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </section>

      <section aria-labelledby="dag-h">
        <h2 id="dag-h" className="section-title mb-3">
          DEPENDENCY GRAPH · critical path in bold
        </h2>
        <Dag
          tasks={plan.tasks}
          critical={stats?.criticalPath}
          onSelect={(id) => navigate(href(pid, "board", id))}
        />
      </section>

      <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center gap-4 border-t border-rule bg-surface px-6 py-3">
        <div className="flex-1 text-[13px] text-ink-2">
          {canApprove ? (
            missing.length ? (
              <span className="text-warn">
                No agents for {missing.join(", ")}: their tasks would use the roles.yaml default.
              </span>
            ) : (
              <>
                Starts the build with{" "}
                <span className="mono">{Object.values(team).reduce((a, b) => a + b, 0)}</span> agents. You can
                pause or kill at any time.
              </>
            )
          ) : (
            <>Plan approval is available in the plan review phase (now: {project.phase.replace("_", " ")}).</>
          )}
        </div>
        {approve.error && <ErrorBox error={approve.error} />}
        <a className="btn" href={href(pid, "docs", "plan")}>
          Read the plan
        </a>
        <button
          className="btn btn-primary"
          disabled={!canApprove || approve.isPending}
          onClick={() =>
            approve.mutate(
              { team },
              {
                onSuccess: () => {
                  toast("Plan approved. Build started.");
                  navigate(href(pid, "board"));
                },
              },
            )
          }
        >
          Approve plan & start build
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-r border-rule px-4 py-3 last:border-r-0">
      <div className="mono text-[11px] text-ink-3">{label}</div>
      <div className="mono text-[22px] leading-tight font-semibold tabular">{value}</div>
      {sub && (
        <div className="mono truncate text-[11px] text-ink-3" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}
