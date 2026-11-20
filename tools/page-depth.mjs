#!/usr/bin/env node

// Page-depth report and checklist store for LIFE-STORIES-GOAL.md.
//
//   npm run page-depth                         summary and the head of the queue
//   npm run page-depth -- --person <id>        one person, with the reading of each open document
//   npm run page-depth -- --queue <lane>       people still open in one lane
//   npm run page-depth:document -- --person <id> --record <id> --outcome facts-recorded \
//       --basis "..." --assertion <id> ...     settle one held document for one person
//   npm run page-depth:lane -- --person <id> --lane arms --outcome not-applicable --reason "..."
//   npm run page-depth:check                   validate the checklist store; report new debt
//   npm run page-depth:baseline                rewrite the baseline from the current state

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { jsonFiles, loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import {
  buildBaseline,
  buildPageDepth,
  compareWithBaseline,
  documentOutcomes,
  generationsFromRoots,
  laneOutcomes,
  laneQueue,
  pageDepthLanes,
  recordedLaneIds,
  validateChecklists
} from "./page-depth-core.mjs";

export const pageDepthPaths = Object.freeze({
  checklists: path.join(projectRoot, "evidence", "life-stories", "checklists"),
  baseline: path.join(projectRoot, "evidence", "life-stories", "page-depth-baseline.json"),
  manifest: path.join(projectRoot, "evidence", "records-manifest.json"),
  reviews: path.join(projectRoot, "evidence", "extraction", "reviews")
});

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const options = (name) => args.flatMap((value, index) => value === name ? [args[index + 1]] : []).filter(Boolean);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const today = () => new Date().toISOString().slice(0, 10);

function loadChecklists() {
  if (!fs.existsSync(pageDepthPaths.checklists)) return [];
  return jsonFiles(pageDepthPaths.checklists).map((file) => {
    const value = readJson(file);
    Object.defineProperty(value, "__file", { value: file, enumerable: false });
    return value;
  });
}

function loadState() {
  const store = loadResearchStore();
  const manifest = readJson(pageDepthPaths.manifest);
  const reviews = jsonFiles(pageDepthPaths.reviews, { recursive: true }).map(readJson);
  const checklists = loadChecklists();
  const projections = buildResearchProjections(store, { manifest });
  const tree = projections.tree.visualTree;
  const treeIds = (tree.views?.full?.nodes || tree.nodes).map((node) => node.id);
  const generations = generationsFromRoots(store.treePresentation.visualTree.directLineRoots || [],
    projections.relationships.parents);
  return { store, manifest, reviews, checklists, treeIds, generations };
}

function report(state) {
  return buildPageDepth({
    store: state.store,
    records: state.manifest.records,
    reviews: state.reviews,
    checklists: state.checklists,
    treeIds: state.treeIds,
    generations: state.generations
  });
}

function checklistFile(personId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(personId)) fail(`invalid person id: ${personId}`);
  return path.join(pageDepthPaths.checklists, `${personId}.json`);
}

function readChecklist(personId) {
  const file = checklistFile(personId);
  return fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, personId, documents: {}, lanes: {} };
}

function writeChecklist(state, checklist) {
  const ordered = {
    schemaVersion: 1,
    personId: checklist.personId,
    documents: Object.fromEntries(Object.entries(checklist.documents || {}).sort(([a], [b]) => a.localeCompare(b))),
    lanes: Object.fromEntries(pageDepthLanes.map((lane) => [lane.id, checklist.lanes?.[lane.id]])
      .filter(([, value]) => value))
  };
  const others = state.checklists.filter((item) => item.personId !== checklist.personId);
  const issues = validateChecklists([...others, ordered], { store: state.store, records: state.manifest.records })
    .filter((issue) => issue.startsWith(`checklist ${checklist.personId}`));
  if (issues.length) fail(issues.join("\n"));
  fs.mkdirSync(pageDepthPaths.checklists, { recursive: true });
  writeJsonAtomic(checklistFile(checklist.personId), ordered);
}

