import { useQuery } from "@tanstack/react-query";
import { Empty, Loadable, PageHeader, toast } from "../components/ui";
import { api, pp } from "../lib/api";
import { href } from "../lib/router";

export interface NeedsYouItem {
  kind: "question" | "approval" | "blocked" | "paused" | "alert" | "team-paused";
  id: string;
  title: string;
  detail: string;
  task?: string | null;
  doc?: string;
  screen: string;
  at: string;
  action?: "unblock" | "release" | "dismiss" | "resume";
}

const KIND: Record<NeedsYouItem["kind"], { label: string; tone: string }> = {
  approval: { label: "Approve", tone: "var(--accent)" },
  question: { label: "Answer", tone: "var(--accent)" },
  blocked: { label: "Blocked", tone: "var(--danger)" },
  "team-paused": { label: "Paused", tone: "var(--warn)" },
  paused: { label: "Paused", tone: "var(--warn)" },
  alert: { label: "Alert", tone: "var(--danger)" },
};

/** Everything waiting on the owner, refreshed live (it rides on the "project" topic). */
export function useNeedsYou(pid: string) {
  return useQuery({
    queryKey: ["p", pid, "project", "needs-you"],
    queryFn: () => api<NeedsYouItem[]>("GET", pp(pid, "/needs-you")),
    refetchInterval: 15_000,
  });
}

function link(pid: string, it: NeedsYouItem): string {
  if (it.screen === "docs" && it.doc) return href(pid, "docs", it.doc);
  if (it.screen === "board" && it.task) return href(pid, "board", it.task);
  return href(pid, it.screen);
}

export function NeedsYouList({ pid, compact = false }: { pid: string; compact?: boolean }) {
  const q = useNeedsYou(pid);
  const act = async (it: NeedsYouItem) => {
    try {
      if (it.action === "unblock" && it.task) await api("POST", pp(pid, `/tasks/${encodeURIComponent(it.task)}/unblock`), {});
      if (it.action === "release" && it.task) await api("POST", pp(pid, `/tasks/${encodeURIComponent(it.task)}/release`), {});
      if (it.action === "resume") await api("POST", pp(pid, "/control/resume"), {});
      if (it.action === "dismiss") await api("POST", pp(pid, "/control/dismiss-alert"), { id: Number(it.id.split(":")[1]) });
      toast("Done");
      void q.refetch();
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  return (
    <Loadable q={q} rows={3}>
      {(items) =>
        items.length === 0 ? (
          compact ? null : (
            <Empty title="Nothing needs you right now">
              Questions, approvals, blocked tasks, and alerts show up here as soon as they happen.
            </Empty>
          )
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--rule)] border border-rule bg-surface" data-testid="needs-you-list">
            {items.slice(0, compact ? 4 : 200).map((it) => (
              <li key={it.id} className="flex items-start gap-3 px-4 py-3" data-testid={`needs-${it.kind}`}>
                <span
                  className="mono mt-0.5 shrink-0 border px-1.5 py-0.5 text-[10.5px] uppercase"
                  style={{ borderColor: KIND[it.kind].tone, color: KIND[it.kind].tone }}
                >
                  {KIND[it.kind].label}
                </span>
                <div className="min-w-0 flex-1">
                  <a className="text-[13.5px] font-semibold hover:underline" href={link(pid, it)}>
                    {it.title}
                  </a>
                  {it.detail && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-2">{it.detail}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {it.action && (
                    <button className="btn btn-sm" onClick={() => void act(it)}>
                      {it.action === "unblock" ? "Unblock" : it.action === "release" ? "Resume" : it.action === "resume" ? "Resume team" : "Dismiss"}
                    </button>
                  )}
                  <a className="btn btn-sm btn-primary" href={link(pid, it)}>
                    Open
                  </a>
                </div>
              </li>
            ))}
            {compact && items.length > 4 && (
              <li className="px-4 py-2 text-[12.5px]">
                <a className="text-accent underline" href={href(pid, "needs")}>
                  {items.length - 4} more need you
                </a>
              </li>
            )}
          </ul>
        )
      }
    </Loadable>
  );
}

export function NeedsYouScreen({ pid }: { pid: string }) {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Needs you" kicker="everything waiting on you, in one place" />
      <NeedsYouList pid={pid} />
    </div>
  );
}
