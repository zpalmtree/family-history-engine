#!/usr/bin/env node

// Stage 6b of LIFE-STORIES-GOAL.md: a blended "their world" paragraph.
//
// A person whose page shows two or more background entries under "Their world" (place,
// trade and print exhibits) gets one short paragraph that blends them. The paragraph is
// written once per *set* of entries and shared by everyone whose page shows exactly that
// set; it names no person, says only what the entries say, is checked against them by a
// separate verifier call, and is credited to every entry it draws on (a blend of CC BY-SA
// text is itself CC BY-SA).
//
// Each paragraph is stored as a `context` exhibit (evidence/exhibits/world-<hash>.json),
// which the viewer already shows under "Their world", with a sidecar in
// evidence/life-stories/world/<id>.json holding the entries' fingerprint, so a changed
// entry makes the paragraph stale.
//
//   node tools/world-paragraphs.mjs --plan                 list the sets and their state
//   node tools/world-paragraphs.mjs --write [--limit n]    draft and verify the missing or stale sets (Claude Code on the plan)
//   node tools/world-paragraphs.mjs --write --older-prompt  also rewrite those written under an earlier promptVersion
//   node tools/world-paragraphs.mjs --sync                 bring each paragraph's people up to date (no model call)
//   node tools/world-paragraphs.mjs --check                fail on a stale paragraph or one shown to the wrong people
//
// Generation goes through Claude Code (`claude -p`), never the paid API.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { projectExhibits } from "./exhibit-store.mjs";
import { generationsFromRoots } from "./page-depth-core.mjs";
import { claudeCodeClient } from "./life-stories.mjs";

export const BLENDED_KINDS = Object.freeze(["place", "trade", "print"]);
export const worldRecipe = Object.freeze({
  promptVersion: "world-paragraph-v2",
  generatorModel: "claude-opus-5-5",
  verifierModel: "claude-opus-5-5",
  minWords: 25,
  maxWords: 110,
  repairs: 1,
  effort: "high"
});

const worldDir = path.join(projectRoot, "evidence", "life-stories", "world");
const exhibitDir = path.join(projectRoot, "evidence", "exhibits");
const sha = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

/** The stable id of a set of entries. */
export function worldSetId(exhibitIds) {
  return `world-${sha([...exhibitIds].sort().join("+")).slice(0, 16)}`;
}

/** What the paragraph may draw on: each entry's own words, nothing else. */
export function worldEntries(exhibits) {
  return [...exhibits].sort((a, b) => a.id.localeCompare(b.id)).map((exhibit) => ({
    id: exhibit.id, kind: exhibit.kind, title: exhibit.title, caption: exhibit.caption,
    ...(exhibit.text ? { text: exhibit.text } : {}), credit: exhibit.credit, licence: exhibit.licence
  }));
}

export function worldFingerprint(entries) {
  return sha(entries.map(({ id, title, caption, text, credit, licence }) => ({ id, title, caption, text, credit, licence })));
}

/**
 * The sets of two or more blended entries shown on people's pages, from the exhibit
 * projection. Returns Map setId -> { exhibitIds, people }.
 */
export function worldSets(exhibits, byPerson) {
  const kinds = new Map(exhibits.map((exhibit) => [exhibit.id, exhibit.kind]));
  const sets = new Map();
  for (const [personId, reached] of byPerson) {
    const ids = (Array.isArray(reached) ? reached : [...reached.values()]).map((entry) => entry.id)
      .filter((id) => BLENDED_KINDS.includes(kinds.get(id))).sort();
    if (ids.length < 2) continue;
    const setId = worldSetId(ids);
    if (!sets.has(setId)) sets.set(setId, { exhibitIds: ids, people: [] });
    sets.get(setId).people.push(personId);
  }
  for (const set of sets.values()) set.people.sort();
  return sets;
}

