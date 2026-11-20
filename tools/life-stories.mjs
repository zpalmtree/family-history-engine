#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { writeJsonAtomic } from "./atomic-json.mjs";
import {
  loadResearchStore,
  projectRoot,
  readJson,
  researchPaths
} from "./research-store.mjs";
import {
  buildLifeStoryIndex,
  buildLifeStoryPacket,
  draftVoiceProblems,
  fullStoryEligible,
  fullStoryRecipe,
  lifeStoryRecipe,
  lifeStoryStatus,
  retainFailedLifeStory,
  storyContentHash,
  storyTiers,
  validateLifeStory
} from "./life-story-core.mjs";
import { isDormantScope, parseResearchScope, researchScopeOf } from "./research-scope.mjs";
import { requireConsent } from "./consents.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

// A small fixed sample for --strict-pilot runs, from tree.config.json
// lifeStories.pilotPersonIds (empty by default).
export const pilotLifeStoryIds = Object.freeze([...(loadTreeConfig().lifeStories?.pilotPersonIds || [])]);

// The API constrains replies to JSON Schema; zod checks the original constraints on receipt.
const storySchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string(),
    assertionIds: z.array(z.string()).min(1)
  })).min(1).max(3)
});

// The fuller story for a person's own page: up to five short paragraphs.
const fullStorySchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string(),
    assertionIds: z.array(z.string()).min(1)
  })).min(1).max(5)
});

const verificationSchema = z.object({
  pass: z.boolean(),
  problems: z.array(z.string())
});

/**
 * Draft, check and independently verify one story. `tier` is "short" (the story the wall
 * display also shows) or "full" (the fuller story for the person's own page); the two
 * differ only in length, in how much they may tell, and in where they are stored.
 */
export async function generateVerifiedStory({ client, packet, now = () => new Date(), tier = "short", model = storyTiers[tier].recipe.generatorModel }) {
  const { recipe, recipeFingerprint } = storyTiers[tier];
  let draft = await requestDraft(client, packet, { model, tier });
  let localProblems = validateDraft(draft, packet, tier);
  let verification = localProblems.length
    ? { pass: false, problems: localProblems }
    : await requestVerification(client, packet, draft, { model: recipe.verifierModel, tier });
  for (let repair = 0; !verification.pass && repair < recipe.repairs; repair++) {
    draft = await requestDraft(client, packet, {
      model, tier,
      repair: { draft, problems: [...new Set([...localProblems, ...(verification.problems || [])])] }
    });
    localProblems = validateDraft(draft, packet, tier);
    verification = localProblems.length
      ? { pass: false, problems: localProblems }
      : await requestVerification(client, packet, draft, { model: recipe.verifierModel, tier });
  }
  if (!verification.pass) throw new Error(`verification failed: ${(verification.problems || []).join("; ") || "unspecified problem"}`);

  const referencedIds = [...new Set(draft.paragraphs.flatMap((paragraph) => paragraph.assertionIds))].sort();
  const factFingerprints = new Map(packet.facts.map((fact) => [fact.assertionId, fact.fingerprint]));
  const generatedAt = now().toISOString();
  const shard = {
    schemaVersion: 1,
    personId: packet.personId,
    ...(tier === "full" ? { tier: "full" } : {}),
    paragraphs: draft.paragraphs,
    inputFingerprint: packet.inputFingerprint,
    referencedFacts: referencedIds.map((assertionId) => ({
      assertionId,
      fingerprint: factFingerprints.get(assertionId)
    })),
    recipeFingerprint,
    contentHash: storyContentHash(draft.paragraphs),
    generation: {
      provider: recipe.provider,
      // The route actually used: Claude Code on the plan, or the direct API when asked for.
      transport: client.transport || recipe.transport,
      model,
      promptVersion: recipe.promptVersion,
      generatedAt
    },
    verification: {
      model: recipe.verifierModel,
      validatorVersion: recipe.validatorVersion,
      passed: true,
      verifiedAt: generatedAt
    }
  };
  const problems = validateLifeStory(shard, packet, tier);
  if (problems.length) throw new Error(`generated story is invalid: ${problems.join("; ")}`);
  return shard;
}

