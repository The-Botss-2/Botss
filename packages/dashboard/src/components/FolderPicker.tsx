import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useFsHome } from "../lib/queries";
import { href, navigate } from "../lib/router";
import type { FsHome, FsList } from "../lib/types";
import { Badge, ErrorBox, Icon, Modal, Skeleton } from "./ui";

function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) || dir.endsWith("/") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Breadcrumb segments with the absolute path each one points at. Handles "C:\a\b" and "/a/b". */
export function crumbs(path: string, sep: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  if (sep === "\\" || /^[A-Za-z]:/.test(path)) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let acc = "";
    parts.forEach((p, i) => {
      acc = i === 0 ? `${p}\\` : joinPath(acc, p, "\\");
      out.push({ label: p, path: acc });
    });
    return out;
  }
  out.push({ label: "/", path: "/" });
  let acc = "";
  for (const p of path.split("/").filter(Boolean)) {
    acc = `${acc}/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}

export function FolderPicker({
  open,
  onClose,
  initialPath,
}: {
  open: boolean;
  onClose: () => void;
  initialPath?: string | null;
}) {
  const home = useFsHome();
  return (
    <Modal open={open} onClose={onClose} title="Open a folder" wide testId="folder-picker">
      {home.error ? (
        <ErrorBox error={home.error} retry={() => void home.refetch()} />
      ) : !home.data ? (
        <Skeleton rows={6} />
      ) : (
        <PickerBody home={home.data} initialPath={initialPath ?? null} onClose={onClose} />
      )}
    </Modal>
  );
}

function PickerBody({
  home,
  initialPath,
  onClose,
}: {
  home: FsHome;
  initialPath: string | null;
  onClose: () => void;
}) {
  const sep = home.sep;
  const [path, setPath] = useState(initialPath || home.launchDir || home.home);
  const [newName, setNewName] = useState<string | null>(null);
  const [existing, setExisting] = useState<boolean | null>(null);
  const known = useRef(new Map<string, { hasFiles: boolean; isBotss: boolean; isGit: boolean }>());
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["fs-list", path],
    queryFn: () => api<FsList>("GET", `/api/fs/list?path=${encodeURIComponent(path)}`),
    retry: false,
  });
  useEffect(() => {
    for (const e of list.data?.entries ?? []) known.current.set(e.path, e);
  }, [list.data]);
  // The server may normalize the path (trailing separators, case): follow it.
  useEffect(() => {
    if (list.data && list.data.path !== path) setPath(list.data.path);
  }, [list.data, path]);
  useEffect(() => setExisting(null), [path]);

  const info = known.current.get(path);
  const hasFiles =
    list.data?.hasFiles ?? info?.hasFiles ?? (list.data ? list.data.entries.length > 0 : false);
  const isBotss = list.data?.isBotss ?? info?.isBotss ?? false;
  const existingChecked = existing ?? hasFiles;

  const mkdir = useMutation({
    mutationFn: (p: string) => api<{ path: string }>("POST", "/api/fs/mkdir", { path: p }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["fs-list"] });
      setNewName(null);
      known.current.set(r.path, { hasFiles: false, isBotss: false, isGit: false });
      setPath(r.path);
    },
  });
  const openProject = useMutation({
    mutationFn: () =>
      api<{ id: string }>(
        "POST",
        "/api/projects",
        isBotss ? { root: path, init: false } : { root: path, init: true, existing: existingChecked },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      navigate(href(r.id, ""));
    },
  });
  const bc = useMemo(() => crumbs(path, sep), [path, sep]);

  return (
    <div className="flex flex-col gap-3 text-ink">
      <div className="flex flex-wrap items-center gap-1.5">
        <button className="btn btn-sm" onClick={() => setPath(home.home)} title={home.home}>
          <Icon name="projects" size={12} /> Home
        </button>
        <button
          className="btn btn-sm"
          disabled={!list.data?.parent}
          onClick={() => list.data?.parent && setPath(list.data.parent)}
          aria-label="Up one folder"
        >
          ↑ Up
        </button>
        {home.roots.length > 1 && (
          <select
            className="field mono w-auto py-0.5 text-[12px]"
            aria-label="Drive"
            value={home.roots.find((r) => path.toLowerCase().startsWith(r.toLowerCase())) ?? ""}
            onChange={(e) => setPath(e.target.value)}
          >
            {home.roots.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {home.launchDir && home.launchDir !== path && (
          <button className="btn btn-sm" onClick={() => setPath(home.launchDir!)} title={home.launchDir}>
            Launch folder
          </button>
        )}
      </div>

      <nav
        aria-label="Current folder"
        className="mono flex flex-wrap items-center gap-0.5 border border-rule bg-sunken px-2 py-1.5 text-[12px]"
        data-testid="fs-breadcrumb"
      >
        {bc.map((c, i) => (
          <span key={c.path} className="flex items-center">
            {i > 0 && <span className="px-0.5 text-ink-3">{sep === "\\" ? "\\" : "/"}</span>}
            <button
              className={`rounded-[2px] px-1 hover:bg-surface ${i === bc.length - 1 ? "font-semibold" : "text-ink-2"}`}
              onClick={() => setPath(c.path)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      <div
        className="h-[300px] overflow-y-auto border border-rule bg-surface"
        role="list"
        aria-label="Subfolders"
      >
        {list.error ? (
          <div className="p-3">
            <ErrorBox error={list.error} retry={() => void list.refetch()} />
          </div>
        ) : !list.data ? (
          <div className="p-3">
            <Skeleton rows={6} />
          </div>
        ) : list.data.entries.length === 0 ? (
          <p className="p-4 text-[13px] text-ink-3">
            No subfolders here. Open this folder, or create a new one.
          </p>
        ) : (
          list.data.entries.map((e) => (
            <div role="listitem" key={e.path}>
              <button
                className="flex w-full items-center gap-2.5 border-b border-rule/60 px-3 py-1.5 text-left text-[13px] hover:bg-sunken"
                onClick={() => setPath(e.path)}
                data-testid={`fs-entry-${e.name}`}
              >
                <Icon name="projects" size={14} className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.isBotss && <Badge tone="ok">Botss project</Badge>}
                {e.isGit && <Badge>git repo</Badge>}
                <Icon name="chevron" size={12} className="text-ink-3" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        {newName === null ? (
          <button className="btn btn-sm" onClick={() => setNewName("")}>
            + New folder
          </button>
        ) : (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) mkdir.mutate(joinPath(path, newName.trim(), sep));
            }}
          >
            <input
              autoFocus
              className="field py-1 text-[13px]"
              aria-label="New folder name"
              placeholder="my-new-app"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setNewName(null);
                }
              }}
            />
            <button type="submit" className="btn btn-sm" disabled={!newName.trim() || mkdir.isPending}>
              Create
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewName(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {mkdir.error && <ErrorBox error={mkdir.error} />}

      <div className="border-t border-rule pt-3" data-testid="fs-summary">
        {isBotss ? (
          <p className="text-[13px]">
            <Badge tone="ok">Botss project</Badge> <span className="mono">{path}</span> is already a Botss
            project. Opening it continues where the team left off.
          </p>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              Botss will put the app and its files in:{" "}
              <span className="mono font-medium break-all text-ink">{path}</span>
            </p>
            <p className="hint mt-1">
              Botss works directly in this folder. It adds one hidden .botss folder for plans and notes; it
              does not use git.
            </p>
            <label className="mt-2 flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={existingChecked}
                onChange={(e) => setExisting(e.target.checked)}
                data-testid="fs-existing"
              />
              This folder already has code (existing project)
            </label>
            {existingChecked && (
              <p className="hint mt-1 pl-6">
                The tech lead reads and summarizes the codebase first; your idea then describes a change or
                fix.
              </p>
            )}
          </>
        )}
        {openProject.error && (
          <div className="mt-2">
            <ErrorBox error={openProject.error} />
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={openProject.isPending || !list.data}
            onClick={() => openProject.mutate()}
            data-testid="fs-open"
          >
            {openProject.isPending ? "Opening…" : isBotss ? "Open project" : "Open in Botss"}
          </button>
        </div>
      </div>
    </div>
  );
}
