#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  assertionMap,
  entityMap,
  loadResearchStore,
  projectRoot,
  readJson
} from "./research-store.mjs";
import {
  acquisitionRouteStatuses,
  reconcileAcquisitionTarget
} from "./research-acquisition.mjs";
import { authorizationGateStatuses, foreignHoldingClaims, outboundVerificationIssues } from "./holding-claims.mjs";
import { formatPlaceRow, placeRoles, placeRowKey, validatePlaceRow } from "./place-labels.mjs";
import {
  evidenceReviewKey,
  isLegacyAssertionEvidence,
  isLegacySourceReview,
  validateEvidenceReview,
  validateSourceReview
} from "./review-provenance.mjs";
import {
  deriveExternalRequest,
  projectExternalRequestOntoRoute,
  validateExternalRequest
} from "./external-request-store.mjs";
import { isResearchAttemptOutcome, validateResearchAction } from "./research-actions.mjs";
import { validateRouteAccessEntitlement } from "./research-access-preemption.mjs";
import {
  normalizeGoalKey,
  questionConclusionStates,
  validateQuestionSupersession
} from "./research-question-state.mjs";
import { validateTargetResearchRole } from "./research-target-state.mjs";
import {
  researchSchedulerFile,
  validateResearchSchedulerRecord
} from "./research-scheduler-store.mjs";
import {
  validateBiographicalReview,
  validateBiographyPresentation,
  validateLifeFact
} from "./biography-schema.mjs";
import { citationSupportsAssertion } from "./citation-coherence.mjs";
import {
  acquisitionTargetAuthorityIssues,
  documentarySourceRequiresAcquisitionTarget
} from "./source-acquisition-authority.mjs";
import { isDormantScope, researchScopeOf, researchScopes } from "./research-scope.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { validateTreeRecencyPolicy } from "./tree-recency-policy.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const store = loadResearchStore();
const issues = [];
const people = entityMap(store.people, "personId", "proof person");
const unions = entityMap(store.unions, "unionId", "proof union");
const kinships = entityMap(store.kinships, "kinshipId", "proof kinship");
const sources = entityMap(store.sources, "id", "source");
const citations = entityMap(store.citations, "id", "citation");
const questions = entityMap(store.questions, "id", "research question");
const targets = entityMap(store.acquisitionTargets, "id", "acquisition target");
const targetsBySourceId = new Map();
const routeOwners = new Map();
const externalRequests = entityMap(store.externalRequests, "id", "external request");
const assertions = assertionMap(store);
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const recordsById = new Map(manifest.records.map((record) => [record.id, record]));
const recordsBySourceId = new Map(manifest.records.map((record) => [record.sourceAtomId || record.id, record]));
const researchAttemptIds = new Map();
const acquisitionAttemptIds = new Map();
const reviewBaseline = readJson(path.join(projectRoot, "evidence", "research", "review-baseline.json"));
const treeRecencyBaseline = readJson(path.join(projectRoot, "evidence", "research", "tree-recency-baseline.json"));
const baselineSourceReviews = new Set(reviewBaseline.sourcePersonLinkIds || []);
const baselineEvidenceReviews = new Set(reviewBaseline.assertionEvidenceKeys || []);

const assessments = new Set(["established", "candidate", "unresolved", "rejected"]);
const claimKinds = new Set([
  "person-identity",
  "name",
  "life-status",
  "event",
  "place-association",
  "occupation",
  "ancestry-origin",
  "parentage",
  "union",
  "sibling",
  "narrative",
  "life-fact"
]);
const evidenceRoles = new Set(["direct", "indirect", "negative", "contradicts", "context"]);
const sourceKinds = new Set(["documentary", "family-statement", "search-audit", "legacy-project-data"]);
const artifactPurposes = new Set(["proof", "control"]);
const researchWorkstreams = new Set(["tree-evidence-resolution"]);
const routeAssessmentStates = new Set(["unassessed", "in-progress", "current-no-known-route"]);
const gateActors = new Set(["user", "external", "system"]);
const gateStates = new Set(["active", "pending", "resolved", "consumed", "retired"]);

for (const bundle of store.people) validatePersonBundle(bundle);
validatePersonIdAliases();
for (const bundle of store.unions) validateUnionBundle(bundle);
for (const bundle of store.kinships) validateKinshipBundle(bundle);
for (const source of store.sources) validateSource(source);
for (const citation of store.citations) validateCitation(citation);
for (const question of store.questions) validateQuestion(question);
for (const target of store.acquisitionTargets) validateTarget(target);
validateSourceTargetCoverage();
for (const request of store.externalRequests) validateRequest(request);
validateBranches();
validateIdentityEvidenceConsistency();
validateDisplayedAncestorOriginFlags();
validateWorkstreams();
validateResearchSchedulers();
if (!issues.length) validateVisibleTreeRecency();

