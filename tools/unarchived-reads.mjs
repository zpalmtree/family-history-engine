// Detects original-record locators cited in research attempts that have no
// archived source master or acquisition target. An agent that reads a frame,
// register page or probate packet and uses it in a finding must preserve it
// (AGENTS.md: "Preserve a source master for every relevant record"); the
// 13 Nov 2026 audit found 46 such reads that only ever lived in attempt notes.
//
// The detector is deliberately conservative: it recognizes provider locators
// with stable, greppable forms (Findmypast transcript ids, film/frame ids and
// browse-volume frames, FamilySearch DGS images and record arks, TNA
// references, Ancestry record and image ids) and matches them against every
// manifest record, canonical source and acquisition target. A
// locator that names a page read only to prove a negative, or a whole-volume
// run around a relevant entry, is dismissed explicitly in
// evidence/research/unarchived-reads-dismissed.json with a reason.
//
// Read-only lane agents cannot record attempts, so the images they read are
// cited only in their findings files (evidence/research/briefs/**/findings/).
// On 19 Nov 2026 a dozen such reads were found parked in a brief with nothing
// to surface them, so the findings files are scanned too, for image-level
// locators only (an index row cited in a finding is not a read).

import fs from "node:fs";
import path from "node:path";

const FILM_FRAME = /\b(0\d{8})\s*\/\s*(\d{5})(?:\s*[-–]\s*(?:0\d{8}\s*\/\s*)?(\d{5}))?/g;
const FILM_FRAMES_PHRASE = /\bfilm\s+(0\d{8})[^.;]{0,40}?\bframes?\s+(\d{5})(?:\s*[-–]\s*(\d{5}))?/gi;
const FMP_TRANSCRIPT = /\b(?:GBPRS|PRS)\/[A-Z0-9]+(?:\/[A-Z0-9]+)*\/\d+(?:\/\d+)?\b/g;
const FMP_WILLS_SHORT = /\bWILLS\/(\d{5,7})\b/g;
const DGS_IMAGE = /\bDGS\s*(\d{7,9})\b[^.;]{0,30}?\bimages?\s+(\d{1,5})\b/gi;
// The last segment of an ark may be a single character (3:1:3Q9M-CSTT-79NG-V).
const FS_ARK = /\b3:1:[A-Z0-9]{4}(?:-[A-Z0-9]{1,4}){1,3}\b/g;
const TNA_REF = /\b(?:PROB\s+11\/\d+\/\d+|E\s+179\/\d+\/\d+(?:\/\d+)?)\b/g;
// Findmypast browse-volume frames, e.g. GBPRS/CANT/PB52/CCA-U3-30-1-5/00106.
const FMP_VOLUME_FRAME = /\bGBPRS\/[A-Z]+\/[A-Z]{1,4}\d+\/[A-Z0-9]+(?:-[A-Z0-9]+)+\/\d{5}\b/gi;
const ANCESTRY_RECORDS = [
  /\bcollections\/(\d{3,6})\/records\/(\d+)/g,
  /\bAncestry(?: collection)? (\d{3,6})\/(\d{4,})\b/g,
  /\bcollection (\d{3,6}),? record (\d+)\b/gi
];
const ANCESTRY_IMAGES = [
  /\bimageviewer\/collections\/\d{3,6}\/images\/([A-Za-z0-9][A-Za-z0-9_.-]{5,})/g,
  /\bimage id \**([A-Za-z0-9][A-Za-z0-9_.-]{7,})/g
];
// Locator kinds that name an image, as opposed to an index row or catalogue entry.
const IMAGE_KINDS = new Set(["frame", "dgs", "ark", "fmp-image", "ancestry-image"]);

