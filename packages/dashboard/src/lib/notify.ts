import { useSyncExternalStore } from "react";
import type { BotssEvent, Notify } from "./types";

// Owner notifications: events that carry data.notify (see notificationFor in packages/server/src/service.ts).
// Past ones come from GET /notifications; only live WebSocket ones raise toasts and desktop notifications.

export type NoteEvent = BotssEvent & { data: BotssEvent["data"] & { notify: Notify } };

export interface Toast {
  key: number;
  ev: NoteEvent;
}

const MAX_TOASTS = 4;
const TOAST_MS: Record<Notify["level"], number | null> = {
  info: 6000,
  success: 6000,
  warning: 10_000,
  action: null,
};

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

export function isNote(e: BotssEvent): e is NoteEvent {
  const n = (e.data as { notify?: unknown } | undefined)?.notify;
  return Boolean(n && typeof n === "object" && "title" in (n as object));
}

export const prefs = {
  desktop: () => lsGet("botss.notify.desktop") === "1",
  setDesktop: (on: boolean) => lsSet("botss.notify.desktop", on ? "1" : "0"),
  sound: () => lsGet("botss.notify.sound") === "1",
  setSound: (on: boolean) => lsSet("botss.notify.sound", on ? "1" : "0"),
};

function beep(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
    o.onended = () => void ctx.close();
  } catch {
    /* no audio */
  }
}

export class NoteStore {
  readonly pid: string;
  notes: NoteEvent[] = [];
  toasts: Toast[] = [];
  lastSeen: number;
  private toastKey = 0;
  private listeners = new Set<() => void>();
  private snap: { notes: NoteEvent[]; toasts: Toast[]; lastSeen: number };

  constructor(pid: string) {
    this.pid = pid;
    this.lastSeen = Number(lsGet(`botss.notify.seen.${pid}`) ?? 0) || 0;
    this.snap = { notes: this.notes, toasts: this.toasts, lastSeen: this.lastSeen };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.snap;
  private emit() {
    this.snap = { notes: this.notes, toasts: this.toasts, lastSeen: this.lastSeen };
    for (const l of this.listeners) l();
  }

  /** Past notifications (HTTP backfill): listed in the bell, never toasted. */
  backfill(evs: BotssEvent[]): void {
    const known = new Set(this.notes.map((n) => n.id));
    const add = evs.filter((e) => isNote(e) && !known.has(e.id)) as NoteEvent[];
    if (!add.length) return;
    this.notes = [...this.notes, ...add].sort((a, b) => a.id - b.id).slice(-500);
    this.emit();
  }

  /** Live events from the WebSocket: list + toast + desktop notification. */
  live(evs: BotssEvent[]): void {
    const known = new Set(this.notes.map((n) => n.id));
    const add = evs.filter((e) => isNote(e) && !known.has(e.id)) as NoteEvent[];
    if (!add.length) return;
    this.notes = [...this.notes, ...add].sort((a, b) => a.id - b.id).slice(-500);
    for (const ev of add) {
      const key = ++this.toastKey;
      this.toasts = [...this.toasts, { key, ev }].slice(-MAX_TOASTS);
      const ms = TOAST_MS[ev.data.notify.level];
      if (ms) setTimeout(() => this.dismiss(key), ms);
      this.desktop(ev);
    }
    this.emit();
  }

  private desktop(ev: NoteEvent): void {
    const n = ev.data.notify;
    if (n.level === "action" && prefs.sound()) beep();
    if (n.level === "info" || !prefs.desktop() || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted" || document.visibilityState !== "hidden") return;
    try {
      const d = new Notification(n.title, { body: n.body ?? "", tag: String(ev.id) });
      d.onclick = () => {
        window.focus();
        window.location.hash = targetHash(this.pid, n);
        d.close();
      };
    } catch {
      /* not supported */
    }
  }

  dismiss(key: number): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.key !== key);
    if (this.toasts.length !== before) this.emit();
  }

  markAllRead(): void {
    const max = this.notes.at(-1)?.id ?? this.lastSeen;
    if (max === this.lastSeen) return;
    this.lastSeen = max;
    lsSet(`botss.notify.seen.${this.pid}`, String(max));
    this.emit();
  }
}

const stores = new Map<string, NoteStore>();
export function noteStore(pid: string): NoteStore {
  let s = stores.get(pid);
  if (!s) {
    s = new NoteStore(pid);
    stores.set(pid, s);
  }
  return s;
}

export function useNotes(pid: string) {
  const s = noteStore(pid);
  return useSyncExternalStore(s.subscribe, s.snapshot, s.snapshot);
}

/** Where clicking a notification goes. */
export function targetHash(pid: string, n: Notify): string {
  const p = `#/p/${encodeURIComponent(pid)}`;
  if (n.screen === "board") return n.task ? `${p}/board/${encodeURIComponent(n.task)}` : `${p}/board`;
  if (n.screen === "docs")
    return n.doc ? `${p}/docs/${n.doc.split("/").map(encodeURIComponent).join("/")}` : `${p}/docs`;
  return `${p}/${n.screen || "questions"}`;
}
