import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateLifeFact } from "./biography-schema.mjs";
import crypto from "node:crypto";
import {
  buildLifeStoryIndex,
  buildLifeStoryPacket,
  draftVoiceProblems,
  FULL_STORY_MIN_OWN_FACTS,
  fullStoryEligible,
  fullStoryRecipe,
  fullStoryRecipeFingerprint,
  lifeStoryRecipeFingerprint,
  lifeStoryStatus,
  projectLifeStory,
  retainFailedLifeStory,
  storyContentHash,
  validateLifeStory
} from "./life-story-core.mjs";
import {
  anthropicApiClient, claudeCodeArgs, claudeCodeClient, draftInstructionsFor, generateVerifiedStory, runApiBridge, verifierInstructionsFor
} from "./life-stories.mjs";

function fixtureStore() {
  return {
    people: [{
      personId: "person",
      privacy: "private",
      presentation: {
        displayNameAssertionId: "name",
        detailAssertionIds: ["name", "birth", "work"],
        treeParentAssertionIds: [],
        biographyFacts: [{ assertionId: "work", prominence: "core" }],
        placeRows: [],
        noteBlocks: []
      },
      assertions: [
        assertion("name", { kind: "name", personId: "person", value: "Person Example", display: true }, "Person Example is the display name."),
        assertion("birth", { kind: "event", subjectType: "person", subjectId: "person", eventType: "birth", dateText: "1900" }, "Person Example was born in 1900."),
        assertion("work", { kind: "life-fact", personId: "person", category: "employment", value: "Worked as a clerk", role: "clerk" }, "Person Example worked as a clerk.")
      ]
    }],
    unions: []
  };
}

function assertion(id, claim, conclusion) {
  return { id, assessment: "established", claim, conclusion, evidence: [{ sourceId: "source", role: "direct", rationale: "fixture" }] };
}

function storyFor(packet) {
  const paragraphs = [{ text: "Person Example was born in 1900 and later worked as a clerk.", assertionIds: ["birth", "work"] }];
  return {
    schemaVersion: 1,
    personId: "person",
    paragraphs,
    inputFingerprint: packet.inputFingerprint,
    referencedFacts: packet.facts.filter((fact) => ["birth", "work"].includes(fact.assertionId))
      .map((fact) => ({ assertionId: fact.assertionId, fingerprint: fact.fingerprint })),
    recipeFingerprint: lifeStoryRecipeFingerprint,
    contentHash: storyContentHash(paragraphs),
    generation: { provider: "openai", model: "gpt-5.6-sol", promptVersion: "test", generatedAt: "2026-07-15T00:00:00.000Z" },
    verification: { model: "gpt-5.6-sol", validatorVersion: "test", passed: true, verifiedAt: "2026-07-15T00:00:00.000Z" }
  };
}

test("new unreferenced facts make a story safely stale while changed referenced facts invalidate it", () => {
  const store = fixtureStore();
  const packet = buildLifeStoryPacket(store, "person");
  const story = storyFor(packet);
  assert.equal(lifeStoryStatus(story, packet).status, "fresh");

  store.people[0].assertions.push(assertion("award", {
    kind: "life-fact", personId: "person", category: "achievement", value: "Received an award"
  }, "Person Example received an award."));
  store.people[0].presentation.biographyFacts.push({ assertionId: "award", prominence: "supporting" });
  assert.deepEqual(lifeStoryStatus(story, buildLifeStoryPacket(store, "person")), {
    status: "stale", publishable: true, problems: []
  });

  store.people[0].assertions.find((item) => item.id === "work").conclusion = "Person Example worked as a teacher.";
  assert.equal(lifeStoryStatus(story, buildLifeStoryPacket(store, "person")).status, "invalidated");
});

test("typed biography rules reject common semantic leaps", () => {
  const draftCard = assertion("registration", {
    kind: "life-fact", personId: "person", category: "military-registration", value: "Served in the army"
  }, "A draft card exists.");
  const baptism = assertion("religion", {
    kind: "life-fact", personId: "person", category: "religious-affiliation", value: "Baptized at St Mary's"
  }, "A baptism was recorded.");
  assert.ok(validateLifeFact(draftCard).some((problem) => /must not imply military service/.test(problem)));
  assert.ok(validateLifeFact(baptism).some((problem) => /must not be represented/.test(problem)));
});

test("published prose rejects internal research language", () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  const story = storyFor(packet);
  story.paragraphs[0].text = "Person Example is represented as a clerk in the canonical evidence.";
  story.contentHash = storyContentHash(story.paragraphs);
  assert.ok(validateLifeStory(story, packet).some((problem) => /internal research language/.test(problem)));
});

test("stories use established facts and reject hedging or unnatural couple wording", () => {
  const store = fixtureStore();
  store.people[0].assertions.push({
    ...assertion("candidate-place", {
      kind: "place-association", personId: "person", value: "Somewhere"
    }, "Person Example may have lived somewhere."),
    assessment: "candidate"
  });
  store.people[0].presentation.detailAssertionIds.push("candidate-place");
  const packet = buildLifeStoryPacket(store, "person");
  assert.equal(packet.facts.find((fact) => fact.assertionId === "candidate-place").usableInStory, false);

  for (const text of [
    "Person Example may have worked as a clerk.",
    "Person Example and Pat Example were a couple.",
    "Person Example was associated with Somewhere."
  ]) {
    const story = storyFor(packet);
    story.paragraphs[0].text = text;
    story.contentHash = storyContentHash(story.paragraphs);
    assert.ok(validateLifeStory(story, packet).some((problem) => /uncertainty|unnatural relationship|vague place/.test(problem)));
  }

  const datedStory = storyFor(packet);
  datedStory.paragraphs[0].text = "Person Example died on 19 May 1945.";
  datedStory.contentHash = storyContentHash(datedStory.paragraphs);
  assert.equal(validateLifeStory(datedStory, packet).some((problem) => /uncertainty/.test(problem)), false);
});

test("a profile with no established story facts is unavailable instead of forced into speculative prose", () => {
  const store = fixtureStore();
  for (const fact of store.people[0].assertions) fact.assessment = "unresolved";
  const packet = buildLifeStoryPacket(store, "person");
  assert.equal(packet.facts.some((fact) => fact.usableInStory), false);
  assert.deepEqual(lifeStoryStatus(undefined, packet), {
    status: "unavailable", publishable: false, problems: []
  });
});

