import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBaseline,
  buildPageDepth,
  compareWithBaseline,
  debtKey,
  documentEventTypes,
  generationsFromRoots,
  laneQueue,
  pageDepthLanes,
  privacyRestriction,
  recordedLaneIds,
  validateChecklists
} from "./page-depth-core.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const evidence = (...sourceIds) => sourceIds.map((sourceId) => ({ sourceId, role: "direct" }));

function person(personId, { events = [], places = [], extra = [], sources = ["src-name"], lifeStatus = "deceased" } = {}) {
  const name = { id: `assert-${personId}-name`, assessment: "established",
    claim: { kind: "name", personId, value: personId, display: true }, conclusion: `Named ${personId}.`, evidence: evidence(...sources) };
  extra = [...extra, { id: `assert-${personId}-life-status`, assessment: "established",
    claim: { kind: "life-status", personId, value: lifeStatus }, conclusion: `Life status ${lifeStatus}.`, evidence: [] }];
  const eventAssertions = events.map((event) => ({
    id: `assert-${personId}-${event.type}`,
    assessment: event.assessment || "established",
    claim: { kind: "event", subjectType: "person", subjectId: personId, eventType: event.type, dateText: event.date || "1 May 1780" },
    conclusion: `${event.type} on ${event.date || "1 May 1780"}.`,
    evidence: evidence(event.source)
  }));
  const placeAssertions = places.map((place, index) => ({
    id: `assert-${personId}-place-${index}`,
    assessment: "established",
    claim: { kind: "place-association", personId, value: place.value, placeRole: place.role },
    conclusion: `Of ${place.value}.`,
    evidence: evidence(place.source)
  }));
  return {
    schemaVersion: 2,
    personId,
    privacy: "private",
    presentation: {
      displayNameAssertionId: name.id,
      detailAssertionIds: [name.id, ...eventAssertions.map((item) => item.id), ...extra.map((item) => item.id)],
      treeParentAssertionIds: [],
      placeRows: placeAssertions.map((item) => ({ assertionIds: [item.id], name: item.claim.value, country: "England" }))
    },
    assertions: [name, ...eventAssertions, ...placeAssertions, ...extra]
  };
}

function record(id, people, { category = "Baptism register", principals = [], sha256 = SHA_A } = {}) {
  return {
    id, sourceAtomId: id, sha256, people,
    viewer: { approved: true, category, titlePrincipals: principals.map((personId) => ({ personId, sourceAtomId: id })) }
  };
}

function build({ people, unions = [], records, checklists = [], generations, reviews = [], sources = [] }) {
  const store = { people, unions, kinships: [], lifeStories: [], sources };
  return {
    store,
    report: buildPageDepth({
      store, records, reviews, checklists, asOfYear: 2026,
      treeIds: people.map((bundle) => bundle.personId),
      generations: generations || new Map(people.map((bundle) => [bundle.personId, 5]))
    })
  };
}

const only = (report, personId = "anne") => report.people.find((item) => item.personId === personId);

test("a category names the events it records, and a bond or an index is not the event", () => {
  assert.deepEqual(documentEventTypes("Baptism register"), ["baptism"]);
  assert.deepEqual(documentEventTypes("Civil birth record"), ["birth"]);
  assert.deepEqual(documentEventTypes("Death and burial"), ["death", "burial"]);
  assert.deepEqual(documentEventTypes("Gravestone"), ["death"]);
  assert.deepEqual(documentEventTypes("Quaker marriage certificate"), ["marriage"]);
  assert.deepEqual(documentEventTypes("Marriage bond"), []);
  assert.deepEqual(documentEventTypes("Marriage allegation"), []);
  assert.deepEqual(documentEventTypes("Death index"), []);
  assert.deepEqual(documentEventTypes("Probate calendar"), []);
  assert.deepEqual(documentEventTypes("Census"), []);
  assert.deepEqual(documentEventTypes(undefined), []);
});

test("generation is counted along the nearest line", () => {
  const generations = generationsFromRoots(["z", "e"], [
    { childId: "z", parentId: "p1" }, { childId: "p1", parentId: "g1" }, { childId: "g1", parentId: "shared" },
    { childId: "e", parentId: "shared" }
  ]);
  assert.equal(generations.get("z"), 0);
  assert.equal(generations.get("g1"), 2);
  assert.equal(generations.get("shared"), 1, "pedigree collapse keeps the nearer generation");
  assert.equal(generations.has("stranger"), false);
});

