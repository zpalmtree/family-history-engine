import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquisitionRoutesRequireExternalAction } from "./research-acquisition.mjs";

import {
  assertionMap,
  entityMap,
  jsonFiles,
  loadResearchStore,
  projectRoot,
  readJson,
  serializeJson
} from "./research-store.mjs";
import { defaultResearchScope, isDormantScope, researchScopes } from "./research-scope.mjs";

export const extractionOutcomes = new Set([
  "claims-corrected-added",
  "corroboration-added",
  "question-context",
  "control-exclusion",
  "structural-no-content",
  "verified-no-new-material-fact",
  "refetch-required",
  "deferred-dormant-scope"
]);

export const extractionRiskFlags = new Set([
  "parentage",
  "identity",
  "union",
  "direct-line-bridge",
  "person-links-changed",
  "conflict",
  "difficult-reading",
  "decisive-negative",
  "question-transition"
]);

export const participantRoles = new Set([
  "principal",
  "spouse",
  "parent",
  "grandparent",
  "child",
  "sibling",
  "witness",
  "informant",
  "officiant",
  "neighbor",
  "bondsman",
  "executor",
  "beneficiary",
  "household-member",
  "employer",
  "other"
]);

export const extractionChecklistFields = Object.freeze([
  "sourceMasterOpened",
  "visualAtSourceResolution",
  "allPagesReviewed",
  "structuredPersonLinksCompared",
  "sourceSpellingsPreserved",
  "neighboringMaterialExcluded",
  "questionEffectsAssessed"
]);

export const defaultExtractionPaths = extractionPaths(projectRoot);

export function extractionPaths(root) {
  const base = path.join(root, "evidence", "extraction");
  return Object.freeze({
    base,
    store: path.join(base, "store.json"),
    campaigns: path.join(base, "campaigns"),
    packets: path.join(base, "packets"),
    reviews: path.join(base, "reviews"),
    manifest: path.join(root, "evidence", "records-manifest.json")
  });
}

export function extractionReviewId(recordId, sha256) {
  return `${recordId}@${sha256}`;
}

export function extractionReviewFile(root, recordId, sha256) {
  assertId(recordId, "record id");
  assertSha256(sha256, "review sha256");
  return path.join(extractionPaths(root).reviews, recordId, `${sha256}.json`);
}

export function extractionPacketFile(root, packetId) {
  assertId(packetId, "packet id");
  return path.join(extractionPaths(root).packets, `${packetId}.json`);
}

export function manifestRecordDigest(records) {
  const material = records.map((record) => ({
    id: record.id,
    sha256: record.sha256,
    sourceId: record.sourceId || record.sourceAtomId || record.id,
    mediaType: record.mediaType,
    length: record.length
  })).sort((left, right) => left.id.localeCompare(right.id));
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function isDeterministicQaSelection(recordId, campaignId, ratePercent = 10) {
  if (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new Error(`invalid QA rate: ${ratePercent}`);
  }
  if (ratePercent === 0) return false;
  if (ratePercent === 100) return true;
  const digest = crypto.createHash("sha256").update(`${campaignId}\0${recordId}`).digest();
  return digest.readUInt32BE(0) % 100 < ratePercent;
}

export function buildExtractionCampaign({
  manifest,
  researchStore,
  campaignId = "master-reread-2026-07-28",
  capturedAt = "2026-07-28",
  qaRatePercent = 10,
  existingCampaign
}) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.records)) {
    throw new Error("records manifest schemaVersion 1 with a records array is required");
  }
  assertId(campaignId, "campaign id");
  const people = new Map((researchStore?.people || []).map((person) => [person.personId, person]));
  const records = manifest.records.map((record) => {
    const researchScope = inferRecordResearchScope(record, people);
    return {
      recordId: record.id,
      sha256: record.sha256,
      sourceId: record.sourceAtomId || record.id,
      mediaType: record.mediaType,
      researchScope,
      qaSelected: isDeterministicQaSelection(record.id, campaignId, qaRatePercent)
    };
  }).sort((left, right) => scopeOrder(left.researchScope) - scopeOrder(right.researchScope)
    || left.recordId.localeCompare(right.recordId));
  const digest = manifestRecordDigest(manifest.records);
  const currentSnapshot = {
    capturedAt,
    recordCount: records.length,
    manifestDigest: digest
  };
  return {
    schemaVersion: 1,
    id: campaignId,
    title: "Current source-master visual reread",
    state: "active",
    initialSnapshot: existingCampaign?.initialSnapshot || currentSnapshot,
    currentSnapshot,
    policy: {
      reviewMethod: "original-visual",
      qaAlgorithm: "sha256-campaign-record-mod-100-v1",
      qaRatePercent,
      maxRecordsPerPacket: 20,
      detailedOnlyDisposition: "deferred-dormant-scope",
      biographyMetadataCountsAsExtractionReview: false
    },
    records
  };
}

export function inferRecordResearchScope(record, peopleById) {
  const linked = (record.people || []).map((id) => peopleById.get(id)).filter(Boolean);
  const scopes = new Set(linked.map((person) => person.researchScope));
  const [only] = scopes;
  return linked.length > 0 && scopes.size === 1 && isDormantScope(only) ? only : defaultResearchScope;
}