test("calculated ages require an established birth event rather than baptism", () => {
  const store = fixtureStore();
  const packet = buildLifeStoryPacket(store, "person");
  const story = storyFor(packet);
  story.paragraphs[0] = {
    text: "Person Example married at age 25.",
    assertionIds: ["work"]
  };
  story.referencedFacts = packet.facts.filter((fact) => fact.assertionId === "work")
    .map((fact) => ({ assertionId: fact.assertionId, fingerprint: fact.fingerprint }));
  story.contentHash = storyContentHash(story.paragraphs);
  assert.ok(validateLifeStory(story, packet).some((problem) => /without an established birth event/.test(problem)));
});

// A stand-in for the direct Messages API; no real credentials or billing in tests.
function claudeReplying(outputs, calls = []) {
  return { request: async (request) => {
    calls.push({ request, input: JSON.parse(request.messages[0].content) });
    const output = outputs.shift();
    return output instanceof Error ? Promise.reject(output)
      : { stop_reason: "end_turn", content: output == null ? [] : [{ type: "text", text: JSON.stringify(output) }] };
  } };
}

test("generation uses direct tool-free API calls and an independent verifier", async () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  const calls = [];
  const client = claudeReplying([
    { paragraphs: [{ text: "Person was born in 1900 and worked as a clerk.", assertionIds: ["birth", "work"] }] },
    { pass: true, problems: [] }
  ], calls);
  const story = await generateVerifiedStory({ client, packet, now: () => new Date("2026-07-15T12:00:00.000Z") });
  assert.equal(calls.length, 2);
  for (const { request } of calls) {
    assert.equal(request.model, "claude-opus-5-5");
    assert.equal(request.output_config.effort, "high");
    assert.equal(request.output_config.format.type, "json_schema");
    assert.equal(request.max_tokens, 8192);
    assert.deepEqual(request.thinking, { type: "adaptive" });
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].role, "user");
  }
  assert.deepEqual(calls[0].request.output_config.format.schema.required, ["paragraphs"]);
  assert.deepEqual(calls[1].request.output_config.format.schema.required, ["pass", "problems"]);
  assert.match(calls[0].request.system, /the way a relative would/);
  assert.match(calls[0].request.system, /never a baptism/);
  assert.deepEqual(calls[1].input.facts, packet.facts);
  assert.ok(calls[1].input.draft);
  assert.equal(story.generation.provider, "anthropic");
  assert.equal(story.generation.transport, "messages-api");
  assert.equal(story.verification.passed, true);
});

test("API setup fails closed without a credential and never falls back to a subscription", async () => {
  const calls = [];
  const client = anthropicApiClient({ run: async (mode) => { calls.push(mode); return { configured: false }; } });
  await assert.rejects(client.assertConfigured(), /No subscription fallback/);
  assert.deepEqual(calls, ["status"]);
  const configured = anthropicApiClient({ run: async (mode, request) => {
    calls.push(mode);
    return mode === "status" ? { configured: true } : request;
  } });
  await configured.assertConfigured();
  assert.deepEqual(await configured.request({ model: "test" }), { model: "test" });
  assert.deepEqual(calls, ["status", "status", "invoke"]);
});

test("authentication or credit errors stop generation without retries or fallback", async () => {
  let requests = 0;
  const client = { request: async () => {
    requests++;
    throw new Error("Life-story API request failed (HTTP 401); previous stories are retained");
  } };
  await assert.rejects(generateVerifiedStory({ client, packet: buildLifeStoryPacket(fixtureStore(), "person") }), /HTTP 401/);
  assert.equal(requests, 1);
});

test("Windows API bridge rejects malformed requests without leaking their content", (t) => {
  const sentinel = "PRIVATE-TEST-DATA-MUST-NOT-BE-LOGGED";
  const result = spawnSync("powershell.exe", [
    "-WindowStyle", "Hidden", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "tools/life-stories-api-windows.ps1", "-Mode", "invoke"
  ], { cwd: new URL("..", import.meta.url), input: JSON.stringify({ model: "forbidden", secret: sentinel }), encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("Windows credential bridge is unavailable on this platform"); return; }
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { error: "life-story-api-failed", httpStatus: 0 });
  assert.equal(result.stderr, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
});

test("Windows API bridge returns non-ASCII story text intact as UTF-8", async (t) => {
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"]);
  if (probe.error?.code === "ENOENT") { t.skip("Windows credential bridge is unavailable on this platform"); return; }
  const result = await runApiBridge("utf8-selftest");
  assert.deepEqual(result.content, [{ type: "text", text: "Schömberg, Bürger, Jäger, Württemberg" }]);
  assert.equal(result.stop_reason, "end_turn");
});

test("an invalid draft receives one repair and is then reverified", async () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  const outputs = [
    { paragraphs: [{ text: "Person Example was a decorated soldier.", assertionIds: ["not-allowed"] }] },
    { paragraphs: [{ text: "Person worked as a clerk.", assertionIds: ["work"] }] },
    { pass: true, problems: [] }
  ];
  const story = await generateVerifiedStory({ client: claudeReplying(outputs), packet });
  assert.equal(story.paragraphs[0].text, "Person worked as a clerk.");
  assert.equal(outputs.length, 0);
});

test("refusals or empty responses fail without producing a shard", async () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([null]), packet }), /contained no structured output/);
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([{ paragraphs: [] }]), packet }), /did not match its schema/);
  const replying = (result) => ({ request: async () => result });
  await assert.rejects(generateVerifiedStory({ client: replying({ stop_reason: "refusal" }), packet }), /was declined/);
  await assert.rejects(generateVerifiedStory({ client: replying({ stop_reason: "max_tokens" }), packet }), /was cut off/);
  await assert.rejects(generateVerifiedStory({ client: replying({ stop_reason: "tool_use" }), packet }), /did not complete/);
  await assert.rejects(generateVerifiedStory({ client: replying({ stop_reason: "end_turn", content: [{ type: "text", text: "not JSON" }] }), packet }), /invalid JSON/);
});

