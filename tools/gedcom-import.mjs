#!/usr/bin/env node
// Import a GEDCOM file into a tree's canonical store as research leads.
//
//   node tools/gedcom-import.mjs --file family.ged [--root <tree dir>] [--branch <id>]
//
// Every person, name, life event and parent link becomes an assertion backed by
// one family-statement source for the file. Names are kept as the display
// label; identity, events, places and parent links are *candidate*: an imported
// tree is a set of leads, not proof. Each imported parent link gets a bridge
// research question, so checking the import against original records becomes
// the agent's first work. The importer refuses to write over an existing person
// file, so it is only for seeding a new or near-empty tree.

import fs from "node:fs";
import path from "node:path";
import { childValue, children, indexRecords, parseGedcom, parseName } from "./gedcom.mjs";
import { placeCountries } from "./place-labels.mjs";

const EVENT_TYPES = { BIRT: "birth", CHR: "baptism", BAPM: "baptism", DEAT: "death", BURI: "burial" };
const PLACE_ROLES = { birth: "birthplace", baptism: "baptism-place", death: "death-place", burial: "burial-place" };
const MONTHS = { JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun", JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec" };
const LIMITATION = "Imported from a family-tree file; not yet checked against an original record.";

export function slugify(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "person";
}

// GEDCOM date phrase -> the store's date text ("12 Mar 1851", "about 1850").
export function gedcomDateToStore(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const words = (part) => part.trim().split(/\s+/).map((token) => MONTHS[token.toUpperCase()] || token).join(" ");
  const upper = text.toUpperCase();
  const prefixes = [["ABT ", "about"], ["EST ", "about"], ["CAL ", "about"], ["BEF ", "before"], ["AFT ", "after"]];
  for (const [prefix, word] of prefixes) if (upper.startsWith(prefix)) return `${word} ${words(text.slice(prefix.length))}`;
  const between = /^(?:BET|FROM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$/i.exec(text);
  if (between) return `between ${words(between[1])} and ${words(between[2])}`;
  if (/^\(.*\)$/.test(text)) return text.slice(1, -1);
  return words(text);
}

function countryOf(place) {
  const last = String(place || "").split(",").map((part) => part.trim()).filter(Boolean).at(-1) || "";
  const aliases = { USA: "United States", "United States of America": "United States", US: "United States", UK: null };
  const country = Object.hasOwn(aliases, last) ? aliases[last] : last;
  return country && placeCountries.has(country) ? country : null;
}

function evidence(sourceId, rationale) {
  return [{ sourceId, role: "indirect", rationale }];
}

function candidate(id, claim, conclusion, sourceId, extra = {}) {
  return { id, assessment: "candidate", claim, conclusion, limitations: LIMITATION, evidence: evidence(sourceId, "The imported family-tree file records this fact; its own source is not identified."), questionIds: [], ...extra };
}

export function planImport(text, { fileName = "family.ged", branchId = "imported-tree", today = new Date().toISOString().slice(0, 10), existingIds = new Set(), treeAddedAt = null } = {}) {
  const index = indexRecords(parseGedcom(text));
  const sourceId = `imported-gedcom-${slugify(path.basename(fileName, path.extname(fileName)))}`;
  const ids = new Map();
  const used = new Set(existingIds);
  for (const record of index.individuals) {
    const name = parseName(childValue(record, "NAME"));
    let id = slugify(name.full || record.xref);
    if (used.has(id)) id = `${id}-${slugify(record.xref)}`;
    let n = 2;
    while (used.has(id)) id = `${slugify(name.full)}-${n++}`;
    used.add(id);
    ids.set(record.xref, id);
  }

  const people = new Map();
  const nowYear = Number(today.slice(0, 4));
  for (const record of index.individuals) {
    const personId = ids.get(record.xref);
    const name = parseName(childValue(record, "NAME")) ;
    const display = name.full || "Unknown";
    const assertions = [];
    const nameId = `assert-${personId}-name`;
    assertions.push({ id: nameId, assessment: "established", claim: { kind: "name", personId, value: display, nameType: "birth", display: true }, conclusion: `${display} is the name the imported family tree uses for this person.`, evidence: [{ sourceId, role: "direct", rationale: "The imported family-tree file names this person." }], questionIds: [] });
    assertions.push(candidate(`assert-${personId}-identity`, { kind: "person-identity", personId }, `${display} is a person in the imported family tree.`, sourceId));
    const placeRows = [];
    const detailAssertionIds = [nameId];
    let birthYear = null;
    let died = false;
    let origin = null;
    for (const [tag, eventType] of Object.entries(EVENT_TYPES)) {
      for (const event of children(record, tag)) {
        const dateText = gedcomDateToStore(childValue(event, "DATE"));
        const place = childValue(event, "PLAC");
        if (eventType === "death" || eventType === "burial") died = true;
        const year = /\b(\d{4})\b/.exec(dateText || "")?.[1];
        if (eventType === "birth" && year) birthYear = Number(year);
        if (!dateText && !place) continue;
        const eventId = `assert-${personId}-event-${eventType}${year ? `-${year}` : ""}`;
        if (assertions.some((assertion) => assertion.id === eventId)) continue;
        assertions.push(candidate(eventId, { kind: "event", subjectType: "person", subjectId: personId, eventType, ...(dateText ? { dateText } : {}), ...(place ? { place } : {}) }, `The imported tree records ${display}'s ${eventType}${dateText ? ` ${dateText}` : ""}${place ? ` at ${place}` : ""}.`, sourceId));
        detailAssertionIds.push(eventId);
        const country = countryOf(place);
        if (place && country) {
          const placeId = `assert-${personId}-place-${PLACE_ROLES[eventType]}`;
          if (!assertions.some((assertion) => assertion.id === placeId)) {
            assertions.push(candidate(placeId, { kind: "place-association", personId, value: place, placeRole: PLACE_ROLES[eventType] }, `The imported tree places ${display}'s ${eventType} at ${place}.`, sourceId));
            placeRows.push({ assertionIds: [placeId], country });
          }
          if (!origin && (eventType === "birth" || eventType === "baptism")) origin = country;
        }
      }
    }
    for (const occupation of children(record, "OCCU").map((entry) => entry.value.trim()).filter(Boolean).slice(0, 3)) {
      const occupationId = `assert-${personId}-occupation-${slugify(occupation).slice(0, 30)}`;
      if (assertions.some((assertion) => assertion.id === occupationId)) continue;
      assertions.push(candidate(occupationId, { kind: "occupation", personId, value: occupation }, `The imported tree gives ${display}'s occupation as ${occupation}.`, sourceId));
      detailAssertionIds.push(occupationId);
    }
    const living = !died && birthYear && nowYear - birthYear < 100;
    const status = died ? "deceased" : living ? "living" : (birthYear && nowYear - birthYear > 110 ? "deceased" : "unknown");
    assertions.push(candidate(`assert-${personId}-life-status`, { kind: "life-status", personId, value: status }, `${display} is treated as ${status} from the imported dates.`, sourceId));
    detailAssertionIds.push(`assert-${personId}-life-status`);
    if (origin) {
      assertions.push(candidate(`assert-${personId}-ancestry-origin`, { kind: "ancestry-origin", personId, value: origin }, `${display}'s recorded birthplace is in ${origin}.`, sourceId));
      detailAssertionIds.push(`assert-${personId}-ancestry-origin`);
    }
    people.set(personId, {
      schemaVersion: 2,
      personId,
      ...(treeAddedAt ? { treeAddedAt } : {}),
      branchIds: [branchId],
      privacy: living ? "private" : "private",
      presentation: { displayNameAssertionId: nameId, detailAssertionIds, treeParentAssertionIds: [], noteBlocks: [], placeRows },
      assertions
    });
  }

  const unions = [];
  const questions = [];
  for (const family of index.families) {
    const fatherId = ids.get(childValue(family, "HUSB"));
    const motherId = ids.get(childValue(family, "WIFE"));
    if (fatherId && motherId) {
      const unionId = `union-${fatherId}-${motherId}`;
      const unionAssertionId = `assert-${unionId}`;
      const marriage = children(family, "MARR")[0];
      const assertions = [candidate(unionAssertionId, { kind: "union", unionId, personIds: [fatherId, motherId], unionType: marriage ? "marriage" : "unknown" }, `The imported tree records ${fatherId} and ${motherId} as a couple.`, sourceId)];
      const eventAssertionIds = [];
      const dateText = gedcomDateToStore(childValue(marriage, "DATE"));
      const placeText = childValue(marriage, "PLAC");
      if (marriage && (dateText || placeText)) {
        const marriageId = `assert-${unionId}-event-marriage`;
        assertions.push(candidate(marriageId, { kind: "event", subjectType: "union", subjectId: unionId, eventType: "marriage", ...(dateText ? { dateText } : {}), ...(placeText ? { placeText } : {}) }, `The imported tree records this marriage${dateText ? ` on ${dateText}` : ""}${placeText ? ` at ${placeText}` : ""}.`, sourceId));
        eventAssertionIds.push(marriageId);
      }
      unions.push({ schemaVersion: 1, unionId, personIds: [fatherId, motherId], presentation: { leftPersonId: fatherId, rightPersonId: motherId, leftRole: "father", rightRole: "mother", unionAssertionId, eventAssertionIds }, assertions });
    }
    for (const childXref of children(family, "CHIL").map((entry) => entry.value.trim())) {
      const childId = ids.get(childXref);
      const child = people.get(childId);
      if (!child) continue;
      const questionId = `rq-imported-parents-${childId}`;
      const parentAssertionIds = [];
      for (const [parentId, role] of [[fatherId, "father"], [motherId, "mother"]]) {
        if (!parentId) continue;
        if (child.presentation.treeParentAssertionIds.some((id) => id.includes(`-parent-${role}-`))) continue;
        const assertionId = `assert-${childId}-parent-${role}-${parentId}`;
        child.assertions.push(candidate(assertionId, { kind: "parentage", childId, parentId, role, relationshipType: "unknown" }, `The imported tree names ${parentId} as ${childId}'s ${role}.`, sourceId, { questionIds: [questionId] }));
        child.presentation.treeParentAssertionIds.push(assertionId);
        parentAssertionIds.push(assertionId);
      }
      if (!parentAssertionIds.length) continue;
      const childName = child.assertions[0].claim.value;
      questions.push({
        schemaVersion: 2,
        id: questionId,
        branchId,
        question: `Do original records confirm the parents the imported tree gives for ${childName}?`,
        priority: "P2",
        personIds: [childId, fatherId, motherId].filter(Boolean),
        lifecycle: "active",
        goalKeys: parentAssertionIds.map((id) => `relationship-bridge:${id}`),
        assertionIds: parentAssertionIds,
        conclusion: { state: "unresolved" },
        acceptanceCriteria: [`A parent-bearing original (a baptism, birth, marriage or census entry, or a will) naming ${childName}'s parents, archived and reviewed.`],
        routeAssessment: { state: "unassessed" },
        actions: [{ id: "find-parent-bearing-original", kind: "search", status: "ready", note: `Find an original record naming ${childName}'s parents, starting from the imported dates and places.` }],
        frontierPersonId: childId
      });
    }
  }

  const source = {
    schemaVersion: 1,
    id: sourceId,
    kind: "family-statement",
    scope: "family-statement",
    provider: "Family information",
    source: `Imported family tree (${path.basename(fileName)})`,
    reference: `GEDCOM file ${path.basename(fileName)} imported ${today}: ${people.size} people, ${index.families.length} families. Its facts are leads until checked against original records.`,
    recordClass: "non-documentary",
    artifactPolicy: "citation-only",
    viewerPolicy: "not-applicable",
    artifactPurpose: "proof",
    standaloneReason: "Imported family-tree file: its facts are leads, carried by the bridge questions rather than a viewer citation.",
    locators: [{ kind: "bibliographic", value: path.basename(fileName) }]
  };
  return { source, people: [...people.values()], unions, questions, rootPersonId: ids.get(index.individuals[0]?.xref) || null };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`${file} already exists; the importer never overwrites canonical files`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeImport(plan, root) {
  writeJson(path.join(root, "evidence", "sources", "family-information", `${plan.source.id}.json`), plan.source);
  for (const person of plan.people) writeJson(path.join(root, "evidence", "proof", "people", `${person.personId}.json`), person);
  for (const union of plan.unions) writeJson(path.join(root, "evidence", "proof", "unions", `${union.unionId}.json`), union);
  for (const question of plan.questions) writeJson(path.join(root, "evidence", "research", "questions", `${question.id}.json`), question);
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const file = value("--file");
  if (!file) throw new Error("usage: node tools/gedcom-import.mjs --file <family.ged> [--root <tree dir>] [--branch <id>]");
  const root = path.resolve(value("--root") || process.cwd());
  const peopleDir = path.join(root, "evidence", "proof", "people");
  const existingIds = new Set(fs.existsSync(peopleDir) ? fs.readdirSync(peopleDir).map((name) => name.replace(/\.json$/, "")) : []);
  const plan = planImport(fs.readFileSync(file, "utf8"), { fileName: file, branchId: value("--branch") || "imported-tree", existingIds });
  writeImport(plan, root);
  console.log(`Imported ${plan.people.length} people, ${plan.unions.length} couples and ${plan.questions.length} parent-link questions into ${root} (first person: ${plan.rootPersonId}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