/** Expand the locators named in free text into canonical keys. */
export function extractLocators(text = "") {
  const keys = new Set();
  const value = String(text);
  for (const match of value.matchAll(FILM_FRAME)) addFrames(keys, match[1], match[2], match[3]);
  for (const match of value.matchAll(FILM_FRAMES_PHRASE)) addFrames(keys, match[1], match[2], match[3]);
  for (const match of value.matchAll(FMP_TRANSCRIPT)) keys.add(`fmp:${match[0]}`);
  for (const match of value.matchAll(FMP_WILLS_SHORT)) {
    const start = match.index;
    const before = value.slice(Math.max(0, start - 12), start);
    if (!/STAFF\/$/.test(before)) keys.add(`fmp:GBPRS/STAFF/WILLS/${match[1]}`);
  }
  for (const match of value.matchAll(DGS_IMAGE)) keys.add(`dgs:${match[1].padStart(9, "0")}/${Number(match[2])}`);
  for (const match of value.matchAll(FS_ARK)) keys.add(`ark:${match[0]}`);
  for (const match of value.matchAll(TNA_REF)) keys.add(`tna:${match[0].replace(/\s+/g, " ")}`);
  for (const match of value.matchAll(FMP_VOLUME_FRAME)) keys.add(`fmp-image:${match[0].toUpperCase()}`);
  for (const pattern of ANCESTRY_RECORDS) {
    for (const match of value.matchAll(pattern)) keys.add(`ancestry:${match[1]}/${match[2]}`);
  }
  for (const pattern of ANCESTRY_IMAGES) {
    for (const match of value.matchAll(pattern)) keys.add(`ancestry-image:${match[1].replace(/[.-]+$/, "")}`);
  }
  return [...keys].sort();
}

const kindOf = (key) => key.slice(0, key.indexOf(":"));

function addFrames(keys, film, first, last) {
  const from = Number(first);
  const to = last ? Number(last) : from;
  if (!Number.isFinite(from) || to < from || to - from > 60) {
    keys.add(`frame:${film}/${first}`);
    return;
  }
  for (let frame = from; frame <= to; frame += 1) keys.add(`frame:${film}/${String(frame).padStart(5, "0")}`);
}

/** True when a canonical key appears in the archived/targeted text corpus. */
export function locatorIsCovered(key, corpus) {
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "frame") {
    const [film, frame] = rest.split("/");
    return corpus.includes(`${film}/${frame}`) || corpus.includes(`${film}%2F${frame}`)
      || corpus.includes(`${film}%2f${frame}`);
  }
  if (kind === "fmp") return corpus.includes(rest) || corpus.includes(rest.replaceAll("/", "%2F"));
  if (kind === "dgs") {
    const [dgs, image] = rest.split("/");
    const short = dgs.replace(/^0+/, "");
    return new RegExp(`0*${short}\\b[^"]{0,60}?\\bimages?\\s+0*${image}\\b`, "i").test(corpus)
      || corpus.includes(`${dgs}_${image.padStart(5, "0")}`);
  }
  if (kind === "ark") return corpus.includes(rest);
  if (kind === "tna") return corpus.includes(rest) || corpus.includes(rest.replace(/\s+/g, ""));
  if (kind === "fmp-image") {
    return [rest, rest.toLowerCase()].some((id) => corpus.includes(id)
      || corpus.includes(id.replaceAll("/", "%2F")) || corpus.includes(id.replaceAll("/", "%2f")));
  }
  if (kind === "ancestry") {
    const [collection, record] = rest.split("/");
    return corpus.includes(`collections/${collection}/records/${record}`)
      || corpus.includes(`ancestry:${collection}:${record}`)
      || new RegExp(`(?:^|[^0-9])${collection}/${record}(?![0-9])`).test(corpus)
      || new RegExp(`collection ${collection},? record ${record}(?![0-9])`, "i").test(corpus);
  }
  if (kind === "ancestry-image") return corpus.includes(rest);
  return false;
}

/** Build the searchable corpus of everything archived or already targeted. */
export function coverageCorpus(root) {
  const parts = [];
  const manifest = readJson(path.join(root, "evidence", "records-manifest.json"));
  for (const record of manifest?.records || []) {
    parts.push(record.id, record.reference || "", record.catalogueUrl || "");
  }
  for (const file of walkJson(path.join(root, "evidence", "sources"))) parts.push(fs.readFileSync(file, "utf8"));
  for (const file of walkJson(path.join(root, "evidence", "acquisition", "targets"))) parts.push(fs.readFileSync(file, "utf8"));
  return parts.join("\n");
}

