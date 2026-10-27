export function fmtTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "∞";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

export function fmtInt(n: number | null | undefined): string {
  return Math.round(Number(n ?? 0)).toLocaleString("en-US");
}

/** SQLite timestamps come back as ISO strings; tolerate "YYYY-MM-DD HH:MM:SS" too. */
export function toDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.includes("T") || ts.endsWith("Z") ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtTime(ts: string | null | undefined): string {
  const d = toDate(ts);
  return d
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "";
}

export function fmtDateTime(ts: string | null | undefined): string {
  const d = toDate(ts);
  return d
    ? d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
}

export function fmtAgo(ts: string | null | undefined, now = Date.now()): string {
  const d = toDate(ts);
  if (!d) return "";
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtMinutes(min: number): string {
  if (min < 60) return `~${Math.round(min)} min`;
  const h = min / 60;
  return h < 10 ? `~${h.toFixed(1)} h` : `~${Math.round(h)} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
