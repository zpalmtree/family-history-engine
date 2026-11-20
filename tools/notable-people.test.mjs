import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectNotableSigns,
  formatApproxMoney,
  moneyToday,
  notableCategories,
  projectNotablePeople,
  uncuratedCandidates,
  validateNotableFile
} from "./notable-people-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const assertion = (id, assessment, claim) => ({ id, assessment, claim });
const store = {
  people: [
    { personId: "sir-roger", assertions: [
      assertion("roger-knight", "established", { kind: "life-fact", category: "other", value: "Was a knight" }),
      assertion("roger-status", "established", { kind: "life-status", value: "deceased" })
    ] },
    { personId: "agnes", assertions: [] },
    { personId: "mayor", assertions: [
      assertion("mayor-office", "candidate", { kind: "life-fact", category: "civic-community-role", value: "Was Mayor of Newcastle" })
    ] },
    { personId: "alive", assertions: [
      assertion("alive-status", "established", { kind: "life-status", value: "living" }),
      assertion("alive-raf", "established", { kind: "life-fact", category: "military-service", value: "Joined the R.A.F." })
    ] },
    { personId: "farmer", assertions: [
      assertion("farmer-occupation", "established", { kind: "occupation", value: "Farmer" }),
      assertion("farmer-acres", "established", { kind: "life-fact", category: "property", value: "Farmed 235 acres" })
    ] }
  ],
  unions: [{ unionId: "u", assertions: [assertion("roger-agnes-union", "established", { kind: "union" })] }],
  personIdAliases: { aliases: [{ alias: "old-farmer", canonicalPersonId: "farmer" }] }
};
const entry = (personId, category, basis, extra = {}) => ({ personId, category, reason: "A reason", basis, ...extra });

test("the curation file is checked for shape only", () => {
  assert.deepEqual(validateNotableFile({ schemaVersion: 1, people: [], declined: [] }), []);
  assert.deepEqual(validateNotableFile({ schemaVersion: 2, people: [], declined: [] }), ["schemaVersion must be 1"]);
  const issues = validateNotableFile({
    schemaVersion: 1,
    people: [
      entry("a", "knight", ["x"]),
      entry("a", "knight", ["x"]),
      { personId: "b", category: "pirate", reason: "Ended with a full stop.", basis: [] },
      entry("c", "trade", ["x"], { rank: 12, colour: "red" }),
      entry("d", "trade", ["x"], { reason: "x".repeat(91) })
    ],
    declined: [{ personId: "a", why: "dup" }, { personId: "e" }]
  });
  for (const expected of [
    /people\[1\] \(a\): listed twice/,
    /people\[2\] \(b\): unknown category pirate/,
    /people\[2\] \(b\): reason must be trimmed and carry no full stop/,
    /people\[2\] \(b\): basis must list at least one assertion id/,
    /people\[3\] \(c\): unknown key colour/,
    /people\[3\] \(c\): rank must be an integer/,
    /people\[4\] \(d\): reason is over 90 characters/,
    /declined\[0\] \(a\): also listed as notable/,
    /declined\[1\] \(e\): why is required/
  ]) assert.ok(issues.some((issue) => expected.test(issue)), `expected ${expected}`);
});

test("an entry is shown only while every basis assertion is established", () => {
  const file = {
    schemaVersion: 1,
    people: [
      entry("sir-roger", "knight", ["roger-knight"], { rank: 1 }),
      entry("agnes", "knight", ["roger-knight", "roger-agnes-union"]),
      entry("mayor", "office", ["mayor-office"]),
      entry("ghost", "trade", ["x"]),
      entry("old-farmer", "wealth", ["farmer-acres", "gone"]),
      entry("alive", "service", ["alive-raf"])
    ],
    declined: []
  };
  const { byPerson, withheld } = projectNotablePeople(file, store);
  assert.deepEqual(byPerson.get("sir-roger"), { category: "knight", reason: "A reason", rank: 1, assertionIds: ["roger-knight"] });
  assert.ok(byPerson.has("agnes"), "a union assertion can be a basis");
  assert.ok(byPerson.has("alive"), "living people may be highlighted (the user's choice, 18 Nov 2026)");
  assert.deepEqual([...byPerson.keys()].sort(), ["agnes", "alive", "sir-roger"]);
  assert.deepEqual(withheld.map((item) => [item.entry.personId, item.why]), [
    ["mayor", "mayor-office is candidate"],
    ["ghost", "person not found"],
    ["old-farmer", "gone not found"]
  ]);
});

test("a malformed file shows nobody rather than throwing", () => {
  const { byPerson, withheld } = projectNotablePeople({ schemaVersion: 1, people: "no" }, store);
  assert.equal(byPerson.size, 0);
  assert.equal(withheld.length, 0);
  assert.equal(projectNotablePeople(null, store).byPerson.size, 0);
});

