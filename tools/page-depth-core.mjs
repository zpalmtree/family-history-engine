// Page depth: what each ancestor's page still owes the documents already held.
//
// The research queue measures progress toward parents. Nothing measured how much
// of a held document had reached the person's page, so a baptism register could be
// archived, read twice and cited for a parent link while the baptism itself stayed
// off the timeline. This module makes that visible per person and per document, and
// keeps the outcome of every checklist lane so no lane is searched twice.
//
// Two kinds of statement are kept apart on purpose:
//
//  1. A SIGNAL is a structural hint computed from categories and citations ("the
//     principal of a burial register has no burial event"). It orders the work. It
//     cannot say what a document states, so it never closes anything.
//
//  2. An OUTCOME is recorded by whoever opened the document and compared it with the
//     person's facts. Only an outcome settles a document, and it is bound to the
//     master's SHA-256, so a replaced master reopens it.

import { buildLifeStoryIndex, buildLifeStoryPacket, lifeStoryStatus } from "./life-story-core.mjs";
import { assertionPersonIds } from "./biography-schema.mjs";

export const pageDepthLanes = Object.freeze([
  Object.freeze({ id: "held-documents", letter: "A", title: "Held documents", computed: true }),
  Object.freeze({ id: "places", letter: "B", title: "Places" }),
  Object.freeze({ id: "arms", letter: "C", title: "Arms" }),
  Object.freeze({ id: "graves", letter: "D", title: "Graves and monuments" }),
  Object.freeze({ id: "signatures", letter: "E", title: "Signatures and marks" }),
  Object.freeze({ id: "voyages", letter: "F", title: "Voyages" }),
  Object.freeze({ id: "trades", letter: "G", title: "Trades and offices" }),
  Object.freeze({ id: "print", letter: "H", title: "Print and newspapers" }),
  Object.freeze({ id: "story", letter: "I", title: "Story", computed: true })
]);

export const recordedLaneIds = Object.freeze(pageDepthLanes.filter((lane) => !lane.computed).map((lane) => lane.id));
export const laneOutcomes = Object.freeze(["done", "nothing-found", "not-applicable"]);
export const documentOutcomes = Object.freeze(["facts-recorded", "nothing-to-record"]);
export const generationBands = Object.freeze([
  Object.freeze({ label: "0-3", from: 0, to: 3 }),
  Object.freeze({ label: "4-6", from: 4, to: 6 }),
  Object.freeze({ label: "7-9", from: 7, to: 9 }),
  Object.freeze({ label: "10-12", from: 10, to: 12 }),
  Object.freeze({ label: "13+", from: 13, to: Infinity })
]);

const SUBSTANTIVE_KINDS = new Set(["event", "place-association", "occupation", "life-fact", "narrative"]);
const FAMILY_BASES = new Set(["child", "child-life", "parent-life"]);
// A bond, allegation or index entry is about a marriage; it is not the marriage.
const NOT_THE_EVENT = /allegation|\bbond\b|promise|publication|banns|consent|annex|\bindex\b|licen[cs]e|notice|calendar/;

/** Event types a document of this category records for its principal. */
export function documentEventTypes(category) {
  const text = String(category || "").toLowerCase();
  if (!text || NOT_THE_EVENT.test(text)) return [];
  const types = [];
  if (/bapti[sz]|christening/.test(text)) types.push("baptism");
  if (/\bbirth/.test(text)) types.push("birth");
  if (/\bmarriage/.test(text)) types.push("marriage");
  if (/\bdeath|obituary|gravestone/.test(text)) types.push("death");
  if (/\bburial|interment/.test(text)) types.push("burial");
  return types;
}

/** Generations above the roots, by the nearest line. Roots are generation 0. */
export function generationsFromRoots(rootIds, parentLinks) {
  const parentsOf = new Map();
  for (const link of parentLinks || []) {
    if (!parentsOf.has(link.childId)) parentsOf.set(link.childId, []);
    parentsOf.get(link.childId).push(link.parentId);
  }
  const generations = new Map();
  let frontier = [...rootIds];
  for (const id of frontier) generations.set(id, 0);
  for (let depth = 1; frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) for (const parentId of parentsOf.get(id) || []) {
      if (generations.has(parentId)) continue;
      generations.set(parentId, depth);
      next.push(parentId);
    }
    frontier = next;
  }
  return generations;
}