const shortLength = `- Length: 30 to 70 words, in one paragraph or two short ones, never more than ${lifeStoryRecipe.draftMaxWords}. Use the four or five most telling facts, not all of them. When little is known, one or two plain sentences are enough. Do not pad.`;

const fullLength = `- Length: this is the fuller telling, 150 to 300 words in three to five short paragraphs, never more than ${fullStoryRecipe.draftMaxWords}. Give each stretch of the life its own paragraph: childhood and parents; marriage and children; work and homes; the last years, death, burial and what was left behind. Use every fact that says something about the life: each trade and each home, land or a house owned, what a will left and to whom, an office held, whether the person signed or made a mark, the arms they bore, a gravestone or monument. Tell each fact once. When the facts cannot fill 150 words, write less. Do not pad.
- A place that comes with no country in its fact's country or places fields is named exactly as the fact names it ("of Engleton", "born in Hainault, in the Low Countries"); add no country, county or state of your own to it.`;

const fullExample = `"Giuseppe was born in Lucca, Italy, in 1868, the son of Paolo Bianchi and Rosa Martini, and lost his father when he was nine.

He married Maria Conti in Lucca in 1895, and their son Paolo was born there in 1896. In 1902 he sailed from Genoa on the Città di Napoli and landed at New York, USA.

He settled in Barre, Vermont, USA, where he cut granite. By 1910 the family were renting a house on Granite Street, and in 1920 he owned one on Berlin Street, free of mortgage. He became an American citizen in 1915 and signed the papers in his own hand.

Giuseppe died in Barre in 1931, at 63, of lung disease, and is buried in Hope Cemetery there. His will left the house to Maria for her life, and then to their four children in equal shares."`;

/**
 * The drafting instructions for one tier. The short tier's text must not change by
 * accident (a test pins it): the wall display and every stored short story rest on it.
 */