if (issues.length) {
  console.error(`research store check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

const supportCounts = { documented: 0, "family-information": 0, "legacy-unsourced": 0, conflicted: 0 };
for (const assertion of assertions.values()) supportCounts[supportClass(assertion)] += 1;
const acquisitionCounts = {};
for (const target of store.acquisitionTargets) {
  const status = reconcileAcquisitionTarget(target, { recordsById, recordsBySourceId, sourcesById: sources }).status;
  acquisitionCounts[status] = (acquisitionCounts[status] || 0) + 1;
}

console.log(
  `research store ok: ${people.size} people, ${unions.size} unions, ${kinships.size} kinships, ${assertions.size} assertions, `
  + `${sources.size} sources, ${questions.size} questions, ${targets.size} acquisition targets, `
  + `${externalRequests.size} external requests`
);
console.log(`assertion support: ${JSON.stringify(supportCounts)}; acquisition: ${JSON.stringify(acquisitionCounts)}`);

function validatePersonBundle(bundle) {
  if (bundle.schemaVersion !== 2) issue(`${bundle.personId} has unsupported proof schema`);
  assertFileId(bundle, "personId");
  if (!Array.isArray(bundle.branchIds) || !bundle.branchIds.length) issue(`${bundle.personId} requires branchIds`);
  if (!new Set(["private", "public", "restricted"]).has(bundle.privacy)) issue(`${bundle.personId} has invalid privacy`);
  if (bundle.treeAddedAt !== undefined
    && (typeof bundle.treeAddedAt !== "string" || !Number.isFinite(Date.parse(bundle.treeAddedAt)))) {
    issue(`${bundle.personId} has invalid treeAddedAt timestamp`);
  }
  validateResearchScope(bundle, bundle.personId);
  const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
  validatePresentationRef(bundle.personId, bundle.presentation?.displayNameAssertionId, local, "display name");
  const display = local.get(bundle.presentation?.displayNameAssertionId);
  if (display?.claim.kind !== "name" || display.claim.display !== true) {
    issue(`${bundle.personId} display name reference is not a display-name assertion`);
  }
  for (const id of bundle.presentation?.detailAssertionIds || []) validatePresentationRef(bundle.personId, id, local, "detail");
  for (const problem of validateBiographyPresentation(bundle, local)) issue(problem);
  validatePlaceRows(bundle, local);
  const parentAssertions = [];
  for (const id of bundle.presentation?.treeParentAssertionIds || []) {
    validatePresentationRef(bundle.personId, id, local, "tree parent");
    const assertion = local.get(id);
    if (assertion?.claim.kind !== "parentage") issue(`${bundle.personId} tree parent ${id} is not parentage`);
    if (assertion) parentAssertions.push(assertion);
  }
  if (parentAssertions.length > 2) issue(`${bundle.personId} selects more than two tree parents`);
  if (new Set(parentAssertions.map((assertion) => assertion.claim.role)).size !== parentAssertions.length) {
    issue(`${bundle.personId} repeats a selected parent role`);
  }
  validateTextBlock(bundle.personId, bundle.presentation?.summaryBlock, local);
  for (const block of bundle.presentation?.noteBlocks || []) validateTextBlock(bundle.personId, block, local);
  for (const assertion of bundle.assertions || []) validateAssertion(assertion, bundle.personId);
}

function validateVisibleTreeRecency() {
  let visualPersonIds;
  try {
    visualPersonIds = buildResearchProjections(store, { manifest }).tree.visualTree.nodes.map((node) => node.id);
  } catch (error) {
    issue(`could not project visible tree for recency validation: ${error.message}`);
    return;
  }
  for (const problem of validateTreeRecencyPolicy({
    people: store.people,
    visualPersonIds,
    baseline: treeRecencyBaseline
  })) issue(problem);
}

function validatePersonIdAliases() {
  const document = store.personIdAliases;
  if (document.schemaVersion !== 1 || !Array.isArray(document.aliases)) {
    issue("person ID aliases have unsupported schema");
    return;
  }
  const seen = new Set();
  for (const item of document.aliases) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.alias || "")) issue(`invalid person ID alias: ${item.alias || "(missing)"}`);
    if (seen.has(item.alias)) issue(`duplicate person ID alias: ${item.alias}`);
    seen.add(item.alias);
    if (people.has(item.alias)) issue(`person ID alias conflicts with a canonical person: ${item.alias}`);
    if (!people.has(item.canonicalPersonId)) issue(`person ID alias ${item.alias} has unknown canonical target ${item.canonicalPersonId}`);
    if (!String(item.reason || "").trim()) issue(`person ID alias ${item.alias} requires a reason`);
  }
}

function validatePlaceRows(bundle, local) {
  const rows = bundle.presentation?.placeRows;
  if (!Array.isArray(rows)) {
    issue(`${bundle.personId} requires presentation.placeRows`);
    return;
  }
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const label = `${bundle.personId} placeRows[${index}]`;
    for (const problem of validatePlaceRow(row, label)) issue(problem);
    const roles = new Set();
    for (const assertionId of row.assertionIds || []) {
      const assertion = local.get(assertionId);
      if (!assertion) {
        issue(`${label} references missing assertion ${assertionId}`);
      } else if (assertion.claim.kind !== "place-association") {
        issue(`${label} references non-place assertion ${assertionId}`);
      } else if (assertion.claim.personId !== bundle.personId) {
        issue(`${label} references another person's place assertion ${assertionId}`);
      } else if (assertion.assessment === "rejected") {
        issue(`${label} references rejected place assertion ${assertionId}`);
      } else {
        roles.add(assertion.claim.placeRole);
      }
    }
    if (roles.size !== 1) issue(`${label} must link place assertions with one shared role`);
    const role = [...roles][0];
    const key = placeRowKey(row, role);
    if (seen.has(key)) issue(`${bundle.personId} repeats displayed ${role || "unknown-role"} place ${formatPlaceRow(row)}`);
    seen.add(key);
  }
}

function validateDisplayedAncestorOriginFlags() {
  const selectedParentIds = new Set(store.people.flatMap((bundle) => {
    const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
    return (bundle.presentation?.treeParentAssertionIds || [])
      .map((id) => local.get(id))
      .filter((assertion) => assertion && assertion.assessment !== "rejected")
      .map((assertion) => assertion.claim.parentId);
  }));

  for (const bundle of store.people) {
    if (!selectedParentIds.has(bundle.personId) || !loadTreeConfig().viewer.requireFlags) continue;
    const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
    const displayedOrigin = (bundle.presentation?.detailAssertionIds || [])
      .map((id) => local.get(id))
      .find((assertion) => assertion?.assessment !== "rejected" && assertion?.claim?.kind === "ancestry-origin");
    const omission = bundle.presentation?.originFlagOmissionReason;
    if (!displayedOrigin && !(typeof omission === "string" && omission.trim())) {
      issue(`${bundle.personId} is a displayed direct ancestor with no ancestry-origin assertion or explicit originFlagOmissionReason (a reason passes here only while the person still inherits a flag; data:check rejects any flagless tree person)`);
    }
  }
}

function validateUnionBundle(bundle) {
  if (bundle.schemaVersion !== 1) issue(`${bundle.unionId} has unsupported union schema`);
  assertFileId(bundle, "unionId");
  if (!Array.isArray(bundle.personIds) || bundle.personIds.length !== 2
    || bundle.personIds.some((id) => !people.has(id))) {
    issue(`${bundle.unionId} must link two known people`);
  }
  const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
  validatePresentationRef(bundle.unionId, bundle.presentation?.unionAssertionId, local, "union");
  if (local.get(bundle.presentation?.unionAssertionId)?.claim.kind !== "union") {
    issue(`${bundle.unionId} presentation does not reference a union assertion`);
  }
  for (const id of bundle.presentation?.eventAssertionIds || []) {
    validatePresentationRef(bundle.unionId, id, local, "union event");
    if (local.get(id)?.claim.kind !== "event") issue(`${bundle.unionId} event ref ${id} is not an event`);
  }
  for (const assertion of bundle.assertions || []) validateAssertion(assertion, bundle.unionId);
}