export function loadExtractionStore({ root = projectRoot, researchStore } = {}) {
  const paths = extractionPaths(root);
  const descriptor = readJson(paths.store);
  if (descriptor.schemaVersion !== 1 || !descriptor.activeCampaignId || !descriptor.activeCampaignFile) {
    throw new Error("invalid extraction store descriptor");
  }
  const campaignFile = path.resolve(paths.base, descriptor.activeCampaignFile);
  if (!isWithin(paths.campaigns, campaignFile)) throw new Error("active extraction campaign must be under evidence/extraction/campaigns");
  const campaign = readJson(campaignFile);
  if (campaign.id !== descriptor.activeCampaignId) throw new Error("active campaign id disagrees with its descriptor");
  const manifest = readJson(paths.manifest);
  const packets = fs.existsSync(paths.packets)
    ? jsonFiles(paths.packets).map((file) => withFile(readJson(file), file))
    : [];
  const reviews = fs.existsSync(paths.reviews)
    ? jsonFiles(paths.reviews, { recursive: true }).map((file) => withFile(readJson(file), file))
    : [];
  return {
    root,
    paths,
    descriptor,
    campaign,
    manifest,
    packets,
    reviews,
    researchStore: researchStore || (root === projectRoot ? loadResearchStore() : undefined)
  };
}

export function validateExtractionStore(store, { requireComplete = false } = {}) {
  return validateExtractionStoreDetailed(store, { requireComplete }).issues;
}

// Validates the store once and keeps each review's own issues, keyed by the
// review object, so the status builder can reuse them instead of validating
// every current review a second (and, through the nested status call, a
// third) time.
function validateExtractionStoreDetailed(store, { requireComplete = false } = {}) {
  const issues = [];
  const reviewIssues = new Map();
  let lookups;
  const manifestById = entityMap(store.manifest.records || [], "id", "manifest record");
  const campaignById = entityMap(store.campaign.records || [], "recordId", "campaign record");
  const campaignIssues = validateCampaign(store.campaign, store.manifest);
  issues.push(...campaignIssues);
  if (store.researchStore) {
    const people = new Map(store.researchStore.people.map((person) => [person.personId, person]));
    for (const campaignRecord of store.campaign.records || []) {
      const manifestRecord = manifestById.get(campaignRecord.recordId);
      if (!manifestRecord) continue;
      const expectedScope = inferRecordResearchScope(manifestRecord, people);
      if (campaignRecord.researchScope !== expectedScope) {
        issues.push(`campaign record ${campaignRecord.recordId} has scope ${campaignRecord.researchScope}; expected ${expectedScope}`);
      }
    }
  }

  const packetById = new Map();
  const packetForRecord = new Map();
  for (const packet of store.packets || []) {
    if (packetById.has(packet.id)) issues.push(`duplicate extraction packet id: ${packet.id}`);
    packetById.set(packet.id, packet);
    issues.push(...validateExtractionPacket(packet, { campaign: store.campaign, campaignById }));
    if (packet.state === "retired") continue;
    for (const member of packet.records || []) {
      if (packetForRecord.has(member.recordId)) {
        issues.push(`record ${member.recordId} belongs to multiple active extraction packets`);
      } else {
        packetForRecord.set(member.recordId, packet.id);
      }
    }
  }

  const reviewKeys = new Set();
  const reviewByCurrentRecord = new Map();
  for (const review of store.reviews || []) {
    const key = extractionReviewId(review.recordId || "missing", review.sha256 || "missing");
    if (reviewKeys.has(key)) issues.push(`duplicate extraction review: ${key}`);
    reviewKeys.add(key);
    const expectedFile = safeExpectedReviewFile(store.root, review);
    if (review.__file && expectedFile && path.resolve(review.__file) !== path.resolve(expectedFile)) {
      issues.push(`${key} is not stored at its record-and-hash path`);
    }
    const campaignRecord = campaignById.get(review.recordId);
    const manifestRecord = manifestById.get(review.recordId);
    lookups ||= extractionReviewLookups(store.researchStore);
    const ownIssues = validateExtractionReview(review, {
      campaign: store.campaign,
      campaignRecord,
      manifestRecord,
      packetById,
      researchStore: store.researchStore,
      lookups
    });
    reviewIssues.set(review, ownIssues);
    issues.push(...ownIssues);
    if (campaignRecord?.sha256 === review.sha256) reviewByCurrentRecord.set(review.recordId, review);
  }

  const status = buildExtractionStatusFrom(store, { skipValidation: true }, { issues: [], reviewIssues });
  if (requireComplete && status.counts.complete !== status.total) {
    issues.push(`extraction campaign is incomplete: ${status.counts.complete || 0}/${status.total} current masters complete`);
  }
  return { issues, reviewIssues };
}

// Store-wide lookups a review validation needs. Building them costs a walk of
// every person, union, kinship and question, so callers validating many
// reviews build them once and pass them as `lookups`; a single-review caller
// may omit it. Assertion and question ids are still checked for duplicates.
export function extractionReviewLookups(researchStore) {
  return {
    peopleById: new Map((researchStore?.people || []).map((person) => [person.personId, person])),
    assertions: researchStore ? assertionMap(researchStore) : new Map(),
    questions: researchStore ? entityMap(researchStore.questions, "id", "research question") : new Map()
  };
}

