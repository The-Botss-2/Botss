import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, ErrorBox, Loadable, Modal, PageHeader, RoleChip, Skeleton, toast } from "../components/ui";
import { api, pp } from "../lib/api";
import { fmtTokens } from "../lib/format";
import { useAction, useProject, useSkillFile, useSkills } from "../lib/queries";
import { GATES, PERMISSION_MODES, ROLES, type ProjectInfo, type Settings } from "../lib/types";

const GATE_LABELS: Record<string, string> = {
  prd: "PRD approval",
  design_direction: "Design direction pick",
  design: "Design (screens) approval",
  architecture: "Architecture approval",
  plan: "Plan & team approval",
  release: "Release approval",
};

const PERMISSION_HELP: Record<string, string> = {
  dontAsk: "Only the allowlisted tools run; anything else is refused without prompting. Recommended.",
  acceptEdits: "File edits are accepted automatically; other tools follow the allowlist.",
  default: "Claude Code's default prompting. Headless runs cannot answer prompts, so unlisted tools fail.",
  plan: "Read-only planning mode. Agents cannot change files; only useful for experiments.",
  auto: "Claude decides on its own which tools to run. Fewer guard rails.",
  bypassPermissions:
    "Every tool runs without any permission check, including shell commands outside the allowlist.",
};

