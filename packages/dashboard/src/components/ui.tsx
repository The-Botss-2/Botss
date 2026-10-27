import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ROLE_CODES, ROLE_LABELS, roleColor, roleOf, statusColor } from "../lib/roles";
import { STATUS_LABELS, type TaskStatus } from "../lib/types";

export function RoleChip({
  role,
  short = false,
  className = "",
}: {
  role: string | null | undefined;
  short?: boolean;
  className?: string;
}) {
  const r = roleOf(role);
  const label = short ? (ROLE_CODES[r] ?? r) : r;
  return (
    <span
      className={`mono inline-flex items-center gap-1 rounded-[2px] border px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap ${className}`}
      style={{
        color: roleColor(r),
        borderColor: `color-mix(in srgb, ${roleColor(r)} 45%, transparent)`,
        background: `color-mix(in srgb, ${roleColor(r)} 8%, transparent)`,
      }}
      title={ROLE_LABELS[r] ?? r}
    >
      {label}
    </span>
  );
}

/** Agent id in its role colour with a role tick. */
export function AgentName({ id, className = "" }: { id: string | null | undefined; className?: string }) {
  if (!id) return <span className="mono text-ink-3">-</span>;
  return (
    <span
      className={`mono inline-flex items-center gap-1.5 font-medium ${className}`}
      style={{ color: roleColor(id) }}
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-[1px]"
        style={{ background: roleColor(id) }}
      />
      {id}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: statusColor(status) }} />
      {STATUS_LABELS[status as TaskStatus] ?? status}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "warn" | "ok" | "accent";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-sunken text-ink-2 border-rule",
    danger: "bg-danger-soft text-danger border-[color-mix(in_srgb,var(--danger)_40%,transparent)]",
    warn: "bg-warn-soft text-warn border-[color-mix(in_srgb,var(--warn)_40%,transparent)]",
    ok: "bg-ok-soft text-ok border-[color-mix(in_srgb,var(--ok)_40%,transparent)]",
    accent: "bg-ink text-paper border-ink",
  };
  return (
    <span
      title={title}
      className={`mono inline-flex items-center rounded-[2px] border px-1.5 text-[10.5px] leading-[17px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function CountBadge({
  n,
  tone = "accent",
  label,
}: {
  n: number;
  tone?: "accent" | "danger";
  label?: string;
}) {
  if (!n) return null;
  return (
    <span
      aria-label={label ?? `${n}`}
      className={`mono inline-flex min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] leading-[18px] font-semibold ${tone === "danger" ? "bg-danger text-danger-ink" : "bg-ink text-paper"}`}
    >
      {n}
    </span>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 border border-dashed border-rule-strong bg-surface/60 px-6 py-8">
      <div className="mono text-[11px] text-ink-3">∅ nothing here yet</div>
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {children && <div className="max-w-[60ch] text-[13px] text-ink-2">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-soft px-4 py-3 text-[13px] text-danger"
    >
      <div>
        <div className="font-semibold">Something went wrong</div>
        <div className="mono mt-0.5 text-[12px] break-words">{msg}</div>
      </div>
      {retry && (
        <button className="btn btn-sm" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Wrapper for a query: skeleton, error with retry, or children. */
export function Loadable<T>({
  q,
  children,
  rows,
}: {
  q: { data: T | undefined; error: unknown; isLoading: boolean; refetch: () => unknown };
  children: (d: T) => ReactNode;
  rows?: number;
}) {
  if (q.error && q.data === undefined) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (q.isLoading || q.data === undefined) return <Skeleton rows={rows} />;
  return <>{children(q.data)}</>;
}

export function PageHeader({
  title,
  kicker,
  children,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-3">
      <div>
        {kicker && <div className="mono mb-1 text-[11px] text-ink-3">{kicker}</div>}
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** In-page modal built on <dialog> (focus trap + Esc for free). Never window.confirm. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const autoId = useId();
  const titleId = labelledBy ?? `${autoId}-title`;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div>
          <div className="border-b border-rule px-5 py-3">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {title}
            </h2>
          </div>
          <div className="px-5 py-4 text-[13.5px] text-ink-2">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-rule bg-sunken/50 px-5 py-3">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (t: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-0 border-b border-rule">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              const n = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
              onChange(tabs[n]!.id);
              refs.current[n]?.focus();
            }
          }}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${value === t.id ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
        >
          {t.label}
          {t.count ? <span className="mono ml-1.5 text-[11px] text-ink-3">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- toasts

type ToastT = { id: number; text: string; tone: "ok" | "danger" };
let toastId = 0;
const toastListeners = new Set<(t: ToastT[]) => void>();
let toasts: ToastT[] = [];
export function toast(text: string, tone: "ok" | "danger" = "ok"): void {
  const t = { id: ++toastId, text, tone };
  toasts = [...toasts, t].slice(-4);
  for (const l of toastListeners) l(toasts);
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    for (const l of toastListeners) l(toasts);
  }, 5000);
}
export function toastError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), "danger");
}
export function Toaster() {
  const [list, setList] = useState<ToastT[]>([]);
  useEffect(() => {
    toastListeners.add(setList);
    return () => {
      toastListeners.delete(setList);
    };
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.tone === "danger" ? "alert" : "status"}
          className={`pointer-events-auto max-w-sm border px-3 py-2 text-[13px] shadow-lg ${t.tone === "danger" ? "border-danger bg-danger-soft text-danger" : "border-rule-strong bg-surface text-ink"}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ icons

const PATHS: Record<string, string> = {
  projects: "M3 6h7l2 2h9v11H3z",
  idea: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z",
  questions: "M4 5h16v11H9l-5 4zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.4M12 14.5v.01",
  docs: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  design:
    "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.3-1-1.4-1-2.6 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3zM7.5 11.5v.01M10 7.5v.01M15 7.5v.01",
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6M2 20c0-3 2.7-5 6-5s6 2 6 5M16 15c3 0 6 1.8 6 5",
  board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z",
  agents: "M5 8h14v11H5zM9 4h6v4H9zM9 12v2M15 12v2M9 17h6",
  feed: "M4 6h16M4 10h11M4 14h16M4 18h8",
  preview: "M3 5h18v13H3zM8 21h8M12 18v3",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  close: "M6 6l12 12M18 6L6 18",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l13 8-13 8z",
  power: "M12 3v9M6.3 7.5a8 8 0 1 0 11.4 0",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  system: "M3 4h18v12H3zM8 20h8M12 16v4",
  chevron: "M9 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};

export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
