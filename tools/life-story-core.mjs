import crypto from "node:crypto";
import { assertionMap } from "./research-store.mjs";

export const lifeStoryRecipe = Object.freeze({
  schemaVersion: 1,
  promptVersion: "life-story-v7",
  validatorVersion: "life-story-validator-v7",
  provider: "anthropic",
  transport: "messages-api",
  generatorModel: "claude-opus-5-5",
  verifierModel: "claude-opus-5-5",
  effort: "high",
  // Redrafts after a failed verification before the previous story is kept.
  repairs: 2,
  // Ceiling for any stored story; earlier recipes wrote up to this length.
  maxWords: 350,
  // New drafts are short enough for the TRMNL wall display as well as the viewer.
  draftMaxWords: 90
});

export const lifeStoryRecipeFingerprint = hashValue(lifeStoryRecipe);

// The fuller story shown on a person's own page (LIFE-STORIES-GOAL.md, two-tier shape).
// It is a separate file with its own recipe, so nothing here can change the short
// story, which the wall display reads.
export const fullStoryRecipe = Object.freeze({
  schemaVersion: 1,
  // v2 (17 Nov 2026): a place no fact locates is named as the fact names it, without a country.
  promptVersion: "full-story-v2",
  validatorVersion: "full-story-validator-v2",
  provider: "anthropic",
  transport: "messages-api",
  generatorModel: "claude-opus-5-5",
  verifierModel: "claude-opus-5-5",
  effort: "high",
  repairs: 2,
  maxWords: 350,
  draftMaxWords: 340
});

export const fullStoryRecipeFingerprint = hashValue(fullStoryRecipe);

// A fuller story needs more to tell than the short one already carries.
export const FULL_STORY_MIN_OWN_FACTS = 6;

export const storyTiers = Object.freeze({
  short: Object.freeze({ recipe: lifeStoryRecipe, recipeFingerprint: lifeStoryRecipeFingerprint, storedParagraphs: 3, draftParagraphs: 2 }),
  full: Object.freeze({ recipe: fullStoryRecipe, recipeFingerprint: fullStoryRecipeFingerprint, storedParagraphs: 5, draftParagraphs: 5 })
});

function tierOf(name) {
  const tier = storyTiers[name];
  if (!tier) throw new Error(`unknown story tier: ${name}`);
  return tier;
}

const lowercaseMay = /\bmay\b/;
// "could" hedges ("could have been"), except where it states what the facts record a
// person able or unable to do: "could not write", "could neither read nor write", "could
// read and write", "could speak English". The drafting rules ask for exactly that
// detail ("a couple who could not sign their names").
const uncertaintyLanguage = /\b(?:might|possibly?|perhaps|uncertain|unresolved|unconfirmed|unknown|reportedly|likely|probably|believed|appears|suggests)\b|\bcould\b(?!\s+(?:(?:not|neither|both)\s+)?(?:write|read|sign|speak)\b)|\bnot (?:known|established|confirmed|proved)\b|\bthought to\b|\bremain(?:s)? unproved\b/i;

function matchUncertainty(value) {
  const text = String(value || "");
  return text.match(lowercaseMay) || text.match(uncertaintyLanguage);
}

// Values grouped by key, each remembering its position in the store, so a lookup
// returns exactly what a filter over the whole list would, in the same order.
function groupByKeys(values, keysOf) {
  const groups = new Map();
  values.forEach((value, position) => {
    for (const key of new Set(keysOf(value))) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ position, value });
    }
  });
  return groups;
}

function valuesForKeys(groups, keys) {
  const found = new Map();
  for (const key of keys) for (const entry of groups.get(key) || []) found.set(entry.position, entry.value);
  return [...found].sort((first, second) => first[0] - second[0]).map(([, value]) => value);
}

/**
 * Everything a packet reads from the store that does not depend on the person. A
 * packet built alone makes its own; anything that builds a packet for every person
 * (the projections, the story status, the page-depth report) builds one and passes
 * it in. Without it each packet walked every assertion, union, source and
 * acquisition target, so a projection cost people x assertions: with 915 people and
 * 9,059 assertions on 19 Nov 2026 that was two thirds of every status command.
 * The index describes the store as it was when built: build a new one after
 * changing the store.
 */
