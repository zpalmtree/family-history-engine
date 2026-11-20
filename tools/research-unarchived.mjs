#!/usr/bin/env node

// Lists research attempts that cite original-record locators with no archived
// source master or acquisition target, and lane findings files that cite image
// locators with none (see unarchived-reads.mjs).
// Usage: npm run research:unarchived -- [--since YYYY-MM-DD] [--json] [--question <id>]
// --question narrows the attempts and leaves the findings files out.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageCorpus, loadDismissals, scanFindingsFiles, scanUnarchivedReads } from "./unarchived-reads.mjs";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const since = value("--since") || "2026-10-01";
const question = value("--question");
const corpus = coverageCorpus(root);
const dismissals = loadDismissals(root);
const findings = scanUnarchivedReads(root, { since, corpus, dismissals })
  .filter((finding) => !question || finding.questionId === question);
const findingsFiles = question ? [] : scanFindingsFiles(root, { corpus, dismissals });

if (args.includes("--json")) {
  console.log(JSON.stringify({ since, attempts: findings.length, findings, findingsFiles }, null, 2));
} else {
  const locators = new Set(findings.flatMap((finding) => finding.locators));
  console.log(`UNARCHIVED READS since ${since}: ${findings.length} attempts cite ${locators.size} unarchived locators`);
  for (const finding of findings) {
    const shown = finding.locators.slice(0, 8).join(" ");
    const more = finding.locators.length > 8 ? ` (+${finding.locators.length - 8})` : "";
    console.log(`${String(finding.attemptedAt).slice(0, 10)} ${finding.questionId} ${finding.attemptId}: ${shown}${more}`);
  }
  if (!question) {
    const laneLocators = new Set(findingsFiles.flatMap((entry) => entry.locators));
    console.log(`UNARCHIVED LANE READS: ${findingsFiles.length} findings files cite ${laneLocators.size} unarchived image locators`);
    for (const entry of findingsFiles) {
      const shown = entry.locators.slice(0, 8).join(" ");
      const more = entry.locators.length > 8 ? ` (+${entry.locators.length - 8})` : "";
      console.log(`${entry.file}: ${shown}${more}`);
    }
  }
}
