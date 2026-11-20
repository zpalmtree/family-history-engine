import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  implementedResearchProviders,
  isResearchProviderHostAllowed,
  loadResearchProviderCapabilities,
  researchProviderCapability,
  researchProviderOperation,
} from "./research-provider-capabilities.mjs";
import {
  assertArchionCatalogParishUrl,
  assertArchionCatalogStepSet,
  loadAndAssertArchionCatalogContext,
} from "./archion-catalog-policy.mjs";
import { researchScopeOf, researchScopes } from "./research-scope.mjs";
import { assertFamilySearchImageUrl } from "./familysearch-viewer-metadata.mjs";

const PROVIDER_REGISTRY = loadResearchProviderCapabilities();
const IMPLEMENTED_PROVIDERS = implementedResearchProviders(PROVIDER_REGISTRY);
const PROVIDER_OPERATIONS = Object.freeze(Object.fromEntries(IMPLEMENTED_PROVIDERS.map((provider) => [
  provider.id,
  new Set(provider.browserBatch.operations.map((operation) => operation.id)),
])));
const TOP_FIELDS = new Set(["schemaVersion", "provider", "affinitySlot", "research", "steps"]);
const RESEARCH_FIELDS = new Set(["questionId", "actionId", "coverage", "scope"]);
const STEP_FIELDS = new Set(["id", "operation", "url", "matchTerms", "returnLimit", "openRowTerms", "openRowOrdinal"]);
const RESEARCH_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SENSITIVE_KEY = /(password|passphrase|pin|cvv|cvc|card|cookie|authorization|secret|token|credential|email|phone|address)/i;

export function validateResearchBatchPlan(input, { projectRoot = process.cwd(), checkCanonical = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The batch plan must be one JSON object.");
  rejectSensitiveKeys(input);
  rejectUnknownFields(input, TOP_FIELDS, "plan");
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be exactly 1.");
  if (!Object.hasOwn(PROVIDER_OPERATIONS, input.provider)) {
    if (PROVIDER_REGISTRY.providers.some((provider) => provider.id === input.provider)) {
      throw new Error(`provider ${input.provider} is scaffolded but has no implemented read-only browser batch adapter.`);
    }
    throw new Error(`provider must be one of: ${IMPLEMENTED_PROVIDERS.map((provider) => provider.id).join(", ")}.`);
  }
  if (!SLOT_PATTERN.test(input.affinitySlot || "")) {
    throw new Error("affinitySlot must be a stable lowercase letter/digit/hyphen identifier up to 32 characters.");
  }
  validateResearch(input.research);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 25) {
    throw new Error("steps must contain 1 through 25 read-only operations.");
  }
  const ids = new Set();
  const steps = input.steps.map((step, index) => validateStep(step, index, input.provider, ids));
  const research = { ...input.research, scope: input.research.scope || "main" };
  const canonical = checkCanonical ? assertCanonicalResearch(research, projectRoot) : null;
  if (input.provider === "archion") {
    assertArchionCatalogStepSet(steps);
    if (canonical) {
      loadAndAssertArchionCatalogContext({
        projectRoot,
        research,
        question: canonical.question,
        action: canonical.action,
        steps,
      });
    }
  }
  return {
    schemaVersion: 1,
    provider: input.provider,
    affinitySlot: input.affinitySlot,
    research,
    steps,
  };
}

function validateResearch(research) {
  if (!research || typeof research !== "object" || Array.isArray(research)) {
    throw new Error("research must be one object naming an existing question and action.");
  }
  rejectUnknownFields(research, RESEARCH_FIELDS, "research");
  for (const field of ["questionId", "actionId"]) {
    if (!RESEARCH_ID_PATTERN.test(research[field] || "")) throw new Error(`research.${field} is invalid.`);
  }
  if (typeof research.coverage !== "string" || !research.coverage.trim() || research.coverage.length > 1_000) {
    throw new Error("research.coverage must be 1 through 1000 characters.");
  }
  if (research.scope !== undefined && !researchScopes.includes(research.scope)) {
    throw new Error(`research.scope must be ${researchScopes.join(" or ")}.`);
  }
}