export function validateCampaign(campaign, manifest) {
  const issues = [];
  if (campaign?.schemaVersion !== 1) return ["extraction campaign must use schemaVersion 1"];
  if (!isId(campaign.id)) issues.push("extraction campaign has an invalid id");
  if (campaign.state !== "active") issues.push(`extraction campaign ${campaign.id} is not active`);
  const policy = campaign.policy || {};
  if (policy.reviewMethod !== "original-visual") issues.push("extraction campaign must require original-visual review");
  if (policy.biographyMetadataCountsAsExtractionReview !== false) {
    issues.push("biography metadata must count as zero extraction reviews");
  }
  if (policy.detailedOnlyDisposition !== "deferred-dormant-scope") {
    issues.push("detailed-only records must use deferred-dormant-scope");
  }
  if (!Number.isInteger(policy.qaRatePercent) || policy.qaRatePercent !== 10) {
    issues.push("extraction campaign QA rate must be the accepted deterministic 10 percent");
  }
  if (!Number.isInteger(policy.maxRecordsPerPacket) || policy.maxRecordsPerPacket < 1) {
    issues.push("extraction campaign requires a positive packet size limit");
  }
  const ids = new Set();
  for (const record of campaign.records || []) {
    if (!isId(record.recordId)) issues.push("campaign record has an invalid recordId");
    else if (ids.has(record.recordId)) issues.push(`duplicate campaign record: ${record.recordId}`);
    ids.add(record.recordId);
    if (!isSha256(record.sha256)) issues.push(`campaign record ${record.recordId} has invalid sha256`);
    if (!researchScopes.includes(record.researchScope)) {
      issues.push(`campaign record ${record.recordId} has invalid researchScope`);
    }
    const expectedQa = isDeterministicQaSelection(record.recordId, campaign.id, policy.qaRatePercent);
    if (record.qaSelected !== expectedQa) issues.push(`campaign record ${record.recordId} has incorrect deterministic QA selection`);
  }
  const manifestRecords = manifest?.records || [];
  const currentDigest = manifestRecordDigest(manifestRecords);
  if (campaign.currentSnapshot?.recordCount !== manifestRecords.length) {
    issues.push(`campaign snapshot count ${campaign.currentSnapshot?.recordCount} disagrees with manifest count ${manifestRecords.length}`);
  }
  if (campaign.currentSnapshot?.manifestDigest !== currentDigest) {
    issues.push("campaign snapshot digest is stale relative to the records manifest");
  }
  const manifestById = new Map(manifestRecords.map((record) => [record.id, record]));
  if ((campaign.records || []).length !== manifestRecords.length) {
    issues.push(`campaign has ${(campaign.records || []).length} records but manifest has ${manifestRecords.length}`);
  }
  for (const record of campaign.records || []) {
    const manifestRecord = manifestById.get(record.recordId);
    if (!manifestRecord) issues.push(`campaign record ${record.recordId} is absent from manifest`);
    else {
      if (manifestRecord.sha256 !== record.sha256) issues.push(`campaign record ${record.recordId} has stale hash`);
      if ((manifestRecord.sourceAtomId || manifestRecord.id) !== record.sourceId) {
        issues.push(`campaign record ${record.recordId} has stale source id`);
      }
      if (manifestRecord.mediaType !== record.mediaType) issues.push(`campaign record ${record.recordId} has stale media type`);
    }
  }
  return issues;
}

export function validateExtractionPacket(packet, { campaign, campaignById } = {}) {
  const issues = [];
  const label = `packet ${packet?.id || "(missing)"}`;
  if (packet?.schemaVersion !== 1) issues.push(`${label} must use schemaVersion 1`);
  if (!isId(packet?.id)) issues.push(`${label} has an invalid id`);
  if (packet?.campaignId !== campaign?.id) issues.push(`${label} belongs to another campaign`);
  if (!["ready", "in-progress", "complete", "quarantined", "retired"].includes(packet?.state)) {
    issues.push(`${label} has invalid state`);
  }
  if (!["P0", "P1", "P2", "P3"].includes(packet?.priority)) issues.push(`${label} has invalid priority`);
  if (!nonempty(packet?.title)) issues.push(`${label} requires a title`);
  if (!nonempty(packet?.rationale)) issues.push(`${label} requires a rationale`);
  const members = packet?.records || [];
  if (!Array.isArray(members) || !members.length) issues.push(`${label} requires at least one record`);
  if (members.length > (campaign?.policy?.maxRecordsPerPacket || 20)) {
    issues.push(`${label} exceeds the campaign packet size limit`);
  }
  const seen = new Set();
  let scope;
  for (const member of members) {
    if (seen.has(member.recordId)) issues.push(`${label} repeats ${member.recordId}`);
    seen.add(member.recordId);
    const campaignRecord = campaignById?.get(member.recordId);
    if (!campaignRecord) issues.push(`${label} references unknown campaign record ${member.recordId}`);
    else {
      if (member.sha256 !== campaignRecord.sha256) issues.push(`${label}/${member.recordId} has a stale hash`);
      if (scope && scope !== campaignRecord.researchScope) issues.push(`${label} mixes research scopes`);
      scope ||= campaignRecord.researchScope;
    }
  }
  if (packet?.researchScope !== scope) issues.push(`${label} researchScope disagrees with its records`);
  return issues;
}