export function loadDismissals(root) {
  const file = path.join(root, "evidence", "research", "unarchived-reads-dismissed.json");
  const data = readJson(file);
  const map = new Map();
  for (const item of data?.dismissed || []) map.set(item.locator, item);
  return map;
}

/**
 * Scan attempt shards (optionally from a date) and return each attempt's
 * uncovered, undismissed locators.
 */
export function scanUnarchivedReads(root, { since = "2026-10-01", corpus, dismissals } = {}) {
  const text = corpus ?? coverageCorpus(root);
  const dismissed = dismissals ?? loadDismissals(root);
  const findings = [];
  for (const file of walkJson(path.join(root, "evidence", "research", "attempts"))) {
    const shard = readJson(file);
    const attempt = shard?.attempt;
    if (!attempt || (since && String(attempt.attemptedAt || "") < since)) continue;
    const locators = uncoveredLocators([attempt.query, attempt.source, attempt.note].join("\n"), text, dismissed);
    if (locators.length) findings.push({ questionId: shard.questionId, attemptId: attempt.id, attemptedAt: attempt.attemptedAt, locators });
  }
  return findings.sort((a, b) => String(b.attemptedAt).localeCompare(String(a.attemptedAt)));
}

export function uncoveredLocators(text, corpus, dismissals = new Map()) {
  return extractLocators(text).filter((key) => !isDismissed(key, dismissals) && !locatorIsCovered(key, corpus));
}

// Until 19 Nov 2026 an ark's one-character last segment was dropped, so older
// dismissals are keyed by the shortened ark; they still stand.
function isDismissed(key, dismissals) {
  if (dismissals.has(key)) return true;
  return kindOf(key) === "ark" && /-[A-Z0-9]$/.test(key) && dismissals.has(key.replace(/-[A-Z0-9]$/, ""));
}

/**
 * Image locators cited in one findings file that are neither archived,
 * targeted nor dismissed. Lane files wrap their lines, so a citation is read
 * as a block (a bullet, heading or paragraph). An Ancestry image is covered
 * when a record id cited in the same block is, because records archived from
 * Ancestry are held under their record id.
 */
export function uncoveredFindingsLocators(text, corpus, dismissals = new Map()) {
  const missing = new Set();
  for (const block of findingsBlocks(text)) {
    const keys = extractLocators(block);
    const recordHeld = keys.some((key) => kindOf(key) === "ancestry" && locatorIsCovered(key, corpus));
    for (const key of keys) {
      if (!IMAGE_KINDS.has(kindOf(key)) || isDismissed(key, dismissals)) continue;
      if (kindOf(key) === "ancestry-image" && recordHeld) continue;
      if (!locatorIsCovered(key, corpus)) missing.add(key);
    }
  }
  return [...missing].sort();
}

function findingsBlocks(text) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) flush();
    else {
      if (/^\s*(?:[-*]|\d+\.|#)\s/.test(line)) flush();
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** Scan every lane findings file under the briefs folder. */
export function scanFindingsFiles(root, { corpus, dismissals } = {}) {
  const text = corpus ?? coverageCorpus(root);
  const dismissed = dismissals ?? loadDismissals(root);
  const findings = [];
  for (const file of walkFiles(path.join(root, "evidence", "research", "briefs"), ".md")) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!relative.includes("/findings/")) continue;
    const locators = uncoveredFindingsLocators(fs.readFileSync(file, "utf8"), text, dismissed);
    if (locators.length) findings.push({ file: relative, locators });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function* walkJson(dir) {
  yield* walkFiles(dir, ".json");
}

function* walkFiles(dir, extension) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, extension);
    else if (entry.name.endsWith(extension)) yield full;
  }
}