export function buildLifeStoryIndex(store) {
  const assertions = assertionMap(store);
  const people = new Map();
  for (const bundle of store.people) if (!people.has(bundle.personId)) people.set(bundle.personId, bundle);
  const family = { children: new Map(), parents: new Map(), events: new Map(), statuses: new Map() };
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const assertion of assertions.values()) {
    const claim = assertion.claim;
    if (!claim || assertion.assessment === "rejected") continue;
    if (claim.kind === "parentage") {
      push(family.children, claim.parentId, assertion);
      push(family.parents, claim.childId, assertion);
    } else if (claim.kind === "event") {
      push(family.events, claim.subjectId, assertion);
    } else if (claim.kind === "life-status") {
      family.statuses.set(claim.personId, assertion);
    }
  }
  return {
    store,
    assertions,
    people,
    family,
    unionsByPerson: groupByKeys(store.unions, (union) => union.personIds),
    sourcesById: groupByKeys(store.sources || [], (source) => [source.id]),
    targetsBySource: groupByKeys(store.acquisitionTargets || [], (target) => [target.sourceId, target.id])
  };
}

export function buildLifeStoryPacket(store, personId, index = buildLifeStoryIndex(store)) {
  if (index.store !== store) throw new Error("life-story index was built from a different store");
  const bundle = index.people.get(personId);
  if (!bundle) throw new Error(`unknown person: ${personId}`);
  const assertions = index.assertions;
  const selected = new Map();
  const prominence = new Map((bundle.presentation?.biographyFacts || [])
    .map((item) => [item.assertionId, item.prominence]));
  const add = (id, basis) => {
    const assertion = assertions.get(id);
    if (!assertion || assertion.assessment === "rejected") return;
    const existing = selected.get(id);
    selected.set(id, { assertion, bases: [...new Set([...(existing?.bases || []), basis])] });
  };

  for (const id of bundle.presentation?.detailAssertionIds || []) add(id, "detail");
  for (const item of bundle.presentation?.biographyFacts || []) add(item.assertionId, "biography");
  // Place rows carry a curated country, which lets a story name it from the facts.
  const placeCountries = new Map();
  const placeAreas = new Map();
  for (const row of bundle.presentation?.placeRows || []) for (const id of row.assertionIds || []) {
    add(id, "place");
    if (row.country) placeCountries.set(id, row.country);
    const areas = placeAreas.get(id) || [];
    areas.push({ ...(row.name ? { name: row.name } : {}), ...(row.state ? { state: row.state } : {}), country: row.country });
    placeAreas.set(id, areas);
  }
  for (const id of bundle.presentation?.treeParentAssertionIds || []) add(id, "relationship");
  for (const id of bundle.presentation?.summaryBlock?.assertionIds || []) add(id, "summary");
  for (const block of bundle.presentation?.noteBlocks || []) for (const id of block.assertionIds || []) add(id, "note");
  for (const union of valuesForKeys(index.unionsByPerson, [personId])) {
    add(union.presentation?.unionAssertionId, "relationship");
    for (const id of union.presentation?.eventAssertionIds || []) add(id, "relationship-event");
  }
  for (const { id, basis } of familyAssertionIds(index.family, personId)) add(id, basis);

  // A life fact may locate its own place ("Wroxall, Isle of Wight" in England), so a
  // story can name the country there as it can for a curated place row.
  const ownArea = (assertion) => assertion.claim?.kind === "life-fact" && assertion.claim.country && assertion.claim.place
    ? { name: assertion.claim.place, ...(assertion.claim.state ? { state: assertion.claim.state } : {}), country: assertion.claim.country }
    : null;
  const facts = [...selected.values()].map(({ assertion, bases }) => ({
    assertionId: assertion.id,
    statement: assertion.conclusion,
    assessment: assertion.assessment,
    factKind: assertion.claim?.kind,
    ...(assertion.claim?.eventType ? { eventType: assertion.claim.eventType } : {}),
    ...(assertion.claim?.placeRole ? { placeRole: assertion.claim.placeRole } : {}),
    ...(placeCountries.has(assertion.id) ? { country: placeCountries.get(assertion.id) }
      : ownArea(assertion) ? { country: ownArea(assertion).country } : {}),
    ...(placeAreas.has(assertion.id) ? { places: placeAreas.get(assertion.id) }
      : ownArea(assertion) ? { places: [ownArea(assertion)] } : {}),
    ...(assertion.limitations ? { limitations: assertion.limitations } : {}),
    bases: bases.sort(),
    prominence: prominence.get(assertion.id) || "supporting",
    // "Family origin: England" is a tree label, not something that happened in a life.
    usableInStory: assertion.assessment === "established"
      && prominence.get(assertion.id) !== "context-only"
      && assertion.claim?.kind !== "ancestry-origin"
      && !matchUncertainty(assertion.conclusion),
    fingerprint: assertionFactFingerprint(assertion)
  })).sort((first, second) => first.assertionId.localeCompare(second.assertionId));
  const displayAssertion = assertions.get(bundle.presentation.displayNameAssertionId);
  const packet = {
    schemaVersion: 1,
    personId,
    displayName: displayAssertion?.claim?.value || personId,
    privacy: bundle.privacy,
    facts
  };
  const evidence = [...selected.values()].map(({ assertion }) => ({
    assertionId: assertion.id, evidence: assertion.evidence || []
  })).sort((a, b) => a.assertionId.localeCompare(b.assertionId));
  const sourceIds = new Set(evidence.flatMap((item) => item.evidence.map((link) => link.sourceId)));
  const sources = valuesForKeys(index.sourcesById, sourceIds)
    .map(withoutFileMetadata).sort((a, b) => a.id.localeCompare(b.id));
  const acquisitions = valuesForKeys(index.targetsBySource, sourceIds)
    .map(acquisitionRecordIdentity).sort((a, b) => a.id.localeCompare(b.id));
  return { ...packet, inputFingerprint: hashValue(packet), evidenceFingerprint: hashValue({ evidence, sources, acquisitions }) };
}