export function draftInstructionsFor(tierName = "short") {
  const full = tierName === "full";
  return `${full ? "You write the fuller life story shown on each ancestor's own page of a private family-history site; a shorter version for a small display in the family's home is written separately." : "You write the life stories shown for each ancestor on a private family-history site and on a small e-ink display in the family's home."} Relatives read them to get a sense of who the person was, not to audit records.

Write only from the supplied facts. Every fact is established and has an assertionId. Each paragraph lists exactly the IDs of the facts its sentences use: every fact it draws on and nothing it does not mention. Facts whose bases include "child", "child-life" or "parent-life" are about the person's children and parents; use them to connect the person to the family, never as facts about the person.

Voice. Tell it the way a relative would, out loud, to someone who never met them: plain everyday words in sentences that flow into each other, nothing that sounds like a form or a report. Read the draft back and ask whether a person would really say it that way.
- Tell the life in the order it happened: birth and parents, marriage, children, work and homes, death. Do not open with a later moment and then double back to the birth.
- Join related facts into one sentence ("he married Ada Price in 1902, while he was clerking in Leeds") and vary the length of sentences. A run of short "He did this. He did that." sentences reads like a list.
- Make geography unmistakable. On first naming a place, give its country from the fact's country or places fields ("Wootton, England", "Rose, Italy"). For an American place include the full state when supplied and USA ("Chester County, Pennsylvania, USA"). USA is a present-day locator, not nationality; for colonial lives write "Pennsylvania, in what is now the USA". Use each place's own supplied area; never borrow a country or state from another place or invent one. Repeat the area or country after a country change or whenever a reader could confuse British and American places. Use "there" only when its meaning is clear. ${full ? "Name each place where a fact gives the person a real role, without listing every year and township." : "Keep the two or three places that matter most instead of listing every year and township."}
- Use the first name, then mostly he or she. The full name is printed above the story.
- Bring family in the way people talk about it: "the daughter of Pasquale and Teresa", "her son Joseph was born in 1892". ${full ? "Name the spouse and up to four children where the facts give them, woven into sentences; never list every child." : "Name the spouse and at most one or two children; never list every child."} Mention a parent's death only when it came in the person's childhood ("he lost his father when he was six"), giving the age only when an established birth event supports it and otherwise just the year.
- Avoid the word partner. With an established marriage fact, say married. Without one, connect the two through a child the facts give to both ("Ellen and Joseph had a daughter, Martha"). Only when the couple is the one thing the facts tell, write "Mary's partner was John Smith".
- Say what the person did, not what a document says about them: "she was keeping house in Wootton in 1851", never "she was described as", "named as", "listed as" or "recorded as". Do not mention censuses, registers, certificates, entries, petitions, indexes or other documents; a will can be mentioned, since making one is something the person did. When a fact must be attributed to someone's own word, say so simply and once ("she said she was born in 1903"); if several facts would need it, keep the one that matters most.
- Leave a fact out rather than state it awkwardly. Skip facts that are hedged, that offer alternatives ("Waterville or Weston") or a range of possible years, that need a long qualification, or that would only repeat something already said.
- Leave out details that say nothing about the life: a sentence about the person's own name or another spelling of it (a new name taken on marriage or emigration, "born Emilia Fiorita", is fine), abbreviations of a name, the form of a name someone signed with, a baptism on the day of birth, the house number of a birthplace, household possessions, who reported something. Never bring in a person the facts do not name, such as "one of his children".
- Keep numbers few. Prefer years to full dates, and give a full date only when the day itself means something, such as Christmas Day or the Fourth of July. Give an age only where it adds something, such as at marriage, emigration or death, and as a phrase where that reads naturally ("in her mid-sixties").
- Explain an old trade or a foreign word in passing when a reader today would not know it ("a contadina, working the land"; "a licensed victualler, keeping a public house"). Never explain a familiar trade such as blacksmith, farmer or clerk.
- Keep the details that make someone real: a voyage and its ship, a street they lived on, a trade, what a will left and to whom, a couple who could not sign their names.
- Avoid stock phrasing: sentences that open with "Born", "Widowed" or another participle, "came from a family with roots in", "at the head of a household", "a child of his", "carried the surname", "the very next day", "and he was again".
- No filler: do not say the person is deceased or "later died", do not restate a lifespan without adding something, and do not comment on missing information, on the family tree or on how the person fits into it, and do not sum a life up in general words ("he lived a long life").
- Give a cause of death briefly and in plain words ("of heart disease").
${full ? fullLength : shortLength}

${full ? "Three short examples of the voice, each written from facts that support every statement, followed by one at the fuller length you are writing:" : "Three examples of the voice, each written from facts that support every statement:"}

"Hannah was born in Ashby, England, in 1799 and married Thomas Ward there in 1821. By 1841 they had five children at home. Ten years later, in her early fifties, she was working as a lacemaker."

"Giuseppe was born in Lucca, Italy, in 1868 and married Maria Conti there in 1895. In 1902 he sailed from Genoa on the Città di Napoli and settled in Barre, Vermont, USA, where he cut granite. He became an American citizen in 1915 and died there in 1931, at 63."

"Mary and Richard Hall had a son, George, who was baptized at Wem, England, in 1762."${full ? `\n\n${fullExample}` : ""}

Accuracy (these rules override the voice):
- Never invent motives, feelings, causes, dates, places, occupations, relationships, chronology or historical context.
- State each fact's positive content directly, without uncertainty language such as may, might, possibly, perhaps, probably, likely, unknown or not established. Keep approximate terms such as about, around or circa when a fact supplies them.
- Give an age only from an established birth event (never a baptism) or an age a fact states: exact from exact dates, "about" from approximate ones, otherwise leave it out.
- Say married, husband or wife only when an established marriage fact supports it. Never say "part of a couple".
- Use place roles precisely: lived in only for a residence, and born, baptized, married, died or buried in only for those roles. Never write associated with, connection to or ties to.
- Separate observations in different years stay separate. Never imply continuous residence, work, membership or status between them.
- Keep each fact's framing. When a fact or its limitations present something as a person's own report, a will's statement or an estimate, say so ("in his will he said he had already given each son land"). Keep date qualifiers such as "on or about".
- Give each relative the name the facts give them; when naming both parents, give each their own surname.
- Do not add small connecting claims that no fact states: that someone was "again" somewhere, that a couple raised children together, that a woman took a surname, or that a child was "their" child when a fact names only one parent (write "her son" or "his son" instead).
- Draft registration is not military service, baptism is not religious affiliation, and an occupational mason is not a Freemason.
- Never use internal words such as represented, retained, displayed, canonical, assertion, source, evidence or research.

Plain text only: no headings, Markdown, citations or mention of research or AI.`;
}

