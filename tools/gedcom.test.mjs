import assert from "node:assert/strict";
import test from "node:test";
import { childValue, children, formatGedcomDate, formatName, indexRecords, node, parseGedcom, parseGedcomDate, parseName, writeGedcom } from "./gedcom.mjs";

const SAMPLE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Ann /Fixture/",
  "1 SEX F",
  "1 BIRT",
  "2 DATE ABT 1850",
  "2 PLAC Exampleton, Testshire, England",
  "1 NOTE first line that is",
  "2 CONC  continued",
  "2 CONT second line",
  "1 FAMS @F1@",
  "0 @F1@ FAM",
  "1 WIFE @I1@",
  "1 MARR",
  "2 DATE BET 1870 AND 1872",
  "0 TRLR"
].join("\r\n");

test("parses records, levels, CONC and CONT", () => {
  const roots = parseGedcom(`﻿${SAMPLE}`);
  const index = indexRecords(roots);
  assert.equal(index.individuals.length, 1);
  assert.equal(index.families.length, 1);
  const ann = index.byXref.get("@I1@");
  assert.equal(childValue(ann, "SEX"), "F");
  assert.equal(childValue(children(ann, "BIRT")[0], "PLAC"), "Exampleton, Testshire, England");
  assert.equal(childValue(ann, "NOTE"), "first line that is continued\nsecond line");
});

test("refuses malformed lines and skipped levels", () => {
  assert.throws(() => parseGedcom("0 HEAD\nnot a line"), /line 2 is malformed/);
  assert.throws(() => parseGedcom("0 HEAD\n2 VERS 5.5.1"), /skips a level/);
});

test("names round-trip", () => {
  assert.deepEqual(parseName("John Henry /Smith/ Jr"), { given: "John Henry", surname: "Smith", suffix: "Jr", full: "John Henry Smith Jr" });
  assert.deepEqual(parseName("Mary"), { given: "Mary", surname: "", suffix: "", full: "Mary" });
  assert.equal(formatName({ given: "John", surname: "Smith" }), "John /Smith/");
});

test("dates map to ISO values with qualifiers and back", () => {
  assert.deepEqual(parseGedcomDate("12 MAR 1851"), { value: "1851-03-12", qualifier: "exact", text: "12 MAR 1851" });
  assert.deepEqual(parseGedcomDate("ABT 1850"), { value: "1850", qualifier: "about", text: "ABT 1850" });
  assert.deepEqual(parseGedcomDate("bet 1870 and 1872"), { value: "1870", to: "1872", qualifier: "between", text: "bet 1870 and 1872" });
  assert.equal(parseGedcomDate("Spring of the flood").qualifier, "phrase");
  assert.equal(parseGedcomDate("10 FEB 1720/21").value, "1720-02-10");
  assert.equal(formatGedcomDate("1851-03-12"), "12 MAR 1851");
  assert.equal(formatGedcomDate("1850", "about"), "ABT 1850");
  assert.equal(formatGedcomDate("1870", "between", "1872"), "BET 1870 AND 1872");
  assert.equal(formatGedcomDate("not a date"), null);
});

test("writer splits long and multi-line values and re-parses identically", () => {
  const long = "x".repeat(450);
  const text = writeGedcom([node("HEAD"), node("NOTE", `${long}\nline two`, [], "@N1@"), node("TRLR")]);
  assert.match(text, /^1 CONC /m);
  assert.match(text, /^1 CONT line two$/m);
  const note = indexRecords(parseGedcom(text)).byXref.get("@N1@");
  assert.equal(note.value, `${long}\nline two`);
});
