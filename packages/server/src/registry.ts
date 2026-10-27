import fs from "node:fs";
import path from "node:path";
import { botssHome } from "./paths.ts";
import { projectId } from "./project.ts";

export interface RegistryEntry {
  id: string;
  root: string;
  name: string;
  added_at: string;
}

function file(): string {
  return path.join(botssHome(), "projects.json");
}

export function readRegistry(): RegistryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as RegistryEntry[];
  } catch {
    return [];
  }
}

export function addToRegistry(root: string): RegistryEntry {
  const list = readRegistry();
  const id = projectId(root);
  const existing = list.find((e) => e.id === id);
  if (existing) return existing;
  const e = { id, root: path.resolve(root), name: path.basename(root), added_at: new Date().toISOString() };
  fs.writeFileSync(file(), JSON.stringify([...list, e], null, 2));
  return e;
}

export function removeFromRegistry(id: string): void {
  fs.writeFileSync(file(), JSON.stringify(readRegistry().filter((e) => e.id !== id), null, 2));
}

export interface ServerInfo {
  url: string;
  port: number;
  pid: number;
  token: string;
  started_at: string;
}

export function serverInfoFile(): string {
  return path.join(botssHome(), "server.json");
}

export function writeServerInfo(info: ServerInfo): void {
  fs.writeFileSync(serverInfoFile(), JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readServerInfo(): ServerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(serverInfoFile(), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}

export function clearServerInfo(pid: number): void {
  const cur = readServerInfo();
  if (cur && cur.pid === pid) fs.rmSync(serverInfoFile(), { force: true });
}