const verifierInstructions = [
  "Independently verify the proposed life story against the supplied canonical facts.",
  "Fail it for any unsupported statement, semantic leap, softened uncertainty, misleading chronology, missing support ID, or use of an assertion ID that does not support its paragraph.",
  "Fail any statement that attributes a relative's fact (a fact whose bases include child, child-life or parent-life) to the person themselves.",
  "Fail prose that sounds like a database or research report, including internal phrases such as represented, retained, displayed, canonical, pre-migration, documentary basis, assertion, source, or evidence, and descriptions of records rather than the life.",
  "Fail any uncertainty or missing-information language, including may, might, possible, perhaps, uncertain, unresolved, unconfirmed, unknown, or not established. Approximate terms such as about, around, and circa are allowed when the established fact supplies them.",
  "Fail any calculated age that lacks an established birth event; baptism is not a birth date and cannot support age at marriage or death. Ages a fact states directly are allowed.",
  "Fail unnatural relationship language such as part of a couple or were a couple. Married, husband and wife need an established marriage fact; without one the story must not imply marriage.",
  "Fail vague place language such as associated with, connection to, or ties to. Lived in requires an established residence fact; other place wording must match its structured role.",
  "Fail wording that turns separate dated observations into an unsupported continuous state.",
  "A story may open with a later, more telling moment and then go back, as long as each statement's own date or sequence is clear; fail chronology only when the wording implies a false order.",
  "Naming the country given in a place fact's country field alongside that place is supported by that fact.",
  "Require an explicit country on first mentioning a place, and its supplied full state for US places. Curated places fields support those qualifiers even when the statement omits them. Check each qualifier belongs to that place, and require repetition after a country change when needed to avoid ambiguity. USA is a modern geographic locator, not colonial nationality; use what is now the USA for colonial lives. Never infer a migration event from separate place observations.",
  "In particular, draft registration is not service, baptism is not religious affiliation, and stonemason is not Freemasonry.",
  "Leaving facts out is never a reason to fail a story. Explanations of an old trade or a foreign word (for example, a contadina working the land) and calendar names for a supported date (Christmas Day for 25 December) are allowed.",
  "Return pass=true only when every statement is supported and appropriately qualified."
].join(" ");

// The fuller story names more places than the short one, and many early places come with
// no country in any fact (a manor, a medieval county). The short story's check is left as
// it is; the fuller one is told what to do with them.
const fullVerifierAddendum = [
  "This is the fuller story for the person's own page: it may run to five paragraphs and name more places and children than a short story.",
  "A place for which no cited fact supplies a country (in a country or places field, or in the fact's own statement) is named as the fact names it, with no country: do not fail the story for that missing country.",
  "Do fail a country, county or state that no cited fact supplies for that place, and a place a fact does locate that is first named without its supplied country."
].join(" ");

export function verifierInstructionsFor(tierName = "short") {
  return tierName === "full" ? `${verifierInstructions} ${fullVerifierAddendum}` : verifierInstructions;
}

async function requestDraft(client, packet, { model, repair, tier = "short" } = {}) {
  const allowedFacts = packet.facts.filter((fact) => fact.usableInStory).map((fact) => ({
    assertionId: fact.assertionId,
    statement: fact.statement,
    assessment: fact.assessment,
    factKind: fact.factKind,
    ...(fact.eventType ? { eventType: fact.eventType } : {}),
    ...(fact.placeRole ? { placeRole: fact.placeRole } : {}),
    ...(fact.country ? { country: fact.country } : {}),
    ...(fact.places ? { places: fact.places } : {}),
    ...(fact.limitations ? { limitations: fact.limitations } : {}),
    bases: fact.bases,
    prominence: fact.prominence
  }));
  const input = {
    person: { id: packet.personId, displayName: packet.displayName },
    facts: allowedFacts,
    ...(repair ? { repair: { previousDraft: repair.draft, problems: repair.problems } } : {})
  };
  return requestStructured(client, {
    model, system: draftInstructionsFor(tier), input, schema: tier === "full" ? fullStorySchema : storySchema, label: "draft"
  });
}

