import fs from "node:fs";
import path from "node:path";

import { resolveRouteAccessEntitlement } from "./research-access-preemption.mjs";
import { researchScopeOf } from "./research-scope.mjs";

// The tree's one Archion catalogue batch lives in tree/archion-catalog.json
// (question, action, target, route, authorization target, archive URL and
// parish list). Without it every Archion catalogue batch is refused.
const catalogFile = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tree", "archion-catalog.json");
const catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, "utf8")) : {};
export const ARCHION_CATALOG_QUESTION_ID = catalog.questionId || null;
export const ARCHION_CATALOG_ACTION_ID = catalog.actionId || null;
export const ARCHION_CATALOG_TARGET_ID = catalog.targetId || null;
export const ARCHION_CATALOG_ROUTE_ID = catalog.routeId || null;
export const ARCHION_AUTHORIZATION_TARGET_ID = catalog.authorizationTargetId || null;
export const ARCHION_CATALOG_ARCHIVE_URL = catalog.archiveUrl || "https://www.archion.de/";

const PARISH_SLUGS = catalog.parishes || [];

export const ARCHION_CATALOG_PARISHES = Object.freeze(PARISH_SLUGS.map(([id, label, slug]) => Object.freeze({
  id,
  label,
  slug,
  url: `${ARCHION_CATALOG_ARCHIVE_URL}/${slug}`,
})));

export function assertArchionCatalogParishUrl(rawUrl) {
  const classified = classifyArchionCatalogUrl(rawUrl);
  if (classified.kind !== "parish") {
    throw new Error("Archion catalogue batch inputs must be one of the configured canonical parish routes (tree/archion-catalog.json).");
  }
  return classified;
}

export function assertArchionCatalogObjectUrl(rawUrl, parishId) {
  const classified = classifyArchionCatalogUrl(rawUrl);
  if (classified.kind !== "object" || classified.parishId !== parishId) {
    throw new Error(`Archion catalogue output must be one numeric object under the exact ${parishId} parish route.`);
  }
  return classified;
}

export function classifyArchionCatalogUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("Archion catalogue URL is invalid."); }
  if (parsed.protocol !== "https:"
      || parsed.hostname !== "www.archion.de"
      || parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
    throw new Error("Archion catalogue URLs require HTTPS, exact host www.archion.de, and no credentials, port, query, or fragment.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname === new URL(ARCHION_CATALOG_ARCHIVE_URL).pathname) {
    return { kind: "archive", url: ARCHION_CATALOG_ARCHIVE_URL };
  }
  for (const parish of ARCHION_CATALOG_PARISHES) {
    const parishPath = new URL(parish.url).pathname;
    if (pathname === parishPath) return { kind: "parish", parishId: parish.id, url: parish.url };
    const objectMatch = pathname.match(new RegExp(`^${escapeRegex(parishPath)}/([1-9]\\d*)$`));
    if (objectMatch) {
      return {
        kind: "object",
        parishId: parish.id,
        objectId: objectMatch[1],
        url: `${parish.url}/${objectMatch[1]}`,
      };
    }
  }
  throw new Error("Archion catalogue URL is outside the exact Braunschweig archive and nine-parish allowlist.");
}

export function assertArchionCatalogStepSet(steps, candidateUrls = ARCHION_CATALOG_PARISHES.map((parish) => parish.url)) {
  if (!Array.isArray(steps) || steps.length !== ARCHION_CATALOG_PARISHES.length) {
    throw new Error("Archion Braunschweig catalogue discovery requires exactly nine parish steps in one batch.");
  }
  const canonicalCandidates = [...new Set((candidateUrls || []).map((url) => assertArchionCatalogParishUrl(url).url))].sort();
  const expectedCandidates = ARCHION_CATALOG_PARISHES.map((parish) => parish.url).sort();
  if (JSON.stringify(canonicalCandidates) !== JSON.stringify(expectedCandidates)) {
    throw new Error("The canonical Archion route must retain all nine exact discovered parish candidates before batch use.");
  }
  const seen = new Set();
  for (const step of steps) {
    const parish = ARCHION_CATALOG_PARISHES.find((candidate) => candidate.id === step.id);
    if (!parish || step.operation !== "catalog-results") {
      throw new Error(`Archion catalogue step must use one exact parish id and catalog-results operation: ${step?.id || "(missing)"}.`);
    }
    const classified = assertArchionCatalogParishUrl(step.url);
    if (classified.parishId !== parish.id || classified.url !== parish.url || seen.has(parish.id)) {
      throw new Error(`Archion catalogue step ${step.id} does not match its unique canonical parish route.`);
    }
    seen.add(parish.id);
  }
  return true;
}

