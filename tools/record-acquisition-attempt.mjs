#!/usr/bin/env node

import { acquisitionAttemptFingerprint, acquisitionAttemptOutcomeToRoute } from "./acquisition-attempt-fingerprint.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { acquisitionRouteStatuses } from "./research-acquisition.mjs";
import { verifiedBoundedCoverage } from "./research-provider-results.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { assertResearchScope, parseResearchScope } from "./research-scope.mjs";

const requestedScope = parseResearchScope(process.argv.slice(2));

const requestedTargetId = valueAfter("--atom") || valueAfter("--target");
const requestedRouteId = valueAfter("--route");
const outcome = valueAfter("--outcome");
const note = valueAfter("--note");
const coverage = valueAfter("--coverage") || "";
const coverageBasis = valueAfter("--coverage-basis") || "";
const candidateUrls = [...new Set(valuesAfter("--candidate-url"))].sort();
if (!requestedTargetId || !outcome) {
  throw new Error("usage: --target <acquisition-target-id> [--route <route-id>] --outcome <status> [--coverage <bounded scope> --coverage-basis <provider/date/place/class basis> --pagination-complete --results-untruncated --provider-coverage-verified] [--note <safe note>] [--candidate-url <https URL>]...");
}
const routeOutcome = acquisitionAttemptOutcomeToRoute.get(outcome) || outcome;
if (!acquisitionRouteStatuses.has(routeOutcome)) throw new Error(`unsupported acquisition outcome: ${outcome}`);
for (const value of [note || "", coverage, coverageBasis]) {
  if (value.length > 1_000 || /password|token|secret|card number|contact details/i.test(value)) {
    throw new Error("attempt text is too long or contains a sensitive-data marker");
  }
}
const recordsBoundedNegative = routeOutcome === "not-found";
let boundedCoverage;
if (recordsBoundedNegative) {
  if (!coverage.trim() || !coverageBasis.trim()
      || !process.argv.includes("--pagination-complete")
      || !process.argv.includes("--results-untruncated")
      || !process.argv.includes("--provider-coverage-verified")) {
    throw new Error("not-found-bounded requires --coverage, --coverage-basis, --pagination-complete, --results-untruncated, and --provider-coverage-verified");
  }
  boundedCoverage = verifiedBoundedCoverage({ coverage, verificationBasis: coverageBasis });
}
if (note && note.length > 500) {
  throw new Error("attempt note is too long or contains a sensitive-data marker");
}
for (const value of candidateUrls) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHost(url.hostname)) throw new Error(`candidate URL is not on an approved HTTPS source host: ${url.hostname}`);
}
if (routeOutcome === "needs-semantic-reconciliation" && !candidateUrls.length) {
  throw new Error("needs-result-review requires at least one --candidate-url");
}
if (routeOutcome === "search-no-candidates" && candidateUrls.length) {
  throw new Error("search-no-candidates cannot include candidate URLs");
}

const store = loadResearchStore();
let target = store.acquisitionTargets.find((item) => item.id === requestedTargetId || item.sourceId === requestedTargetId);
if (!target) target = store.acquisitionTargets.find((item) => item.routes?.some((route) => route.id === requestedTargetId));
if (!target) throw new Error(`unknown acquisition target or route: ${requestedTargetId}`);
assertResearchScope(target, requestedScope, `acquisition target ${target.id}`);
const routeId = requestedRouteId || (target.routes?.some((item) => item.id === requestedTargetId) ? requestedTargetId : undefined);
let route = routeId ? target.routes?.find((item) => item.id === routeId) : undefined;
if (!route && target.routes?.length === 1) route = target.routes[0];
if (!route && target.routes?.length > 1) throw new Error(`target ${target.id} has multiple routes; pass --route with the exact route id`);
if (!route) throw new Error(`target ${target.id} has no acquisition route to update`);

const fingerprint = acquisitionAttemptFingerprint({
  targetId: target.id,
  routeId: route.id,
  outcome: routeOutcome,
  note,
  coverage,
  coverageDetails: boundedCoverage,
  candidateUrls,
});
const existing = (route.attempts || []).find((attempt) => attempt.fingerprint === fingerprint);
if (existing) {
  console.log(`acquisition attempt already recorded for ${target.id} via ${route.id}: ${existing.attemptedAt}`);
  process.exit(0);
}

const timestamp = new Date().toISOString();
const attempt = {
  id: `attempt-${fingerprint.slice(0, 16)}`,
  fingerprint,
  attemptedAt: timestamp,
  outcome,
  ...(boundedCoverage ? { scope: boundedCoverage } : coverage ? { scope: { coverage } } : {}),
  ...(note ? { note } : {}),
  ...(candidateUrls.length ? { candidateUrls } : {})
};
route.status = routeOutcome;
route.lastAttemptAt = timestamp;
route.attempts = [...(route.attempts || []), attempt];
if (candidateUrls.length) route.candidateUrls = candidateUrls;
else if (routeOutcome === "search-no-candidates") delete route.candidateUrls;
writeJsonAtomic(target.__file, target);
console.log(`recorded acquisition attempt for ${target.id} via ${route.id}: ${outcome}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function allowedHost(hostname) {
  return hostname === "www.familysearch.org"
    || hostname === "archive.org"
    || hostname === "genpa.org"
    || hostname === "www.archion.de"
    || hostname === "www.landesarchiv-bw.de"
    || hostname === "www2.landesarchiv-bw.de"
    || hostname === "michigan.access.preservica.com"
    || hostname.endsWith(".ancestry.com")
    || hostname.endsWith(".ancestry.co.uk")
    || hostname.endsWith(".findmypast.com")
    || hostname.endsWith(".findmypast.co.uk")
    || hostname.endsWith(".archives.gov")
    || hostname === "probatesearch.service.gov.uk"
    || hostname === "leicester.contentdm.oclc.org";
}
