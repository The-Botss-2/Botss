import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { optionColors, QuestionCard } from "../components/QuestionCard";
import { Badge, Empty, ErrorBox, Loadable, Modal, PageHeader, Skeleton } from "../components/ui";
import { api, pp } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useDesign, useDoc, useProject } from "../lib/queries";
import type { Question } from "../lib/types";
import { GateBar } from "./Docs";

export function DesignScreen({ pid }: { pid: string }) {
  const q = useDesign(pid);
  const project = useProject(pid);
  const inDesign = project.data?.phase === "design";
  const designDoc = useDoc(pid, inDesign ? "design" : null);
  return (
    <div>
      <PageHeader title="Design" kicker="direction · tokens · screens" />
      {inDesign && designDoc.data && (
        <GateBar pid={pid} name="design" doc={designDoc.data} project={project.data} sticky />
      )}
      <Loadable q={q} rows={8}>
        {(d) => (
          <div className="flex flex-col gap-10">
            <section aria-labelledby="dir-h">
              <h2 id="dir-h" className="section-title mb-3">
                VISUAL DIRECTION
              </h2>
              <Directions
                pid={pid}
                directions={d.directions}
                choice={d.choice}
                previews={d.directionPreviews ?? []}
              />
            </section>
            <section aria-labelledby="tok-h">
              <h2 id="tok-h" className="section-title mb-3">
                DESIGN TOKENS
              </h2>
              {d.tokens ? (
                <TokenViewer tokens={d.tokens} />
              ) : (
                <Empty title="No tokens yet">
                  After you pick a direction, the designer turns it into design tokens (colours, type,
                  spacing) in contracts/design-tokens.json.
                </Empty>
              )}
            </section>
            <section aria-labelledby="scr-h">
              <h2 id="scr-h" className="section-title mb-3">
                SCREEN MOCKUPS
              </h2>
              {d.screens.length ? (
                <Screens pid={pid} screens={d.screens} />
              ) : (
                <Empty title="No screens yet">
                  The designer writes one spec and one HTML mockup per PRD screen after the design system is
                  ready.
                </Empty>
              )}
            </section>
          </div>
        )}
      </Loadable>
    </div>
  );
}