function validateKinshipBundle(bundle) {
  if (bundle.schemaVersion !== 1) issue(`${bundle.kinshipId} has unsupported kinship schema`);
  assertFileId(bundle, "kinshipId");
  if (!Array.isArray(bundle.personIds) || bundle.personIds.length !== 2
    || bundle.personIds.some((id) => !people.has(id))) {
    issue(`${bundle.kinshipId} must link two known people`);
    return;
  }
  const sorted = [...bundle.personIds].sort();
  if (bundle.personIds.some((id, index) => id !== sorted[index])) {
    issue(`${bundle.kinshipId} personIds must use stable sorted order`);
  }
  const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
  validatePresentationRef(bundle.kinshipId, bundle.presentation?.siblingAssertionId, local, "sibling");
  const selected = local.get(bundle.presentation?.siblingAssertionId);
  if (selected?.claim.kind !== "sibling") {
    issue(`${bundle.kinshipId} presentation does not reference a sibling assertion`);
  } else if (!Array.isArray(selected.claim.personIds)
    || selected.claim.personIds.length !== 2
    || selected.claim.personIds.some((id, index) => id !== sorted[index])) {
    issue(`${bundle.kinshipId} sibling claim must repeat the sorted personIds`);
  }
  for (const assertion of bundle.assertions || []) validateAssertion(assertion, bundle.kinshipId);
}

function validateAssertion(assertion, ownerId) {
  if (!assertion?.id || typeof assertion.id !== "string") return issue(`${ownerId} contains an assertion without id`);
  if (!assessments.has(assertion.assessment)) issue(`${assertion.id} has invalid assessment`);
  if (!claimKinds.has(assertion.claim?.kind)) issue(`${assertion.id} has invalid claim kind`);
  if (assertion.claim?.kind === "place-association" && !placeRoles.has(assertion.claim.placeRole)) {
    issue(`${assertion.id} has invalid place role ${assertion.claim.placeRole || "(missing)"}`);
  }
  if (assertion.claim?.kind !== "place-association" && assertion.claim?.placeRole !== undefined) {
    issue(`${assertion.id} has placeRole on a non-place claim`);
  }
  if (!assertion.conclusion || typeof assertion.conclusion !== "string") issue(`${assertion.id} requires conclusion`);
  if (["candidate", "unresolved"].includes(assertion.assessment) && !assertion.limitations) {
    issue(`${assertion.id} requires limitations`);
  }
  if (!Array.isArray(assertion.evidence) || !assertion.evidence.length) issue(`${assertion.id} requires evidence`);
  for (const evidence of assertion.evidence || []) {
    if (!sources.has(evidence.sourceId)) issue(`${assertion.id} links missing source ${evidence.sourceId}`);
    if (!evidenceRoles.has(evidence.role)) issue(`${assertion.id} has invalid evidence role ${evidence.role}`);
    if (!evidence.rationale || typeof evidence.rationale !== "string") issue(`${assertion.id} evidence requires rationale`);
    for (const problem of validateEvidenceReview(assertion, evidence)) issue(problem);
    if (isLegacyAssertionEvidence(evidence)) {
      const key = evidenceReviewKey(assertion.id, evidence.sourceId);
      if (!baselineEvidenceReviews.has(key)) issue(`${key} adds new bootstrap review debt`);
      if (evidence.review?.status !== "migration-inferred") issue(`${key} lacks migration review provenance`);
    }
    const source = sources.get(evidence.sourceId);
    if (source?.kind === "search-audit" && !["negative", "context"].includes(evidence.role)) {
      issue(`${assertion.id} uses search audit ${source.id} as positive evidence`);
    }
  }
  if (assertion.assessment === "established"
    && !(assertion.evidence || []).some((evidence) => evidence.role === "direct" || evidence.role === "indirect")) {
    issue(`${assertion.id} is established without positive evidence`);
  }
  for (const questionId of assertion.questionIds || []) {
    if (!questions.has(questionId)) issue(`${assertion.id} links missing question ${questionId}`);
    else if (!(questions.get(questionId).assertionIds || []).includes(assertion.id)) {
      issue(`${assertion.id} links question ${questionId} without a reciprocal question assertion link`);
    }
  }
  if (assertion.claim?.kind === "parentage"
    && ["candidate", "unresolved"].includes(assertion.assessment)
    && !(assertion.questionIds || []).length) {
    issue(`${assertion.id} is non-established parentage without a canonical research question`);
  }
  for (const problem of validateLifeFact(assertion)) issue(problem);
  validateClaimPeople(assertion);
}

function validateClaimPeople(assertion) {
  const claim = assertion.claim || {};
  for (const id of [claim.personId, claim.childId, claim.parentId,
    claim.subjectType === "person" ? claim.subjectId : null, ...(claim.personIds || [])].filter(Boolean)) {
    if (!people.has(id)) issue(`${assertion.id} claim links missing person ${id}`);
  }
  if (claim.subjectType === "union" && !unions.has(claim.subjectId)) issue(`${assertion.id} links missing union ${claim.subjectId}`);
  if (claim.associatedPersonId && !people.has(claim.associatedPersonId)) {
    issue(`${assertion.id} links missing associated person ${claim.associatedPersonId}`);
  }
  if (claim.kind === "parentage" && claim.childId === claim.parentId) issue(`${assertion.id} is self-parentage`);
}

function validateSource(source) {
  if (source.schemaVersion !== 1) issue(`${source.id} has unsupported source schema`);
  assertFileId(source, "id");
  if (!sourceKinds.has(source.kind)) issue(`${source.id} has invalid source kind`);
  if (!artifactPurposes.has(source.artifactPurpose)) issue(`${source.id} has invalid artifact purpose`);
  if (Object.hasOwn(source, "evidenceRole")) issue(`${source.id} retains a global evidenceRole`);
  if (Object.hasOwn(source, "people")) issue(`${source.id} retains a duplicate people array`);
  for (const problem of validateSourceReview(source)) issue(problem);
  if (isLegacySourceReview(source)) {
    if (!baselineSourceReviews.has(source.id)) issue(`${source.id} adds new legacy source-person review debt`);
    if (source.personLinkReview?.status !== "migration-inferred") issue(`${source.id} lacks migration review provenance`);
  }
  const linked = new Set();
  for (const link of source.personLinks || []) {
    if (!people.has(link.personId)) issue(`${source.id} links missing person ${link.personId}`);
    if (linked.has(link.personId)) issue(`${source.id} repeats person ${link.personId}`);
    linked.add(link.personId);
    for (const problem of validateBiographicalReview(source, link, { assertions, targets })) issue(problem);
  }
  for (const personId of source.intendedPersonIds || []) {
    if (!people.has(personId)) issue(`${source.id} intends missing person ${personId}`);
  }
  if (source.recordId && !recordsById.has(source.recordId)) issue(`${source.id} links missing record ${source.recordId}`);
  if (source.recordId && source.scope === "planned-source") {
    issue(`${source.id} has manifest custody but remains planned-source`);
  }
  if (source.kind === "legacy-project-data" && source.includeInLegacyAtomProjection !== false) {
    issue(`${source.id} legacy provenance must stay out of source-atom compatibility output`);
  }
}

