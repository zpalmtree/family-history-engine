#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { loadResearchStore, projectRoot } from "./research-store.mjs";
import {
  generatedSourceTitle,
  validatePersonLinks,
  validateTitlePresentation
} from "./source-person-links.mjs";
import { legacySourceVerificationBasis, sourceReviewMethods } from "./review-provenance.mjs";
import { writeRegistryAtomic } from "./registry-write.mjs";

const root = projectRoot;
const queueName = valueAfter("--queue");
const targetId = valueAfter("--target");
const people = valuesAfter("--person");
const links = valuesAfter("--link").map(parseLink);
const unlinkedNames = valuesAfter("--name").map(parseName);
const noPerson = process.argv.includes("--no-person");
const note = valueAfter("--note");
const method = valueAfter("--method");
const titleMode = valueAfter("--title-mode");
const titlePeople = valuesAfter("--title-person");
const titleNames = valuesAfter("--title-name");
const titleQualifier = valueAfter("--title-qualifier");
const queueFiles = {
  public: "evidence/record-recovery-queue.json",
  familysearch: "evidence/familysearch-recovery-queue.json",
  subscription: "evidence/subscription-records-queue.json",
  manifest: null
};

if (!(queueName in queueFiles) || !targetId || (!noPerson && !people.length && !links.length) || !note
  || !sourceReviewMethods.has(method) || method === "legacy-reference-text") {
  throw new Error("usage: --queue public|familysearch|subscription|manifest --target <id> (--link '<person-link-json>'... | --no-person) [--name '<unlinked-name-json>'...] --method original-visual|provider-index|provider-transcript|family-statement|catalogue [--title-mode people|category-only --title-person <person-id>... --title-name <unlinked-name-id>... --title-qualifier <text>] --note <visual verification basis>");
}
if (noPerson && (people.length || links.length)) {
  throw new Error("--no-person cannot be combined with --person or --link");
}
if (unlinkedNames.length && people.length) {
  throw new Error("--name requires structured --link entries or --no-person, not legacy --person links");
}
if (people.length) {
  throw new Error("legacy --person links are no longer accepted; use structured --link entries with source-name readings or directly-evidenced links");
}
if (note.length > 300 || /password|token|secret|credit card|contact details/i.test(note)) {
  throw new Error("verification note is too long or contains a sensitive-data marker");
}
if (note === legacySourceVerificationBasis) throw new Error("the legacy migration basis cannot be used as a completed source review");

