#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { explicitSubscriptionProjectionRoute } from "./subscription-registration-route.mjs";
import { artifactPolicyFor, extractLocators, inferRecordClass } from "./source-atoms-lib.mjs";
import { reconcileProviderPublishEligibility } from "./source-acquisition-authority.mjs";
import {
  canonicalProviderSlug,
  loadResearchStore,
  projectRoot,
  readJson,
  researchPaths
} from "./research-store.mjs";

const checkOnly = process.argv.includes("--check");
const store = loadResearchStore();
const peopleIds = new Set(store.people.map((person) => person.personId));
const sources = new Map(store.sources.map((source) => [source.id, source]));
const targets = new Map(store.acquisitionTargets.map((target) => [target.id, target]));
const targetsBySource = new Map(store.acquisitionTargets.map((target) => [target.sourceId, target]));
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const changed = new Map();
const providerAccessStatuses = new Set([
  "provider-alternate",
  "index-only-no-image",
  "needs-familysearch-center",
  "needs-alternate-route"
]);

for (const record of manifest.records || []) {
  const sourceId = record.sourceAtomId || record.id;
  // A newly registered source master is deliberately absent from record.viewer
  // until its private Blob upload succeeds. Preserve an explicit canonical
  // approved-private source policy during that pending interval; absence
  // of delivery metadata is not evidence that the source was reclassified as
  // a withheld control.
  const canonicalSource = sources.get(sourceId);
  const canonicalTarget = targetsBySource.get(sourceId);
  const explicitlyWithheld = canonicalSource?.viewerPolicy === "withheld-control";
  const approvedForViewer = !explicitlyWithheld && (Boolean(record.viewer?.approved)
    || canonicalTarget?.desiredArtifact?.publishEligible === true);
  const source = ensureSource(sourceId, {
    provider: record.source,
    reference: record.reference,
    people: record.people,
    url: record.catalogueUrl,
    mediaType: record.mediaType,
    scope: "preserved-record",
    viewerPolicy: approvedForViewer ? "approved-private" : "withheld-control"
  });
  set(source, "recordId", record.id);
  set(source, "viewerPolicy", approvedForViewer ? "approved-private" : "withheld-control");
  ensureTarget(sourceId, source, {
    provider: record.source,
    reference: record.reference,
    people: record.people,
    publishEligible: approvedForViewer
  });
}

for (const spec of providerSpecs()) {
  const queue = readJson(path.join(projectRoot, spec.file));
  for (const item of queue.targets || []) {
    const sourceId = item.atomId || item.id;
    const publishEligible = reconcileProviderPublishEligibility(
      providerPublishEligible(item),
      sources.get(sourceId),
      targetsBySource.get(sourceId)
    );
    const source = ensureSource(sourceId, {
      provider: item.provider || spec.provider,
      reference: item.reference,
      people: item.people,
      url: item.recordUrl || item.url || item.catalogueUrl,
      scope: "planned-source",
      viewerPolicy: publishEligible ? "approved-private" : "not-applicable"
    });
    const target = ensureTarget(sourceId, source, {
      id: item.id,
      provider: item.provider || spec.provider,
      reference: item.reference,
      people: item.people,
      publishEligible
    });
    const providerRouteId = item.routeId || item.id;
    let route = target.routes?.find((candidate) => candidate.id === providerRouteId);
    if (item.routeId) {
      if (spec.sourceQueue !== "subscription-records") {
        throw new Error(`Explicit subscription route binding on a different queue: ${item.id}`);
      }
      route = explicitSubscriptionProjectionRoute(target, item);
    }
    if (!route) {
      route = {
        id: providerRouteId,
        targetId: target.id,
        sourceQueue: spec.sourceQueue,
        provider: item.provider || spec.provider,
        route: spec.route,
        priority: item.priority || target.priority,
        status: mapRouteStatus(item.status),
        ...(item.recordUrl || item.url || item.catalogueUrl
          ? { sourceUrl: item.recordUrl || item.url || item.catalogueUrl } : {}),
        ...(item.reference ? { reference: item.reference } : {})
      };
      target.routes ||= [];
      target.routes.push(route);
      changed.set(target.__file, target);
    } else {
      const mappedStatus = mapRouteStatus(item.status);
      const custodyStatus = ["acquired", "published"].includes(item.status);
      const publishedByProvider = item.viewerPublishState === "published";
      const shouldPromotePublished = publishedByProvider && route.status !== "published";
      const shouldRecordCustody = custodyStatus && !["acquired", "published"].includes(route.status);
      const shouldRecordAccess = providerAccessStatuses.has(item.status)
        && route.status === "error-retryable" && route.status !== mappedStatus;
      if (shouldPromotePublished || shouldRecordCustody || shouldRecordAccess) {
        route.status = shouldPromotePublished ? "published" : mappedStatus;
        changed.set(target.__file, target);
      }
    }
  }
}

const materialChanges = new Map([...changed].filter(([file, value]) => {
  if (!fs.existsSync(file)) return true;
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(value);
  } catch {
    return true;
  }
}));