function validateCitation(citation) {
  if (citation.schemaVersion !== 1) issue(`${citation.id} has unsupported citation schema`);
  assertFileId(citation, "id");
  if (!Array.isArray(citation.assertionIds)) issue(`${citation.id} requires an assertionIds array`);
  if (citation.contextAssertionIds !== undefined && !Array.isArray(citation.contextAssertionIds)) {
    issue(`${citation.id} contextAssertionIds must be an array`);
  }
  const proofIds = citation.assertionIds || [];
  const contextIds = citation.contextAssertionIds || [];
  if (!proofIds.length && !contextIds.length) issue(`${citation.id} requires proof or context assertions`);
  if (new Set(proofIds).size !== proofIds.length) issue(`${citation.id} repeats a proof assertion`);
  if (new Set(contextIds).size !== contextIds.length) issue(`${citation.id} repeats a context assertion`);
  const contextSet = new Set(contextIds);
  for (const id of proofIds) {
    const assertion = assertions.get(id);
    if (!assertion) issue(`${citation.id} links missing assertion ${id}`);
    else if (!citationSupportsAssertion(citation, assertion)) {
      issue(`${citation.id} proof-links ${id} without a canonical evidence edge to one of its sources`);
    }
    if (contextSet.has(id)) issue(`${citation.id} links ${id} as both proof and context`);
  }
  for (const id of contextIds) if (!assertions.has(id)) issue(`${citation.id} context-links missing assertion ${id}`);
  if (contextIds.length && !citation.contextNote?.trim()) issue(`${citation.id} context assertions require contextNote`);
  if (!Array.isArray(citation.sourceIds) || !citation.sourceIds.length) issue(`${citation.id} requires sources`);
  for (const id of citation.sourceIds || []) if (!sources.has(id)) issue(`${citation.id} links missing source ${id}`);
  if ((!citation.presentation?.title && !citation.presentation?.titlePresentation)
    || !citation.presentation?.category) issue(`${citation.id} requires viewer presentation`);
}