function printSummary(result, state) {
  const { totals } = result;
  console.log(`page depth: ${totals.people} people on the tree; ${totals.complete} checklists complete; ${totals.restricted} living or recently dead, left alone`);
  console.log(`held documents: ${totals.documentLinks} person-document links; ${totals.openDocumentLinks} not yet compared; ${totals.flaggedDocumentLinks} of those carry a signal; ${totals.awaitingIdentification} are candidate matches waiting for the main goal to confirm who they name`);
  for (const [signal, count] of Object.entries(totals.signals)) console.log(`  ${String(count).padStart(5)}  ${signal}`);
  console.log(`facts: ${totals.atMostOneSubstantiveFact} people have at most one substantive fact (${totals.noSubstantiveFact} none); ${totals.storiesUnder30Words} stories under 30 words`);
  console.log(`places: ${totals.associatedPlaces} of ${totals.placeFacts} place facts are only "associated"`);
  console.log("generation  people  median facts  median documents  median story words");
  for (const band of result.bands) {
    console.log(`  ${band.label.padEnd(8)}  ${String(band.people).padStart(6)}  ${String(band.medianSubstantiveFacts).padStart(12)}  ${String(band.medianDocuments).padStart(16)}  ${String(band.medianStoryWords).padStart(18)}`);
  }
  console.log("lane                        done  nothing found  not applicable  open");
  for (const lane of pageDepthLanes) {
    const counts = result.lanes[lane.id];
    console.log(`  ${`${lane.letter}. ${lane.title}`.padEnd(24)}  ${String(counts.done).padStart(4)}  ${String(counts["nothing-found"]).padStart(13)}  ${String(counts["not-applicable"]).padStart(14)}  ${String(counts.open).padStart(4)}`);
  }
  printBaseline(result, state);
}

function printBaseline(result) {
  if (!fs.existsSync(pageDepthPaths.baseline)) {
    console.log("baseline: none recorded (npm run page-depth:baseline)");
    return { added: [], cleared: [] };
  }
  const baseline = readJson(pageDepthPaths.baseline);
  const delta = compareWithBaseline(result, baseline);
  console.log(`baseline ${baseline.capturedAt} at ${String(baseline.commit).slice(0, 9)}: ${delta.added.length} new signal(s), ${delta.cleared.length} cleared`);
  const byPerson = new Map();
  for (const key of delta.added) {
    const [personId, recordId, signal] = key.split("|");
    if (!byPerson.has(personId)) byPerson.set(personId, []);
    byPerson.get(personId).push(`${recordId} (${signal})`);
  }
  for (const [personId, items] of byPerson) console.log(`PAGE DEPTH NEW ${personId}: ${items.join("; ")}`);
  return delta;
}

function printPerson(result, state, personId) {
  const person = result.people.find((item) => item.personId === personId);
  if (!person) fail(`not on the main tree: ${personId}`);
  const recordsById = new Map(state.manifest.records.map((record) => [record.id, record]));
  const reviewByKey = new Map(state.reviews.map((review) => [`${review.recordId}@${review.sha256}`, review]));
  const assertions = new Map();
  for (const owner of [...state.store.people, ...state.store.unions, ...(state.store.kinships || [])]) {
    for (const assertion of owner.assertions || []) assertions.set(assertion.id, assertion);
  }
  console.log(`${person.name} (${person.personId}) · generation ${person.generation ?? "n/a"} · ${person.substantiveFacts} substantive fact(s) · story ${person.storyWords} words (${person.storyStatus})`);
  if (person.restriction) console.log(`restricted (${person.restriction}): ${person.restriction === "living" ? "left alone" : "a grave photograph or a published obituary only"}`);
  console.log(`lanes: ${pageDepthLanes.map((lane) => `${lane.letter}=${person.lanes[lane.id] || "open"}`).join(" ")}`);
  console.log(`places: ${person.associatedPlaces} of ${person.placeFacts} only "associated"`);
  for (const document of person.documents) {
    const record = recordsById.get(document.recordId);
    const state_ = document.outcome || (document.staleOutcome ? "open (master replaced since the last comparison)" : "open");
    console.log(`\n- ${document.recordId} [${document.category || "uncategorized"}] ${document.principal ? "principal" : "named"} · ${state_}${document.signals.length ? ` · ${document.signals.join(", ")}` : ""}`);
    if (!has("--packet") || document.outcome) continue;
    console.log(`  reference: ${record.reference || record.source || ""}`);
    const review = reviewByKey.get(`${record.id}@${record.sha256}`);
    const mine = (review?.participants || []).filter((item) => item.canonicalPersonId === personId);
    for (const participant of mine) console.log(`  named as: ${participant.nameAsRecorded} (${participant.role})`);
    const wanted = new Set(mine.flatMap((item) => item.readingIds || []));
    for (const reading of (review?.readings || []).filter((item) => !wanted.size || wanted.has(item.id))) {
      console.log(`  reading ${reading.locator || reading.id}: ${reading.textAsRecorded}`);
    }
    for (const id of document.citedAssertionIds) {
      const assertion = assertions.get(id);
      const claim = assertion?.claim || {};
      console.log(`  cites it: ${id} [${claim.kind}${claim.eventType ? `:${claim.eventType}` : ""}${claim.placeRole ? `:${claim.placeRole}` : ""}, ${assertion?.assessment}] ${assertion?.conclusion || ""}`);
    }
  }
}