export function SettingsScreen({ pid }: { pid: string }) {
  const project = useProject(pid);
  return (
    <div className="max-w-5xl">
      <PageHeader title="Settings" kicker="scheduler · budget · gates · models · safety · skills" />
      <Loadable q={project} rows={10}>
        {(p) => <SettingsForm key={p.id} pid={pid} p={p} />}
      </Loadable>
      <div className="mt-12">
        <SkillsEditor pid={pid} />
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)] items-start gap-6 border-b border-rule py-3 max-[1100px]:grid-cols-1 max-[1100px]:gap-1">
      <div>
        <label className="text-[13px] font-medium" htmlFor={htmlFor}>
          {label}
        </label>
        {hint && <div className="hint mt-0.5">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SettingsForm({ pid, p }: { pid: string; p: ProjectInfo }) {
  const [draft, setDraft] = useState<Settings>(p.settings);
  const [newCheck, setNewCheck] = useState("");
  const save = useAction<Partial<Settings>, Settings>(pid, "PATCH", "/settings", ["project", "usage"]);
  useEffect(() => setDraft(p.settings), [p.settings]);

  const changed = useMemo(() => {
    const out: Partial<Settings> = {};
    for (const k of Object.keys(draft) as (keyof Settings)[])
      if (JSON.stringify(draft[k]) !== JSON.stringify(p.settings[k]))
        (out as Record<string, unknown>)[k] = draft[k];
    return out;
  }, [draft, p.settings]);
  const dirty = Object.keys(changed).length > 0;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (k: keyof Settings, v: string) => set(k, (v === "" ? 0 : Number(v)) as never);
  const risky = draft.permission_mode === "bypassPermissions" || draft.permission_mode === "auto";
  const allowance =
    draft.daily_token_budget > 0
      ? Math.floor((draft.daily_token_budget * (100 - draft.reserve_percent)) / 100)
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(changed, { onSuccess: () => toast("Settings saved") });
      }}
      data-testid="settings-form"
    >
      <h2 className="section-title mb-1">SCHEDULER & BUDGET</h2>
      <Row label="Agents running at once" hint="Upper bound across all roles." htmlFor="s-max">
        <input
          id="s-max"
          type="number"
          min={1}
          max={32}
          className="field mono w-28"
          value={draft.max_concurrent_agents}
          onChange={(e) => num("max_concurrent_agents", e.target.value)}
        />
      </Row>
      <Row
        label="Daily token budget"
        hint="Input + output + cache-write tokens per day. 0 means no budget."
        htmlFor="s-budget"
      >
        <div className="flex items-center gap-3">
          <input
            id="s-budget"
            type="number"
            min={0}
            step={100000}
            className="field mono w-40"
            value={draft.daily_token_budget}
            onChange={(e) => num("daily_token_budget", e.target.value)}
          />
          <span className="mono text-[12px] text-ink-3">{fmtTokens(draft.daily_token_budget)}</span>
        </div>
      </Row>
      <Row
        label="Reserve for you"
        hint={
          allowance !== null
            ? `Botss stops starting runs at ${fmtTokens(allowance)} tokens a day.`
            : undefined
        }
        htmlFor="s-reserve"
      >
        <div className="flex items-center gap-3">
          <input
            id="s-reserve"
            type="range"
            min={0}
            max={90}
            step={5}
            value={draft.reserve_percent}
            onChange={(e) => num("reserve_percent", e.target.value)}
            className="w-56 accent-[var(--ink)]"
          />
          <span className="mono text-[13px]">{draft.reserve_percent}%</span>
        </div>
      </Row>
      <Row
        label="Resume after a usage limit"
        hint="When Claude Code reports a limit, wait for the reset and continue automatically."
      >
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={draft.auto_resume_after_limit}
            onChange={(e) => set("auto_resume_after_limit", e.target.checked)}
          />
          Auto-resume
        </label>
      </Row>
      <Row label="Run timeout" hint="Minutes before a single agent run is stopped." htmlFor="s-timeout">
        <input
          id="s-timeout"
          type="number"
          min={1}
          className="field mono w-28"
          value={draft.run_timeout_minutes}
          onChange={(e) => num("run_timeout_minutes", e.target.value)}
        />
      </Row>

      <h2 className="section-title mt-8 mb-1">GATES · where Botss waits for you</h2>
      <Row label="Approval gates" hint="Turning a gate off auto-approves at that step. All on by default.">
        <div className="grid grid-cols-2 gap-1.5">
          {GATES.map((g) => (
            <label key={g} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={draft.gates[g] !== false}
                onChange={(e) => set("gates", { ...draft.gates, [g]: e.target.checked })}
                data-testid={`gate-${g}`}
              />
              {GATE_LABELS[g]}
            </label>
          ))}
        </div>
      </Row>
      <Row label="QA every task" hint="A QA agent verifies each task before merge.">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={draft.qa_per_task}
            onChange={(e) => set("qa_per_task", e.target.checked)}
          />
          QA per task
        </label>
      </Row>
      <Row label="Security audit" hint="A security engineer audits the release candidate.">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={draft.security_audit}
            onChange={(e) => set("security_audit", e.target.checked)}
          />
          Run a security audit before release
        </label>
      </Row>

      <h2 className="section-title mt-8 mb-1">MODELS & TURNS PER ROLE</h2>
      <Row
        label="Per role"
        hint="Model alias or full id; blank uses Claude Code's default. Max turns blank uses the default below."
      >
        <div className="grid grid-cols-[110px_minmax(0,1fr)_100px] items-center gap-x-3 gap-y-1.5">
          <span className="mono text-[10.5px] text-ink-3">role</span>
          <span className="mono text-[10.5px] text-ink-3">model</span>
          <span className="mono text-[10.5px] text-ink-3">max turns</span>
          {ROLES.map((r) => (
            <RoleModelRow
              key={r}
              role={r}
              model={draft.models[r] ?? ""}
              turns={draft.max_turns[r]}
              onModel={(v) => {
                const m = { ...draft.models };
                if (v) m[r] = v;
                else delete m[r];
                set("models", m);
              }}
              onTurns={(v) => {
                const m = { ...draft.max_turns };
                if (v) m[r] = v;
                else delete m[r];
                set("max_turns", m);
              }}
            />
          ))}
        </div>
        <datalist id="settings-models">
          {["opus", "sonnet", "haiku", "fable"].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Row>
      <Row label="Default max turns" htmlFor="s-turns">
        <input
          id="s-turns"
          type="number"
          min={1}
          className="field mono w-28"
          value={draft.default_max_turns}
          onChange={(e) => num("default_max_turns", e.target.value)}
        />
      </Row>

      <h2 className="section-title mt-8 mb-1">SAFETY</h2>
      <Row
        label="Permission mode"
        hint="How Claude Code treats tools outside the allowlist."
        htmlFor="s-perm"
      >
        <select
          id="s-perm"
          className="field mono w-60"
          value={draft.permission_mode}
          onChange={(e) => set("permission_mode", e.target.value)}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="mt-1.5 text-[12.5px] text-ink-2">{PERMISSION_HELP[draft.permission_mode]}</div>
        {risky && (
          <div
            role="alert"
            className="mt-3 border border-l-4 border-[color-mix(in_srgb,var(--danger)_45%,transparent)] border-l-[var(--danger)] bg-danger-soft px-4 py-3 text-[13px] text-ink"
            data-testid="permission-warning"
          >
            <div className="mb-1 font-semibold text-danger">Agents get far more power in this mode</div>
            With <code className="mono">{draft.permission_mode}</code>, agents can run commands Botss did not
            allowlist, on your machine, with your user account. The Botss guard hook still blocks writes
            outside each task's files and force pushes, but a confused agent can do real damage. Use it only
            on a throwaway machine or container, and keep the kill switch in reach.
          </div>
        )}
      </Row>
      <Row
        label="Integration checks"
        hint="Run on the integration branch after every merge. Usually set by the scaffold task."
      >
        <ul className="mb-2 flex flex-col gap-1">
          {draft.checks.map((c, i) => (
            <li key={`${c}-${i}`} className="flex items-center gap-2">
              <input
                className="field mono py-1 text-[12px]"
                value={c}
                aria-label={`Check ${i + 1}`}
                onChange={(e) =>
                  set(
                    "checks",
                    draft.checks.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`Remove check ${i + 1}`}
                onClick={() =>
                  set(
                    "checks",
                    draft.checks.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
          {draft.checks.length === 0 && <li className="text-[12.5px] text-ink-3">No checks yet.</li>}
        </ul>
        <div className="flex gap-2">
          <input
            className="field mono py-1 text-[12px]"
            placeholder="pnpm test"
            aria-label="New check command"
            value={newCheck}
            onChange={(e) => setNewCheck(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!newCheck.trim()}
            onClick={() => {
              set("checks", [...draft.checks, newCheck.trim()]);
              setNewCheck("");
            }}
          >
            Add check
          </button>
        </div>
      </Row>

      <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center gap-3 border-t border-rule bg-surface px-6 py-3">
        {save.error && <ErrorBox error={save.error} />}
        <span className="flex-1 text-[12.5px] text-ink-3">
          {dirty
            ? `${Object.keys(changed).length} unsaved change${Object.keys(changed).length === 1 ? "" : "s"}: ${Object.keys(changed).join(", ")}`
            : "All changes saved."}
        </span>
        <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(p.settings)}>
          Discard
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!dirty || save.isPending}
          data-testid="save-settings"
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

function RoleModelRow({
  role,
  model,
  turns,
  onModel,
  onTurns,
}: {
  role: string;
  model: string;
  turns: number | undefined;
  onModel: (v: string) => void;
  onTurns: (v: number | null) => void;
}) {
  return (
    <>
      <RoleChip role={role} />
      <input
        className="field mono py-1 text-[12px]"
        list="settings-models"
        placeholder="default"
        aria-label={`Model for ${role}`}
        value={model}
        onChange={(e) => onModel(e.target.value.trim())}
      />
      <input
        className="field mono py-1 text-[12px]"
        type="number"
        min={1}
        placeholder="default"
        aria-label={`Max turns for ${role}`}
        value={turns ?? ""}
        onChange={(e) => onTurns(e.target.value ? Number(e.target.value) : null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- skills

function SkillsEditor({ pid }: { pid: string }) {
  const skills = useSkills(pid);
  const [sel, setSel] = useState<string | null>(null);
  return (
    <section aria-labelledby="skills-h">
      <h2 id="skills-h" className="section-title mb-1">
        SKILLS · what each agent is taught
      </h2>
      <p className="mb-4 text-[12.5px] text-ink-3">
        These files are appended to the agents' system prompts. Edits are committed to the integration branch
        and apply to the next run.
      </p>
      <Loadable q={skills} rows={6}>
        {(s) => {
          const groups = new Map<string, string[]>();
          for (const f of s.files) {
            const g = f.split("/")[0]!;
            groups.set(g, [...(groups.get(g) ?? []), f]);
          }
          const usedBy = (skill: string) =>
            Object.entries(s.roles)
              .filter(([, list]) => list.includes(skill))
              .map(([r]) => r);
          return (
            <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4 max-[1100px]:grid-cols-[200px_minmax(0,1fr)]">
              <nav
                aria-label="Skill files"
                className="max-h-[640px] overflow-y-auto border border-rule bg-surface"
              >
                {[...groups.entries()].map(([g, files]) => (
                  <div key={g} className="border-b border-rule last:border-b-0">
                    <div className="flex flex-wrap items-center gap-1 px-2 pt-2 pb-1">
                      <span className="mono text-[11.5px] font-semibold">{g}</span>
                      {usedBy(g).map((r) => (
                        <RoleChip key={r} role={r} short />
                      ))}
                    </div>
                    <ul className="pb-1">
                      {files.map((f) => (
                        <li key={f}>
                          <button
                            className={`mono w-full truncate px-3 py-0.5 text-left text-[11.5px] ${sel === f ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunken"}`}
                            aria-current={sel === f}
                            onClick={() => setSel(f)}
                          >
                            {f.slice(g.length + 1)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
              <div className="min-w-0">
                {sel ? (
                  <SkillFileEditor key={sel} pid={pid} path={sel} />
                ) : (
                  <p className="pt-2 text-[13px] text-ink-3">Pick a file to view or edit it.</p>
                )}
              </div>
            </div>
          );
        }}
      </Loadable>
    </section>
  );
}

function SkillFileEditor({ pid, path }: { pid: string; path: string }) {
  const q = useSkillFile(pid, path);
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const tabEscape = useRef(false);
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton rows={10} />;
  const value = text ?? q.data.content;
  const dirty = text !== null && text !== q.data.content;
  const refresh = () => qc.invalidateQueries({ queryKey: ["p", pid, "skills"] });
  const saveFile = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("PUT", pp(pid, "/skills/file"), { path, content: value });
      await refresh();
      setText(null);
      toast(`Saved ${path}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const resetFile = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("POST", pp(pid, "/skills/reset"), { path });
      await refresh();
      setText(null);
      setConfirmReset(false);
      toast(`${path} reset to the default`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[12.5px] font-semibold">{path}</span>
        {q.data.modified && <Badge tone="warn">edited</Badge>}
        {dirty && <Badge tone="danger">unsaved</Badge>}
        <span className="ml-auto" />
        {q.data.hasDefault && (
          <button
            className="btn btn-sm"
            disabled={busy || !q.data.modified}
            onClick={() => setConfirmReset(true)}
          >
            Reset to default
          </button>
        )}
        <button className="btn btn-sm" disabled={!dirty || busy} onClick={() => setText(null)}>
          Discard
        </button>
        <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={() => void saveFile()}>
          Save file
        </button>
      </div>
      {Boolean(err) && <ErrorBox error={err} />}
      <textarea
        aria-label={`Contents of ${path}`}
        className="field mono min-h-[560px] text-[12px] leading-relaxed"
        spellCheck={false}
        value={value}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            tabEscape.current = true;
            return;
          }
          const escaped = tabEscape.current;
          tabEscape.current = false;
          if (e.key === "Tab" && !escaped && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: en } = el;
            const next = `${value.slice(0, s)}  ${value.slice(en)}`;
            setText(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (dirty) void saveFile();
          }
        }}
      />
      <div className="hint">Tab inserts two spaces; Esc then Tab moves focus out. Ctrl+S saves.</div>
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={`Reset ${path}?`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void resetFile()}>
              Reset to default
            </button>
          </>
        }
      >
        Your edits to this file are replaced with the version that ships with Botss. The change is committed,
        so it can be recovered from git history.
      </Modal>
    </div>
  );
}