async function requestVerification(client, packet, draft, { model, tier = "short" }) {
  const input = { personId: packet.personId, facts: packet.facts, draft };
  return requestStructured(client, { model, system: verifierInstructionsFor(tier), input, schema: verificationSchema, label: "verification" });
}

/** Tool-free direct API call; drafts and independent verification use separate requests. */
async function requestStructured(client, { model, system, input, schema, label }) {
  const { parse: _parse, ...format } = zodOutputFormat(schema);
  const result = await client.request({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: JSON.stringify(input) }],
    thinking: { type: "adaptive" },
    output_config: { effort: lifeStoryRecipe.effort, format }
  });
  if (result?.stop_reason === "refusal") throw new Error(`${label} request was declined`);
  if (result?.stop_reason === "max_tokens") throw new Error(`${label} response was cut off`);
  if (result?.stop_reason !== "end_turn") throw new Error(`${label} request did not complete`);
  const text = (result.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
  if (!text) throw new Error(`${label} response contained no structured output`);
  let output;
  try { output = JSON.parse(text); }
  catch { throw new Error(`${label} response contained invalid JSON`); }
  const parsed = schema.safeParse(output);
  if (!parsed.success) throw new Error(`${label} response did not match its schema`);
  return parsed.data;
}

/**
 * Stories are written through Claude Code itself (the user's decision of 18 Nov 2026,
 * replacing the direct-API route because of its cost): one headless, tool-free
 * `claude -p` call per draft or check, on the Claude Code plan this machine is signed in
 * to. The call gets the same system prompt, input and reply schema as the API route.
 */
export function claudeCodeArgs(request) {
  const { description: _description, ...schema } = request.output_config?.format?.schema || {};
  if (!schema.type) throw new Error("Claude Code story request needs a reply schema");
  return [
    "-p", "--model", request.model, "--effort", request.output_config?.effort || "high",
    "--system-prompt", request.system,
    // No tools, no MCP servers, nothing saved: the call can only read its input and answer.
    "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(schema)
  ];
}

export function claudeCodeClient({ run = runClaudeCode } = {}) {
  return {
    transport: "claude-code-print",
    async request(request) {
      const result = await run(claudeCodeArgs(request), request.messages[0].content);
      if (!result || result.is_error || result.subtype !== "success") {
        throw new Error("Claude Code story request did not complete; previous stories are retained");
      }
      const structured = result.structured_output;
      const text = structured && typeof structured === "object" ? JSON.stringify(structured) : String(result.result || "");
      return { stop_reason: "end_turn", content: text ? [{ type: "text", text }] : [] };
    },
    async assertConfigured() {
      const version = await run(["--version"]);
      if (!version) throw new Error("Claude Code is not available on this machine; no story was written and nothing falls back to the API.");
    }
  };
}

/**
 * One `claude` process. It runs in an empty directory, so it loads no project
 * instructions and can read nothing of the repository, and any API key is removed from
 * its environment, so a story can never be billed to the API by accident.
 */
export function runClaudeCode(args, input) {
  return new Promise((resolve, reject) => {
    const cwd = path.join(os.tmpdir(), "life-stories-claude-code");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env };
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[key];
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 660_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    // Never forward raw output: it can carry the request.
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("Claude Code could not start")); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal || code !== 0) return reject(new Error("Claude Code story request failed; previous stories are retained"));
      if (args.includes("--version")) return resolve(stdout.trim());
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Claude Code returned no readable result; previous stories are retained")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

/**
 * The direct-API route, kept for use only when the user asks for it (--transport api).
 * The API key is decrypted and used only inside Windows. Node sends bounded
 * requests over stdin; the bridge returns response text/usage, never credentials.
 * Nothing falls back to it, and it falls back to nothing.
 */
export function anthropicApiClient({ run = runApiBridge } = {}) {
  return {
    transport: "messages-api",
    request: (request) => run("invoke", request),
    async assertConfigured() {
      const status = await run("status");
      if (!status?.configured) throw new Error("Life-story API credential is not configured in the Windows encrypted store; configure tools/life-stories-api-windows.ps1 before refreshing. No subscription fallback is used.");
    }
  };
}

