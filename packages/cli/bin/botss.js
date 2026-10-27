#!/usr/bin/env node
// Launcher for `npm link` / global installs: runs the TypeScript CLI with Node's type stripping and without
// the node:sqlite experimental warning.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