test("new drafts must read as a life, not a record, while older stored stories stay publishable", async () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  const problems = (text) => draftVoiceProblems([{ text, assertionIds: ["work"] }]);
  assert.ok(problems("The 1900 census lists Person as a clerk.").some((problem) => /census/.test(problem)));
  assert.ok(problems("Person worked as a clerk and is now deceased.").some((problem) => /filler/.test(problem)));
  assert.ok(problems("word ".repeat(120)).some((problem) => /words/.test(problem)));
  assert.ok(problems("Her family's roots were in England.").some((problem) => /roots/.test(problem)));
  assert.ok(problems("He was described as a yeoman.").some((problem) => /described as/.test(problem)));
  assert.deepEqual(problems("Person worked as a clerk."), []);
  // A story written under an earlier recipe in the old voice is stale, not invalid.
  const older = storyFor(packet);
  older.recipeFingerprint = "an-earlier-recipe";
  assert.deepEqual(lifeStoryStatus(older, packet), { status: "stale", publishable: true, problems: [] });
});

test("packets carry children's births for historical relatives and parents' deaths in childhood", () => {
  const store = fixtureStore();
  const relative = (personId, assertions) => ({
    personId, privacy: "private",
    presentation: { displayNameAssertionId: `${personId}-name`, detailAssertionIds: [], treeParentAssertionIds: [], biographyFacts: [], placeRows: [], noteBlocks: [] },
    assertions
  });
  store.people.push(
    relative("child", [
      assertion("child-parent", { kind: "parentage", childId: "child", parentId: "person", role: "father" }, "Person Example is Child Example's father."),
      assertion("child-birth", { kind: "event", subjectType: "person", subjectId: "child", eventType: "birth", dateText: "1925" }, "Child Example was born in 1925."),
      assertion("child-status", { kind: "life-status", personId: "child", value: "deceased" }, "Child Example has died.")
    ]),
    relative("living-child", [
      assertion("living-parent", { kind: "parentage", childId: "living-child", parentId: "person", role: "father" }, "Person Example is Living Example's father."),
      assertion("living-birth", { kind: "event", subjectType: "person", subjectId: "living-child", eventType: "birth", dateText: "1950" }, "Living Example was born in 1950."),
      assertion("living-status", { kind: "life-status", personId: "living-child", value: "living" }, "Living Example is living.")
    ]),
    relative("father", [
      assertion("own-parent", { kind: "parentage", childId: "person", parentId: "father", role: "father" }, "Father Example is Person Example's father."),
      assertion("father-death", { kind: "event", subjectType: "person", subjectId: "father", eventType: "death", dateText: "1899" }, "Father Example died in 1899.")
    ]),
    relative("mother", [
      assertion("own-mother", { kind: "parentage", childId: "person", parentId: "mother", role: "mother" }, "Mother Example is Person Example's mother."),
      assertion("mother-death", { kind: "event", subjectType: "person", subjectId: "mother", eventType: "death", dateText: "1950" }, "Mother Example died in 1950.")
    ])
  );
  const facts = new Map(buildLifeStoryPacket(store, "person").facts.map((fact) => [fact.assertionId, fact]));
  assert.deepEqual(facts.get("child-birth").bases, ["child-life"]);
  assert.deepEqual(facts.get("child-parent").bases, ["child"]);
  assert.deepEqual(facts.get("father-death").bases, ["parent-life"]);
  // A parent's death in the person's adult life is the parent's story, not theirs.
  assert.ok(!facts.has("mother-death"));
  assert.ok(!facts.has("living-birth") && !facts.has("living-parent"));
  // Someone known only through relatives' facts still has no story to tell.
  store.people[0].assertions.forEach((item) => { item.assessment = "candidate"; });
  assert.equal(lifeStoryStatus(undefined, buildLifeStoryPacket(store, "person")).status, "unavailable");
});

test("one index serves every person's packet without walking the store again", () => {
  const store = fixtureStore();
  const relative = (personId, assertions) => ({
    personId, privacy: "private",
    presentation: { displayNameAssertionId: `${personId}-name`, detailAssertionIds: [], treeParentAssertionIds: [], biographyFacts: [], placeRows: [], noteBlocks: [] },
    assertions
  });
  store.people.push(
    relative("child", [
      assertion("child-parent", { kind: "parentage", childId: "child", parentId: "person", role: "father" }, "Person Example is Child Example's father."),
      assertion("child-birth", { kind: "event", subjectType: "person", subjectId: "child", eventType: "birth", dateText: "1925" }, "Child Example was born in 1925."),
      assertion("child-status", { kind: "life-status", personId: "child", value: "deceased" }, "Child Example has died.")
    ]),
    relative("father", [
      assertion("own-parent", { kind: "parentage", childId: "person", parentId: "father", role: "father" }, "Father Example is Person Example's father."),
      assertion("father-death", { kind: "event", subjectType: "person", subjectId: "father", eventType: "death", dateText: "1899" }, "Father Example died in 1899.")
    ])
  );
  store.unions = [{
    unionId: "own", personIds: ["person", "spouse"],
    presentation: { unionAssertionId: "own-union", eventAssertionIds: ["own-wedding"] },
    assertions: [
      assertion("own-union", { kind: "union", unionId: "own" }, "Person Example and Spouse Example were a couple."),
      assertion("own-wedding", { kind: "event", subjectType: "union", subjectId: "own", eventType: "marriage", dateText: "1924" }, "They married in 1924.")
    ]
  }, {
    unionId: "parents", personIds: ["father", "mother"],
    presentation: { unionAssertionId: "parents-union", eventAssertionIds: [] },
    assertions: [assertion("parents-union", { kind: "union", unionId: "parents" }, "Father Example and Mother Example were a couple.")]
  }];
  store.sources = [{ id: "source", title: "Register" }, { id: "elsewhere", title: "Another register" }];
  store.acquisitionTargets = [
    { id: "unrelated", sourceId: "elsewhere", sha256: "first" },
    { id: "by-source", sourceId: "source", sha256: "second" },
    { id: "source", sha256: "third" }
  ];

  // A packet built from a shared index is the packet the person gets alone.
  const index = buildLifeStoryIndex(store);
  const alone = new Map(store.people.map(({ personId }) => [personId, buildLifeStoryPacket(store, personId)]));
  for (const [personId, packet] of alone) assert.deepEqual(buildLifeStoryPacket(store, personId, index), packet);
  const facts = new Map(alone.get("person").facts.map((fact) => [fact.assertionId, fact]));
  assert.deepEqual(facts.get("own-union").bases, ["relationship"]);
  assert.deepEqual(facts.get("own-wedding").bases, ["relationship-event"]);
  assert.deepEqual(facts.get("child-birth").bases, ["child-life"]);
  assert.deepEqual(facts.get("father-death").bases, ["parent-life"]);
  assert.ok(!facts.has("parents-union"), "another couple's union is not this person's fact");

  // The evidence fingerprint follows the cited source and the targets that hold it,
  // by source or by their own id, and nothing else.
  const evidenceAfter = (change) => {
    const changed = structuredClone(store);
    change(changed);
    return buildLifeStoryPacket(changed, "person", buildLifeStoryIndex(changed)).evidenceFingerprint;
  };
  const evidence = alone.get("person").evidenceFingerprint;
  assert.equal(evidenceAfter(() => {}), evidence);
  assert.notEqual(evidenceAfter((changed) => { changed.sources[0].title = "Register, volume 2"; }), evidence);
  assert.equal(evidenceAfter((changed) => { changed.sources[1].title = "Another register, volume 2"; }), evidence);
  assert.equal(evidenceAfter((changed) => { changed.acquisitionTargets[0].sha256 = "replaced"; }), evidence);
  assert.notEqual(evidenceAfter((changed) => { changed.acquisitionTargets[1].sha256 = "replaced"; }), evidence);
  assert.notEqual(evidenceAfter((changed) => { changed.acquisitionTargets[2].sha256 = "replaced"; }), evidence);

  // An index belongs to the store it was built from.
  assert.throws(() => buildLifeStoryPacket(structuredClone(store), "person", index), /different store/);

  // With the index in hand a packet reads nothing from the store's lists. Each of
  // them once cost a whole pass per person, which made a projection of every person
  // grow with people x assertions.
  for (const list of ["people", "unions", "kinships", "sources", "acquisitionTargets"]) {
    Object.defineProperty(store, list, { get() { throw new Error(`a packet walked store.${list}`); } });
  }
  for (const [personId, packet] of alone) assert.deepEqual(buildLifeStoryPacket(store, personId, index), packet);
});

