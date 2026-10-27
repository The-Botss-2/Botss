import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DiffView } from "../components/Diff";
import { Markdown } from "../components/Markdown";
import {
  AgentName,
  Badge,
  Empty,
  ErrorBox,
  Icon,
  Loadable,
  PageHeader,
  RoleChip,
  Skeleton,
  StatusPill,
  Tabs,
  toast,
  toastError,
} from "../components/ui";
import { fmtDateTime, fmtTime, toDate } from "../lib/format";
import { statusColor } from "../lib/roles";
import { useAction, useTask, useTaskDiff, useTasks } from "../lib/queries";
import { href, navigate } from "../lib/router";
import { STATUS_LABELS, TASK_STATUSES, type Task, type TaskDetail } from "../lib/types";
import { Glyph } from "./Feed";

const BOARD_KINDS = new Set(["build", "integrate", "release"]);

export function BoardScreen({ pid, taskId }: { pid: string; taskId: string | null }) {
  const tasks = useTasks(pid);
  const [stripOpen, setStripOpen] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Live board" kicker="build · review · qa · merge">
        {tasks.data && <BoardCounts tasks={tasks.data.filter((t) => BOARD_KINDS.has(t.kind))} />}
      </PageHeader>
      <Loadable q={tasks} rows={6}>
        {(all) => {
          const board = all.filter((t) => BOARD_KINDS.has(t.kind));
          const side = all.filter((t) => !BOARD_KINDS.has(t.kind));
          return (
            <>
              {side.length > 0 && (
                <section
                  className="mb-4 border border-rule bg-surface"
                  aria-label="Planning and answer tasks"
                >
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px]"
                    aria-expanded={stripOpen}
                    onClick={() => setStripOpen((o) => !o)}
                  >
                    <span className="mono text-ink-3">{stripOpen ? "▾" : "▸"}</span>
                    <span className="font-medium">Planning & answer tasks</span>
                    <span className="mono text-ink-3">
                      {side.filter((t) => t.status !== "done").length} active · {side.length} total
                    </span>
                  </button>
                  {stripOpen && (
                    <div className="flex flex-wrap gap-2 border-t border-rule px-3 py-2">
                      {side.map((t) => (
                        <a
                          key={t.id}
                          href={href(pid, "board", t.id)}
                          className="flex items-center gap-2 border border-rule bg-paper px-2 py-1 text-[12px] hover:border-rule-strong"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: statusColor(t.status) }}
                            aria-label={STATUS_LABELS[t.status]}
                          />
                          <span className="mono font-medium">{t.id}</span>
                          <RoleChip role={t.role} short />
                          <span className="max-w-[260px] truncate text-ink-2">{t.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {board.length === 0 ? (
                <Empty title="No tasks yet">
                  The plan appears here after the tech lead submits it and you approve it in the Team builder.
                </Empty>
              ) : (
                <Columns pid={pid} tasks={board} />
              )}
            </>
          );
        }}
      </Loadable>
      {taskId && <TaskDrawer pid={pid} id={taskId} onClose={() => navigate(href(pid, "board"))} />}
    </div>
  );
}

function BoardCounts({ tasks }: { tasks: Task[] }) {
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return (
    <div className="flex items-center gap-3" aria-label={`${done} of ${tasks.length} tasks done`}>
      <div className="mono text-[12px] text-ink-2">
        <span className="font-semibold text-ink" data-testid="done-count">
          {done}
        </span>
        /{tasks.length} done
      </div>
      <div className="flex h-2 w-40 overflow-hidden border border-rule-strong bg-sunken" aria-hidden>
        {TASK_STATUSES.map((s) => {
          const n = tasks.filter((t) => t.status === s).length;
          return n ? (
            <div
              key={s}
              style={{ width: `${(n / tasks.length) * 100}%`, background: statusColor(s) }}
              title={`${STATUS_LABELS[s]}: ${n}`}
            />
          ) : null;
        })}
      </div>
      <span className="mono text-[12px] text-ink-3">{pct}%</span>
    </div>
  );
}

function Columns({ pid, tasks }: { pid: string; tasks: Task[] }) {
  const by = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const s of TASK_STATUSES) m.set(s, []);
    for (const t of tasks) m.get(t.status)?.push(t);
    return m;
  }, [tasks]);
  return (
    <div
      className="grid min-h-0 flex-1 auto-cols-[minmax(132px,1fr)] grid-flow-col gap-px overflow-x-auto border border-rule bg-rule"
      data-testid="board"
    >
      {TASK_STATUSES.map((s) => {
        const list = by.get(s) ?? [];
        return (
          <section
            key={s}
            className="flex min-h-[420px] flex-col bg-paper"
            aria-label={`${STATUS_LABELS[s]} column, ${list.length} tasks`}
            data-testid={`col-${s}`}
          >
            <header className="sticky top-0 flex items-center gap-2 border-b border-rule bg-surface px-2.5 py-2">
              <span className="h-2 w-2 rounded-full" style={{ background: statusColor(s) }} aria-hidden />
              <h2 className="text-[12px] font-semibold">{STATUS_LABELS[s]}</h2>
              <span className="mono ml-auto text-[11px] text-ink-3">{list.length}</span>
            </header>
            <ul className="flex flex-col gap-1.5 p-1.5">
              {list.map((t) => (
                <li key={t.id}>
                  <Card pid={pid} t={t} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const Card = memo(function Card({ pid, t }: { pid: string; t: Task }) {
  const fresh = Date.now() - (toDate(t.updated_at)?.getTime() ?? 0) < 4000;
  return (
    <a
      href={href(pid, "board", t.id)}
      data-testid={`card-${t.id}`}
      className={`block border border-rule bg-surface px-2.5 py-2 hover:border-rule-strong ${fresh ? "flash-in" : ""}`}
      style={{ borderLeft: `3px solid ${statusColor(t.status)}` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="mono text-[11.5px] font-semibold">{t.id}</span>
        {t.kind !== "build" && <Badge>{t.kind}</Badge>}
        <span className="ml-auto">
          <RoleChip role={t.role} short />
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug">{t.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {t.assignee && <AgentName id={t.assignee} className="text-[11px]" />}
        {t.review_round > 0 && <Badge title="Review round">R{t.review_round}</Badge>}
        {t.done_status === "DONE_WITH_CONCERNS" && <Badge tone="warn">concerns</Badge>}
        {t.status === "blocked" && (
          <Badge tone="danger" title={t.blocked_reason ?? undefined}>
            blocked{t.blocked_on ? ` on ${t.blocked_on}` : ""}
          </Badge>
        )}
        {(t.bugs ?? 0) > 0 && (
          <Badge tone="danger">
            {t.bugs} bug{t.bugs === 1 ? "" : "s"}
          </Badge>
        )}
        {t.hold && <Badge tone="warn">hold: {t.hold}</Badge>}
      </div>
    </a>
  );
});

// ---------------------------------------------------------------------------------------------- drawer

type DTab = "file" | "timeline" | "handoff" | "review" | "qa" | "diff" | "verify";

export function TaskDrawer({ pid, id, onClose }: { pid: string; id: string; onClose: () => void }) {
  const q = useTask(pid, id);
  const [tab, setTab] = useState<DTab>("file");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const unblock = useAction(pid, "POST", `/tasks/${encodeURIComponent(id)}/unblock`, ["tasks"]);
  const hold = useAction(pid, "POST", `/tasks/${encodeURIComponent(id)}/hold`, ["tasks"]);
  const release = useAction(pid, "POST", `/tasks/${encodeURIComponent(id)}/release`, ["tasks"]);
  const d = q.data;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-[rgb(16_18_23/0.25)]" onClick={onClose} aria-hidden />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Task ${id}`}
        data-testid="task-drawer"
        className="fixed top-0 right-0 bottom-0 z-40 flex w-[min(860px,calc(100vw-120px))] flex-col border-l border-rule-strong bg-paper shadow-2xl outline-none"
      >
        <header className="flex items-start gap-3 border-b border-rule bg-surface px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[15px] font-semibold">{id}</span>
              {d && <RoleChip role={d.task.role} />}
              {d && <StatusPill status={d.task.status} />}
              {d?.task.assignee && <AgentName id={d.task.assignee} className="text-[12px]" />}
              {d?.task.hold && <Badge tone="warn">hold: {d.task.hold}</Badge>}
            </div>
            <div className="mt-1 truncate text-[14px] font-medium">{d?.task.title ?? ""}</div>
            {d?.task.blocked_reason && (
              <div className="mt-1 text-[12.5px] text-danger">
                Blocked on {d.task.blocked_on}: {d.task.blocked_reason}
              </div>
            )}
          </div>
          {d && (
            <div className="flex items-center gap-2">
              {d.task.status === "blocked" && (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    unblock.mutate(undefined, {
                      onSuccess: () => toast(`${id} unblocked`),
                      onError: toastError,
                    })
                  }
                >
                  Unblock
                </button>
              )}
              {d.task.hold ? (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    release.mutate(undefined, {
                      onSuccess: () => toast(`${id} released`),
                      onError: toastError,
                    })
                  }
                >
                  Release
                </button>
              ) : (
                d.task.status !== "done" && (
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      hold.mutate(undefined, { onSuccess: () => toast(`${id} on hold`), onError: toastError })
                    }
                  >
                    Hold
                  </button>
                )
              )}
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close task">
            <Icon name="close" size={14} />
          </button>
        </header>
        {q.error ? (
          <div className="p-5">
            <ErrorBox error={q.error} retry={() => void q.refetch()} />
          </div>
        ) : !d ? (
          <div className="p-5">
            <Skeleton rows={8} />
          </div>
        ) : (
          <>
            <div className="px-5 pt-2">
              <Tabs<DTab>
                label="Task details"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "file", label: "Task file" },
                  { id: "timeline", label: "Timeline", count: d.events.length },
                  { id: "handoff", label: "Handoff", count: d.handoffs.length },
                  { id: "review", label: "Review", count: d.reviews.length },
                  { id: "qa", label: "QA", count: d.qa.length + d.bugs.length },
                  { id: "diff", label: "Diff" },
                  { id: "verify", label: "Verify" },
                ]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <DrawerTab pid={pid} d={d} tab={tab} />
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function DrawerTab({ pid, d, tab }: { pid: string; d: TaskDetail; tab: DTab }) {
  const t = d.task;
  switch (tab) {
    case "file":
      return (
        <div className="flex flex-col gap-4">
          <dl className="mono grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-ink-3">owns</dt>
            <dd>{t.owns.join(", ") || "-"}</dd>
            {t.may_touch.length > 0 && (
              <>
                <dt className="text-ink-3">may touch</dt>
                <dd>{t.may_touch.join(", ")}</dd>
              </>
            )}
            <dt className="text-ink-3">after</dt>
            <dd>{t.after.join(", ") || "-"}</dd>
            <dt className="text-ink-3">verify</dt>
            <dd className="break-all">{t.verify || "-"}</dd>
            <dt className="text-ink-3">branch</dt>
            <dd>{t.branch ?? "-"}</dd>
            <dt className="text-ink-3">size · rounds</dt>
            <dd>
              {t.size} · review {t.review_round} · qa {t.qa_round}
            </dd>
          </dl>
          {t.source ? (
            <div className="border border-rule bg-surface px-5 py-4">
              <Markdown text={t.source.replace(/^---\n[\s\S]*?\n---\n?/, "")} />
            </div>
          ) : t.body ? (
            <div className="border border-rule bg-surface px-5 py-4">
              <Markdown text={t.body} />
            </div>
          ) : null}
        </div>
      );
    case "timeline":
      return d.events.length ? (
        <ol className="flex flex-col">
          {[...d.events].reverse().map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[64px_16px_120px_minmax(0,1fr)] items-baseline gap-2 border-b border-rule py-1.5 text-[12.5px]"
            >
              <span className="mono text-[11px] text-ink-3">{fmtTime(e.ts)}</span>
              <Glyph type={e.type} />
              <span className="truncate">
                {e.actor ? (
                  <AgentName id={e.actor} className="text-[11.5px]" />
                ) : (
                  <span className="mono text-[11px] text-ink-3">botss</span>
                )}
              </span>
              <span className="min-w-0 break-words text-ink-2">{e.summary}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-ink-3">No events yet.</p>
      );
    case "handoff":
      return d.handoffs.length ? (
        <div className="flex flex-col gap-4" data-testid="handoff">
          {[...d.handoffs].reverse().map((h) => (
            <article key={h.id} className="border border-rule bg-surface">
              <header className="flex items-center gap-2 border-b border-rule px-4 py-2 text-[12px]">
                <AgentName id={h.agent} />
                <Badge tone={h.status === "DONE" ? "ok" : "warn"}>{h.status}</Badge>
                <span className="mono ml-auto text-ink-3">
                  {h.head_sha?.slice(0, 7)} · {fmtDateTime(h.created_at)}
                </span>
              </header>
              <div className="px-5 py-3">
                <Markdown text={h.content} />
              </div>
              {h.verify_output && (
                <details className="border-t border-rule px-4 py-2">
                  <summary className="mono cursor-pointer text-[11.5px] text-ink-3">verify output</summary>
                  <pre className="mono mt-2 max-h-72 overflow-auto text-[11.5px] whitespace-pre-wrap">
                    {h.verify_output}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">
          No handoff yet. The engineer writes one when the task is done.
        </p>
      );
    case "review":
      return d.reviews.length ? (
        <div className="flex flex-col gap-4">
          {d.reviews.map((r) => (
            <article key={r.id} className="border border-rule bg-surface">
              <header className="flex items-center gap-2 border-b border-rule px-4 py-2 text-[12px]">
                <span className="mono font-semibold">round {r.round}</span>
                <AgentName id={r.reviewer} />
                <Badge
                  tone={r.verdict === "approved" ? "ok" : r.verdict === "pending" ? "neutral" : "danger"}
                >
                  {r.verdict.replace("_", " ")}
                </Badge>
                <span className="mono ml-auto text-ink-3">{fmtDateTime(r.created_at)}</span>
              </header>
              <div className="px-4 py-3 text-[13px]">
                {r.summary && <p className="mb-2">{r.summary}</p>}
                {r.comments.length > 0 && (
                  <ul className="flex flex-col gap-1.5">
                    {r.comments.map((c) => (
                      <li key={c.id} className="grid grid-cols-[70px_minmax(0,1fr)] gap-2 text-[12.5px]">
                        <Badge
                          tone={c.severity === "blocker" || c.severity === "major" ? "danger" : "neutral"}
                        >
                          {c.severity}
                        </Badge>
                        <span>
                          {c.file && (
                            <span className="mono mr-1.5 text-ink-3">
                              {c.file}
                              {c.line ? `:${c.line}` : ""}
                            </span>
                          )}
                          {c.body}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.content && (
                  <div className="mt-3 border-t border-rule pt-3">
                    <Markdown text={r.content} />
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">Not reviewed yet.</p>
      );
    case "qa":
      return d.qa.length || d.bugs.length ? (
        <div className="flex flex-col gap-4">
          {d.bugs.length > 0 && (
            <ul className="divide-y divide-rule border border-rule bg-surface">
              {d.bugs.map((b) => (
                <li key={b.id} className="px-4 py-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="mono font-semibold">{b.id}</span>
                    <Badge tone={b.status === "open" ? "danger" : "ok"}>{b.status}</Badge>
                    <Badge>{b.severity}</Badge>
                    <span>{b.title}</span>
                  </div>
                  {b.content && (
                    <pre className="mono mt-1 text-[11.5px] whitespace-pre-wrap text-ink-2">{b.content}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
          {[...d.qa].reverse().map((r) => (
            <article key={r.id} className="border border-rule bg-surface">
              <header className="flex items-center gap-2 border-b border-rule px-4 py-2 text-[12px]">
                <span className="mono font-semibold">round {r.round}</span>
                <AgentName id={r.agent} />
                <Badge tone={r.verdict === "pass" ? "ok" : "danger"}>{r.verdict}</Badge>
                <span className="mono ml-auto text-ink-3">{fmtDateTime(r.created_at)}</span>
              </header>
              <div className="px-5 py-3">
                <Markdown text={r.content} />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">No QA report yet.</p>
      );
    case "diff":
      return <TaskDiff pid={pid} id={t.id} />;
    case "verify":
      return t.meta.lastVerify ? (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[12.5px]">
            <Badge tone={t.meta.lastVerify.code === 0 ? "ok" : "danger"}>exit {t.meta.lastVerify.code}</Badge>
            <span className="mono text-ink-3">{t.verify}</span>
            <span className="mono ml-auto text-[11px] text-ink-3">{fmtDateTime(t.meta.lastVerify.at)}</span>
          </div>
          <pre className="mono max-h-[60vh] overflow-auto border border-rule bg-sunken p-3 text-[11.5px] whitespace-pre-wrap">
            {t.meta.lastVerify.output || "(no output)"}
          </pre>
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">
          Botss has not run this task's verify command yet (<code className="mono">{t.verify || "none"}</code>
          ).
        </p>
      );
  }
}

function TaskDiff({ pid, id }: { pid: string; id: string }) {
  const q = useTaskDiff(pid, id, true);
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton rows={8} />;
  if (!q.data.diff)
    return <p className="text-[13px] text-ink-3">No diff yet: the task has no branch or no commits.</p>;
  return (
    <div data-testid="task-diff">
      <div className="mono mb-2 text-[11px] text-ink-3">
        {q.data.base?.slice(0, 7)}…{q.data.head?.slice(0, 12)}
      </div>
      <DiffView diff={q.data.diff} />
    </div>
  );
}
