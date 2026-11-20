import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sourceAtomsPath = path.join(root, "evidence", "source-atoms.json");

export const recordClasses = new Set([
  "original-image",
  "original-pdf",
  "newspaper-page",
  "index-image",
  "index-entry",
  "transcript",
  "catalogue-entry",
  "family-statement",
  "research-webpage",
  "search-audit"
]);

export const artifactPolicies = new Set(["preserve-if-accessible", "citation-only"]);
export const viewerPolicies = new Set([
  "approved-private",
  "withheld-control",
  "not-applicable",
  "pending-rights"
]);
export const artifactPurposes = new Set(["proof", "control"]);
export const locatorKinds = new Set([
  "canonical-url",
  "provider-record-id",
  "provider-image-id",
  "archive-reference",
  "bibliographic",
  "search-url"
]);

export function readSourceAtoms() {
  return JSON.parse(fs.readFileSync(sourceAtomsPath, "utf8"));
}

export function normalizeUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["lang", "view", "action", "usePUB"].includes(key)) {
        url.searchParams.delete(key);
      }
    }
    return `${url.hostname.toLocaleLowerCase()}${url.pathname}${url.search}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function extractLocators(...values) {
  const text = values.filter(Boolean).join(" ");
  const locators = [];
  const seen = new Set();
  const add = (kind, value) => {
    const clean = String(value || "").trim().replace(/[),.;]+$/, "");
    if (!clean) return;
    const key = `${kind}:${clean.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    locators.push({ kind, value: clean });
  };

  for (const match of text.matchAll(/https:\/\/[^\s;]+/gi)) {
    const value = match[0].replace(/[.)]+$/, "");
    add(/[?&](?:q|query|firstname|lastname|surname|search)=/i.test(value) || /\/search\/results/i.test(value)
      ? "search-url" : "canonical-url", value);
  }
  for (const match of text.matchAll(/ark:\/61903\/[13]:1:[A-Z0-9-]+/gi)) {
    add(match[0].includes("/3:1:") ? "provider-image-id" : "provider-record-id", match[0]);
  }
  for (const match of text.matchAll(/(?:collection\s+|collections\/)(\d+)[^\n;]{0,100}?(?:record\s+|records\/|pid=)(\d+)/gi)) {
    add("provider-record-id", `ancestry:${match[1]}:${match[2]}`);
  }
  for (const match of text.matchAll(/(?:image|frame)\s+([A-Z0-9][A-Z0-9_.-]{5,})/gi)) {
    add("provider-image-id", match[1]);
  }
  for (const match of text.matchAll(/GBPRS%2F[A-Z0-9%/_-]+/gi)) add("provider-record-id", match[0]);
  for (const match of text.matchAll(/BL\/\d+\/\d+\/\d+/gi)) add("provider-record-id", match[0]);
  for (const match of text.matchAll(/(?:DGS|digital folder|film)\s+(\d{6,12})/gi)) {
    add("archive-reference", `${match[0].split(/\s+/)[0].toUpperCase()} ${match[1]}`);
  }
  for (const match of text.matchAll(/(?:manifest id|source-master manifest id|encrypted source-master manifest id)\s+([a-z0-9][a-z0-9-]+)/gi)) {
    add("archive-reference", `manifest:${match[1]}`);
  }
  for (const match of text.matchAll(/\b(?:QSR|PROB|HO107|RG\d+|T\d+|D\d{3,5})\/[A-Z0-9/.-]+/gi)) {
    add("archive-reference", match[0]);
  }
  return locators;
}

export function locatorTokens(locators) {
  const tokens = new Set();
  for (const locator of locators || []) {
    const value = locator.value || "";
    tokens.add(`${locator.kind}:${value.toLocaleLowerCase()}`);
    const normalized = normalizeUrl(value);
    if (normalized) tokens.add(`url:${normalized}`);
    for (const match of value.matchAll(/(?:ark:\/61903\/[13]:1:|manifest:|ancestry:\d+:)([A-Z0-9-]+)/gi)) {
      tokens.add(`id:${match[1].toLocaleLowerCase()}`);
    }
    for (const match of value.matchAll(/\b(?:BL\/\d+\/\d+\/\d+|GBPRS%2F[A-Z0-9%/_-]+)\b/gi)) {
      tokens.add(`id:${match[0].toLocaleLowerCase()}`);
    }
  }
  return tokens;
}

export function inferRecordClass(value, mediaType = "") {
  const text = String(value || "").toLocaleLowerCase();
  if (/newspaper|obituar|gazette|advertiser|news-bee|chronicle|the blade/.test(text)) return "newspaper-page";
  if (/family information|direct user|user-supplied|family statement/.test(text)) return "family-statement";
  if (/transcript|freecen|freereg|ocr snippet/.test(text)) return "transcript";
  if (/catalogue|catalog |finding aid|discovery record/.test(text)) return "catalogue-entry";
  if (/search|audit|control/.test(text) && !/original|image|certificate|register/.test(text)) return "search-audit";
  if (/index/.test(text) && !/original|image/.test(text)) return "index-entry";
  if (/index/.test(text) && /original|image/.test(text)) return "index-image";
  if (mediaType === "application/pdf") return "original-pdf";
  if (/original|image|certificate|register|census|will|probate|manifest|directory|book|biograph/.test(text)) {
    return "original-image";
  }
  if (/https?:\/\//.test(text)) return "research-webpage";
  return "index-entry";
}

export function artifactPolicyFor(recordClass) {
  return new Set(["original-image", "original-pdf", "newspaper-page", "index-image"]).has(recordClass)
    ? "preserve-if-accessible"
    : "citation-only";
}

export function splitCitationReference(reference) {
  const clauses = String(reference || "").split(/;\s+/).map((item) => item.trim()).filter(Boolean);
  if (clauses.length < 2) return clauses;
  const result = [];
  const startsSource = (value) => {
    const locators = extractLocators(value);
    if (locators.length) return true;
    return /^(?:familysearch|ancestry|findmypast|freereg|freebmd|freecen|staffordshirebmd|general register office|gro\b|national archives|internet archive|google news|toledo|staffordshire|wood county|commemorative|original\b|\d{4}\b)/i.test(value)
      || /\b(?:census|bapti[sz]m|marriage|burial|death|birth|probate|will|register|certificate|directory|newspaper|obituary|memorial)\b/i.test(value);
  };
  for (const clause of clauses) {
    if (!result.length || startsSource(clause)) result.push(clause);
    else result[result.length - 1] += `; ${clause}`;
  }
  return result;
}

export function slug(value) {
  return String(value || "source")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLocaleLowerCase()
    .slice(0, 80) || "source";
}

export function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, compact(item)]));
}
