#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquisitionTargetIdsForScope,
  acquisitionTargetsForScope,
  buildAcquisitionSession,
  sessionPath,
  writeAcquisitionSession
} from "./acquisition-session-lib.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { researchPaths } from "./research-store.mjs";
import { parseResearchScope } from "./research-scope.mjs";
import { vercelScopeArgs } from "./tree-config.mjs";

const researchScope = parseResearchScope(process.argv.slice(2));

const mode = process.argv.includes("--resume") ? "resume"
  : process.argv.includes("--prepare") ? "prepare"
    : "audit";
const mutating = mode !== "audit";
const skipRemoteAudit = process.argv.includes("--skip-remote-audit");
const discoverFamilySearch = process.argv.includes("--discover-familysearch");
const maxSearches = integerAfter("--max-searches", 25);
const startedAt = new Date().toISOString();
const startedAtMs = Date.now();
const phases = [];
let failed = false;
const runId = `run-${startedAt.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/g, "")}`;
const runFile = mutating ? path.join(researchPaths.acquisitionRuns, `${runId}.json`) : null;
const sessionRun = mutating ? {
  schemaVersion: 2,
  id: runId,
  startedAt,
  mode,
  researchScope,
  status: "running",
  phases
} : null;

if (mutating) {
  markInterruptedRuns(runId);
  checkpointRun();
}