test("a place abroad is named with its country, which the draft is given", async () => {
  const store = fixtureStore();
  store.people[0].assertions.push(assertion("home", { kind: "place-association", personId: "person", placeRole: "residence", value: "Wootton" }, "Person Example lived in Wootton."));
  store.people[0].presentation.placeRows.push({ assertionIds: ["home"], country: "England" });
  const packet = buildLifeStoryPacket(store, "person");
  const calls = [];
  const client = claudeReplying([
    { paragraphs: [{ text: "Person lived in Wootton.", assertionIds: ["home"] }] },
    { paragraphs: [{ text: "Person lived in Wootton, England.", assertionIds: ["home"] }] },
    { pass: true, problems: [] }
  ], calls);
  const story = await generateVerifiedStory({ client, packet });
  assert.equal(story.paragraphs[0].text, "Person lived in Wootton, England.");
  assert.equal(calls[0].input.facts.find((fact) => fact.assertionId === "home").country, "England");
  assert.ok(calls[1].input.repair.problems.some((problem) => /England/.test(problem)));
});

test("American story places require their supplied state and an explicit country", async () => {
  const store = fixtureStore();
  store.people[0].assertions.push(assertion("home", { kind: "place-association", personId: "person", placeRole: "residence", value: "East Marlborough" }, "Person Example lived in East Marlborough in Chester County."));
  store.people[0].presentation.placeRows.push({ assertionIds: ["home"], name: "East Marlborough", state: "Pennsylvania", country: "United States" });
  const packet = buildLifeStoryPacket(store, "person");
  const calls = [];
  const draft = (text) => ({ paragraphs: [{ text, assertionIds: ["home"] }] });
  const client = claudeReplying([
    draft("Person lived in East Marlborough in Chester County."),
    draft("Person lived in East Marlborough, Pennsylvania."),
    draft("Person lived in East Marlborough, Pennsylvania, in what is now the USA."),
    { pass: true, problems: [] }
  ], calls);
  const story = await generateVerifiedStory({ client, packet });
  assert.match(story.paragraphs[0].text, /Pennsylvania, in what is now the USA/);
  assert.deepEqual(calls[0].input.facts.find((fact) => fact.assertionId === "home").places,
    [{ name: "East Marlborough", state: "Pennsylvania", country: "United States" }]);
  assert.ok(calls[1].input.repair.problems.some((problem) => /full state Pennsylvania/.test(problem)));
  assert.ok(calls[2].input.repair.problems.some((problem) => /USA/.test(problem)));
});

test("a life fact that locates its own place lets the story name the country there", async () => {
  const store = fixtureStore();
  store.people[0].assertions.push(assertion("garden", {
    kind: "life-fact", personId: "person", category: "residence", value: "Lived at Wroxall, working as a market gardener", place: "Wroxall, Isle of Wight", country: "England"
  }, "Person Example lived at Wroxall on the Isle of Wight, working as a market gardener."));
  store.people[0].assertions.push(assertion("shop", {
    kind: "life-fact", personId: "person", category: "business", value: "Kept a hardware store", place: "Waterville, Ohio", state: "Ohio", country: "United States"
  }, "Person Example kept a hardware store at Waterville."));
  store.people[0].presentation.biographyFacts.push({ assertionId: "garden", prominence: "core" }, { assertionId: "shop", prominence: "core" });
  const packet = buildLifeStoryPacket(store, "person");
  const fact = (id) => packet.facts.find((item) => item.assertionId === id);
  assert.equal(fact("garden").country, "England");
  assert.deepEqual(fact("garden").places, [{ name: "Wroxall, Isle of Wight", country: "England" }]);
  assert.deepEqual(fact("shop").places, [{ name: "Waterville, Ohio", state: "Ohio", country: "United States" }]);
  assert.equal(Object.hasOwn(fact("work"), "country"), false, "a fact with no place of its own gains nothing");

  const calls = [];
  const client = claudeReplying([
    { paragraphs: [{ text: "Person lived at Wroxall, working as a market gardener.", assertionIds: ["garden"] }] },
    { paragraphs: [{ text: "Person lived at Wroxall, England, working as a market gardener.", assertionIds: ["garden"] }] },
    { pass: true, problems: [] }
  ], calls);
  const story = await generateVerifiedStory({ client, packet });
  assert.match(story.paragraphs[0].text, /Wroxall, England/);
  assert.ok(calls[1].input.repair.problems.some((problem) => /England/.test(problem)), "the draft is asked to name the country the fact supplies");

  const bad = (claim) => validateLifeFact(assertion("x", { kind: "life-fact", personId: "person", category: "residence", value: "Lived there", ...claim }, "x"));
  assert.deepEqual(bad({ place: "Wroxall", country: "England" }), []);
  assert.deepEqual(bad({ place: "Waterville, Ohio", state: "Ohio", country: "United States" }), []);
  assert.ok(bad({ country: "England" }).some((problem) => /add place/.test(problem)));
  assert.ok(bad({ place: "Wroxall", state: "Hampshire", country: "England" }).some((problem) => /state is for a place in the United States/.test(problem)));
  assert.ok(bad({ place: "Wroxall", country: "" }).some((problem) => /country must be a non-empty string/.test(problem)));
});