test("the principal of a baptism register with no baptism on the page is flagged", () => {
  const { report } = build({
    people: [person("anne", { sources: ["bap-1"] })],
    records: [record("bap-1", ["anne"], { principals: ["anne"] })]
  });
  assert.deepEqual(only(report).documents[0].signals, ["event-missing:baptism", "no-usable-fact"]);
  assert.equal(report.totals.flaggedDocumentLinks, 1);
  assert.deepEqual(report.debtKeys, [debtKey("anne", "bap-1", "event-missing:baptism"), debtKey("anne", "bap-1", "no-usable-fact")]);
});

test("an established baptism clears the signal; a candidate one does not", () => {
  const records = [record("bap-1", ["anne"], { principals: ["anne"] })];
  const established = build({ people: [person("anne", { events: [{ type: "baptism", source: "bap-1" }] })], records });
  assert.deepEqual(only(established.report).documents[0].signals, []);
  const candidate = build({
    people: [person("anne", { events: [{ type: "baptism", source: "bap-1", assessment: "candidate" }] })], records
  });
  assert.deepEqual(only(candidate.report).documents[0].signals, ["event-missing:baptism", "no-usable-fact"]);
});

test("a person merely named in a document is not expected to have its event", () => {
  const { report } = build({
    people: [person("anne", { sources: ["bap-1"] }), person("child", { events: [{ type: "baptism", source: "bap-1" }] })],
    records: [record("bap-1", ["anne", "child"], { principals: ["child"] })]
  });
  assert.deepEqual(only(report).documents[0].signals, []);
  assert.equal(only(report).documents[0].principal, false);
  assert.equal(only(report).openDocuments, 1, "it still waits for someone to compare it");
});

test("a review's principal counts even when the title names nobody", () => {
  const { report } = build({
    people: [person("anne", { sources: ["bur-1"] })],
    records: [record("bur-1", ["anne"], { category: "Burial register" })],
    reviews: [{ recordId: "bur-1", sha256: SHA_A, state: "current",
      participants: [{ canonicalPersonId: "anne", role: "principal" }] }]
  });
  assert.deepEqual(only(report).documents[0].signals, ["event-missing:burial", "no-usable-fact"]);
});

test("a document no assertion cites for the person is uncited", () => {
  const { report } = build({
    people: [person("anne")],
    records: [record("census-1", ["anne"], { category: "Census" })]
  });
  assert.deepEqual(only(report).documents[0].signals, ["uncited"]);
});

test("a marriage recorded on the union counts for both spouses", () => {
  const union = {
    unionId: "union-anne-john", personIds: ["anne", "john"],
    presentation: { unionAssertionId: "assert-union", eventAssertionIds: ["assert-union-marriage"] },
    assertions: [
      { id: "assert-union", assessment: "established", claim: { kind: "union", personIds: ["anne", "john"] },
        conclusion: "Anne and John were married.", evidence: evidence("mar-1") },
      { id: "assert-union-marriage", assessment: "established",
        claim: { kind: "event", subjectType: "union", subjectId: "union-anne-john", eventType: "marriage", dateText: "2 June 1801" },
        conclusion: "Married 2 June 1801.", evidence: evidence("mar-1") }
    ]
  };
  const { report } = build({
    people: [person("anne"), person("john")],
    unions: [union],
    records: [record("mar-1", ["anne", "john"], { category: "Marriage register", principals: ["anne", "john"] })]
  });
  assert.deepEqual(only(report, "anne").documents[0].signals, []);
  assert.deepEqual(only(report, "john").documents[0].signals, []);
});

test("a place left as associated by the document that states its role is flagged", () => {
  const { report } = build({
    people: [person("anne", {
      events: [{ type: "baptism", source: "bap-1" }],
      places: [{ value: "Ellastone", role: "associated", source: "bap-1" }]
    })],
    records: [record("bap-1", ["anne"], { principals: ["anne"] })]
  });
  assert.deepEqual(only(report).documents[0].signals, ["place-associated"]);
  assert.equal(only(report).associatedPlaces, 1);
  assert.equal(report.totals.associatedPlaces, 1);
});

