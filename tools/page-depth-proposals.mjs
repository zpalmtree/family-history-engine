#!/usr/bin/env node

// Held-document proposals for LIFE-STORIES-GOAL.md (lane A).
//
// A read-only helper compares each of a person's documents with the facts already
// recorded and writes a proposal file. This tool is the gate between that proposal
// and the proof store: it checks every proposed fact mechanically, prints what
// survives for the coordinator to read, and records it only with --write.
//
//   npm run page-depth:proposals -- --documents <personId>   list the person's documents and which may be used
//   npm run page-depth:proposals -- --facts <personId>       print the facts already recorded for the person
//   npm run page-depth:proposals -- <proposal.json>...       check and print (dry run)
//   npm run page-depth:proposals -- <proposal.json>... --write [--skip <personId>:<slug>]...
//
// The brief a helper works from is evidence/research/briefs/life-stories/HELPER-BRIEF.md.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lifeFactCategories } from "./biography-schema.mjs";
import { areaForPlace, placeRoles } from "./place-labels.mjs";

export { areaForPlace };

const EVENT_TYPES = new Set(["death", "burial", "birth", "baptism"]);
const REAL_ROLES = new Set([...placeRoles].filter((role) => role !== "associated"));
// Wording that reports a guess, not a document.
const INFERENCE = /\b(?:would have|must have|probably|perhaps|likely|presumably|no doubt)\b/i;

const MONTHS = { January: "Jan", February: "Feb", March: "Mar", April: "Apr", June: "Jun", July: "Jul", August: "Aug", September: "Sep", October: "Oct", November: "Nov", December: "Dec" };

/** Dates are stored with three-letter months ("7 Jun 1907"), whatever a helper writes. */
export function shortMonths(dateText) {
  return String(dateText).replace(/\b(January|February|March|April|June|July|August|September|October|November|December)\b/g, (month) => MONTHS[month]);
}

