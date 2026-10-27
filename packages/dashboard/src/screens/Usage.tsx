import type { ReactNode } from "react";
import { Empty, Loadable, PageHeader, RoleChip } from "../components/ui";
import { fmtDateTime, fmtInt, fmtTokens } from "../lib/format";
import { useUsage } from "../lib/queries";
import { href } from "../lib/router";
import type { UsageInfo, UsageRow } from "../lib/types";

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function UsageScreen({ pid }: { pid: string }) {
  const q = useUsage(pid);
  return (
    <div className="max-w-6xl">
      <PageHeader title="Usage" kicker="tokens Botss spent on your Claude Code subscription" />
      <Loadable q={q} rows={8}>
        {(u) => <UsageBody pid={pid} u={u} />}
      </Loadable>
    </div>
  );
}

function UsageBody({ pid, u }: { pid: string; u: UsageInfo }) {
  const budget = u.settings.daily_token_budget;
  const reserve = u.settings.reserve_percent;
  const allowance = budget > 0 ? Math.floor((budget * (100 - reserve)) / 100) : 0;
  const total7 = u.byDay.reduce((n, d) => n + Number(d.tokens ?? 0), 0);
  const cost7 = u.byDay.reduce((n, d) => n + Number(d.cost ?? 0), 0);
  const runs7 = u.byDay.reduce((n, d) => n + Number(d.runs ?? 0), 0);
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="today-h" className="border border-rule bg-surface p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="today-h" className="text-[14px] font-semibold">
            Today
          </h2>
          <div className="mono text-[12px] text-ink-3">
            <span className="text-[20px] font-semibold text-ink tabular" data-testid="usage-today">
              {fmtTokens(u.today)}
            </span>{" "}
            {budget > 0
              ? `of ${fmtTokens(allowance)} Botss may use (${fmtTokens(budget)} budget, ${reserve}% kept for you)`
              : "no daily budget set"}
          </div>
        </div>
        <BudgetBar used={u.today} budget={budget} reserve={reserve} />
      </section>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
        <section aria-labelledby="days-h">
          <h2 id="days-h" className="section-title mb-3">
            LAST 7 DAYS · {fmtTokens(total7)} tokens · {runs7} runs
            {cost7 ? ` · $${cost7.toFixed(2)} API-equivalent` : ""}
          </h2>
          <DayBars rows={u.byDay} allowance={allowance} />
        </section>
        <section aria-labelledby="roles-h">
          <h2 id="roles-h" className="section-title mb-3">
            BY ROLE
          </h2>
          <UsageTable rows={u.byRole} keyName="role" render={(r) => <RoleChip role={r.role ?? ""} />} />
        </section>
      </div>

      <section aria-labelledby="tasks-h">
        <h2 id="tasks-h" className="section-title mb-3">
          BY TASK (top 50)
        </h2>
        <UsageTable
          rows={u.byTask}
          keyName="task"
          render={(r) => (
            <a
              className="mono font-medium underline-offset-2 hover:underline"
              href={href(pid, "board", r.task ?? "")}
            >
              {r.task}
            </a>
          )}
        />
      </section>

      <section aria-labelledby="limits-h">
        <h2 id="limits-h" className="section-title mb-3">
          LIMIT EVENTS
        </h2>
        {u.limits.length === 0 ? (
          <p className="text-[13px] text-ink-3">No usage limits hit in the recent history.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {[...u.limits].reverse().map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[150px_120px_minmax(0,1fr)] gap-3 px-1 py-2 text-[12.5px]"
              >
                <span className="mono text-ink-3">{fmtDateTime(e.ts)}</span>
                <span className="mono text-warn">{e.type}</span>
                <span>{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BudgetBar({ used, budget, reserve }: { used: number; budget: number; reserve: number }) {
  if (budget <= 0) return <div className="h-4 border border-rule-strong bg-sunken" />;
  const pct = Math.min(100, (used / budget) * 100);
  const allowPct = 100 - reserve;
  const over = pct >= allowPct;
  return (
    <div>
      <svg
        width="100%"
        height="40"
        role="img"
        aria-label={`${Math.round(pct)}% of the daily budget used; Botss stops at ${allowPct}%`}
      >
        <rect x="0" y="8" width="100%" height="18" fill="var(--sunken)" stroke="var(--rule-strong)" />
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-3)" strokeWidth="1.5" opacity="0.5" />
        </pattern>
        <rect x={`${allowPct}%`} y="8" width={`${reserve}%`} height="18" fill="url(#hatch)" />
        <rect x="0" y="8" width={`${pct}%`} height="18" fill={over ? "var(--danger)" : "var(--ink)"} />
        <line
          x1={`${allowPct}%`}
          x2={`${allowPct}%`}
          y1="2"
          y2="32"
          stroke="var(--danger)"
          strokeWidth="1.5"
        />
        <text
          x={`${allowPct}%`}
          dx="-4"
          y="38"
          textAnchor="end"
          fontSize="10"
          fontFamily="var(--font-mono)"
          fill="var(--ink-3)"
        >
          Botss stops here
        </text>
      </svg>
      <div className="mono mt-1 flex justify-between text-[10.5px] text-ink-3">
        <span>0</span>
        <span>reserve {reserve}% for you →</span>
        <span>{fmtTokens(budget)}</span>
      </div>
    </div>
  );
}

function DayBars({ rows, allowance }: { rows: UsageRow[]; allowance: number }) {
  const days: { day: string; tokens: number; runs: number }[] = [];
  const by = new Map(rows.map((r) => [r.day, r]));
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    // byDay is grouped by the UTC date prefix of started_at; match both the local and UTC day.
    const key = localDay(d);
    const utc = d.toISOString().slice(0, 10);
    const r = by.get(key) ?? by.get(utc);
    days.push({ day: key, tokens: Number(r?.tokens ?? 0), runs: Number(r?.runs ?? 0) });
  }
  const peak = Math.max(...days.map((d) => d.tokens), 1);
  // Keep small days readable: the allowance line is only drawn to scale when it is near the data.
  const showAllowance = allowance > 0 && allowance <= peak * 4;
  const max = showAllowance ? Math.max(allowance, peak) * 1.1 : peak * 1.25;
  const H = 160;
  const bw = 100 / days.length;
  return (
    <div className="border border-rule bg-surface p-4">
      <svg width="100%" height={H + 24} role="img" aria-label="Tokens per day for the last 7 days">
        {allowance > 0 && !showAllowance && (
          <text
            x="100%"
            dx="-2"
            y="12"
            textAnchor="end"
            fontSize="10"
            fontFamily="var(--font-mono)"
            fill="var(--ink-3)"
          >
            daily allowance {fmtTokens(allowance)} (off scale)
          </text>
        )}
        {showAllowance && (
          <>
            <line
              x1="0"
              x2="100%"
              y1={H - (allowance / max) * H}
              y2={H - (allowance / max) * H}
              stroke="var(--danger)"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            <text
              x="100%"
              dx="-2"
              y={H - (allowance / max) * H - 4}
              textAnchor="end"
              fontSize="10"
              fontFamily="var(--font-mono)"
              fill="var(--ink-3)"
            >
              daily allowance {fmtTokens(allowance)}
            </text>
          </>
        )}
        <line x1="0" x2="100%" y1={H} y2={H} stroke="var(--rule-strong)" />
        {days.map((d, i) => {
          const h = (d.tokens / max) * H;
          const today = i === days.length - 1;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${fmtInt(d.tokens)} tokens, ${d.runs} runs`}</title>
              <rect
                x={`${i * bw + bw * 0.22}%`}
                y={H - h}
                width={`${bw * 0.56}%`}
                height={Math.max(h, d.tokens ? 1 : 0)}
                fill={today ? "var(--ink)" : "var(--ink-3)"}
              />
              <text
                x={`${i * bw + bw / 2}%`}
                y={H - h - 4}
                textAnchor="middle"
                fontSize="10"
                fontFamily="var(--font-mono)"
                fill="var(--ink-2)"
              >
                {d.tokens ? fmtTokens(d.tokens) : ""}
              </text>
              <text
                x={`${i * bw + bw / 2}%`}
                y={H + 16}
                textAnchor="middle"
                fontSize="10.5"
                fontFamily="var(--font-mono)"
                fill={today ? "var(--ink)" : "var(--ink-3)"}
              >
                {today ? "today" : new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: "short" })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function UsageTable({
  rows,
  keyName,
  render,
}: {
  rows: UsageRow[];
  keyName: "role" | "task";
  render: (r: UsageRow) => ReactNode;
}) {
  if (!rows.length) return <Empty title="No runs yet">Usage appears after the first agent run.</Empty>;
  const max = Math.max(...rows.map((r) => Number(r.tokens ?? 0)), 1);
  return (
    <table className="w-full border-collapse border border-rule bg-surface text-[12.5px]">
      <thead>
        <tr className="bg-sunken text-left text-[11px] text-ink-3">
          <th className="whitespace-nowrap px-3 py-1.5 font-medium">{keyName}</th>
          <th className="whitespace-nowrap px-3 py-1.5 font-medium">tokens</th>
          <th className="whitespace-nowrap px-3 py-1.5 text-right font-medium">runs</th>
          <th className="whitespace-nowrap px-3 py-1.5 text-right font-medium">turns</th>
          <th className="whitespace-nowrap px-3 py-1.5 text-right font-medium">cache read</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r[keyName]}-${i}`} className="border-t border-rule">
            <td className="px-3 py-1.5">{render(r)}</td>
            <td className="px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="mono w-12 text-right tabular">{fmtTokens(r.tokens)}</span>
                <span
                  className="h-1.5 bg-ink-3"
                  style={{ width: `${(Number(r.tokens ?? 0) / max) * 120}px` }}
                  aria-hidden
                />
              </div>
            </td>
            <td className="mono px-3 py-1.5 text-right tabular">{r.runs}</td>
            <td className="mono px-3 py-1.5 text-right tabular">{r.turns ?? 0}</td>
            <td className="mono px-3 py-1.5 text-right text-ink-3 tabular">{fmtTokens(r.cache_read)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