function validateQuestion(question) {
  if (![1, 2].includes(question.schemaVersion)) issue(`${question.id} has unsupported question schema`);
  assertFileId(question, "id");
  if (question.__inlineAttempts !== undefined) {
    issue(`${question.id} embeds attempts instead of using evidence/research/attempts/${question.id}/`);
  }
  if (question.schemaVersion === 1) {
    if (!new Set(["open", "blocked", "answered", "exhausted", "superseded"]).has(question.status)) {
      issue(`${question.id} has invalid status`);
    }
  } else {
    if (!new Set(["active", "superseded"]).has(
      typeof question.lifecycle === "string" ? question.lifecycle : question.lifecycle?.state)) {
      issue(`${question.id} has invalid lifecycle`);
    }
    if (!questionConclusionStates.includes(question.conclusion?.state)) {
      issue(`${question.id} has invalid conclusion state`);
    }
    if (!routeAssessmentStates.has(question.routeAssessment?.state)) {
      issue(`${question.id} has invalid routeAssessment state`);
    }
    validateQuestionGoalKeys(question);
    for (const problem of validateQuestionSupersession(question, questions)) issue(problem);
  }
  if (!new Set(["P0", "P1", "P2", "P3"]).has(question.priority)) issue(`${question.id} has invalid priority`);
  validateResearchScope(question, question.id);
  for (const [index, event] of (question.reopenEvents || []).entries()) {
    const label = `${question.id} reopenEvents[${index}]`;
    if (event.type !== "reopened") issue(`${label} has unsupported type ${event.type}`);
    const validLegacyReopen = ["exhausted", "blocked"].includes(event.fromStatus);
    const validV2Reopen = event.fromRouteAssessment === "current-no-known-route";
    if (!validLegacyReopen && !validV2Reopen) {
      issue(`${label} records an unreopenable prior state ${event.fromStatus || event.fromRouteAssessment}`);
    }
    if (typeof event.reason !== "string" || !event.reason.trim()) issue(`${label} lacks a reason`);
    // The action binding is what distinguishes a real re-entry from a status
    // flip that drops the question straight back into generic triage.
    if (!(question.actions || []).some((action) => action.id === event.actionId)) {
      issue(`${label} names action ${event.actionId}, which does not exist on the question`);
    }
  }
  if (question.workstream && !researchWorkstreams.has(question.workstream)) {
    issue(`${question.id} has invalid workstream ${question.workstream}`);
  }
  if (question.workstream && (!Number.isInteger(question.queueOrder) || question.queueOrder < 1)) {
    issue(`${question.id} workstream requires a positive integer queueOrder`);
  }
  if (!question.workstream && Object.hasOwn(question, "queueOrder")) {
    issue(`${question.id} has queueOrder without a workstream`);
  }
  for (const id of question.personIds || []) {
    if (!people.has(id)) issue(`${question.id} links missing person ${id}`);
    else if (isDormantScope(researchScopeOf(people.get(id))) && researchScopeOf(question) !== researchScopeOf(people.get(id))) {
      issue(`${question.id} must use ${researchScopeOf(people.get(id))} scope because it names protected person ${id}`);
    }
  }
  for (const id of question.assertionIds || []) {
    if (!assertions.has(id)) issue(`${question.id} links missing assertion ${id}`);
    else if (!(assertions.get(id).questionIds || []).includes(question.id)) {
      issue(`${question.id} links assertion ${id} without a reciprocal assertion question link`);
    }
  }
  if (question.legacyQuestionIds !== undefined && !Array.isArray(question.legacyQuestionIds)) {
    issue(`${question.id} legacyQuestionIds must be an array`);
  }
  for (const id of question.legacyQuestionIds || []) {
    if (id === question.id) issue(`${question.id} cannot name itself as a legacy question`);
    else if (!questions.has(id)) issue(`${question.id} links missing legacy question ${id}`);
    else if (researchScopeOf(questions.get(id)) !== researchScopeOf(question)) {
      issue(`${question.id} scope disagrees with legacy question ${id}`);
    }
  }
  if (new Set(question.legacyQuestionIds || []).size !== (question.legacyQuestionIds || []).length) {
    issue(`${question.id} repeats a legacy question id`);
  }
  if (question.legacyAttemptIds !== undefined && !Array.isArray(question.legacyAttemptIds)) {
    issue(`${question.id} legacyAttemptIds must be an array`);
  }
  const legacyAttemptIds = question.legacyAttemptIds || [];
  if (legacyAttemptIds.some((id) => typeof id !== "string" || !id)) {
    issue(`${question.id} has an invalid legacy attempt id`);
  }
  if (new Set(legacyAttemptIds).size !== legacyAttemptIds.length) {
    issue(`${question.id} repeats a legacy attempt id`);
  }
  if ([...legacyAttemptIds].sort().some((id, index) => id !== legacyAttemptIds[index])) {
    issue(`${question.id} legacyAttemptIds must be sorted`);
  }
  if (legacyAttemptIds.length && !(question.legacyQuestionIds || []).length) {
    issue(`${question.id} has legacyAttemptIds without legacyQuestionIds`);
  }
  const allowedLegacyAttemptIds = new Set((question.legacyQuestionIds || [])
    .flatMap((id) => questions.get(id)?.attempts || []).map((attempt) => attempt.id));
  for (const id of legacyAttemptIds) {
    if (!allowedLegacyAttemptIds.has(id)) {
      issue(`${question.id} legacyAttemptIds links attempt ${id} outside its declared legacy questions`);
    }
  }
  if (question.schemaVersion === 2 && allowedLegacyAttemptIds.size && question.legacyAttemptIds === undefined) {
    issue(`${question.id} must pin inherited attempts with legacyAttemptIds`);
  }
  if (question.deferred !== undefined && typeof question.deferred !== "boolean") {
    issue(`${question.id} deferred must be boolean`);
  }
  if (question.deferred) {
    if (!question.dependsOnAssertionIds?.length) issue(`${question.id} deferred state requires dependsOnAssertionIds`);
    for (const id of question.dependsOnAssertionIds || []) {
      if (!assertions.has(id)) issue(`${question.id} depends on missing assertion ${id}`);
    }
  } else if (question.dependsOnAssertionIds?.length) {
    issue(`${question.id} has dependsOnAssertionIds without deferred state`);
  }
  validateQuestionFrontierPerson(question);
  const actionIds = new Set();
  for (const action of question.actions || []) {
    if (!action.id || actionIds.has(action.id)) issue(`${question.id} has invalid or duplicate action id`);
    actionIds.add(action.id);
    validateGate(action.gate, `${question.id}/${action.id} gate`);
    for (const problem of validateResearchAction(action, {
      questionId: question.id,
      questionStatus: question.schemaVersion === 1 ? question.status : undefined
    })) issue(problem);
    if (action.acquisitionTargetId && !targets.has(action.acquisitionTargetId)) {
      issue(`${question.id}/${action.id} links missing acquisition target ${action.acquisitionTargetId}`);
    } else if (action.acquisitionTargetId
      && researchScopeOf(targets.get(action.acquisitionTargetId)) !== researchScopeOf(question)) {
      issue(`${question.id}/${action.id} scope disagrees with acquisition target ${action.acquisitionTargetId}`);
    }
  }
  const fingerprints = new Map();
  const attemptsById = new Map();
  for (const attempt of question.attempts || []) {
    if (!attempt.id || !actionIds.has(attempt.actionId)) issue(`${question.id} has an attempt with invalid action`);
    if (attemptsById.has(attempt.id)) issue(`${question.id} repeats attempt id ${attempt.id}`);
    attemptsById.set(attempt.id, attempt);
    if (researchAttemptIds.has(attempt.id)) {
      issue(`${question.id} reuses attempt id ${attempt.id} from ${researchAttemptIds.get(attempt.id)}`);
    } else if (attempt.id) {
      researchAttemptIds.set(attempt.id, question.id);
    }
    if (!attempt.attemptedAt || !Number.isFinite(Date.parse(attempt.attemptedAt))) {
      issue(`${question.id}/${attempt.id || "(missing attempt id)"} has invalid attemptedAt`);
    }
    if (!isResearchAttemptOutcome(attempt.outcome)) {
      issue(`${question.id}/${attempt.id || "(missing attempt id)"} has invalid outcome ${attempt.outcome || "(missing)"}`);
    }
    if (!/^[0-9a-f]{64}$/.test(attempt.fingerprint || "")) {
      issue(`${question.id}/${attempt.id || "(missing attempt id)"} has invalid fingerprint`);
    } else {
      if (fingerprints.has(attempt.fingerprint)) issue(`${question.id} repeats fingerprint ${attempt.fingerprint}`);
      fingerprints.set(attempt.fingerprint, attempt.id);
    }
    if (attempt.outcome === "not-found-bounded" && !attempt.scope?.coverage) {
      issue(`${question.id}/${attempt.id} bounded negative requires coverage`);
    }
  }
  for (const action of question.actions || []) {
    if (!action.lastAttemptId) continue;
    const attempt = attemptsById.get(action.lastAttemptId);
    if (!attempt || attempt.actionId !== action.id) {
      issue(`${question.id}/${action.id} has invalid lastAttemptId ${action.lastAttemptId}`);
    } else if (action.lastAttemptAt !== attempt.attemptedAt) {
      issue(`${question.id}/${action.id} lastAttemptAt disagrees with ${action.lastAttemptId}`);
    }
  }
  if (question.schemaVersion === 1 && ["blocked", "exhausted"].includes(question.status) && !(question.reopenWhen || []).length) {
    issue(`${question.id} ${question.status} state requires reopenWhen`);
  }
  if (question.schemaVersion === 1 && question.status === "answered" && !question.conclusion?.assertionIds?.length) {
    issue(`${question.id} answered state requires conclusion assertions`);
  }
  if (question.schemaVersion === 2 && question.conclusion?.state === "established"
    && !question.conclusion?.assertionIds?.length) {
    issue(`${question.id} established conclusion requires assertionIds`);
  }
}