test("an outcome settles a document until its master is replaced", () => {
  const people = [person("anne", { sources: ["bap-1"] })];
  const checklists = [{ schemaVersion: 1, personId: "anne", documents: {
    "bap-1": { outcome: "nothing-to-record", sha256: SHA_A, checkedAt: "2026-11-17", basis: "Names her as a sponsor only.", assertionIds: [] }
  }, lanes: {} }];
  const settled = build({ people, records: [record("bap-1", ["anne"], { principals: ["anne"] })], checklists });
  assert.equal(only(settled.report).documents[0].outcome, "nothing-to-record");
  assert.equal(only(settled.report).lanes["held-documents"], "done");
  assert.deepEqual(settled.report.debtKeys, [], "a settled document carries no debt");
  const replaced = build({ people, records: [record("bap-1", ["anne"], { principals: ["anne"], sha256: SHA_B })], checklists });
  assert.equal(only(replaced.report).documents[0].outcome, null);
  assert.equal(only(replaced.report).documents[0].staleOutcome, true);
  assert.equal(only(replaced.report).lanes["held-documents"], null);
});

test("a checklist is complete only when every lane has an outcome", () => {
  const lanes = Object.fromEntries(recordedLaneIds.map((id) => [id, { outcome: "not-applicable", date: "2026-11-17", reason: "test" }]));
  const people = [person("anne", { events: [{ type: "baptism", source: "bap-1" }] })];
  const records = [record("bap-1", ["anne"], { principals: ["anne"] })];
  const documents = { "bap-1": { outcome: "facts-recorded", sha256: SHA_A, checkedAt: "2026-11-17", basis: "Baptism date recorded.", assertionIds: ["assert-anne-baptism"] } };
  const partial = build({ people, records, checklists: [{ schemaVersion: 1, personId: "anne", documents, lanes }] });
  // The story lane is computed: with no story written it stays open.
  assert.equal(only(partial.report).lanes.story, null);
  assert.equal(only(partial.report).complete, false);
  assert.equal(partial.report.lanes["held-documents"].done, 1);
  assert.equal(partial.report.lanes.arms["not-applicable"], 1);
  assert.equal(pageDepthLanes.length, 9);
});

test("someone with no held documents has nothing to compare", () => {
  const { report } = build({ people: [person("anne")], records: [] });
  assert.equal(only(report).lanes["held-documents"], "not-applicable");
});

test("the baseline separates new debt from debt already known", () => {
  const people = [person("anne", { sources: ["bap-1", "bur-1"] })];
  const before = build({ people, records: [record("bap-1", ["anne"], { principals: ["anne"] })] });
  const baseline = buildBaseline(before.report, { capturedAt: "2026-11-17", commit: "abc" });
  const after = build({ people, records: [
    record("bap-1", ["anne"], { principals: ["anne"] }),
    record("bur-1", ["anne"], { category: "Burial register", principals: ["anne"] })
  ] });
  const delta = compareWithBaseline(after.report, baseline);
  assert.deepEqual(delta.added, [debtKey("anne", "bur-1", "event-missing:burial"), debtKey("anne", "bur-1", "no-usable-fact")]);
  assert.deepEqual(delta.cleared, []);
  const cleared = compareWithBaseline(build({ people, records: [] }).report, baseline);
  assert.equal(cleared.cleared.length, 2);
  assert.deepEqual(compareWithBaseline(after.report, undefined).added.length, 4, "with no baseline everything is new");
});

test("the queue takes the nearer generations first, then the most debt", () => {
  const people = [person("far", { sources: ["a"] }), person("near-two", { sources: ["b", "c"] }), person("near-one", { sources: ["d"] })];
  const records = [
    record("a", ["far"], { principals: ["far"] }),
    record("b", ["near-two"], { principals: ["near-two"] }),
    record("c", ["near-two"], { category: "Burial register", principals: ["near-two"] }),
    record("d", ["near-one"], { principals: ["near-one"] })
  ];
  const { report } = build({ people, records, generations: new Map([["far", 9], ["near-two", 6], ["near-one", 2]]) });
  assert.deepEqual(laneQueue(report, "held-documents").map((item) => item.personId), ["near-two", "near-one", "far"]);
});

