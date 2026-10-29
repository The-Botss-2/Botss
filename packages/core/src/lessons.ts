import { globsOverlap } from "./globs.ts";

// Learning memory: short lessons the team (or the owner) records so the same mistake is not repeated.
// Each run gets only the lessons that match its role and its task's files, so the memory stays cheap.

export interface Lesson {
  id: number;
  text: string;
  /** Roles it applies to; empty = everyone. */
  roles: string[];
  /** File globs it applies to; empty = the whole project. */
  paths: string[];
  source: string | null;
  by_agent: string | null;
  pinned: boolean;
  created_at: string;
}

export const MAX_LESSON_CHARS = 300;
export const LESSONS_PER_RUN = 20;

/** Lessons for one run: role and file match, pinned first, then newest, capped. */
export function lessonsFor(all: Lesson[], role: string, taskPaths: string[]): Lesson[] {
  return all
    .filter((l) => l.roles.length === 0 || l.roles.includes(role))
    .filter((l) => l.paths.length === 0 || taskPaths.length === 0 || l.paths.some((g) => taskPaths.some((t) => globsOverlap(g, t).overlap)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id)
    .slice(0, LESSONS_PER_RUN);
}

/** Markdown copy of the memory for people (and agents that want the whole list). */
export function lessonsMarkdown(all: Lesson[]): string {
  const lines = all
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id)
    .map((l) => {
      const scope = [l.roles.length ? `roles: ${l.roles.join(", ")}` : "", l.paths.length ? `files: ${l.paths.join(", ")}` : ""].filter(Boolean).join(" · ");
      return `- ${l.pinned ? "📌 " : ""}${l.text}${scope ? ` _(${scope})_` : ""}${l.source ? ` — from ${l.source}` : ""}`;
    });
  return `# Project memory\n\nLessons the team learned on this project. Edit them in the dashboard (Memory).\n\n${lines.join("\n") || "_No lessons yet._"}\n`;
}
