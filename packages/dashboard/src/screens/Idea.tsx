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
        p.phase === "idea" || p.phase === "done" ? (
          <IdeaForm pid={pid} existing={Boolean(p.settings.existing) || p.phase === "done"} next={p.phase === "done"} />
        ) : (
          <div className="max-w-3xl">
            <PageHeader title="The current request" kicker="submitted · read only" />
            <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="request-status">
              <span className="mono border border-rule bg-surface px-2 py-1 text-[12px]" data-testid="track">
                process: {p.state.track ? TRACK_LABEL[p.state.track] : "being sized by the tech lead"}
              </span>
              <CancelWork pid={pid} />
            </div>
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

const TRACK_LABEL: Record<string, string> = {
  quick: "quick: built right away",
  standard: "standard: short PRD, then a plan",
  full: "full: discovery, design, and architecture",
};

const TRACKS = [
  { v: "auto", label: "Auto", hint: "The tech lead sizes it first. Recommended." },
  { v: "quick", label: "Quick", hint: "Small change: build it now, no PRD or design." },
  { v: "standard", label: "Standard", hint: "A feature: short PRD and a plan to approve." },
  { v: "full", label: "Full", hint: "New product: questions, PRD, design, architecture." },
] as const;

/** Stop the current request (agents, open questions, unfinished tasks); finished work stays. */
function CancelWork({ pid }: { pid: string }) {
  const [confirm, setConfirm] = useState(false);
  const cancel = useAction<Record<string, never>>(pid, "POST", "/cancel", ["project", "tasks", "questions", "agents", "docs"]);
  if (!confirm)
    return (
      <button type="button" className="btn" onClick={() => setConfirm(true)} data-testid="cancel-work">
        Cancel current work
      </button>
    );
  return (
    <span className="flex items-center gap-2 text-[13px]">
      Stop the agents and drop unfinished tasks? Finished work stays in your folder.
      <button
        type="button"
        className="btn btn-danger"
        data-testid="cancel-work-confirm"
        onClick={() => cancel.mutate({}, { onSuccess: () => (toast("Cancelled. Send a new request when you are ready."), setConfirm(false)) })}
      >
        Yes, cancel
      </button>
      <button type="button" className="btn" onClick={() => setConfirm(false)}>
        Keep working
      </button>
    </span>
  );
}

function IdeaForm({ pid, existing, next = false }: { pid: string; existing: boolean; next?: boolean }) {
  const [text, setText] = useState("");
  const [track, setTrack] = useState<(typeof TRACKS)[number]["v"]>("auto");
  const [kind, setKind] = useState<"new" | "feature" | "fix">(existing ? "feature" : "new");
  const [stakes, setStakes] = useState("internal tool");
  const [links, setLinks] = useState<string[]>([]);
  const [link, setLink] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const submit = useAction<{
    text: string;
    stakes: string;
    kind: string;
    track: string;
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
      <PageHeader
        title={next ? "What's next?" : existing ? "What should the team change?" : "What should the team build?"}
        kicker={next ? "new request" : existing ? "phase 0 · existing codebase" : "phase 0 · idea"}
      />
      <div
        className="mb-5 border border-l-4 border-rule border-l-[var(--accent)] bg-surface px-4 py-3 text-[13px] text-ink-2"
        data-testid="existing-note"
      >
        {next
          ? "The last request is done. Ask for the next change; small changes are built right away."
          : existing
            ? "The tech lead sizes your request first: small changes are built right away, bigger ones get a short spec and a plan for you to approve."
            : "The tech lead sizes your request first, then the team follows just enough process for it."}
      </div>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate(
            { text, stakes, kind, track, links, attachments: atts.map(({ name, data }) => ({ name, data })) },
            {
              onSuccess: () =>
                toast(
                  track === "full"
                    ? "Submitted. The team starts the full process."
                    : track === "auto"
                      ? "Submitted. The tech lead is sizing it."
                      : `Submitted on the ${track} track.`,
                ),
            },
          );
        }}
      >
        {existing && (
          <fieldset>
            <legend className="label">Kind of change</legend>
            <div className="flex gap-2">
              {(
                [
                  ["feature", "New feature", "Add or extend behaviour."],
                  ["fix", "Fix", "Something is broken or wrong."],
                ] as const
              ).map(([v, label, hint]) => (
                <label
                  key={v}
                  className={`flex-1 cursor-pointer border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${kind === v ? "border-ink bg-surface" : "border-rule hover:border-rule-strong"}`}
                  data-testid={`kind-${v}`}
                >
                  <input
                    type="radio"
                    name="kind"
                    className="sr-only"
                    value={v}
                    checked={kind === v}
                    onChange={() => setKind(v)}
                  />
                  <div className="text-[13px] font-semibold">{label}</div>
                  <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div>
          <label className="label" htmlFor="idea-text">
            {existing
              ? kind === "fix"
                ? "Describe the problem"
                : "Describe the change"
              : "Describe the app"}
          </label>
          <textarea
            id="idea-text"
            className="field min-h-[220px] text-[14px] leading-relaxed"
            placeholder={
              existing
                ? kind === "fix"
                  ? "When a customer cancels within 4 hours, the deposit is still refunded. It should be kept. Steps: book a slot, cancel 2 hours before, check Stripe…"
                  : "Add SMS reminders the evening before each booking, with an opt-out link. Barbers should see who opted out on the Today screen…"
                : "A booking app for my barbershop: customers pick a barber and a slot, pay a deposit, and get a reminder the day before. I want to see tomorrow's schedule on my phone…"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            minLength={3}
          />
          <div className="hint mt-1">
            {existing
              ? "What should change and how you will know it works. The team builds only what you ask for."
              : "Who uses it, what they do, what must never go wrong. The team builds only what you ask for."}
          </div>
        </div>

        <fieldset>
          <legend className="label">Process</legend>
          <div className="grid grid-cols-4 gap-2 max-[1100px]:grid-cols-2">
            {TRACKS.map((t) => (
              <label
                key={t.v}
                className={`cursor-pointer border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${track === t.v ? "border-ink bg-surface" : "border-rule hover:border-rule-strong"}`}
                data-testid={`track-${t.v}`}
              >
                <input type="radio" name="track" className="sr-only" value={t.v} checked={track === t.v} onChange={() => setTrack(t.v)} />
                <div className="text-[13px] font-semibold">{t.label}</div>
                <div className="mt-0.5 text-[12px] text-ink-3">{t.hint}</div>
              </label>
            ))}
          </div>
        </fieldset>

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