const HISTORICAL_BIRTH_YEAR = 1916;
const CHILDHOOD_YEARS = 16;

/**
 * Facts that place a person in their family: each child's parentage and birth or
 * baptism, and a parent's death or burial while the person was still a child. A
 * parent dying in the person's adult life belongs to the parent's story, not theirs.
 * Relatives who may be living are left out: only those recorded as deceased or born by
 * 1916 contribute facts.
 */
function familyAssertionIds(family, personId) {
  // The parentage, event and life-status lookups come from buildLifeStoryIndex.
  const children = family.children.get(personId) || [];
  const parents = family.parents.get(personId) || [];
  const { events, statuses } = family;
  const lifeEvents = (id, types) => (events.get(id) || []).filter((event) => types.includes(event.claim.eventType));
  const yearOf = (event) => Number(String(event.claim.dateText || "").match(/\b1\d{3}\b/)?.[0]) || null;
  const historical = (id) => statuses.get(id)?.claim.value === "deceased"
    || lifeEvents(id, ["birth", "baptism"]).some((event) =>
      Number(String(event.claim.dateText || "").match(/\b1\d{3}\b/)?.[0]) <= HISTORICAL_BIRTH_YEAR);
  const ids = [];
  for (const link of children) {
    if (!historical(link.claim.childId)) continue;
    ids.push({ id: link.id, basis: "child" });
    for (const event of lifeEvents(link.claim.childId, ["birth", "baptism"])) ids.push({ id: event.id, basis: "child-life" });
  }
  const born = lifeEvents(personId, ["birth", "baptism"]).map(yearOf).find(Boolean);
  const inChildhood = (event) => born && yearOf(event) && yearOf(event) < born + CHILDHOOD_YEARS;
  for (const link of parents) {
    for (const event of lifeEvents(link.claim.parentId, ["death", "burial"]).filter(inChildhood)) {
      ids.push({ id: event.id, basis: "parent-life" });
    }
  }
  return ids;
}