function validateQuestionFrontierPerson(question) {
  if (question.schemaVersion !== 2) return;
  const goalKeys = (question.goalKeys || []).map(normalizeGoalKey).filter(Boolean);
  const frontierKeys = goalKeys.filter((key) => /^(?:parent-slot|relationship-bridge):/.test(key));
  const lifecycle = typeof question.lifecycle === "string" ? question.lifecycle : question.lifecycle?.state;
  const conclusion = question.conclusion?.state;
  const requiresFrontierPerson = lifecycle === "active"
    && ["unresolved", "candidate", "conflicted"].includes(conclusion)
    && frontierKeys.length > 0;
  if (requiresFrontierPerson && !question.frontierPersonId) {
    issue(`${question.id} active frontier question requires frontierPersonId`);
    return;
  }
  if (!requiresFrontierPerson && question.frontierPersonId !== undefined) {
    issue(`${question.id} established or superseded question must omit frontierPersonId`);
    return;
  }
  if (!question.frontierPersonId) return;
  if (!people.has(question.frontierPersonId)) {
    issue(`${question.id} frontierPersonId links missing person ${question.frontierPersonId}`);
  }
  if (!(question.personIds || []).includes(question.frontierPersonId)) {
    issue(`${question.id} frontierPersonId must also appear in personIds`);
  }
  for (const key of frontierKeys) {
    const parentSlot = /^parent-slot:([^:]+):(father|mother)$/.exec(key);
    if (parentSlot && parentSlot[1] !== question.frontierPersonId) {
      issue(`${question.id} parent-slot ${key} disagrees with frontierPersonId ${question.frontierPersonId}`);
    }
    const bridge = /^relationship-bridge:(.+)$/.exec(key);
    if (!bridge) continue;
    const assertion = assertions.get(bridge[1]);
    const childId = assertion?.claim?.childId || (bridge[1].includes(":") ? bridge[1].split(":")[0] : null);
    if (childId && childId !== question.frontierPersonId) {
      issue(`${question.id} relationship bridge ${key} has child ${childId}, not frontierPersonId ${question.frontierPersonId}`);
    }
  }
}

function validateQuestionGoalKeys(question) {
  if (!Array.isArray(question.goalKeys)) return issue(`${question.id} requires a goalKeys array`);
  const normalized = question.goalKeys.map(normalizeGoalKey);
  if (normalized.some((key) => !key)) issue(`${question.id} has an invalid goal key`);
  if (new Set(normalized).size !== normalized.length) issue(`${question.id} repeats a goal key`);
  for (const key of normalized.filter(Boolean)) {
    const parent = /^parent-slot:([^:]+):(father|mother)$/.exec(key);
    const bridge = /^relationship-bridge:(.+)$/.exec(key);
    if (parent && !people.has(parent[1])) issue(`${question.id} goal key links missing person ${parent[1]}`);
    if (bridge && !assertions.has(bridge[1]) && !bridge[1].includes(":")) {
      issue(`${question.id} goal key links missing assertion ${bridge[1]}`);
    }
  }
}

function validateWorkstreams() {
  for (const workstream of researchWorkstreams) {
    const queueOrders = new Map();
    for (const question of store.questions.filter((item) => item.workstream === workstream)) {
      if (queueOrders.has(question.queueOrder)) {
        issue(`${question.id} duplicates ${workstream} queueOrder ${question.queueOrder} from ${queueOrders.get(question.queueOrder)}`);
      }
      queueOrders.set(question.queueOrder, question.id);
    }
  }
}

function validateResearchSchedulers() {
  for (const scope of researchScopes) {
    const file = researchSchedulerFile(projectRoot, scope);
    if (!fs.existsSync(file)) {
      issue(`missing canonical research scheduler for ${scope}`);
      continue;
    }
    for (const problem of validateResearchSchedulerRecord(readJson(file), { scope })) issue(problem);
  }
}