test("a family-origin label is shown in the tree but never told as part of a life", () => {
  const store = fixtureStore();
  store.people[0].assertions.push(assertion("origin", { kind: "ancestry-origin", personId: "person", value: "England" }, "England is the documented family origin for Person Example."));
  store.people[0].presentation.detailAssertionIds.push("origin");
  const facts = new Map(buildLifeStoryPacket(store, "person").facts.map((fact) => [fact.assertionId, fact]));
  assert.equal(facts.get("origin").usableInStory, false);
  assert.equal(facts.get("work").usableInStory, true);
});

function failedRefreshFixture() {
  const store = fixtureStore();
  store.sources = [{ id: "source", reference: "original" }];
  store.acquisitionTargets = [{ id: "source", sha256: "original-hash" }];
  const previous = storyFor(buildLifeStoryPacket(store, "person"));
  store.people[0].assertions.find((item) => item.id === "work").conclusion = "Person Example worked as a teacher.";
  const packet = buildLifeStoryPacket(store, "person");
  return { store, previous, packet, retained: retainFailedLifeStory(previous, packet) };
}

test("a bound failed refresh preserves the previous shard and withholds its prose", () => {
  const { previous, packet, retained } = failedRefreshFixture();
  const { refreshFailure, ...preserved } = retained;
  assert.deepEqual(preserved, previous);
  assert.equal(lifeStoryStatus(previous, packet).status, "invalidated");
  assert.equal(lifeStoryStatus(retained, packet).status, "refresh-failed");
  assert.equal(lifeStoryStatus(retained, packet).publishable, false);
  assert.deepEqual(projectLifeStory(retained, packet), { status: "refresh-failed", paragraphs: [] });
  assert.ok(validateLifeStory(retained, packet).length, "generation validation remains strict");
  assert.equal(retainFailedLifeStory(undefined, packet), undefined);
});

test("failed optional regeneration leaves an independently valid previous story publishable", () => {
  const store = fixtureStore();
  const originalPacket = buildLifeStoryPacket(store, "person");
  const previous = storyFor(originalPacket);
  assert.equal(lifeStoryStatus(retainFailedLifeStory(previous, originalPacket), originalPacket).status, "fresh");
  store.people[0].assertions.push(assertion("award", { kind: "life-fact" }, "Person Example received an award."));
  store.people[0].presentation.detailAssertionIds.push("award");
  const packet = buildLifeStoryPacket(store, "person");
  const retained = retainFailedLifeStory(previous, packet);
  assert.deepEqual(lifeStoryStatus(retained, packet), { status: "stale", publishable: true, problems: [] });
  retained.refreshFailure.inputFingerprint = "expired";
  assert.equal(lifeStoryStatus(retained, packet).publishable, true, "no exemption is needed for valid prose");
});

test("a failed refresh after a fact downgrade retains but never displays the old story", () => {
  const store = fixtureStore();
  const previous = storyFor(buildLifeStoryPacket(store, "person"));
  store.people[0].assertions.find((fact) => fact.id === "birth").assessment = "candidate";
  const packet = buildLifeStoryPacket(store, "person");
  const retained = retainFailedLifeStory(previous, packet, { reason: "verification-failed" });
  assert.equal(lifeStoryStatus(previous, packet).status, "invalidated");
  assert.equal(lifeStoryStatus(retained, packet).status, "refresh-failed");
  assert.deepEqual(projectLifeStory(retained, packet), { status: "refresh-failed", paragraphs: [] });
  assert.ok(validateLifeStory(retained, packet).length, "new drafts still cannot cite candidate facts");
  retained.refreshFailure.evidenceFingerprint = "expired";
  assert.equal(lifeStoryStatus(retained, packet).status, "invalidated");
});

test("a failed-refresh receipt survives acquisition attempts but not a changed record", () => {
  const store = fixtureStore();
  store.acquisitionTargets = [{
    id: "source", sourceId: "source", reference: "Register entry", sha256: "a".repeat(64), status: "needs-interactive-sign-in",
    routes: [{ id: "route", status: "needs-interactive-sign-in", attempts: [{ outcome: "needs-interactive-sign-in", attemptedAt: "2026-07-30T00:00:00Z" }] }]
  }];
  const previous = storyFor(buildLifeStoryPacket(store, "person"));
  store.people[0].assertions.find((fact) => fact.id === "birth").assessment = "candidate";
  const retained = retainFailedLifeStory(previous, buildLifeStoryPacket(store, "person"), { reason: "verification-failed" });
  const target = store.acquisitionTargets[0];
  target.status = "ready-download";
  target.routes[0].status = "ready-download";
  target.routes[0].attempts.push({ outcome: "ready-download", attemptedAt: "2026-10-07T00:00:00Z", note: "Access gate reopened" });
  assert.equal(lifeStoryStatus(retained, buildLifeStoryPacket(store, "person")).status, "refresh-failed");
  target.sha256 = "b".repeat(64);
  assert.equal(lifeStoryStatus(retained, buildLifeStoryPacket(store, "person")).status, "invalidated");
});

