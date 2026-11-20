#!/usr/bin/env node

// Signature and mark exhibits for LIFE-STORIES-GOAL.md (lane E).
//
// A marriage register from 1754 on carries each party's own signature or mark. For a
// held, published register image this tool turns a checked plan (which lines, who
// signed, who made a mark) into an exhibit cut from the page, a fact for each party,
// the reading added to the record's review, and the checklist lane outcome.
//
//   npm run signatures -- <plan.json> --sheet <out.png>   cut every crop into one image, to look at first
//   npm run signatures -- <plan.json>                     check and print (dry run)
//   npm run signatures -- <plan.json> --write
//
// A plan is a JSON array of:
//   { "id": "<manifest record id>", "slug": "walker-smith-ellastone-1818", "place": "Ellastone, Staffordshire",
//     "dateLong": "1 June 1818", "dateText": "1 Jun 1818", "year": 1818,
//     "crop": { "x": 0.5, "y": 0.33, "width": 0.36, "height": 0.05 },          fractions of the page image
//     "groom": { "personId": "...", "name": "John Example", "how": "signed", "line": "John Example" },
//     "bride": { "personId": "...", "name": "Jane Sample", "how": "mark", "line": "Jane Sample + her Mark" } }
// "how" is "signed", "mark" or "unclear" (shown, but no fact is recorded for that party).
// A party with "personId": null is named in the caption only.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recordArchiveRoot } from "./tree-config.mjs";

const HOW = new Set(["signed", "mark", "unclear"]);

