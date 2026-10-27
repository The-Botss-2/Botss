// Token bootstrap and the HTTP client. The page is opened as /?token=<master>#/p/<pid>; the token is moved
// into sessionStorage and stripped from the address bar so it does not end up in history or screenshots.

const TOKEN_KEY = "botss.token";

function readToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) {
      sessionStorage.setItem(TOKEN_KEY, fromQuery);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      return fromQuery;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = typeof window !== "undefined" ? readToken() : null;

export function getToken(): string | null {
  return token;
}

export function setToken(t: string): void {
  token = t;
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode */
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("Cannot reach the Botss server. Is `botss up` still running?", 0);
  }
  const ct = res.headers.get("content-type") ?? "";
  const payload: unknown = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  if (!res.ok) {
    const msg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return payload as T;
}

/** Project-scoped path helper. */
export function pp(pid: string, rest = ""): string {
  return `/api/projects/${encodeURIComponent(pid)}${rest}`;
}

/** Encode a document name (may contain slashes) for the /docs/* wildcard route. */
export function docPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}