test("people outside the main scope are left out", () => {
  const detailed = { ...person("cousin"), researchScope: "collateral" };
  const { report } = build({ people: [person("anne"), detailed], records: [] });
  assert.deepEqual(report.people.map((item) => item.personId), ["anne"]);
});

test("checklist entries are checked against the canonical stores", () => {
  const people = [person("anne", { events: [{ type: "baptism", source: "bap-1" }] }), person("john")];
  const store = { people, unions: [], kinships: [] };
  const records = [record("bap-1", ["anne"], { principals: ["anne"] }), record("other", ["john"])];
  const good = { schemaVersion: 1, personId: "anne", documents: {
    "bap-1": { outcome: "facts-recorded", sha256: SHA_A, checkedAt: "2026-11-17", basis: "Baptism date and place recorded.", assertionIds: ["assert-anne-baptism"] }
  }, lanes: {
    graves: { outcome: "nothing-found", date: "2026-11-17", searched: [{ source: "Find a Grave", bounds: "Ellastone, surname Heath, all years" }] },
    arms: { outcome: "not-applicable", date: "2026-11-17", reason: "No printed pedigree names this family." },
    places: { outcome: "done", date: "2026-11-17", exhibitIds: ["place-ellastone-st-peter"] }
  } };
  assert.deepEqual(validateChecklists([good], { store, records }), []);

  const issues = validateChecklists([
    { schemaVersion: 1, personId: "nobody", documents: {}, lanes: {} },
    { schemaVersion: 1, personId: "anne", documents: {
      missing: { outcome: "nothing-to-record", sha256: SHA_A, checkedAt: "2026-11-17", basis: "x" },
      other: { outcome: "nothing-to-record", sha256: SHA_A, checkedAt: "2026-11-17", basis: "x" },
      "bap-1": { outcome: "facts-recorded", sha256: "short", checkedAt: "yesterday", basis: "", assertionIds: [] }
    }, lanes: {
      story: { outcome: "done", date: "2026-11-17", note: "x" },
      graves: { outcome: "nothing-found", date: "2026-11-17" },
      arms: { outcome: "not-applicable", date: "2026-11-17" },
      print: { outcome: "done", date: "2026-11-17" },
      voyages: { outcome: "searched", date: "soon" }
    } },
    { schemaVersion: 1, personId: "john", documents: {
      other: { outcome: "facts-recorded", sha256: SHA_A, checkedAt: "2026-11-17", basis: "x", assertionIds: ["assert-anne-baptism", "assert-nope"] }
    }, lanes: {} }
  ], { store, records });
  const expectIssue = (pattern) => assert.ok(issues.some((issue) => pattern.test(issue)), `expected ${pattern} in:\n${issues.join("\n")}`);
  expectIssue(/checklist nobody: unknown person/);
  expectIssue(/document missing: no such manifest record/);
  expectIssue(/document other: the record does not list this person/);
  expectIssue(/document bap-1: requires the sha256/);
  expectIssue(/document bap-1: requires checkedAt/);
  expectIssue(/document bap-1: requires a basis/);
  expectIssue(/document bap-1: facts-recorded requires assertionIds/);
  expectIssue(/lane story: not a recorded lane/);
  expectIssue(/lane graves: nothing-found requires what was searched/);
  expectIssue(/lane arms: not-applicable requires a reason/);
  expectIssue(/lane print: done requires a note or exhibitIds/);
  expectIssue(/lane voyages: invalid outcome searched/);
  expectIssue(/lane voyages: requires date/);
  expectIssue(/checklist john document other: assertion assert-anne-baptism does not concern this person/);
  expectIssue(/checklist john document other: assertion assert-anne-baptism does not cite this record/);
  expectIssue(/checklist john document other: missing assertion assert-nope/);
});

test("a lane closes as nothing found after at most three sources", () => {
  const store = { people: [person("anne")], unions: [], kinships: [] };
  const searched = ["a", "b", "c", "d"].map((source) => ({ source, bounds: "all years" }));
  const issues = validateChecklists([{ schemaVersion: 1, personId: "anne", documents: {}, lanes: {
    graves: { outcome: "nothing-found", date: "2026-11-17", searched }
  } }], { store, records: [] });
  assert.deepEqual(issues, ["checklist anne lane graves: at most three sources per lane"]);
});

