import assert from "node:assert/strict";
import test from "node:test";
import { groIndexCoverage, groIndexRowText, hasGroIndexHeaders, parseGroIndexPairs } from "./gro-index-results.mjs";

const target = { person: "John Example", year: 1848, quarter: "Sep", volume: "XI", page: "317" };
const pair = {
  name: "EXAMPLE, JOHN",
  maternalSurname: "POOL",
  reference: "GRO Reference: 1848 S Quarter in THE CLIFTON UNION Volume 11 Page 317"
};

test("reads the split GRO result and preserves the literal maternal surname and reference", () => {
  assert.deepEqual(parseGroIndexPairs([pair], target), [pair]);
});

test("matches letter volumes despite GRO leading zeroes and retains additional forenames", () => {
  const entry = {
    name: "EXAMPLE, JOHN THOMAS", maternalSurname: "SAMPLE",
    reference: "GRO Reference: 1853 S Quarter in CLIFTON Volume 06A Page 90"
  };
  assert.deepEqual(parseGroIndexPairs([entry], { ...target, year: 1853, volume: "6a", page: 90 }), [entry]);
});

test("checks each labeled reference field instead of matching digits elsewhere", () => {
  for (const [from, to] of [["1848", "1849"], ["S Quarter", "J Quarter"], ["Volume 11", "Volume 12"], ["Page 317", "Page 31"]]) {
    assert.deepEqual(parseGroIndexPairs([{ ...pair, reference: pair.reference.replace(from, to) }], target), []);
  }
  assert.deepEqual(parseGroIndexPairs([pair], { ...target, page: "18" }), []);
});

test("does not borrow a later reference from another name row", () => {
  assert.deepEqual(parseGroIndexPairs([
    { ...pair, reference: "EXAMPLE, HANNAH" },
    { ...pair, name: "EXAMPLE, HANNAH" }
  ], target), []);
});

test("rejects surname and first-forename substrings", () => {
  for (const name of ["EXAMPLE, JOHNETTE", "EXAMPLES, JOHN", "EXAMPLE, THOMAS JOHN"]) {
    assert.deepEqual(parseGroIndexPairs([{ ...pair, name }], target), []);
  }
});

test("preserves a blank or dash maternal surname without interpretation", () => {
  for (const maternalSurname of ["", "-"]) {
    assert.equal(parseGroIndexPairs([{ ...pair, maternalSurname }], target)[0].maternalSurname, maternalSurname);
  }
});

test("normalizes whitespace and numeric padding without rewriting literal references", () => {
  const reference = pair.reference.replace("Page 317", "Page 00317");
  assert.deepEqual(parseGroIndexPairs([{ ...pair, name: " EXAMPLE,  JOHN\n", reference }], target), [{ ...pair, reference }]);
});

test("missing or malformed immediate reference yields no extracted entry", () => {
  for (const reference of [undefined, "", "1848 11 317", pair.reference + " unrelated row"]) {
    assert.deepEqual(parseGroIndexPairs([{ ...pair, reference }], target), []);
  }
});

test("an unsupported quarter cannot silently bypass reference validation", () => {
  assert.deepEqual(parseGroIndexPairs([pair], { ...target, quarter: "unknown" }), []);
});

test("complete coverage requires the ordered name and maternal-surname column headings", () => {
  const input = { kind: "results", count: 1, text: "1 Record(s) Found - Showing Page 1 of 1", candidateCount: 1, entries: [pair] };
  for (const headers of [["", "Name:", "Mother's Maiden Surname:"], ["", "NAME", "Mother’s Maiden Surname:"]]) {
    assert.equal(groIndexCoverage({ ...input, headers }).complete, true);
  }
  for (const headers of [[], ["Name:"], ["", "Name:", "District:"], ["", "Mother's Maiden Surname:", "Name:"]]) {
    const result = groIndexCoverage({ ...input, headers });
    assert.equal(result.headerRecognized, false);
    assert.equal(result.complete, false);
  }
});

test("pagination, mismatched counts and capture ceiling cannot claim complete coverage", () => {
  const input = { kind: "results", count: 1, text: "Showing Page 1 of 1", candidateCount: 1, entries: [pair], headers: ["", "Name:", "Mother's Maiden Surname:"] };
  for (const patch of [{ text: "Showing Page 1 of 2" }, { count: 2 }, { candidateCount: 51 }, { kind: "unknown" }]) {
    assert.equal(groIndexCoverage({ ...input, ...patch }).complete, false);
  }
});

test("reads a death-index row, whose third column is the age at death", () => {
  const death = { person: "John Example", event: "death", year: 1859, quarter: "Dec", volume: "06A", page: "32" };
  const row = { name: "EXAMPLE, JOHN", maternalSurname: "34", reference: "GRO Reference: 1859 D Quarter in BRISTOL Volume 06A Page 32" };
  const [entry] = parseGroIndexPairs([row], death);
  assert.deepEqual(entry, { ...row, ageAtDeath: "34" });
  assert.equal(groIndexRowText(entry), "EXAMPLE, JOHN | Age at death: 34 | GRO Reference: 1859 D Quarter in BRISTOL Volume 06A Page 32");
  assert.deepEqual(parseGroIndexPairs([row], { ...death, groAgeAtDeath: "31" }), []);
  assert.deepEqual(parseGroIndexPairs([row], { ...death, groAgeAtDeath: "34" }), [entry]);
  assert.equal(groIndexRowText(parseGroIndexPairs([pair], target)[0]), "EXAMPLE, JOHN | Mother's maiden surname: POOL | GRO Reference: 1848 S Quarter in THE CLIFTON UNION Volume 11 Page 317");
});

test("each index layout is recognized only for its own event", () => {
  const birthHeaders = ["", "Name:", "Mother's Maiden Surname:"];
  const deathHeaders = ["", "Name:", "Age at Death (in years):"];
  assert.equal(hasGroIndexHeaders(birthHeaders), true);
  assert.equal(hasGroIndexHeaders(deathHeaders), true);
  assert.equal(hasGroIndexHeaders(birthHeaders, "birth"), true);
  assert.equal(hasGroIndexHeaders(deathHeaders, "death"), true);
  assert.equal(hasGroIndexHeaders(deathHeaders, "birth"), false);
  assert.equal(hasGroIndexHeaders(birthHeaders, "death"), false);
  assert.equal(hasGroIndexHeaders(["", "Name:", "Spouse:"], "death"), false);
  const coverage = groIndexCoverage({ kind: "results", count: 1, text: "1 Record(s) Found - Showing Page 1 of 1", candidateCount: 1, entries: [{}], headers: deathHeaders, event: "death" });
  assert.equal(coverage.complete, true);
  assert.equal(groIndexCoverage({ kind: "results", count: 1, text: "1 Record(s) Found - Showing Page 1 of 1", candidateCount: 1, entries: [{}], headers: deathHeaders, event: "birth" }).complete, false);
});
