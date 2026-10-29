import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Empty, Loadable, PageHeader, toast } from "../components/ui";
import { api, pp } from "../lib/api";
import { useAction } from "../lib/queries";

interface Lesson {
  id: number;
  text: string;
  roles: string[];
  paths: string[];
  source: string | null;
  pinned: boolean;
  created_at: string;
}

const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The learning memory: lessons the team recorded; each agent run sees the ones matching its role and files. */
export function MemoryScreen({ pid }: { pid: string }) {
  const q = useQuery({ queryKey: ["p", pid, "memory"], queryFn: () => api<Lesson[]>("GET", pp(pid, "/lessons")) });
  const add = useAction<{ text: string; roles: string[]; paths: string[] }>(pid, "POST", "/lessons", ["memory"]);
  const [text, setText] = useState("");
  const [roles, setRoles] = useState("");
  const [paths, setPaths] = useState("");
  const call = async (method: string, path: string, body?: unknown) => {
    try {
      await api(method, pp(pid, path), body ?? {});
      void q.refetch();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  return (
    <div className="max-w-4xl">
      <PageHeader title="Memory" kicker="lessons the team learned on this project" />
      <p className="mb-4 text-[13px] text-ink-2">
        When an agent, a reviewer, or you notice a mistake that could happen again, it becomes a one-line lesson. Every later run
        sees the lessons that match its role and files, so the team stops repeating mistakes (and spending usage on fixing them).
      </p>
      <form
        className="mb-6 grid grid-cols-[1fr_180px_220px_auto] gap-2 max-[1100px]:grid-cols-1"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { text, roles: split(roles), paths: split(paths) },
            { onSuccess: () => (setText(""), setRoles(""), setPaths(""), toast("Lesson saved"), void q.refetch()), onError: (e) => toast(e.message, "danger") },
          );
        }}
      >
        <input className="field" placeholder="e.g. Use the shared <Dialog>, never window.confirm" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} required aria-label="Lesson" />
        <input className="field mono text-[12px]" placeholder="roles (optional): frontend" value={roles} onChange={(e) => setRoles(e.target.value)} aria-label="Roles" />
        <input className="field mono text-[12px]" placeholder="files (optional): src/components/**" value={paths} onChange={(e) => setPaths(e.target.value)} aria-label="Files" />
        <button className="btn btn-primary" disabled={add.isPending}>
          Add lesson
        </button>
      </form>
      <Loadable q={q} rows={4}>
        {(list) =>
          list.length === 0 ? (
            <Empty title="No lessons yet">Lessons appear here as the team learns. You can add your own rules above.</Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--rule)] border border-rule bg-surface" data-testid="memory-list">
              {list.map((l) => (
                <li key={l.id} className="flex items-start gap-3 px-4 py-3">
                  <button className="mt-0.5 text-[14px]" title={l.pinned ? "Unpin" : "Pin (always shown first)"} aria-pressed={l.pinned} onClick={() => void call("PATCH", `/lessons/${l.id}`, { pinned: !l.pinned })}>
                    {l.pinned ? "📌" : "📍"}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px]">{l.text}</div>
                    <div className="mono mt-0.5 text-[11.5px] text-ink-3">
                      {l.roles.length ? `roles: ${l.roles.join(", ")}` : "all roles"} · {l.paths.length ? `files: ${l.paths.join(", ")}` : "whole project"}
                      {l.source ? ` · from ${l.source}` : ""}
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => void call("DELETE", `/lessons/${l.id}`)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </div>
  );
}
