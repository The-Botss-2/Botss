import { createTwoFilesPatch } from "diff";
import { useMemo, useState } from "react";
import YAML from "yaml";
import { DiffView } from "../components/Diff";
import { headingsOf, Markdown, slugify } from "../components/Markdown";
import {
  AgentName,
  Badge,
  Empty,
  ErrorBox,
  Loadable,
  Modal,
  PageHeader,
  Skeleton,
  Tabs,
  toast,
} from "../components/ui";
import { fmtDateTime } from "../lib/format";
import { useAction, useDoc, useDocs, useDocVersion, useProject } from "../lib/queries";
import { href } from "../lib/router";
import { DOC_GATE, PHASE_GATE, type DocDetail, type DocRow, type ProjectInfo } from "../lib/types";
import { ChangeCallout, ChangesList } from "../components/Changes";

/** Is the owner's gate for this document open? Phase gates, plus prd/plan while a change request waits for review. */
export function gateOpenFor(name: string, project: ProjectInfo | undefined, docStatus?: string): boolean {
  const gate = DOC_GATE[name];
  if (!gate || !project) return false;
  const ch = project.activeChange;
  if (gate === "prd" && ch?.status === "prd_review") return true;
  if (gate === "plan" && ch?.status === "plan_review") return true;
  if (PHASE_GATE[project.phase] !== gate) return false;
  // The design gate opens once the designer submitted the screens.
  if (gate === "design" && docStatus !== undefined) return docStatus === "submitted";
  return true;
}

const ORDER = ["idea", "prd", "design", "architecture", "plan", "release"];