// The runbook leaves living people alone. (The rule that allowed only a grave
// photograph or a published obituary for anyone who died within the last fifty years
// was removed at the user's request on 18 Nov 2026.)
const HISTORICAL_BIRTH_YEAR = 1916;

export function privacyRestriction(bundle, generation) {
  const active = (bundle.assertions || []).filter((assertion) => assertion.assessment !== "rejected");
  const status = active.find((assertion) => assertion.claim?.kind === "life-status")?.claim.value || "unknown";
  const years = (types) => active.filter((assertion) => assertion.claim?.kind === "event" && types.includes(assertion.claim.eventType))
    .map((assertion) => Number(String(assertion.claim.dateText || "").match(/\b(1\d{3}|20\d{2})\b/)?.[0])).filter(Boolean);
  if (years(["death", "burial"]).length) return null;
  if (status === "living") return "living";
  if (status === "deceased") return null;
  // Life status unknown: near the roots, with no birth old enough to settle it,
  // the person may be alive.
  if (years(["birth", "baptism"]).some((year) => year <= HISTORICAL_BIRTH_YEAR)) return null;
  return generation === null || generation <= 3 ? "living" : null;
}

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const isSha256 = (value) => /^[0-9a-f]{64}$/.test(String(value || ""));
const filled = (value) => typeof value === "string" && value.trim().length > 0;
const sourceIdOf = (record) => record.sourceAtomId || record.id;
const isOwnFact = (fact) => !(fact.bases || []).every((basis) => FAMILY_BASES.has(basis));