export function validateExtractionReview(review, {
  campaign,
  campaignRecord,
  manifestRecord,
  packetById = new Map(),
  researchStore,
  lookups
} = {}) {
  const issues = [];
  const { peopleById, assertions, questions } = lookups || extractionReviewLookups(researchStore);
  const label = `review ${review?.recordId || "(missing)"}@${String(review?.sha256 || "").slice(0, 12) || "missing"}`;
  if (review?.schemaVersion !== 1) issues.push(`${label} must use schemaVersion 1`);
  if (!isId(review?.recordId)) issues.push(`${label} has invalid recordId`);
  if (!isSha256(review?.sha256)) issues.push(`${label} has invalid sha256`);
  if (review?.id !== extractionReviewId(review?.recordId, review?.sha256)) issues.push(`${label} has an invalid id`);
  if (review?.campaignId !== campaign?.id) issues.push(`${label} belongs to another campaign`);
  if (!campaignRecord) issues.push(`${label} references a record outside the campaign`);
  else {
    if (review.sourceId !== campaignRecord.sourceId) issues.push(`${label} sourceId disagrees with campaign`);
    if (review.researchScope !== campaignRecord.researchScope) issues.push(`${label} researchScope disagrees with campaign`);
  }
  if (manifestRecord && review.sha256 === manifestRecord.sha256 && review.sourceId !== (manifestRecord.sourceAtomId || manifestRecord.id)) {
    issues.push(`${label} sourceId disagrees with manifest`);
  }
  if (!["current", "superseded"].includes(review?.state)) issues.push(`${label} has invalid state`);
  const dormantScopeDisposition = review?.outcome === "deferred-dormant-scope";
  if (dormantScopeDisposition) {
    if (review?.method !== "scope-disposition") issues.push(`${label} dormant scope must use scope-disposition method`);
  } else if (review?.method !== "original-visual") {
    issues.push(`${label} must use original-visual method`);
  }
  if (!isIsoDateTime(review?.reviewedAt)) issues.push(`${label} requires an ISO reviewedAt timestamp`);
  if (!nonempty(review?.reviewerId)) issues.push(`${label} requires reviewerId`);
  if (!extractionOutcomes.has(review?.outcome)) issues.push(`${label} has invalid outcome`);
  if (isDormantScope(review?.researchScope) && review?.outcome !== "deferred-dormant-scope") {
    issues.push(`${label} cannot activate detailed-scope extraction`);
  }
  if (!isDormantScope(review?.researchScope) && review?.outcome === "deferred-dormant-scope") {
    issues.push(`${label} may defer only a detailed-only record`);
  }
  if (review?.outcome === "refetch-required" && !nonempty(review?.refetchReason)) {
    issues.push(`${label} refetch-required outcome requires refetchReason`);
  }
  if (review?.outcome !== "refetch-required" && review?.refetchReason !== undefined) {
    issues.push(`${label} retains refetchReason outside refetch-required`);
  }
  for (const field of extractionChecklistFields) {
    if (!dormantScopeDisposition && review?.checklist?.[field] !== true) issues.push(`${label} checklist.${field} must be true`);
  }
  if (!dormantScopeDisposition) {
    issues.push(...validatePageCoverage(review?.pageCoverage, manifestRecord?.mediaType || campaignRecord?.mediaType, label, review));
  } else {
    if (review?.pageCoverage !== undefined) issues.push(`${label} dormant scope cannot claim page coverage`);
    if ((review?.readings || []).length || (review?.participants || []).length
      || (review?.personLinkChanges || []).length || (review?.claimEffects || []).length
      || (review?.questionEffects || []).length || (review?.riskFlags || []).length) {
      issues.push(`${label} dormant scope cannot claim content extraction or reconciliation effects`);
    }
  }

  const readingIds = new Set();
  for (const [index, reading] of (review?.readings || []).entries()) {
    const readingLabel = `${label} reading[${index}]`;
    if (!isLocalId(reading?.id)) issues.push(`${readingLabel} has invalid id`);
    else if (readingIds.has(reading.id)) issues.push(`${label} repeats reading ${reading.id}`);
    readingIds.add(reading?.id);
    if (!nonempty(reading?.locator)) issues.push(`${readingLabel} requires locator`);
    if (!nonempty(reading?.textAsRecorded)) issues.push(`${readingLabel} requires literal textAsRecorded`);
  }

  const participantIds = new Set();
  for (const [index, participant] of (review?.participants || []).entries()) {
    const participantLabel = `${label} participant[${index}]`;
    if (!isLocalId(participant?.id)) issues.push(`${participantLabel} has invalid id`);
    else if (participantIds.has(participant.id)) issues.push(`${label} repeats participant ${participant.id}`);
    participantIds.add(participant?.id);
    if (!nonempty(participant?.nameAsRecorded)) issues.push(`${participantLabel} requires nameAsRecorded`);
    if (!participantRoles.has(participant?.role)) issues.push(`${participantLabel} has invalid role`);
    if (!["confirmed", "candidate", "unlinked"].includes(participant?.identificationStatus)) {
      issues.push(`${participantLabel} has invalid identificationStatus`);
    }
    if (participant?.identificationStatus === "unlinked" && participant?.canonicalPersonId !== undefined) {
      issues.push(`${participantLabel} unlinked participant cannot have canonicalPersonId`);
    }
    if (["confirmed", "candidate"].includes(participant?.identificationStatus)) {
      if (!nonempty(participant?.canonicalPersonId)) issues.push(`${participantLabel} requires canonicalPersonId`);
      else if (researchStore && !peopleById.has(participant.canonicalPersonId)) {
        issues.push(`${participantLabel} references unknown canonical person ${participant.canonicalPersonId}`);
      }
    }
    validateIdReferences(participant?.readingIds, readingIds, `${participantLabel} readingIds`, issues, { requireNonempty: true });
  }

  const riskFlags = review?.riskFlags || [];
  if (!Array.isArray(riskFlags)) issues.push(`${label} riskFlags must be an array`);
  else {
    for (const risk of riskFlags) if (!extractionRiskFlags.has(risk)) issues.push(`${label} has invalid risk flag ${risk}`);
    if (new Set(riskFlags).size !== riskFlags.length) issues.push(`${label} repeats a risk flag`);
  }
  const linkChanges = review?.personLinkChanges || [];
  if (!Array.isArray(linkChanges)) issues.push(`${label} personLinkChanges must be an array`);
  else for (const [index, change] of linkChanges.entries()) {
    const changeLabel = `${label} personLinkChanges[${index}]`;
    if (!["add", "remove", "change-identification"].includes(change?.kind)) issues.push(`${changeLabel} has invalid kind`);
    if (!nonempty(change?.participantId) || !participantIds.has(change.participantId)) issues.push(`${changeLabel} requires a participantId`);
    if (!nonempty(change?.rationale)) issues.push(`${changeLabel} requires rationale`);
  }
  if (linkChanges.length && !riskFlags.includes("person-links-changed")) {
    issues.push(`${label} person-link changes require person-links-changed risk flag`);
  }

  const claimEffects = review?.claimEffects || [];
  if (!Array.isArray(claimEffects)) issues.push(`${label} claimEffects must be an array`);
  else for (const [index, effect] of claimEffects.entries()) {
    const effectLabel = `${label} claimEffects[${index}]`;
    if (!nonempty(effect?.assertionId)) issues.push(`${effectLabel} requires assertionId`);
    if (!["added", "corrected", "corroborated", "confirmed", "rejected"].includes(effect?.effect)) {
      issues.push(`${effectLabel} has invalid effect`);
    }
    validateIdReferences(effect?.readingIds, readingIds, `${effectLabel} readingIds`, issues, { requireNonempty: true });
    const assertion = assertions.get(effect?.assertionId);
    if (researchStore && !assertion) issues.push(`${effectLabel} references unknown assertion ${effect?.assertionId}`);
    else if (assertion && !(assertion.evidence || []).some((evidence) => evidence.sourceId === review.sourceId)) {
      issues.push(`${effectLabel} assertion ${effect.assertionId} does not cite ${review.sourceId}`);
    }
  }
  if (review?.outcome === "claims-corrected-added"
    && !claimEffects.some((effect) => ["added", "corrected", "rejected"].includes(effect.effect))) {
    issues.push(`${label} claims-corrected-added outcome requires a changed claim`);
  }
  if (review?.outcome === "corroboration-added"
    && !claimEffects.some((effect) => ["corroborated", "confirmed"].includes(effect.effect))) {
    issues.push(`${label} corroboration-added outcome requires a corroborated or confirmed claim`);
  }

  const questionEffects = review?.questionEffects || [];
  if (!Array.isArray(questionEffects)) issues.push(`${label} questionEffects must be an array`);
  else for (const [index, effect] of questionEffects.entries()) {
    const effectLabel = `${label} questionEffects[${index}]`;
    const question = questions.get(effect?.questionId);
    if (!nonempty(effect?.questionId)) issues.push(`${effectLabel} requires questionId`);
    else if (researchStore && !question) issues.push(`${effectLabel} references unknown question ${effect.questionId}`);
    else if (question && (question.researchScope || "main") !== review.researchScope) {
      issues.push(`${effectLabel} crosses research scopes`);
    }
    if (!["supports", "new-evidence", "context", "conflict", "reopen", "no-change", "deferred"].includes(effect?.effect)) {
      issues.push(`${effectLabel} has invalid effect`);
    }
    if (!nonempty(effect?.rationale)) issues.push(`${effectLabel} requires rationale`);
    validateIdReferences(effect?.readingIds || [], readingIds, `${effectLabel} readingIds`, issues);
    if (review?.reconciliation?.status === "complete") {
      issues.push(...validateQuestionEffectConsumption(effect, {
        effectLabel,
        review,
        question,
        assertions
      }));
    }
  }
  if (review?.outcome === "question-context" && !questionEffects.length) {
    issues.push(`${label} question-context outcome requires questionEffects`);
  }

  const reconciliation = review?.reconciliation;
  if (!reconciliation || !["pending", "complete"].includes(reconciliation.status)) {
    issues.push(`${label} requires pending or complete reconciliation`);
  } else if (reconciliation.status === "pending") {
    if (reconciliation.reconciledAt || reconciliation.reconcilerId) {
      issues.push(`${label} pending reconciliation cannot claim completion metadata`);
    }
  } else {
    if (!isIsoDateTime(reconciliation.reconciledAt)) issues.push(`${label} complete reconciliation requires reconciledAt`);
    if (!nonempty(reconciliation.reconcilerId)) issues.push(`${label} complete reconciliation requires reconcilerId`);
  }

  const requiredReasons = requiredSecondReviewReasons(review, { campaignRecord, assertions });
  issues.push(...validateSecondReview(review, requiredReasons, label));

  if (review?.packetId !== undefined) {
    const packet = packetById.get(review.packetId);
    if (!packet) issues.push(`${label} references unknown packet ${review.packetId}`);
    else if (!(packet.records || []).some((member) => member.recordId === review.recordId && member.sha256 === review.sha256)) {
      issues.push(`${label} does not belong to packet ${review.packetId}`);
    }
  }
  return issues;
}

