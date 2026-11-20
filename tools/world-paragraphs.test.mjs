import test from "node:test";
import assert from "node:assert/strict";
import { worldDraftInstructions, worldVerifierInstructions,
  generateWorldParagraph,
  worldDraftProblems,
  worldEntries,
  worldExhibit,
  worldFingerprint,
  worldSetId,
  worldSets,
  worldState
} from "./world-paragraphs.mjs";

const place = { id: "place-rose", kind: "place", title: "Rose: the hill town", caption: "Rose, a hill town above the Crati valley in Calabria.", credit: "Photograph: A, Wikimedia Commons", licence: "CC BY-SA 4.0", recordIds: ["public-commons-rose"] };
const trade = { id: "trade-contadino", kind: "trade", title: "Contadino", caption: "A contadino worked the land, growing fruit, vegetables and cereals.", text: "\"L'agricoltore o contadino ...\"", credit: "Text after Wikipedia", licence: "CC BY-SA 4.0", recordIds: ["familysearch-catena-death"] };
const grave = { id: "grave-x", kind: "grave", title: "A grave", caption: "A stone.", credit: "Photo", licence: "Shown by permission", recordIds: ["public-findagrave-x"] };

const reply = (object) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(object) }] });
const fakeClient = (replies) => {
  const calls = [];
  return { calls, transport: "claude-code-print", async request(request) { calls.push(request); return reply(replies.shift()); } };
};
const goodParagraph = "Rose is a hill town above the Crati valley in Calabria. Around it the land was worked by contadini, who grew fruit, vegetables and cereals, running a holding or labouring on another's, as the soil and the climate allowed them.";

test("sets group people by the exact blend of place, trade and print entries they are shown", () => {
  const byPerson = new Map([
    ["a", [{ id: "place-rose" }, { id: "trade-contadino" }, { id: "grave-x" }]],
    ["b", new Map([["trade-contadino", { id: "trade-contadino" }], ["place-rose", { id: "place-rose" }]])],
    ["c", [{ id: "place-rose" }]]
  ]);
  const sets = worldSets([place, trade, grave], byPerson);
  assert.equal(sets.size, 1);
  const [[setId, set]] = [...sets];
  assert.equal(setId, worldSetId(["trade-contadino", "place-rose"]));
  assert.deepEqual(set.exhibitIds, ["place-rose", "trade-contadino"]);
  assert.deepEqual(set.people, ["a", "b"]);
});

test("a draft that names a person, runs long or blends one entry is refused before any check", () => {
  const entries = worldEntries([place, trade]);
  assert.deepEqual(worldDraftProblems({ paragraph: goodParagraph, entryIds: ["place-rose", "trade-contadino"] }, entries, ["Jane Sample"]), []);
  assert.match(worldDraftProblems({ paragraph: `${goodParagraph} Jane Sample lived there.`, entryIds: ["place-rose", "trade-contadino"] }, entries, ["Jane Sample"]).join(), /names a person/);
  assert.match(worldDraftProblems({ paragraph: `${goodParagraph} `.repeat(4), entryIds: ["place-rose", "trade-contadino"] }, entries).join(), /keep it under/);
  assert.match(worldDraftProblems({ paragraph: goodParagraph, entryIds: ["place-rose"] }, entries).join(), /at least two/);
  assert.match(worldDraftProblems({ paragraph: goodParagraph, entryIds: ["place-rose", "nope"] }, entries).join(), /unknown entry/);
});

test("a paragraph is drafted, independently verified and repaired once", async () => {
  const entries = worldEntries([place, trade]);
  const client = fakeClient([
    { paragraph: goodParagraph, entryIds: ["place-rose", "trade-contadino"] },
    { pass: false, problems: ["'as the soil and the climate allowed them' is not stated"] },
    { paragraph: goodParagraph.replace(", as the soil and the climate allowed them", ""), entryIds: ["place-rose", "trade-contadino"] },
    { pass: true, problems: [] }
  ]);
  const result = await generateWorldParagraph({ client, entries, now: () => new Date("2026-11-18T12:00:00Z") });
  assert.equal(client.calls.length, 4);
  assert.match(JSON.parse(client.calls[2].messages[0].content).repair.problems[0], /not stated/);
  assert.deepEqual(result.entryIds, ["place-rose", "trade-contadino"]);
  assert.equal(result.generation.transport, "claude-code-print");
  assert.equal(result.verification.passed, true);
});

test("a paragraph that never passes is not written", async () => {
  const client = fakeClient([
    { paragraph: goodParagraph, entryIds: ["place-rose", "trade-contadino"] }, { pass: false, problems: ["adds a date"] },
    { paragraph: goodParagraph, entryIds: ["place-rose", "trade-contadino"] }, { pass: false, problems: ["adds a date"] }
  ]);
  await assert.rejects(generateWorldParagraph({ client, entries: worldEntries([place, trade]) }), /verification failed: adds a date/);
});

test("the exhibit is a shared context entry credited to every entry, and goes stale when an entry changes", () => {
  const set = { exhibitIds: ["place-rose", "trade-contadino"], people: ["a", "b"] };
  const setId = worldSetId(set.exhibitIds);
  const exhibitsById = new Map([place, trade].map((exhibit) => [exhibit.id, exhibit]));
  const exhibit = worldExhibit(setId, set, { paragraph: goodParagraph, entryIds: set.exhibitIds }, exhibitsById, "2026-11-18");
  assert.equal(exhibit.kind, "context");
  assert.deepEqual(exhibit.recordIds, ["familysearch-catena-death", "public-commons-rose"]);
  assert.match(exhibit.credit, /Wikimedia Commons.*Wikipedia/);
  assert.match(exhibit.licence, /CC BY-SA/);
  assert.deepEqual(exhibit.appliesTo.people.map((entry) => entry.personId), ["a", "b"]);
  const sidecar = { inputFingerprint: worldFingerprint(worldEntries([place, trade])) };
  assert.equal(worldState(setId, set, exhibitsById, sidecar), "fresh");
  assert.equal(worldState(setId, set, exhibitsById, null), "missing");
  const changed = new Map(exhibitsById); changed.set("place-rose", { ...place, caption: "A different caption." });
  assert.equal(worldState(setId, set, changed, sidecar), "stale");
});

test("a record that is only a candidate match for one of the paragraph's people is not cited", () => {
  const set = { exhibitIds: ["place-rose", "trade-contadino"], people: ["a", "b"] };
  const setId = worldSetId(set.exhibitIds);
  const exhibitsById = new Map([place, trade].map((exhibit) => [exhibit.id, exhibit]));
  const citable = (recordId, people) => !(recordId === "familysearch-catena-death" && people.includes("b"));
  const exhibit = worldExhibit(setId, set, { paragraph: goodParagraph, entryIds: set.exhibitIds }, exhibitsById, "2026-11-19", citable);
  assert.deepEqual(exhibit.recordIds, ["public-commons-rose"]);
  assert.deepEqual(worldExhibit(setId, set, { paragraph: goodParagraph, entryIds: set.exhibitIds }, exhibitsById, "2026-11-19").recordIds,
    ["familysearch-catena-death", "public-commons-rose"]);
});

test("both prompts keep the paragraph on the place, not the picture", () => {
  assert.match(worldDraftInstructions(), /never the picture/);
  assert.match(worldVerifierInstructions(), /rather than the picture/);
});
