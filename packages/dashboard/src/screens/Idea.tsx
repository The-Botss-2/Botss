import { useState } from "react";
import { Markdown } from "../components/Markdown";
import { ErrorBox, Icon, Loadable, PageHeader, toast } from "../components/ui";
import { useAction, useProject } from "../lib/queries";
import { href } from "../lib/router";

const STAKES = [
  { v: "hobby", label: "Hobby project", hint: "Speed over polish; fewer checks." },
  { v: "internal tool", label: "Internal tool", hint: "A handful of trusted users." },
  { v: "customer-facing", label: "Customer-facing", hint: "Real users; quality and security matter." },
  { v: "regulated", label: "Regulated", hint: "Health, finance, legal: audits and strict review." },
];
const MAX = 10 * 1024 * 1024;

interface Att {
  name: string;
  size: number;
  data: string;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function IdeaScreen({ pid }: { pid: string }) {
  const project = useProject(pid);
  return (
    <Loadable q={project}>
      {(p) =>
        p.phase === "idea" ? (
          <IdeaForm pid={pid} />
        ) : (
          <div className="max-w-3xl">
            <PageHeader title="The idea" kicker="submitted · read only" />
            {p.state.idea ? (
              <div className="border border-rule bg-surface p-5" data-testid="idea-readonly">
                {p.state.idea.stakes && (
                  <div className="mono mb-3 text-[12px] text-ink-3">
                    stakes: <span className="text-ink">{p.state.idea.stakes}</span>
                  </div>
                )}
                <Markdown text={p.state.idea.text} />
                {p.state.idea.links.length > 0 && (
                  <>
                    <h2 className="section-title mt-5 mb-2">LINKS</h2>
                    <ul className="text-[13px]">
                      {p.state.idea.links.map((l) => (
                        <li key={l} className="mono truncate">
                          <a
                            className="text-accent underline"
                            href={l}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {l}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {p.state.idea.attachments.length > 0 && (
                  <>
                    <h2 className="section-title mt-5 mb-2">ATTACHMENTS</h2>
                    <ul className="mono text-[12.5px] text-ink-2">
                      {p.state.idea.attachments.map((a) => (
                        <li key={a}>.botss/docs/attachments/{a}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <p className="text-ink-2">
                This project started without an idea in the dashboard (the plan was imported directly). See{" "}
                <a className="text-accent underline" href={href(pid, "docs")}>
                  Documents
                </a>
                .
              </p>
            )}
          </div>
        )
      }
    </Loadable>
  );
}

function IdeaForm({ pid }: { pid: string }) {
  const [text, setText] = useState("");
  const [stakes, setStakes] = useState("internal tool");
  const [links, setLinks] = useState<string[]>([]);
  const [link, setLink] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const submit = useAction<{
    text: string;
    stakes: string;
    links: string[];
    attachments: { name: string; data: string }[];
  }>(pid, "POST", "/idea", ["project", "docs", "tasks"]);

  const addLink = () => {
    if (link.trim()) {
      setLinks((l) => [...l, link.trim()]);
      setLink("");
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setFileErr(null);
    const next: Att[] = [];
    for (const f of Array.from(files)) {
      if (f.size > MAX) {
        setFileErr(`${f.name} is larger than 10 MB.`);
        continue;
      }
      next.push({ name: f.name, size: f.size, data: await toBase64(f) });
    }
    setAtts((a) => [...a, ...next].slice(0, 20));
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="What should the team build?" kicker="phase 0 · idea" />
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate(
            { text, stakes, links, attachments: atts.map(({ name, data }) => ({ name, data })) },
            { onSuccess: () => toast("Idea submitted. The product manager is reading it.") },
          );
        }}
      >
        <div>
          <label className="label" htmlFor="idea-text">
            Describe the app
          </label>
          <textarea
            id="idea-text"
            className="field min-h-[220px] text-[14px] leading-relaxed"
            placeholder="A booking app for my barbershop: customers pick a barber and a slot, pay a deposit, and get a reminder the day before. I want to see tomorrow's schedule on my phone…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            minLength={3}
          />
          <div className="hint mt-1">
            Who uses it, what they do, what must never go wrong. The PM asks follow-up questions next.
          </div>
        </div>

        <fieldset>
          <legend className="label">Stakes</legend>
          <div className="grid grid-cols-4 gap-2 max-[1100px]:grid-cols-2">
            {STAKES.map((s) => (
              <label
                key={s.v}
                className={`cursor-pointer border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${stakes === s.v ? "border-ink bg-surface" : "border-rule hover:border-rule-strong"}`}
              >
                <input
                  type="radio"
                  name="stakes"
                  className="sr-only"
                  value={s.v}
                  checked={stakes === s.v}
                  onChange={() => setStakes(s.v)}
                />
                <div className="text-[13px] font-semibold">{s.label}</div>
                <div className="mt-0.5 text-[12px] text-ink-3">{s.hint}</div>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="link">
            Links (references, competitors, existing site)
          </label>
          <div className="flex gap-2">
            <input
              id="link"
              className="field mono"
              placeholder="https://"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLink();
                }
              }}
            />
            <button type="button" className="btn" onClick={addLink}>
              Add
            </button>
          </div>
          {links.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {links.map((l, i) => (
                <li
                  key={`${l}-${i}`}
                  className="mono flex items-center justify-between border border-rule bg-surface px-2 py-1 text-[12px]"
                >
                  <span className="truncate">{l}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Remove ${l}`}
                    onClick={() => setLinks((x) => x.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label className="label" htmlFor="files">
            Attachments (sketches, screenshots, briefs; up to 10 MB each)
          </label>
          <input
            id="files"
            type="file"
            multiple
            className="block text-[13px] file:mr-3 file:border file:border-rule-strong file:bg-surface file:px-3 file:py-1 file:text-[13px]"
            onChange={(e) => void addFiles(e.target.files)}
          />
          {fileErr && (
            <div className="mt-1 text-[12px] text-danger" role="alert">
              {fileErr}
            </div>
          )}
          {atts.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {atts.map((a, i) => (
                <li
                  key={`${a.name}-${i}`}
                  className="mono flex items-center justify-between border border-rule bg-surface px-2 py-1 text-[12px]"
                >
                  <span>
                    {a.name} <span className="text-ink-3">({Math.ceil(a.size / 1024)} KB)</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {submit.error && <ErrorBox error={submit.error} />}
        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={text.trim().length < 3 || submit.isPending}
          >
            {submit.isPending ? "Submitting…" : "Submit idea to the team"}
          </button>
        </div>
      </form>
    </div>
  );
}
