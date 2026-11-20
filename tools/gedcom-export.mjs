#!/usr/bin/env node
// Export the canonical store as GEDCOM 5.5.1, so a tree is never locked in.
//
//   npm run gedcom:export -- --out family.ged [--established-only] [--include-living] [--no-sources]
//
// What is exported:
// - every person in evidence/proof/people, named from their display-name
//   assertion (surname = the last word of the name, a heuristic);
// - birth, baptism, death and burial events, with their dates converted to
//   GEDCOM date phrases and their places;
// - families: one FAM per couple in evidence/proof/unions, plus one per
//   parent pair drawn on the tree (presentation.treeParentAssertionIds);
// - each assertion's assessment (established, candidate, unresolved) as a note,
//   and its cited sources as SOUR records.
// Rejected assertions are never exported. Living people are reduced to
// "Living" with no events unless --include-living is passed.

import fs from "node:fs";
import path from "node:path";
import { formatName, node, writeGedcom } from "./gedcom.mjs";
import { engineRoot, loadTreeConfig } from "./tree-config.mjs";

const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS = Object.fromEntries([
  ...MONTH_NAMES.map((name, index) => [name, MONTH_CODES[index]]),
  ...MONTH_NAMES.map((name, index) => [name.slice(0, 3), MONTH_CODES[index]]),
  ["sept", "SEP"]
]);
const EVENT_TAGS = { birth: "BIRT", baptism: "CHR", death: "DEAT", burial: "BURI", emigration: "EMIG" };
const PLACE_ROLE_EVENT = { birthplace: "birth", "baptism-place": "baptism", "death-place": "death", "burial-place": "burial" };

// Store date text ("30 Nov 1812", "about 1752-1753", "c. 1850", "before 22 Jan
// 1329/30") -> a GEDCOM date, or a "(phrase)" when it cannot be parsed.
export function storeDateToGedcom(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const one = (part) => {
    const tokens = part.trim().replace(/,/g, " ").split(/\s+/).filter(Boolean);
    const out = [];
    for (const token of tokens) {
      const lower = token.toLowerCase().replace(/\.$/, "");
      if (/^\d{1,2}$/.test(token) && out.length === 0) out.push(String(Number(token)));
      else if (MONTHS[lower]) out.push(MONTHS[lower]);
      else if (/^\d{3,4}(\/\d{1,2})?$/.test(token)) out.push(token);
      else return null;
    }
    // A day needs its month ("5 1733" is not a date).
    if (out.length === 2 && /^\d{1,2}$/.test(out[0]) && /\d{3,4}/.test(out[1])) return null;
    return out.length && /\d{3,4}/.test(out.at(-1)) ? out.join(" ") : null;
  };
  const lower = raw.toLowerCase();
  const prefixed = [
    [/^(about|abt\.?|c\.|ca\.?|circa)\s+/, "ABT"],
    [/^(on or before|before|bef\.?|by)\s+/, "BEF"],
    [/^(on or after|after|aft\.?)\s+/, "AFT"],
    [/^(estimated|est\.?)\s+/, "EST"]
  ];
  for (const [pattern, keyword] of prefixed) {
    const match = pattern.exec(lower);
    if (!match) continue;
    const rest = raw.slice(match[0].length);
    const range = /^(\d{3,4})\s*[-–]\s*(\d{2,4})$/.exec(rest.trim());
    if (range && keyword === "ABT") {
      const end = range[2].length === 4 ? range[2] : range[1].slice(0, 4 - range[2].length) + range[2];
      return `BET ${range[1]} AND ${end}`;
    }
    const parsed = one(rest);
    return parsed ? `${keyword} ${parsed}` : `(${raw})`;
  }
  const between = /^(?:(?:between|bet\.?)\s+)?(.+?)\s+(?:and|-|–)\s+(.+)$/i.exec(raw);
  if (/^(between|bet\.?)\s/i.test(raw) && between) {
    const to = one(between[2]);
    // "between 5 Nov and 24 Dec 1735": the first date borrows the second's year
    // (and month, for "between 5 and 13 Feb 1733/4").
    const toTokens = to ? to.split(" ") : [];
    const fromRaw = between[1].replace(/^(between|bet\.?)\s+/i, "");
    const from = one(fromRaw)
      || one(`${fromRaw} ${toTokens.at(-1) || ""}`)
      || one(`${fromRaw} ${toTokens.slice(-2).join(" ")}`);
    if (from && to) return `BET ${from} AND ${to}`;
  }
  const yearRange = /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(raw);
  if (yearRange) return `BET ${yearRange[1]} AND ${yearRange[2]}`;
  return one(raw) || `(${raw.replace(/[()]/g, "")})`;
}