export function requiredSecondReviewReasons(review, { campaignRecord, assertions = new Map() } = {}) {
  if (review?.outcome === "deferred-dormant-scope") return [];
  const reasons = new Set();
  if (campaignRecord?.qaSelected) reasons.add("deterministic-qa-sample");
  for (const risk of review?.riskFlags || []) reasons.add(risk);
  if ((review?.personLinkChanges || []).length) reasons.add("person-links-changed");
  if (review?.outcome === "refetch-required") reasons.add("refetch-required");
  for (const effect of review?.questionEffects || []) {
    if (effect.effect === "conflict") reasons.add("conflict");
    if (effect.effect === "reopen") reasons.add("question-transition");
  }
  for (const effect of review?.claimEffects || []) {
    const kind = assertions.get(effect.assertionId)?.claim?.kind;
    if (kind === "parentage") reasons.add("parentage");
    if (kind === "person-identity") reasons.add("identity");
    if (kind === "union") reasons.add("union");
  }
  return [...reasons].sort();
}

export function normalizeSecondReview(review, context = {}) {
  const reasons = requiredSecondReviewReasons(review, context);
  return {
    ...review,
    secondReview: reasons.length
      ? { status: "pending", requiredReasons: reasons }
      : { status: "not-required", requiredReasons: [] }
  };
}

