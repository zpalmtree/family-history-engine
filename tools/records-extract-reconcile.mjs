#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";
import {
  extractionReviewFile,
  loadExtractionStore,
  normalizeSecondReview,
  validateExtractionReview
} from "./extraction-store.mjs";
import { assertionMap, readJson } from "./research-store.mjs";

const args = process.argv.slice(2);
const recordId = value("--record");
const inputFile = value("--input");
const dryRun = args.includes("--dry-run");
if (!recordId || !inputFile) usage();
const store = loadExtractionStore();
const campaignRecord = store.campaign.records.find((record) => record.recordId === recordId);
if (!campaignRecord) usage(`record is outside active campaign: ${recordId}`);
const target = extractionReviewFile(store.root, recordId, campaignRecord.sha256);
if (!fs.existsSync(target)) usage(`current hash has no primary review: ${recordId}`);
const payload = readJson(path.resolve(inputFile));
const allowed = new Set(["claimEffects", "questionEffects", "reconciliation"]);
const unexpected = Object.keys(payload).filter((field) => !allowed.has(field));
if (unexpected.length) usage(`reconciliation patch has unsupported fields: ${unexpected.join(", ")}`);

try {
  withFileLockSync(target, () => {
    const current = readJson(target);
    let review = { ...current, ...payload };
    review = normalizeSecondReview(review, {
      campaignRecord,
      assertions: assertionMap(store.researchStore)
    });
    const issues = validateExtractionReview(review, {
      campaign: store.campaign,
      campaignRecord,
      manifestRecord: store.manifest.records.find((record) => record.id === recordId),
      packetById: new Map(store.packets.map((packet) => [packet.id, packet])),
      researchStore: store.researchStore
    });
    if (issues.length) throw new Error(issues.join("\n- "));
    if (dryRun) console.log(JSON.stringify(review, null, 2));
    else writeJsonAtomic(target, review);
  });
} catch (error) {
  console.error(`extraction reconciliation refused:\n- ${error.message}`);
  process.exit(1);
}
if (!dryRun) console.log(`reconciled extraction review for ${recordId}: ${payload.reconciliation?.status || "updated"}`);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node tools/records-extract-reconcile.mjs --record <id> --input <reconciliation-patch.json> [--dry-run]");
  process.exit(2);
}
