import { useSyncExternalStore } from "react";

// A tiny hash router: #/ (projects), #/p/<pid>/<screen>/<rest...>. Query params after "?" in the hash are allowed.

export interface Route {
  pid: string | null;
  screen: string;
  rest: string[];
  params: URLSearchParams;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function snapshot(): string {
  return window.location.hash;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", query = ""] = raw.split("?");
  const parts = pathPart
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const params = new URLSearchParams(query);
  if (parts[0] === "p" && parts[1])
    return { pid: parts[1], screen: parts[2] ?? "", rest: parts.slice(3), params };
  if (parts[0] === "open") return { pid: null, screen: "open", rest: [], params };
  return { pid: null, screen: "projects", rest: [], params };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseHash(hash);
}

export function href(pid: string, screen: string, ...rest: string[]): string {
  return `#/p/${encodeURIComponent(pid)}/${screen}${rest.length ? `/${rest.map((r) => r.split("/").map(encodeURIComponent).join("/")).join("/")}` : ""}`;
}

export function navigate(to: string, replace = false): void {
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = to;
    window.history.replaceState(window.history.state, "", url.toString());
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = to;
}