function validateTarget(target) {
  for (const problem of validateTargetResearchRole(target)) issue(problem);
  for (const problem of acquisitionTargetAuthorityIssues(target)) issue(problem);
  assertFileId(target, "id");
  validateResearchScope(target, target.id);
  if (target.contactRequest) issue(`${target.id} retains legacy contactRequest state; migrate it to evidence/acquisition/requests`);
  if (!sources.has(target.sourceId)) issue(`${target.id} links missing source ${target.sourceId}`);
  if (targetsBySourceId.has(target.sourceId)) {
    issue(`${target.id} duplicates source ownership from ${targetsBySourceId.get(target.sourceId)}`);
  } else {
    targetsBySourceId.set(target.sourceId, target.id);
  }
  for (const id of target.questionIds || []) {
    if (!questions.has(id)) issue(`${target.id} links missing question ${id}`);
    else if (researchScopeOf(questions.get(id)) !== researchScopeOf(target)) {
      issue(`${target.id} scope disagrees with question ${id}`);
    }
  }
  validateGate(target.gate, `${target.id} gate`);
  validateGate(target.reconciliation?.gate, `${target.id} reconciliation gate`);
  for (const [index, gate] of (target.gates || []).entries()) validateGate(gate, `${target.id} gates[${index}]`);
  if (target.satisfaction) {
    if (target.satisfaction.kind !== "equivalent-record") issue(`${target.id} has invalid satisfaction kind`);
    if (!new Set(["same-record-other-provider", "same-document-other-route", "complete-multipart-document"])
      .has(target.satisfaction.basis)) issue(`${target.id} has invalid satisfaction basis`);
    if (!target.satisfaction.recordIds?.length) issue(`${target.id} satisfaction requires record ids`);
    for (const id of target.satisfaction.recordIds || []) if (!recordsById.has(id)) issue(`${target.id} satisfaction misses ${id}`);
    if (target.satisfaction.partial === true) issue(`${target.id} cannot be partially satisfied`);
  }
  if (target.supersession) {
    const recordIds = target.supersession.recordIds || [];
    const targetIds = target.supersession.targetIds || [];
    if (Boolean(recordIds.length) === Boolean(targetIds.length)) {
      issue(`${target.id} supersession requires exactly one of recordIds or targetIds`);
    }
    if (!target.supersession.reason || typeof target.supersession.reason !== "string") {
      issue(`${target.id} supersession requires a reason`);
    }
    for (const id of recordIds) if (!recordsById.has(id)) issue(`${target.id} supersession misses record ${id}`);
    for (const id of targetIds) {
      if (id === target.id) issue(`${target.id} cannot supersede itself`);
      else if (!targets.has(id)) issue(`${target.id} supersession misses target ${id}`);
      else if (researchScopeOf(targets.get(id)) !== researchScopeOf(target)) {
        issue(`${target.id} supersession scope disagrees with target ${id}`);
      }
    }
  }
  const attemptFingerprints = new Set();
  for (const route of target.routes || []) {
    for (const problem of validateRouteAccessEntitlement(route, {
      target,
      requests: externalRequests
    })) issue(problem);
    validateGate(route.gate, `${target.id}/${route.id || "(missing)"} gate`);
    for (const [index, gate] of (route.gates || []).entries()) {
      validateGate(gate, `${target.id}/${route.id || "(missing)"} gates[${index}]`);
    }
    if (!route.id || !acquisitionRouteStatuses.has(route.status)) issue(`${target.id} has invalid route ${route.id || "(missing)"}`);
    if (route.targetId !== target.id) issue(`${target.id}/${route.id || "(missing)"} has stale targetId ${route.targetId || "(missing)"}`);
    if (route.id) {
      const owner = routeOwners.get(route.id);
      if (owner) issue(`${target.id}/${route.id} duplicates globally unique route id owned by ${owner}`);
      else routeOwners.set(route.id, target.id);
    }
    if (route.requestId) {
      const request = externalRequests.get(route.requestId);
      if (!request) issue(`${target.id}/${route.id} links missing external request ${route.requestId}`);
      else {
        if (!request.items?.some((item) => item.targetId === target.id && item.routeId === route.id)) {
          issue(`${target.id}/${route.id} is not listed by external request ${route.requestId}`);
        }
        const item = request.items?.find((candidate) => candidate.targetId === target.id && candidate.routeId === route.id);
        const projectedRoute = structuredClone(route);
        const derived = projectExternalRequestOntoRoute(projectedRoute, request);
        if (route.authorization) issue(`${target.id}/${route.id} duplicates canonical request authorization`);
        if (route.confirmationPhrase !== request.guard.requiredPhrase) issue(`${target.id}/${route.id} has a stale request guard projection`);
        if (route.status !== projectedRoute.status) issue(`${target.id}/${route.id} has stale request status projection`);
        if (route.requestProjection?.operationalState !== derived.operationalState
            || route.requestProjection?.revision !== request.revision) {
          issue(`${target.id}/${route.id} has stale request metadata projection`);
        }
      }
    }
    // A reference that names another repository's own collection identifier is
    // a holding claim about that repository. Asking a different institution to
    // pull it wastes a real person's time on a reel they do not have, so an
    // outbound route must record item-level proof that its provider holds the
    // cited item before it can be sent.
    if (foreignHoldingClaims(target, route).length) {
      issue(`${target.id}/${route.id} cites another repository's holding without item-level holdingVerification for ${route.provider}`);
    }
    // A SUBMIT or PAY gate is an instruction to contact a real institution, so
    // it may not be offered before both halves of the request are verified.
    if (authorizationGateStatuses.has(route.status)) {
      for (const problem of outboundVerificationIssues(target, route, externalRequests.get(route.requestId))) {
        issue(`${target.id}/${route.id} cannot offer an authorization gate: ${problem}`);
      }
    }
    const submitTargetId = route.authorizationTargetId || target.id;
    if (route.authorizationTargetId && !/^[a-z0-9][a-z0-9-]*$/.test(route.authorizationTargetId)) {
      issue(`${target.id}/${route.id} has an invalid grouped submission id`);
    }
    if (route.status === "needs-submit-confirmation"
        && route.confirmationPhrase !== `SUBMIT ${submitTargetId}`) {
      issue(`${target.id}/${route.id} submission confirmation must be exactly SUBMIT ${submitTargetId}`);
    }
    if (route.status === "needs-purchase-confirmation") {
      if (route.confirmationPhrase !== `PAY ${target.id}`) {
        issue(`${target.id}/${route.id} purchase confirmation must be exactly PAY ${target.id}`);
      }
      if (!validEstimatedCost(route)) {
        issue(`${target.id}/${route.id} purchase confirmation requires a positive estimated cost and supported currency`);
      }
    }
    if (route.authorization) {
      if (route.authorization.status !== "authorized") {
        issue(`${target.id}/${route.id} has an invalid authorization status`);
      }
      const phrase = route.authorization.confirmationPhrase;
      const isPurchase = phrase === `PAY ${target.id}`;
      const isNoChargeSubmit = phrase === `SUBMIT ${submitTargetId}`;
      if (!isPurchase && !isNoChargeSubmit) {
        issue(`${target.id}/${route.id} authorization must retain exact PAY or SUBMIT provenance`);
      }
      if (!Number.isFinite(Date.parse(route.authorization.confirmedAt))) {
        issue(`${target.id}/${route.id} authorization requires a valid confirmedAt timestamp`);
      }
      if (isPurchase && !validEstimatedCost(route)) {
        issue(`${target.id}/${route.id} authorized purchase must retain its estimated cost guard`);
      }
      if (isNoChargeSubmit && route.confirmationPhrase !== `SUBMIT ${submitTargetId}`) {
        issue(`${target.id}/${route.id} authorized no-charge request must retain exact SUBMIT ${submitTargetId} route provenance`);
      }
    }
    if (route.status === "needs-semantic-reconciliation" && !(route.candidateUrls || []).length) {
      issue(`${target.id}/${route.id} requires result review but has no candidates`);
    }
    if (route.status === "search-no-candidates" && (route.candidateUrls || []).length) {
      issue(`${target.id}/${route.id} is zero-result but has candidates`);
    }
    if (route.status === "duplicate" && !route.duplicateOf && !target.satisfaction && !target.disposition) {
      issue(`${target.id}/${route.id} duplicate has no referent or terminal disposition`);
    }
    for (const attempt of route.attempts || []) {
      if (!/^attempt-[a-z0-9][a-z0-9-]{7,79}$/.test(attempt.id || "")) {
        issue(`${target.id}/${route.id} has an acquisition attempt with invalid id ${attempt.id || "(missing)"}`);
      } else if (acquisitionAttemptIds.has(attempt.id)) {
        issue(`${target.id}/${route.id} reuses acquisition attempt id ${attempt.id} from ${acquisitionAttemptIds.get(attempt.id)}`);
      } else {
        acquisitionAttemptIds.set(attempt.id, `${target.id}/${route.id}`);
      }
      if (!/^[0-9a-f]{64}$/.test(attempt.fingerprint || "")) {
        issue(`${target.id}/${route.id}/${attempt.id || "(missing)"} has invalid acquisition attempt fingerprint`);
      } else {
        if (attemptFingerprints.has(attempt.fingerprint)) issue(`${target.id} repeats acquisition attempt fingerprint ${attempt.fingerprint}`);
        attemptFingerprints.add(attempt.fingerprint);
      }
      if (attempt.outcome === "not-found-bounded" && !attempt.scope?.coverage) {
        issue(`${target.id}/${route.id} bounded negative lacks coverage`);
      }
    }
  }
  try {
    const result = reconcileAcquisitionTarget(target, { recordsById, recordsBySourceId, sourcesById: sources });
    if (result.status === "needs-result-review"
      && !(target.routes || []).some((route) => (route.candidateUrls || []).length)) {
      issue(`${target.id} reconciles to result review without candidates`);
    }
    if (target.satisfaction && result.status !== "satisfied-by-equivalent-route"
      && !["published", "preserved-withheld"].includes(result.status)) {
      issue(`${target.id} satisfaction did not win reconciliation`);
    }
  } catch (error) {
    issue(error.message);
  }
}