test("a failed refresh acknowledges a removed prior fact without displaying its old prose", () => {
  const store = fixtureStore();
  const previous = storyFor(buildLifeStoryPacket(store, "person"));
  store.people[0].assertions.find((fact) => fact.id === "birth").assessment = "rejected";
  store.people[0].presentation.detailAssertionIds = store.people[0].presentation.detailAssertionIds
    .filter((id) => id !== "birth");
  const packet = buildLifeStoryPacket(store, "person");
  assert.ok(!packet.facts.some((fact) => fact.assertionId === "birth"));
  assert.equal(lifeStoryStatus(previous, packet).status, "invalidated");
  const retained = retainFailedLifeStory(previous, packet, { reason: "verification-failed" });
  assert.equal(lifeStoryStatus(retained, packet).status, "refresh-failed");
  assert.deepEqual(projectLifeStory(retained, packet), { status: "refresh-failed", paragraphs: [] });
  assert.ok(validateLifeStory(retained, packet).length, "generation validation still rejects removed facts");
  retained.refreshFailure.inputFingerprint = "expired";
  assert.equal(lifeStoryStatus(retained, packet).status, "invalidated");
});

test("failure receipts expire when inputs, evidence, source masters, or retained provenance change", () => {
  const mutations = [
    ({ store }) => { store.people[0].assertions[2].conclusion += " Later."; },
    ({ store }) => { store.people[0].assertions[2].evidence[0].rationale = "revised"; },
    ({ store }) => { store.sources[0].reference = "replacement"; },
    ({ store }) => { store.acquisitionTargets[0].sha256 = "replacement-hash"; },
    ({ retained }) => { retained.refreshFailure.recipeFingerprint = "different"; },
    ({ retained }) => { retained.generation.generatedAt = "2026-08-01T00:00:00Z"; },
    ({ retained }) => { retained.verification.model = "different"; },
    ({ retained }) => { retained.referencedFacts[0].fingerprint = "different"; },
    ({ retained }) => { retained.paragraphs[0].text += " A new sentence."; retained.contentHash = storyContentHash(retained.paragraphs); }
  ];
  for (const mutate of mutations) {
    const fixture = failedRefreshFixture();
    mutate(fixture);
    assert.equal(lifeStoryStatus(fixture.retained, buildLifeStoryPacket(fixture.store, "person")).status, "invalidated");
  }
  const fixture = failedRefreshFixture();
  fixture.store.sources.push({ id: "unrelated", reference: "unrelated" });
  assert.equal(lifeStoryStatus(fixture.retained, buildLifeStoryPacket(fixture.store, "person")).status, "refresh-failed");
});

test("even newly bound receipts cannot waive prose, support, structure, or verification errors", () => {
  for (const mutate of [
    (story) => { story.paragraphs[0].text = "Person Example may have worked as a clerk."; },
    (story) => { story.paragraphs[0] = { text: "Person Example married at age 25.", assertionIds: ["work"] }; },
    (story) => { story.paragraphs[0].assertionIds.push("missing"); },
    (story) => { story.referencedFacts = []; },
    (story) => { story.schemaVersion = 2; },
    (story) => { story.verification.passed = false; }
  ]) {
    const { previous, packet } = failedRefreshFixture();
    mutate(previous);
    previous.contentHash = storyContentHash(previous.paragraphs);
    assert.equal(lifeStoryStatus(retainFailedLifeStory(previous, packet), packet).status, "invalidated");
  }
});

test("a successful refresh replaces the failure receipt; failed verification gets two repairs", async () => {
  const { packet } = failedRefreshFixture();
  const married = { paragraphs: [{ text: "Person married at age 25.", assertionIds: ["work"] }] };
  const calls = [];
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([married, married, married], calls), packet }), /verification failed/);
  assert.equal(calls.length, 3);
  const client = claudeReplying([
    { paragraphs: [{ text: "Person worked as a teacher.", assertionIds: ["work"] }] },
    { pass: true, problems: [] }
  ]);
  const fresh = await generateVerifiedStory({ client, packet });
  assert.equal(fresh.refreshFailure, undefined);
  assert.equal(lifeStoryStatus(fresh, packet).status, "fresh");
});

// ---- The fuller story for a person's own page (two-tier shape) ----

function fullerStore() {
  const store = fixtureStore();
  const person = store.people[0];
  const life = (id, value, extra = {}) => {
    person.assertions.push(assertion(id, { kind: "life-fact", personId: "person", category: "residence", value, ...extra }, `Person Example ${value.toLowerCase()}.`));
    person.presentation.biographyFacts.push({ assertionId: id, prominence: "supporting" });
  };
  life("home-1920", "Lived on Mill Lane");
  life("home-1930", "Lived on Church Street");
  life("house", "Owned a house free of mortgage", { category: "property" });
  life("school", "Attended school", { category: "education" });
  return store;
}

const fullerDraft = () => ({ paragraphs: [
  { text: "Person was born in 1900 and attended school.", assertionIds: ["birth", "school"] },
  { text: "Person worked as a clerk and lived on Mill Lane.", assertionIds: ["work", "home-1920"] },
  { text: "Person afterwards lived on Church Street and owned a house free of mortgage.", assertionIds: ["home-1930", "house"] },
  { text: "Person kept to that work.", assertionIds: ["work"] }
] });