export function buildExtractionStatus(store, { skipValidation = false, scope } = {}) {
  if (scope !== undefined && !researchScopes.includes(scope)) {
    throw new Error(`unsupported extraction research scope: ${scope}`);
  }
  const validation = skipValidation ? { issues: [], reviewIssues: new Map() } : validateExtractionStoreDetailed(store);
  return buildExtractionStatusFrom(store, { skipValidation, scope }, validation);
}

function buildExtractionStatusFrom(store, { scope } = {}, { issues, reviewIssues }) {
  const reviewsByRecord = new Map();
  for (const review of store.reviews || []) {
    if (!reviewsByRecord.has(review.recordId)) reviewsByRecord.set(review.recordId, []);
    reviewsByRecord.get(review.recordId).push(review);
  }
  const packetForRecord = new Map();
  for (const packet of store.packets || []) {
    if (packet.state === "retired") continue;
    for (const member of packet.records || []) packetForRecord.set(member.recordId, packet);
  }
  const campaignRecords = (store.campaign.records || [])
    .filter((campaignRecord) => scope === undefined || campaignRecord.researchScope === scope);
  const edgePeople = frontierEdgePersonIds(store.researchStore);
  const linkedPeople = new Map((store.researchStore?.sources || [])
    .map((source) => [source.id, (source.personLinks || []).map((link) => link.personId)]));
  const manifestById = new Map();
  for (const record of store.manifest.records || []) if (!manifestById.has(record.id)) manifestById.set(record.id, record);
  const packetById = new Map((store.packets || []).map((packet) => [packet.id, packet]));
  let lookups;
  const items = campaignRecords.map((campaignRecord) => {
    const reviews = reviewsByRecord.get(campaignRecord.recordId) || [];
    const current = reviews.find((review) => review.sha256 === campaignRecord.sha256 && review.state !== "superseded");
    const oldHashCount = reviews.filter((review) => review.sha256 !== campaignRecord.sha256).length;
    const recordIssues = !current ? []
      : reviewIssues.get(current) || validateExtractionReview(current, {
        campaign: store.campaign,
        campaignRecord,
        manifestRecord: manifestById.get(campaignRecord.recordId),
        packetById,
        researchStore: store.researchStore,
        lookups: (lookups ||= extractionReviewLookups(store.researchStore))
      });
    let state;
    if (!current) state = oldHashCount ? "stale-hash" : "primary-review";
    else if (recordIssues.length) state = "invalid-review";
    else if (current.outcome === "refetch-required") state = "refetch-required";
    else if (current.reconciliation.status !== "complete") state = "reconciliation";
    else if (current.secondReview.status === "changes-required") state = "primary-correction";
    else if (current.secondReview.status === "pending") state = "second-review";
    else state = "complete";
    const recoveryTarget = state === "refetch-required"
      ? store.researchStore?.acquisitionTargets?.find((target) => (
        target.sourceId === campaignRecord.sourceId
        && (target.researchScope || "main") === campaignRecord.researchScope
      ))
      : undefined;
    // A completed route acquired the current unreadable bytes. It does not
    // make a separately gated request for a better copy executable.
    const recoveryGated = recoveryTarget
      && acquisitionRoutesRequireExternalAction(recoveryTarget.routes);
    return {
      recordId: campaignRecord.recordId,
      sha256: campaignRecord.sha256,
      sourceId: campaignRecord.sourceId,
      researchScope: campaignRecord.researchScope,
      qaSelected: campaignRecord.qaSelected,
      packetId: packetForRecord.get(campaignRecord.recordId)?.id,
      state,
      ...(recoveryGated ? { executable: false } : {}),
      ...((linkedPeople.get(campaignRecord.sourceId) || []).some((id) => edgePeople.has(id))
        ? { frontierEdge: true } : {}),
      oldHashCount,
      issues: recordIssues
    };
  });
  const counts = countBy(items, "state");
  const next = selectNextExtractionWork(items, store.packets || []);
  return {
    schemaVersion: 1,
    campaignId: store.campaign.id,
    researchScope: scope || "all",
    total: items.length,
    counts,
    complete: counts.complete || 0,
    pending: items.length - (counts.complete || 0),
    issues,
    next,
    items
  };
}