/** Checks a draft can fail without a model call. */
export function worldDraftProblems(draft, entries, personNames = []) {
  const problems = [];
  const words = String(draft?.paragraph || "").trim().split(/\s+/).filter(Boolean).length;
  if (words < worldRecipe.minWords) problems.push(`paragraph has ${words} words; write at least ${worldRecipe.minWords}`);
  if (words > worldRecipe.maxWords) problems.push(`paragraph has ${words} words; keep it under ${worldRecipe.maxWords}`);
  const known = new Set(entries.map((entry) => entry.id));
  const used = draft?.entryIds || [];
  if (!used.length) problems.push("name the entries the paragraph draws on");
  for (const id of used) if (!known.has(id)) problems.push(`unknown entry ${id}`);
  if (used.length && used.length < Math.min(2, entries.length)) problems.push("blend at least two of the entries");
  const text = ` ${String(draft?.paragraph || "")} `;
  for (const name of personNames) {
    if (name && name.length > 3 && text.includes(` ${name}`)) problems.push(`the paragraph names a person (${name}); it must name nobody`);
  }
  return problems;
}

const draftSchema = z.object({
  paragraph: z.string().describe("The blended paragraph, one paragraph of plain prose."),
  entryIds: z.array(z.string()).describe("The ids of the entries the paragraph draws on.")
});
const verificationSchema = z.object({
  pass: z.boolean(),
  problems: z.array(z.string()).describe("Each statement not supported by the entries, each person named, or other fault.")
});

export function worldDraftInstructions() {
  return `You write a short background paragraph for a private family-history website. It sits under the heading "Their world", below a note saying the section is background from outside sources and not part of the documented life.

You are given two or more entries: pictures and notes about places, trades and printed accounts that appear on the page of one or more ancestors. Blend them into one paragraph of plain, warm, exact prose.

Rules:
- Say only what the entries themselves say. Add no fact, date, number, place, comparison or explanation that is not in an entry. Do not guess how the entries connect beyond what they state.
- Name no person at all, not even a person an entry names; speak of the places, the work and the times. The paragraph is shared by several people's pages.
- Do not address the reader and do not refer to "the family", "the ancestors" or "these records".
- Describe the place, the work or the times, never the picture: say nothing about a photograph, drawing or engraving, when it was taken or made, or who took or made it.
- ${worldRecipe.minWords} to ${worldRecipe.maxWords} words, one paragraph, no lists, no headings.
- In entryIds, list every entry the paragraph draws on; blend at least two of them.
- When a repair is asked for, keep what was sound and fix each listed problem.`;
}

export function worldVerifierInstructions() {
  return `You check a short background paragraph against the entries it was written from. Pass it only if every statement in it is stated by one of the entries, it names no person, it adds no date, number, place or explanation of its own, it does not address the reader, and it describes the place, work or times rather than the picture (nothing about a photograph, drawing or engraving, when it was made, or who made it). List each problem plainly.`;
}

