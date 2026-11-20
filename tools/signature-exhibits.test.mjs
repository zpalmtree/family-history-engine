import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignatureEntry } from "./signature-exhibits.mjs";

const TODAY = "2026-11-17";
const record = (extra = {}) => ({
  id: "walker-smith-1818", sha256: "a".repeat(64), mediaType: "image/jpeg", rights: "family-viewer-approved",
  source: "Findmypast, Staffordshire Marriages And Banns", reference: "John Example and Jane Sample, married 1 Jun 1818 at Ellastone St Peter",
  viewer: { approved: true }, ...extra
});
const source = (groom = "confirmed", bride = "confirmed") => ({ personLinks: [
  { personId: "james-walker", identificationStatus: groom }, { personId: "mary-smith", identificationStatus: bride }
] });
const review = () => ({ readings: [{ id: "r", locator: "entry 40", textAsRecorded: "John Example of this Parish" }], claimEffects: [] });
const item = (extra = {}) => ({
  id: "walker-smith-1818", slug: "walker-smith-ellastone-1818", place: "Ellastone, Staffordshire", dateLong: "1 June 1818", dateText: "1 Jun 1818", year: 1818,
  crop: { x: 0.5, y: 0.33, width: 0.36, height: 0.05 },
  groom: { personId: "james-walker", name: "John Example", how: "signed", line: "John Example" },
  bride: { personId: "mary-smith", name: "Jane Sample", how: "mark", line: "Jane Sample + her Mark" }, ...extra
});
const build = (plan = item(), context = {}) => buildSignatureEntry(plan, { record: record(), source: source(), review: review(), today: TODAY, ...context });

test("a signature and a mark become one exhibit, a fact each and a reading in the review", () => {
  const built = build();
  assert.deepEqual(built.problems, []);
  assert.equal(built.exhibit.id, "signature-walker-smith-ellastone-1818");
  assert.equal(built.exhibit.kind, "signature");
  assert.equal(built.exhibit.title, "John Example's signature and Jane Sample's mark");
  assert.equal(built.exhibit.caption, "From the marriage register of Ellastone, Staffordshire, 1 June 1818. He signed his name; hers is written for her, and she made a mark.");
  assert.deepEqual(built.exhibit.image.crop, { x: 0.5, y: 0.33, width: 0.36, height: 0.05 });
  assert.deepEqual(built.exhibit.recordIds, ["walker-smith-1818"]);
  assert.deepEqual(built.exhibit.appliesTo.people, [
    { personId: "james-walker", note: "His own signature." },
    { personId: "mary-smith", note: "Her name is written for her; the mark is hers." }
  ]);
  assert.deepEqual(built.facts.map((fact) => fact.assertion.id), ["assert-james-walker-signed-register-1818", "assert-mary-smith-mark-register-1818"]);
  assert.deepEqual(built.facts[0].assertion.claim, { kind: "life-fact", personId: "james-walker", category: "education",
    value: "Signed his own name in the marriage register", dateText: "1 Jun 1818", place: "Ellastone, Staffordshire" });
  assert.equal(built.facts[1].assertion.claim.value, "Made her mark in the marriage register");
  assert.match(built.facts[1].assertion.conclusion, /Jane Sample's name was written for her and she made a mark \('Jane Sample \+ her Mark'\)/);
  assert.equal(built.facts[0].assertion.evidence[0].sourceId, "walker-smith-1818");
  assert.equal(built.review.readings.at(-1).id, "sig");
  assert.match(built.review.readings.at(-1).textAsRecorded, /^John Example \| Jane Sample \+ her Mark\./);
  assert.deepEqual(built.review.claimEffects, [
    { assertionId: "assert-james-walker-signed-register-1818", effect: "added", readingIds: ["sig"] },
    { assertionId: "assert-mary-smith-mark-register-1818", effect: "added", readingIds: ["sig"] }
  ]);
  const again = buildSignatureEntry(item(), { record: record(), source: source(), review: built.review, today: TODAY });
  assert.equal(again.review.readings.length, built.review.readings.length, "running it twice adds the reading once");
  assert.equal(again.review.claimEffects.length, 2);
});

test("titles and sentences follow who signed", () => {
  const both = (groom, bride) => build(item({ groom: { ...item().groom, how: groom }, bride: { ...item().bride, how: bride } })).exhibit;
  assert.equal(both("signed", "signed").title, "The signatures of John Example and Jane Sample");
  assert.match(both("signed", "signed").caption, /Both signed their own names\.$/);
  assert.equal(both("mark", "mark").title, "The marks of John Example and Jane Sample");
  assert.match(both("mark", "mark").caption, /Neither signed: their names are written for them, and each made a mark\.$/);
  assert.equal(both("mark", "signed").title, "Jane Sample's signature and John Example's mark");
  assert.match(both("mark", "signed").caption, /She signed her name; his is written for him, and he made a mark\.$/);
});

test("a doubtful party is shown without a claim, and an unlinked one is only named", () => {
  const doubtful = build(item({ bride: { ...item().bride, how: "unclear", line: "Thamason Henery" } }));
  assert.deepEqual(doubtful.problems, []);
  assert.equal(doubtful.exhibit.title, "John Example and Jane Sample in the marriage register");
  assert.match(doubtful.exhibit.caption, /He signed his name; whether her name is a signature or written for her is not clear\.$/);
  assert.deepEqual(doubtful.facts.map((fact) => fact.personId), ["james-walker"], "no fact is recorded for the doubtful party");
  assert.equal(doubtful.exhibit.appliesTo.people[1].note, "Her name as it stands in the register.");

  const unlinked = build(item({ groom: { ...item().groom, personId: null } }));
  assert.deepEqual(unlinked.problems, []);
  assert.deepEqual(unlinked.exhibit.appliesTo.people.map((entry) => entry.personId), ["mary-smith"]);
  assert.deepEqual(unlinked.facts.map((fact) => fact.personId), ["mary-smith"]);
  assert.match(unlinked.exhibit.title, /John Example's signature/, "he is still named in the title");
});

test("a candidate match, an unpublished record or a bad plan is refused", () => {
  const problems = (plan, context) => build(plan, context).problems.join("; ");
  assert.match(problems(item(), { source: source("candidate") }), /james-walker: the record is only a candidate match/);
  assert.match(problems(item(), { source: { personLinks: [] } }), /james-walker: the record is not linked/);
  assert.match(problems(item(), { record: record({ viewer: { approved: false } }) }), /not published to the family viewer/);
  assert.match(problems(item(), { record: record({ mediaType: "application/pdf" }) }), /a strip is cut from an image master/);
  assert.match(problems(item({ crop: { x: 0.8, y: 0.1, width: 0.5, height: 0.1 } })), /crop must be fractions of the image, inside it/);
  assert.match(problems(item({ bride: { ...item().bride, how: "cross" } })), /how must be signed, mark or unclear/);
  assert.match(problems(item({ groom: { ...item().groom, personId: null }, bride: { ...item().bride, personId: null } })), /no linked party/);
  assert.match(problems(item({ year: "1818", dateLong: "" })), /requires dateLong; requires year/);
  assert.deepEqual(buildSignatureEntry(item(), { record: undefined, today: TODAY }).problems, ["no such record walker-smith-1818"]);
});
