import { useState } from "react";
import { QuestionCard } from "../components/QuestionCard";
import { ChangeCallout, ChangesList } from "../components/Changes";
import { AgentName, Empty, Icon, Loadable, PageHeader, toastError } from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { useAction, useProject, useQuestions } from "../lib/queries";
import { href } from "../lib/router";

export function QuestionsScreen({ pid }: { pid: string }) {
  const qq = useQuestions(pid);
  const project = useProject(pid);
  const alerts = project.data?.state.alerts ?? [];
  const dismiss = useAction<{ id: number }>(pid, "POST", "/control/dismiss-alert", ["project"]);
  const [showHistory, setShowHistory] = useState(true);

  return (
    <div className="max-w-4xl">
      <PageHeader title="Questions & alerts" kicker="inbox · the team is waiting on these" />
      <ChangeCallout pid={pid} p={project.data} />

      {alerts.length > 0 && (
        <section aria-labelledby="alerts-h" className="mb-8">
          <h2 id="alerts-h" className="section-title mb-3">
            ALERTS
          </h2>
          <ul className="flex flex-col gap-2">
            {[...alerts].reverse().map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-3 border border-l-4 border-rule border-l-[var(--warn)] bg-surface px-4 py-3"
                data-testid="alert"
              >
                <span className="mono mt-0.5 text-[11px] text-warn">!</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px]">{a.text}</div>
                  <div className="mono mt-0.5 text-[11px] text-ink-3">
                    {fmtDateTime(a.ts)}
                    {a.task && (
                      <>
                        {" · "}
                        <a className="underline" href={href(pid, "board", a.task)}>
                          {a.task}
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  aria-label={`Dismiss alert ${a.id}`}
                  onClick={() => dismiss.mutate({ id: a.id }, { onError: toastError })}
                >
                  <Icon name="close" size={12} /> Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Loadable q={qq}>
        {(all) => {
          const mine = all.filter((q) => q.to_addr === "@human");
          const open = mine.filter((q) => q.status === "open");
          const answered = mine.filter((q) => q.status !== "open").reverse();
          return (
            <>
              <section aria-labelledby="open-h" className="mb-10">
                <h2 id="open-h" className="section-title mb-3">
                  OPEN · {open.length}
                </h2>
                {open.length === 0 ? (
                  <Empty title="Nothing needs you right now">
                    When an agent asks you something (a discovery batch, a design direction, a missing API
                    key) it appears here and the badge in the header lights up.
                  </Empty>
                ) : (
                  <div className="flex flex-col gap-5">
                    {open.map((q) => (
                      <QuestionCard key={q.id} pid={pid} q={q} />
                    ))}
                  </div>
                )}
              </section>

              <section aria-labelledby="hist-h">
                <h2 id="hist-h" className="section-title mb-3">
                  <button
                    className="mono"
                    aria-expanded={showHistory}
                    onClick={() => setShowHistory((s) => !s)}
                  >
                    {showHistory ? "▾" : "▸"} ANSWERED · {answered.length}
                  </button>
                </h2>
                {showHistory &&
                  (answered.length === 0 ? (
                    <p className="text-[13px] text-ink-3">No answered questions yet.</p>
                  ) : (
                    <ul className="divide-y divide-rule border-y border-rule">
                      {answered.map((q) => (
                        <li
                          key={q.id}
                          className="grid grid-cols-[80px_minmax(0,1fr)] gap-4 px-1 py-3"
                          data-testid={`answered-${q.id}`}
                        >
                          <div className="mono text-[12px]">
                            <div className="font-semibold">{q.id}</div>
                            <div className="text-ink-3">{q.task ?? ""}</div>
                          </div>
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                              <AgentName id={q.from_agent} /> asked · answered by{" "}
                              <span className="mono">{q.answered_by}</span> · {fmtDateTime(q.answered_at)}
                            </div>
                            <div className="text-[13px] text-ink-2">{q.batch?.intro ?? q.body}</div>
                            <pre className="mono mt-1.5 border-l-2 border-rule-strong pl-3 text-[12px] whitespace-pre-wrap text-ink">
                              {typeof q.answer === "string" ? q.answer : JSON.stringify(q.answer, null, 2)}
                            </pre>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ))}
              </section>
            </>
          );
        }}
      </Loadable>
      <section aria-labelledby="changes-h" className="mt-10">
        <h2 id="changes-h" className="section-title mb-3">
          CHANGE REQUESTS
        </h2>
        <ChangesList pid={pid} />
      </section>
    </div>
  );
}