function sentence(parties) {
  const [groom, bride] = parties;
  if (groom.how === "signed" && bride.how === "signed") return "Both signed their own names.";
  if (groom.how === "mark" && bride.how === "mark") return "Neither signed: their names are written for them, and each made a mark.";
  if (groom.how === "signed" && bride.how === "mark") return "He signed his name; hers is written for her, and she made a mark.";
  if (groom.how === "mark" && bride.how === "signed") return "She signed her name; his is written for him, and he made a mark.";
  const say = (party, he) => party.how === "signed" ? `${he} signed ${he === "He" ? "his" : "her"} name`
    : party.how === "mark" ? `${he === "He" ? "his" : "her"} name is written for ${he === "He" ? "him" : "her"}, with a mark`
      : `whether ${he === "He" ? "his" : "her"} name is a signature or written for ${he === "He" ? "him" : "her"} is not clear`;
  const text = `${say(groom, "He")}; ${say(bride, "She")}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function title(parties) {
  const [groom, bride] = parties;
  if (parties.some((party) => party.how === "unclear")) return `${groom.name} and ${bride.name} in the marriage register`;
  if (groom.how === bride.how) return `The ${groom.how === "signed" ? "signatures" : "marks"} of ${groom.name} and ${bride.name}`;
  const signer = parties.find((party) => party.how === "signed");
  const marker = parties.find((party) => party.how === "mark");
  return `${signer.name}'s signature and ${marker.name}'s mark`;
}

/**
 * Check one plan entry and build what it records. Pure: nothing is read or written.
 * @returns {{ problems: string[], exhibit?: object, facts?: Array<{personId: string, assertion: object}>, review?: object }}
 */
export function buildSignatureEntry(item, { record, source, review, today }) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(item.slug || "")) problems.push("bad slug");
  if (!record) return { problems: [`no such record ${item.id}`] };
  if (record.viewer?.approved !== true || record.rights !== "family-viewer-approved") problems.push("record is not published to the family viewer");
  if (!/^image\//.test(record.mediaType || "")) problems.push(`record is ${record.mediaType}; a strip is cut from an image master`);
  const crop = item.crop || {};
  if (![crop.x, crop.y, crop.width, crop.height].every((value) => typeof value === "number" && value >= 0 && value <= 1)
    || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.0001 || crop.y + crop.height > 1.0001) problems.push("crop must be fractions of the image, inside it");
  for (const field of ["place", "dateLong", "dateText"]) if (!item[field]) problems.push(`requires ${field}`);
  if (!Number.isInteger(item.year)) problems.push("requires year");
  const parties = [{ ...item.groom, he: "He" }, { ...item.bride, he: "She" }];
  for (const party of parties) {
    if (!party.name || !party.line) problems.push("each party needs a name and the line as written");
    if (!HOW.has(party.how)) problems.push(`how must be signed, mark or unclear (${party.name})`);
    if (party.personId) {
      const link = (source?.personLinks || []).find((entry) => entry.personId === party.personId);
      if (link?.identificationStatus !== "confirmed") problems.push(`${party.personId}: the record is ${link ? "only a candidate match" : "not linked"}; leave the party unlinked (personId null) or wait for the identification`);
    }
  }
  if (!parties.some((party) => party.personId)) problems.push("no linked party");
  if (problems.length) return { problems };

  const sourceId = record.sourceAtomId || record.id;
  const quote = `'${item.groom.line}' and '${item.bride.line}'`;
  const exhibitId = `signature-${item.slug}`;
  const his = (party) => party.he === "He" ? "his" : "her";
  const him = (party) => party.he === "He" ? "him" : "her";
  const exhibit = {
    schemaVersion: 1, id: exhibitId, kind: "signature", title: title(parties),
    caption: `From the marriage register of ${item.place}, ${item.dateLong}. ${sentence(parties)}`,
    citation: `${record.reference}. The parties' lines read ${quote}.`,
    credit: record.source,
    licence: "Shown in this private family viewer by permission",
    checkedAt: today, recordIds: [record.id],
    image: { recordId: record.id, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
      alt: `Two handwritten lines from a marriage register: ${item.groom.line}; ${item.bride.line}.` },
    appliesTo: { people: parties.filter((party) => party.personId).map((party) => ({
      personId: party.personId,
      note: party.how === "signed" ? `${party.he === "He" ? "His" : "Her"} own signature.`
        : party.how === "mark" ? `${party.he === "He" ? "His" : "Her"} name is written for ${him(party)}; the mark is ${party.he === "He" ? "his" : "hers"}.`
          : `${party.he === "He" ? "His" : "Her"} name as it stands in the register.`
    })) }
  };
  const facts = parties.filter((party) => party.personId && party.how !== "unclear").map((party) => ({
    personId: party.personId,
    assertion: {
      id: `assert-${party.personId}-${party.how === "signed" ? "signed" : "mark"}-register-${item.year}`, assessment: "established",
      claim: { kind: "life-fact", personId: party.personId, category: "education",
        value: party.how === "signed" ? `Signed ${his(party)} own name in the marriage register` : `Made ${his(party)} mark in the marriage register`,
        dateText: item.dateText, place: item.place },
      conclusion: party.how === "signed"
        ? `At ${his(party)} marriage at ${item.place} on ${item.dateLong} ${party.name} signed the register ('${party.line}').`
        : `At ${his(party)} marriage at ${item.place} on ${item.dateLong} ${party.name}'s name was written for ${him(party)} and ${party.he.toLowerCase()} made a mark ('${party.line}').`,
      evidence: [{ sourceId, role: "direct", rationale: `The parties' lines of the entry read ${quote}.`, review: { status: "claim-reviewed", method: "original", reviewedAt: today } }],
      questionIds: [], reviewedAt: today
    }
  }));
  // The review gains the literal reading of the parties' lines, so each fact rests on a recorded reading.
  let extended;
  if (review) {
    extended = structuredClone(review);
    if (!extended.readings.some((reading) => reading.id === "sig")) {
      extended.readings.push({ id: "sig", locator: `the parties' lines after 'This Marriage was solemnized between us' (read ${today} for the life-stories checklist)`,
        textAsRecorded: `${item.groom.line} | ${item.bride.line}. ${parties.map((party) => party.how === "signed" ? `${party.name}'s name stands with no mark wording, in a hand unlike the clerk's`
          : party.how === "mark" ? `${party.name}'s name is written for ${him(party)}, with a mark` : `${party.name}'s name: signature or clerk's hand not determined`).join("; ")}.` });
    }
    for (const fact of facts) {
      if (!extended.claimEffects.some((effect) => effect.assertionId === fact.assertion.id)) extended.claimEffects.push({ assertionId: fact.assertion.id, effect: "added", readingIds: ["sig"] });
    }
  }
  return { problems, exhibit, facts, review: extended };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { execFileSync } = await import("node:child_process");
  const { jsonFiles, projectRoot, readJson } = await import("./research-store.mjs");
  const args = process.argv.slice(2);
  const planFile = args.find((value) => value.endsWith(".json"));
  if (!planFile) { console.error("usage: signature-exhibits.mjs <plan.json> [--sheet <out.png>] [--write]"); process.exit(1); }
  const plan = readJson(path.resolve(planFile));
  const today = new Date().toISOString().slice(0, 10);
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json")).records;
  const recordsById = new Map(manifest.map((record) => [record.id, record]));

  if (args.includes("--sheet")) {
    // One image of every crop, cut from the masters, to look at before anything is written.
    const { createRequire } = await import("node:module");
    const sharp = createRequire(path.join(projectRoot, "package.json"))("sharp");
    const archive = process.env.FAMILY_RECORD_ARCHIVE || recordArchiveRoot();
    const placed = [];
    let top = 8;
    for (const item of plan) {
      const file = path.join(archive, path.basename(recordsById.get(item.id).archivePath));
      const info = await sharp(file).metadata();
      const box = { left: Math.floor(item.crop.x * info.width), top: Math.floor(item.crop.y * info.height),
        width: Math.floor(item.crop.width * info.width), height: Math.floor(item.crop.height * info.height) };
      const input = await sharp(file).extract(box).resize({ width: 760, height: 150, fit: "inside" }).png().toBuffer();
      placed.push({ input, left: 8, top });
      top += (await sharp(input).metadata()).height + 10;
    }
    await sharp({ create: { width: 776, height: top, channels: 3, background: "#777" } }).composite(placed).png().toFile(args[args.indexOf("--sheet") + 1]);
    console.log(`sheet rows, top to bottom:\n${plan.map((item, index) => `${index + 1}. ${item.id}`).join("\n")}`);
    process.exit(0);
  }

  const write = args.includes("--write");
  const sourcesById = new Map(jsonFiles(path.join(projectRoot, "evidence", "sources"), { recursive: true }).map((file) => readJson(file)).map((source) => [source.id, source]));
  const changed = new Set();
  let failed = 0;
  for (const item of plan) {
    const record = recordsById.get(item.id);
    const reviewFile = record ? path.join(projectRoot, "evidence", "extraction", "reviews", record.id, `${record.sha256}.json`) : null;
    const built = buildSignatureEntry(item, { record, source: sourcesById.get(record?.sourceAtomId || item.id), review: reviewFile && fs.existsSync(reviewFile) ? readJson(reviewFile) : null, today });
    if (built.problems.length) { failed += 1; console.log(`REFUSED ${item.slug || item.id}: ${built.problems.join("; ")}`); continue; }
    console.log(`+ ${built.exhibit.id}: ${built.exhibit.title}\n    ${built.exhibit.caption}\n    facts: ${built.facts.map((fact) => fact.assertion.id).join(", ") || "none"}`);
    if (!write) continue;
    fs.writeFileSync(path.join(projectRoot, "evidence", "exhibits", `${built.exhibit.id}.json`), `${JSON.stringify(built.exhibit, null, 2)}\n`);
    for (const { personId, assertion } of built.facts) {
      const file = path.join(projectRoot, "evidence", "proof", "people", `${personId}.json`);
      const bundle = readJson(file);
      if (!bundle.assertions.some((entry) => entry.id === assertion.id)) bundle.assertions.push(assertion);
      bundle.presentation.biographyFacts ||= [];
      if (!bundle.presentation.biographyFacts.some((entry) => entry.assertionId === assertion.id)) bundle.presentation.biographyFacts.push({ assertionId: assertion.id, prominence: "supporting" });
      fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
      changed.add(personId);
    }
    for (const entry of built.exhibit.appliesTo.people) {
      const file = path.join(projectRoot, "evidence", "life-stories", "checklists", `${entry.personId}.json`);
      const checklist = fs.existsSync(file) ? readJson(file) : { schemaVersion: 1, personId: entry.personId, documents: {}, lanes: {} };
      checklist.lanes.signatures = { outcome: "done", date: today, exhibitIds: [built.exhibit.id] };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(checklist, null, 2)}\n`);
    }
    if (built.review) {
      const input = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "signature-review-")), "review.json");
      fs.writeFileSync(input, JSON.stringify(built.review, null, 2));
      const result = execFileSync("node", ["tools/records-extract-review.mjs", "--input", input, "--replace"], { cwd: projectRoot, encoding: "utf8" });
      console.log(`    review: ${result.trim().split("\n").pop()}`);
    }
  }
  console.log(`\n${write ? "WROTE" : "DRY RUN"}: ${plan.length - failed} of ${plan.length}${write ? `; people changed: ${[...changed].join(" ") || "none"}. Next: exhibits:check, page-depth:check, life-stories:refresh for those on the tree.` : ""}`);
  if (failed) process.exit(1);
}
