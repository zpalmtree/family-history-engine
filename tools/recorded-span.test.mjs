import assert from "node:assert/strict";
import test from "node:test";
import { recordYear, recordYears, recordYearsByPerson, recordedSpan } from "./recorded-span.mjs";

const record = (date, extra = {}) => ({ id: "r", people: ["ann"], viewer: { date, category: "Baptism register", ...extra } });

test("a record's year comes only from its own single-year date", () => {
  assert.equal(recordYear(record("23 Mar 1788")), 1788);
  assert.equal(recordYear(record("1748-03-07")), 1748);
  assert.equal(recordYear(record("17 Feb 1722/23")), 1723, "Old Style dates use the modern year");
  assert.equal(recordYear(record("10 Mar 1699/00")), 1700);
  assert.equal(recordYear(record("1729/0")), 1730);
  assert.equal(recordYear(record("22 Sep–27 Oct 1804")), 1804);
  assert.equal(recordYear(record("1770-1775")), null, "a multi-year volume is not a year of mention");
  assert.equal(recordYear(record("9 Sep 1823 / 23 Feb 1825")), null);
  assert.equal(recordYear(record("Undated")), null);
  assert.equal(recordYear(record("Catalogued 1917; text includes 1921")), null);
  assert.equal(recordYear(record("9 [March/May unresolved]1820")), null);
  assert.equal(recordYear({ id: "r", people: ["ann"] }), null);
});

test("later and secondary records never anchor a person", () => {
  for (const category of ["County history", "Printed visitation pedigree", "Compiled family history", "Directory", "Gravestone"]) {
    assert.equal(recordYear(record("1880", { category })), null, category);
  }
  assert.equal(recordYear({ id: "deed-1853-control", people: ["ann"], viewer: { date: "1853", category: "Deed" } }), 1853,
    "a -control id is an acquisition label; its verified people are named in it");
});

test("a record of separate dated entries names a person in each year", () => {
  assert.deepEqual(recordYears(record("1762 and 1764")), [1762, 1764]);
  assert.equal(recordYear(record("1762 and 1764")), null);
  assert.deepEqual(recordYears(record("between 22 Sep and 27 Oct 1804")), [1804]);
  assert.deepEqual(recordYears(record("between 1801 and 1810")), [], "a window is not a list");
  const years = recordYearsByPerson([{ id: "b", people: ["mary"], viewer: { date: "1762 and 1764", category: "Baptism register" } }]);
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, years.get("mary")), { from: 1762, to: 1764 });
});

test("dated established life facts anchor a person; a visitation pedigree is the last resort", () => {
  const fact = (dateText, assessment = "established") => ({ dateText, proof: { assessment } });
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [], biographyFacts: [fact("1614"), fact("7 Apr 1640")] }, undefined),
    { from: 1614, to: 1640 });
  assert.equal(recordedSpan({ lifeStatus: "deceased", events: [], biographyFacts: [fact("1614", "candidate")] }, undefined), null,
    "a candidate fact does not anchor");
  const years = recordYearsByPerson([
    { id: "v1", people: ["ann"], viewer: { date: "28 Apr 1664", category: "Printed visitation pedigree" } },
    { id: "v2", people: ["ann", "tom"], viewer: { date: "1583", category: "Printed visitation pedigree" } },
    { id: "v3", people: ["tom"], viewer: { date: "1614-1664", category: "Printed visitation pedigree" } },
    { id: "c", people: ["tom"], viewer: { date: "1600", category: "Baptism register" } }
  ]);
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, years.get("ann")), { from: 1583, to: 1583, kind: "pedigree" },
    "the earliest visitation naming them");
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, years.get("tom")), { from: 1600, to: 1600 },
    "any dated record outranks a pedigree");
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [], biographyFacts: [fact("1614")] }, years.get("ann")), { from: 1614, to: 1614 });
  const recordsById = new Map([
    ["sketch", { id: "sketch", viewer: { date: "1897", category: "Biographical history" } }],
    ["visit", { id: "visit", viewer: { date: "1614", category: "Printed visitation pedigree" } }]
  ]);
  const cited = (dateText, id) => ({ dateText, proof: { assessment: "established", viewerRecordIds: [id] } });
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [],
    biographyFacts: [cited("1897", "sketch"), cited("1798", "sketch")] }, undefined, { recordsById }), { from: 1798, to: 1798 },
  "a fact dated only by the history that reports it does not anchor; a year the history states does");
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [], biographyFacts: [cited("1614", "visit")] }, undefined, { recordsById }),
    { from: 1614, to: 1614 }, "a visitation states the family as it stood that year");
});

