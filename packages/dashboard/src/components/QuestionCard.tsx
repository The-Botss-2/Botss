import { useState } from "react";
import { useAction } from "../lib/queries";
import { fmtAgo } from "../lib/format";
import type { BatchOption, BatchQuestion, Question } from "../lib/types";
import { Markdown } from "./Markdown";
import { AgentName, Badge, ErrorBox, toast } from "./ui";

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/** Best-effort palette extraction from a direction option (structured `palette` or hex codes in the text). */
export function optionColors(o: BatchOption): { name?: string; hex: string }[] {
  const out: { name?: string; hex: string }[] = [];
  const pal = (o.palette ?? o.colors) as unknown;
  if (Array.isArray(pal)) {
    for (const c of pal) {
      if (typeof c === "string" && /^#/.test(c)) out.push({ hex: c });
      else if (c && typeof c === "object") {
        const r = c as Record<string, unknown>;
        const hex = String(r.hex ?? r.value ?? r.color ?? "");
        if (/^#/.test(hex)) out.push({ name: String(r.name ?? r.role ?? ""), hex });
      }
    }
  } else if (pal && typeof pal === "object") {
    for (const [k, v] of Object.entries(pal as Record<string, unknown>))
      if (typeof v === "string" && /^#/.test(v)) out.push({ name: k, hex: v });
  }
  if (!out.length) {
    const text = [o.label, o.description, o.mood, typeof o.details === "string" ? o.details : ""]
      .filter(Boolean)
      .join(" ");
    for (const m of text.matchAll(HEX))
      if (!out.some((x) => x.hex.toLowerCase() === m[0].toLowerCase())) out.push({ hex: m[0] });
  }
  return out.slice(0, 8);
}

function OptionExtras({ o }: { o: BatchOption }) {
  const colors = optionColors(o);
  const type = (o.type ?? o.typography ?? o.fonts) as unknown;
  const mood = o.mood as unknown;
  return (
    <>
      {colors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Palette">
          {colors.map((c) => (
            <span
              key={c.hex + (c.name ?? "")}
              className="flex items-center gap-1"
              title={`${c.name ? `${c.name} ` : ""}${c.hex}`}
            >
              <span className="h-5 w-5 border border-rule-strong" style={{ background: c.hex }} />
              <span className="mono text-[10.5px] text-ink-3">{c.name || c.hex}</span>
            </span>
          ))}
        </div>
      )}
      {typeof type === "string" && <div className="mt-1.5 text-[12px] text-ink-2">Type: {type}</div>}
      {typeof mood === "string" && <div className="mt-1 text-[12px] text-ink-3 italic">{mood}</div>}
      {typeof o.description === "string" && o.description && (
        <div className="mt-1 text-[12.5px] text-ink-2">{o.description}</div>
      )}
    </>
  );
}

function BatchItem({
  q,
  value,
  onChange,
  note,
  onNote,
  rich,
}: {
  q: BatchQuestion;
  value: string;
  onChange: (v: string) => void;
  note: string;
  onNote: (v: string) => void;
  rich: boolean;
}) {
  const [showNote, setShowNote] = useState(Boolean(note));
  const name = `q-${q.id}`;
  return (
    <fieldset className="border-t border-rule py-4 first:border-t-0" data-testid={`batch-q-${q.id}`}>
      <legend className="sr-only">{q.question}</legend>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="mono text-[11px] text-ink-3">{q.id}</span>
        {q.topic && <span className="mono text-[11px] font-medium text-ink-2">{q.topic}</span>}
      </div>
      <div className="mb-3 text-[14.5px] font-semibold">{q.question}</div>
      <div
        className={
          rich ? "grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2" : "flex flex-col gap-1.5"
        }
      >
        {(q.options ?? []).map((o) => {
          const rec = q.recommended === o.key;
          const checked = value === o.key;
          return (
            <label
              key={o.key}
              className={`flex cursor-pointer items-start gap-2.5 border px-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${checked ? "border-ink bg-surface" : rec ? "border-[color-mix(in_srgb,var(--ok)_55%,transparent)] bg-ok-soft/40" : "border-rule hover:border-rule-strong"}`}
            >
              <input
                type="radio"
                name={name}
                value={o.key}
                checked={checked}
                onChange={() => onChange(o.key)}
                className="mt-[3px] accent-[var(--ink)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[12px] font-semibold">{o.key}</span>
                  <span className="text-[13.5px]">{o.label}</span>
                  {rec && <Badge tone="ok">recommended</Badge>}
                </span>
                {rich && <OptionExtras o={o} />}
              </span>
            </label>
          );
        })}
        {!q.options?.length && (
          <input
            className="field"
            aria-label={`Answer to ${q.id}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Your answer"
          />
        )}
      </div>
      {q.why_it_matters && (
        <div className="mt-2 flex gap-2 text-[12.5px] text-ink-2">
          <span className="mono shrink-0 text-[11px] text-ink-3">why it matters</span>
          <span>{q.why_it_matters}</span>
        </div>
      )}
      <div className="mt-2">
        {showNote ? (
          <input
            className="field text-[12.5px]"
            aria-label={`Note for ${q.id}`}
            placeholder="Add a note (optional), e.g. 'B, but only for staff'"
            value={note}
            onChange={(e) => onNote(e.target.value)}
          />
        ) : (
          <button
            type="button"
            className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
            onClick={() => setShowNote(true)}
          >
            + add a note
          </button>
        )}
      </div>
    </fieldset>
  );
}

/** One open question for the owner: a batch (radio options) or a single ask (free text). */
export function QuestionCard({ pid, q, rich = false }: { pid: string; q: Question; rich?: boolean }) {
  const qs = q.batch?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  const [single, setSingle] = useState("");
  const answer = useAction<{ answer: unknown }>(
    pid,
    "POST",
    `/questions/${encodeURIComponent(q.id)}/answer`,
    ["questions", "project", "tasks", "docs"],
  );
  const done = () => toast(`Answered ${q.id}. ${q.from_agent} continues.`);

  const recommended = Object.fromEntries(qs.map((x) => [x.id, x.recommended ?? x.options?.[0]?.key ?? ""]));
  const unanswered = qs.filter((x) => !answers[x.id]);

  return (
    <article
      className="border border-rule bg-surface"
      data-testid={`question-${q.id}`}
      aria-labelledby={`qh-${q.id}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-rule px-5 py-3">
        <span className="mono text-[12px] font-semibold">{q.id}</span>
        <AgentName id={q.from_agent} />
        {q.task && <span className="mono text-[12px] text-ink-3">on {q.task}</span>}
        <span className="mono ml-auto text-[11px] text-ink-3">{fmtAgo(q.created_at)}</span>
      </header>
      <div className="px-5 py-4">
        {q.batch ? (
          <>
            <div id={`qh-${q.id}`} className="mb-2 text-[14px] text-ink-2">
              {q.batch.intro ?? q.body}
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate(
                    { answer: { answers: recommended, notes, freeText, acceptedRecommendations: true } },
                    { onSuccess: done },
                  )
                }
                data-testid="accept-all"
              >
                Accept all recommendations
              </button>
              <span className="text-[12px] text-ink-3">or pick below and submit</span>
            </div>
            {qs.map((x) => (
              <BatchItem
                key={x.id}
                q={x}
                rich={rich}
                value={answers[x.id] ?? ""}
                onChange={(v) => setAnswers((a) => ({ ...a, [x.id]: v }))}
                note={notes[x.id] ?? ""}
                onNote={(v) => setNotes((n) => ({ ...n, [x.id]: v }))}
              />
            ))}
            <div className="border-t border-rule pt-4">
              <label className="label" htmlFor={`free-${q.id}`}>
                Anything else? (free text)
              </label>
              <textarea
                id={`free-${q.id}`}
                className="field min-h-[70px]"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="e.g. 'B, but warmer colours'"
              />
            </div>
            {answer.error && (
              <div className="mt-3">
                <ErrorBox error={answer.error} />
              </div>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate(
                    { answer: { answers: { ...recommended, ...answers }, notes, freeText } },
                    { onSuccess: done },
                  )
                }
              >
                Submit answers
              </button>
              {unanswered.length > 0 && (
                <span className="text-[12px] text-ink-3">
                  {unanswered.length} unanswered will use the recommendation.
                </span>
              )}
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (single.trim()) answer.mutate({ answer: single.trim() }, { onSuccess: done });
            }}
          >
            <div id={`qh-${q.id}`}>
              <Markdown text={q.body} className="mb-3 text-[14px]" />
            </div>
            <label className="label" htmlFor={`ans-${q.id}`}>
              Your answer
            </label>
            <textarea
              id={`ans-${q.id}`}
              className="field min-h-[90px]"
              value={single}
              onChange={(e) => setSingle(e.target.value)}
            />
            {answer.error && (
              <div className="mt-3">
                <ErrorBox error={answer.error} />
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary mt-3"
              disabled={!single.trim() || answer.isPending}
            >
              Send answer
            </button>
          </form>
        )}
      </div>
    </article>
  );
}