function validateGate(gate, label) {
  if (gate === undefined) return;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return issue(`${label} must be an object`);
  if (!gateActors.has(gate.actor)) issue(`${label} has invalid actor ${gate.actor || "(missing)"}`);
  if (!gateStates.has(gate.state)) issue(`${label} has invalid state ${gate.state || "(missing)"}`);
  if (typeof gate.type !== "string" || !gate.type.trim()) issue(`${label} requires a type`);
  if (gate.actor === "user" && gate.state === "active"
    && (typeof gate.resumeToken !== "string" || !gate.resumeToken.trim())) {
    issue(`${label} active user gate requires an exact resumeToken`);
  }
  if (gate.actor === "external" && gate.state === "active"
    && !String(gate.resumeToken || "").startsWith("RECEIVED ")) {
    issue(`${label} active external gate resumeToken must start with RECEIVED`);
  }
  if (/purchase|payment/.test(gate.type || "") && gate.actor === "user"
    && !/^(?:PAY|PAYMENT READY) /.test(gate.resumeToken || "")) {
    issue(`${label} payment gate requires an exact PAY or PAYMENT READY token`);
  }
}

function validateSourceTargetCoverage() {
  for (const source of store.sources) {
    if (documentarySourceRequiresAcquisitionTarget(source) && !targetsBySourceId.has(source.id)) {
      issue(`${source.id} is a preservable documentary source without an acquisition target; classify it citation-only or add a target`);
    }
  }
}

function validateRequest(request) {
  assertFileId(request, "id");
  for (const problem of validateExternalRequest(request)) issue(`${request.id}: ${problem}`);
  for (const item of request.items || []) {
    const target = targets.get(item.targetId);
    const route = target?.routes?.find((candidate) => candidate.id === item.routeId);
    if (!target) issue(`${request.id} links missing target ${item.targetId}`);
    else if (!route) issue(`${request.id} links missing route ${item.targetId}/${item.routeId}`);
    else if (route.requestId && route.requestId !== request.id) {
      issue(`${request.id} conflicts with ${route.requestId} on ${item.targetId}/${item.routeId}`);
    }
  }
}

function validEstimatedCost(route) {
  if (Number.isFinite(route.estimatedCostGbp) && route.estimatedCostGbp > 0) return true;
  return Number.isFinite(route.estimatedCost?.amount)
    && route.estimatedCost.amount > 0
    && new Set(["GBP", "USD", "EUR"]).has(route.estimatedCost.currency);
}

function validateBranches() {
  if (store.branches.schemaVersion !== 1 || !Array.isArray(store.branches.branches)) {
    return issue("research branch registry is invalid");
  }
  const ids = new Set();
  for (const branch of store.branches.branches) {
    if (!branch.id || ids.has(branch.id)) issue(`invalid or duplicate branch: ${branch.id}`);
    ids.add(branch.id);
    if (!fs.existsSync(path.join(projectRoot, branch.currentStateFile || ""))) {
      issue(`${branch.id} current-state file is missing`);
    }
  }
  for (const question of store.questions) if (!ids.has(question.branchId)) issue(`${question.id} links missing branch ${question.branchId}`);
}

function validateIdentityEvidenceConsistency() {
  const confirmedDocumentaryLinks = new Map();
  for (const source of store.sources) {
    if (["search-audit", "legacy-project-data"].includes(source.kind)
      || !source.personLinksVerifiedAt || !source.personLinksVerificationBasis) continue;
    for (const link of source.personLinks || []) {
      if (link.identificationStatus !== "confirmed") continue;
      const ids = confirmedDocumentaryLinks.get(link.personId) || [];
      ids.push(source.id);
      confirmedDocumentaryLinks.set(link.personId, ids);
    }
  }
  for (const bundle of store.people) {
    const identity = (bundle.assertions || []).find((assertion) => assertion.claim?.kind === "person-identity");
    const sourceIds = confirmedDocumentaryLinks.get(bundle.personId) || [];
    if (identity && identity.assessment !== "established" && sourceIds.length) {
      issue(`${identity.id} is ${identity.assessment} despite confirmed verified source link(s): ${sourceIds.join(", ")}`);
    }
  }
}

function supportClass(assertion) {
  if ((assertion.evidence || []).some((evidence) => evidence.role === "contradicts")) return "conflicted";
  const linked = (assertion.evidence || []).map((evidence) => sources.get(evidence.sourceId)).filter(Boolean);
  if (linked.some((source) => source.kind === "documentary")) return "documented";
  if (linked.some((source) => source.kind === "family-statement")) return "family-information";
  return "legacy-unsourced";
}

function validatePresentationRef(ownerId, id, local, label) {
  if (!id || !local.has(id)) issue(`${ownerId} has invalid ${label} assertion ref: ${id || "(missing)"}`);
  if (local.get(id)?.assessment === "rejected") issue(`${ownerId} presents rejected assertion ${id}`);
}

function validateTextBlock(ownerId, block, local) {
  if (block == null) return;
  if (!block.text || !Array.isArray(block.assertionIds) || !block.assertionIds.length) {
    return issue(`${ownerId} has an invalid presentation text block`);
  }
  for (const id of block.assertionIds) validatePresentationRef(ownerId, id, local, "text block");
}

function validateResearchScope(value, label) {
  if (!researchScopes.includes(researchScopeOf(value))) {
    issue(`${label} has invalid researchScope ${String(value?.researchScope)}`);
  }
}

function assertFileId(value, idField) {
  if (!value.__file) return;
  const basename = path.basename(value.__file, ".json");
  if (basename !== value[idField]) issue(`${path.relative(projectRoot, value.__file)} does not match ${idField} ${value[idField]}`);
}

function issue(message) {
  issues.push(message);
}