test("the short-story instructions are pinned and the fuller ones differ only where they must", () => {
  // Changing the short prompt is a deliberate act: bump lifeStoryRecipe.promptVersion and this hash together.
  const short = draftInstructionsFor("short");
  assert.equal(crypto.createHash("sha256").update(short).digest("hex"),
    "2779f9da42020252a4eab83dfb59a196c57b679a46d65d528dad807cc0e4cac0");
  assert.equal(draftInstructionsFor(), short);
  const full = draftInstructionsFor("full");
  assert.match(full, new RegExp(`150 to 300 words in three to five short paragraphs, never more than ${fullStoryRecipe.draftMaxWords}`));
  assert.doesNotMatch(full, /30 to 70 words|small e-ink display in the family's home\. Relatives|at most one or two children/);
  assert.match(full, /Giuseppe died in Barre in 1931/);
  assert.doesNotMatch(short, /fuller|Giuseppe died in Barre/);
  // The accuracy rules are shared word for word.
  const accuracy = (text) => text.slice(text.indexOf("Accuracy (these rules override the voice):"));
  assert.equal(accuracy(full), accuracy(short));

  // The independent check is the short story's own, plus how the fuller one treats a
  // place that no fact locates. The short check is pinned like its prompt.
  const check = verifierInstructionsFor("short");
  assert.equal(crypto.createHash("sha256").update(check).digest("hex"), "e116f4f76ce7f558fc66923ab2f671edc9cd9a38fde0e98bedf057706d5a1985");
  assert.equal(verifierInstructionsFor(), check);
  const fullCheck = verifierInstructionsFor("full");
  assert.ok(fullCheck.startsWith(`${check} `));
  assert.match(fullCheck, /named as the fact names it, with no country/);
  assert.match(full, /add no country, county or state of your own/);
  assert.doesNotMatch(short, /add no country, county or state of your own/);
});

test("a fuller story is written under its own recipe, limits and tier", async () => {
  const packet = buildLifeStoryPacket(fullerStore(), "person");
  assert.equal(fullStoryEligible(packet), true, `${FULL_STORY_MIN_OWN_FACTS} own facts are enough`);
  assert.equal(fullStoryEligible(buildLifeStoryPacket(fixtureStore(), "person")), false, "two facts leave nothing more to tell");

  const calls = [];
  const client = claudeReplying([fullerDraft(), { pass: true, problems: [] }], calls);
  const story = await generateVerifiedStory({ client, packet, tier: "full", now: () => new Date("2026-11-18T05:00:00.000Z") });
  assert.equal(story.tier, "full");
  assert.equal(story.paragraphs.length, 4);
  assert.equal(story.recipeFingerprint, fullStoryRecipeFingerprint);
  assert.notEqual(fullStoryRecipeFingerprint, lifeStoryRecipeFingerprint);
  assert.equal(story.generation.promptVersion, fullStoryRecipe.promptVersion);
  assert.match(calls[0].request.system, /this is the fuller telling/);
  assert.equal(calls[1].request.system, verifierInstructionsFor("full"), "the fuller story is checked under its own instructions");
  // The reply schema allows five paragraphs here and three for the short story.
  const six = { paragraphs: [...fullerDraft().paragraphs, ...fullerDraft().paragraphs.slice(0, 2)] };
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([six]), packet, tier: "full" }), /did not match its schema/);
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([fullerDraft()]), packet }), /did not match its schema/);
  assert.deepEqual(validateLifeStory(story, packet, "full"), []);
  assert.equal(lifeStoryStatus(story, packet, "full").status, "fresh");

  // Each tier refuses the other's file, so a misfiled story is never shown.
  assert.ok(validateLifeStory(story, packet).some((problem) => /wrong tier|one to three paragraphs/.test(problem)));
  const short = await generateVerifiedStory({ client: claudeReplying([
    { paragraphs: [{ text: "Person was born in 1900 and worked as a clerk.", assertionIds: ["birth", "work"] }] }, { pass: true, problems: [] }
  ]), packet });
  assert.equal(Object.hasOwn(short, "tier"), false, "the short story's file keeps its shape");
  assert.ok(validateLifeStory(short, packet, "full").some((problem) => /wrong tier/.test(problem)));

  // Length: four paragraphs and 120 words suit the fuller tier and are refused for the short one.
  const long = [0, 1, 2, 3].map(() => ({ text: Array(30).fill("word").join(" "), assertionIds: ["work"] }));
  assert.deepEqual(draftVoiceProblems(long, "full"), []);
  assert.ok(draftVoiceProblems(long).some((problem) => /keep it under 90/.test(problem)));
  assert.ok(draftVoiceProblems(long).some((problem) => /at most two paragraphs/.test(problem)));
  const tooLong = [0, 1, 2, 3, 4, 5].map(() => ({ text: Array(60).fill("word").join(" "), assertionIds: ["work"] }));
  assert.ok(draftVoiceProblems(tooLong, "full").some((problem) => new RegExp(`keep it under ${fullStoryRecipe.draftMaxWords}`).test(problem)));
  assert.ok(draftVoiceProblems(tooLong, "full").some((problem) => /at most 5 paragraphs/.test(problem)));
  // The voice rules are the same in both tiers.
  assert.ok(draftVoiceProblems([{ text: "The census recorded him as a clerk.", assertionIds: ["work"] }], "full").length);
});

test("the page gets the fuller story only while its facts hold, and the short story is untouched", async () => {
  const store = fullerStore();
  const packet = buildLifeStoryPacket(store, "person");
  const short = storyFor(packet);
  const full = await generateVerifiedStory({ client: claudeReplying([fullerDraft(), { pass: true, problems: [] }]), packet, tier: "full" });

  assert.deepEqual(projectLifeStory(short, packet), { status: "fresh", paragraphs: [short.paragraphs[0].text] });
  assert.deepEqual(projectLifeStory(short, packet, full),
    { status: "fresh", paragraphs: [short.paragraphs[0].text], full: full.paragraphs.map((paragraph) => paragraph.text) });

  // A new fact the fuller story does not tell leaves it publishable (stale).
  store.people[0].assertions.push(assertion("award", { kind: "life-fact", personId: "person", category: "achievement", value: "Received an award" }, "Person Example received an award."));
  store.people[0].presentation.biographyFacts.push({ assertionId: "award", prominence: "supporting" });
  const grown = buildLifeStoryPacket(store, "person");
  assert.deepEqual(lifeStoryStatus(full, grown, "full"), { status: "stale", publishable: true, problems: [] });
  assert.equal(projectLifeStory(short, grown, full).full.length, 4);

  // A fact it tells changes: the fuller story is withheld and the short one stands alone.
  store.people[0].assertions.find((item) => item.id === "house").conclusion = "Person Example rented a house.";
  const changed = buildLifeStoryPacket(store, "person");
  assert.equal(lifeStoryStatus(full, changed, "full").publishable, false);
  const projected = projectLifeStory(short, changed, full);
  assert.equal(Object.hasOwn(projected, "full"), false);
  assert.deepEqual(projected.paragraphs, [short.paragraphs[0].text], "the short story did not cite the changed fact");
});

