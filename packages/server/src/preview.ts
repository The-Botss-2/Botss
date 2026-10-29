import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { killTree } from "./runner.ts";
import { findShell } from "./shell.ts";

// The running app the owner sees on the Preview screen. Botss starts it when a build finishes (and on demand):
// the command comes from the owner's setting, the tech lead's notes (a "## Preview" section), or the project's
// own files; plain HTML projects get a small static server. The URL is read from the app's output.

export interface PreviewPlan {
  command: string | null;
  url: string | null;
  /** Where the plan came from, shown to the owner. */
  source: string;
  /** Serve the folder as static files instead of running a command. */
  staticDir?: string;
}

export interface PreviewStatus {
  running: boolean;
  url: string | null;
  command: string | null;
  source: string | null;
  log: string;
  startedAt: string | null;
  error: string | null;
}

const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s"'<>)\]]*)/i;

/** "## Preview" (or "## Run") section with `command:` and `url:` lines, from the tech lead's notes. */
export function previewFromNotes(text: string): { command: string | null; url: string | null } | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,}\s*(preview|run|running it|how to run)\b/i.test(l.trim()));
  if (at < 0) return null;
  let command: string | null = null;
  let url: string | null = null;
  for (const raw of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(raw)) break;
    const line = raw.trim().replace(/^[-*]\s+/, "");
    const c = /^command\s*:\s*`?([^`]+)`?\s*$/i.exec(line);
    const u = /^url\s*:\s*`?([^`\s]+)`?/i.exec(line);
    if (c) command = c[1]!.trim();
    if (u) url = u[1]!.trim();
  }
  return command || url ? { command, url } : null;
}

/** Guess how to run the project from its files. */
export function guessPreview(root: string, port: number): PreviewPlan | null {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
      const install = has("node_modules") ? "" : `${pm} install && `;
      const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : pkg.scripts?.preview ? "preview" : null;
      if (script) return { command: `${install}${pm} run ${script}`, url: null, source: `package.json script "${script}"` };
    } catch {
      /* fall through */
    }
  }
  if (has("frontend/package.json")) {
    const sub = guessPreview(path.join(root, "frontend"), port);
    if (sub?.command) return { ...sub, command: `cd frontend && ${sub.command}`, source: `frontend/${sub.source}` };
  }
  if (has("manage.py")) return { command: `python manage.py runserver 127.0.0.1:${port}`, url: `http://127.0.0.1:${port}`, source: "Django manage.py" };
  if (has("docker-compose.yml") || has("compose.yaml") || has("docker-compose.yaml")) {
    return { command: "docker compose up --build", url: null, source: "Docker Compose" };
  }
  for (const dir of [".", "public", "dist", "build"]) {
    if (has(path.join(dir, "index.html"))) return { command: null, url: `http://127.0.0.1:${port}`, source: `static files in ${dir === "." ? "the project folder" : dir}`, staticDir: path.join(root, dir) };
  }
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

export class PreviewManager {
  private child: ChildProcess | null = null;
  private server: http.Server | null = null;
  private log = "";
  private status: Omit<PreviewStatus, "running" | "log"> = { url: null, command: null, source: null, startedAt: null, error: null };
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  get running(): boolean {
    return Boolean(this.child || this.server);
  }

  get(): PreviewStatus {
    return { running: this.running, log: this.log.slice(-8000), ...this.status };
  }

  private append(s: string): void {
    this.log = (this.log + s).slice(-20_000);
    if (!this.status.url) {
      const m = URL_RE.exec(s);
      if (m) {
        this.status.url = m[1]!.replace("0.0.0.0", "127.0.0.1").replace(/[.,;]+$/, "");
        this.onChange();
      }
    }
  }

  async start(root: string, plan: PreviewPlan, env: Record<string, string>, port: number): Promise<PreviewStatus> {
    await this.stop();
    this.log = "";
    this.status = { url: plan.url, command: plan.command, source: plan.source, startedAt: new Date().toISOString(), error: null };
    if (plan.staticDir) {
      this.server = staticServer(plan.staticDir);
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(port, "127.0.0.1", () => resolve());
      }).catch((e: Error) => {
        this.server = null;
        this.status.error = e.message;
      });
      this.append(this.server ? `Serving ${plan.staticDir} at http://127.0.0.1:${port}\n` : `Could not serve: ${this.status.error}\n`);
      this.onChange();
      return this.get();
    }
    if (!plan.command) {
      this.status.error = "No way to run this project was found. Set a preview command in Settings.";
      this.onChange();
      return this.get();
    }
    const child = spawn(findShell(), ["-c", plan.command], {
      cwd: root,
      env: { ...process.env, ...env, PORT: String(port), BROWSER: "none", HOST: "127.0.0.1", FORCE_COLOR: "0" },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.append(d.toString()));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.append(`\n[preview stopped${code !== null ? ` (exit ${code})` : ""}]\n`);
      if (code && code !== 0) this.status.error = `The app exited with code ${code}. See the log.`;
      this.onChange();
    });
    child.on("error", (e) => {
      this.status.error = e.message;
      this.onChange();
    });
    this.onChange();
    // Give the app a moment to print its URL.
    for (let i = 0; i < 40 && this.child && !this.status.url; i++) await new Promise((r) => setTimeout(r, 250));
    return this.get();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child?.pid) await killTree(child.pid);
    if (this.server) {
      const server = this.server;
      this.server = null;
      // A browser (the dashboard's preview frame) can hold keep-alive connections open; close them so stopping
      // never waits on a page someone left open.
      server.closeAllConnections();
      await Promise.race([new Promise<void>((r) => server.close(() => r())), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.onChange();
  }
}

/** Minimal static file server for plain HTML projects (127.0.0.1 only, no directory listings). */
function staticServer(dir: string): http.Server {
  const base = path.resolve(dir);
  return http.createServer((req, res) => {
    const url = decodeURIComponent(String(req.url ?? "/").split("?")[0]!);
    let file = path.resolve(base, `.${url}`);
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) file = path.join(base, "index.html"); // single-page apps
    if (!fs.existsSync(file)) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}
