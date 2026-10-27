import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api, getToken, pp } from "./api";
import type { BotssEvent } from "./types";

// Live updates. One WebSocket per open project. The server batches events every 100 ms and says which query
// topics changed; we coalesce invalidations for another ~150 ms so a burst of 10 streaming agents causes a
// handful of refetches, not hundreds. Events are also appended to an in-memory store that the feed, agents and
// drawer timelines read without refetching.

const MAX_EVENTS = 20_000;

type Listener = () => void;

export class EventStore {
  events: BotssEvent[] = [];
  lastId = 0;
  loaded = false;
  status: "connecting" | "live" | "offline" = "connecting";
  private listeners = new Set<Listener>();
  private snapshotObj = { events: this.events, loaded: false, status: this.status as EventStore["status"] };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = () => this.snapshotObj;

  private emit(): void {
    this.snapshotObj = { events: this.events, loaded: this.loaded, status: this.status };
    for (const l of this.listeners) l();
  }

  setStatus(s: EventStore["status"]): void {
    if (s === this.status) return;
    this.status = s;
    this.emit();
  }

  add(evs: BotssEvent[], markLoaded = false): void {
    const fresh = evs.filter((e) => e.id > this.lastId);
    if (fresh.length) {
      // Out-of-order safety: merge then sort only when needed.
      let next = this.events.concat(fresh);
      if (fresh.some((e, i) => i > 0 && e.id < fresh[i - 1]!.id)) next.sort((a, b) => a.id - b.id);
      if (next.length > MAX_EVENTS) next = next.slice(next.length - MAX_EVENTS);
      this.events = next;
      this.lastId = next[next.length - 1]!.id;
    } else if (evs.length) {
      // Initial load may arrive after some WS events: fold in older ones.
      const known = new Set(this.events.map((e) => e.id));
      const older = evs.filter((e) => !known.has(e.id));
      if (older.length) this.events = [...older, ...this.events].sort((a, b) => a.id - b.id);
    }
    if (markLoaded) this.loaded = true;
    if (fresh.length || markLoaded || evs.length) this.emit();
  }
}

const stores = new Map<string, EventStore>();
export function eventStore(pid: string): EventStore {
  let s = stores.get(pid);
  if (!s) {
    s = new EventStore();
    stores.set(pid, s);
  }
  return s;
}

export function useEvents(pid: string): {
  events: BotssEvent[];
  loaded: boolean;
  status: EventStore["status"];
} {
  const s = eventStore(pid);
  return useSyncExternalStore(s.subscribe, s.snapshot, s.snapshot);
}

/** Connect the project's live channel. Mounted once by the project shell. */
export function useLive(pid: string, qc: QueryClient): void {
  useEffect(() => {
    const store = eventStore(pid);
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      flushTimer = undefined;
      const topics = [...pending];
      pending.clear();
      for (const t of topics) void qc.invalidateQueries({ queryKey: ["p", pid, t] });
    };
    const queue = (topics: string[]) => {
      for (const t of topics) {
        pending.add(t);
        // The project summary carries openQuestions, activeRuns and board counts, but the server's topicsFor() does not
        // list "project" for ask/run/task events, so the header would go stale. Refresh it alongside.
        if (t === "questions" || t === "agents" || t === "tasks") pending.add("project");
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    };

    const backfill = async () => {
      try {
        const q = store.lastId ? `?after=${store.lastId}&limit=5000` : "?limit=1000";
        const evs = await api<BotssEvent[]>("GET", pp(pid, `/events${q}`));
        store.add(evs, true);
      } catch {
        /* the socket retry will try again */
      }
    };

    const connect = () => {
      if (closed) return;
      store.setStatus("connecting");
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(getToken() ?? "")}&project=${encodeURIComponent(pid)}`;
      ws = new WebSocket(url);
      ws.onmessage = (m) => {
        let msg: { type: string; events?: BotssEvent[]; topics?: string[] };
        try {
          msg = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (msg.type === "hello") {
          const wasRetry = retry > 0 || store.loaded;
          retry = 0;
          store.setStatus("live");
          void backfill();
          // After a reconnect everything may be stale.
          if (wasRetry) void qc.invalidateQueries({ queryKey: ["p", pid] });
        } else if (msg.type === "events") {
          if (msg.events?.length) store.add(msg.events);
          if (msg.topics?.length) queue(msg.topics);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        store.setStatus("offline");
        retry++;
        retryTimer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(retry, 5)));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
      ws?.close();
    };
  }, [pid, qc]);
}
