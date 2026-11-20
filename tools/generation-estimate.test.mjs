import assert from "node:assert/strict";
import test from "node:test";
import { dateYears, generationEstimates } from "./generation-estimate.mjs";

const person = (id, events = [], extra = {}) => ({ id, lifeStatus: "deceased", events, ...extra });
const born = (date) => ({ type: "birth", date });
const father = (parentId, childId) => ({ parentId, childId, role: "father" });

test("date years read Old Style and ranges", () => {
  assert.deepEqual(dateYears("17 Feb 1722/23"), { low: 1723, high: 1723 });
  assert.deepEqual(dateYears("c. 1822–1825"), { low: 1822, high: 1825 });
  assert.equal(dateYears("unknown"), null);
});

test("a pedigree line is spread back a generation at a time, not stacked on the visitation year", () => {
  // g4 (born 1580) <- g3 <- g2 <- g1, all three named only in a 1614 pedigree.
  const pedigree = { recordedSpan: { from: 1614, to: 1614, kind: "pedigree" } };
  const people = [person("g4", [born("1580")]), person("g3", [], pedigree), person("g2", [], pedigree), person("g1", [], pedigree)];
  const estimates = generationEstimates(people, { parents: [father("g3", "g4"), father("g2", "g3"), father("g1", "g2")] });
  const mid = (id) => (estimates.get(id).from + estimates.get(id).to) / 2;
  assert.ok(Math.abs(mid("g3") - 1548) <= 5, `g3 about 1548, got ${mid("g3")}`);
  assert.ok(Math.abs(mid("g1") - 1484) <= 8, `g1 about 1484, got ${mid("g1")}`);
  assert.ok(mid("g1") < mid("g2") && mid("g2") < mid("g3"));
  const width = (id) => estimates.get(id).to - estimates.get(id).from;
  assert.ok(width("g1") > width("g3"), "the window widens with each generation from a date");
  assert.deepEqual(estimates.get("g1").nearest, { personId: "g4", type: "birth", date: "1580", generations: 3 });
  assert.ok(!estimates.has("g4"), "a dated person needs no estimate");
});

test("dates above and below are pooled, and hard limits trim the window", () => {
  const people = [
    person("grandfather", [born("1500")]),
    person("father", [{ type: "burial", date: "1570" }]),
    person("son", [born("1562")])
  ];
  const estimates = generationEstimates(people, { parents: [father("grandfather", "father"), father("father", "son")] });
  const estimate = estimates.get("father");
  assert.ok(estimate.from >= 1513 && estimate.to <= 1549, `between the grandfather +13 and the son -13: ${estimate.from}–${estimate.to}`);
});

test("living people are never estimated or named as the nearest relative", () => {
  const people = [
    person("child", [born("1990")], { lifeStatus: "living" }),
    person("parent", [], { lifeStatus: "living" }),
    person("grandparent", [born("1930")]),
    person("aunt", [])
  ];
  const parents = [father("parent", "child"), father("grandparent", "parent"), father("grandparent", "aunt")];
  const estimates = generationEstimates(people, { parents });
  assert.ok(!estimates.has("parent"));
  assert.equal(estimates.get("aunt").nearest.personId, "grandparent");
});

test("someone with no dated relative gets no estimate", () => {
  const estimates = generationEstimates([person("alone", [], { recordedSpan: { from: 1614, to: 1614, kind: "pedigree" } })]);
  assert.equal(estimates.size, 0);
});
