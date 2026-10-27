export interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value. Everything else after `--name` consumes the next word. */
const BOOLEAN_FLAGS = new Set(["json", "ready", "all", "help", "no-open", "follow", "f", "login", "yes", "force", "uninstall"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && !/^-\d/.test(a))) {
      const raw = a.replace(/^--?/, "");
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(raw) && next !== undefined && !next.startsWith("--")) {
        flags[raw] = next;
        i++;
      } else {
        flags[raw] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

export function flag(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}