if (checkOnly && materialChanges.size) {
  console.error(`canonical source/target inputs are stale:\n- ${[...materialChanges.keys()].map((file) => path.relative(projectRoot, file)).join("\n- ")}\nRun npm run research:sync:inputs.`);
  process.exit(1);
}
if (!checkOnly) for (const [file, value] of materialChanges) writeJsonAtomic(file, value);
console.log(`${checkOnly ? "checked" : "synchronized"} custody/provider inputs: ${materialChanges.size} canonical file(s) ${checkOnly ? "would change" : "changed"}`);

function ensureSource(id, input) {
  let source = sources.get(id);
  if (!source) {
    const provider = input.provider || "Unassigned provider";
    const recordClass = inferRecordClass(`${provider} ${input.reference || ""}`, input.mediaType || "");
    source = {
      schemaVersion: 1,
      id,
      kind: recordClass === "search-audit" ? "search-audit" : "documentary",
      scope: input.scope || "planned-source",
      provider,
      source: provider,
      reference: input.reference || id,
      recordClass,
      artifactPolicy: artifactPolicyFor(recordClass),
      viewerPolicy: input.viewerPolicy || "not-applicable",
      artifactPurpose: "control",
      intendedPersonIds: validPeople(input.people),
      locators: extractLocators(input.url, input.reference),
      includeInLegacyAtomProjection: true
    };
    const directory = path.join(researchPaths.sources, canonicalProviderSlug(provider));
    if (!checkOnly) fs.mkdirSync(directory, { recursive: true });
    Object.defineProperty(source, "__file", { value: path.join(directory, `${id}.json`), enumerable: false });
    sources.set(id, source);
    changed.set(source.__file, source);
  } else {
    if (input.scope === "preserved-record" && source.scope === "planned-source") {
      set(source, "scope", "preserved-record");
    }
    const locators = extractLocators(input.url);
    if (locators.length) {
      const existing = new Set((source.locators || []).map((locator) => `${locator.kind}:${locator.value}`));
      const merged = [...(source.locators || []), ...locators.filter((locator) => !existing.has(`${locator.kind}:${locator.value}`))];
      if (merged.length !== (source.locators || []).length) set(source, "locators", merged);
    }
  }
  return source;
}

function ensureTarget(sourceId, source, input) {
  let target = targetsBySource.get(sourceId) || targets.get(input.id || sourceId);
  if (target) {
    // Custody can be registered before publication, and a former viewer item
    // can later be deliberately withheld as a control. Keep only publication
    // intent on the target; artifact classification and viewer policy remain
    // owned by the canonical source.
    set(target, "schemaVersion", 4);
    for (const field of ["artifactPurpose", "recordClass", "artifactPolicy", "viewerPolicy"]) unset(target, field);
    set(target, "desiredArtifact", { publishEligible: Boolean(input.publishEligible) });
    return target;
  }
  const id = input.id || sourceId;
  target = {
    schemaVersion: 4,
    id,
    sourceId,
    questionIds: [],
    priority: "P2",
    provider: input.provider || source.provider,
    reference: input.reference || source.reference,
    desiredArtifact: { publishEligible: Boolean(input.publishEligible) },
    routes: []
  };
  Object.defineProperty(target, "__file", {
    value: path.join(researchPaths.acquisitionTargets, `${id}.json`),
    enumerable: false
  });
  targets.set(id, target);
  targetsBySource.set(sourceId, target);
  changed.set(target.__file, target);
  return target;
}

function set(value, field, next) {
  if (JSON.stringify(value[field]) === JSON.stringify(next)) return;
  value[field] = next;
  changed.set(value.__file, value);
}

function unset(value, field) {
  if (!Object.hasOwn(value, field)) return;
  delete value[field];
  changed.set(value.__file, value);
}

function validPeople(values) {
  return [...new Set(values || [])].filter((id) => peopleIds.has(id)).sort();
}

function providerPublishEligible(item) {
  if (item.publishEligible === false || item.viewerPublishState === "withheld-control") return false;
  return Boolean(item.viewer || item.publishEligible);
}

function mapRouteStatus(status) {
  return ({
    ready: "ready-download",
    "pending-subscription": "ready-subscription-capture",
    "provider-alternate": "alternate-provider",
    "index-only-no-image": "resolved-index-only",
    acquired: "acquired",
    published: "published"
  })[status] || status || "queued-free-search";
}

function providerSpecs() {
  return [
    {
      file: "evidence/familysearch-recovery-queue.json",
      provider: "FamilySearch",
      sourceQueue: "familysearch-recovery",
      route: "shared-windows-chrome-cdp"
    },
    {
      file: "evidence/record-recovery-queue.json",
      provider: "Public web",
      sourceQueue: "public-record-recovery",
      route: "public-https-download"
    },
    {
      file: "evidence/subscription-records-queue.json",
      provider: "Subscription provider",
      sourceQueue: "subscription-records",
      route: "windows-subscription-profile"
    }
  ];
}