function validateStep(step, index, provider, ids) {
  const label = `steps[${index}]`;
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${label} must be an object.`);
  rejectUnknownFields(step, STEP_FIELDS, label);
  if (!STEP_ID_PATTERN.test(step.id || "")) throw new Error(`${label}.id is invalid.`);
  if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}.`);
  ids.add(step.id);
  if (!PROVIDER_OPERATIONS[provider].has(step.operation)) {
    throw new Error(`${label}.operation is not a read-only ${provider} batch operation.`);
  }
  const providerCapability = researchProviderCapability(provider, PROVIDER_REGISTRY);
  if (providerCapability.browserBatch.state !== "implemented") {
    throw new Error(`${label}.provider has no implemented read-only browser batch adapter.`);
  }
  const operationCapability = researchProviderOperation(provider, step.operation, PROVIDER_REGISTRY);
  let parsed;
  try { parsed = new URL(step.url); } catch { throw new Error(`${label}.url is invalid.`); }
  if (parsed.protocol !== "https:" || !isResearchProviderHostAllowed(provider, parsed.hostname, PROVIDER_REGISTRY)) {
    throw new Error(`${label}.url is not an allowed HTTPS ${provider} route.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label}.url must not include credentials.`);
  validateOperationRoute(operationCapability.routePolicy, parsed, label);
  // record-facts reads one record page and does not wait for a search to
  // render, so on a results URL it reports the "(0)" placeholder as a false
  // zero. Search results must use page-links, which waits for rows or an
  // explicit zero-result state.
  if (provider === "familysearch" && step.operation === "record-facts"
      && /\/search\/record\/results\/?$/i.test(parsed.pathname)) {
    throw new Error(`${label}: use page-links for FamilySearch record search results; record-facts reads only one record page.`);
  }
  const matchTerms = step.matchTerms === undefined ? [] : step.matchTerms;
  if (!Array.isArray(matchTerms) || matchTerms.length > 12 || matchTerms.some((term) =>
    typeof term !== "string" || !term.trim() || term.length > 160)) {
    throw new Error(`${label}.matchTerms must contain at most 12 non-empty strings of at most 160 characters.`);
  }
  const returnLimit = step.returnLimit === undefined ? 20 : Number(step.returnLimit);
  if (!Number.isInteger(returnLimit) || returnLimit < 1 || returnLimit > 100) {
    throw new Error(`${label}.returnLimit must be an integer from 1 through 100.`);
  }
  // openRowTerms (Findmypast result rows only): open the single result row
  // whose text contains every term, through its own View button, and report
  // the record URL it reaches. Rows no longer carry record links.
  let openRowTerms;
  if (step.openRowTerms !== undefined) {
    if (provider !== "findmypast" || step.operation !== "findmypast-row") {
      throw new Error(`${label}.openRowTerms is only valid for a findmypast-row step.`);
    }
    if (!Array.isArray(step.openRowTerms) || step.openRowTerms.length < 2 || step.openRowTerms.length > 6
      || step.openRowTerms.some((term) => typeof term !== "string" || !term.trim() || term.length > 160)) {
      throw new Error(`${label}.openRowTerms must contain 2 through 6 non-empty strings of at most 160 characters.`);
    }
    openRowTerms = step.openRowTerms.map((term) => term.trim());
  }
  // openRowOrdinal (1-5, with openRowTerms): when several rows match the
  // terms, deliberately open the Nth of them in page order, e.g. two packet
  // documents indexed with identical fields. Without it, ambiguity is refused.
  let openRowOrdinal;
  if (step.openRowOrdinal !== undefined) {
    if (!openRowTerms) throw new Error(`${label}.openRowOrdinal requires openRowTerms.`);
    openRowOrdinal = Number(step.openRowOrdinal);
    if (!Number.isInteger(openRowOrdinal) || openRowOrdinal < 1 || openRowOrdinal > 5) {
      throw new Error(`${label}.openRowOrdinal must be an integer from 1 through 5.`);
    }
  }
  return { id: step.id, operation: step.operation, url: parsed.toString(), matchTerms: [...new Set(matchTerms.map(normalizeText))], returnLimit, ...(openRowTerms ? { openRowTerms } : {}), ...(openRowOrdinal ? { openRowOrdinal } : {}) };
}

