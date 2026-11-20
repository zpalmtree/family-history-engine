import assert from "node:assert/strict";
import test from "node:test";
import { groIndexSearchBounds, parseGroIndexSearchPairs, unparsedGroIndexPairs, verifyGroIndexSearchFields } from "./gro-index-search.mjs";
import { groIndexCoverage } from "./gro-index-results.mjs";

const target = { person: "William Millard", event: "birth", year: "1844", sex: "Male", groDistrict: "Clifton", readyForPaidOrder: false, groIndexSearch: { yearRange: 2 } };
const entry = (year = 1844, district = "THE CLIFTON UNION") => ({ name: "MILLARD, WILLIAM", maternalSurname: "POOL", reference: `GRO Reference: ${year} J Quarter in ${district} Volume 11 Page 317` });
const fields = Object.entries({ surname: "Millard", "first-forename": "William", district: "Clifton", year: "1844", "year-range": "2", sex: "Male", "second-forename-clear": "", "mother-maiden-surname-clear": "", "volume-clear": "", "page-clear": "", "quarter-clear": "" }).map(([purpose, value]) => ({ purpose, value, text: value }));
fields.push(...["SurnameMatches", "ForenameMatches", "MothersSurnameMatches"].map((name) => ({ purpose: `match-mode-${name}`, value: "E", text: "Exact matches only" })));

test("exploratory targets cannot enter order workflows or carry stale reference/MMN filters", () => {
  for (const mode of ["order", "queue", "resume", "profile", "dry-run"]) assert.throws(() => groIndexSearchBounds(target, mode));
  for (const patch of [{ readyForPaidOrder: true }, { event: "death" }, { volume: "11" }, { quarter: "Jun" }, { page: "317" }, { groMotherMaidenSurname: "Pool" }, { groDistrict: "" }, { sex: "" }, { year: "1844 OR 1845" }]) assert.throws(() => groIndexSearchBounds({ ...target, ...patch }));
  for (const yearRange of [-1, 3, 1.5, "2", null]) assert.throws(() => groIndexSearchBounds({ ...target, groIndexSearch: { yearRange } }));
  assert.equal(groIndexSearchBounds({ person: "legacy target" }), null);
});

test("inclusive range and district aliases retain all maternal surnames without invented kinship", () => {
  const rows = [entry(1842), { ...entry(1846, "CLIFTON"), maternalSurname: "POOLE" }, { ...entry(), maternalSurname: "OTHER" }, { ...entry(), maternalSurname: "-" }];
  assert.deepEqual(parseGroIndexSearchPairs(rows, target), rows);
  for (const row of [entry(1841), entry(1847), entry(1844, "BRISTOL"), { ...entry(), name: "MILLARDS, WILLIAM" }, { ...entry(), name: "MILLARD, WILLIAMINA" }, { ...entry(), reference: "MILLARD, HANNAH" }]) assert.deepEqual(parseGroIndexSearchPairs([row], target), []);
});

test("postback changes, missing fields and phonetic modes fail query readback", () => {
  assert.equal(verifyGroIndexSearchFields(fields, target, true).ok, true);
  assert.equal(verifyGroIndexSearchFields(fields, target, false).ok, false);
  for (const purpose of ["year", "year-range", "surname", "first-forename", "district", "sex", "mother-maiden-surname-clear", "second-forename-clear", "volume-clear", "page-clear", "quarter-clear"]) {
    const altered = fields.map((field) => field.purpose === purpose ? { ...field, value: "unexpected", text: "unexpected" } : field);
    assert.equal(verifyGroIndexSearchFields(altered, target, true).ok, false, purpose);
  }
  for (const purpose of ["year-range", "volume-clear", "page-clear", "quarter-clear", "match-mode-SurnameMatches", "match-mode-ForenameMatches"]) assert.equal(verifyGroIndexSearchFields(fields.filter((field) => field.purpose !== purpose), target, true).ok, false, purpose);
  assert.equal(verifyGroIndexSearchFields(fields.map((field) => field.purpose === "match-mode-SurnameMatches" ? { ...field, purpose: "match-mode-Unrelated" } : field), target, true).ok, false);
  assert.equal(verifyGroIndexSearchFields(fields.map((field) => field.purpose.startsWith("match-mode") ? { ...field, text: "Phonetically similar" } : field), target, true).ok, false);
});

test("rejected or paginated rows never become complete exploratory coverage", () => {
  const rows = [entry(), entry(1848)];
  const result = { kind: "results", count: 2, candidateCount: 2, entries: parseGroIndexSearchPairs(rows, target), headers: ["", "Name:", "Mother's Maiden Surname:"], text: "Showing Page 1 of 1" };
  assert.equal(groIndexCoverage(result).complete, false);
  assert.equal(groIndexCoverage({ ...result, count: 1, candidateCount: 1, text: "Showing Page 1 of 2" }).complete, false);
});

