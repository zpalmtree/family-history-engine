#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore, projectRoot } from "./research-store.mjs";
import { validatePersonLinks } from "./source-person-links.mjs";
import { legacySourceVerificationBasis, sourceReviewMethods } from "./review-provenance.mjs";

const root = projectRoot;
const atomId = valueAfter("--atom");
const note = valueAfter("--note");
const method = valueAfter("--method");
const links = valuesAfter("--link").map(parseLink);
const unlinkedNames = valuesAfter("--name").map(parseName);
const noPerson = process.argv.includes("--no-person");
if (!atomId || (!links.length && !noPerson) || !note || !sourceReviewMethods.has(method) || method === "legacy-reference-text") {
  throw new Error("usage: --atom <source-atom-id> (--link '<person-link-json>'... | --no-person) [--name '<unlinked-name-json>'...] --method original-visual|provider-index|provider-transcript|family-statement|catalogue --note <verification basis>");
}
if (noPerson && links.length) {
  throw new Error("--no-person cannot be combined with --link");
}
if (note.length > 300 || /password|token|secret|credit card|contact details/i.test(note)) {
  throw new Error("verification note is too long or contains a sensitive-data marker");
}
if (note === legacySourceVerificationBasis) throw new Error("the legacy migration basis cannot be used as a completed source review");

const family = JSON.parse(fs.readFileSync(path.join(root, "data", "family", "people.json"), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
const atom = loadResearchStore().sources.find((item) => item.id === atomId);
if (!atom) throw new Error(`unknown source atom: ${atomId}`);

const verifiedAt = new Date().toISOString().slice(0, 10);
const exactPeople = noPerson ? [] : [...new Set(links.map((link) => link.personId))];
const linkIssues = validatePersonLinks({
  id: atomId,
  people: exactPeople,
  personLinks: links,
  personLinksVerifiedAt: verifiedAt,
  personLinksVerificationBasis: note,
  ...(unlinkedNames.length ? { unlinkedNames } : {})
}, { personIds });
if (linkIssues.length) throw new Error(`invalid structured person links:\n- ${linkIssues.join("\n- ")}`);

atom.personLinks = links;
atom.personLinksVerifiedAt = verifiedAt;
atom.personLinksVerificationBasis = note;
atom.personLinkReview = { status: "reviewed", method, reviewedAt: verifiedAt };
if (unlinkedNames.length) atom.unlinkedNames = unlinkedNames;
else delete atom.unlinkedNames;
delete atom.intendedPersonIds;
writeJsonAtomic(atom.__file, atom);
console.log(`verified structured source people for ${atomId}: ${exactPeople.join(", ")}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function parseLink(value) {
  try {
    const link = JSON.parse(value);
    if (!link || typeof link !== "object" || Array.isArray(link)) throw new Error("not an object");
    return link;
  } catch (error) {
    throw new Error(`invalid --link JSON: ${error.message}`);
  }
}

function parseName(value) {
  try {
    const name = JSON.parse(value);
    if (!name || typeof name !== "object" || Array.isArray(name)) throw new Error("not an object");
    return name;
  } catch (error) {
    throw new Error(`invalid --name JSON: ${error.message}`);
  }
}