/** Text compared loosely: quotes straightened, whitespace collapsed, case ignored. */
export function squash(text) {
  return String(text || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

/** Why a record cannot give this person a fact, or null when it can. */
export function unusableReason(record, source, personId) {
  if (!record) return "no such record";
  if (record.viewer?.approved !== true) return "not published";
  const link = (source?.personLinks || []).find((item) => item.personId === personId);
  if (link?.identificationStatus !== "confirmed") return `link ${link?.identificationStatus || "missing"}`;
  return null;
}

/**
 * Check one proposal against the person's bundle and documents. Pure: nothing is read
 * from or written to disk.
 *
 * @param {object} proposal the helper's JSON
 * @param {object} context
 * @param {object} context.bundle the person's proof bundle
 * @param {Map<string, object>} context.recordsById manifest records
 * @param {Map<string, object>} context.sourcesById canonical sources
 * @param {(recordId: string) => string} context.readingText all literal readings of the record's current review
 * @param {Set<string>} [context.skip] "<personId>:<slug or assertion id>" entries the coordinator declined
 * @param {string} context.today YYYY-MM-DD
 */
export function reviewProposal(proposal, { bundle, recordsById, sourcesById, readingText, skip = new Set(), today }) {
  const personId = proposal.personId;
  if (bundle.personId !== personId) throw new Error(`proposal is for ${personId}, bundle is ${bundle.personId}`);
  const active = (bundle.assertions || []).filter((item) => item.assessment !== "rejected");
  const existing = new Set((bundle.assertions || []).map((item) => item.id));
  const sourceOf = (recordId) => sourcesById.get(recordsById.get(recordId)?.sourceAtomId || recordId);
  const usable = (recordId) => unusableReason(recordsById.get(recordId), sourceOf(recordId), personId);
  const quoted = (recordId, quote) => squash(quote).length >= 8 && squash(readingText(recordId)).includes(squash(quote));

  // A helper sometimes repeats the person's id, or the start of it, at the head of a slug.
  const parts = personId.split("-");
  const trim = (slug) => {
    const text = String(slug || "");
    for (let count = parts.length; count >= 2; count -= 1) {
      const prefix = `${parts.slice(0, count).join("-")}-`;
      if (text.startsWith(prefix)) return text.slice(prefix.length);
    }
    return text;
  };
  // A second trade for someone whose trade is already on the page goes to the timeline
  // as employment, so the tree card keeps one trade.
  const hasTrade = active.some((item) => item.claim.kind === "occupation" && (bundle.presentation?.detailAssertionIds || []).includes(item.id));

  const refused = [];
  const facts = [];
  for (const raw of proposal.facts || []) {
    const fact = { ...raw, slug: trim(raw.slug) };
    if (fact.kind === "occupation" && hasTrade) { fact.kind = "life-fact"; fact.category = "employment"; }
    if (fact.dateText) fact.dateText = shortMonths(fact.dateText);
    const id = `assert-${personId}-${fact.slug}`;
    const problems = [];
    if (skip.has(`${personId}:${fact.slug}`)) problems.push("skipped by the coordinator");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(fact.slug)) problems.push("bad slug");
    if (existing.has(id) || facts.some((item) => item.id === id)) problems.push("assertion id already exists");
    if (!["event", "occupation", "life-fact"].includes(fact.kind)) problems.push(`kind ${fact.kind} is not accepted (never parentage, identity, names or unions)`);
    if (fact.kind === "life-fact") {
      if (!lifeFactCategories.has(fact.category)) problems.push(`category ${fact.category}`);
      if (fact.category === "organization-membership") problems.push("organization membership needs its organization; record it by hand");
      if (fact.category === "migration" && !fact.place) problems.push("migration needs a place");
    }
    if (fact.kind === "event") {
      if (!EVENT_TYPES.has(fact.eventType)) problems.push(`eventType ${fact.eventType}`);
      if (!fact.dateText) problems.push("event without dateText");
      if (active.some((item) => item.claim.kind === "event" && item.claim.eventType === fact.eventType && item.assessment === "established")) {
        problems.push(`an established ${fact.eventType} already exists`);
      }
    } else if (!fact.value || fact.value.length > 240) problems.push("value missing or over 240 characters");
    if (!fact.conclusion) problems.push("no conclusion");
    if (!(fact.evidence || []).length) problems.push("no evidence");
    for (const item of fact.evidence || []) {
      const why = usable(item.recordId);
      if (why) problems.push(`${item.recordId}: ${why}`);
      else if (!quoted(item.recordId, item.quote)) problems.push(`quote not found word for word in ${item.recordId}: "${String(item.quote).slice(0, 70)}"`);
    }
    if (INFERENCE.test(`${fact.value || ""} ${fact.conclusion || ""}`)) problems.push("inference wording");
    if (problems.length) { refused.push({ key: `${personId}:${fact.slug}`, problems }); continue; }
    const claim = fact.kind === "event"
      ? { kind: "event", subjectType: "person", subjectId: personId, eventType: fact.eventType, dateText: fact.dateText, ...(fact.place ? { place: fact.place } : {}) }
      : fact.kind === "occupation"
        ? { kind: "occupation", personId, value: fact.value, ...(fact.dateText ? { dateText: fact.dateText } : {}) }
        : { kind: "life-fact", personId, category: fact.category, value: fact.value, ...(fact.dateText ? { dateText: fact.dateText } : {}),
          ...(fact.place ? { place: fact.place, ...(areaForPlace(fact.place) || {}) } : {}) };
    facts.push({
      id,
      slug: fact.slug,
      recordIds: [...new Set(fact.evidence.map((item) => item.recordId))],
      quotes: fact.evidence.map((item) => item.quote),
      prominence: fact.prominence === "core" ? "core" : "supporting",
      assertion: {
        id, assessment: "established", claim, conclusion: fact.conclusion,
        evidence: fact.evidence.map((item) => ({
          sourceId: recordsById.get(item.recordId).sourceAtomId || item.recordId, role: "direct", rationale: `The reading has: '${item.quote}'.`,
          review: { status: "claim-reviewed", method: "original", reviewedAt: today }
        })),
        questionIds: [], reviewedAt: today,
        // A helper states the limits of a derivative account ("from a family history printed in 1917").
        ...(typeof fact.limitations === "string" && fact.limitations.trim() ? { limitations: fact.limitations.trim() } : {})
      }
    });
  }

  const roles = [];
  for (const item of proposal.placeRoles || []) {
    const target = active.find((entry) => entry.id === item.assertionId);
    const problems = [];
    if (skip.has(`${personId}:${item.assertionId}`)) problems.push("skipped by the coordinator");
    if (!target || target.claim.kind !== "place-association") problems.push("no such place assertion");
    else if (target.claim.placeRole !== "associated") problems.push(`role is already ${target.claim.placeRole}`);
    if (!REAL_ROLES.has(item.role)) problems.push(`role ${item.role}`);
    const why = usable(item.recordId);
    if (why) problems.push(`${item.recordId}: ${why}`);
    else if (!quoted(item.recordId, item.quote)) problems.push("quote not found word for word");
    if (problems.length) { refused.push({ key: `${personId}:${item.assertionId}`, problems }); continue; }
    roles.push({ assertionId: item.assertionId, role: item.role, recordId: item.recordId, quote: item.quote, value: target.claim.value });
  }

  const documents = {};
  const leftOpen = [];
  const settled = new Set(facts.map((item) => item.id));
  for (const doc of proposal.documents || []) {
    const record = recordsById.get(doc.recordId);
    const why = usable(doc.recordId);
    if (why) { leftOpen.push({ recordId: doc.recordId, reason: why }); continue; }
    if (!["facts-recorded", "nothing-to-record"].includes(doc.outcome) || !doc.basis) { leftOpen.push({ recordId: doc.recordId, reason: "bad outcome or no basis" }); continue; }
    const sourceId = record.sourceAtomId || record.id;
    const fromFacts = (doc.factSlugs || []).map((slug) => `assert-${personId}-${trim(slug)}`)
      .filter((id) => settled.has(id) && facts.find((item) => item.id === id).recordIds.includes(doc.recordId));
    const fromExisting = (doc.existingAssertionIds || []).filter((id) => active.some((entry) => entry.id === id && (entry.evidence || []).some((link) => link.sourceId === sourceId)));
    const fromRoles = roles.filter((item) => item.recordId === doc.recordId).map((item) => item.assertionId);
    const assertionIds = [...new Set([...fromFacts, ...fromExisting, ...fromRoles])].sort();
    if (doc.outcome === "facts-recorded" && !assertionIds.length) { leftOpen.push({ recordId: doc.recordId, reason: "no fact rests on it after checks" }); continue; }
    documents[doc.recordId] = {
      outcome: doc.outcome, sha256: record.sha256, checkedAt: today,
      basis: `Compared from the current review's literal readings on ${today}; ${doc.basis}`,
      assertionIds: doc.outcome === "facts-recorded" ? assertionIds : []
    };
  }
  return { personId, facts, roles, documents, leftOpen, refused, needsMaster: proposal.needsMaster || [], notes: proposal.notes || "" };
}

/** The bundle with the accepted facts and place roles written in. */
export function applyReview(bundle, review, today) {
  const next = structuredClone(bundle);
  next.presentation.detailAssertionIds ||= [];
  for (const fact of review.facts) {
    next.assertions.push(fact.assertion);
    if (fact.assertion.claim.kind === "life-fact") {
      next.presentation.biographyFacts ||= [];
      next.presentation.biographyFacts.push({ assertionId: fact.id, prominence: fact.prominence });
    } else next.presentation.detailAssertionIds.push(fact.id);
  }
  for (const role of review.roles) {
    const target = next.assertions.find((entry) => entry.id === role.assertionId);
    target.claim.placeRole = role.role;
    target.reviewedAt = today;
    // The document whose words state the role must be among the assertion's evidence,
    // or the checklist entry that settles the document on it would rest on nothing.
    target.evidence ||= [];
    if (!target.evidence.some((link) => link.sourceId === role.recordId)) {
      target.evidence.push({ sourceId: role.recordId, role: "direct", rationale: `States the place's role: "${role.quote}".`,
        review: { status: "claim-reviewed", method: "original", reviewedAt: today } });
    }
  }
  return next;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { jsonFiles, projectRoot, readJson } = await import("./research-store.mjs");
  const args = process.argv.slice(2);
  const today = new Date().toISOString().slice(0, 10);
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json")).records;
  const recordsById = new Map(manifest.map((record) => [record.id, record]));
  const sourcesById = new Map(jsonFiles(path.join(projectRoot, "evidence", "sources"), { recursive: true }).map((file) => readJson(file)).map((source) => [source.id, source]));
  const readings = new Map();
  const readingText = (recordId) => {
    if (!readings.has(recordId)) {
      const record = recordsById.get(recordId);
      const file = path.join(projectRoot, "evidence", "extraction", "reviews", recordId, `${record?.sha256}.json`);
      readings.set(recordId, fs.existsSync(file) ? readJson(file).readings.map((reading) => reading.textAsRecorded).join(" \n ") : "");
    }
    return readings.get(recordId);
  };
  const bundleFile = (personId) => path.join(projectRoot, "evidence", "proof", "people", `${personId}.json`);
  const checklistFile = (personId) => path.join(projectRoot, "evidence", "life-stories", "checklists", `${personId}.json`);

  if (args.includes("--documents")) {
    const personId = args[args.indexOf("--documents") + 1];
    const settled = fs.existsSync(checklistFile(personId)) ? readJson(checklistFile(personId)).documents || {} : {};
    for (const record of manifest.filter((item) => (item.people || []).includes(personId))) {
      const source = sourcesById.get(record.sourceAtomId || record.id);
      const why = unusableReason(record, source, personId);
      console.log(`${why ? "SKIP   " : "USABLE "} ${record.id} | sha256=${record.sha256} | category=${record.viewer?.category || "-"} | ${why || "published, confirmed"} | recordClass=${source?.recordClass || "?"}${settled[record.id] ? " | ALREADY SETTLED" : ""}`);
    }
    process.exit(0);
  }

  if (args.includes("--facts")) {
    const personId = args[args.indexOf("--facts") + 1];
    const bundle = readJson(bundleFile(personId));
    for (const item of bundle.assertions.filter((entry) => entry.assessment !== "rejected" && !["parentage", "ancestry-origin"].includes(entry.claim.kind))) {
      const claim = item.claim;
      console.log(`${item.id} [${claim.kind}${claim.category ? `:${claim.category}` : ""}${claim.eventType ? `:${claim.eventType}` : ""}${claim.placeRole ? `:${claim.placeRole}` : ""}, ${item.assessment}] ${claim.dateText || ""} ${claim.value ? `«${claim.value}» ` : ""}${item.conclusion} <${(item.evidence || []).map((link) => link.sourceId).join(", ")}>`);
    }
    for (const note of bundle.presentation?.noteBlocks || []) console.log(`NOTE: ${note.text}`);
    process.exit(0);
  }

  const write = args.includes("--write");
  const skip = new Set(args.flatMap((value, index) => value === "--skip" ? [args[index + 1]] : []));
  const files = args.filter((value, index) => value.endsWith(".json") && args[index - 1] !== "--skip");
  if (!files.length) {
    console.error("usage: page-depth-proposals.mjs --documents <personId> | --facts <personId> | <proposal.json>... [--write] [--skip <personId>:<slug>]...");
    process.exit(1);
  }
  const overrides = [];
  const changed = [];
  let refusedCount = 0;
  for (const file of files) {
    const proposal = readJson(file);
    const bundle = readJson(bundleFile(proposal.personId));
    const review = reviewProposal(proposal, { bundle, recordsById, sourcesById, readingText, skip, today });
    console.log(`\n=== ${review.personId}`);
    for (const fact of review.facts) {
      const claim = fact.assertion.claim;
      console.log(`  + ${fact.slug} [${claim.kind}${claim.category ? `:${claim.category}` : ""}${claim.eventType ? `:${claim.eventType}` : ""} ${claim.dateText || ""} | ${String(claim.value || fact.assertion.conclusion).slice(0, 200)}]\n      "${fact.quotes.join('" / "').slice(0, 230)}"`);
    }
    for (const role of review.roles) console.log(`  ~ place ${role.assertionId} → ${role.role} ("${String(role.value).slice(0, 50)}")  "${String(role.quote).slice(0, 120)}"`);
    for (const item of review.refused) console.log(`  REFUSED ${item.key}: ${item.problems.join("; ")}`);
    for (const item of review.leftOpen) console.log(`  (document ${item.recordId} left open: ${item.reason})`);
    console.log(`  documents settled: ${Object.keys(review.documents).length}; needs the master opened: ${review.needsMaster.length}${review.notes ? `\n  NOTES: ${String(review.notes).slice(0, 400)}` : ""}`);
    refusedCount += review.refused.length;
    if (!write) continue;
    if (review.facts.length || review.roles.length) {
      fs.writeFileSync(bundleFile(review.personId), `${JSON.stringify(applyReview(bundle, review, today), null, 2)}\n`);
      changed.push(review.personId);
    }
    for (const role of review.roles) {
      overrides.push(`  // ${role.recordId}: '${String(role.quote).replace(/\s+/g, " ").replace(/\*\//g, "").slice(0, 110)}'.\n  ${JSON.stringify(role.assertionId)}: ${JSON.stringify(role.role)},\n`);
    }
    if (Object.keys(review.documents).length) {
      const current = fs.existsSync(checklistFile(review.personId)) ? readJson(checklistFile(review.personId)) : { schemaVersion: 1, personId: review.personId, documents: {}, lanes: {} };
      const documents = Object.fromEntries(Object.entries({ ...current.documents, ...review.documents }).sort(([a], [b]) => a.localeCompare(b)));
      fs.mkdirSync(path.dirname(checklistFile(review.personId)), { recursive: true });
      fs.writeFileSync(checklistFile(review.personId), `${JSON.stringify({ schemaVersion: 1, personId: review.personId, documents, lanes: current.lanes || {} }, null, 2)}\n`);
    }
  }
  if (write && overrides.length) {
    // A real place role is a reviewed exception to the conservative default, kept with its words.
    const tool = path.join(projectRoot, "tools", "migrate-place-roles.mjs");
    const anchor = "const roleOverrides = new Map(Object.entries({\n";
    const source = fs.readFileSync(tool, "utf8");
    if (!source.includes(anchor)) throw new Error("role override anchor not found in tools/migrate-place-roles.mjs");
    fs.writeFileSync(tool, source.replace(anchor, anchor + overrides.join("")));
  }
  console.log(`\n${write ? "WROTE" : "DRY RUN"}: ${refusedCount} refused${write ? `; people changed: ${changed.join(" ") || "none"}. Next: research:places:check (migrate-place-presentation --write if rows are mixed), page-depth:check, life-stories:refresh for those people.` : ""}`);
}
