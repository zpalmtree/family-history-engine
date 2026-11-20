import assert from "node:assert/strict";
import test from "node:test";
import { buildGedcom, splitDisplayName, storeDateToGedcom } from "./gedcom-export.mjs";
import { childValue, children, indexRecords, parseGedcom } from "./gedcom.mjs";

test("store date text converts to GEDCOM dates", () => {
  const cases = {
    "30 Nov 1812": "30 NOV 1812",
    "Aug 1829": "AUG 1829",
    "1850": "1850",
    "about 1752-1753": "BET 1752 AND 1753",
    "about 1752-53": "BET 1752 AND 1753",
    "c. 1850": "ABT 1850",
    "before 22 Jan 1329/30": "BEF 22 JAN 1329/30",
    "on or before 16 Feb 1767": "BEF 16 FEB 1767",
    "by 1 Apr 1729": "BEF 1 APR 1729",
    "after 1900": "AFT 1900",
    "19 June 1815": "19 JUN 1815",
    "between 5 Nov and 24 Dec 1735": "BET 5 NOV 1735 AND 24 DEC 1735",
    "between 5 and 13 Feb 1733/4": "BET 5 FEB 1733/4 AND 13 FEB 1733/4",
    "bet. 3 Sep 1756 and 10 May 1757": "BET 3 SEP 1756 AND 10 MAY 1757",
    "Sep quarter 1864": "(Sep quarter 1864)",
    "": null
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(storeDateToGedcom(input), expected, input);
});

test("display names split into given name and surname", () => {
  assert.deepEqual(splitDisplayName("Ann Mary Fixture"), { given: "Ann Mary", surname: "Fixture", suffix: "" });
  assert.deepEqual(splitDisplayName("John Fixture Jr."), { given: "John", surname: "Fixture", suffix: "Jr." });
  assert.deepEqual(splitDisplayName("Mononym"), { given: "Mononym", surname: "" });
});

const assertion = (id, assessment, claim, extra = {}) => ({ id, assessment, claim, conclusion: "test", evidence: [{ sourceId: "src-register", role: "direct", rationale: "test" }], ...extra });
const person = (personId, name, assertions = [], treeParentAssertionIds = []) => ({
  schemaVersion: 2,
  personId,
  presentation: { displayNameAssertionId: `${personId}-name`, treeParentAssertionIds },
  assertions: [assertion(`${personId}-name`, "established", { kind: "name", personId, value: name, display: true }), ...assertions]
});

function fixtureStore() {
  return {
    people: [
      person("child", "Ann Fixture", [
        assertion("child-birth", "established", { kind: "event", subjectType: "person", subjectId: "child", eventType: "birth", dateText: "12 Mar 1851", place: "Exampleton" }),
        assertion("child-father", "established", { kind: "parentage", childId: "child", parentId: "father", role: "father" }),
        assertion("child-mother", "candidate", { kind: "parentage", childId: "child", parentId: "mother", role: "mother" }, { limitations: "one source" }),
        assertion("child-death", "rejected", { kind: "event", subjectType: "person", subjectId: "child", eventType: "death", dateText: "1900" })
      ], ["child-father", "child-mother"]),
      person("father", "John Fixture"),
      person("mother", "Mary Example"),
      person("living", "Present Day", [
        assertion("living-status", "established", { kind: "life-status", value: "living" }),
        assertion("living-birth", "established", { kind: "event", subjectType: "person", subjectId: "living", eventType: "birth", dateText: "1990" })
      ])
    ],
    unions: [{
      unionId: "union-father-mother",
      presentation: { leftPersonId: "father", rightPersonId: "mother", leftRole: "father", rightRole: "mother", unionAssertionId: "u", eventAssertionIds: ["u-marr"] },
      assertions: [
        assertion("u", "established", { kind: "union", personIds: ["father", "mother"] }),
        assertion("u-marr", "established", { kind: "event", subjectType: "union", subjectId: "union-father-mother", eventType: "marriage", dateText: "1850", placeText: "Exampleton" })
      ]
    }],
    sources: new Map([["src-register", { id: "src-register", source: "Exampleton parish register", provider: "Test archive", locators: [{ kind: "canonical-url", value: "https://example.org/register" }] }]])
  };
}

test("exports people, one family per parent pair, assessments, sources and living privacy", () => {
  const text = buildGedcom(fixtureStore(), { now: new Date("2026-11-19T12:00:00Z") });
  const index = indexRecords(parseGedcom(text));
  assert.equal(index.individuals.length, 4);
  assert.equal(index.families.length, 1);
  assert.equal(index.sources.length, 1);
  const byUid = new Map(index.individuals.map((record) => [childValue(record, "_UID"), record]));
  const child = byUid.get("child");
  assert.equal(childValue(child, "NAME"), "Ann /Fixture/");
  assert.equal(childValue(children(child, "BIRT")[0], "DATE"), "12 MAR 1851");
  assert.equal(children(child, "DEAT").length, 0, "rejected assertions are never exported");
  assert.match(childValue(children(child, "FAMC")[0], "NOTE"), /mother link is candidate/);
  assert.equal(childValue(byUid.get("father"), "SEX"), "M");
  assert.equal(childValue(byUid.get("mother"), "SEX"), "F");
  const family = index.families[0];
  assert.equal(childValue(family, "HUSB"), child && childValue(byUid.get("father"), "_UID") && byUid.get("father").xref);
  assert.equal(childValue(children(family, "MARR")[0], "DATE"), "1850");
  const living = byUid.get("living");
  assert.equal(childValue(living, "NAME"), "Living //");
  assert.equal(children(living, "BIRT").length, 0);
  assert.equal(childValue(index.sources[0], "TITL"), "Exampleton parish register");
});

test("established-only drops candidate links; include-living keeps living details", () => {
  const strict = indexRecords(parseGedcom(buildGedcom(fixtureStore(), { establishedOnly: true, includeLiving: true })));
  const family = strict.families.find((record) => children(record, "CHIL").length);
  assert.ok(family);
  assert.equal(children(family, "WIFE").length, 0, "the candidate mother is not linked");
  const living = strict.individuals.find((record) => childValue(record, "_UID") === "living");
  assert.equal(childValue(living, "NAME"), "Present /Day/");
});