function wordsIn(story) {
  return (story?.paragraphs || []).flatMap((paragraph) => String(paragraph?.text || "").trim().split(/\s+/))
    .filter(Boolean).length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @param {object} input
 * @param {object} input.store the research store
 * @param {Array<object>} input.records manifest records
 * @param {Array<object>} [input.reviews] extraction reviews
 * @param {Array<object>} [input.checklists] page-depth checklist documents
 * @param {Iterable<string>} input.treeIds people shown on the main tree
 * @param {Map<string, number>} [input.generations] generation above the roots
 */
export function buildPageDepth({
  store, records, reviews = [], checklists = [], treeIds, generations = new Map()
}) {
  const peopleById = new Map(store.people.map((bundle) => [bundle.personId, bundle]));
  const unionPeople = new Map(store.unions.map((union) => [union.unionId, union.personIds || []]));
  const storiesById = new Map((store.lifeStories || []).map((story) => [story.personId, story]));
  const checklistById = new Map(checklists.map((item) => [item.personId, item]));
  const reviewByRecord = new Map(reviews.filter((review) => review.state !== "superseded")
    .map((review) => [`${review.recordId}@${review.sha256}`, review]));

  // Every active assertion that concerns a person, keyed by the source it cites.
  const citing = new Map();
  const note = (personId, sourceId, assertionId) => {
    const key = `${personId}\0${sourceId}`;
    if (!citing.has(key)) citing.set(key, new Set());
    citing.get(key).add(assertionId);
  };
  for (const owner of [...store.people, ...store.unions, ...(store.kinships || [])]) {
    for (const assertion of owner.assertions || []) {
      if (assertion.assessment === "rejected") continue;
      const concerned = new Set(assertionPersonIds(assertion));
      if (owner.personId) concerned.add(owner.personId);
      for (const id of owner.personIds || []) concerned.add(id);
      for (const id of unionPeople.get(assertion.claim?.subjectId) || []) concerned.add(id);
      for (const link of assertion.evidence || []) for (const id of concerned) note(id, link.sourceId, assertion.id);
    }
  }

  // A record that is only a candidate match for a person cannot give that person
  // facts: it waits for the research question that owns the identification.
  const linkStatus = candidateLinkLookup(store);

  const recordsByPerson = new Map();
  for (const record of records) for (const personId of new Set(record.people || [])) {
    if (!recordsByPerson.has(personId)) recordsByPerson.set(personId, []);
    recordsByPerson.get(personId).push(record);
  }

  const people = [];
  const packetIndex = buildLifeStoryIndex(store);
  for (const personId of [...new Set(treeIds)].sort()) {
    const bundle = peopleById.get(personId);
    if (!bundle || (bundle.researchScope || "main") !== "main") continue;
    const packet = buildLifeStoryPacket(store, personId, packetIndex);
    const own = packet.facts.filter((fact) => fact.usableInStory && isOwnFact(fact));
    const substantive = own.filter((fact) => SUBSTANTIVE_KINDS.has(fact.factKind));
    const eventTypes = new Set(own.filter((fact) => fact.factKind === "event").map((fact) => fact.eventType));
    const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
    const placeAssertions = (bundle.presentation?.placeRows || []).flatMap((row) => row.assertionIds || [])
      .map((id) => local.get(id)).filter((assertion) => assertion && assertion.assessment !== "rejected");
    const associated = placeAssertions.filter((assertion) => assertion.claim?.placeRole === "associated");
    const usableBySource = new Set(substantive.flatMap((fact) => {
      const assertion = local.get(fact.assertionId);
      return (assertion?.evidence || []).map((link) => link.sourceId);
    }));
    for (const union of store.unions.filter((item) => (item.personIds || []).includes(personId))) {
      for (const assertion of union.assertions || []) {
        if (!substantive.some((fact) => fact.assertionId === assertion.id)) continue;
        for (const link of assertion.evidence || []) usableBySource.add(link.sourceId);
      }
    }
    const checklist = checklistById.get(personId);

    const documents = (recordsByPerson.get(personId) || []).map((record) => {
      const sourceId = sourceIdOf(record);
      const review = reviewByRecord.get(`${record.id}@${record.sha256}`);
      const principal = (record.viewer?.titlePrincipals || []).some((item) => item.personId === personId)
        || (review?.participants || []).some((item) => item.canonicalPersonId === personId && item.role === "principal");
      const cited = [...(citing.get(`${personId}\0${sourceId}`) || [])].sort();
      const awaitingIdentification = linkStatus(sourceId, personId) === "candidate";
      const signals = [];
      if (awaitingIdentification) {
        // Nothing is owed yet, so nothing is flagged.
      } else if (!cited.length) signals.push("uncited");
      if (principal && !awaitingIdentification) {
        for (const type of documentEventTypes(record.viewer?.category)) {
          if (!eventTypes.has(type)) signals.push(`event-missing:${type}`);
        }
        if (cited.length && !usableBySource.has(sourceId)) signals.push("no-usable-fact");
      }
      if (!awaitingIdentification
        && associated.some((assertion) => (assertion.evidence || []).some((link) => link.sourceId === sourceId))
        && (principal || /census|1939 register/i.test(record.viewer?.category || ""))) {
        signals.push("place-associated");
      }
      const stored = checklist?.documents?.[record.id];
      const outcome = awaitingIdentification ? { outcome: "awaiting-identification" }
        : stored && stored.sha256 === record.sha256 ? stored : null;
      return {
        recordId: record.id,
        sourceId,
        sha256: record.sha256,
        category: record.viewer?.category || "",
        principal,
        reviewed: Boolean(review),
        citedAssertionIds: cited,
        signals,
        outcome: outcome ? outcome.outcome : null,
        ...(stored && !outcome ? { staleOutcome: true } : {}),
        ...(awaitingIdentification ? { awaitingIdentification: true } : {})
      };
    }).sort((a, b) => a.recordId.localeCompare(b.recordId));

    const open = documents.filter((document) => !document.outcome);
    const flagged = open.filter((document) => document.signals.length);
    const story = storiesById.get(personId);
    const storyState = lifeStoryStatus(story, packet).status;
    const generation = generations.has(personId) ? generations.get(personId) : null;
    const restriction = privacyRestriction(bundle, generation);
    const lanes = {};
    for (const lane of pageDepthLanes) {
      if (lane.id === "story") {
        lanes[lane.id] = storyState === "fresh" ? "done" : storyState === "unavailable" ? "not-applicable" : null;
      } else if (restriction === "living") {
        lanes[lane.id] = "not-applicable";
      } else if (lane.id === "held-documents") {
        lanes[lane.id] = !documents.length ? "not-applicable" : open.length ? null
          : documents.every((document) => document.awaitingIdentification) ? "not-applicable" : "done";
      } else {
        lanes[lane.id] = checklist?.lanes?.[lane.id]?.outcome || null;
      }
    }
    people.push({
      personId,
      name: packet.displayName,
      generation,
      ...(restriction ? { restriction } : {}),
      substantiveFacts: substantive.length,
      documentCount: documents.length,
      storyWords: wordsIn(story),
      storyStatus: storyState,
      associatedPlaces: associated.length,
      placeFacts: placeAssertions.length,
      documents,
      openDocuments: open.length,
      flaggedDocuments: flagged.length,
      lanes,
      complete: pageDepthLanes.every((lane) => lanes[lane.id])
    });
  }

  const bands = generationBands.map((band) => {
    const members = people.filter((person) => person.generation !== null
      && person.generation >= band.from && person.generation <= band.to);
    return {
      label: band.label,
      people: members.length,
      medianSubstantiveFacts: median(members.map((person) => person.substantiveFacts)),
      medianDocuments: median(members.map((person) => person.documentCount)),
      medianStoryWords: median(members.map((person) => person.storyWords))
    };
  });
  const signalCounts = {};
  const debtKeys = [];
  for (const person of people) for (const document of person.documents) {
    if (document.outcome || person.restriction) continue;
    for (const signal of document.signals) {
      signalCounts[signal] = (signalCounts[signal] || 0) + 1;
      debtKeys.push(debtKey(person.personId, document.recordId, signal));
    }
  }
  const laneCounts = Object.fromEntries(pageDepthLanes.map((lane) => [lane.id, {
    done: 0, "nothing-found": 0, "not-applicable": 0, open: 0
  }]));
  for (const person of people) for (const lane of pageDepthLanes) {
    laneCounts[lane.id][person.lanes[lane.id] || "open"] += 1;
  }

  const workable = people.filter((person) => !person.restriction);
  return {
    people,
    totals: {
      people: people.length,
      complete: people.filter((person) => person.complete).length,
      documentLinks: people.reduce((sum, person) => sum + person.documentCount, 0),
      awaitingIdentification: people.reduce((sum, person) => sum + person.documents.filter((document) => document.awaitingIdentification).length, 0),
      restricted: people.filter((person) => person.restriction).length,
      openDocumentLinks: workable.reduce((sum, person) => sum + person.openDocuments, 0),
      flaggedDocumentLinks: workable.reduce((sum, person) => sum + person.flaggedDocuments, 0),
      atMostOneSubstantiveFact: people.filter((person) => person.substantiveFacts <= 1).length,
      noSubstantiveFact: people.filter((person) => person.substantiveFacts === 0).length,
      storiesUnder30Words: people.filter((person) => person.storyWords < 30).length,
      placeFacts: people.reduce((sum, person) => sum + person.placeFacts, 0),
      associatedPlaces: people.reduce((sum, person) => sum + person.associatedPlaces, 0),
      signals: Object.fromEntries(Object.entries(signalCounts).sort(([a], [b]) => a.localeCompare(b)))
    },
    bands,
    lanes: laneCounts,
    debtKeys: debtKeys.sort()
  };
}

/** "confirmed" | "candidate" | null for the link between a record's source and a person. */
export function candidateLinkLookup(store) {
  const links = new Map();
  for (const source of store.sources || []) for (const link of source.personLinks || []) {
    links.set(`${source.id}\0${link.personId}`, link.identificationStatus === "confirmed" ? "confirmed" : "candidate");
  }
  return (sourceId, personId) => links.get(`${sourceId}\0${personId}`) || null;
}

export function debtKey(personId, recordId, signal) {
  return `${personId}|${recordId}|${signal}`;
}

/** Debt that appeared since the baseline: a held document nobody has compared yet. */
export function compareWithBaseline(report, baseline) {
  const known = new Set(baseline?.debtKeys || []);
  const current = new Set(report.debtKeys);
  return {
    added: report.debtKeys.filter((key) => !known.has(key)),
    cleared: [...known].filter((key) => !current.has(key)).sort()
  };
}

export function buildBaseline(report, { capturedAt, commit }) {
  return {
    schemaVersion: 1,
    capturedAt,
    commit,
    totals: report.totals,
    debtKeys: report.debtKeys
  };
}

/** People ordered for work on one lane: nearest generations first, then by debt. */
export function laneQueue(report, laneId) {
  const band = (person) => person.generation === null ? 99 : person.generation <= 6 ? 0 : person.generation;
  return report.people.filter((person) => !person.lanes[laneId])
    .sort((a, b) => band(a) - band(b)
      || (laneId === "held-documents" ? b.flaggedDocuments - a.flaggedDocuments || b.openDocuments - a.openDocuments : 0)
      || a.personId.localeCompare(b.personId));
}

/**
 * Checklist files are written by hand-run commands and read by the report, so every
 * reference in them is checked against the canonical stores.
 */
export function validateChecklists(checklists, { store, records }) {
  const issues = [];
  const peopleById = new Map(store.people.map((bundle) => [bundle.personId, bundle]));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const assertions = new Map();
  for (const owner of [...store.people, ...store.unions, ...(store.kinships || [])]) {
    for (const assertion of owner.assertions || []) assertions.set(assertion.id, { assertion, owner });
  }
  const linkStatus = candidateLinkLookup(store);
  const seen = new Set();
  for (const checklist of checklists) {
    const label = `checklist ${checklist?.personId || "(no personId)"}`;
    if (checklist?.schemaVersion !== 1) issues.push(`${label}: unsupported schemaVersion`);
    const bundle = peopleById.get(checklist?.personId);
    if (!bundle) {
      issues.push(`${label}: unknown person`);
      continue;
    }
    if (seen.has(checklist.personId)) issues.push(`${label}: duplicate checklist`);
    seen.add(checklist.personId);
    if ((bundle.researchScope || "main") !== "main") issues.push(`${label}: person is outside the main scope`);
    for (const key of Object.keys(checklist)) {
      if (!["schemaVersion", "personId", "documents", "lanes"].includes(key)) issues.push(`${label}: unknown field ${key}`);
    }

    for (const [recordId, entry] of Object.entries(checklist.documents || {})) {
      const where = `${label} document ${recordId}`;
      const record = recordsById.get(recordId);
      if (!record) {
        issues.push(`${where}: no such manifest record`);
        continue;
      }
      if (!(record.people || []).includes(checklist.personId)) issues.push(`${where}: the record does not list this person`);
      if (linkStatus(sourceIdOf(record), checklist.personId) === "candidate") {
        issues.push(`${where}: the record is only a candidate match for this person; nothing is recorded from it until the identification is confirmed`);
      }
      if (!documentOutcomes.includes(entry?.outcome)) issues.push(`${where}: invalid outcome ${entry?.outcome}`);
      if (!isSha256(entry?.sha256)) issues.push(`${where}: requires the sha256 of the master that was compared`);
      if (!isDate(entry?.checkedAt)) issues.push(`${where}: requires checkedAt (YYYY-MM-DD)`);
      if (!filled(entry?.basis)) issues.push(`${where}: requires a basis saying what was compared`);
      const ids = entry?.assertionIds || [];
      if (!Array.isArray(ids)) issues.push(`${where}: assertionIds must be an array`);
      if (entry?.outcome === "facts-recorded" && !ids.length) issues.push(`${where}: facts-recorded requires assertionIds`);
      const sourceId = sourceIdOf(record);
      for (const id of Array.isArray(ids) ? ids : []) {
        const found = assertions.get(id);
        if (!found) {
          issues.push(`${where}: missing assertion ${id}`);
          continue;
        }
        const { assertion, owner } = found;
        if (assertion.assessment === "rejected") issues.push(`${where}: assertion ${id} is rejected`);
        const concerned = new Set([...assertionPersonIds(assertion), owner.personId, ...(owner.personIds || [])]);
        if (!concerned.has(checklist.personId)) issues.push(`${where}: assertion ${id} does not concern this person`);
        if (!(assertion.evidence || []).some((link) => link.sourceId === sourceId)) {
          issues.push(`${where}: assertion ${id} does not cite this record`);
        }
      }
    }

    for (const [laneId, entry] of Object.entries(checklist.lanes || {})) {
      const where = `${label} lane ${laneId}`;
      if (!recordedLaneIds.includes(laneId)) {
        issues.push(`${where}: not a recorded lane (held-documents and story are computed)`);
        continue;
      }
      if (!laneOutcomes.includes(entry?.outcome)) issues.push(`${where}: invalid outcome ${entry?.outcome}`);
      if (!isDate(entry?.date)) issues.push(`${where}: requires date (YYYY-MM-DD)`);
      if (entry?.outcome === "nothing-found") {
        const searched = entry.searched;
        if (!Array.isArray(searched) || !searched.length) issues.push(`${where}: nothing-found requires what was searched`);
        for (const item of Array.isArray(searched) ? searched : []) {
          if (!filled(item?.source) || !filled(item?.bounds)) issues.push(`${where}: each search needs a source and its bounds`);
        }
        if (Array.isArray(searched) && searched.length > 3) issues.push(`${where}: at most three sources per lane`);
      }
      if (entry?.outcome === "not-applicable" && !filled(entry.reason)) issues.push(`${where}: not-applicable requires a reason`);
      if (entry?.outcome === "done" && !filled(entry.note) && !(entry.exhibitIds || []).length) {
        issues.push(`${where}: done requires a note or exhibitIds`);
      }
    }
  }
  return issues;
}