export function assertArchionCatalogCanonicalContext({
  research,
  question,
  action,
  target,
  route,
  request,
  authorizationTarget,
  steps,
  now = new Date(),
} = {}) {
  if (research?.questionId !== ARCHION_CATALOG_QUESTION_ID
      || research?.actionId !== ARCHION_CATALOG_ACTION_ID
      || (research.scope || "main") !== "main") {
    throw new Error("Archion catalogue batches are limited to the exact ready main-scope question and action in tree/archion-catalog.json.");
  }
  if (question?.id !== ARCHION_CATALOG_QUESTION_ID
      || researchScopeOf(question) !== "main"
      || question.lifecycle !== "active"
      || action?.id !== ARCHION_CATALOG_ACTION_ID
      || action.status !== "ready"
      || action.acquisitionTargetId !== ARCHION_CATALOG_TARGET_ID) {
    throw new Error("The canonical Archion catalogue action is missing, stale, gated, completed, or outside main scope.");
  }
  if (target?.id !== ARCHION_CATALOG_TARGET_ID
      || target.sourceId !== ARCHION_CATALOG_TARGET_ID
      || researchScopeOf(target) !== "main"
      || target.provider !== "Archion"
      || !(target.questionIds || []).includes(ARCHION_CATALOG_QUESTION_ID)
      || route?.id !== ARCHION_CATALOG_ROUTE_ID
      || route.targetId !== ARCHION_CATALOG_TARGET_ID
      || route.sourceQueue !== "archion-access"
      || route.provider !== "Archion"
      || route.route !== "paid-provider-subscription"
      || route.status !== "subscription-first"
      || classifyArchionCatalogUrl(route.sourceUrl).kind !== "archive"
      || classifyArchionCatalogUrl(route.sourceUrl).url !== ARCHION_CATALOG_ARCHIVE_URL) {
    throw new Error("The exact canonical Archion catalogue target and subscription-first route are required.");
  }
  assertArchionCatalogStepSet(steps, route.candidateUrls);
  const resolved = resolveRouteAccessEntitlement(route, {
    target,
    requests: new Map(request ? [[request.id, request]] : []),
  });
  const authorizationRoute = authorizationTarget?.routes?.find(
    (candidate) => candidate.id === resolved.authorizationItem?.routeId,
  );
  const nowValue = now instanceof Date ? now.getTime() : Date.parse(now);
  if (resolved.issues.length
      || !resolved.reused
      || route.accessEntitlement?.authorizationTargetId !== ARCHION_AUTHORIZATION_TARGET_ID
      || request?.id !== ARCHION_AUTHORIZATION_TARGET_ID
      || request.provider !== "Archion"
      || request.kind !== "paid-order"
      || request.guard?.requiredPhrase !== `PAY ${ARCHION_AUTHORIZATION_TARGET_ID}`
      || request.guard?.costMode !== "maximum"
      || request.guard?.currency !== "EUR"
      || request.guard?.maxAmount !== 19.9
      || authorizationTarget?.id !== ARCHION_AUTHORIZATION_TARGET_ID
      || authorizationTarget.provider !== "Archion"
      || authorizationRoute?.targetId !== ARCHION_AUTHORIZATION_TARGET_ID
      || authorizationRoute.provider !== "Archion"
      || authorizationRoute.sourceQueue !== "archion-access"
      || authorizationRoute.route !== "paid-provider-subscription"
      || !new Set(["acquired", "published"]).has(authorizationRoute.status)
      || !Number.isFinite(nowValue)
      || Date.parse(route.accessEntitlement?.expiresAt || "") <= nowValue) {
    const suffix = resolved.issues.length ? `: ${resolved.issues.join("; ")}` : "";
    throw new Error(`The Archion catalogue route has no valid active reusable entitlement${suffix}.`);
  }
  return { target, route, request, authorizationTarget };
}

export function loadAndAssertArchionCatalogContext({ projectRoot, research, question, action, steps, now = new Date() } = {}) {
  const target = readJson(path.join(projectRoot, "evidence", "acquisition", "targets", `${ARCHION_CATALOG_TARGET_ID}.json`));
  const route = target.routes?.find((candidate) => candidate.id === ARCHION_CATALOG_ROUTE_ID);
  const request = readJson(path.join(projectRoot, "evidence", "acquisition", "requests", `${ARCHION_AUTHORIZATION_TARGET_ID}.json`));
  const authorizationTarget = readJson(path.join(projectRoot, "evidence", "acquisition", "targets", `${ARCHION_AUTHORIZATION_TARGET_ID}.json`));
  return assertArchionCatalogCanonicalContext({ research, question, action, target, route, request, authorizationTarget, steps, now });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`Required canonical Archion file is missing or invalid: ${path.relative(process.cwd(), file)}.`); }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