function printQueue(result, laneId) {
  if (!pageDepthLanes.some((lane) => lane.id === laneId)) fail(`unknown lane: ${laneId}`);
  const limit = Number(option("--limit")) || 30;
  const queue = laneQueue(result, laneId);
  console.log(`${queue.length} people open in ${laneId}; showing ${Math.min(limit, queue.length)}`);
  for (const person of queue.slice(0, limit)) {
    console.log(`  g${String(person.generation ?? "?").padEnd(2)} ${person.personId} · ${person.flaggedDocuments} flagged / ${person.openDocuments} open of ${person.documentCount} · ${person.substantiveFacts} fact(s)`);
  }
}

function recordDocument(state) {
  const personId = option("--person");
  const recordId = option("--record");
  const outcome = option("--outcome");
  const basis = option("--basis");
  if (!personId || !recordId || !outcome || !basis) fail("requires --person, --record, --outcome and --basis");
  if (!documentOutcomes.includes(outcome)) fail(`outcome must be one of: ${documentOutcomes.join(", ")}`);
  const record = state.manifest.records.find((item) => item.id === recordId);
  if (!record) fail(`no such manifest record: ${recordId}`);
  const checklist = readChecklist(personId);
  checklist.documents = { ...checklist.documents, [recordId]: {
    outcome,
    sha256: record.sha256,
    checkedAt: today(),
    basis,
    assertionIds: options("--assertion").sort()
  } };
  writeChecklist(state, checklist);
  console.log(`recorded ${personId} / ${recordId}: ${outcome}`);
}

function recordLane(state) {
  const personIds = options("--person");
  const laneId = option("--lane");
  const outcome = option("--outcome");
  if (!personIds.length || !laneId || !outcome) fail("requires --person, --lane and --outcome");
  if (!recordedLaneIds.includes(laneId)) fail(`lane must be one of: ${recordedLaneIds.join(", ")}`);
  if (!laneOutcomes.includes(outcome)) fail(`outcome must be one of: ${laneOutcomes.join(", ")}`);
  const searched = options("--searched").map((value) => {
    const [source, ...rest] = value.split("::");
    return { source: source.trim(), bounds: rest.join("::").trim() };
  });
  for (const personId of personIds) {
    const checklist = readChecklist(personId);
    checklist.lanes = { ...checklist.lanes, [laneId]: {
      outcome,
      date: today(),
      ...(option("--note") ? { note: option("--note") } : {}),
      ...(option("--reason") ? { reason: option("--reason") } : {}),
      ...(searched.length ? { searched } : {}),
      ...(options("--exhibit").length ? { exhibitIds: options("--exhibit").sort() } : {})
    } };
    writeChecklist(state, checklist);
    state.checklists = loadChecklists();
    console.log(`recorded ${personId} / ${laneId}: ${outcome}`);
  }
}

const state = loadState();

if (has("--record-document")) {
  recordDocument(state);
} else if (has("--record-lane")) {
  recordLane(state);
} else if (has("--baseline")) {
  const result = report(state);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  writeJsonAtomic(pageDepthPaths.baseline, buildBaseline(result, { capturedAt: today(), commit }));
  console.log(`baseline written: ${result.debtKeys.length} signal(s) on ${result.totals.flaggedDocumentLinks} document link(s)`);
} else if (has("--check")) {
  const issues = validateChecklists(state.checklists, { store: state.store, records: state.manifest.records });
  for (const checklist of state.checklists) {
    if (path.basename(checklist.__file, ".json") !== checklist.personId) {
      issues.push(`checklist ${checklist.personId}: file name does not match personId`);
    }
  }
  if (issues.length) fail(issues.map((issue) => `- ${issue}`).join("\n"));
  const result = report(state);
  const delta = printBaseline(result);
  console.log(`page-depth checklists are valid: ${state.checklists.length} file(s), ${result.totals.complete} complete`);
  // New debt is announced, not refused: the main goal adds documents all day and
  // must not be stopped by biography. --strict is for the life-stories session.
  if (has("--strict") && delta.added.length) process.exit(1);
} else {
  const result = report(state);
  if (has("--json")) {
    const personId = option("--person");
    console.log(JSON.stringify(personId ? result.people.find((item) => item.personId === personId) : {
      totals: result.totals, bands: result.bands, lanes: result.lanes
    }, null, 2));
  } else if (option("--person")) {
    printPerson(result, state, option("--person"));
  } else if (option("--queue")) {
    printQueue(result, option("--queue"));
  } else {
    printSummary(result, state);
    console.log("");
    printQueue(result, "held-documents");
  }
}
