import assert from "node:assert/strict";
import test from "node:test";
import {
  generatedSourceTitle,
  titleNameFromReading,
  validatePersonLinks,
  validateTitlePresentation
} from "./source-person-links.mjs";

const namedLink = {
  personId: "person",
  identificationStatus: "candidate",
  evidenceBasis: "named",
  names: [{ asRecorded: "G. Example", interpretation: "Giuseppe Example", origin: "index", preferred: true }]
};

test("source person links preserve candidate identity and faithful readings", () => {
  const source = {
    id: "source",
    people: ["person"],
    personLinks: [namedLink],
    personLinksVerifiedAt: "2026-07-13",
    personLinksVerificationBasis: "Fixture"
  };
  assert.deepEqual(validatePersonLinks(source, { personIds: new Set(["person"]) }), []);
  assert.ok(validatePersonLinks({
    ...source,
    personLinks: [{ ...namedLink, names: [] }]
  }, { personIds: new Set(["person"]) }).some((issue) => /requires a name reading/.test(issue)));
});

test("directly evidenced continuation pages cannot inherit a recorded name", () => {
  const source = {
    id: "continuation",
    people: ["person"],
    personLinksVerifiedAt: "2026-07-13",
    personLinksVerificationBasis: "Fixture",
    personLinks: [{
      personId: "person",
      identificationStatus: "confirmed",
      evidenceBasis: "directly-evidenced",
      names: [{ asRecorded: "Copied Name", origin: "original", preferred: true }]
    }]
  };
  assert.ok(validatePersonLinks(source, { personIds: new Set(["person"]) })
    .some((issue) => /cannot claim a recorded name/.test(issue)));
});

test("an explicitly reviewed source may contain no family person", () => {
  assert.deepEqual(validatePersonLinks({
    id: "unlinked-page",
    people: [],
    personLinks: [],
    personLinksVerifiedAt: "2026-07-13",
    personLinksVerificationBasis: "Original visually reviewed; no family person is present"
  }, { personIds: new Set(["joseph"]) }), []);
  assert.match(validatePersonLinks({
    id: "unreviewed-page",
    people: []
  })[0], /personLinks array/);
});

test("source titles are generated only from explicit principals", () => {
  const atomMap = new Map([["source", {
    personLinks: [namedLink],
    unlinkedNames: [{ id: "child", asRecorded: "Maria Example", origin: "original" }]
  }]]);
  const presentation = {
    titleMode: "people",
    titlePrincipals: [{ personId: "person", sourceAtomId: "source" }],
    category: "Passenger manifest"
  };
  assert.deepEqual(validateTitlePresentation(presentation, atomMap, new Set(["person"])), []);
  assert.equal(
    generatedSourceTitle(presentation, atomMap, new Set(["person"])),
    "Giuseppe Example — Passenger manifest"
  );
  const unlinkedPresentation = {
    titleMode: "people",
    titlePrincipals: [{ unlinkedNameId: "child", sourceAtomId: "source" }],
    category: "Baptism register"
  };
  assert.deepEqual(validateTitlePresentation(unlinkedPresentation, atomMap, new Set(["person"])), []);
  assert.equal(
    generatedSourceTitle(unlinkedPresentation, atomMap, new Set(["person"])),
    "Maria Example — Baptism register"
  );
  assert.equal(generatedSourceTitle({
    titleMode: "category-only",
    category: "Passenger manifest",
    titleQualifier: "second sheet"
  }, atomMap, new Set(["person"])), "Passenger manifest — second sheet");
  assert.ok(validateTitlePresentation({
    titleMode: "category-only",
    category: "Baptism register",
    titleQualifier: "Maria Example, 1882"
  }, atomMap, new Set(["person"])).some((issue) => /document structure/.test(issue)));
});

test("titles show an interpretation only when it reads as a name", () => {
  assert.equal(titleNameFromReading({ asRecorded: "Margaret L.", interpretation: "Margaret L. Augenstein" }), "Margaret L. Augenstein");
  assert.equal(titleNameFromReading({ asRecorded: "Sample, Mrs. Rosa", interpretation: "Rosa Sample" }), "Rosa Sample");
  assert.equal(titleNameFromReading({ asRecorded: "Ann Hoy", interpretation: "deceased, daughter of John Example and Ann Sample" }), "Ann Hoy");
  assert.equal(titleNameFromReading({ asRecorded: "Sarah Peirce", interpretation: "widow and relict of Thomas Sample; releasor of dower" }), "Sarah Peirce");
  assert.equal(titleNameFromReading({ asRecorded: "Hannah", interpretation: "Buried 23 Jul 1851 aged 89" }), "Hannah");
  assert.equal(titleNameFromReading({ asRecorded: "Frank" }), "Frank");
});
