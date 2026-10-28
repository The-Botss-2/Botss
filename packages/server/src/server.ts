import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { registerApi } from "./api.ts";
import { EventBus, topicsFor, type BotssEvent } from "./bus.ts";
import { initProject } from "./init.ts";
import { buildId, DASHBOARD_DIST } from "./paths.ts";
import { Project, projectId } from "./project.ts";
import { clearServerInfo, readRegistry, writeServerInfo } from "./registry.ts";
import type { AgentRunner } from "./runner.ts";
import { safeEqual, TokenStore } from "./tokens.ts";

export interface ServerOptions {
  port?: number;
  /** Always 127.0.0.1. Exposed for tests only; anything else is refused. */
  host?: "127.0.0.1";
  token?: string;
  launchDir?: string;
  runnerFactory?: () => AgentRunner;
  /** Open every registered project at startup. */
  openRegistered?: boolean;
  writeInfo?: boolean;
  /** Start orchestrator loops (tests may drive ticks by hand). */
  autoStart?: boolean;
}

export class BotssServer {
  readonly bus = new EventBus();
  readonly tokens: TokenStore;
  readonly projects = new Map<string, Project>();
  app!: FastifyInstance;
  port = 0;
  /** The folder `botss up` was started from (or last opened from the CLI); the dashboard offers to open it. */
  launchDir: string | null = null;
  /** The code version this server runs (see buildId). */
  readonly build = buildId();
  /** Called after a shutdown request has stopped the server (the CLI exits the process). */
  onShutdown: (() => void) | null = null;

  private readonly opts: ServerOptions;
  constructor(opts: ServerOptions = {}) {
    this.opts = opts;
    this.launchDir = opts.launchDir ?? null;
    this.tokens = new TokenStore(opts.token);
  }

  async requestShutdown(): Promise<void> {
    await this.stop();
    this.onShutdown?.();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async openProject(root: string, o: { init?: boolean } = {}): Promise<Project> {
    const id = projectId(root);
    const existing = this.projects.get(id);
    if (existing) return existing;
    if (o.init || !fs.existsSync(path.join(root, ".botss"))) {
      if (!o.init) throw new Error(`${root} is not a Botss project. Run \`botss init\` there, or create it from the dashboard with "initialize".`);
      await initProject(root);
    }
    const p = await Project.open(root, { bus: this.bus, tokens: this.tokens, serverUrl: () => this.url, runner: this.opts.runnerFactory?.() });
    this.projects.set(p.id, p);
    if (this.opts.autoStart !== false) p.start();
    return p;
  }

  async start(): Promise<void> {
    const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
    this.app = app;
    await app.register(fastifyWebsocket);
    registerApi(app, this);

    // Live events: batched every 100 ms per socket, so 10 streaming agents stay cheap for the browser.
    app.get("/api/ws", { websocket: true }, (socket, req) => {
      const q = req.query as { project?: string };
      let queue: BotssEvent[] = [];
      const onEvent = (pid: string, ev: BotssEvent) => {
        if (!q.project || pid === q.project) queue.push(ev);
      };
      this.bus.on("event", onEvent);
      const timer = setInterval(() => {
        if (!queue.length) return;
        const events = queue;
        queue = [];
        const topics = [...new Set(events.flatMap((e) => topicsFor(e.type)))];
        socket.send(JSON.stringify({ type: "events", events, topics }));
      }, 100);
      socket.send(JSON.stringify({ type: "hello" }));
      socket.on("close", () => {
        clearInterval(timer);
        this.bus.off("event", onEvent);
      });
    });

    // Dashboard: static assets, gated by a cookie set when the tokened URL is opened.
    if (fs.existsSync(DASHBOARD_DIST)) {
      await app.register(fastifyStatic, { root: DASHBOARD_DIST, index: false, wildcard: false, serve: false });
      app.get("/*", (req, reply) => {
        const q = req.query as { token?: string };
        const cookie = /(?:^|;\s*)botss_token=([^;]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
        const okQuery = q.token && safeEqual(q.token, this.tokens.master);
        const okCookie = cookie && safeEqual(decodeURIComponent(cookie), this.tokens.master);
        if (!okQuery && !okCookie) {
          return reply
            .code(401)
            .type("text/html")
            .send("<!doctype html><title>Botss</title><body style='font-family:system-ui;padding:3rem'><h1>Botss</h1><p>Open the link printed by <code>botss up</code> (it contains the access token).</p></body>");
        }
        if (okQuery) reply.header("set-cookie", `botss_token=${encodeURIComponent(this.tokens.master)}; HttpOnly; SameSite=Strict; Path=/`);
        const rel = (req.params as { "*": string })["*"];
        const file = rel && fs.existsSync(path.join(DASHBOARD_DIST, rel)) && !rel.includes("..") ? rel : "index.html";
        if (file === "index.html") reply.header("cache-control", "no-store");
        reply.header("x-frame-options", "SAMEORIGIN");
        reply.header("referrer-policy", "no-referrer");
        return reply.sendFile(file);
      });
    } else {
      app.get("/", (_req, reply) => reply.type("text/plain").send("Botss server is running, but the dashboard is not built. Run `pnpm build`."));
    }

    if (this.opts.host && this.opts.host !== "127.0.0.1") throw new Error("Botss only binds to 127.0.0.1");
    await app.listen({ port: this.opts.port ?? 0, host: "127.0.0.1" });
    const addr = app.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : (this.opts.port ?? 0);
    if (this.opts.writeInfo !== false) writeServerInfo({ url: this.url, port: this.port, pid: process.pid, token: this.tokens.master, started_at: new Date().toISOString() });
    if (this.opts.openRegistered) {
      for (const e of readRegistry()) {
        if (!fs.existsSync(path.join(e.root, ".botss"))) continue;
        try {
          await this.openProject(e.root);
        } catch (err) {
          console.error(`[botss] could not open ${e.root}: ${(err as Error).message}`);
        }
      }
    }
  }

  async stop(): Promise<void> {
    for (const p of this.projects.values()) await p.close();
    this.projects.clear();
    await this.app?.close();
    if (this.opts.writeInfo !== false) clearServerInfo(process.pid);
  }
}