function groupDocs(docs: DocRow[]): { group: string; docs: DocRow[] }[] {
  const groups = new Map<string, DocRow[]>();
  for (const d of docs) {
    const g = d.name.includes("/") ? d.name.split("/")[0]! : "";
    groups.set(g, [...(groups.get(g) ?? []), d]);
  }
  const top = (groups.get("") ?? []).sort((a, b) => {
    const ia = ORDER.indexOf(a.name);
    const ib = ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  groups.delete("");
  return [
    { group: "", docs: top },
    ...[...groups.entries()].sort().map(([group, docs]) => ({ group, docs })),
  ];
}

function statusTone(s: string): "ok" | "warn" | "danger" | "neutral" {
  return s === "approved"
    ? "ok"
    : s === "submitted"
      ? "warn"
      : s === "changes_requested"
        ? "danger"
        : "neutral";
}

export function DocsScreen({ pid, name }: { pid: string; name: string | null }) {
  const docs = useDocs(pid);
  const project = useProject(pid);
  const selected = name ?? docs.data?.[0]?.name ?? null;

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-[180px_minmax(0,1fr)]">
      <aside aria-label="Documents" className="self-start">
        <h1 className="section-title mb-3">DOCUMENTS</h1>
        <Loadable q={docs} rows={6}>
          {(list) =>
            list.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                No documents yet. The PRD appears here after discovery.
              </p>
            ) : (
              <nav className="flex flex-col gap-3">
                {groupDocs(list).map((g) => (
                  <div key={g.group || "_"}>
                    {g.group && <div className="mono mb-1 text-[10.5px] text-ink-3">{g.group}/</div>}
                    <ul className="flex flex-col">
                      {g.docs.map((d) => {
                        const open = gateOpenFor(d.name, project.data, d.status);
                        return (
                          <li key={d.name}>
                            <a
                              href={href(pid, "docs", d.name)}
                              aria-current={selected === d.name ? "page" : undefined}
                              className={`flex items-center gap-2 border-l-2 px-2 py-1 text-[13px] ${selected === d.name ? "border-ink bg-surface font-medium" : "border-transparent text-ink-2 hover:border-rule-strong hover:text-ink"}`}
                            >
                              <span className="mono min-w-0 flex-1 truncate text-[12.5px]">
                                {g.group ? d.name.slice(g.group.length + 1) : d.name}
                              </span>
                              {open && (
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-danger"
                                  title="Waiting for your review"
                                  aria-label="waiting for your review"
                                />
                              )}
                              <span className="mono text-[10.5px] text-ink-3">v{d.version}</span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </nav>
            )
          }
        </Loadable>
        <div className="mt-6">
          <h2 className="section-title mb-2">CHANGES</h2>
          <ChangesList pid={pid} compact />
        </div>
      </aside>
      <section className="min-w-0">
        <ChangeCallout pid={pid} p={project.data} />
        {selected ? (
          <DocView key={selected} pid={pid} name={selected} project={project.data} />
        ) : docs.isLoading ? (
          <Skeleton rows={8} />
        ) : (
          <Empty title="No documents yet">
            The product manager writes the PRD after discovery; the tech lead adds the architecture and the
            plan. Each version is kept so you can compare them.
          </Empty>
        )}
      </section>
    </div>
  );
}

type Tab = "doc" | "changes" | "comments";

function DocView({ pid, name, project }: { pid: string; name: string; project: ProjectInfo | undefined }) {
  const q = useDoc(pid, name);
  const [tab, setTab] = useState<Tab>("doc");
  const [viewV, setViewV] = useState<number | null>(null);
  return (
    <Loadable q={q} rows={10}>
      {(d) => {
        const latest = d.version;
        const v = viewV ?? latest;
        const commentsCount = d.versions.reduce((n, x) => n + (x.comments?.length ?? 0), 0);
        return (
          <div>
            <PageHeader
              kicker={
                <span>
                  {d.path} · owner {d.owner_role ?? "owner"} · updated {fmtDateTime(d.updated_at)}
                </span>
              }
              title={
                <span className="flex items-center gap-3">
                  <span className="mono">{name}</span>
                  <Badge tone={statusTone(d.status)}>{d.status.replace("_", " ")}</Badge>
                </span>
              }
            >
              {d.versions.length > 1 && (
                <label className="flex items-center gap-2 text-[12px] text-ink-3">
                  version
                  <select
                    className="field w-auto py-1"
                    value={v}
                    onChange={(e) =>
                      setViewV(Number(e.target.value) === latest ? null : Number(e.target.value))
                    }
                  >
                    {[...d.versions].reverse().map((x) => (
                      <option key={x.version} value={x.version}>
                        v{x.version} · {x.submitted_by ?? ""} · {x.status}
                        {x.version === latest ? " (latest)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </PageHeader>
            <GateBar pid={pid} name={name} doc={d} project={project} />
            <Tabs<Tab>
              label="Document views"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "doc", label: "Document" },
                {
                  id: "changes",
                  label: "Compare versions",
                  count: d.versions.length > 1 ? d.versions.length : 0,
                },
                { id: "comments", label: "Comments", count: commentsCount },
              ]}
            />
            <div className="pt-5">
              {tab === "doc" && (
                <DocContent
                  pid={pid}
                  name={name}
                  version={v === latest ? null : v}
                  latest={d.content ?? ""}
                />
              )}
              {tab === "changes" && <VersionDiff pid={pid} doc={d} />}
              {tab === "comments" && <Comments pid={pid} doc={d} />}
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

function DocContent({
  pid,
  name,
  version,
  latest,
}: {
  pid: string;
  name: string;
  version: number | null;
  latest: string;
}) {
  const old = useDocVersion(pid, name, version);
  if (version !== null && !old.data)
    return old.error ? <ErrorBox error={old.error} /> : <Skeleton rows={8} />;
  const text = version !== null ? (old.data?.content ?? "") : latest;
  if (/\.(ya?ml)$/i.test(name) || /openapi/i.test(name)) return <OpenApiView text={text} />;
  if (/\.json$/i.test(name))
    return <pre className="mono overflow-x-auto border border-rule bg-surface p-4 text-[12px]">{text}</pre>;
  if (!text.trim()) return <p className="text-ink-3">This version is empty.</p>;
  return (
    <article className="border border-rule bg-surface px-8 py-6">
      <Markdown text={text} />
    </article>
  );
}

// ------------------------------------------------------------------------------------------- OpenAPI

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const METHOD_COLOR: Record<string, string> = {
  get: "var(--st-ready)",
  post: "var(--st-done)",
  put: "var(--st-in_progress)",
  patch: "var(--st-changes_requested)",
  delete: "var(--st-blocked)",
};

function schemaSummary(s: unknown): string {
  if (!s || typeof s !== "object") return "";
  const o = s as Record<string, unknown>;
  if (typeof o.$ref === "string") return o.$ref.split("/").pop() ?? "";
  if (o.type === "array") return `${schemaSummary(o.items)}[]`;
  return String(o.type ?? (o.oneOf ? "oneOf" : o.allOf ? "allOf" : "object"));
}

export function OpenApiView({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    try {
      return { doc: YAML.parse(text) as Record<string, any>, err: null };
    } catch (e) {
      return { doc: null, err: (e as Error).message };
    }
  }, [text]);
  const doc = parsed.doc;
  if (!doc || typeof doc !== "object" || !doc.paths || raw) {
    return (
      <div>
        {doc?.paths && (
          <button className="btn btn-sm mb-3" onClick={() => setRaw(false)}>
            Show API table
          </button>
        )}
        {parsed.err && (
          <div className="mono mb-2 text-[12px] text-danger">YAML parse error: {parsed.err}</div>
        )}
        <pre className="mono overflow-x-auto border border-rule bg-surface p-4 text-[12px] leading-relaxed">
          {text}
        </pre>
      </div>
    );
  }
  const ops: { path: string; method: string; op: Record<string, any> }[] = [];
  for (const [p, item] of Object.entries(doc.paths as Record<string, any>))
    for (const m of METHODS) if (item?.[m]) ops.push({ path: p, method: m, op: item[m] });
  const schemas = Object.entries((doc.components?.schemas ?? {}) as Record<string, any>);
  return (
    <div className="flex flex-col gap-6" data-testid="openapi-view">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[17px] font-semibold">{doc.info?.title ?? "API"}</div>
          <div className="mono text-[12px] text-ink-3">
            OpenAPI {doc.openapi ?? doc.swagger ?? ""} · v{doc.info?.version ?? "?"} · {ops.length} operations
            · {schemas.length} schemas
          </div>
        </div>
        <button className="btn btn-sm" onClick={() => setRaw(true)}>
          View YAML
        </button>
      </div>
      <table className="w-full border-collapse border border-rule bg-surface text-[13px]">
        <thead>
          <tr className="bg-sunken text-left text-[11.5px] text-ink-3">
            <th className="border-b border-rule px-3 py-2 font-medium">Method</th>
            <th className="border-b border-rule px-3 py-2 font-medium">Path</th>
            <th className="border-b border-rule px-3 py-2 font-medium">Summary</th>
            <th className="border-b border-rule px-3 py-2 font-medium">Request</th>
            <th className="border-b border-rule px-3 py-2 font-medium">Responses</th>
          </tr>
        </thead>
        <tbody>
          {ops.map(({ path, method, op }) => {
            const req = op.requestBody?.content
              ? Object.values(op.requestBody.content as Record<string, any>)[0]?.schema
              : null;
            return (
              <tr key={`${method} ${path}`} className="border-b border-rule align-top">
                <td className="px-3 py-2">
                  <span
                    className="mono text-[11.5px] font-semibold uppercase"
                    style={{ color: METHOD_COLOR[method] ?? "var(--ink)" }}
                  >
                    {method}
                  </span>
                </td>
                <td className="mono px-3 py-2 text-[12.5px]">{path}</td>
                <td className="px-3 py-2 text-ink-2">{op.summary ?? op.operationId ?? ""}</td>
                <td className="mono px-3 py-2 text-[12px] text-ink-2">{schemaSummary(req)}</td>
                <td className="mono px-3 py-2 text-[12px] text-ink-2">
                  {Object.keys(op.responses ?? {}).join(" ")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {schemas.length > 0 && (
        <div>
          <h3 className="section-title mb-3">SCHEMAS</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {schemas.map(([n, s]) => (
              <div key={n} className="border border-rule bg-surface">
                <div className="mono border-b border-rule px-3 py-1.5 text-[12.5px] font-semibold">{n}</div>
                <ul className="px-3 py-2 text-[12px]">
                  {Object.entries((s?.properties ?? {}) as Record<string, unknown>).map(([k, v]) => (
                    <li key={k} className="mono flex justify-between gap-2">
                      <span>
                        {k}
                        {(s.required as string[] | undefined)?.includes(k) ? (
                          <span className="text-danger">*</span>
                        ) : (
                          ""
                        )}
                      </span>
                      <span className="text-ink-3">{schemaSummary(v)}</span>
                    </li>
                  ))}
                  {!s?.properties && <li className="mono text-ink-3">{schemaSummary(s)}</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------- versions diff

function VersionDiff({ pid, doc }: { pid: string; doc: DocDetail }) {
  const latest = doc.version;
  const [a, setA] = useState(Math.max(1, latest - 1));
  const [b, setB] = useState(latest);
  const va = useDocVersion(pid, doc.name, a);
  const vb = useDocVersion(pid, doc.name, b);
  if (doc.versions.length < 2)
    return (
      <p className="text-[13px] text-ink-3">
        Only one version so far. When the author revises this document, compare versions here.
      </p>
    );
  const patch =
    va.data && vb.data
      ? createTwoFilesPatch(doc.name, doc.name, va.data.content, vb.data.content, `v${a}`, `v${b}`)
      : null;
  const sel = (val: number, set: (n: number) => void, label: string) => (
    <label className="flex items-center gap-2 text-[12px] text-ink-3">
      {label}
      <select className="field w-auto py-1" value={val} onChange={(e) => set(Number(e.target.value))}>
        {doc.versions.map((x) => (
          <option key={x.version} value={x.version}>
            v{x.version}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        {sel(a, setA, "from")}
        <span className="text-ink-3">→</span>
        {sel(b, setB, "to")}
      </div>
      {va.error || vb.error ? (
        <ErrorBox error={va.error ?? vb.error} />
      ) : patch ? (
        <DiffView diff={patch} defaultFormat="side-by-side" fileList={false} />
      ) : (
        <Skeleton rows={6} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- comments

function Comments({ pid, doc }: { pid: string; doc: DocDetail }) {
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState("");
  const add = useAction<{ doc: string; body: string; anchor: string | null }>(pid, "POST", "/docs-comment", [
    "docs",
  ]);
  const headings = useMemo(() => headingsOf(doc.content ?? ""), [doc.content]);
  const all = doc.versions.flatMap((v) => (v.comments ?? []).map((c) => ({ ...c, version: v.version })));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6 max-[1100px]:grid-cols-1">
      <div>
        {all.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            No comments yet. Comments go to the author with the next revision.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {all.map((c, i) => (
              <li key={i} className="border border-rule bg-surface px-4 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                  <AgentName id={c.by} />
                  <span className="mono">v{c.version}</span>
                  {c.anchor && (
                    <a
                      className="mono underline"
                      href={`#${slugify(c.anchor)}`}
                      onClick={(e) => e.preventDefault()}
                    >
                      § {c.anchor}
                    </a>
                  )}
                  <span className="mono ml-auto">{fmtDateTime(c.ts)}</span>
                </div>
                <div className="text-[13.5px] whitespace-pre-wrap">{c.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        className="self-start border border-rule bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { doc: doc.name, body: body.trim(), anchor: anchor || null },
            {
              onSuccess: () => {
                setBody("");
                toast("Comment added");
              },
            },
          );
        }}
      >
        <h3 className="mb-3 text-[13px] font-semibold">Add a comment on v{doc.version}</h3>
        <label className="label" htmlFor="anchor">
          Section (optional)
        </label>
        <select id="anchor" className="field mb-3" value={anchor} onChange={(e) => setAnchor(e.target.value)}>
          <option value="">Whole document</option>
          {headings.map((h, i) => (
            <option key={`${h}-${i}`} value={h}>
              {h}
            </option>
          ))}
        </select>
        <label className="label" htmlFor="cbody">
          Comment
        </label>
        <textarea
          id="cbody"
          className="field min-h-[100px]"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {add.error && (
          <div className="mt-2">
            <ErrorBox error={add.error} />
          </div>
        )}
        <button type="submit" className="btn btn-primary mt-3" disabled={!body.trim() || add.isPending}>
          Add comment
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- gates

export function GateBar({
  pid,
  name,
  doc,
  project,
  sticky = false,
}: {
  pid: string;
  name: string;
  doc: DocDetail;
  project: ProjectInfo | undefined;
  sticky?: boolean;
}) {
  const gate = DOC_GATE[name];
  const [mode, setMode] = useState<null | "approve" | "changes">(null);
  const [comment, setComment] = useState("");
  const act = useAction<{ comment?: string }>(
    pid,
    "POST",
    () => `/gates/${gate}/${mode === "approve" ? "approve" : "request-changes"}`,
    ["docs", "project", "tasks"],
  );
  if (!gate) return null;
  const isOpen = gateOpenFor(name, project, doc.status);
  const changeReview =
    project?.activeChange && ["prd_review", "plan_review"].includes(project.activeChange.status)
      ? project.activeChange
      : null;
  if (!isOpen)
    return doc.status === "approved" ? (
      <div className="mb-4 flex items-center gap-2 border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-ok-soft px-4 py-2 text-[13px] text-ok">
        ✓ Approved. This gate is closed.
      </div>
    ) : null;
  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-3 border border-l-4 border-rule border-l-[var(--danger)] bg-surface px-4 py-3 ${sticky ? "sticky top-0 z-20 shadow-md" : ""}`}
      data-testid="gate-bar"
    >
      <div className="flex-1 text-[13.5px]">
        {gate === "design" ? (
          <>
            <span className="font-semibold">
              Review the screens, then approve the design or ask for changes.
            </span>{" "}
            <span className="text-ink-2">Approving moves the team on to the architecture.</span>
          </>
        ) : (
          <>
            <span className="font-semibold">Your review is needed.</span>{" "}
            <span className="text-ink-2">
              {changeReview && (gate === "prd" || gate === "plan")
                ? `${changeReview.id} updated the ${gate === "prd" ? "PRD" : "plan"}: approve v${doc.version} to continue the change, or request changes.`
                : `The ${gate} gate is open: approve v${doc.version} to move on, or request changes with a comment for the author.`}
            </span>
          </>
        )}
      </div>
      <button className="btn" onClick={() => setMode("changes")}>
        Request changes
      </button>
      <button className="btn btn-primary" onClick={() => setMode("approve")}>
        Approve {name}
      </button>
      <Modal
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === "approve" ? `Approve ${name} v${doc.version}?` : `Request changes on ${name}`}
        footer={
          <>
            <button className="btn" onClick={() => setMode(null)}>
              Cancel
            </button>
            <button
              className={`btn ${mode === "approve" ? "btn-primary" : "btn-danger"}`}
              disabled={act.isPending || (mode === "changes" && !comment.trim())}
              onClick={() =>
                act.mutate(comment.trim() ? { comment: comment.trim() } : {}, {
                  onSuccess: () => {
                    toast(
                      mode === "approve" ? `${name} approved` : "Changes requested; the author is revising",
                    );
                    setMode(null);
                    setComment("");
                  },
                })
              }
            >
              {mode === "approve" ? "Approve" : "Send to author"}
            </button>
          </>
        }
      >
        <label className="label" htmlFor="gate-comment">
          {mode === "approve" ? "Comment (optional)" : "What should change? (required)"}
        </label>
        <textarea
          id="gate-comment"
          className="field min-h-[110px]"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {act.error && (
          <div className="mt-3">
            <ErrorBox error={act.error} />
          </div>
        )}
      </Modal>
    </div>
  );
}
