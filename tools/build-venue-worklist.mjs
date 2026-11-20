#!/usr/bin/env node

// A printable worklist for one unblock venue.
//
//   npm run research:worklist -- --venue familysearch-center-visit
//   npm run research:worklist                      # list the venues
//   npm run research:worklist -- --venue <id> --json
//
// This is a read-only projection over the same canonical acquisition targets
// that `research:status --needs-user` groups, sharing its venue rules through
// needs-user.mjs. It is never a second queue: nothing here is stored, and the
// next run re-derives everything.
//
// The status rollup already answers "which venue clears the most items". What
// it cannot do is go to the venue with you -- so this adds the per-item
// reference, what to capture, and the exact token to reply with afterwards.
//
// Contact details, account state, and payment data are deliberately excluded:
// this artifact is meant to be printed and carried into a public reading room.

import path from "node:path";

import { buildNeedsUserResult, priorityRank } from "./needs-user.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const venueId = valueAfter("--venue");
const asJson = args.includes("--json");

const store = loadResearchStore();
const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
const projections = buildResearchProjections(store, { manifest });
const targets = projections.acquisitionSession.targets;
const targetById = new Map(targets.map((target) => [target.id, target]));
const needsUser = buildNeedsUserResult(store.questions, targets);

const actionable = needsUser.items.filter((item) => item.kind === "needs-user");

if (!venueId) {
  const venues = new Map();
  for (const item of actionable) {
    if (!venues.has(item.venue.id)) venues.set(item.venue.id, { ...item.venue, count: 0, highest: "P9" });
    const venue = venues.get(item.venue.id);
    venue.count += 1;
    if (priorityRank(item.priority) < priorityRank(venue.highest)) venue.highest = item.priority;
  }
  const listed = [...venues.values()].sort((left, right) => right.count - left.count);
  if (asJson) console.log(JSON.stringify({ venues: listed }, null, 2));
  else {
    console.log("Venues with actionable items — pass --venue <id> for a printable worklist:");
    for (const venue of listed) console.log(`  ${venue.highest} ${String(venue.count).padStart(3)}  ${venue.id}  (${venue.label})`);
  }
  process.exit(0);
}

const items = actionable.filter((item) => item.venue.id === venueId)
  .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
    || left.id.localeCompare(right.id));

if (!items.length) {
  console.error(`no actionable items for venue ${venueId}; run without --venue to list venues`);
  process.exit(1);
}

const entries = items.map((item) => {
  const target = targetById.get(item.id);
  const route = (target?.routes || []).find((candidate) => candidate.id === target?.reconciliation?.routeId)
    || (target?.routes || [])[0];
  return {
    id: item.id,
    priority: item.priority,
    provider: target?.provider || "",
    // The catalogue/film reference is the thing you actually need at a desk.
    reference: target?.reference || item.blockedItem || "",
    locator: route?.reference || route?.sourceUrl || "",
    capture: target?.desiredArtifact?.publishEligible === false
      ? "Capture for citation only; this artifact is not viewer-publishable."
      : "Capture the full original image or PDF, plus the page/entry reference.",
    proofQuestion: route?.proofQuestion || item.impact || "",
    resumeToken: item.resumeToken
  };
});

const output = { venue: items[0].venue, itemCount: entries.length, entries };

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`# Worklist — ${output.venue.label}`);
  console.log(`${entries.length} item(s). One visit clears every item below.`);
  console.log("Reply with each item's resume token afterwards so its canonical route advances.\n");
  for (const [index, entry] of entries.entries()) {
    console.log(`${index + 1}. [${entry.priority}] ${entry.provider} — ${entry.id}`);
    console.log(`   Reference : ${entry.reference}`);
    if (entry.locator) console.log(`   Locator   : ${entry.locator}`);
    console.log(`   Capture   : ${entry.capture}`);
    if (entry.proofQuestion) console.log(`   Answers   : ${entry.proofQuestion}`);
    console.log(`   Reply     : ${entry.resumeToken}\n`);
  }
}
