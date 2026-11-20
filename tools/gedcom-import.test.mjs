import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gedcomDateToStore, planImport, slugify } from "./gedcom-import.mjs";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fixture-tree.ged"), "utf8");

test("GEDCOM dates become store date text", () => {
  assert.equal(gedcomDateToStore("12 MAR 1851"), "12 Mar 1851");
  assert.equal(gedcomDateToStore("ABT 1850"), "about 1850");
  assert.equal(gedcomDateToStore("BEF 1 JAN 1900"), "before 1 Jan 1900");
  assert.equal(gedcomDateToStore("BET 1870 AND 1872"), "between 1870 and 1872");
  assert.equal(gedcomDateToStore("(Sep quarter 1864)"), "Sep quarter 1864");
  assert.equal(gedcomDateToStore(""), null);
  assert.equal(slugify("Ännchen O'Brien-Smith"), "annchen-o-brien-smith");
});

test("the fixture imports as candidate leads with one bridge question per child", () => {
  const plan = planImport(fixture, { fileName: "fixture-tree.ged", today: "2026-11-19", treeAddedAt: "2026-11-19T12:00:00+00:00" });
  assert.equal(plan.people.length, 31);
  assert.equal(plan.unions.length, 15);
  assert.equal(plan.questions.length, 15);
  assert.equal(plan.source.kind, "family-statement");
  assert.equal(plan.rootPersonId, plan.people[0].personId);
  const ids = new Set(plan.people.map((person) => person.personId));
  assert.equal(ids.size, 31, "person ids are unique");
  for (const person of plan.people) {
    assert.equal(person.treeAddedAt, "2026-11-19T12:00:00+00:00");
    const name = person.assertions.find((assertion) => assertion.id === person.presentation.displayNameAssertionId);
    assert.equal(name.claim.kind, "name");
    for (const assertion of person.assertions) {
      if (assertion === name) continue;
      assert.equal(assertion.assessment, "candidate", `${assertion.id} is a lead, not proof`);
      assert.ok(assertion.limitations);
      assert.equal(assertion.evidence[0].sourceId, plan.source.id);
    }
    for (const assertionId of person.presentation.treeParentAssertionIds) {
      const parentage = person.assertions.find((assertion) => assertion.id === assertionId);
      assert.equal(parentage.claim.kind, "parentage");
      const question = plan.questions.find((entry) => entry.id === parentage.questionIds[0]);
      assert.ok(question.assertionIds.includes(assertionId), "question links are reciprocal");
    }
  }
  const root = plan.people[0];
  assert.equal(root.presentation.treeParentAssertionIds.length, 2);
  assert.ok(root.assertions.some((assertion) => assertion.claim.kind === "ancestry-origin" && assertion.claim.value === "England"));
});

test("existing ids are never reused", () => {
  const first = planImport(fixture, { fileName: "fixture-tree.ged" });
  const again = planImport(fixture, { fileName: "fixture-tree.ged", existingIds: new Set(first.people.map((person) => person.personId)) });
  const overlap = again.people.filter((person) => first.people.some((other) => other.personId === person.personId));
  assert.deepEqual(overlap, []);
});