// Wording a new draft must avoid. Stored stories from earlier recipes are not held to
// it, so changing these rules marks old stories stale rather than invalid.
const RECORD_LANGUAGE = /\b(?:census|censuses|register|registers|index card|indexed|entry|entries|columns?|recorded|records?|documented|documents?|certificates?|listed|lists)\b/i;
const FILLER = /\b(?:is|was) (?:now )?deceased\b|\blater died\b/i;
// Phrasing that reads like a form rather than a person talking.
const STOCK = /\b(?:roots|(?:described|listed|named|recorded) as)\b/i;

export function draftVoiceProblems(paragraphs, tierName = "short") {
  const tier = tierOf(tierName);
  const problems = [];
  const text = (paragraphs || []).map((paragraph) => String(paragraph?.text || "")).join(" ");
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > tier.recipe.draftMaxWords) problems.push(`story has ${words} words; keep it under ${tier.recipe.draftMaxWords}`);
  if (paragraphs?.length > tier.draftParagraphs) {
    problems.push(`use at most ${tier.draftParagraphs === 2 ? "two" : tier.draftParagraphs} paragraphs`);
  }
  const record = text.match(RECORD_LANGUAGE);
  if (record) problems.push(`describe the life, not the record: avoid "${record[0]}"`);
  const filler = text.match(FILLER);
  if (filler) problems.push(`remove filler: "${filler[0]}"`);
  const stock = text.match(STOCK);
  if (stock) problems.push(`say it the way a person would: avoid "${stock[0]}"`);
  return problems;
}

// A failed-refresh receipt stays current only while the evidence it was
// checked against is unchanged. Acquisition routes, attempts, gates and queue
// state describe how a record is being pursued, not what it says; hashing them
// meant that recording any acquisition attempt, or reopening a sign-in gate,
// invalidated every receipt citing that record.
const acquisitionOperationalFields = new Set([
  "routes", "status", "priority", "questionIds", "reconciliation", "gate", "gates", "lastAttemptAt", "researchRole"
]);

function acquisitionRecordIdentity(target) {
  return Object.fromEntries(Object.entries(withoutFileMetadata(target))
    .filter(([key]) => !acquisitionOperationalFields.has(key)));
}

function withoutFileMetadata(value) {
  const { __file, ...data } = value;
  return data;
}

function retainedStoryFingerprint(story) {
  const { refreshFailure, ...retained } = withoutFileMetadata(story);
  return hashValue(retained);
}

export function retainFailedLifeStory(story, packet, { attemptedAt = new Date().toISOString(), reason = "generation-failed" } = {}) {
  if (!story) return undefined;
  return {
    ...withoutFileMetadata(story),
    refreshFailure: {
      schemaVersion: 1, personId: packet.personId, attemptedAt, reason,
      inputFingerprint: packet.inputFingerprint,
      evidenceFingerprint: packet.evidenceFingerprint,
      recipeFingerprint: lifeStoryRecipeFingerprint,
      retainedStoryFingerprint: retainedStoryFingerprint(story)
    }
  };
}

function hasCurrentRefreshFailure(story, packet) {
  const failure = story.refreshFailure;
  return failure?.schemaVersion === 1 && failure.personId === packet.personId
    && typeof failure.attemptedAt === "string" && Number.isFinite(Date.parse(failure.attemptedAt))
    && ["generation-failed", "verification-failed"].includes(failure.reason)
    && failure.inputFingerprint === packet.inputFingerprint
    && typeof packet.evidenceFingerprint === "string" && failure.evidenceFingerprint === packet.evidenceFingerprint
    && failure.recipeFingerprint === lifeStoryRecipeFingerprint
    && failure.retainedStoryFingerprint === retainedStoryFingerprint(story);
}

export function assertionFactFingerprint(assertion) {
  return hashValue({
    id: assertion.id,
    assessment: assertion.assessment,
    claim: assertion.claim,
    conclusion: assertion.conclusion,
    limitations: assertion.limitations || null
  });
}

const FAMILY_BASES = new Set(["child", "child-life", "parent-life"]);
const isOwnFact = (fact) => !(fact.bases || []).every((basis) => FAMILY_BASES.has(basis));
const LIFE_KINDS = new Set(["event", "life-fact", "occupation", "place-association"]);

