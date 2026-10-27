/** Display IDs: M-0042, Q-0007, D-012, B-0003. */
export function formatId(prefix: string, n: number, width = 4): string {
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

/** Branch-safe slug from a task title. */
export function slugify(title: string, max = 32): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "") || "task";
}

export function taskBranch(id: string, title: string): string {
  return `botss/${id}-${slugify(title)}`;
}