export function runApiBridge(mode, request) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-WindowStyle", "Hidden", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", "tools/life-stories-api-windows.ps1", "-Mode", mode
    ], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 660_000);
    // Decode as one UTF-8 stream so a multi-byte character split across chunks survives.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    // Never forward raw transport errors: they can contain headers or request data.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows life-story API bridge could not start"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout); } catch { /* Deliberately suppress raw output. */ }
      if (signal || code !== 0 || !result) {
        const status = Number.isInteger(result?.httpStatus) ? ` (HTTP ${result.httpStatus})` : "";
        return reject(new Error(`Life-story API request failed${status}; previous stories are retained`));
      }
      resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request ? JSON.stringify(request) : "");
  });
}

function validateDraft(draft, packet, tier = "short") {
  const pseudo = {
    schemaVersion: 1,
    personId: packet.personId,
    ...(tier === "full" ? { tier: "full" } : {}),
    paragraphs: draft?.paragraphs,
    inputFingerprint: packet.inputFingerprint,
    referencedFacts: [...new Set((draft?.paragraphs || []).flatMap((paragraph) => paragraph.assertionIds || []))]
      .sort().map((assertionId) => ({
        assertionId,
        fingerprint: packet.facts.find((fact) => fact.assertionId === assertionId)?.fingerprint
      })),
    recipeFingerprint: storyTiers[tier].recipeFingerprint,
    contentHash: storyContentHash(draft?.paragraphs || []),
    generation: { provider: "validation", model: "validation", generatedAt: "validation" },
    verification: { model: "validation", passed: true, verifiedAt: "validation" }
  };
  return [
    ...validateLifeStory(pseudo, packet, tier).filter((problem) => !/metadata/.test(problem)),
    ...draftVoiceProblems(draft?.paragraphs, tier),
    ...missingCountries(draft, packet)
  ];
}

/**
 * Check new drafts only: older verified stories remain publishable until refreshed.
 * The independent verifier checks that qualifiers attach to the right locality.
 */
