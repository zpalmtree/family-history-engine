#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { withFileLockSync, writeJsonAtomic } from "./atomic-json.mjs";
import {
  extractionPacketFile,
  loadExtractionStore,
  validateExtractionPacket
} from "./extraction-store.mjs";
import { readJson } from "./research-store.mjs";

const args = process.argv.slice(2);
const inputFile = value("--input");
const replace = args.includes("--replace");
const dryRun = args.includes("--dry-run");
if (!inputFile) usage();
const store = loadExtractionStore();
const packet = readJson(path.resolve(inputFile));
const campaignById = new Map(store.campaign.records.map((record) => [record.recordId, record]));
const issues = validateExtractionPacket(packet, { campaign: store.campaign, campaignById });
const owned = new Map();
for (const current of store.packets.filter((item) => item.state !== "retired" && item.id !== packet.id)) {
  for (const member of current.records || []) owned.set(member.recordId, current.id);
}
for (const member of packet.records || []) {
  if (owned.has(member.recordId)) issues.push(`record ${member.recordId} already belongs to active packet ${owned.get(member.recordId)}`);
}
if (issues.length) {
  console.error(`extraction packet refused:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
const target = extractionPacketFile(store.root, packet.id);
if (dryRun) {
  console.log(JSON.stringify(packet, null, 2));
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
try {
  withFileLockSync(target, () => {
    if (fs.existsSync(target) && !replace) throw new Error(`packet already exists: ${packet.id}`);
    writeJsonAtomic(target, packet);
  });
} catch (error) {
  console.error(`extraction packet refused:\n- ${error.message}`);
  process.exit(1);
}
console.log(`recorded extraction packet ${packet.id}: ${packet.records.length} current-hash record(s)`);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node tools/records-extract-packet.mjs --input <packet.json> [--replace] [--dry-run]");
  process.exit(2);
}
