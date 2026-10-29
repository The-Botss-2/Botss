import { useMemo, useState } from "react";
import {
  deriveInsight,
  PLANNING_LABELS,
  stageOf,
  STAGES,
  todoProgress,
  type Insight,
  type Todo,
} from "../lib/activity";
import { fmtAgo, fmtElapsed, toDate } from "../lib/format";
import { useAction } from "../lib/queries";
import { ROLE_CODES, ROLE_LABELS, roleColor } from "../lib/roles";
import { href } from "../lib/router";
import { useNow } from "../lib/theme";
import type { Agent, Run, Task } from "../lib/types";
import { TranscriptView, useRunEvents, useRunItems } from "./LiveTranscript";
import { Badge, Icon, Modal, toast, toastError } from "./ui";

// ------------------------------------------------------------------------------------------- pieces

const ACT_PATHS: Record<string, string> = {
  writing: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4", // pen
  testing: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9", // flask
  reading: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5", // magnifier
  searching: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  talking: "M4 5h16v11H9l-5 4z", // chat bubble
  planning: "M9 4h6v3H9zM7 5H5v16h14V5h-2M8 11h8M8 15h5", // clipboard
  reviewing: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5", // check-shield
  checking: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  installing: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10", // package
  running: "M7 4l13 8-13 8z", // play
  handing_off: "M4 12h13M13 7l5 5-5 5M20 4v16", // hand-off arrow
};

export function ActivityIcon({
  activity,
  size = 18,
}: {
  activity: string | null | undefined;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ACT_PATHS[activity ?? ""] ?? "M12 7v5l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"} />
    </svg>
  );
}

export function Avatar({ agent, role, size = 40 }: { agent: string; role: string; size?: number }) {
  const n = /-(\d+)$/.exec(agent)?.[1];
  const code = (ROLE_CODES[role] ?? role.slice(0, 2)).toUpperCase();
  return (
    <span
      aria-hidden
      className="mono relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: roleColor(role),
        color: "var(--paper)",
        fontSize: size * 0.34,
      }}
    >
      {code}
      {n && n !== "1" && (
        <span className="absolute -right-1 -bottom-1 rounded-full border-2 border-[var(--surface)] bg-ink px-1 text-[9px] leading-[13px] text-paper">
          {n}
        </span>
      )}
    </span>
  );
}