test("a visible page-less GRO reference remains a result without becoming a complete order reference", () => {
  const fletcher = { ...target, person: "Joseph Fletcher", year: "1848", groDistrict: "Dover" };
  const pair = { name: "FLETCHER, JOSEPH EDWARD", maternalSurname: "READER", reference: "GRO Reference: 1848 J Quarter in DOVER UNION Volume 05" };
  const entries = parseGroIndexSearchPairs([pair], fletcher);
  assert.deepEqual(entries, []);
  assert.deepEqual(unparsedGroIndexPairs([pair], entries), [pair]);
  assert.equal(groIndexCoverage({ kind: "results", count: 1, candidateCount: 1, entries, headers: ["", "Name:", "Mother's Maiden Surname:"], text: "Showing Page1of1" }).complete, false);
  const completePair = { ...pair, reference: `${pair.reference} Page 107` };
  const parsed = parseGroIndexSearchPairs([completePair], fletcher);
  assert.equal(parsed.length, 1);
  assert.deepEqual(unparsedGroIndexPairs([pair, completePair], parsed), [pair]);
});

test("a surname-only pass must be explicit, clears the forename and keeps surname, district and range exact", () => {
  const wills = { person: "Wills", event: "birth", year: "1851", sex: "Female", groDistrict: "Dover", readyForPaidOrder: false, groIndexSearch: { yearRange: 1, surnameOnly: true } };
  assert.deepEqual(groIndexSearchBounds(wills), { surname: "WILLS", forename: "", surnameOnly: true, year: 1851, yearRange: 1, from: 1850, to: 1852, sex: "Female", district: "Dover" });
  assert.equal(groIndexSearchBounds(target).surnameOnly, false);
  for (const patch of [{ person: "Amelia Wills" }, { groIndexSearch: { yearRange: 1, surnameOnly: "yes" } }, { groIndexSearch: { yearRange: 1 } }, { groDistrict: "" }]) assert.throws(() => groIndexSearchBounds({ ...wills, ...patch }));
  assert.throws(() => groIndexSearchBounds({ ...target, groIndexSearch: { yearRange: 2, surnameOnly: true } }));

  const pair = (name, year = 1851, district = "DOVER UNION") => ({ name, maternalSurname: "CANTY", reference: `GRO Reference: ${year} S Quarter in ${district} Volume 05 Page 107` });
  const kept = [pair("WILLS, AMELIA CATHERINE"), pair("WILLS, FLORA", 1850), pair("WILLS, MARY ANN", 1852), pair("WILLS")];
  assert.deepEqual(parseGroIndexSearchPairs(kept, wills), kept);
  for (const row of [pair("WILLSON, MARY"), pair("WILLS, MARY", 1849), pair("WILLS, MARY", 1853), pair("WILLS, MARY", 1851, "RIVER"), { ...pair("WILLS, MARY"), reference: "GRO Reference: 1851 S Quarter in DOVER UNION Volume 05" }]) {
    assert.deepEqual(parseGroIndexSearchPairs([row], wills), [], row.name);
  }

  const willsFields = fields
    .filter((field) => field.purpose !== "first-forename")
    .map((field) => ({ surname: { ...field, value: "Wills", text: "Wills" }, district: { ...field, value: "Dover", text: "Dover" }, year: { ...field, value: "1851", text: "1851" }, "year-range": { ...field, value: "1", text: "1" }, sex: { ...field, value: "Female", text: "Female" } })[field.purpose] || field);
  willsFields.push({ purpose: "first-forename-clear", value: "", text: "" });
  assert.equal(verifyGroIndexSearchFields(willsFields, wills, true).ok, true);
  assert.equal(verifyGroIndexSearchFields(willsFields.map((field) => field.purpose === "first-forename-clear" ? { ...field, value: "AMELIA", text: "AMELIA" } : field), wills, true).ok, false);
  assert.equal(verifyGroIndexSearchFields(willsFields.filter((field) => field.purpose !== "first-forename-clear"), wills, true).ok, false);
  assert.equal(verifyGroIndexSearchFields([...willsFields, { purpose: "first-forename", value: "AMELIA", text: "AMELIA" }], wills, true).ok, false);
  assert.equal(verifyGroIndexSearchFields(willsFields, target, true).ok, false);
});

test("a county suffix on the GRO district does not drop a matching row", () => {
  const target = { person: "Nellie Millard", event: "birth", year: "1893", sex: "Female", groDistrict: "Christchurch", readyForPaidOrder: false, groIndexSearch: { yearRange: 0 } };
  const row = { name: "MILLARD, NELLIE BERTHA", maternalSurname: "SHOOSMITH", reference: "GRO Reference: 1893 S Quarter in CHRISTCHURCH, HANTS Volume 02B Page 671" };
  const parsed = parseGroIndexSearchPairs([row], target);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].maternalSurname, "SHOOSMITH");
  assert.deepEqual(parseGroIndexSearchPairs([{ ...row, reference: "GRO Reference: 1893 S Quarter in POOLE, DORSET Volume 02B Page 671" }], target), []);
});