/** Whether the person's own usable facts are enough for a fuller story to add anything. */
export function fullStoryEligible(packet) {
  return packet.facts.filter((fact) => fact.usableInStory && isOwnFact(fact) && LIFE_KINDS.has(fact.factKind)).length
    >= FULL_STORY_MIN_OWN_FACTS;
}

export function lifeStoryStatus(story, packet, tierName = "short") {
  const tier = tierOf(tierName);
  // Relatives' facts only add context: a story needs a usable fact about the person.
  if (!packet.facts.some((fact) => fact.usableInStory && isOwnFact(fact))) {
    return { status: "unavailable", publishable: false, problems: [] };
  }
  if (!story) return { status: "missing", publishable: false, problems: [] };
  const { problems, staleFactProblems } = validateLifeStoryDetails(story, packet, tierName);
  // A failed optional refresh never hides an independently valid previous story.
  // The receipt only acknowledges changed referenced facts; it cannot publish them.
  if (problems.length && problems.length === staleFactProblems.length && hasCurrentRefreshFailure(story, packet)) {
    return { status: "refresh-failed", publishable: false, problems };
  }
  if (problems.length) return { status: "invalidated", publishable: false, problems };
  if (story.inputFingerprint === packet.inputFingerprint
    && story.recipeFingerprint === tier.recipeFingerprint) {
    return { status: "fresh", publishable: true, problems: [] };
  }
  const current = new Map(packet.facts.map((fact) => [fact.assertionId, fact.fingerprint]));
  const invalidated = story.referencedFacts.some((fact) => current.get(fact.assertionId) !== fact.fingerprint);
  return invalidated
    ? { status: "invalidated", publishable: false, problems: ["a referenced canonical fact changed or disappeared"] }
    : { status: "stale", publishable: true, problems: [] };
}

export function validateLifeStory(story, packet, tierName = "short") {
  return validateLifeStoryDetails(story, packet, tierName).problems;
}

