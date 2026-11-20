import assert from "node:assert/strict";
import test from "node:test";
import { extractLocators, locatorIsCovered, uncoveredFindingsLocators, uncoveredLocators } from "./unarchived-reads.mjs";

test("extracts Findmypast, FamilySearch and TNA locators and expands frame ranges", () => {
  const keys = extractLocators("WILLS/368640, film 007622732 frames 00409-00411; GBPRS/STAFF/WILLS/392401 at 007622959/00201; DGS 004450842 image 407; ark 3:1:33SQ-GPKP-SXP9; TNA PROB 11/219/28 and E 179/256/31");
  assert.deepEqual(keys, [
    "ark:3:1:33SQ-GPKP-SXP9",
    "dgs:004450842/407",
    "fmp:GBPRS/STAFF/WILLS/368640",
    "fmp:GBPRS/STAFF/WILLS/392401",
    "frame:007622732/00409",
    "frame:007622732/00410",
    "frame:007622732/00411",
    "frame:007622959/00201",
    "tna:E 179/256/31",
    "tna:PROB 11/219/28"
  ]);
});

test("a frame is covered by a URL-encoded viewer id, a transcript by its id", () => {
  const corpus = "https://search.findmypast.com/record?id=GBPRS%2FSTAFF%2F007622719%2F00185&parentid=GBPRS%2FSTAFF%2FWILLS%2F366749";
  assert.equal(locatorIsCovered("frame:007622719/00185", corpus), true);
  assert.equal(locatorIsCovered("fmp:GBPRS/STAFF/WILLS/366749", corpus), true);
  assert.equal(locatorIsCovered("frame:007622719/00186", corpus), false);
  assert.equal(locatorIsCovered("dgs:004450842/407", "Wirksworth DGS 4450842 image 407 burial"), true);
});

test("dismissed and covered locators are not reported", () => {
  const dismissed = new Map([["frame:007605031/00494", { reason: "negative page" }]]);
  const missing = uncoveredLocators("film 007605031 frames 00494-00496", "007605031/00495", dismissed);
  assert.deepEqual(missing, ["frame:007605031/00496"]);
});

test("text without locators reports nothing", () => {
  assert.deepEqual(extractLocators("Searched the FreeREG index for Example baptisms 1670-1690."), []);
});

test("extracts Ancestry record and image ids and Findmypast browse-volume frames", () => {
  const keys = extractLocators("Ancestry 61687/270429; https://www.ancestry.com/search/collections/6598/records/24634615; collection 61686 record 180125; image id **GLSRG12_1959_1961-0502** (https://www.ancestry.com/imageviewer/collections/61687/images/engl0082d_p-ht-r-4-c_m_00291). Image GBPRS/CANT/PB52/CCA-U3-30-1-5/00106.");
  assert.deepEqual(keys, [
    "ancestry-image:GLSRG12_1959_1961-0502",
    "ancestry-image:engl0082d_p-ht-r-4-c_m_00291",
    "ancestry:61686/180125",
    "ancestry:61687/270429",
    "ancestry:6598/24634615",
    "fmp-image:GBPRS/CANT/PB52/CCA-U3-30-1-5/00106"
  ]);
});

test("an Ancestry record is covered by its record URL, id pair or reference wording", () => {
  assert.equal(locatorIsCovered("ancestry:61687/270429", "https://www.ancestry.com/search/collections/61687/records/270429"), true);
  assert.equal(locatorIsCovered("ancestry:61687/270429", '"value": "ancestry:61687:270429"'), true);
  assert.equal(locatorIsCovered("ancestry:61687/270429", "Ancestry collection 61687 record 270429"), true);
  assert.equal(locatorIsCovered("ancestry:61687/270429", '"value": "61687/2704291"'), false);
  assert.equal(locatorIsCovered("ancestry-image:rg14_05135_0069_03", "image rg14_05135_0069_03"), true);
  assert.equal(locatorIsCovered("fmp-image:GBPRS/CANT/PB52/CCA-U3-30-1-5/00106", "record/browse?id=gbprs%2fcant%2fpb52%2fcca-u3-30-1-5%2f00106"), true);
  assert.equal(locatorIsCovered("fmp-image:GBPRS/CANT/PB52/CCA-U3-30-1-5/00106", "GBPRS/CANT/PB52/CCA-U3-30-1-5/00107"), false);
});

test("findings files report image locators only, by wrapped block", () => {
  const findings = [
    "- Index only: transcript GBPRS/CANT/B/96058285 and Ancestry 7619/1776179.",
    "- **Burial of John Example.** Ancestry 61687 record 270429; image id",
    "  **engl0082d_p-ht-r-4-c_m_00291**, page 291.",
    "- 1891 census: Ancestry 6598/24634615; image id **GLSRG12_1959_1961-0502**.",
    "",
    "Image GBPRS/CANT/005264838/00178 read; film 007605031 frame 00494 read for the negative."
  ].join("\n");
  const corpus = "https://www.ancestry.com/search/collections/61687/records/270429";
  const dismissed = new Map([["frame:007605031/00494", { reason: "negative page" }]]);
  assert.deepEqual(uncoveredFindingsLocators(findings, corpus, dismissed), [
    "ancestry-image:GLSRG12_1959_1961-0502",
    "frame:005264838/00178"
  ]);
});

test("an ark keeps a one-character last segment, and an older shortened dismissal still covers it", () => {
  assert.deepEqual(extractLocators("ark 3:1:3Q9M-CSTT-79NG-V and ark:/61903/3:1:9Q97-YMF7-5"), [
    "ark:3:1:3Q9M-CSTT-79NG-V",
    "ark:3:1:9Q97-YMF7-5"
  ]);
  assert.equal(locatorIsCovered("ark:3:1:9Q97-YMF7-5", "https://www.familysearch.org/ark:/61903/3:1:9Q97-YMF7-9"), false);
  const dismissed = new Map([["ark:3:1:3Q9M-CSTT-79NG", { reason: "keyed before the fix" }]]);
  assert.deepEqual(uncoveredLocators("ark 3:1:3Q9M-CSTT-79NG-V; ark 3:1:9Q97-YMF7-5", "", dismissed), ["ark:3:1:9Q97-YMF7-5"]);
});
