import type { Identity } from "@botss/core";
import crypto from "node:crypto";

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Scoped agent tokens: one per run, tied to project, agent, role and task. Revoked when the run ends. */
export class TokenStore {
  private agents = new Map<string, { projectId: string; identity: Identity & { kind: "agent" } }>();

  readonly master: string;
  constructor(master: string = randomToken()) {
    this.master = master;
  }

  issue(projectId: string, identity: Identity & { kind: "agent" }): string {
    const t = `bta_${randomToken()}`;
    this.agents.set(t, { projectId, identity });
    return t;
  }

  revokeRun(runId: string): void {
    for (const [t, v] of this.agents) if (v.identity.runId === runId) this.agents.delete(t);
  }

  resolve(token: string | undefined): { projectId: string | null; identity: Identity } | null {
    if (!token) return null;
    if (safeEqual(token, this.master)) return { projectId: null, identity: { kind: "human" } };
    const a = this.agents.get(token);
    return a ? { projectId: a.projectId, identity: a.identity } : null;
  }
}
