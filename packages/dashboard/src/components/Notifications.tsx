import { useEffect, useRef, useState } from "react";
import { fmtAgo } from "../lib/format";
import { noteStore, prefs, targetHash, useNotes, type NoteEvent } from "../lib/notify";
import { useDocs, useProject, useQuestions } from "../lib/queries";
import { navigate } from "../lib/router";
import type { Notify } from "../lib/types";
import { Icon } from "./ui";

const LEVEL: Record<Notify["level"], { color: string; label: string }> = {
  action: { color: "var(--accent)", label: "needs you" },
  warning: { color: "var(--danger)", label: "warning" },
  success: { color: "var(--ok)", label: "done" },
  info: { color: "var(--ink-3)", label: "info" },
};

/** Action notifications still waiting on the owner (question open, document still submitted, change waiting). */
export function useUnresolved(pid: string): (ev: NoteEvent) => boolean {
  const questions = useQuestions(pid);
  const docs = useDocs(pid);
  const project = useProject(pid);
  return (ev) => {
    const n = ev.data.notify;
    if (n.level !== "action") return false;
    if (ev.type.startsWith("ask.")) {
      const mid = ev.data.message as string | undefined;
      if (!questions.data) return true;
      return questions.data.some((q) => q.status === "open" && (!mid || q.message_id === mid));
    }
    if (ev.type === "change.status") return project.data?.activeChange?.status === ev.data.status;
    if (n.doc) {
      const d = docs.data?.find((x) => x.name === n.doc);
      return d ? d.status === "submitted" : true;
    }
    return true;
  };
}

/** Open actions, keeping only the newest one per document (v1, v2, v3 of the PRD are one review). */
function openNeeds(notes: NoteEvent[], unresolved: (ev: NoteEvent) => boolean): NoteEvent[] {
  const latestDoc = new Map<string, number>();
  for (const n of notes) if (n.data.notify.doc) latestDoc.set(n.data.notify.doc, n.id);
  return notes.filter((n) => unresolved(n) && (!n.data.notify.doc || latestDoc.get(n.data.notify.doc) === n.id));
}

/** Unread action notifications that are still open (drives the tab title). */
export function useUnreadActions(pid: string): number {
  const { notes, lastSeen } = useNotes(pid);
  const open = useUnresolved(pid);
  return openNeeds(notes, open).filter((n) => n.id > lastSeen).length;
}