function validateLifeStoryDetails(story, packet, tierName = "short") {
  const tier = tierOf(tierName);
  const problems = [];
  const staleFactProblems = [];
  if (story?.schemaVersion !== 1) problems.push("unsupported story schemaVersion");
  if (story?.personId !== packet.personId) problems.push("story personId does not match packet");
  if (!Array.isArray(story?.paragraphs) || story.paragraphs.length < 1 || story.paragraphs.length > tier.storedParagraphs) {
    problems.push(`story requires one to ${tier.storedParagraphs === 3 ? "three" : tier.storedParagraphs} paragraphs`);
  }
  // The two tiers live in separate folders; a file in the wrong one is never read as the other.
  if (tierName === "full" ? story?.tier !== "full" : story?.tier !== undefined) problems.push("story is filed under the wrong tier");
  const allowed = new Map(packet.facts.filter((fact) => fact.usableInStory)
    .map((fact) => [fact.assertionId, fact.fingerprint]));
  const allowedFacts = new Map(packet.facts.filter((fact) => fact.usableInStory)
    .map((fact) => [fact.assertionId, fact]));
  const storedRefs = new Map((story?.referencedFacts || []).map((fact) => [fact.assertionId, fact.fingerprint]));
  const downgradedFacts = new Set(packet.facts.filter((fact) => !fact.usableInStory
    && storedRefs.has(fact.assertionId) && storedRefs.get(fact.assertionId) !== fact.fingerprint)
    .map((fact) => fact.assertionId));
  // Rejected facts can disappear from presentation and therefore from this
  // packet. A prior fingerprint records that the retained story used the fact;
  // a new unsupported paragraph reference has no such history. Both remain
  // validation errors, but a bound failed refresh may acknowledge the former
  // while continuing to withhold the old prose.
  const currentFactIds = new Set(packet.facts.map((fact) => fact.assertionId));
  for (const [id, fingerprint] of storedRefs) {
    if (!currentFactIds.has(id) && typeof fingerprint === "string" && fingerprint) {
      downgradedFacts.add(id);
    }
  }
  const referenced = new Set();
  for (const [index, paragraph] of (story?.paragraphs || []).entries()) {
    if (!paragraph?.text || typeof paragraph.text !== "string") problems.push(`paragraph ${index + 1} requires text`);
    if (!Array.isArray(paragraph?.assertionIds) || !paragraph.assertionIds.length) {
      problems.push(`paragraph ${index + 1} requires assertionIds`);
    }
    if (/<[^>]+>|https?:\/\/|\[[^\]]+\]\([^)]+\)|^\s*[-#>*]/m.test(paragraph?.text || "")) {
      problems.push(`paragraph ${index + 1} must be plain text`);
    }
    if (/\b(?:assertion|canonical|documentary basis|evidence|pre-migration|represented|research|retained|source)\b/i.test(paragraph?.text || "")) {
      problems.push(`paragraph ${index + 1} contains internal research language`);
    }
    const uncertaintyMatch = matchUncertainty(paragraph?.text);
    if (uncertaintyMatch) {
      problems.push(`paragraph ${index + 1} contains uncertainty language: ${uncertaintyMatch[0]}`);
    }
    if (/\b(?:part of a couple|were a couple|was a couple|are a couple|is a couple)\b/i.test(paragraph?.text || "")) {
      problems.push(`paragraph ${index + 1} contains unnatural relationship language`);
    }
    if (/\b(?:associated with|place association|connection to|ties to)\b/i.test(paragraph?.text || "")) {
      problems.push(`paragraph ${index + 1} contains vague place language`);
    }
    if (/\b(?:at|aged?) (?:about )?age?\s*\d+\b|\bat (?:about )?age \d+\b/i.test(paragraph?.text || "")) {
      const supportsBirth = (paragraph?.assertionIds || [])
        .some((id) => allowedFacts.get(id)?.eventType === "birth");
      if (!supportsBirth) problems.push(`paragraph ${index + 1} gives an age without an established birth event`);
    }
    for (const id of paragraph?.assertionIds || []) {
      if (!allowed.has(id)) {
        const problem = `paragraph ${index + 1} references unavailable fact ${id}`;
        problems.push(problem);
        if (downgradedFacts.has(id)) staleFactProblems.push(problem);
      }
      referenced.add(id);
    }
  }
  const wordCount = (story?.paragraphs || []).flatMap((paragraph) => String(paragraph.text || "").trim().split(/\s+/))
    .filter(Boolean).length;
  if (wordCount > tier.recipe.maxWords) problems.push(`story exceeds ${tier.recipe.maxWords} words`);
  if (!Array.isArray(story?.referencedFacts)) problems.push("story requires referencedFacts");
  for (const id of referenced) if (storedRefs.get(id) !== allowed.get(id)) {
    const problem = `story has stale fact fingerprint for ${id}`;
    problems.push(problem);
    if (storedRefs.has(id) && (allowed.has(id) || downgradedFacts.has(id))) staleFactProblems.push(problem);
  }
  if ([...storedRefs.keys()].some((id) => !referenced.has(id))) problems.push("referencedFacts contains unused assertions");
  if (story?.contentHash !== storyContentHash(story?.paragraphs || [])) problems.push("story contentHash is stale");
  if (!story?.generation?.provider || !story?.generation?.model || !story?.generation?.generatedAt) {
    problems.push("story generation metadata is incomplete");
  }
  if (!story?.verification?.model || !story?.verification?.verifiedAt || story.verification.passed !== true) {
    problems.push("story verification metadata is incomplete");
  }
  return { problems, staleFactProblems };
}

export function storyContentHash(paragraphs) {
  return hashValue(paragraphs.map((paragraph) => ({ text: paragraph.text, assertionIds: paragraph.assertionIds })));
}

/**
 * What a person's page receives: the short story and, when one is written and still
 * true to the facts, the fuller one. A fuller story whose facts changed is left out, so
 * the page falls back to the short story until it is refreshed.
 */
export function projectLifeStory(story, packet, fullStory) {
  const result = lifeStoryStatus(story, packet);
  const full = fullStory ? lifeStoryStatus(fullStory, packet, "full") : null;
  return {
    status: result.status,
    paragraphs: result.publishable ? story.paragraphs.map((paragraph) => paragraph.text) : [],
    ...(full?.publishable ? { full: fullStory.paragraphs.map((paragraph) => paragraph.text) } : {})
  };
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