const family = JSON.parse(fs.readFileSync(path.join(root, "data", "family", "people.json"), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
for (const id of [...people, ...links.map((link) => link.personId)]) {
  if (!personIds.has(id)) throw new Error(`unknown family person id: ${id}`);
}
for (const id of titlePeople) {
  if (!personIds.has(id)) throw new Error(`unknown title person id: ${id}`);
}

const queuePath = queueFiles[queueName] ? path.join(root, queueFiles[queueName]) : null;
const manifestPath = path.join(root, "evidence", "records-manifest.json");
const queue = queuePath ? JSON.parse(fs.readFileSync(queuePath, "utf8")) : null;
const queueBase = structuredClone(queue);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestBase = structuredClone(manifest);
const store = loadResearchStore();
const record = manifest.records.find((item) => item.id === targetId);
if (!record) throw new Error(`manifest record is missing for acquired target: ${targetId}`);
const target = queue?.targets.find((item) => item.id === targetId) || record;
if (queue && target === record) throw new Error(`unknown ${queueName} target: ${targetId}`);
if (queue && !["acquired", "published"].includes(target.status)) {
  throw new Error(`target must be acquired or published before visual person verification: ${targetId}`);
}
// A queue viewer block describes how a record would be presented if approved;
// it is not itself publication approval. Withheld controls must never acquire
// manifest viewer metadata merely because their person links were reverified.
if (target.viewerPublishState === "withheld-control") {
  delete record.viewer;
} else if (!record.viewer && target.viewer) {
  // An interrupted publication transaction can register the manifest record
  // before the publication/import pass copies the approved presentation onto
  // it. Carry that presentation forward for publishable records only.
  record.viewer = structuredClone(target.viewer);
}
const atomId = target.atomId || record.sourceAtomId || target.id;
const atom = store.sources.find((item) => item.id === atomId);
if (!atom) throw new Error(`source atom is missing for target: ${atomId}`);
const canonicalTarget = store.acquisitionTargets.find((item) => item.id === targetId || item.sourceId === atomId);
// The original can only be transcribed after custody registration, so the
// compatibility queue and manifest may still carry the pre-review index
// reference. Refresh those generated custody views from the canonical source
// in the same visual-verification transaction.
target.source = atom.source || atom.provider || target.source;
target.reference = atom.reference || target.reference;
record.source = atom.source || atom.provider || record.source;
record.reference = atom.reference || record.reference;
// The provider queue is a generated custody view and can lag canonical
// approval while a newly reviewed master is awaiting its first Blob upload.
// Carry the canonical presentation and publication intent forward in this
// same verification transaction so the publication runner cannot downgrade
// the record back to a control on its next synchronization pass.
if (canonicalTarget?.viewer) {
  target.viewer = structuredClone(canonicalTarget.viewer);
  if (record.viewer) record.viewer = { ...record.viewer, ...structuredClone(canonicalTarget.viewer) };
}
if (atom.viewerPolicy === "approved-private"
    && canonicalTarget?.desiredArtifact?.publishEligible === true) {
  target.publishEligible = true;
  if (target.status === "acquired" && target.viewerPublishState === "withheld-control") {
    target.viewerPublishState = "pending-upload";
  }
}

const verifiedAt = new Date().toISOString().slice(0, 10);
const exactPeople = noPerson ? [] : [...new Set(links.length ? links.map((link) => link.personId) : people)];
const structured = links.length > 0 || noPerson;
// Canonical source links also carry biographical-review bookkeeping. That
// metadata is intentionally absent from the generated source-atom projection,
// so validate only the source-name/identity portion while preserving the full
// canonical link objects when this transaction writes them back.
const reviewableLinks = links.map(({ biographicalReview: ignoredReview, ...link }) => link);
const virtualAtom = {
  ...atom,
  people: exactPeople,
  ...(structured ? {
    personLinks: reviewableLinks,
    personLinksVerifiedAt: verifiedAt,
    personLinksVerificationBasis: note,
    ...(unlinkedNames.length ? { unlinkedNames } : { unlinkedNames: undefined })
  } : {})
};
if (structured) {
  const linkIssues = validatePersonLinks(virtualAtom, { personIds });
  if (linkIssues.length) throw new Error(`invalid structured person links:\n- ${linkIssues.join("\n- ")}`);
}
const titleRequested = titleMode !== undefined || titlePeople.length || titleNames.length || titleQualifier !== undefined;
if (titleRequested && !titleMode) throw new Error("title presentation requires --title-mode");
if (structured && record.viewer?.approved && record.viewer.title && !record.viewer.titleMode && !titleMode) {
  throw new Error(`reviewing manual viewer title ${targetId} requires --title-mode in the same transaction`);
}
let titlePresentation;
if (titleMode) {
  titlePresentation = {
    category: record.viewer?.category || target.viewer?.category,
    titleMode,
    titlePrincipals: [
      ...titlePeople.map((personId) => ({ personId, sourceAtomId: atomId })),
      ...titleNames.map((unlinkedNameId) => ({ unlinkedNameId, sourceAtomId: atomId }))
    ],
    ...(titleQualifier ? { titleQualifier } : {})
  };
  const titleIssues = validateTitlePresentation(
    titlePresentation,
    new Map([[atomId, virtualAtom]]),
    new Set(exactPeople)
  );
  if (titleIssues.length) throw new Error(`invalid structured title:\n- ${titleIssues.join("\n- ")}`);
}
target.people = exactPeople;
target.peopleVerifiedAt = verifiedAt;
target.peopleVerificationBasis = note;
record.people = exactPeople;
record.peopleVerifiedAt = verifiedAt;
record.peopleVerificationBasis = note;
atom.peopleVerifiedAt = verifiedAt;
if (structured) {
  atom.personLinks = links;
  atom.personLinksVerifiedAt = verifiedAt;
  atom.personLinksVerificationBasis = note;
  atom.personLinkReview = { status: "reviewed", method, reviewedAt: verifiedAt };
  if (unlinkedNames.length) atom.unlinkedNames = unlinkedNames;
  else delete atom.unlinkedNames;
} else {
  delete atom.personLinks;
  delete atom.personLinksVerifiedAt;
  delete atom.personLinksVerificationBasis;
  delete atom.personLinkReview;
  delete atom.unlinkedNames;
}
if (titlePresentation) {
  const viewers = [...new Set([record.viewer, target.viewer].filter(Boolean))];
  if (!viewers.length) throw new Error(`record has no viewer presentation: ${targetId}`);
  for (const viewer of viewers) {
    delete viewer.title;
    viewer.titleMode = titlePresentation.titleMode;
    viewer.titlePrincipals = titlePresentation.titlePrincipals;
    if (titlePresentation.titleQualifier) viewer.titleQualifier = titlePresentation.titleQualifier;
    else delete viewer.titleQualifier;
  }
}
if (queuePath) writeRegistryAtomic(queuePath, queueBase, queue);
writeRegistryAtomic(manifestPath, manifestBase, manifest);
delete atom.intendedPersonIds;
writeJsonAtomic(atom.__file, atom);
const generatedTitle = titlePresentation
  ? generatedSourceTitle(titlePresentation, new Map([[atomId, virtualAtom]]), new Set(exactPeople))
  : undefined;
console.log(`verified exact document people for ${targetId}: ${exactPeople.join(", ") || "none (all-files only)"}${generatedTitle ? `; title: ${generatedTitle}` : ""}`);

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