function Directions({
  pid,
  directions,
  choice,
  previews,
}: {
  pid: string;
  directions: Question[];
  choice: string | null;
  previews: string[];
}) {
  const extra = (key: string) =>
    previews.includes(`${key}.html`) ? <DirectionPreview pid={pid} file={`${key}.html`} /> : null;
  const open = directions.filter((d) => d.status === "open");
  if (open.length) {
    return (
      <div className="flex flex-col gap-4">
        {open.map((q) => (
          <QuestionCard key={q.id} pid={pid} q={q} rich optionExtra={extra} />
        ))}
      </div>
    );
  }
  if (choice || directions.length) {
    const last = directions.at(-1);
    const opts = last?.batch?.questions?.[0]?.options ?? [];
    return (
      <div className="flex flex-col gap-3">
        {choice && (
          <div className="border border-rule bg-surface px-5 py-4">
            <div className="mono mb-1 text-[11px] text-ink-3">owner's choice</div>
            <pre className="text-[13.5px] whitespace-pre-wrap">{choice}</pre>
          </div>
        )}
        {opts.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
            {opts.map((o) => (
              <div key={o.key} className="border border-rule bg-surface px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="mono text-[12px] font-semibold">{o.key}</span>
                  <span className="text-[13px]">{o.label}</span>
                </div>
                <div className="mt-2 flex gap-1">
                  {optionColors(o).map((c) => (
                    <span
                      key={c.hex}
                      className="h-4 w-6 border border-rule"
                      style={{ background: c.hex }}
                      title={c.hex}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <Empty title="No directions yet">
      After the PRD is approved, the designer proposes 2 or 3 visual directions. You pick one here.
    </Empty>
  );
}

// ---------------------------------------------------------------------------------------------- tokens

interface Leaf {
  path: string[];
  value: unknown;
  type?: string;
}

function flatten(obj: unknown, path: string[] = [], out: Leaf[] = []): Leaf[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    if (
      "$value" in o ||
      ("value" in o &&
        Object.keys(o).every((k) => ["value", "type", "description", "$type", "$description"].includes(k)))
    ) {
      out.push({ path, value: o.$value ?? o.value, type: String(o.$type ?? o.type ?? "") });
      return out;
    }
    for (const [k, v] of Object.entries(o)) if (!k.startsWith("$")) flatten(v, [...path, k], out);
  } else out.push({ path, value: obj });
  return out;
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i;

export function TokenViewer({ tokens }: { tokens: unknown }) {
  const leaves = useMemo(() => flatten(tokens), [tokens]);
  const colors = leaves.filter(
    (l) => l.type === "color" || (typeof l.value === "string" && COLOR_RE.test(l.value.trim())),
  );
  const isType = (l: Leaf) =>
    /font|type|typography|text|size|leading|line/i.test(l.path.join(".")) && !colors.includes(l);
  const typeLeaves = leaves.filter(isType);
  const spacing = leaves.filter(
    (l) => /spac|space|gap|radius/i.test(l.path.join(".")) && !colors.includes(l) && !typeLeaves.includes(l),
  );
  const other = leaves.filter((l) => !colors.includes(l) && !typeLeaves.includes(l) && !spacing.includes(l));
  const groups = new Map<string, Leaf[]>();
  for (const c of colors) {
    const g = c.path.slice(0, -1).join(".") || "color";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return (
    <div className="flex flex-col gap-6" data-testid="token-viewer">
      {colors.length > 0 && (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([g, ls]) => (
            <div key={g}>
              <div className="mono mb-1.5 text-[11px] text-ink-3">{g}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {ls.map((l) => (
                  <div
                    key={l.path.join(".")}
                    className="flex items-center gap-2 border border-rule bg-surface p-1.5"
                  >
                    <span
                      className="h-9 w-9 shrink-0 border border-rule-strong"
                      style={{ background: String(l.value) }}
                    />
                    <span className="min-w-0">
                      <span className="mono block truncate text-[11.5px] font-medium">{l.path.at(-1)}</span>
                      <span className="mono block truncate text-[10.5px] text-ink-3">{String(l.value)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {typeLeaves.length > 0 && (
        <div>
          <div className="mono mb-1.5 text-[11px] text-ink-3">typography</div>
          <div className="divide-y divide-rule border-y border-rule bg-surface">
            {typeLeaves.slice(0, 40).map((l) => {
              const v = typeof l.value === "object" ? JSON.stringify(l.value) : String(l.value);
              const isSize = /^-?[\d.]+(px|rem|em)$|clamp\(/.test(v);
              const isFamily = /family|font$/i.test(l.path.at(-1) ?? "") && !isSize;
              return (
                <div
                  key={l.path.join(".")}
                  className="grid grid-cols-[200px_minmax(0,1fr)] items-center gap-4 px-3 py-2"
                >
                  <span className="mono truncate text-[11.5px] text-ink-2">{l.path.join(".")}</span>
                  <span
                    className="min-w-0 truncate"
                    style={{
                      fontSize: isSize ? v : undefined,
                      fontFamily: isFamily ? v : undefined,
                      lineHeight: 1.2,
                    }}
                  >
                    {isSize || isFamily ? (
                      "The quick brown fox jumps"
                    ) : (
                      <span className="mono text-[12px]">{v}</span>
                    )}
                    {isSize && <span className="mono ml-3 text-[11px] text-ink-3">{v}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {spacing.length > 0 && (
        <div>
          <div className="mono mb-1.5 text-[11px] text-ink-3">spacing & radius</div>
          <div className="flex flex-col gap-1 border border-rule bg-surface p-3">
            {spacing.slice(0, 30).map((l) => {
              const v = String(l.value);
              const radius = /radius/i.test(l.path.join("."));
              return (
                <div
                  key={l.path.join(".")}
                  className="grid grid-cols-[200px_80px_minmax(0,1fr)] items-center gap-3"
                >
                  <span className="mono truncate text-[11.5px] text-ink-2">{l.path.join(".")}</span>
                  <span className="mono text-[11px] text-ink-3">{v}</span>
                  {radius ? (
                    <span className="h-6 w-10 border border-ink-2" style={{ borderRadius: v }} />
                  ) : (
                    <span className="h-2.5 bg-ink-3" style={{ width: /^[\d.]+(px|rem)$/.test(v) ? v : 4 }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {other.length > 0 && (
        <details>
          <summary className="mono cursor-pointer text-[11px] text-ink-3">
            {other.length} other tokens
          </summary>
          <pre className="mono mt-2 max-h-80 overflow-auto border border-rule bg-surface p-3 text-[11.5px]">
            {other.map((l) => `${l.path.join(".")}: ${JSON.stringify(l.value)}`).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- screens

function Screens({ pid, screens }: { pid: string; screens: string[] }) {
  const html = screens.filter((s) => s.endsWith(".html"));
  const [sel, setSel] = useState(html[0] ?? screens[0]!);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const content = useQuery({
    queryKey: ["p", pid, "docs", "screen", sel],
    queryFn: () => api<string>("GET", pp(pid, `/design/screen?name=${encodeURIComponent(sel)}`)),
  });
  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-4">
      <ul className="flex flex-col self-start border-y border-rule">
        {screens.map((s) => (
          <li key={s}>
            <button
              className={`mono w-full truncate border-l-2 px-2 py-1.5 text-left text-[12px] ${sel === s ? "border-ink bg-surface font-medium" : "border-transparent text-ink-2 hover:text-ink"}`}
              aria-current={sel === s}
              onClick={() => setSel(s)}
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between">
          <span className="mono text-[12px] text-ink-2">{sel}</span>
          {sel.endsWith(".html") && (
            <div role="group" aria-label="Device width" className="flex gap-1">
              {(["desktop", "mobile"] as const).map((d) => (
                <button
                  key={d}
                  className={`btn btn-sm ${device === d ? "btn-primary" : ""}`}
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                >
                  {d === "desktop" ? "Desktop 1280" : "Mobile 390"}
                </button>
              ))}
            </div>
          )}
        </div>
        {content.error ? (
          <ErrorBox error={content.error} retry={() => void content.refetch()} />
        ) : content.data === undefined ? (
          <Skeleton rows={6} />
        ) : sel.endsWith(".html") ? (
          <ScaledFrame
            html={content.data}
            width={device === "desktop" ? 1280 : 390}
            title={`Mockup ${sel}`}
          />
        ) : (
          <div className="border border-rule bg-surface px-6 py-5">
            <Markdown text={content.data} />
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-[11.5px] text-ink-3">
          <Badge>sandboxed</Badge> Mockups run in an isolated frame without access to Botss.
        </div>
      </div>
    </div>
  );
}

/** A sandboxed srcdoc iframe rendered at a device width and scaled down to fit the column. */
export function ScaledFrame({
  html,
  width,
  title,
  height: fixedHeight,
}: {
  html: string;
  width: number;
  title: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(width);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, avail / width);
  const height = fixedHeight ?? (width > 600 ? 800 : 780);
  return (
    <div ref={box} className="w-full">
      <div
        className="mx-auto overflow-hidden border border-rule-strong bg-white"
        style={{ width: width * scale, height: height * scale }}
      >
        <iframe
          title={title}
          sandbox="allow-scripts"
          srcDoc={html}
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            border: 0,
            display: "block",
          }}
        />
      </div>
    </div>
  );
}

/** Thumbnail of a direction's HTML preview (designer writes design/directions/<key>.html); click to expand. */
function DirectionPreview({ pid, file }: { pid: string; file: string }) {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const html = useQuery({
    queryKey: ["p", pid, "docs", "direction", file],
    queryFn: () =>
      api<string>("GET", pp(pid, `/design/screen?name=${encodeURIComponent(file)}&dir=directions`)),
  });
  if (html.error) return <div className="mt-2 text-[11.5px] text-ink-3">Preview unavailable</div>;
  if (html.data === undefined) return <div className="skeleton mt-2 h-28" />;
  return (
    <div className="mt-2" data-testid={`direction-preview-${file}`}>
      <div className="pointer-events-none">
        <ScaledFrame html={html.data} width={1280} height={720} title={`Direction ${file} preview`} />
      </div>
      <button
        type="button"
        className="btn btn-sm mt-1.5"
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        Expand preview
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Direction ${file.replace(/\.html$/, "")}`}
        wide
      >
        <div className="mb-2 flex justify-end gap-1" role="group" aria-label="Device width">
          {(["desktop", "mobile"] as const).map((d) => (
            <button
              key={d}
              className={`btn btn-sm ${device === d ? "btn-primary" : ""}`}
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
            >
              {d === "desktop" ? "Desktop 1280" : "Mobile 390"}
            </button>
          ))}
        </div>
        <ScaledFrame
          html={html.data}
          width={device === "desktop" ? 1280 : 390}
          title={`Direction ${file} expanded`}
        />
      </Modal>
    </div>
  );
}
