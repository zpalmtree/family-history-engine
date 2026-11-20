#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";
import {
  extractionChecklistFields,
  extractionReviewFile,
  extractionReviewId,
  loadExtractionStore,
  normalizeSecondReview,
  requiredSecondReviewReasons,
  validateExtractionReview
} from "./extraction-store.mjs";
import { assertionMap, readJson } from "./research-store.mjs";
import { isDormantScope } from "./research-scope.mjs";

const args = process.argv.slice(2);
const inputFile = value("--input");
const recordId = value("--record");
const secondReviewFile = value("--second-review");
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const template = args.includes("--template");
const store = loadExtractionStore();
const campaignById = new Map(store.campaign.records.map((record) => [record.recordId, record]));
const manifestById = new Map(store.manifest.records.map((record) => [record.id, record]));
const packetById = new Map(store.packets.map((packet) => [packet.id, packet]));

if (template) {
  if (!recordId || inputFile || secondReviewFile) usage("--template requires only --record <id>");
  const campaignRecord = campaignById.get(recordId);
  if (!campaignRecord) usage(`record is outside active campaign: ${recordId}`);
  console.log(JSON.stringify(reviewTemplate(store.campaign.id, campaignRecord), null, 2));
  process.exit(0);
}

if (secondReviewFile) {
  if (!recordId || inputFile) usage("--second-review requires --record and cannot be combined with --input");
  updateSecondReview(recordId, secondReviewFile);
  process.exit(0);
}

if (!inputFile || recordId) usage("primary review requires --input <review.json>");
const supplied = readJson(path.resolve(inputFile));
const campaignRecord = campaignById.get(supplied.recordId);
if (!campaignRecord) usage(`record is outside active campaign: ${supplied.recordId}`);
let review = {
  ...supplied,
  schemaVersion: 1,
  id: extractionReviewId(campaignRecord.recordId, campaignRecord.sha256),
  campaignId: store.campaign.id,
  recordId: campaignRecord.recordId,
  sha256: campaignRecord.sha256,
  sourceId: campaignRecord.sourceId,
  researchScope: campaignRecord.researchScope,
  state: "current",
  method: isDormantScope(campaignRecord.researchScope) ? "scope-disposition" : "original-visual"
};
if (!review.secondReview) {
  review = normalizeSecondReview(review, {
    campaignRecord,
    assertions: assertionMap(store.researchStore)
  });
}
const issues = validate(review, campaignRecord);
if (issues.length) refuse(issues);
const target = extractionReviewFile(store.root, review.recordId, review.sha256);
if (dryRun) {
  console.log(JSON.stringify(review, null, 2));
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
try {
  withFileLockSync(target, () => {
    if (fs.existsSync(target) && !replace) throw new Error(`review already exists; use --replace only for an intentional correction: ${review.id}`);
    writeJsonAtomic(target, review);
  });
} catch (error) {
  refuse([error.message]);
}
console.log(`recorded extraction review ${review.id}`);
console.log(`state: ${review.reconciliation.status}; second review: ${review.secondReview.status}`);

function updateSecondReview(requestedRecordId, file) {
  const campaignRecord = campaignById.get(requestedRecordId);
  if (!campaignRecord) usage(`record is outside active campaign: ${requestedRecordId}`);
  const target = extractionReviewFile(store.root, requestedRecordId, campaignRecord.sha256);
  if (!fs.existsSync(target)) usage(`current hash has no primary review: ${requestedRecordId}`);
  const payload = readJson(path.resolve(file));
  try {
    withFileLockSync(target, () => {
      const current = readJson(target);
      const reasons = requiredSecondReviewReasons(current, {
        campaignRecord,
        assertions: assertionMap(store.researchStore)
      });
      const review = {
        ...current,
        secondReview: { ...payload, requiredReasons: reasons }
      };
      const issues = validate(review, campaignRecord);
      if (issues.length) throw new Error(issues.join("\n- "));
      if (!dryRun) writeJsonAtomic(target, review);
      else console.log(JSON.stringify(review, null, 2));
    });
  } catch (error) {
    refuse([error.message]);
  }
  if (!dryRun) console.log(`recorded independent ${payload.status} review for ${requestedRecordId}`);
}

function validate(review, campaignRecord) {
  return validateExtractionReview(review, {
    campaign: store.campaign,
    campaignRecord,
    manifestRecord: manifestById.get(review.recordId),
    packetById,
    researchStore: store.researchStore
  });
}

function reviewTemplate(campaignId, record) {
  return {
    schemaVersion: 1,
    id: extractionReviewId(record.recordId, record.sha256),
    campaignId,
    recordId: record.recordId,
    sha256: record.sha256,
    sourceId: record.sourceId,
    researchScope: record.researchScope,
    state: "current",
    method: isDormantScope(record.researchScope) ? "scope-disposition" : "original-visual",
    reviewedAt: "REPLACE_WITH_ISO_TIMESTAMP",
    reviewerId: "REPLACE_WITH_STABLE_REVIEWER_ID",
    outcome: isDormantScope(record.researchScope) ? "deferred-dormant-scope" : "REPLACE_WITH_OUTCOME",
    checklist: isDormantScope(record.researchScope)
      ? {}
      : Object.fromEntries(extractionChecklistFields.map((field) => [field, false])),
    ...(isDormantScope(record.researchScope) ? {} : {
      pageCoverage: { pageCount: 1, reviewedRanges: [{ from: 1, to: 1 }], basis: "REPLACE_WITH_PAGE_COUNT_BASIS" }
    }),
    readings: [],
    participants: [],
    personLinkChanges: [],
    claimEffects: [],
    questionEffects: [],
    riskFlags: [],
    reconciliation: { status: "pending" }
  };
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function refuse(issues) {
  console.error(`extraction review refused:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: --template --record <id> | --input <review.json> [--replace] [--dry-run] | --record <id> --second-review <json> [--dry-run]");
  process.exit(2);
}