test("the span covers the records naming a person with no dated vital event", () => {
  const years = recordYearsByPerson([
    { id: "a", people: ["ann", "john"], viewer: { date: "1689", category: "Will" } },
    { id: "b", people: ["ann"], viewer: { date: "3 May 1675", category: "Baptism register" } },
    { id: "c", people: ["ann"], viewer: { date: "1880", category: "County history" } }
  ]);
  assert.deepEqual([...years.get("ann").years].sort(), [1675, 1689]);
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, years.get("ann")), { from: 1675, to: 1689 });
  assert.deepEqual(recordedSpan({ lifeStatus: "unknown", events: [{ type: "marriage", date: "1660" }] }, years.get("ann")),
    { from: 1660, to: 1689 }, "the person's own dated events count");
  assert.equal(recordedSpan({ lifeStatus: "deceased", events: [{ type: "burial", date: "about 1700" }] }, years.get("ann")), null,
    "any dated birth, baptism, death or burial wins");
  assert.equal(recordedSpan({ lifeStatus: "living", events: [] }, years.get("ann")), null, "living people stay private");
  assert.equal(recordedSpan({ lifeStatus: "deceased", events: [{ type: "death", date: "" }] }, undefined), null);
});

test("a child's or spouse's death, or a child's marriage, does not anchor a parent", () => {
  const records = [
    { id: "own-marriage", people: ["henry", "mary"], viewer: { date: "1820", category: "Marriage register" } },
    { id: "son-baptism", people: ["henry", "mary", "frederick"], viewer: { date: "1825", category: "Baptism register" } },
    { id: "census", people: ["henry", "frederick"], viewer: { date: "1850", category: "Census" } },
    { id: "son-marriage", people: ["frederick", "henry"], viewer: { date: "1852", category: "Marriage record" } },
    { id: "son-death", people: ["frederick", "henry"], viewer: { date: "1928", category: "Death certificate" } },
    { id: "wife-death", people: ["mary", "henry"], viewer: { date: "1890", category: "Death record" } },
    { id: "own-administration", people: ["henry", "frederick"], viewer: { date: "1882", category: "Administration" } }
  ];
  const years = recordYearsByPerson(records, {
    childrenOf: new Map([["henry", new Set(["frederick"])], ["mary", new Set(["frederick"])]]),
    spousesOf: new Map([["henry", new Set(["mary"])], ["mary", new Set(["henry"])]])
  });
  assert.deepEqual([...years.get("henry").years].sort(), [1820, 1825, 1850, 1882]);
  assert.deepEqual([...years.get("henry").laterMentions].sort(), [1852, 1890, 1928]);
  assert.deepEqual([...years.get("frederick").years].sort(), [1825, 1850, 1852, 1882, 1928], "the child keeps every record");
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, years.get("henry")), { from: 1820, to: 1882 });
  const onlyLater = recordYearsByPerson(records.filter((record) => ["son-marriage", "son-death"].includes(record.id)), {
    childrenOf: new Map([["henry", new Set(["frederick"])]])
  });
  assert.deepEqual(recordedSpan({ lifeStatus: "deceased", events: [] }, onlyLater.get("henry")), { from: 1852, to: 1852 },
    "with only later mentions, the earliest one anchors the person");
});
