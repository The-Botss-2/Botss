import { memo, useMemo } from "react";
import { roleColor } from "../lib/roles";
import { statusColor } from "../lib/roles";

interface DagTask {
  id: string;
  title: string;
  role: string;
  after: string[];
  status?: string;
  size?: string;
}

const W = 132;
const H = 40;
const GX = 52;
const GY = 12;

/** Layered left-to-right DAG: column = dependency depth, critical path drawn heavier. */
export const Dag = memo(function Dag({
  tasks,
  critical = [],
  onSelect,
}: {
  tasks: DagTask[];
  critical?: string[];
  onSelect?: (id: string) => void;
}) {
  const layout = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const d = (id: string): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const t = byId.get(id);
      const v = t ? Math.max(0, ...t.after.filter((a) => byId.has(a)).map((a) => d(a) + 1)) : 0;
      visiting.delete(id);
      depth.set(id, v);
      return v;
    };
    for (const t of tasks) d(t.id);
    const cols: DagTask[][] = [];
    for (const t of tasks) (cols[depth.get(t.id)!] ??= []).push(t);
    // Order rows in each column by the mean row of their parents to reduce crossings.
    const row = new Map<string, number>();
    cols.forEach((col, ci) => {
      if (ci > 0) {
        const score = (t: DagTask) => {
          const ps = t.after.filter((a) => row.has(a)).map((a) => row.get(a)!);
          return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 0;
        };
        col.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
      }
      col.forEach((t, i) => row.set(t.id, i));
    });
    const maxRows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((col, ci) => {
      const offset = ((maxRows - col.length) * (H + GY)) / 2;
      col.forEach((t, i) => pos.set(t.id, { x: ci * (W + GX) + 8, y: offset + i * (H + GY) + 8 }));
    });
    return { pos, width: cols.length * (W + GX) - GX + 16, height: maxRows * (H + GY) - GY + 16 };
  }, [tasks]);

  const crit = new Set(critical);
  const critEdge = (from: string, to: string) => {
    const i = critical.indexOf(from);
    return i >= 0 && critical[i + 1] === to;
  };
  if (!tasks.length) return null;
  return (
    <div className="overflow-x-auto border border-rule bg-surface" data-testid="dag">
      <svg
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Task dependency graph, ${tasks.length} tasks; critical path ${critical.join(" → ")}`}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0 8 4 0 8z" fill="var(--rule-strong)" />
          </marker>
          <marker
            id="arrow-crit"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0 8 4 0 8z" fill="var(--ink)" />
          </marker>
        </defs>
        {tasks.flatMap((t) =>
          t.after
            .filter((a) => layout.pos.has(a))
            .map((a) => {
              const s = layout.pos.get(a)!;
              const e = layout.pos.get(t.id)!;
              const x1 = s.x + W;
              const y1 = s.y + H / 2;
              const x2 = e.x - 2;
              const y2 = e.y + H / 2;
              const c = critEdge(a, t.id);
              return (
                <path
                  key={`${a}-${t.id}`}
                  d={`M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}`}
                  fill="none"
                  stroke={c ? "var(--ink)" : "var(--rule-strong)"}
                  strokeWidth={c ? 2 : 1}
                  markerEnd={`url(#${c ? "arrow-crit" : "arrow"})`}
                />
              );
            }),
        )}
        {tasks.map((t) => {
          const p = layout.pos.get(t.id)!;
          const c = crit.has(t.id);
          return (
            <g
              key={t.id}
              transform={`translate(${p.x},${p.y})`}
              className={onSelect ? "cursor-pointer" : undefined}
              onClick={() => onSelect?.(t.id)}
              tabIndex={onSelect ? 0 : undefined}
              role={onSelect ? "button" : undefined}
              aria-label={`${t.id} ${t.title}`}
              onKeyDown={(e) => {
                if (onSelect && (e.key === "Enter" || e.key === " ")) onSelect(t.id);
              }}
            >
              <title>{`${t.id} · ${t.title} (${t.role}${t.size ? `, ${t.size}` : ""})`}</title>
              <rect
                width={W}
                height={H}
                rx={2}
                fill="var(--paper)"
                stroke={c ? "var(--ink)" : "var(--rule-strong)"}
                strokeWidth={c ? 1.8 : 1}
              />
              <rect width={3} height={H} fill={roleColor(t.role)} />
              {t.status && <circle cx={W - 9} cy={9} r={3.5} fill={statusColor(t.status)} />}
              <text
                x={10}
                y={15}
                fontFamily="var(--font-mono)"
                fontSize={11}
                fontWeight={600}
                fill="var(--ink)"
              >
                {t.id}
                {t.size ? <tspan fill="var(--ink-3)" fontWeight={400}>{` · ${t.size}`}</tspan> : null}
              </text>
              <text x={10} y={30} fontSize={11} fill="var(--ink-2)">
                {t.title.length > 19 ? `${t.title.slice(0, 18)}…` : t.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
});
