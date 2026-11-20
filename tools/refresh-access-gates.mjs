#!/usr/bin/env node

// Reopen provider sign-in and subscription gates once access is back.
//
//   npm run research:gates:refresh                      # stale sign-in gates only
//   npm run research:gates:refresh -- --signed-in familysearch,findmypast
//   npm run research:gates:refresh -- --entitlement findmypast   # after a subscription change
//   ... [--target <id>]... [--force] [--dry-run] [--json] [--scope <scope>]
//
// Each reopened route gets an auditable acquisition attempt and returns to an
// actionable status, so the acquisition queue retries it. If access is still
// missing, the retry records a fresh gate. A route reopened twice that gated
// again each time is left for the user unless --force is passed.

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyGateReopening,
  canonicalAccessProvider,
  planGateReopenings,
  providerAccessSignals
} from "./access-gates.mjs";
import { acquisitionAttemptFingerprint } from "./acquisition-attempt-fingerprint.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { parseResearchScope, researchScopeOf } from "./research-scope.mjs";

export function refreshAccessGates({ store, scope = "main", signedIn = [], entitlement = [], targetIds = null, force = false, write = false, now = new Date() }) {
  const targets = store.acquisitionTargets.filter((target) => researchScopeOf(target) === scope);
  const questionAttempts = store.questions.flatMap((question) => question.attempts || []);
  const signals = providerAccessSignals({ acquisitionTargets: store.acquisitionTargets, questionAttempts });
  const { plan, skipped } = planGateReopenings(targets, { signals, signedIn, entitlement, force, targetIds });
  const touched = new Set();
  for (const item of plan) {
    if (write) {
      applyGateReopening(item, {
        now,
        fingerprint: ({ routeId, outcome, note }) => acquisitionAttemptFingerprint({ targetId: item.target.id, routeId, outcome, note })
      });
      touched.add(item.target);
    }
  }
  if (write) for (const target of touched) writeJsonAtomic(target.__file, stripInternal(target));
  return {
    scope,
    dryRun: !write,
    reopened: plan.map(({ target, route, providerId, reason, restoredStatus }) => ({
      targetId: target.id, routeId: route.id, provider: providerId, restoredStatus, reason
    })),
    skipped: skipped.map(({ target, route, providerId, reason }) => ({ targetId: target.id, routeId: route.id, provider: providerId, reason })),
    providers: Object.fromEntries([...signals].map(([providerId, signal]) => [providerId, {
      lastAuthenticatedReadAt: signal.lastSuccessAt ? new Date(signal.lastSuccessAt).toISOString() : null,
      lastSignInGateAt: signal.lastSignInGateAt ? new Date(signal.lastSignInGateAt).toISOString() : null
    }]))
  };
}

function stripInternal(target) {
  const copy = { ...target };
  for (const key of Object.keys(copy)) if (key.startsWith("__")) delete copy[key];
  return copy;
}

function providerList(args, flag) {
  return args.flatMap((value, index) => (args[index - 1] === flag ? value.split(",") : []))
    .map((value) => canonicalAccessProvider(value.trim()))
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const scope = parseResearchScope(args);
  const targetIds = args.flatMap((value, index) => (args[index - 1] === "--target" ? [value] : []));
  const result = refreshAccessGates({
    store: loadResearchStore(),
    scope,
    signedIn: providerList(args, "--signed-in"),
    entitlement: providerList(args, "--entitlement"),
    targetIds: targetIds.length ? new Set(targetIds) : null,
    force: args.includes("--force"),
    write: !args.includes("--dry-run")
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const verb = result.dryRun ? "Would reopen" : "Reopened";
  console.log(`${verb} ${result.reopened.length} access-gated route(s) in scope ${scope}.`);
  for (const item of result.reopened) console.log(`  ${item.targetId} [${item.provider}] -> ${item.restoredStatus}: ${item.reason}`);
  for (const item of result.skipped) console.log(`  kept ${item.targetId} [${item.provider}]: ${item.reason}`);
  if (result.reopened.length && !result.dryRun) {
    console.log("Run npm run build so the acquisition queue picks the reopened routes up.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
