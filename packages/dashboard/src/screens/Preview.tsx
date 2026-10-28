import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Empty, Icon, PageHeader, Skeleton, toast } from "../components/ui";
import { api, pp } from "../lib/api";
import { useAction } from "../lib/queries";

interface PreviewStatus {
  running: boolean;
  url: string | null;
  command: string | null;
  source: string | null;
  log: string;
  startedAt: string | null;
  error: string | null;
  plan?: { command: string | null; url: string | null; source: string } | null;
}

/** The app running locally. Botss starts it when a build finishes; the owner can start, restart, or stop it. */
export function PreviewScreen({ pid }: { pid: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const status = useQuery({
    queryKey: ["p", pid, "project", "preview"],
    queryFn: () => api<PreviewStatus>("GET", pp(pid, "/preview")),
    // While the app is starting (running, no URL yet), poll for its URL.
    refetchInterval: (q) => (q.state.data?.running && !q.state.data.url ? 1500 : false),
  });
  const start = useAction<unknown, PreviewStatus>(pid, "POST", "/preview/start", ["project"]);
  const stop = useAction<unknown, PreviewStatus>(pid, "POST", "/preview/stop", ["project"]);
  const busy = start.isPending || stop.isPending;
  const s = status.data;
  const after = () => void status.refetch();

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[480px] flex-col">
      <PageHeader title="Preview" kicker="your app, running on this computer">
        <button
          className="btn btn-primary"
          disabled={busy}
          data-testid="preview-start"
          onClick={() => start.mutate(undefined, { onSuccess: (r) => (after(), r.error ? undefined : toast(s?.running ? "App restarted" : "App started")) })}
        >
          {start.isPending ? "Starting…" : s?.running ? "Restart" : "Start the app"}
        </button>
        <button className="btn" disabled={busy || !s?.running} onClick={() => stop.mutate(undefined, { onSuccess: after })}>
          {stop.isPending ? "Stopping…" : "Stop"}
        </button>
        <button className="btn" onClick={() => setShowLog((v) => !v)} aria-pressed={showLog}>
          {showLog ? "Hide log" : "Show log"}
        </button>
      </PageHeader>

      {!s ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2" data-testid="preview-info">
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${s.running ? "bg-ok" : "bg-[var(--ink-3)]"}`} aria-hidden />
              {s.running ? (s.url ? "Running" : "Starting…") : "Stopped"}
            </span>
            {(s.command ?? s.plan?.command) && (
              <span>
                runs <code className="mono text-ink">{s.command ?? s.plan?.command}</code>
              </span>
            )}
            {(s.source ?? s.plan?.source) && <span>(from {s.source ?? s.plan?.source})</span>}
            {!s.command && !s.plan && <span>No way to run this project was found yet. Set a preview command in Settings.</span>}
          </div>
          {s.error && (
            <div role="alert" className="mb-3 border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-soft px-4 py-2 text-[13px] text-danger">
              {s.error}
            </div>
          )}
          {showLog && (
            <pre className="mono mb-3 max-h-56 overflow-auto border border-rule bg-surface px-3 py-2 text-[11.5px] whitespace-pre-wrap" data-testid="preview-log">
              {s.log || "(no output yet)"}
            </pre>
          )}
          {s.running && s.url ? (
            <div className="flex min-h-0 flex-1 flex-col border border-rule-strong bg-surface">
              <div className="flex items-center gap-2 border-b border-rule px-3 py-1.5">
                <span className="h-2 w-2 rounded-full bg-ok" aria-hidden />
                <span className="mono flex-1 truncate text-[12px] text-ink-2" data-testid="preview-url">
                  {s.url}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
                  Reload
                </button>
                <a className="btn btn-ghost btn-sm" href={s.url} target="_blank" rel="noreferrer noopener">
                  <Icon name="external" size={12} /> Open in a new tab
                </a>
              </div>
              <iframe key={reloadKey} title="App preview" src={s.url} className="min-h-0 w-full flex-1 bg-white" />
            </div>
          ) : s.running ? (
            <Empty title="Starting your app…">The app is starting. Its address appears here as soon as it prints one (see the log).</Empty>
          ) : (
            <Empty title="The app is not running">
              Botss starts it automatically when a build finishes. You can also start it now with the button above.
            </Empty>
          )}
        </>
      )}
    </div>
  );
}