function validateOperationRoute(routePolicy, parsed, label) {
  if (routePolicy === "familysearch-image-metadata") {
    assertFamilySearchImageUrl(parsed.href);
    return;
  }
  if (routePolicy === "provider-read-route") return;
  if (routePolicy === "ancestry-record") {
    if (!/^\/search\/collections\/\d+\/records\/\d+\/?$/i.test(parsed.pathname)) {
      throw new Error(`${label}.url must be one exact Ancestry record route for record-facts.`);
    }
    return;
  }
  if (routePolicy === "ancestry-public-tree-results") {
    if (!/^\/search\/collections\/1030\/?$/i.test(parsed.pathname)) {
      throw new Error(`${label}.url must be the Ancestry Public Member Trees collection route.`);
    }
    return;
  }
  if (routePolicy === "ancestry-public-tree-person") {
    if (!/^\/family-tree\/person\/tree\/\d+\/person\/-?\d+\/facts\/?$/i.test(parsed.pathname)) {
      throw new Error(`${label}.url must be one exact Ancestry public-tree person facts route.`);
    }
    return;
  }
  if (routePolicy === "findmypast-transcript") {
    if (parsed.pathname !== "/transcript") throw new Error(`${label}.url must be the exact Findmypast /transcript route.`);
    return;
  }
  if (routePolicy === "findmypast-newspaper-results") {
    if (parsed.pathname !== "/search-newspapers/results") {
      throw new Error(`${label}.url must be the exact Findmypast /search-newspapers/results route.`);
    }
    return;
  }
  if (routePolicy === "antenati-register-ark") {
    if (!/^\/ark:\/12657\/an_ua\d+\/?$/i.test(parsed.pathname)) {
      throw new Error(`${label}.url must be one exact Antenati register ARK route.`);
    }
    return;
  }
  if (routePolicy === "pcusa-catalog-results") {
    if (parsed.hostname !== "catalog.history.pcusa.org" || parsed.pathname !== "/cgi-bin/koha/opac-search.pl") {
      throw new Error(`${label}.url must be the exact PHS Koha catalog search route.`);
    }
    return;
  }
  if (routePolicy === "pcusa-catalog-detail") {
    if (parsed.hostname !== "catalog.history.pcusa.org" || parsed.pathname !== "/cgi-bin/koha/opac-detail.pl"
        || !/^\d+$/.test(parsed.searchParams.get("biblionumber") || "")) {
      throw new Error(`${label}.url must be one exact PHS Koha catalog detail route.`);
    }
    return;
  }
  if (routePolicy === "pcusa-catalog-marc") {
    if (parsed.hostname !== "catalog.history.pcusa.org" || parsed.pathname !== "/cgi-bin/koha/opac-MARCdetail.pl"
        || !/^\d+$/.test(parsed.searchParams.get("biblionumber") || "")) {
      throw new Error(`${label}.url must be one exact PHS Koha MARC detail route.`);
    }
    return;
  }
  if (routePolicy === "pcusa-digital-context") {
    if (parsed.hostname !== "digital.history.pcusa.org" || !/^\/(?:$|islandora\/(?:search|object)(?:\/|$))/i.test(parsed.pathname)) {
      throw new Error(`${label}.url must be the PHS digital root, search, or exact object route.`);
    }
    return;
  }
  if (routePolicy === "ava-index-document") {
    if (parsed.hostname !== "ava.fidlar.com"
        || parsed.pathname !== "/OHFairfield/AvaWeb/"
        || parsed.search
        || !/^#\/search\?docname=(?:GE|GR)1801-99-[A-Z]{3}-[A-Z]{3}$/i.test(parsed.hash)) {
      throw new Error(`${label}.url must be one exact Fairfield County AVA grantor or grantee index document search route.`);
    }
    return;
  }
  if (routePolicy === "archion-braunschweig-catalog") {
    assertArchionCatalogParishUrl(parsed.toString());
    return;
  }
  throw new Error(`${label}.operation route policy is not implemented: ${routePolicy}.`);
}

function assertCanonicalResearch(research, projectRoot) {
  const questionFile = path.join(projectRoot, "evidence", "research", "questions", `${research.questionId}.json`);
  let question;
  try { question = JSON.parse(fs.readFileSync(questionFile, "utf8")); }
  catch { throw new Error(`Canonical research question does not exist: ${research.questionId}.`); }
  if (question.id !== research.questionId) throw new Error(`Canonical question id mismatch in ${path.basename(questionFile)}.`);
  if (researchScopeOf(question) !== research.scope) {
    throw new Error(`Canonical question ${research.questionId} belongs to ${researchScopeOf(question)}, not ${research.scope}.`);
  }
  const action = (question.actions || []).find((candidate) => candidate.id === research.actionId);
  if (!action) {
    throw new Error(`Canonical action ${research.actionId} does not exist on ${research.questionId}.`);
  }
  return { question, action };
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}.`);
}

function rejectSensitiveKeys(value, trail = "plan") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Sensitive field is forbidden in a browser batch plan: ${trail}.${key}.`);
    rejectSensitiveKeys(child, `${trail}.${key}`);
  }
}

export function normalizedBatchResult(values, { matchTerms = [], returnLimit = 20 } = {}) {
  const unique = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeResult(value);
    const key = `${normalized.href || ""}\u0000${normalized.text || ""}`;
    if ((!normalized.text && !normalized.href) || seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  const terms = matchTerms.map(normalizeText);
  unique.sort((left, right) => score(right, terms) - score(left, terms));
  return {
    all: unique,
    returned: unique.slice(0, returnLimit),
    visibleCount: unique.length,
    returnedCount: Math.min(unique.length, returnLimit),
    truncated: unique.length > returnLimit,
  };
}

function normalizeResult(value) {
  const result = { text: String(value?.text || "").replace(/\s+/g, " ").trim().slice(0, 12_000) };
  if (value?.href) result.href = sanitizeUrl(value.href);
  if (value?.label) result.label = String(value.label).replace(/\s+/g, " ").trim().slice(0, 500);
  return result;
}

function score(value, terms) {
  const text = normalizeText(`${value.text || ""} ${value.label || ""}`);
  return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function sanitizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

export function batchFingerprint(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 20);
}

export const researchBatchOperations = PROVIDER_OPERATIONS;