export function splitDisplayName(full) {
  const words = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { given: words[0] || "", surname: "" };
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
  const suffix = suffixes.has(words.at(-1).toLowerCase()) ? words.pop() : "";
  const surname = words.pop();
  return { given: words.join(" "), surname, suffix };
}

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

function readSources(dir) {
  const sources = new Map();
  if (!fs.existsSync(dir)) return sources;
  for (const provider of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    for (const record of readDir(path.join(dir, provider.name))) sources.set(record.id, record);
  }
  return sources;
}

export function loadStoreForExport(root = engineRoot) {
  return {
    people: readDir(path.join(root, "evidence", "proof", "people")),
    unions: readDir(path.join(root, "evidence", "proof", "unions")),
    sources: readSources(path.join(root, "evidence", "sources"))
  };
}

export function buildGedcom(store, { establishedOnly = false, includeLiving = false, includeSources = true, title = "Family tree", now = new Date() } = {}) {
  const usable = (assertion) => assertion && assertion.assessment !== "rejected" && (!establishedOnly || assertion.assessment === "established");
  const people = new Map(store.people.map((person) => [person.personId, person]));
  const xref = new Map();
  [...people.keys()].sort().forEach((id, index) => xref.set(id, `@I${index + 1}@`));
  const sourceXref = new Map();
  const citedSourceIds = new Set();
  const sexes = new Map();
  const families = new Map();

  const familyKey = (fatherId, motherId) => `${fatherId || "?"}|${motherId || "?"}`;
  const familyFor = (fatherId, motherId) => {
    const key = familyKey(fatherId, motherId);
    if (!families.has(key)) families.set(key, { fatherId, motherId, children: [], union: null });
    return families.get(key);
  };

  for (const person of people.values()) {
    const byId = new Map(person.assertions.map((assertion) => [assertion.id, assertion]));
    let fatherId = null;
    let motherId = null;
    const linkNotes = [];
    for (const id of person.presentation?.treeParentAssertionIds || []) {
      const assertion = byId.get(id);
      if (!usable(assertion) || assertion.claim?.kind !== "parentage") continue;
      const { parentId, role } = assertion.claim;
      if (!people.has(parentId)) continue;
      if (role === "father") { fatherId = parentId; sexes.set(parentId, "M"); }
      if (role === "mother") { motherId = parentId; sexes.set(parentId, "F"); }
      if (assertion.assessment !== "established") linkNotes.push(`${role} link is ${assertion.assessment}`);
    }
    if (fatherId || motherId) familyFor(fatherId, motherId).children.push({ personId: person.personId, notes: linkNotes });
  }
  for (const union of store.unions) {
    const presentation = union.presentation || {};
    const left = presentation.leftPersonId;
    const right = presentation.rightPersonId;
    const roles = { [left]: presentation.leftRole, [right]: presentation.rightRole };
    const fatherId = [left, right].find((id) => roles[id] === "father") || left;
    const motherId = [left, right].find((id) => id !== fatherId);
    if (!people.has(fatherId) || !people.has(motherId)) continue;
    const unionAssertion = union.assertions.find((assertion) => assertion.id === presentation.unionAssertionId);
    if (!usable(unionAssertion)) continue;
    sexes.set(fatherId, sexes.get(fatherId) || (roles[fatherId] === "father" ? "M" : undefined));
    sexes.set(motherId, sexes.get(motherId) || (roles[motherId] === "mother" ? "F" : undefined));
    const family = familyFor(fatherId, motherId);
    family.union = union;
  }

  const citations = (assertion) => {
    if (!includeSources) return [];
    return (assertion.evidence || []).filter((item) => item.role === "direct" || item.role === "indirect").map((item) => {
      citedSourceIds.add(item.sourceId);
      return { sourceId: item.sourceId };
    });
  };
  const sourceNodes = (assertion, level) => citations(assertion).map(({ sourceId }) => node("SOUR", `@SRC:${sourceId}@`));
  const assessmentNote = (assertion) => assertion.assessment === "established" ? null : node("NOTE", `Assessment: ${assertion.assessment}${assertion.limitations ? ` (${assertion.limitations})` : ""}`);

  const individuals = [];
  for (const id of [...people.keys()].sort()) {
    const person = people.get(id);
    const byId = new Map(person.assertions.map((assertion) => [assertion.id, assertion]));
    const living = person.assertions.some((assertion) => assertion.claim?.kind === "life-status" && assertion.claim.value === "living" && assertion.assessment !== "rejected");
    const nameAssertion = byId.get(person.presentation?.displayNameAssertionId);
    const fullName = nameAssertion?.claim?.value || id;
    const entries = [];
    if (living && !includeLiving) {
      entries.push(node("NAME", "Living //"), node("RESN", "privacy"));
    } else {
      const { given, surname, suffix } = splitDisplayName(fullName);
      entries.push(node("NAME", formatName({ given, surname, suffix }), [nameAssertion ? sourceNodes(nameAssertion) : []].flat()));
      for (const assertion of person.assertions) {
        if (!usable(assertion) || assertion.claim?.kind !== "name" || assertion.id === nameAssertion?.id) continue;
        const parts = splitDisplayName(assertion.claim.value);
        const type = { married: "married", birth: "birth", nickname: "aka", alternate: "aka", anglicized: "aka", "spelling-variant": "aka" }[assertion.claim.nameType] || "aka";
        entries.push(node("NAME", formatName(parts), [node("TYPE", type)]));
      }
      if (sexes.get(id)) entries.push(node("SEX", sexes.get(id)));
      const places = new Map();
      for (const assertion of person.assertions) {
        if (usable(assertion) && assertion.claim?.kind === "place-association" && PLACE_ROLE_EVENT[assertion.claim.placeRole]) {
          places.set(PLACE_ROLE_EVENT[assertion.claim.placeRole], assertion.claim.value);
        }
      }
      for (const assertion of person.assertions) {
        if (!usable(assertion) || assertion.claim?.kind !== "event" || assertion.claim.subjectId !== id) continue;
        const tag = EVENT_TAGS[assertion.claim.eventType];
        if (!tag) continue;
        const date = storeDateToGedcom(assertion.claim.dateText);
        const place = assertion.claim.placeText || assertion.claim.place || places.get(assertion.claim.eventType);
        entries.push(node(tag, "", [date ? node("DATE", date) : null, place ? node("PLAC", place) : null, assessmentNote(assertion), ...sourceNodes(assertion)]));
      }
      for (const assertion of person.assertions) {
        if (!usable(assertion)) continue;
        if (assertion.claim?.kind === "occupation" && assertion.claim.value) entries.push(node("OCCU", assertion.claim.value, [assessmentNote(assertion), ...sourceNodes(assertion)]));
        if (assertion.claim?.kind === "place-association" && assertion.claim.placeRole === "residence" && assertion.claim.value) {
          entries.push(node("RESI", "", [node("PLAC", assertion.claim.value), assessmentNote(assertion), ...sourceNodes(assertion)]));
        }
      }
    }
    entries.push(node("_UID", id));
    individuals.push({ id, record: node("INDI", "", entries, xref.get(id)) });
  }

  const familyRecords = [];
  let familyIndex = 0;
  const familyLinks = new Map();
  const link = (personId, tag, value, extra = []) => {
    if (!familyLinks.has(personId)) familyLinks.set(personId, []);
    familyLinks.get(personId).push(node(tag, value, extra));
  };
  for (const family of [...families.values()].sort((a, b) => familyKey(a.fatherId, a.motherId).localeCompare(familyKey(b.fatherId, b.motherId)))) {
    familyIndex += 1;
    const id = `@F${familyIndex}@`;
    const entries = [];
    if (family.fatherId) { entries.push(node("HUSB", xref.get(family.fatherId))); link(family.fatherId, "FAMS", id); }
    if (family.motherId) { entries.push(node("WIFE", xref.get(family.motherId))); link(family.motherId, "FAMS", id); }
    for (const child of family.children.sort((a, b) => a.personId.localeCompare(b.personId))) {
      entries.push(node("CHIL", xref.get(child.personId)));
      link(child.personId, "FAMC", id, [node("PEDI", "birth"), ...child.notes.map((note) => node("NOTE", note))]);
    }
    if (family.union) {
      const byId = new Map(family.union.assertions.map((assertion) => [assertion.id, assertion]));
      for (const assertionId of family.union.presentation?.eventAssertionIds || []) {
        const assertion = byId.get(assertionId);
        if (!usable(assertion) || assertion.claim?.eventType !== "marriage") continue;
        const date = storeDateToGedcom(assertion.claim.dateText);
        const place = assertion.claim.placeText || assertion.claim.place;
        entries.push(node("MARR", "", [date ? node("DATE", date) : null, place ? node("PLAC", place) : null, assessmentNote(assertion), ...sourceNodes(assertion)]));
      }
    }
    familyRecords.push(node("FAM", "", entries, id));
  }
  for (const { id, record } of individuals) {
    const links = familyLinks.get(id) || [];
    const uid = record.children.pop();
    record.children.push(...links, uid);
  }

  const sourceRecords = [];
  let sourceIndex = 0;
  for (const sourceId of [...citedSourceIds].sort()) {
    sourceIndex += 1;
    sourceXref.set(sourceId, `@S${sourceIndex}@`);
    const source = store.sources.get(sourceId);
    const url = source?.locators?.find((locator) => locator.kind === "canonical-url")?.value;
    sourceRecords.push(node("SOUR", "", [
      node("TITL", source?.source || sourceId),
      source?.provider ? node("PUBL", source.provider) : null,
      source?.reference ? node("TEXT", source.reference) : null,
      url ? node("NOTE", url) : null
    ], `@S${sourceIndex}@`));
  }
  const rewriteSources = (entry) => {
    if (entry.tag === "SOUR" && entry.value.startsWith("@SRC:")) entry.value = sourceXref.get(entry.value.slice(5, -1));
    entry.children.forEach(rewriteSources);
  };
  [...individuals.map(({ record }) => record), ...familyRecords].forEach(rewriteSources);

  const date = now.toISOString().slice(0, 10);
  const header = node("HEAD", "", [
    node("SOUR", "FAMILY-HISTORY-HARNESS", [node("NAME", "Family history harness GEDCOM export")]),
    node("DATE", `${Number(date.slice(8))} ${MONTH_CODES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`),
    node("GEDC", "", [node("VERS", "5.5.1"), node("FORM", "LINEAGE-LINKED")]),
    node("CHAR", "UTF-8"),
    node("NOTE", `${title}. Exported from the canonical evidence store. Candidate and unresolved facts carry an "Assessment" note; surnames are the last word of each display name.`)
  ]);
  return writeGedcom([header, ...individuals.map(({ record }) => record), ...familyRecords, ...sourceRecords, node("TRLR")]);
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  if (!out) throw new Error("usage: npm run gedcom:export -- --out <file.ged> [--established-only] [--include-living] [--no-sources]");
  const config = loadTreeConfig();
  const store = loadStoreForExport(engineRoot);
  const text = buildGedcom(store, {
    establishedOnly: args.includes("--established-only"),
    includeLiving: args.includes("--include-living"),
    includeSources: !args.includes("--no-sources"),
    title: config.tree.title
  });
  fs.writeFileSync(path.resolve(out), text);
  const counts = (pattern) => (text.match(pattern) || []).length;
  console.log(`GEDCOM written to ${path.resolve(out)}: ${counts(/^0 @I\d+@ INDI/gm)} people, ${counts(/^0 @F\d+@ FAM/gm)} families, ${counts(/^0 @S\d+@ SOUR/gm)} sources`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
