import net from "node:net";

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Each agent gets a block of 10 ports: DB +0, BACKEND +1, FRONTEND +2 (rest reserved). */
export async function allocatePortBlock(base: number, taken: number[]): Promise<number> {
  for (let k = 0; k < 400; k++) {
    const block = base + k * 10;
    if (taken.includes(block)) continue;
    const ok = (await portFree(block)) && (await portFree(block + 1)) && (await portFree(block + 2));
    if (ok) return block;
  }
  throw new Error(`no free port block found from ${base}`);
}

export function agentRuntimeEnv(agent: string, block: number, opts: { test?: boolean } = {}): Record<string, string> {
  const db = block;
  const be = block + 1;
  const fe = block + 2;
  return {
    COMPOSE_PROJECT_NAME: `botss-${agent}`,
    DB_PORT: String(db),
    BACKEND_PORT: String(be),
    FRONTEND_PORT: String(fe),
    DATABASE_URL: `postgresql+asyncpg://app:app@localhost:${db}/app`,
    TEST_DATABASE_URL: `postgresql+asyncpg://app:app@localhost:${db}/app_test`,
    API_INTERNAL_URL: `http://localhost:${be}`,
    E2E_BASE_URL: `http://localhost:${fe}`,
    ENVIRONMENT: opts.test ? "test" : "local",
  };
}