if (mutating) {
  run("source-atoms-migrate", "npm", ["run", "records:atoms:migrate"]);
  skip("seed-provider-routes", "records:atoms:migrate already runs the identical canonical sync and research build");
  run("seed-ledger", "node", ["tools/seed-acquisition-session.mjs"]);
} else {
  run("source-atoms-sync-check", "npm", ["run", "research:sync:inputs:check"]);
  run("research-projection-check", "npm", ["run", "research:build:check"]);
  skip("seed-ledger", "audit mode is read-only; use records:session:prepare to synchronize canonical inputs and the generated ledger");
}
run("efs-archive-preflight", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/check-efs-archive-windows.ps1"]);
run("vercel-identity", "npx", ["--yes", "vercel@55.0.0", "whoami"]);
run("vercel-blob-binding", "npx", ["--yes", "vercel@55.0.0", "env", "ls", "production", ...vercelScopeArgs()]);

if (mode === "resume") {
  importEveryProvider("initial");
  recoverPublicBatch();
  recoverFamilySearchBatch();
  recoverSubscriptionBatch();
  if (discoverFamilySearch) runFamilySearchDiscovery(maxSearches);
  else skip("familysearch-batch-discovery", "pass --discover-familysearch to run every queued saved-profile search");
  importEveryProvider("post-acquisition");

  const publicationReady = [
    run("prepublish-archive-check", "node", ["tools/reconcile-record-archive.mjs", "--check"]),
    run("prepublish-manifest-check", "node", ["tools/check-records-manifest.mjs"]),
    run("prepublish-source-atoms-check", "npm", ["run", "records:atoms:check"]),
    run("prepublish-record-people-check", "npm", ["run", "records:check:people"])
  ].every(Boolean);
  const { verified, unverified } = pendingUploadCounts();
  for (const [kind, count] of Object.entries(unverified)) {
    if (count) skip(`publish-${kind}-unverified`, `${count} source master(s) require exact visual person reconciliation before publication`);
  }
  for (const [kind, count] of Object.entries(verified)) {
    if (!publicationReady) {
      skip(`publish-${kind}-dependency-failed`, "archive, manifest, source-atom, or person-link verification failed; publication is dependency-gated");
      continue;
    }
    if (!count) {
      skip(`publish-${kind}`, "no visually verified approved source masters pending upload");
      continue;
    }
    run(`publish-${kind}`, "npx", [
      "--yes", "vercel@55.0.0", "env", "run", "-e", "production", ...vercelScopeArgs(), "--",
      "npx", "--yes", "node@24", `tools/publish-${kind}-records.mjs`
    ]);
    run(`reimport-${kind}-after-publish`, "node", [`tools/import-${kind}-records.mjs`]);
  }
  run("publish-viewer-derivatives", "npx", [
    "--yes", "vercel@55.0.0", "env", "run", "-e", "production", ...vercelScopeArgs(), "--",
    "npx", "--yes", "node@24", "tools/publish-viewer-derivatives.mjs"
  ]);
}

run("reconcile-archive-check", "node", ["tools/reconcile-record-archive.mjs", "--check"]);
run("records-manifest-check", "node", ["tools/check-records-manifest.mjs"]);
run("viewer-blob-inventory-check", "node", ["tools/check-viewer-blob-inventory.mjs"]);
run("source-atoms-check", "npm", ["run", "records:atoms:check"]);
run("subscription-queue-check", "npm", ["run", "records:check:subscriptions"]);
run("record-people-check", "npm", ["run", "records:check:people"]);
if (mutating) run("refresh-ledger", "node", ["tools/seed-acquisition-session.mjs"]);
else skip("refresh-ledger", "audit mode does not rewrite the generated ledger");
run("acquisition-ledger-check", "node", ["tools/check-acquisition-session.mjs"]);
if (!skipRemoteAudit) {
  run("private-blob-audit", "npx", [
    "--yes", "vercel@55.0.0", "env", "run", "-e", "production", ...vercelScopeArgs(), "--",
    "npx", "--yes", "node@24", "tools/audit-record-blobs.mjs"
  ]);
}

let session;
if (mutating) {
  const phase = beginPhase("finalize-generated-ledger");
  try {
    session = buildAcquisitionSession();
    writeAcquisitionSession(session);
    finishPhase(phase, { status: "completed", durationMs: 0 });
  } catch (error) {
    failed = true;
    finishPhase(phase, { status: "failed", durationMs: 0, error: safeError(error) });
    throw error;
  }
} else {
  session = buildAcquisitionSession();
}
if (sessionRun) {
  sessionRun.finishedAt = new Date().toISOString();
  sessionRun.status = failed ? "completed-with-errors" : "completed";
  checkpointRun();
}

const scopedTargets = acquisitionTargetsForScope(session, researchScope);
const remaining = scopedTargets.filter((target) => ![...new Set([
  "published", "preserved-withheld", "satisfied-by-equivalent-route", "citation-only", "search-audit-only", "access-entitlement", "user-declined",
  "not-found-bounded", "disproved"
])].includes(target.status));
console.log(`Acquisition ${mode} (${researchScope}) ${failed ? "completed with errors" : "completed"}: ${scopedTargets.length} source atoms; ${remaining.length} remain gated or actionable.`);
for (const [status, count] of Object.entries(countByStatus(scopedTargets))) console.log(`  ${status}: ${count}`);
printTimingSummary(Date.now() - startedAtMs);
if (failed) process.exitCode = 1;

function importEveryProvider(label) {
  run(`${label}-reconcile-archive`, "node", ["tools/reconcile-record-archive.mjs"]);
  run(`${label}-import-public`, "node", ["tools/import-public-records.mjs"]);
  run(`${label}-import-familysearch`, "node", ["tools/import-familysearch-records.mjs"]);
  run(`${label}-import-subscription`, "node", ["tools/import-subscription-records.mjs"]);
  run(`${label}-atoms`, "npm", ["run", "records:atoms:migrate"]);
  skip(`${label}-routes`, `${label}-atoms already runs the identical canonical sync and research build`);
  run(`${label}-ledger`, "node", ["tools/seed-acquisition-session.mjs"]);
}

function recoverPublicBatch() {
  const queue = readJson("evidence/record-recovery-queue.json");
  const allowedIds = currentScopeTargetIds();
  const targets = (queue.targets || []).filter((target) => target.status === "ready"
    && (allowedIds.has(target.id) || allowedIds.has(target.atomId)));
  if (!targets.length) {
    skip("recover-ready-public-records", "no ready public URL targets");
    return;
  }
  for (const target of targets) {
    run(`recover-ready-public-record:${target.id}`, "powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/recover-public-records-windows.ps1", "-TargetId", target.id
    ]);
  }
  run("reimport-public-records", "node", ["tools/import-public-records.mjs"]);
}

function recoverFamilySearchBatch() {
  const queue = readJson("evidence/familysearch-recovery-queue.json");
  const allowedIds = currentScopeTargetIds();
  const targets = (queue.targets || []).filter((target) => target.status === "ready"
    && (allowedIds.has(target.id) || allowedIds.has(target.atomId))).slice(0, 25);
  if (!targets.length) {
    skip("recover-ready-familysearch-records", "no exact ready FamilySearch routes");
    return;
  }
  run("shared-browser-status-before-familysearch", "npm", ["run", "subscription:cdp:status"]);
  run("shared-browser-tabs-before-familysearch", "npm", ["run", "subscription:win:tabs:audit"]);
  for (const target of targets) {
    run(`recover-ready-familysearch-record:${target.id}`, "powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/recover-familysearch-records-windows.ps1",
      "-TargetId", target.id, "-Scope", researchScope
    ]);
  }
  run("shared-browser-tabs-after-familysearch", "npm", ["run", "subscription:win:tabs:audit"]);
  run("reimport-familysearch-records", "node", ["tools/import-familysearch-records.mjs"]);
}