function missingCountries(draft, packet) {
  const text = (draft?.paragraphs || []).map((paragraph) => String(paragraph?.text || "")).join(" ");
  const cited = new Set((draft?.paragraphs || []).flatMap((paragraph) => paragraph?.assertionIds || []));
  const facts = packet.facts.filter((fact) => cited.has(fact.assertionId));
  const places = facts.flatMap((fact) => fact.places || (fact.country ? [{ country: fact.country }] : []));
  const countries = new Set(places.map((place) => place.country).filter(Boolean));
  const problems = [...countries].filter((country) => country === "United States"
    ? !/\b(?:USA|United States)\b|\bU\.S\.A\./i.test(text) : !text.includes(country))
    .map((country) => `name the country with the first place in ${country}: "Placename, ${country === "United States" ? "State, USA" : country}"`);
  for (const state of new Set(places.filter((place) => place.country === "United States" && place.state).map((place) => place.state))) {
    if (!text.includes(state)) problems.push(`include the supplied full state ${state} with its American place`);
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const scope = parseResearchScope(args);
  const mode = args.includes("--refresh") ? "refresh" : args.includes("--check") ? "check" : "status";
  const store = loadResearchStore();
  const stories = new Map(store.lifeStories.map((story) => [story.personId, story]));
  const fullStories = new Map((store.lifeStoriesFull || []).map((story) => [story.personId, story]));
  const visualIds = visualPersonIds(scope);
  const packetIndex = buildLifeStoryIndex(store);
  const rows = visualIds.map((personId) => {
    const packet = buildLifeStoryPacket(store, personId, packetIndex);
    const full = fullStories.get(personId);
    return {
      personId, packet, story: stories.get(personId), result: lifeStoryStatus(stories.get(personId), packet),
      full, fullResult: full ? lifeStoryStatus(full, packet, "full") : null, fullEligible: fullStoryEligible(packet)
    };
  });

  if (mode === "status" || mode === "check") {
    const counts = {};
    for (const row of rows) counts[row.result.status] = (counts[row.result.status] || 0) + 1;
    counts.inactive = store.lifeStories.filter((story) => !visualIds.includes(story.personId)).length;
    console.log(`life stories: ${rows.length} visual people; ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
    const invalid = rows.filter((row) => row.result.status === "invalidated");
    for (const row of invalid) console.error(`- ${row.personId}: ${row.result.problems.join("; ")}`);
    for (const row of rows.filter((row) => row.result.status === "refresh-failed")) {
      console.log(`- ${row.personId}: known failed refresh; previous story retained and withheld`);
    }
    // The fuller tier never fails a check: a fuller story whose facts changed is simply
    // not shown, and the page tells the short story until the person is refreshed.
    const written = rows.filter((row) => row.full);
    const fullCounts = {};
    for (const row of written) fullCounts[row.fullResult.status] = (fullCounts[row.fullResult.status] || 0) + 1;
    console.log(`fuller stories: ${written.length} written of ${rows.filter((row) => row.fullEligible).length} people with enough to tell`
      + `${written.length ? `; ${Object.entries(fullCounts).map(([key, value]) => `${key}=${value}`).join(", ")}` : ""}`);
    for (const row of written.filter((row) => !row.fullResult.publishable)) {
      console.log(`- FULLER STORY HIDDEN ${row.personId}: a fact it tells changed; refresh with --person ${row.personId}`);
    }
    if (mode === "check") {
      const strictIds = args.includes("--strict-coverage") ? visualIds
        : args.includes("--strict-pilot") ? pilotLifeStoryIds : [];
      const missingStrict = strictIds.filter((personId) => {
        const row = rows.find((item) => item.personId === personId);
        return row?.result.status !== "unavailable" && !row?.result.publishable;
      });
      if (invalid.length || missingStrict.length) {
        if (missingStrict.length) console.error(`missing publishable stories: ${missingStrict.join(", ")}`);
        process.exit(1);
      }
      console.log("life-story checks passed; only publishable stories are projected");
    }
    return;
  }

  const explicit = optionValues(args, "--person");
  const all = args.includes("--all");
  if (all && process.env.LIFE_STORIES_BATCH_CONFIRMATION !== "PROCEED LIFE STORIES") {
    throw new Error("full refresh requires LIFE_STORIES_BATCH_CONFIRMATION='PROCEED LIFE STORIES'");
  }
  // A full refresh stays inside the requested research scope; another scope's people
  // can appear in the shared tree views but need their own authorization.
  const inScope = (personId) => {
    const person = store.people.find((item) => item.personId === personId);
    return person && researchScopeOf(person) === scope;
  };
  const targetIds = explicit.length ? explicit : all ? visualIds.filter(inScope) : pilotLifeStoryIds;
  for (const personId of explicit) {
    const person = store.people.find((item) => item.personId === personId);
    if (!person) throw new Error(`unknown canonical person: ${personId}`);
    if (!visualIds.includes(personId)) {
      throw new Error(`person ${personId} is not available in research scope ${scope}`);
    }
    if (isDormantScope(researchScopeOf(person)) && scope !== researchScopeOf(person)) {
      throw new Error(`person ${personId} requires --scope ${researchScopeOf(person)}`);
    }
  }
  const force = args.includes("--force");
  const targets = rows.filter((row) => targetIds.includes(row.personId)
    && (force || ["missing", "stale", "invalidated", "refresh-failed"].includes(row.result.status)));
  // A fuller story is written for a person only when asked for with --full. Once one
  // exists, every later refresh of that person keeps it current.
  const wantFull = args.includes("--full");
  const fullTargets = rows.filter((row) => targetIds.includes(row.personId) && row.result.status !== "unavailable"
    && (row.full ? (force && wantFull) || row.fullResult.status !== "fresh" : wantFull && row.fullEligible));
  const tooThin = wantFull ? rows.filter((row) => explicit.includes(row.personId) && !row.full && !row.fullEligible) : [];
  if (tooThin.length) console.log(`too little recorded for a fuller story: ${tooThin.map((row) => row.personId).join(", ")}`);
  if (args.includes("--dry-run")) {
    console.log(`would refresh ${targets.length} life stories: ${targets.map((row) => row.personId).join(", ") || "none"}`);
    if (fullTargets.length || wantFull) {
      console.log(`would write ${fullTargets.length} fuller stories: ${fullTargets.map((row) => row.personId).join(", ") || "none"}`);
    }
    return;
  }
  if (!targets.length && !fullTargets.length) { console.log("No life stories need refreshing."); return; }
  // Claude Code on this machine's plan unless the user asks for the paid API route by name.
  const transport = optionValues(args, "--transport")[0] || "claude-code";
  if (!["claude-code", "api"].includes(transport)) throw new Error("--transport is claude-code (the default) or api");
  requireConsent("life-stories");
  const client = transport === "api" ? anthropicApiClient() : claudeCodeClient();
  await client.assertConfigured();
  console.log(transport === "api"
    ? "Life stories use the direct Anthropic API and linked organization credits for this run (--transport api); no fallback."
    : "Life stories are written through Claude Code on this machine's plan; the direct API is used only with --transport api.");
  // A named list runs a few at a time too: one after another, forty people took forty minutes.
  const jobs = [...targets.map((row) => ({ row, tier: "short" })), ...fullTargets.map((row) => ({ row, tier: "full" }))];
  const results = await mapWithConcurrency(jobs, all ? 6 : Math.min(4, jobs.length), async ({ row, tier }) => {
    try {
      const story = await generateVerifiedStory({ client, packet: row.packet, tier });
      console.log(tier === "full" ? `verified fuller story for ${row.personId}` : `verified ${row.personId}`);
      return { tier, story };
    } catch (error) {
      if (tier === "full") {
        // No receipt: an existing fuller story stays as it is, shown only while its facts hold.
        console.error(`no fuller story written for ${row.personId}: ${error.message}`);
        return { tier, failure: { personId: row.personId, message: error.message } };
      }
      console.error(`retained existing story for ${row.personId}: ${error.message}`);
      return {
        tier,
        retained: retainFailedLifeStory(row.story, row.packet, {
          reason: error.message.startsWith("verification failed:") ? "verification-failed" : "generation-failed"
        }),
        failure: { personId: row.personId, message: error.message }
      };
    }
  });
  const ofTier = (tier) => results.filter((result) => result.tier === tier);
  const generated = ofTier("short").flatMap((result) => result.story ? [result.story] : []);
  const failures = ofTier("short").flatMap((result) => result.failure ? [result.failure] : []);
  fs.mkdirSync(researchPaths.lifeStories, { recursive: true });
  for (const story of generated) writeJsonAtomic(path.join(researchPaths.lifeStories, `${story.personId}.json`), story);
  for (const { retained } of results) if (retained) {
    writeJsonAtomic(path.join(researchPaths.lifeStories, `${retained.personId}.json`), retained);
  }
  if (targets.length) console.log(`wrote ${generated.length} verified life stories; ${failures.length} failed safely`);
  const fullWritten = ofTier("full").flatMap((result) => result.story ? [result.story] : []);
  const fullFailures = ofTier("full").filter((result) => result.failure);
  if (fullWritten.length) fs.mkdirSync(researchPaths.lifeStoriesFull, { recursive: true });
  for (const story of fullWritten) writeJsonAtomic(path.join(researchPaths.lifeStoriesFull, `${story.personId}.json`), story);
  if (fullTargets.length) console.log(`wrote ${fullWritten.length} fuller stories; ${fullFailures.length} not written`);
  if (failures.length || fullFailures.length) process.exitCode = 1;
}

function visualPersonIds(scope = "main") {
  const tree = readJson(path.join(projectRoot, "data", "family", "tree.json"));
  // A dormant scope's people are its own view's; otherwise every other view's.
  const views = Object.keys(tree.visualTree.views || {});
  const viewIds = isDormantScope(scope) ? views.filter((viewId) => viewId === scope) : views.filter((viewId) => !isDormantScope(viewId));
  return [...new Set(viewIds.flatMap((viewId) =>
    (tree.visualTree.views?.[viewId]?.nodes || []).map((node) => node.id)))];
}

function optionValues(args, name) {
  return args.flatMap((value, index) => value === name ? [args[index + 1]] : []).filter(Boolean);
}

async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
