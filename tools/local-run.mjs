#!/usr/bin/env node
// Run a browser-driving research tool against the local Chrome (macOS, Linux).
//
//   npm run local -- <tool> [arguments...]
//   e.g. npm run local -- tools/providers-signin.mjs
//
// The cross-platform counterpart of the project's Windows PowerShell
// wrappers: it checks that the local Chrome (npm run browser:start) is up,
// holds the one browser lock so tasks never drive Chrome at the same time,
// and runs the tool with the --shared-window flag the tools expect from a
// wrapper. Every helper's own gates (consents, PAY/SUBMIT phrases, human
// steps) still apply.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { browserVersion, stateDirectory } from "./local-browser.mjs";
import { getSecret } from "./secret-store.mjs";
import { engineRoot } from "./tree-config.mjs";

export function lockFile() {
  return path.join(stateDirectory(), "browser.lock");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// One task at a time; a lock whose owner has exited is taken over.
export async function acquireBrowserLock({ file = lockFile(), waitMs = 10 * 60_000, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, String(pid), { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(file, "utf8"));
      if (!owner || !alive(owner)) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Another research task (pid ${owner}) still holds the browser after ${Math.round(waitMs / 60_000)} minutes.`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

export function resolveTool(name, root = engineRoot) {
  const candidates = [name, `tools/${name}`, `tools/${name}.mjs`].map((candidate) => path.resolve(root, candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate) && candidate.startsWith(path.join(root, "tools")) && candidate.endsWith(".mjs"));
  if (!found) throw new Error(`No research tool ${name} under tools/.`);
  return found;
}

async function main() {
  const argv = process.argv.slice(2);
  // --secret-stdin <name> pipes a secret from the OS store to the tool's
  // stdin (the Windows wrappers pipe DPAPI profiles the same way), e.g. the
  // contact-form requester profile with --contact-profile-stdin.
  const secretIndex = argv.indexOf("--secret-stdin");
  const secretName = secretIndex >= 0 ? argv[secretIndex + 1] : null;
  if (secretIndex >= 0) argv.splice(secretIndex, 2);
  const [tool, ...rest] = argv;
  if (!tool) throw new Error("usage: npm run local -- <tool> [arguments...] [--secret-stdin <name>]");
  let input;
  if (secretName) {
    input = getSecret(secretName);
    if (!input) throw new Error(`No secret named ${secretName} is stored: npm run secret -- set ${secretName}`);
  }
  const script = resolveTool(tool);
  if (!await browserVersion()) throw new Error("The local Chrome is not running: start it with npm run browser:start.");
  const release = await acquireBrowserLock();
  try {
    const args = rest.includes("--shared-window") ? rest : [...rest, "--shared-window"];
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: engineRoot,
      input,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      env: { ...process.env, FAMILY_HISTORY_BROWSER_BACKEND: "local" }
    });
    process.exitCode = result.status ?? 1;
  } finally {
    release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
