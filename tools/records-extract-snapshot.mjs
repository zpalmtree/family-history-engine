#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-json.mjs";
import {
  buildExtractionCampaign,
  extractionPaths,
  loadExtractionStore,
  validateCampaign
} from "./extraction-store.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
const capturedAt = value("--captured-at") || new Date().toISOString().slice(0, 10);
const campaignId = value("--campaign") || "master-reread-2026-07-28";
if (write && check) usage("choose --write or --check");

const paths = extractionPaths(projectRoot);
const manifest = readJson(paths.manifest);
const researchStore = loadResearchStore();
const existing = fs.existsSync(paths.store) ? loadExtractionStore({ researchStore }) : undefined;
const campaign = buildExtractionCampaign({
  manifest,
  researchStore,
  campaignId,
  capturedAt,
  existingCampaign: existing?.campaign?.id === campaignId ? existing.campaign : undefined
});

if (check) {
  if (!existing) usage("no extraction campaign exists; run with --write once");
  const issues = validateCampaign(existing.campaign, manifest);
  if (JSON.stringify(existing.campaign.records) !== JSON.stringify(campaign.records)) {
    issues.push("campaign record scope/hash/QA projection is stale");
  }
  if (issues.length) {
    console.error(`extraction campaign snapshot check failed:\n- ${issues.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`extraction campaign snapshot ok: ${existing.campaign.records.length} current records`);
  process.exit(0);
}

if (!write) {
  console.log(JSON.stringify(campaign, null, 2));
  process.exit(0);
}

fs.mkdirSync(paths.campaigns, { recursive: true });
fs.mkdirSync(paths.packets, { recursive: true });
fs.mkdirSync(paths.reviews, { recursive: true });
const campaignFile = path.join(paths.campaigns, `${campaign.id}.json`);
writeJsonAtomic(campaignFile, campaign);
writeJsonAtomic(paths.store, {
  schemaVersion: 1,
  activeCampaignId: campaign.id,
  activeCampaignFile: `campaigns/${campaign.id}.json`
});
console.log(`wrote extraction campaign ${campaign.id}: ${campaign.records.length} current records`);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node tools/records-extract-snapshot.mjs [--write|--check] [--campaign <id>] [--captured-at YYYY-MM-DD]");
  process.exit(2);
}
