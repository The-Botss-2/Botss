import { useState } from "react";
import { Empty, Icon, Loadable, PageHeader, toast } from "../components/ui";
import { useAction, useProject } from "../lib/queries";

interface PreviewResult {
  ok: boolean;
  output: string;
  url: string | null;
}

export function PreviewScreen({ pid }: { pid: string }) {
  const project = useProject(pid);
  const [last, setLast] = useState<{ action: string; r: PreviewResult } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const start = useAction<unknown, PreviewResult>(pid, "POST", "/preview/start");
  const stop = useAction<unknown, PreviewResult>(pid, "POST", "/preview/stop");
  const reset = useAction<unknown, PreviewResult>(pid, "POST", "/preview/reset");
  const busy = start.isPending || stop.isPending || reset.isPending;
  const run = (action: string, m: typeof start) =>
    m.mutate(undefined, {
      onSuccess: (r) => {
        setLast({ action, r });
        if (r.ok) toast(`Preview ${action}: ok`);
      },
      onError: (e) => setLast({ action, r: { ok: false, output: e.message, url: null } }),
    });

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[480px] flex-col">
      <PageHeader
        title="Preview"
        kicker={
          project.data?.settings.workspace === "isolated"
            ? "the integration branch, running locally (docker compose)"
            : "your project folder, running locally (docker compose)"
        }
      >
        <button className="btn btn-primary" disabled={busy} onClick={() => run("start", start)}>
          {start.isPending ? "Starting…" : "Start"}
        </button>
        <button className="btn" disabled={busy} onClick={() => run("stop", stop)}>
          {stop.isPending ? "Stopping…" : "Stop"}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => run("reset", reset)}
          title="docker compose down -v, then up: wipes preview data"
        >
          {reset.isPending ? "Resetting…" : "Reset data"}
        </button>
      </PageHeader>
      {last && !last.r.ok && (
        <div
          role="alert"
          className="mb-3 border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-soft"
        >
          <div className="px-4 py-2 text-[13px] font-semibold text-danger">Preview {last.action} failed</div>
          <pre className="mono max-h-64 overflow-auto border-t border-[color-mix(in_srgb,var(--danger)_30%,transparent)] px-4 py-2 text-[11.5px] whitespace-pre-wrap text-ink">
            {last.r.output || "(no output)"}
          </pre>
        </div>
      )}
      <Loadable q={project}>
        {(p) =>
          p.previewUrl ? (
            <div className="flex min-h-0 flex-1 flex-col border border-rule-strong bg-surface">
              <div className="flex items-center gap-2 border-b border-rule px-3 py-1.5">
                <span className="h-2 w-2 rounded-full bg-ok" aria-hidden />
                <span className="mono flex-1 truncate text-[12px] text-ink-2">{p.previewUrl}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
                  Reload
                </button>
                <a
                  className="btn btn-ghost btn-sm"
                  href={p.previewUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Icon name="external" size={12} /> Open
                </a>
              </div>
              <iframe
                key={reloadKey}
                title="App preview"
                src={p.previewUrl}
                className="min-h-0 w-full flex-1 bg-white"
              />
            </div>
          ) : (
            <Empty title="The preview is not running">
              Start runs <code className="mono">docker compose up -d --build</code> on the integration branch.
              It needs Docker and the compose file the devops engineer writes in the scaffold task.
            </Empty>
          )
        }
      </Loadable>
    </div>
  );
}