export function ProgressBar({
  done,
  total,
  color = "var(--ink)",
  label,
}: {
  done: number;
  total: number;
  color?: string;
  label?: string;
}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={label ?? `${done} of ${total}`}
      className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

export function Checklist({ todos, color, max = 8 }: { todos: Todo[]; color: string; max?: number }) {
  const { done, total, current } = todoProgress(todos);
  // Keep the current step in view when the list is long.
  const idx = current ? todos.indexOf(current) : todos.findIndex((t) => t.status !== "completed");
  const startAt = Math.max(0, Math.min(todos.length - max, (idx < 0 ? todos.length : idx) - 2));
  const shown = todos.slice(startAt, startAt + max);
  return (
    <div data-testid="plan-checklist">
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="font-semibold">Plan</span>
        <span className="mono text-ink-3" data-testid="plan-progress">
          {done} of {total} steps
        </span>
      </div>
      <ProgressBar done={done} total={total} color={color} label={`${done} of ${total} steps done`} />
      <ul className="mt-2 flex flex-col gap-1">
        {startAt > 0 && <li className="mono pl-6 text-[11px] text-ink-3">… {startAt} earlier</li>}
        {shown.map((t, i) => {
          const st = t.status;
          return (
            <li
              key={`${startAt + i}-${t.content}`}
              className={`flex items-start gap-2 rounded-[2px] px-1 py-0.5 text-[12.5px] ${st === "in_progress" ? "bg-highlight/60 font-medium text-ink" : st === "completed" ? "text-ink-3" : "text-ink-3"}`}
              data-status={st}
            >
              <span
                aria-hidden
                className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[10px]"
                style={
                  st === "completed"
                    ? { background: color, borderColor: color, color: "var(--paper)" }
                    : st === "in_progress"
                      ? { borderColor: color }
                      : { borderColor: "var(--rule-strong)" }
                }
              >
                {st === "completed" ? (
                  "✓"
                ) : st === "in_progress" ? (
                  <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                ) : null}
              </span>
              <span className={st === "completed" ? "line-through" : ""}>
                {st === "in_progress" && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          );
        })}
        {startAt + max < todos.length && (
          <li className="mono pl-6 text-[11px] text-ink-3">… {todos.length - startAt - max} more</li>
        )}
      </ul>
    </div>
  );
}

export function StageTrack({ task }: { task: Task | null | undefined }) {
  if (!task) return null;
  if (task.kind === "planning" || task.kind === "answer") {
    return (
      <div className="mono text-[11.5px] text-ink-2" data-testid="stage-track">
        {PLANNING_LABELS[task.mode ?? ""] ?? task.mode ?? task.kind}
      </div>
    );
  }
  const cur = stageOf(task);
  const blocked = task.status === "blocked";
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="Task stage" data-testid="stage-track">
      {STAGES.map((s, i) => (
        <li key={s} className="flex items-center gap-1" aria-current={i === cur ? "step" : undefined}>
          <span
            className={`rounded-full border px-2 py-[1px] ${i === cur ? (blocked ? "border-danger bg-danger-soft font-semibold text-danger" : "border-ink bg-ink font-semibold text-paper") : i < cur ? "border-rule-strong text-ink-2" : "border-dashed border-rule-strong text-ink-3"}`}
          >
            {i < cur ? "✓ " : ""}
            {s}
            {i === cur && s === "Review" && task.review_round > 0 ? ` · round ${task.review_round + 1}` : ""}
            {i === cur && s === "Building" && task.review_round > 0
              ? ` · round ${task.review_round + 1}`
              : ""}
            {i === cur && blocked ? " · blocked" : ""}
          </span>
          {i < STAGES.length - 1 && <span className="h-px w-3 bg-rule-strong" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function FileChips({ files, max = 8 }: { files: Insight["files"]; max?: number }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="files-touched">
      {files.slice(0, max).map((f) => (
        <span
          key={f.path}
          title={f.path}
          className={`mono max-w-[200px] truncate rounded-[2px] border px-1.5 text-[11px] leading-[18px] ${f.wrote ? "border-ink-2 bg-surface font-medium text-ink" : "border-rule text-ink-3"}`}
        >
          {f.wrote ? "✎ " : ""}
          {f.path.split("/").pop()}
        </span>
      ))}
      {files.length > max && (
        <span className="mono text-[11px] leading-[18px] text-ink-3">+{files.length - max}</span>
      )}
    </div>
  );
}

function Moments({ moments }: { moments: Insight["moments"] }) {
  if (!moments.length) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="moments">
      {moments.map((m) => (
        <li
          key={m.id}
          className={`flex gap-2 text-[12.5px] ${m.tone === "ok" ? "text-ok" : m.tone === "bad" ? "font-medium text-danger" : m.tone === "talk" ? "text-ink-2 italic" : "text-ink-2"}`}
        >
          <span className="mono mt-[1px] w-11 shrink-0 text-[10.5px] text-ink-3 not-italic">
            {fmtAgo(m.ts).replace(" ago", "")}
          </span>
          <span className="min-w-0 break-words">{m.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------- cards

export function WorkingCard({
  pid,
  a,
  run,
  task,
  roleTitle,
  live,
  large = true,
}: {
  pid: string;
  a: Agent;
  run: Run | null;
  task: Task | null;
  roleTitle: string;
  live: boolean;
  large?: boolean;
}) {
  const now = useNow(1000, live);
  const [details, setDetails] = useState(false);
  const [stop, setStop] = useState(false);
  const pause = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/pause`, ["agents", "tasks"]);
  const kill = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/kill`, ["agents", "tasks"]);
  const { events } = useRunEvents(pid, run?.id ?? null, a.id);
  const insight = useMemo(
    () => deriveInsight(events, run, { label: a.last_action, activity: a.activity }),
    [events, run, a.last_action, a.activity],
  );
  const color = roleColor(a.role);
  const started = toDate(run?.started_at)?.getTime();
  const ended = toDate(run?.ended_at)?.getTime();
  const elapsed = started ? (ended ?? now) - started : 0;
  const taskId = task?.id ?? a.current_task ?? run?.task ?? null;
  const planning = live && !insight.todos && elapsed < 20_000;

  return (
    <article
      className="flex flex-col border border-rule bg-surface"
      style={{ boxShadow: `inset 0 3px 0 ${color}` }}
      data-testid={`agent-${a.id}`}
      aria-label={`${a.id}, ${roleTitle}`}
    >
      <header className="flex items-start gap-3 px-4 pt-4">
        <Avatar agent={a.id} role={a.role} size={large ? 44 : 36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[15px] font-semibold">{a.id}</span>
            <span className="text-[12px] text-ink-3">{roleTitle}</span>
          </div>
          {taskId && (
            <a
              className="block truncate text-[13px] text-ink-2 hover:underline"
              href={href(pid, "board", taskId)}
              title={task?.title}
            >
              <span className="mono font-medium text-ink">{taskId}</span> · {task?.title ?? ""}
            </a>
          )}
        </div>
        <span className={`flex items-center gap-1.5 text-[11.5px] ${live ? "text-ok" : "text-ink-3"}`}>
          <span
            className={`h-2 w-2 rounded-full ${live ? "pulse-dot" : ""}`}
            style={{ background: live ? "var(--ok)" : "var(--rule-strong)" }}
            aria-hidden
          />
          {live ? "working" : run?.ended_at ? `finished ${fmtAgo(run.ended_at)}` : "idle"}
        </span>
      </header>

      <div className="mt-3 flex items-center gap-2.5 px-4" data-testid="agent-status">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
        >
          <ActivityIcon activity={insight.activity} />
        </span>
        <span
          className={`min-w-0 truncate text-[16px] font-semibold ${live ? "status-shimmer" : ""}`}
          data-testid="agent-label"
        >
          {insight.label ?? (live ? "Getting started…" : "Idle")}
        </span>
      </div>

      <div className="mt-3 px-4">
        <StageTrack task={task} />
      </div>

      <div
        className="mt-3 grid gap-4 px-4 pb-3"
        style={{ gridTemplateColumns: large ? "minmax(0,1.15fr) minmax(0,1fr)" : "minmax(0,1fr)" }}
      >
        <div>
          {insight.todos ? (
            <Checklist todos={insight.todos} color={color} max={large ? 8 : 5} />
          ) : planning ? (
            <div aria-busy="true" data-testid="plan-skeleton">
              <div className="mb-1.5 text-[12px] font-semibold text-ink-3">Planning…</div>
              <div className="flex flex-col gap-1.5">
                {[80, 64, 72].map((w) => (
                  <div key={w} className="skeleton h-3" style={{ width: `${w}%` }} />
                ))}
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold">Activity</div>
              {insight.moments.length ? (
                <Moments moments={insight.moments} />
              ) : (
                <p className="text-[12px] text-ink-3">Nothing yet.</p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3">
          {insight.todos && insight.moments.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold">Recent</div>
              <Moments moments={insight.moments} />
            </div>
          )}
          {insight.files.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold">Files</div>
              <FileChips files={insight.files} />
            </div>
          )}
        </div>
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-3 border-t border-rule px-4 py-2">
        <span className="mono text-[12px] tabular" title="elapsed">
          ⏱ {elapsed ? fmtElapsed(elapsed) : "-"}
        </span>
        <span className="ml-auto" />
        {live && (
          <>
            <button
              className="btn btn-sm"
              disabled={pause.isPending}
              onClick={() =>
                pause.mutate(undefined, { onSuccess: () => toast(`${a.id} paused`), onError: toastError })
              }
            >
              <Icon name="pause" size={12} /> Pause
            </button>
            <button className="btn btn-sm" onClick={() => setStop(true)}>
              Stop
            </button>
          </>
        )}
        <button
          className="btn btn-sm"
          aria-expanded={details}
          onClick={() => setDetails((d) => !d)}
          data-testid="details-toggle"
        >
          {details ? "Hide details" : "Details"}
        </button>
      </footer>
      {details && <DetailsTranscript pid={pid} run={run} live={live} role={a.role} />}
      <Modal
        open={stop}
        onClose={() => setStop(false)}
        title={`Stop ${a.id}?`}
        footer={
          <>
            <button className="btn" onClick={() => setStop(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() =>
                kill.mutate(undefined, {
                  onSuccess: () => {
                    setStop(false);
                    toast(`${a.id} stopped`);
                  },
                  onError: toastError,
                })
              }
            >
              Stop now
            </button>
          </>
        }
      >
        The agent stops immediately and its task goes on hold. When you resume, it starts the task fresh (the
        files it already changed stay). Use Pause to keep its train of thought instead.
      </Modal>
    </article>
  );
}

function DetailsTranscript({
  pid,
  run,
  live,
  role,
}: {
  pid: string;
  run: Run | null;
  live: boolean;
  role: string;
}) {
  const { items, lastTs, loading } = useRunItems(pid, run?.id ?? null, live);
  return (
    <div className="flex h-[420px] flex-col border-t border-rule bg-paper" data-testid="agent-details">
      <TranscriptView items={items} active={live} lastTs={lastTs} role={role} loading={loading} />
    </div>
  );
}

export function IdleCard({
  pid,
  a,
  last,
  roleTitle,
  hasPaused,
  onDetails,
  selected,
}: {
  pid: string;
  a: Agent;
  last: Run | null;
  roleTitle: string;
  hasPaused: boolean;
  onDetails: () => void;
  selected: boolean;
}) {
  const resume = useAction(pid, "POST", `/agents/${encodeURIComponent(a.id)}/resume`, ["agents", "tasks"]);
  return (
    <div
      className={`flex items-center gap-2.5 border bg-surface px-3 py-2 ${selected ? "border-ink" : "border-rule"}`}
      data-testid={`agent-${a.id}`}
    >
      <Avatar agent={a.id} role={a.role} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold">{a.id}</span>
          <span className="truncate text-[11.5px] text-ink-3">{roleTitle}</span>
        </div>
        <div className="truncate text-[11.5px] text-ink-3">
          {hasPaused ? "paused" : "idle"}
          {last?.task ? ` · last: ${last.task}` : ""}
          {last?.ended_at ? ` · ${fmtAgo(last.ended_at)}` : ""}
        </div>
      </div>
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
      ) : last ? (
        <button className="btn btn-ghost btn-sm" onClick={onDetails} aria-expanded={selected}>
          Last run
        </button>
      ) : null}
    </div>
  );
}

export function roleTitleOf(roles: Record<string, { title: string }> | undefined, role: string): string {
  return roles?.[role]?.title ?? ROLE_LABELS[role] ?? role;
}