test("living people are left alone; the recently dead are treated like everyone else", () => {
  // The rule that allowed only a grave or an obituary for anyone who died within the
  // last fifty years was removed at the user's request on 18 Nov 2026.
  const living = person("living", { lifeStatus: "living", sources: ["cert-1"] });
  const unknownNear = person("unknown-near", { lifeStatus: "unknown" });
  const unknownOld = person("unknown-old", { lifeStatus: "unknown", events: [{ type: "birth", date: "3 March 1790", source: "x" }] });
  const unknownFar = person("unknown-far", { lifeStatus: "unknown" });
  const recent = person("recent", { events: [{ type: "death", date: "4 July 1984", source: "obit-1" }] });
  assert.equal(privacyRestriction(living, 1), "living");
  assert.equal(privacyRestriction(unknownNear, 2), "living");
  assert.equal(privacyRestriction(unknownNear, null), "living", "a relative off the direct line with nothing dated");
  assert.equal(privacyRestriction(unknownOld, 2), null);
  assert.equal(privacyRestriction(unknownFar, 7), null);
  assert.equal(privacyRestriction(recent, 2), null, "a recent death is no restriction");
  const born = (id, year, lifeStatus) => person(id, { lifeStatus, events: [{ type: "birth", date: `13 Feb ${year}`, source: "x" }] });
  assert.equal(privacyRestriction(born("b1903", 1903, "unknown"), 4), null);
  assert.equal(privacyRestriction(born("b1903d", 1903, "deceased"), 4), null);
  assert.equal(privacyRestriction(born("b1920", 1920, "unknown"), 2), "living", "born after 1916 near the roots with no death: may be alive");
  assert.equal(privacyRestriction(person("undated", { lifeStatus: "deceased" }), 4), null, "nothing dated: left to the generation rule");

  const { report } = build({
    people: [living, recent],
    records: [
      record("cert-1", ["living"], { category: "Birth certificate", principals: ["living"] }),
      record("obit-1", ["recent"], { category: "Marriage register", principals: ["recent"] })
    ],
    generations: new Map([["living", 1], ["recent", 2]])
  });
  const alive = only(report, "living");
  assert.equal(alive.restriction, "living");
  for (const lane of recordedLaneIds) assert.equal(alive.lanes[lane], "not-applicable");
  assert.equal(alive.lanes["held-documents"], "not-applicable");
  const late = only(report, "recent");
  assert.ok(!late.restriction);
  assert.equal(late.lanes.arms, null, "every lane is open");
  assert.equal(late.lanes["held-documents"], null, "their documents are worked like anyone's");
  assert.equal(report.totals.restricted, 1);
});

test("a candidate match gives a person no facts and owes nothing until it is confirmed", () => {
  const people = [person("anne", { sources: ["stone-1"] })];
  const records = [record("stone-1", ["anne"], { category: "Gravestone", principals: ["anne"] })];
  const link = (status) => [{ id: "stone-1", personLinks: [{ personId: "anne", identificationStatus: status }] }];
  const candidate = build({ people, records, sources: link("candidate") });
  const document = only(candidate.report).documents[0];
  assert.equal(document.outcome, "awaiting-identification");
  assert.deepEqual(document.signals, []);
  assert.deepEqual(candidate.report.debtKeys, []);
  assert.equal(candidate.report.totals.awaitingIdentification, 1);
  assert.equal(only(candidate.report).lanes["held-documents"], "not-applicable", "nothing was compared, so the lane is not done");
  const confirmed = build({ people, records, sources: link("confirmed") });
  assert.deepEqual(only(confirmed.report).documents[0].signals, ["event-missing:death", "no-usable-fact"]);

  const issues = validateChecklists([{ schemaVersion: 1, personId: "anne", documents: {
    "stone-1": { outcome: "facts-recorded", sha256: SHA_A, checkedAt: "2026-11-17", basis: "Death date recorded.", assertionIds: ["assert-anne-name"] }
  }, lanes: {} }], { store: candidate.store, records });
  assert.deepEqual(issues, ["checklist anne document stone-1: the record is only a candidate match for this person; nothing is recorded from it until the identification is confirmed"]);
});
