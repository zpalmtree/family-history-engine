#!/usr/bin/env node

// Session-start provider sign-in sweep.
//
//   npm run providers:signin                       # FamilySearch, Findmypast, Ancestry, plus
//                                                  # MDLandRec or TNA while one holds a sign-in gate
//   npm run providers:signin -- --providers findmypast
//   npm run providers:signin -- --probe            # report login state; submit nothing
//   npm run providers:signin -- --no-refresh       # do not reopen gates afterwards
//
// For each provider, Chrome's saved credentials are submitted only when the
// browser has visibly autofilled both fields (tools/saved-signin.mjs). Every
// provider confirmed signed in then has its sign-in gates reopened through
// research:gates:refresh, so queued acquisition routes retry automatically.
// A provider that needs a human step is left open on that step and reported
// once as NEEDS USER sign-in-<provider>.

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { signInGatedProviders } from "./access-gates.mjs";
import { refreshAccessGates } from "./refresh-access-gates.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { coreSavedSignInProviderIds, savedSignInProviderIds } from "./saved-signin.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSignInResults(stdout) {
  return String(stdout).split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry?.type === "signin-result");
}

// The core providers, plus any other supported provider with an open sign-in gate.
export function defaultSweepProviders(acquisitionTargets) {
  const gated = signInGatedProviders(acquisitionTargets);
  return savedSignInProviderIds.filter((providerId) =>
    coreSavedSignInProviderIds.includes(providerId) || gated.has(providerId));
}

export function signedInProviders(results) {
  return results.filter((entry) => ["signed-in", "already-signed-in"].includes(entry.status)).map((entry) => entry.provider);
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--providers");
  const providers = (index >= 0
    ? args[index + 1]
    : defaultSweepProviders(loadResearchStore().acquisitionTargets).join(",")) || "";
  const probe = args.includes("--probe");
  const powershellArgs = ["-WindowStyle", "Hidden", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "tools/provider-signin-windows.ps1", "-Providers", providers, ...(probe ? ["-Probe"] : [])];
  const run = spawnSync("powershell.exe", powershellArgs, { cwd: projectRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.stderr) process.stderr.write(run.stderr);
  const results = parseSignInResults(run.stdout);
  if (!results.length) throw new Error(`The sign-in sweep returned no result (exit ${run.status}).`);

  if (args.includes("--json")) console.log(JSON.stringify({ results }, null, 2));
  for (const entry of results) {
    const detail = entry.reason ? ` (${entry.reason})` : "";
    if (entry.status === "needs-user") {
      console.log(`NEEDS USER sign-in-${entry.provider} — finish the ${entry.provider} sign-in step left open in the shared Chrome window${detail}, then reply READY sign-in-${entry.provider}.`);
    } else {
      console.log(`${entry.provider}: ${entry.status}${detail}`);
    }
  }

  const signedIn = signedInProviders(results);
  if (!probe && !args.includes("--no-refresh") && signedIn.length) {
    const refreshed = refreshAccessGates({ store: loadResearchStore(), signedIn, write: true });
    console.log(`Reopened ${refreshed.reopened.length} access-gated route(s) for ${signedIn.join(", ")}.`);
    for (const item of refreshed.reopened) console.log(`  ${item.targetId} [${item.provider}] -> ${item.restoredStatus}`);
    if (refreshed.reopened.length) console.log("Run npm run build so the acquisition queue picks the reopened routes up.");
  }
  process.exitCode = results.some((entry) => entry.status === "error") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