export function NotificationToasts({ pid }: { pid: string }) {
  const { toasts: all } = useNotes(pid);
  const unresolved = useUnresolved(pid);
  // An action toast disappears once it is handled (question answered, document approved).
  const toasts = all.filter((t) => t.ev.data.notify.level !== "action" || unresolved(t.ev));
  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed top-[96px] right-4 z-50 flex w-[360px] flex-col gap-2"
      aria-live="polite"
      data-testid="notify-toasts"
    >
      {toasts.map(({ key, ev }) => {
        const n = ev.data.notify;
        const lv = LEVEL[n.level] ?? LEVEL.info;
        return (
          <div
            key={key}
            role={n.level === "action" || n.level === "warning" ? "alert" : "status"}
            className="pointer-events-auto flex border border-rule-strong bg-surface shadow-lg"
            style={{ borderLeft: `4px solid ${lv.color}` }}
            data-testid="notify-toast"
            data-level={n.level}
          >
            <button
              className="min-w-0 flex-1 px-3 py-2.5 text-left"
              onClick={() => {
                noteStore(pid).dismiss(key);
                navigate(targetHash(pid, n));
              }}
            >
              <div className="mono mb-0.5 text-[10px] tracking-wide uppercase" style={{ color: lv.color }}>
                {lv.label}
              </div>
              <div className="text-[13.5px] font-semibold">{n.title}</div>
              {n.body && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-2">{n.body}</div>}
            </button>
            <button
              className="self-start px-2 py-2 text-ink-3 hover:text-ink"
              aria-label="Dismiss notification"
              onClick={() => noteStore(pid).dismiss(key)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      {label}
    </label>
  );
}

export function Bell({ pid }: { pid: string }) {
  const { notes, lastSeen } = useNotes(pid);
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(prefs.desktop());
  const [sound, setSound] = useState(prefs.sound());
  const [perm, setPerm] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const box = useRef<HTMLDivElement>(null);
  const unresolved = useUnresolved(pid);
  const unread = notes.filter((n) => n.id > lastSeen).length;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needs = openNeeds(notes, unresolved).reverse();
  const recent = [...notes].reverse().slice(0, 60);
  const go = (n: Notify) => {
    setOpen(false);
    navigate(targetHash(pid, n));
  };
  const item = (ev: NoteEvent) => {
    const n = ev.data.notify;
    const lv = LEVEL[n.level] ?? LEVEL.info;
    return (
      <li key={ev.id}>
        <button
          className={`flex w-full gap-2.5 px-4 py-2 text-left hover:bg-sunken ${ev.id > lastSeen ? "bg-highlight/40" : ""}`}
          onClick={() => go(n)}
          data-testid="notify-item"
        >
          <span
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
            style={{ background: lv.color }}
            aria-label={lv.label}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{n.title}</span>
            {n.body && <span className="block truncate text-[12px] text-ink-3">{n.body}</span>}
          </span>
          <span className="mono shrink-0 text-[10.5px] text-ink-3">{fmtAgo(ev.ts)}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="relative" ref={box}>
      <button
        className="btn btn-sm relative"
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="bell"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span
            className="mono absolute -top-1.5 -right-1.5 min-w-[17px] rounded-full bg-danger px-1 text-center text-[10px] leading-[17px] font-semibold text-danger-ink"
            data-testid="bell-count"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute top-[calc(100%+6px)] right-0 z-40 flex max-h-[70vh] w-[400px] flex-col border border-rule-strong bg-surface shadow-2xl"
          role="dialog"
          aria-label="Notifications"
          data-testid="bell-panel"
        >
          <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
            <span className="text-[14px] font-semibold">Notifications</span>
            <span className="mono text-[11px] text-ink-3">{unread} unread</span>
            <button
              className="ml-auto text-[12px] text-accent underline-offset-2 hover:underline disabled:opacity-40"
              disabled={!unread}
              onClick={() => noteStore(pid).markAllRead()}
            >
              Mark all read
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {needs.length > 0 && (
              <>
                <div className="mono px-4 pt-2 pb-1 text-[10.5px] tracking-wide text-accent">
                  NEEDS YOU · {needs.length}
                </div>
                <ul data-testid="needs-you">{needs.map(item)}</ul>
              </>
            )}
            <div className="mono px-4 pt-2 pb-1 text-[10.5px] tracking-wide text-ink-3">RECENT</div>
            {recent.length ? (
              <ul>{recent.map(item)}</ul>
            ) : (
              <p className="px-4 pb-4 text-[12.5px] text-ink-3">
                Nothing yet. Questions, approvals, blocked and finished tasks show up here.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-rule px-4 py-2.5">
            <Toggle
              label={
                perm === "denied"
                  ? "Desktop notifications (blocked in the browser settings)"
                  : perm === "unsupported"
                    ? "Desktop notifications (not supported here)"
                    : "Desktop notifications when this tab is in the background"
              }
              checked={desktop && perm === "granted"}
              testId="desktop-toggle"
              onChange={async (on) => {
                if (!on) {
                  prefs.setDesktop(false);
                  setDesktop(false);
                  return;
                }
                if (typeof Notification === "undefined") return;
                const p =
                  Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
                setPerm(p);
                prefs.setDesktop(p === "granted");
                setDesktop(p === "granted");
              }}
            />
            <Toggle
              label="Play a sound when something needs you"
              checked={sound}
              onChange={(on) => {
                prefs.setSound(on);
                setSound(on);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
