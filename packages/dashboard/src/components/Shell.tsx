import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useLive, useEvents } from "../lib/live";
import { fmtTokens } from "../lib/format";
import { useAction, useProject } from "../lib/queries";
import { href } from "../lib/router";
import { useTheme, type ThemePref } from "../lib/theme";
import { PHASE_LABELS, PHASES, type Phase, type ProjectInfo } from "../lib/types";
import { CountBadge, Icon, Modal, toast, toastError } from "./ui";
import { RequestChangeButton } from "./Changes";

export const SCREENS: { id: string; label: string; icon: string }[] = [
  { id: "idea", label: "Idea", icon: "idea" },
  { id: "questions", label: "Questions", icon: "questions" },
  { id: "docs", label: "Documents", icon: "docs" },
  { id: "design", label: "Design", icon: "design" },
  { id: "team", label: "Team builder", icon: "team" },
  { id: "board", label: "Live board", icon: "board" },
  { id: "agents", label: "Agents", icon: "agents" },
  { id: "feed", label: "Team feed", icon: "feed" },
  { id: "preview", label: "Preview", icon: "preview" },
  { id: "usage", label: "Usage", icon: "usage" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** Where to land when a project is opened without a screen. */
export function defaultScreen(p: ProjectInfo | undefined): string {
  if (!p) return "board";
  if (p.openQuestions > 0) return "questions";
  const m: Record<Phase, string> = {
    idea: "idea",
    discovery: "feed",
    prd_review: "docs/prd",
    design_direction: "design",
    design: "design",
    architecture_review: "docs/architecture",
    plan_review: "team",
    build: "board",
    release_review: "docs/release",
    done: "board",
  };
  return m[p.phase] ?? "board";
}

export function Shell({ pid, screen, children }: { pid: string; screen: string; children: ReactNode }) {
  const qc = useQueryClient();
  useLive(pid, qc);
  const project = useProject(pid);
  const p = project.data;
  const alerts = p?.state.alerts?.length ?? 0;

  return (
    <div className="grid h-full grid-cols-[208px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] max-[1100px]:grid-cols-[56px_minmax(0,1fr)]">
      <Header pid={pid} p={p} />
      <nav
        aria-label="Screens"
        className="row-start-2 flex flex-col gap-0.5 overflow-y-auto border-r border-rule bg-surface px-2 py-3"
      >
        <a
          href="#/"
          className="mb-2 flex items-center gap-2 rounded-[3px] px-2 py-1.5 text-[12px] text-ink-3 hover:bg-sunken hover:text-ink"
        >
          <Icon name="projects" size={15} />
          <span className="max-[1100px]:sr-only">All projects</span>
        </a>
        {SCREENS.map((s) => {
          const active = screen === s.id;
          const badge =
            s.id === "questions"
              ? (p?.openQuestions ?? 0) + alerts
              : s.id === "agents"
                ? (p?.activeRuns ?? 0)
                : 0;
          return (
            <a
              key={s.id}
              href={href(pid, s.id)}
              aria-current={active ? "page" : undefined}
              title={s.label}
              className={`group relative flex items-center gap-2.5 rounded-[3px] px-2 py-[7px] text-[13.5px] ${active ? "bg-ink font-medium text-paper" : "text-ink-2 hover:bg-sunken hover:text-ink"}`}
            >
              <Icon name={s.icon} size={16} />
              <span className="flex-1 max-[1100px]:sr-only">{s.label}</span>
              {badge > 0 && (
                <span className="max-[1100px]:absolute max-[1100px]:-top-0.5 max-[1100px]:right-0">
                  <CountBadge
                    n={badge}
                    tone={s.id === "questions" ? "danger" : "accent"}
                    label={s.id === "questions" ? `${badge} need you` : `${badge} running`}
                  />
                </span>
              )}
            </a>
          );
        })}
        <div className="mt-auto px-2 pt-4 max-[1100px]:hidden">
          <LiveStatus pid={pid} />
        </div>
      </nav>
      <main id="main" tabIndex={-1} className="canvas row-start-2 min-h-0 overflow-y-auto outline-none">
        {children}
      </main>
    </div>
  );
}

function LiveStatus({ pid }: { pid: string }) {
  const { status } = useEvents(pid);
  const label = status === "live" ? "live" : status === "connecting" ? "connecting" : "offline, retrying";
  const color = status === "live" ? "var(--ok)" : status === "connecting" ? "var(--warn)" : "var(--danger)";
  return (
    <div
      className="mono flex items-center gap-2 text-[11px] text-ink-3"
      role="status"
      aria-label={`Live updates ${label}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status === "live" ? "pulse-dot" : ""}`}
        style={{ background: color }}
      />
      {label}
    </div>
  );
}

function Header({ pid, p }: { pid: string; p: ProjectInfo | undefined }) {
  const [killOpen, setKillOpen] = useState(false);
  const pause = useAction(pid, "POST", "/control/pause");
  const resume = useAction(pid, "POST", "/control/resume");
  const kill = useAction<unknown, { killed: number }>(pid, "POST", "/control/kill", [
    "project",
    "agents",
    "tasks",
  ]);
  const paused = Boolean(p?.state.paused);

  return (
    <header className="col-span-2 border-b border-rule bg-surface">
      <div className="flex h-12 items-center gap-4 px-4">
        <a href="#/" className="flex items-center gap-2" aria-label="Botss home">
          <Logo />
          <span className="mono text-[13px] font-semibold tracking-tight">botss</span>
        </a>
        <span className="h-5 w-px bg-rule" aria-hidden />
        <div className="min-w-0">
          <div
            className="truncate text-[14px] leading-tight font-semibold"
            data-testid="project-name"
            title={p?.root}
          >
            {p?.name ?? "…"}
          </div>
        </div>
        {p?.state.paused && (
          <span
            className="mono rounded-[2px] border border-warn bg-warn-soft px-1.5 text-[11px] leading-[18px] text-warn"
            role="status"
          >
            paused{p.state.pauseReason ? `: ${p.state.pauseReason}` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {p && <QuotaMeter p={p} />}
          <RequestChangeButton pid={pid} p={p} />
          <a
            href={href(pid, "questions")}
            className="btn btn-sm"
            aria-label={`${p?.openQuestions ?? 0} open questions`}
            data-testid="questions-badge"
          >
            <Icon name="questions" size={14} />
            <span className="max-[1280px]:hidden">Questions</span>
            <span
              className={`mono rounded-full px-1.5 text-[11px] leading-[16px] font-semibold ${p?.openQuestions ? "bg-danger text-danger-ink" : "bg-sunken text-ink-3"}`}
            >
              {p?.openQuestions ?? 0}
            </span>
          </a>
          {paused ? (
            <button
              className="btn btn-sm"
              onClick={() =>
                resume.mutate(undefined, { onSuccess: () => toast("Scheduler resumed"), onError: toastError })
              }
              disabled={resume.isPending}
            >
              <Icon name="play" size={13} /> Resume
            </button>
          ) : (
            <button
              className="btn btn-sm"
              onClick={() =>
                pause.mutate(undefined, {
                  onSuccess: () => toast("Scheduler paused. Running agents finish their current run."),
                  onError: toastError,
                })
              }
              disabled={pause.isPending || !p}
            >
              <Icon name="pause" size={13} /> Pause
            </button>
          )}
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setKillOpen(true)}
            disabled={!p}
            data-testid="kill-switch"
          >
            <Icon name="power" size={13} /> Kill switch
          </button>
          <ThemeToggle />
        </div>
      </div>
      <PhaseStepper phase={p?.phase} />
      <Modal
        open={killOpen}
        onClose={() => setKillOpen(false)}
        title="Stop every agent now?"
        footer={
          <>
            <button className="btn" onClick={() => setKillOpen(false)} autoFocus>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={kill.isPending}
              onClick={() =>
                kill.mutate(undefined, {
                  onSuccess: (r) => {
                    setKillOpen(false);
                    toast(
                      `Kill switch: stopped ${r.killed} agent run${r.killed === 1 ? "" : "s"}. Botss is paused.`,
                    );
                  },
                  onError: toastError,
                })
              }
            >
              {kill.isPending ? "Stopping…" : "Stop all agents"}
            </button>
          </>
        }
      >
        <p>
          Every running Claude Code process is killed immediately and the scheduler is paused. Work in
          progress stays in each task's worktree; when you resume, agents pick up from where they stopped.
        </p>
        <p className="mt-2 text-ink-3">Use Pause instead if you only want to stop new runs from starting.</p>
      </Modal>
    </header>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="4" fill="var(--ink)" />
      <path
        d="M9 8h9a5 5 0 0 1 0 10H9zM9 18h10a5 5 0 0 1 0 10H9z"
        fill="none"
        stroke="var(--paper)"
        strokeWidth="2.5"
      />
    </svg>
  );
}

function PhaseStepper({ phase }: { phase: Phase | undefined }) {
  const cur = phase ? PHASES.indexOf(phase) : -1;
  return (
    <ol
      aria-label="Project phase"
      className="flex items-stretch overflow-x-auto border-t border-rule px-4"
      data-testid="phase-stepper"
    >
      {PHASES.map((ph, i) => {
        const state = i < cur ? "past" : i === cur ? "current" : "future";
        return (
          <li
            key={ph}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center"
          >
            <div
              className={`relative flex w-full items-center gap-1.5 py-1.5 pr-2 text-[11.5px] whitespace-nowrap ${state === "current" ? "font-semibold text-ink" : state === "past" ? "text-ink-2" : "text-ink-3"}`}
            >
              <span
                aria-hidden
                className={`mono flex h-[16px] min-w-[16px] items-center justify-center rounded-[2px] text-[10px] ${state === "current" ? "bg-ink text-paper" : state === "past" ? "border border-rule-strong text-ink-2" : "border border-dashed border-rule-strong text-ink-3"}`}
              >
                {state === "past" ? "✓" : i}
              </span>
              <span className="truncate">{PHASE_LABELS[ph]}</span>
              {state === "current" && (
                <span className="absolute right-2 bottom-0 left-0 h-[2px] bg-ink" aria-hidden />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function QuotaMeter({ p }: { p: ProjectInfo }) {
  const used = p.quota.usedToday;
  const budget = p.settings.daily_token_budget;
  const allowance = p.quota.allowance;
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  const reservePct = budget > 0 ? p.settings.reserve_percent : 0;
  const tone = !p.quota.ok ? "var(--danger)" : pct > 100 - reservePct - 10 ? "var(--warn)" : "var(--ink)";
  const label =
    budget > 0
      ? `${fmtTokens(used)} of ${fmtTokens(allowance)} tokens used today`
      : `${fmtTokens(used)} tokens today, no daily budget`;
  return (
    <div
      className="flex items-center gap-2 max-[1180px]:hidden"
      title={p.quota.reason ?? label}
      data-testid="quota-meter"
    >
      <div className="mono text-right text-[10.5px] leading-tight text-ink-3">
        <div>quota today</div>
        <div className="text-ink-2">
          {fmtTokens(used)} / {budget > 0 ? fmtTokens(allowance) : "∞"}
        </div>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="relative h-2 w-28 overflow-hidden rounded-[1px] border border-rule-strong bg-sunken"
      >
        <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: tone }} />
        {reservePct > 0 && (
          <div
            className="absolute inset-y-0 right-0"
            style={{
              width: `${reservePct}%`,
              background:
                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--ink-3) 45%, transparent) 3px 4px)",
            }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const opts: { id: ThemePref; icon: string; label: string }[] = [
    { id: "system", icon: "system", label: "System theme" },
    { id: "light", icon: "sun", label: "Light theme" },
    { id: "dark", icon: "moon", label: "Dark theme" },
  ];
  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex border border-rule-strong"
      data-testid="theme-toggle"
    >
      {opts.map((o) => (
        <button
          key={o.id}
          aria-pressed={pref === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => setPref(o.id)}
          className={`flex h-[26px] w-[26px] items-center justify-center ${pref === o.id ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"}`}
        >
          <Icon name={o.icon} size={13} />
        </button>
      ))}
    </div>
  );
}