function recoverSubscriptionBatch() {
  run("shared-browser-status-before-subscriptions", "npm", ["run", "subscription:cdp:status"]);
  run("shared-browser-tabs-before-subscriptions", "npm", ["run", "subscription:win:tabs:audit"]);
  const queue = readJson("evidence/subscription-records-queue.json");
  const allowedIds = currentScopeTargetIds();
  const targets = (queue.targets || []).filter((target) => target.status === "pending-subscription"
    && target.provider === "Ancestry"
    && (allowedIds.has(target.id) || allowedIds.has(target.atomId))
    && /^https:\/\/www\.ancestry\.(?:com|co\.uk)\/search\/collections\/\d+\/records\/\d+/.test(target.catalogueUrl || ""));
  if (!targets.length) {
    skip("recover-exact-subscription-records", "no exact pending Ancestry routes");
  }
  for (const target of targets) {
    const archiveFile = target.archiveFile || `${target.id}.jpg`;
    const ok = run(`subscription-acquire:${target.id}`, "npm", [
      "run", "subscription:win:acquire", "--", "-TargetId", target.id, "-ArchiveFile", archiveFile
    ]);
    if (!ok) {
      run(`subscription-attempt:${target.id}`, "node", [
        "tools/record-acquisition-attempt.mjs", "--atom", target.atomId || target.id, "--route", target.id,
        "--scope", researchScope,
        "--outcome", "retryable-error", "--note", "Exact provider acquisition failed; inspect redirects, overlays, or provider errors before retrying."
      ]);
    }
  }
  run("shared-browser-tabs-after-subscriptions", "npm", ["run", "subscription:win:tabs:audit"]);
  run("reimport-subscription-records", "node", ["tools/import-subscription-records.mjs"]);
}

function runFamilySearchDiscovery(limit) {
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  const work = acquisitionTargetsForScope(session, researchScope).flatMap((atom) => (atom.routes || [])
    .filter((route) => route.provider?.startsWith("FamilySearch")
      && route.status === "queued-free-search" && route.searchQuery)
    .map((route) => ({ atom, route }))).slice(0, limit);
  if (!work.length) {
    skip("familysearch-batch-discovery", "no queued FamilySearch discovery routes");
    return;
  }
  for (const { atom, route } of work) {
    const name = `familysearch-discovery:${route.id}`;
    const phase = beginPhase(name);
    const phaseStartedAtMs = Date.now();
    const commandStartedAtMs = Date.now();
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/familysearch-windows.ps1",
      "-Mode", "global-query", "-Query", route.searchQuery, "-AffinitySlot", affinityFor(route.id)
    ], commandOptions());
    const commandDurationMs = Date.now() - commandStartedAtMs;
    emit(result);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const signIn = /identity\/login|requires.*sign-in/i.test(output);
    const candidates = [...new Set(output.match(/https:\/\/www\.familysearch\.org\/ark:\/61903\/[13]:1:[^\s|]+/g) || [])]
      .map((value) => value.replace(/[),.;]+$/, "")).slice(0, 12);
    const outcome = signIn
      ? "needs-interactive-sign-in"
      : result.status === 0
        ? candidates.length ? "needs-result-review" : "search-no-candidates"
        : "retryable-error";
    const attemptArgs = [
      "tools/record-acquisition-attempt.mjs", "--atom", atom.atomId, "--route", route.id, "--outcome", outcome,
      "--scope", researchScope,
      "--note", signIn
        ? "Shared FamilySearch profile requires one manual sign-in; later discovery routes were not attempted."
        : result.status === 0
          ? candidates.length
            ? `Batch search completed; ${candidates.length} candidate record URL(s) require relevance and original-image review.`
            : "Batch search completed with zero candidate record URLs; record this bounded query without creating a phantom review task."
          : "Batch search failed and is safe to retry after provider-state review."
    ];
    for (const candidate of candidates) attemptArgs.push("--candidate-url", candidate);
    const recordStartedAtMs = Date.now();
    const recorded = spawnSync("node", attemptArgs, commandOptions());
    const recordDurationMs = Date.now() - recordStartedAtMs;
    emit(recorded);
    const status = result.status === 0 && recorded.status === 0 ? "completed" : "failed";
    finishPhase(phase, {
      status,
      exitCode: result.status ?? 1,
      candidateCount: candidates.length,
      durationMs: Date.now() - phaseStartedAtMs,
      commandDurationMs,
      recordDurationMs
    });
    if (status === "failed") failed = true;
    if (signIn) break;
  }
}