async function requestStructured(client, { model, system, input, schema, label }) {
  const { parse: _parse, ...format } = zodOutputFormat(schema);
  const result = await client.request({
    model, max_tokens: 4096, system,
    messages: [{ role: "user", content: JSON.stringify(input) }],
    thinking: { type: "adaptive" },
    output_config: { effort: worldRecipe.effort, format }
  });
  if (result?.stop_reason !== "end_turn") throw new Error(`${label} request did not complete`);
  const text = (result.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
  let output;
  try { output = JSON.parse(text); } catch { throw new Error(`${label} response contained invalid JSON`); }
  const parsed = schema.safeParse(output);
  if (!parsed.success) throw new Error(`${label} response did not match its schema`);
  return parsed.data;
}

/** Draft, check and independently verify one paragraph. */
export async function generateWorldParagraph({ client, entries, personNames = [], now = () => new Date() }) {
  let repair = null;
  for (let attempt = 0; attempt <= worldRecipe.repairs; attempt++) {
    const draft = await requestStructured(client, {
      model: worldRecipe.generatorModel, system: worldDraftInstructions(),
      input: { entries, ...(repair ? { repair } : {}) }, schema: draftSchema, label: "draft"
    });
    const local = worldDraftProblems(draft, entries, personNames);
    const verification = local.length ? { pass: false, problems: local } : await requestStructured(client, {
      model: worldRecipe.verifierModel, system: worldVerifierInstructions(),
      input: { entries, paragraph: draft.paragraph }, schema: verificationSchema, label: "verification"
    });
    if (verification.pass) {
      const at = now().toISOString();
      return {
        paragraph: draft.paragraph.trim(), entryIds: [...new Set(draft.entryIds)].sort(),
        generation: { transport: client.transport || "claude-code-print", model: worldRecipe.generatorModel, promptVersion: worldRecipe.promptVersion, generatedAt: at },
        verification: { model: worldRecipe.verifierModel, passed: true, verifiedAt: at }
      };
    }
    repair = { previousDraft: draft, problems: verification.problems };
  }
  throw new Error(`verification failed: ${(repair?.problems || []).join("; ")}`);
}

/** The context exhibit that shows one paragraph. */
export function worldExhibit(setId, set, paragraph, exhibitsById, today, citable = () => true) {
  const used = paragraph.entryIds.map((id) => exhibitsById.get(id));
  const licences = [...new Set(used.map((exhibit) => exhibit.licence))];
  return {
    schemaVersion: 1, id: setId, kind: "context", title: "Around them",
    citation: `Written from ${used.map((exhibit) => `'${exhibit.title}'`).join(", ")}; each entry's own citation is given with it.`,
    credit: used.map((exhibit) => exhibit.credit).join("; "),
    licence: licences.some((licence) => /BY-SA/.test(licence)) ? `CC BY-SA 4.0 (it blends ${licences.join(", ")} entries)` : licences.join(", "),
    checkedAt: today,
    // A record that matches one of the paragraph's people only as a candidate is not cited
    // here: the paragraph names its people, and a candidate identification is not yet theirs.
    recordIds: [...new Set(used.flatMap((exhibit) => exhibit.recordIds))].filter((recordId) => citable(recordId, set.people)).sort(),
    text: paragraph.paragraph,
    appliesTo: { people: set.people.map((personId) => ({ personId })) }
  };
}

function loadProjection() {
  const store = loadResearchStore();
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
  const relationships = readJson(path.join(projectRoot, "data", "family", "relationships.json"));
  const generations = generationsFromRoots(store.treePresentation.visualTree.directLineRoots || [], relationships.parents);
  const entryExhibits = store.exhibits.filter((exhibit) => BLENDED_KINDS.includes(exhibit.kind));
  const { byPerson } = projectExhibits(entryExhibits, { store, records: manifest.records, generations });
  const candidateLinks = new Set(store.sources.flatMap((source) => (source.personLinks || [])
    .filter((link) => link.identificationStatus === "candidate").map((link) => `${source.id}|${link.personId}`)));
  const citable = (recordId, people) => !people.some((personId) => candidateLinks.has(`${recordId}|${personId}`));
  return { store, citable, sets: worldSets(entryExhibits, byPerson), exhibitsById: new Map(store.exhibits.map((exhibit) => [exhibit.id, exhibit])) };
}

function readSidecar(setId) {
  const file = path.join(worldDir, `${setId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** State of one set: missing, fresh or stale. */
export function worldState(setId, set, exhibitsById, sidecar) {
  if (!sidecar) return "missing";
  const fingerprint = worldFingerprint(worldEntries(set.exhibitIds.map((id) => exhibitsById.get(id))));
  return sidecar.inputFingerprint === fingerprint ? "fresh" : "stale";
}

async function main() {
  const args = process.argv.slice(2);
  const { store, sets, exhibitsById, citable } = loadProjection();
  const today = new Date().toISOString().slice(0, 10);
  const states = [...sets].map(([setId, set]) => ({ setId, set, state: worldState(setId, set, exhibitsById, readSidecar(setId)) }));

  if (args.includes("--plan")) {
    const counts = states.reduce((acc, { state }) => ({ ...acc, [state]: (acc[state] || 0) + 1 }), {});
    console.log(`world paragraphs: ${sets.size} sets for ${states.reduce((n, { set }) => n + set.people.length, 0)} people; ${JSON.stringify(counts)}`);
    for (const { setId, set, state } of states) console.log(`${state.padEnd(7)} ${setId} | ${set.people.length} people | ${set.exhibitIds.join(" + ")}`);
    return;
  }

  const existing = fs.existsSync(exhibitDir) ? fs.readdirSync(exhibitDir).filter((name) => /^world-[0-9a-f]{16}\.json$/.test(name)) : [];

  if (args.includes("--sync") || args.includes("--check")) {
    const problems = [];
    for (const name of existing) {
      const setId = name.replace(/\.json$/, "");
      const file = path.join(exhibitDir, name);
      const exhibit = JSON.parse(fs.readFileSync(file, "utf8"));
      const set = sets.get(setId);
      const sidecar = readSidecar(setId);
      if (!set) { problems.push(`${setId}: no page shows this set any more`); continue; }
      if (worldState(setId, set, exhibitsById, sidecar) !== "fresh") problems.push(`${setId}: an entry changed since the paragraph was written`);
      if (exhibit.caption !== undefined) {
        if (args.includes("--sync")) {
          delete exhibit.caption;
          fs.writeFileSync(file, `${JSON.stringify(exhibit, null, 2)}\n`);
          console.log(`${setId}: caption removed (the paragraph speaks for itself)`);
        } else problems.push(`${setId}: carries a caption; a world paragraph needs none`);
      }
      const cited = (exhibit.recordIds || []).filter((recordId) => citable(recordId, set.people));
      if (cited.length !== (exhibit.recordIds || []).length) {
        if (args.includes("--sync")) {
          exhibit.recordIds = cited;
          fs.writeFileSync(file, `${JSON.stringify(exhibit, null, 2)}\n`);
          console.log(`${setId}: dropped a record that is only a candidate match for one of its people`);
        } else problems.push(`${setId}: cites a record that is only a candidate match for one of its people`);
      }
      const shown = (exhibit.appliesTo?.people || []).map((entry) => entry.personId).sort();
      if (JSON.stringify(shown) !== JSON.stringify(set.people)) {
        if (args.includes("--sync")) {
          exhibit.appliesTo = { people: set.people.map((personId) => ({ personId })) };
          fs.writeFileSync(file, `${JSON.stringify(exhibit, null, 2)}\n`);
          console.log(`${setId}: people brought up to date (${set.people.length})`);
        } else problems.push(`${setId}: shown to ${shown.length} people, but ${set.people.length} pages show this set`);
      }
    }
    if (args.includes("--check")) {
      if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
      console.log(`world paragraphs are current: ${existing.length} written of ${sets.size} sets`);
    }
    return;
  }

  if (args.includes("--write")) {
    const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
    // The sets that reach the most people are written first, so a limited run does the most good.
    // --older-prompt also rewrites paragraphs written under an earlier prompt version. They stay
    // "fresh" for --check (their entries have not changed), so the rewrite is a deliberate choice.
    const olderPrompt = args.includes("--older-prompt");
    const todo = states.filter(({ setId, state }) => state !== "fresh"
      || (olderPrompt && readSidecar(setId)?.generation?.promptVersion !== worldRecipe.promptVersion))
      .sort((a, b) => b.set.people.length - a.set.people.length || a.setId.localeCompare(b.setId)).slice(0, limit);
    console.log(`writing ${todo.length} world paragraph(s) through Claude Code (two calls each, more on a repair)`);
    const client = claudeCodeClient();
    await client.assertConfigured();
    const names = [...new Set(store.people.flatMap((bundle) => (bundle.assertions || [])
      .filter((assertion) => assertion.claim?.kind === "name" && assertion.assessment !== "rejected")
      .map((assertion) => String(assertion.claim.value || "").trim())))].filter((name) => name.includes(" "));
    fs.mkdirSync(worldDir, { recursive: true });
    let written = 0;
    for (const { setId, set } of todo) {
      const entries = worldEntries(set.exhibitIds.map((id) => exhibitsById.get(id)));
      try {
        const paragraph = await generateWorldParagraph({ client, entries, personNames: names });
        fs.writeFileSync(path.join(worldDir, `${setId}.json`), `${JSON.stringify({ schemaVersion: 1, setId, exhibitIds: set.exhibitIds, inputFingerprint: worldFingerprint(entries), ...paragraph }, null, 2)}\n`);
        fs.writeFileSync(path.join(exhibitDir, `${setId}.json`), `${JSON.stringify(worldExhibit(setId, set, paragraph, exhibitsById, today, citable), null, 2)}\n`);
        written += 1;
        console.log(`verified ${setId} (${set.people.length} people)`);
      } catch (error) {
        console.log(`not written ${setId}: ${error.message}`);
      }
    }
    console.log(`wrote ${written} of ${todo.length}`);
    return;
  }
  console.error("usage: world-paragraphs.mjs --plan | --write [--limit n] [--older-prompt] | --sync | --check");
  process.exit(2);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