test("a fuller draft that fails its check is repaired like a short one, then refused", async () => {
  const packet = buildLifeStoryPacket(fullerStore(), "person");
  const calls = [];
  const bad = { paragraphs: [{ text: "The census recorded Person as a clerk.", assertionIds: ["work"] }] };
  await assert.rejects(generateVerifiedStory({ client: claudeReplying([bad, bad, bad], calls), packet, tier: "full" }), /verification failed: .*describe the life, not the record/);
  assert.equal(calls.length, 1 + fullStoryRecipe.repairs, "one draft and two repairs, no verifier call for a draft that fails locally");
  assert.ok(calls[1].input.repair.problems.some((problem) => /census/.test(problem)));
});

test("a recorded inability to write is told plainly; a hedging could is still refused", () => {
  const store = fixtureStore();
  store.people[0].assertions.push(assertion("mark", { kind: "life-fact", personId: "person", category: "education", value: "Could not write and made her mark" },
    "Person Example could not write her name and made her mark in the register."));
  store.people[0].assertions.push(assertion("guess", { kind: "life-fact", personId: "person", category: "other", value: "Farm" },
    "Person Example could have farmed at Wootton."));
  store.people[0].presentation.biographyFacts.push({ assertionId: "mark", prominence: "core" }, { assertionId: "guess", prominence: "supporting" });
  const packet = buildLifeStoryPacket(store, "person");
  assert.equal(packet.facts.find((fact) => fact.assertionId === "mark").usableInStory, true);
  assert.equal(packet.facts.find((fact) => fact.assertionId === "guess").usableInStory, false);
  const story = (text) => { const paragraphs = [{ text, assertionIds: ["mark"] }];
    return { ...storyFor(packet), paragraphs, referencedFacts: packet.facts.filter((fact) => fact.assertionId === "mark").map((fact) => ({ assertionId: fact.assertionId, fingerprint: fact.fingerprint })), contentHash: storyContentHash(paragraphs) }; };
  assert.deepEqual(validateLifeStory(story("Person could not write, and made her mark when she married."), packet), []);
  assert.deepEqual(validateLifeStory(story("Person could neither read nor write."), packet), []);
  assert.deepEqual(validateLifeStory(story("Person could read and write, and could speak English."), packet), []);
  assert.ok(validateLifeStory(story("Person could have made her mark."), packet).some((problem) => /uncertainty language: could/.test(problem)));
  assert.ok(validateLifeStory(story("Person could not be found in 1851."), packet).some((problem) => /uncertainty language: could/.test(problem)));
});

// ---- Stories written through Claude Code on the plan (18 Nov 2026) ----

test("a story request becomes one tool-free headless Claude Code call", () => {
  const request = { model: "claude-opus-5-5", system: "Write the story.", messages: [{ role: "user", content: "{}" }],
    output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"], description: "{$schema: x}" } } } };
  const args = claudeCodeArgs(request);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.equal(value("--model"), "claude-opus-5-5");
  assert.equal(value("--effort"), "high");
  assert.equal(value("--system-prompt"), "Write the story.");
  assert.equal(value("--tools"), "", "no built-in tools");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
  assert.equal(value("--output-format"), "json");
  assert.deepEqual(JSON.parse(value("--json-schema")), { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] });
  assert.equal(args.some((arg) => /api[-_]?key|bare/i.test(arg)), false, "nothing that would switch the call to an API key");
  assert.throws(() => claudeCodeArgs({ model: "m", system: "s", messages: [] }), /needs a reply schema/);
});

test("a whole story is drafted and checked through Claude Code, and failures never fall back", async () => {
  const packet = buildLifeStoryPacket(fixtureStore(), "person");
  const calls = [];
  const replies = [
    { type: "result", subtype: "success", is_error: false, structured_output: { paragraphs: [{ text: "Person was born in 1900 and worked as a clerk.", assertionIds: ["birth", "work"] }] } },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify({ pass: true, problems: [] }) }
  ];
  const client = claudeCodeClient({ run: async (args, input) => { calls.push({ args, input }); return replies.shift(); } });
  const story = await generateVerifiedStory({ client, packet, now: () => new Date("2026-11-18T09:00:00.000Z") });
  assert.equal(story.paragraphs[0].text, "Person was born in 1900 and worked as a clerk.");
  assert.equal(story.generation.transport, "claude-code-print");
  assert.equal(story.generation.model, "claude-opus-5-5");
  assert.equal(calls.length, 2, "one draft and one independent check");
  assert.equal(calls[0].args[calls[0].args.indexOf("--system-prompt") + 1], draftInstructionsFor("short"));
  assert.equal(calls[1].args[calls[1].args.indexOf("--system-prompt") + 1], verifierInstructionsFor("short"));
  assert.equal(JSON.parse(calls[0].input).person.id, "person");
  assert.deepEqual(validateLifeStory(story, packet), []);

  // A stored API-route story keeps its own transport label.
  const viaApi = await generateVerifiedStory({ client: { ...claudeReplying([
    { paragraphs: [{ text: "Person was born in 1900 and worked as a clerk.", assertionIds: ["birth", "work"] }] }, { pass: true, problems: [] }
  ]) }, packet });
  assert.equal(viaApi.generation.transport, "messages-api");

  // An error result, a plan limit or an empty reply stops the story; nothing else is tried.
  const failing = (reply) => claudeCodeClient({ run: async () => reply });
  await assert.rejects(generateVerifiedStory({ client: failing({ type: "result", subtype: "error_during_execution", is_error: true }), packet }), /did not complete; previous stories are retained/);
  await assert.rejects(generateVerifiedStory({ client: failing({ type: "result", subtype: "success", is_error: false, result: "" }), packet }), /contained no structured output/);
  await assert.rejects(generateVerifiedStory({ client: claudeCodeClient({ run: async () => { throw new Error("Claude Code story request failed; previous stories are retained"); } }), packet }), /previous stories are retained/);
  await assert.rejects(claudeCodeClient({ run: async () => "" }).assertConfigured(), /nothing falls back to the API/);
  await claudeCodeClient({ run: async () => "2.1.327 (Claude Code)" }).assertConfigured();
});