// People at the edge of the tree: anyone with an open parent slot on a live,
// unestablished question. The user asked on 7 Oct 2026 that rereads favour
// records naming these people.
export function frontierEdgePersonIds(researchStore) {
  const ids = new Set();
  for (const question of researchStore?.questions || []) {
    if (question.lifecycle !== "active" || question.conclusion?.state === "established") continue;
    for (const key of question.goalKeys || []) {
      const match = /^parent-slot:([^:]+):/.exec(key);
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

export function selectNextExtractionWork(items, packets = []) {
  const rank = new Map([
    ["invalid-review", 0],
    ["primary-correction", 1],
    ["reconciliation", 2],
    ["second-review", 3],
    ["refetch-required", 4],
    ["stale-hash", 5],
    ["primary-review", 6]
  ]);
  const actionable = items.filter((item) => rank.has(item.state) && item.executable !== false).sort((left, right) => {
    const leftPacket = packets.find((packet) => packet.id === left.packetId);
    const rightPacket = packets.find((packet) => packet.id === right.packetId);
    return rank.get(left.state) - rank.get(right.state)
      || packetPriority(leftPacket) - packetPriority(rightPacket)
      || Number(!left.frontierEdge) - Number(!right.frontierEdge)
      || scopeOrder(left.researchScope) - scopeOrder(right.researchScope)
      || left.recordId.localeCompare(right.recordId);
  });
  if (!actionable.length) return null;
  const selected = actionable[0];
  if (!selected.packetId) return { kind: selected.state, implicitPacket: true, records: [selected] };
  return {
    kind: selected.state,
    packetId: selected.packetId,
    records: items.filter((item) => item.packetId === selected.packetId
      && item.state !== "complete" && item.executable !== false)
  };
}

export function summarizeExtractionStatus(status) {
  const debt = Object.entries(status.counts)
    .filter(([state]) => state !== "complete")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}=${count}`)
    .join(", ") || "none";
  return `Extraction campaign ${status.campaignId}: ${status.complete}/${status.total} complete; ${debt}.`;
}

export function serializeExtractionJson(value) {
  return serializeJson(value);
}

// A whole printed reference volume (an alphabetical directory, for instance)
// kept only as a control may be reviewed at the pages its alphabetical
// arrangement locates, rather than page by page. The exception is limited to a
// multi-page PDF, a control-exclusion outcome with no claim, link, question or
// risk effect, and a stated locator basis, so it can never carry a canonical
// change that the unread pages could contradict.
export const ALPHABETICAL_LOCATOR_MIN_PAGES = 50;

function alphabeticalLocatorIssues(coverage, mediaType, label, review) {
  const issues = [];
  if (mediaType !== "application/pdf") issues.push(`${label} alphabetical-locator coverage requires a PDF master`);
  if (!(coverage.pageCount >= ALPHABETICAL_LOCATOR_MIN_PAGES)) {
    issues.push(`${label} alphabetical-locator coverage requires at least ${ALPHABETICAL_LOCATOR_MIN_PAGES} pages`);
  }
  if (review?.outcome !== "control-exclusion") issues.push(`${label} alphabetical-locator coverage requires a control-exclusion outcome`);
  if ((review?.participants || []).length || (review?.personLinkChanges || []).length
    || (review?.claimEffects || []).length || (review?.riskFlags || []).length
    || (review?.questionEffects || []).some((effect) => effect?.effect !== "no-change")) {
    issues.push(`${label} alphabetical-locator coverage cannot carry claim, link, question or risk effects`);
  }
  if (!nonempty(coverage.locatorBasis)) issues.push(`${label} alphabetical-locator coverage requires locatorBasis`);
  return issues;
}

function validatePageCoverage(coverage, mediaType, label, review) {
  const issues = [];
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return [`${label} requires pageCoverage`];
  if (!Number.isInteger(coverage.pageCount) || coverage.pageCount < 1) issues.push(`${label} pageCoverage requires positive pageCount`);
  if (mediaType?.startsWith("image/") && coverage.pageCount !== 1) {
    issues.push(`${label} image master must have pageCount 1`);
  }
  const ranges = coverage.reviewedRanges;
  if (!Array.isArray(ranges) || !ranges.length) issues.push(`${label} pageCoverage requires reviewedRanges`);
  else if (Number.isInteger(coverage.pageCount) && coverage.pageCount > 0) {
    const covered = new Set();
    for (const [index, range] of ranges.entries()) {
      if (!Number.isInteger(range?.from) || !Number.isInteger(range?.to)
        || range.from < 1 || range.to < range.from || range.to > coverage.pageCount) {
        issues.push(`${label} pageCoverage range[${index}] is invalid`);
        continue;
      }
      for (let page = range.from; page <= range.to; page += 1) covered.add(page);
    }
    if (coverage.scope === "alphabetical-locator") {
      issues.push(...alphabeticalLocatorIssues(coverage, mediaType, label, review));
    } else if (coverage.scope !== undefined) {
      issues.push(`${label} pageCoverage has unsupported scope ${coverage.scope}`);
    } else if (covered.size !== coverage.pageCount) issues.push(`${label} pageCoverage does not cover every page`);
  }
  if (!nonempty(coverage.basis)) issues.push(`${label} pageCoverage requires basis`);
  return issues;
}

function validateQuestionEffectConsumption(effect, { effectLabel, review, question, assertions }) {
  const issues = [];
  const consumption = effect?.consumption;
  if (!consumption || consumption.status !== "consumed") return [`${effectLabel} must be consumed before reconciliation completes`];
  const expectedKinds = {
    supports: ["assertion-linked"],
    "new-evidence": ["assertion-linked"],
    context: ["question-recorded"],
    conflict: ["assertion-linked", "question-transition"],
    reopen: ["question-transition"],
    "no-change": ["reviewed-no-change"],
    deferred: ["deferred-dormant-scope"]
  }[effect.effect] || [];
  if (!expectedKinds.includes(consumption.kind)) issues.push(`${effectLabel} has incompatible consumption kind ${consumption.kind}`);
  if (!nonempty(consumption.rationale)) issues.push(`${effectLabel} consumption requires rationale`);
  if (consumption.kind === "assertion-linked") {
    if (!Array.isArray(consumption.assertionIds) || !consumption.assertionIds.length) {
      issues.push(`${effectLabel} assertion-linked consumption requires assertionIds`);
    } else for (const assertionId of consumption.assertionIds) {
      const assertion = assertions.get(assertionId);
      if (!assertion) issues.push(`${effectLabel} consumption references unknown assertion ${assertionId}`);
      else {
        if (!(assertion.evidence || []).some((evidence) => evidence.sourceId === review.sourceId)) {
          issues.push(`${effectLabel} assertion ${assertionId} does not cite ${review.sourceId}`);
        }
        if (!(assertion.questionIds || []).includes(effect.questionId)) {
          issues.push(`${effectLabel} assertion ${assertionId} is not linked reciprocally to ${effect.questionId}`);
        }
      }
    }
  }
  if (["question-recorded", "question-transition"].includes(consumption.kind)) {
    if (!Array.isArray(consumption.referenceIds) || !consumption.referenceIds.length) {
      issues.push(`${effectLabel} ${consumption.kind} requires referenceIds`);
    } else {
      const canonical = JSON.stringify(question || {});
      for (const referenceId of consumption.referenceIds) {
        if (!nonempty(referenceId) || !canonical.includes(JSON.stringify(referenceId))) {
          issues.push(`${effectLabel} reference ${referenceId} is not recorded on the canonical question`);
        }
      }
    }
  }
  if (consumption.kind === "deferred-dormant-scope" && !isDormantScope(review.researchScope)) {
    issues.push(`${effectLabel} may defer only detailed-scope work`);
  }
  return issues;
}

function validateSecondReview(review, requiredReasons, label) {
  const issues = [];
  const second = review?.secondReview;
  if (!second || !["not-required", "pending", "complete", "changes-required"].includes(second.status)) {
    return [`${label} requires secondReview state`];
  }
  if (!Array.isArray(second.requiredReasons)
    || JSON.stringify([...second.requiredReasons].sort()) !== JSON.stringify(requiredReasons)) {
    issues.push(`${label} secondReview.requiredReasons is stale or incomplete`);
  }
  if (!requiredReasons.length && second.status !== "not-required") {
    issues.push(`${label} has a second review state although none is required`);
  }
  if (requiredReasons.length && second.status === "not-required") {
    issues.push(`${label} requires independent second review: ${requiredReasons.join(", ")}`);
  }
  if (["complete", "changes-required"].includes(second.status)) {
    if (!isIsoDateTime(second.reviewedAt)) issues.push(`${label} completed second review requires reviewedAt`);
    if (!nonempty(second.reviewerId)) issues.push(`${label} completed second review requires reviewerId`);
    if (second.reviewerId === review.reviewerId) issues.push(`${label} second reviewer must be independent`);
    if (second.independent !== true) issues.push(`${label} completed second review must attest independence`);
    if (!nonempty(second.notes)) issues.push(`${label} completed second review requires notes`);
  } else if (second.reviewedAt || second.reviewerId || second.independent || second.notes) {
    issues.push(`${label} incomplete second review cannot retain completion metadata`);
  }
  return issues;
}

function validateIdReferences(values, available, label, issues, { requireNonempty = false } = {}) {
  if (!Array.isArray(values)) {
    issues.push(`${label} must be an array`);
    return;
  }
  if (requireNonempty && !values.length) issues.push(`${label} cannot be empty`);
  for (const value of values) if (!available.has(value)) issues.push(`${label} references unknown id ${value}`);
}

function withFile(value, file) {
  Object.defineProperty(value, "__file", { value: file, enumerable: false });
  return value;
}

function safeExpectedReviewFile(root, review) {
  try {
    return extractionReviewFile(root, review.recordId, review.sha256);
  } catch {
    return null;
  }
}

function scopeOrder(scope) {
  return scope === "main" ? 0 : 1;
}

function packetPriority(packet) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[packet?.priority] ?? 9;
}

function countBy(items, field) {
  const result = {};
  for (const item of items) result[item[field]] = (result[item[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value || ""));
}

function isLocalId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value || ""));
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function assertId(value, label) {
  if (!isId(value)) throw new Error(`invalid ${label}: ${value || "(missing)"}`);
}

function assertSha256(value, label) {
  if (!isSha256(value)) throw new Error(`invalid ${label}: ${value || "(missing)"}`);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateTime(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}