function run(name, command, args) {
  console.log(`\n[${name}] ${command} ${redactedArgs(args).join(" ")}`);
  const phase = beginPhase(name);
  const phaseStartedAtMs = Date.now();
  const result = spawnSync(command, args, commandOptions());
  emit(result);
  const status = result.status === 0 ? "completed" : "failed";
  const durationMs = Date.now() - phaseStartedAtMs;
  finishPhase(phase, {
    status,
    exitCode: result.status ?? 1,
    durationMs
  });
  console.log(`[timing] ${name}: ${formatDuration(durationMs)}`);
  if (status === "failed") failed = true;
  return status === "completed";
}

function commandOptions() {
  return {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  };
}

function emit(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function skip(name, reason) {
  console.log(`\n[${name}] skipped: ${reason}`);
  phases.push({ name, status: "skipped", reason, durationMs: 0 });
  checkpointRun();
}

function beginPhase(name) {
  const phase = { name, status: "running", startedAt: new Date().toISOString() };
  phases.push(phase);
  checkpointRun();
  return phase;
}

function finishPhase(phase, result) {
  Object.assign(phase, result, { finishedAt: new Date().toISOString() });
  checkpointRun();
}

function checkpointRun() {
  if (runFile) writeJsonAtomic(runFile, sessionRun);
}

function markInterruptedRuns(interruptedByRunId) {
  if (!fs.existsSync(researchPaths.acquisitionRuns)) return;
  for (const name of fs.readdirSync(researchPaths.acquisitionRuns)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(researchPaths.acquisitionRuns, name);
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    if (previous.status !== "running") continue;
    previous.status = "interrupted";
    previous.finishedAt = startedAt;
    previous.interruptedByRunId = interruptedByRunId;
    writeJsonAtomic(file, previous);
  }
}

function safeError(error) {
  return String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function printTimingSummary(totalDurationMs) {
  const measuredDurationMs = phases.reduce((total, phase) => total + (phase.durationMs || 0), 0);
  console.log(`Timing: total=${formatDuration(totalDurationMs)} measured-phases=${formatDuration(measuredDurationMs)} phase-overhead=${formatDuration(Math.max(0, totalDurationMs - measuredDurationMs))}.`);
  const slowest = phases
    .filter((phase) => phase.durationMs > 0)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5);
  if (slowest.length) console.log(`Slowest phases: ${slowest.map((phase) => `${phase.name}=${formatDuration(phase.durationMs)}`).join(", ")}.`);
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function pendingUploadCounts() {
  const specs = {
    public: "evidence/record-recovery-queue.json",
    familysearch: "evidence/familysearch-recovery-queue.json",
    subscription: "evidence/subscription-records-queue.json"
  };
  const verified = {};
  const unverified = {};
  const atoms = readJson("evidence/source-atoms.json");
  const atomsById = new Map(atoms.atoms.map((atom) => [atom.id, atom]));
  for (const [kind, file] of Object.entries(specs)) {
    const queue = readJson(file);
    const pending = (queue.targets || []).filter((target) => target.status === "acquired"
      && target.viewer && target.viewerPublishState === "pending-upload");
    verified[kind] = pending.filter((target) => {
      const atom = atomsById.get(target.atomId || target.id);
      return target.peopleVerifiedAt && target.peopleVerificationBasis
        && Array.isArray(atom?.personLinks) && atom.personLinksVerifiedAt && atom.personLinksVerificationBasis;
    }).length;
    unverified[kind] = pending.length - verified[kind];
  }
  return { verified, unverified };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

function affinityFor(value) {
  const safe = value.toLocaleLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 19) || "route";
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `fs-${safe}-${hash.toString(16).padStart(8, "0")}`.slice(0, 32).replace(/-+$/g, "");
}

function redactedArgs(args) {
  return args.map((arg) => /token|password|secret/i.test(arg) ? "[sensitive-name]" : arg);
}

function integerAfter(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`${flag} must be an integer from 1 to 100`);
  return value;
}

function currentScopeTargetIds() {
  return acquisitionTargetIdsForScope(buildAcquisitionSession(), researchScope);
}

function countByStatus(targets) {
  return Object.fromEntries([...targets.reduce((counts, target) => {
    counts.set(target.status, (counts.get(target.status) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}
