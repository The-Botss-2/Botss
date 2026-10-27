import { useState } from "react";
import { fmtDateTime } from "../lib/format";
import { useAction, useChanges } from "../lib/queries";
import { href } from "../lib/router";
import type { ChangeStatus, ProjectInfo } from "../lib/types";
import { PHASES } from "../lib/types";
import { Badge, ErrorBox, Icon, Modal, toast, toastError } from "./ui";

export const CHANGE_LABELS: Record<ChangeStatus, string> = {
  pm: "PM updating PRD",
  prd_review: "PRD needs your review",
  replan: "Tech lead replanning",
  plan_review: "Plan needs your review",
  applied: "Applied",
  cancelled: "Cancelled",
};

const ACTIVE: ChangeStatus[] = ["pm", "prd_review", "replan", "plan_review"];

function tone(s: ChangeStatus): "ok" | "warn" | "danger" | "neutral" {
  return s === "applied"
    ? "ok"
    : s === "prd_review" || s === "plan_review"
      ? "danger"
      : s === "cancelled"
        ? "neutral"
        : "warn";
}

export function ChangePill({ status }: { status: ChangeStatus }) {
  return <Badge tone={tone(status)}>{CHANGE_LABELS[status] ?? status}</Badge>;
}

/** Change requests are possible once the PRD has been approved (the server enforces it too). */
export function canRequestChange(p: ProjectInfo | undefined): boolean {
  if (!p) return false;
  return Boolean(p.activeChange) || PHASES.indexOf(p.phase) > PHASES.indexOf("prd_review");
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function ChangeDialog({ pid, open, onClose }: { pid: string; open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<{ name: string; data: string }[]>([]);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const submit = useAction<{ text: string; attachments: { name: string; data: string }[] }, { id: string }>(
    pid,
    "POST",
    "/changes",
    ["changes", "project", "tasks"],
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a change"
      testId="change-dialog"
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={text.trim().length < 3 || submit.isPending}
            onClick={() =>
              submit.mutate(
                { text: text.trim(), attachments: atts },
                {
                  onSuccess: (r) => {
                    toast(`${r.id} sent to the PM`);
                    setText("");
                    setAtts([]);
                    onClose();
                  },
                },
              )
            }
          >
            {submit.isPending ? "Sending…" : "Send change request"}
          </button>
        </>
      }
    >
      <p className="mb-3">
        Describe what to add, remove, or change. The PM updates the PRD, then the tech lead updates the plan;
        work already merged is kept.
      </p>
      <label className="label" htmlFor="change-text">
        The change
      </label>
      <textarea
        id="change-text"
        className="field min-h-[150px] text-[14px] text-ink"
        placeholder="Customers should be able to book two services in one visit (cut + beard), with one deposit."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="label mt-3" htmlFor="change-files">
        Attachments (optional, up to 10 MB each)
      </label>
      <input
        id="change-files"
        type="file"
        multiple
        className="block text-[13px] file:mr-3 file:border file:border-rule-strong file:bg-surface file:px-3 file:py-1 file:text-[13px]"
        onChange={async (e) => {
          setFileErr(null);
          const next: { name: string; data: string }[] = [];
          for (const f of Array.from(e.target.files ?? [])) {
            if (f.size > 10 * 1024 * 1024) setFileErr(`${f.name} is larger than 10 MB.`);
            else next.push({ name: f.name, data: await toBase64(f) });
          }
          setAtts(next);
        }}
      />
      {fileErr && <div className="mt-1 text-[12px] text-danger">{fileErr}</div>}
      {submit.error && (
        <div className="mt-3">
          <ErrorBox error={submit.error} />
        </div>
      )}
    </Modal>
  );
}

/** Callout for the active change request, with the next step for the owner. */
export function ChangeCallout({ pid, p }: { pid: string; p: ProjectInfo | undefined }) {
  const ch = p?.activeChange;
  const cancel = useAction(pid, "POST", `/changes/${encodeURIComponent(ch?.id ?? "")}/cancel`, [
    "changes",
    "project",
    "docs",
  ]);
  const [confirm, setConfirm] = useState(false);
  if (!ch || !ACTIVE.includes(ch.status)) return null;
  const review = ch.status === "prd_review" ? "prd" : ch.status === "plan_review" ? "plan" : null;
  return (
    <div
      className={`mb-5 flex flex-wrap items-center gap-3 border border-l-4 border-rule bg-surface px-4 py-3 ${review ? "border-l-[var(--danger)]" : "border-l-[var(--warn)]"}`}
      data-testid="change-callout"
    >
      <span className="mono text-[12px] font-semibold">{ch.id}</span>
      <ChangePill status={ch.status} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={ch.text}>
        {ch.text}
      </span>
      {review && (
        <a className="btn btn-primary btn-sm" href={href(pid, "docs", review)}>
          Review the updated {review === "prd" ? "PRD" : "plan"}
        </a>
      )}
      <button className="btn btn-sm" onClick={() => setConfirm(true)}>
        Cancel change
      </button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Cancel ${ch.id}?`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              Keep it
            </button>
            <button
              className="btn btn-danger"
              onClick={() =>
                cancel.mutate(undefined, {
                  onSuccess: () => {
                    setConfirm(false);
                    toast(`${ch.id} cancelled`);
                  },
                  onError: toastError,
                })
              }
            >
              Cancel change
            </button>
          </>
        }
      >
        The PM and tech lead stop working on this change. Documents already resubmitted stay as new versions.
      </Modal>
    </div>
  );
}

export function ChangesList({ pid, compact = false }: { pid: string; compact?: boolean }) {
  const q = useChanges(pid);
  if (q.error || !q.data?.length)
    return compact ? null : <p className="text-[13px] text-ink-3">No change requests yet.</p>;
  return (
    <ul
      className={`flex flex-col ${compact ? "gap-1" : "divide-y divide-rule border-y border-rule"}`}
      data-testid="changes-list"
    >
      {[...q.data].reverse().map((c) => (
        <li
          key={c.id}
          className={
            compact
              ? "text-[12px]"
              : "grid grid-cols-[72px_minmax(0,1fr)_auto] items-start gap-3 px-1 py-2.5 text-[13px]"
          }
        >
          {compact ? (
            <div className="flex flex-col gap-0.5 border-l-2 border-rule-strong pl-2">
              <span className="flex items-center gap-1.5">
                <span className="mono font-semibold">{c.id}</span>
                <ChangePill status={c.status} />
              </span>
              <span className="line-clamp-2 text-ink-2">{c.text}</span>
            </div>
          ) : (
            <>
              <span className="mono font-semibold">{c.id}</span>
              <span>
                <span className="block">{c.text}</span>
                <span className="mono text-[11px] text-ink-3">
                  {fmtDateTime(c.created_at)} · updated {fmtDateTime(c.updated_at)}
                </span>
              </span>
              <ChangePill status={c.status} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RequestChangeButton({ pid, p }: { pid: string; p: ProjectInfo | undefined }) {
  const [open, setOpen] = useState(false);
  if (!canRequestChange(p)) return null;
  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)} data-testid="request-change">
        <Icon name="docs" size={13} /> <span className="max-[1280px]:hidden">Request a change</span>
        <span className="min-[1281px]:hidden">Change</span>
      </button>
      <ChangeDialog pid={pid} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
