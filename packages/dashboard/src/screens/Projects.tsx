import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FolderPicker } from "../components/FolderPicker";
import { Badge, Empty, ErrorBox, Icon, Skeleton, toastError } from "../components/ui";
import { api } from "../lib/api";
import { useFsHome, useProjects } from "../lib/queries";
import { href, navigate } from "../lib/router";
import { PHASE_LABELS } from "../lib/types";

export function ProjectsScreen({ openPath = null }: { openPath?: string | null }) {
  const q = useProjects();
  const fsHome = useFsHome();
  const [picker, setPicker] = useState<{ path: string | null } | null>(null);
  // Deep link #/open?path=... (botss up in a folder that is not a project yet) opens the picker there.
  const pickerOpen = picker !== null || openPath !== null;
  const pickerPath = picker?.path ?? openPath ?? null;
  const closePicker = () => {
    setPicker(null);
    if (openPath !== null) navigate("#/", true);
  };
  const launch = fsHome.data?.launchDir && !fsHome.data.launchIsProject ? fsHome.data.launchDir : null;
  const qc = useQueryClient();
  const [root, setRoot] = useState("");
  const [init, setInit] = useState(false);
  const open = useMutation({
    mutationFn: (b: { root: string; init: boolean }) =>
      api<{ id: string; name: string; root: string }>("POST", "/api/projects", b),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(href(r.id, ""));
    },
  });

  return (
    <div className="canvas min-h-full">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mono mb-1 text-[12px] text-ink-3">botss · local AI software team</div>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-[28px] font-semibold tracking-[-0.015em]">Projects</h1>
          <button
            className="btn btn-primary h-10 px-5 text-[14px]"
            onClick={() => setPicker({ path: null })}
            data-testid="open-folder"
          >
            <Icon name="projects" size={16} /> Open a folder
          </button>
        </div>
        {launch && openPath === null && (
          <div
            className="mb-8 flex flex-wrap items-center gap-4 border border-l-4 border-rule border-l-[var(--ink)] bg-surface px-5 py-4"
            data-testid="launch-banner"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">
                Open <span className="mono break-all">{launch}</span> in Botss?
              </div>
              <div className="text-[12.5px] text-ink-3">
                You ran <code className="mono">botss up</code> in this folder. It is not a Botss project yet.
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setPicker({ path: launch })}>
              Open a folder
            </button>
          </div>
        )}
        <FolderPicker
          key={pickerPath ?? "_"}
          open={pickerOpen}
          onClose={closePicker}
          initialPath={pickerPath}
        />

        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-8 max-[900px]:grid-cols-1">
          <section aria-labelledby="known">
            <h2 id="known" className="section-title mb-3">
              KNOWN PROJECTS
            </h2>
            {q.error ? (
              <ErrorBox error={q.error} retry={() => void q.refetch()} />
            ) : q.isLoading ? (
              <Skeleton rows={4} />
            ) : !q.data?.length ? (
              <Empty title="No projects yet">
                Open a folder on the right. Botss keeps its state in a <code className="mono">.botss</code>{" "}
                folder inside it.
              </Empty>
            ) : (
              <ul className="divide-y divide-rule border-y border-rule">
                {q.data.map((p) => (
                  <li key={p.id}>
                    <button
                      className="group flex w-full items-center gap-4 px-2 py-3 text-left hover:bg-surface disabled:opacity-60"
                      disabled={open.isPending}
                      onClick={() =>
                        p.open
                          ? navigate(href(p.id, ""))
                          : open.mutate({ root: p.root, init: false }, { onError: toastError })
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-semibold">
                          {p.name ?? p.root.split(/[\\/]/).pop()}
                        </div>
                        <div className="mono truncate text-[12px] text-ink-3">{p.root}</div>
                      </div>
                      {p.phase && <Badge>{PHASE_LABELS[p.phase] ?? p.phase}</Badge>}
                      {!p.exists ? (
                        <Badge tone="danger">missing</Badge>
                      ) : p.open ? (
                        <Badge tone="ok">open</Badge>
                      ) : (
                        <Badge>closed</Badge>
                      )}
                      <Icon name="chevron" className="text-ink-3 group-hover:text-ink" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="openp" className="self-start border border-rule bg-surface p-5">
            <h2 id="openp" className="mb-1 text-[15px] font-semibold">
              Open a project
            </h2>
            <p className="mb-4 text-[13px] text-ink-2">
              Any folder on this machine. New folders can be initialized here.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (root.trim()) open.mutate({ root: root.trim(), init });
              }}
            >
              <label className="label" htmlFor="root">
                Folder path
              </label>
              <input
                id="root"
                className="field mono"
                placeholder="C:\code\my-app"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
              <label className="mt-3 flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={init} onChange={(e) => setInit(e.target.checked)} />
                Initialize if needed (<code className="mono text-[12px]">botss init</code>)
              </label>
              {open.error && (
                <div className="mt-3">
                  <ErrorBox error={open.error} />
                </div>
              )}
              <button
                type="submit"
                className="btn btn-primary mt-4"
                disabled={!root.trim() || open.isPending}
              >
                {open.isPending ? "Opening…" : "Open project"}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