test("candidates come from established facts and skip anyone already curated", () => {
  const signs = detectNotableSigns(store);
  assert.deepEqual(signs.get("sir-roger").map((sign) => sign.categories), [["knight"]]);
  assert.equal(signs.has("mayor"), false, "a candidate fact is no sign");
  assert.deepEqual(signs.get("farmer").map((sign) => sign.assertionId), ["farmer-acres"], "a plain farmer is no sign");
  const candidates = uncuratedCandidates(
    { people: [entry("sir-roger", "knight", ["roger-knight"])], declined: [{ personId: "alive", why: "living" }] },
    store
  );
  assert.deepEqual(candidates.map((item) => item.personId), ["farmer"]);
  assert.deepEqual(uncuratedCandidates({ people: [], declined: [] }, store, { onTree: new Set(["alive"]) }).map((item) => item.personId), ["alive"]);
});

test("the canonical file is valid and every category is known to the viewer", () => {
  const file = JSON.parse(fs.readFileSync(path.join(root, "evidence", "notable-people.json"), "utf8"));
  assert.deepEqual(validateNotableFile(file), []);
  const viewer = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const category of notableCategories) {
    assert.match(viewer, new RegExp(`${category.id}: \\{ label: "${category.label}"`), `the viewer names ${category.id}`);
  }
});

test("a sum of money carries a rough equivalent in 2024 money", () => {
  const prices = { baseYear: 2024, gbp: { 1900: 2, 2024: 200 }, usd: { 1860: 10, 2024: 300 } };
  assert.deepEqual(moneyToday({ amount: 8844, currency: "GBP", year: 1900 }, prices), { value: 884400, baseYear: 2024, text: "about £880,000 today" });
  assert.equal(moneyToday({ amount: 6000, currency: "USD", year: 1860 }, prices).text, "about $180,000 today");
  assert.equal(moneyToday({ amount: 5, currency: "GBP", year: 1500 }, prices), null, "a year outside the series");
  assert.equal(moneyToday({ amount: 5, currency: "EUR", year: 1900 }, prices), null);
  assert.equal(formatApproxMoney(1234567, "GBP"), "£1.2 million");
  assert.equal(formatApproxMoney(15400000, "USD"), "$15 million");
  assert.equal(formatApproxMoney(29221, "GBP"), "£29,000");
  assert.equal(formatApproxMoney(950, "GBP"), "£950");

  // The real table: the Bank of England and ONS series meet at 2015 = 100.
  assert.equal(moneyToday({ amount: 100, currency: "GBP", year: 2024 }).text, "about £100 today");
  assert.equal(moneyToday({ amount: 8844, currency: "GBP", year: 1933 }).text, "about £580,000 today");

  const file = (money) => ({ schemaVersion: 1, people: [entry("sir-roger", "wealth", ["roger-knight"], { money })], declined: [] });
  assert.deepEqual(validateNotableFile(file({ amount: 8844, currency: "GBP", year: 1933 })), []);
  const issues = [
    ...validateNotableFile(file({ amount: -1, currency: "GBP", year: 1933 })),
    ...validateNotableFile(file({ amount: 5, currency: "PA", year: 1777 })),
    ...validateNotableFile(file({ amount: 5, currency: "USD", year: 1700 })),
    ...validateNotableFile(file({ amount: 5, currency: "GBP", year: 1933, note: "x" }))
  ];
  for (const expected of [/money.amount must be a positive number/, /money.currency must be GBP or USD/,
    /money.year 1700 has no USD price index/, /money takes only amount, currency and year/]) {
    assert.ok(issues.some((issue) => expected.test(issue)), `expected ${expected} in ${issues.join(" | ")}`);
  }
  const shown = projectNotablePeople(file({ amount: 8844, currency: "GBP", year: 1933 }), store).byPerson.get("sir-roger");
  assert.equal(shown.today, "about £580,000 today");
});

test("crime and the underworld are signs of a remarkable life, in English and Italian", () => {
  const signs = (value) => detectNotableSigns({ people: [{ personId: "p", assertions: [assertion("a", "established", { kind: "life-fact", category: "other", value })] }] }).get("p")?.[0].categories || [];
  for (const value of ["Named as a Black Hand extortionist", "Arrested for bootlegging", "Convicted of manslaughter", "Described as a mafioso",
    "Condannato dalla corte", "Charged with assault", "Deported to Italy"]) {
    assert.ok(signs(value).includes("story"), value);
  }
  assert.deepEqual(signs("Married in the ninth indiction"), [], "a church-register indiction is not an indictment");
});

test("a life of ninety years or more is a sign, from established birth and death years", () => {
  const bundle = (id, birth, death, assessment = "established") => ({ personId: id, assertions: [
    assertion(`${id}-b`, "established", { kind: "event", eventType: "birth", dateText: birth }),
    assertion(`${id}-d`, assessment, { kind: "event", eventType: "death", dateText: death })
  ] });
  const signs = detectNotableSigns({ people: [bundle("old", "about 1646", "23 Sep 1744"), bundle("young", "1900", "1980"), bundle("doubtful", "1700", "1800", "candidate")] });
  assert.deepEqual(signs.get("old").map((sign) => [sign.assertionId, sign.categories]), [["old-d", ["story"]]]);
  assert.match(signs.get("old")[0].text, /^Lived to about 98/);
  assert.equal(signs.has("young"), false);
  assert.equal(signs.has("doubtful"), false, "a candidate death is no sign");
});
