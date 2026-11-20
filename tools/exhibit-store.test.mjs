import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { exhibitKinds, projectExhibits, validateExhibits } from "./exhibit-store.mjs";
import { renderShield, validateShield } from "./heraldry-shield.mjs";
import { lifeFactCategories, validateLifeFact } from "./biography-schema.mjs";
import { timelineFactEntries } from "./research-projections.mjs";

const knightley = { quarterly: [
  { field: { fur: "ermine" } }, { field: { paly: 6, tinctures: ["or", "gules"] } },
  { field: { paly: 6, tinctures: ["or", "gules"] } }, { field: { fur: "ermine" } }
] };
const moreton = { field: { tincture: "argent" }, ordinary: { type: "chevron", tincture: "gules" },
  charges: [{ type: "buckle", tincture: "sable", count: 3, arrangement: "two-and-one" }] };

function person(personId, { lifeStatus = "deceased", died, places = [], trades = [], scope } = {}) {
  const assertions = [
    { id: `${personId}-name`, assessment: "established", claim: { kind: "name", personId, value: personId } },
    { id: `${personId}-status`, assessment: "established", claim: { kind: "life-status", personId, value: lifeStatus } },
    ...(died ? [{ id: `${personId}-death`, assessment: "established",
      claim: { kind: "event", subjectType: "person", subjectId: personId, eventType: "death", dateText: died } }] : []),
    ...places.map((place, index) => ({ id: `${personId}-place-${index}`, assessment: place.assessment || "established",
      claim: { kind: "place-association", personId, value: place.name, placeRole: place.role } })),
    ...trades.map((value, index) => ({ id: `${personId}-trade-${index}`, assessment: "established",
      claim: { kind: "occupation", personId, value } }))
  ];
  return {
    personId, ...(scope ? { researchScope: scope } : {}),
    presentation: {
      displayNameAssertionId: `${personId}-name`,
      detailAssertionIds: assertions.filter((item) => item.claim.kind !== "place-association").map((item) => item.id),
      placeRows: places.map((place, index) => ({ assertionIds: [`${personId}-place-${index}`], name: place.name, country: place.country || "England" }))
    },
    assertions
  };
}

const record = (id, extra = {}) => ({
  id, sha256: "a".repeat(64), mediaType: "image/jpeg", rights: "family-viewer-approved", privacy: "private",
  viewer: { approved: true }, ...extra
});

const exhibit = (extra) => ({
  schemaVersion: 1, id: "grave-anne", kind: "grave", title: "Anne's gravestone",
  caption: "Her stone in the churchyard.", citation: "Photograph of the stone, St Peter, Ellastone.",
  credit: "Photo: A. Contributor", licence: "CC BY-SA 2.0", checkedAt: "2026-11-17",
  recordIds: ["photo-1"], image: { recordId: "photo-1" },
  appliesTo: { people: [{ personId: "anne" }] }, ...extra
});

const context = (people, records = [record("photo-1")]) => ({
  store: { people }, records, generations: new Map(people.map((bundle) => [bundle.personId, 6])), asOfYear: 2026
});

test("a complete exhibit is valid and reaches the person it names", () => {
  const people = [person("anne"), person("john")];
  assert.deepEqual(validateExhibits([exhibit()], context(people)), []);
  const projected = projectExhibits([exhibit()], context(people));
  assert.deepEqual(projected.byPerson.get("anne"), [{ id: "grave-anne" }]);
  assert.equal(projected.byPerson.has("john"), false);
  assert.deepEqual(Object.keys(projected.exhibits[0]).sort(),
    ["caption", "checkedAt", "citation", "credit", "id", "image", "kind", "licence", "recordIds", "title"]);
});

test("every exhibit needs its archived record, credit, licence and check date", () => {
  const issues = validateExhibits([exhibit({ recordIds: [], credit: "", licence: " ", checkedAt: "today", image: undefined })],
    context([person("anne")]));
  for (const pattern of [/requires the archived record/, /requires credit/, /requires licence/, /requires checkedAt/, /needs an image, a drawing or text/]) {
    assert.ok(issues.some((issue) => pattern.test(issue)), `expected ${pattern} in ${issues.join(" | ")}`);
  }
});

test("an image must come from an image master the family viewer may show", () => {
  const people = [person("anne")];
  const withheld = validateExhibits([exhibit()], context(people, [record("photo-1", { viewer: { approved: false } })]));
  assert.ok(withheld.some((issue) => /not approved for the family viewer/.test(issue)));
  const pdf = validateExhibits([exhibit()], context(people, [record("photo-1", { mediaType: "application/pdf" })]));
  assert.ok(pdf.some((issue) => /must be an image master/.test(issue)));
  const unlisted = validateExhibits([exhibit({ image: { recordId: "elsewhere" } })], context(people));
  assert.ok(unlisted.some((issue) => /image record must be listed in recordIds/.test(issue)));
  const crop = validateExhibits([exhibit({ image: { recordId: "photo-1", crop: { x: 0.6, y: 0.1, width: 0.5, height: 0.2 } } })], context(people));
  assert.ok(crop.some((issue) => /crop must be fractions of the image, inside it/.test(issue)));
  assert.deepEqual(validateExhibits([exhibit({ image: { recordId: "photo-1", crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 } } })], context(people)), []);
});

test("an image may ask for the larger layout, and unknown image fields are refused", () => {
  const people = [person("anne")];
  const large = exhibit({ image: { recordId: "photo-1", large: true } });
  assert.deepEqual(validateExhibits([large], context(people)), []);
  assert.equal(projectExhibits([large], context(people)).exhibits[0].image.large, true);
  assert.equal(Object.hasOwn(projectExhibits([exhibit()], context(people)).exhibits[0].image, "large"), false);
  assert.deepEqual(validateExhibits([exhibit({ image: { recordId: "photo-1", large: "yes", width: 400 } })], context(people)),
    ["exhibit grave-anne: image large must be true or false", "exhibit grave-anne: unknown image field width"]);
});

test("an unpublished record is kept as the basis but not handed to the viewer", () => {
  const people = [person("anne")];
  const records = [record("photo-1"), record("page-1", { viewer: { approved: false } })];
  const projected = projectExhibits([exhibit({ recordIds: ["photo-1", "page-1"] })], context(people, records));
  assert.deepEqual(projected.exhibits[0].recordIds, ["photo-1"]);
});

test("a living person's portrait requires approval for their own confirmed image", () => {
  const ctx = context([person("anne", { lifeStatus: "living" }), person("bert", { lifeStatus: "living" })]);
  ctx.store.sources = [{ id: "photo-1", personLinks: [{ personId: "anne", identificationStatus: "confirmed" }] }];
  const portrait = exhibit({
    id: "portrait-anne", kind: "portrait", title: "Portrait of Anne"
  });
  assert.match(validateExhibits([portrait], ctx).join("\n"), /anne may be living/);
  assert.equal(projectExhibits([portrait], ctx).byPerson.size, 0);

  portrait.appliesTo.people[0].livingPhotoApprovedAt = "2026-11-20";
  assert.deepEqual(validateExhibits([portrait], ctx), []);
  assert.deepEqual([...projectExhibits([portrait], ctx).byPerson], [["anne", [{ id: "portrait-anne" }]]]);

  portrait.appliesTo.people[0].personId = "bert";
  assert.match(validateExhibits([portrait], ctx).join("\n"), /requires a confirmed source link to bert/);
  assert.equal(projectExhibits([portrait], ctx).byPerson.size, 0);
});

test("arms are linked to named people only and carry their own note", () => {
  const people = [person("william"), person("robert"), person("stranger", { places: [{ name: "Fawsley", role: "residence" }] })];
  const arms = exhibit({
    id: "arms-knightley", kind: "arms", title: "Arms of Knightley", image: undefined,
    recordIds: ["photo-1"],
    drawing: { shield: knightley, basis: "Drawn from the blazon printed on p. 89." },
    appliesTo: { people: [
      { personId: "william", note: "As a second son he bore them with a crescent sable for difference." },
      { personId: "robert" }
    ] }
  });
  assert.deepEqual(validateExhibits([arms], context(people)), []);
  const projected = projectExhibits([arms], context(people));
  assert.equal(projected.byPerson.get("william")[0].note, "As a second son he bore them with a crescent sable for difference.");
  assert.deepEqual(projected.byPerson.get("robert"), [{ id: "arms-knightley" }]);
  assert.match(projected.exhibits[0].drawing.svg, /^<svg /);
  assert.equal(projected.exhibits[0].drawing.basis, "Drawn from the blazon printed on p. 89.");

  const bySurname = validateExhibits([{ ...arms, appliesTo: { places: [{ name: "Fawsley", country: "England" }] } }], context(people));
  assert.ok(bySurname.some((issue) => /arms is linked to named people only/.test(issue)));
  const undrawn = validateExhibits([{ ...arms, drawing: { shield: knightley } }], context(people));
  assert.ok(undrawn.some((issue) => /must say what it is drawn from/.test(issue)));
  const drawnGrave = validateExhibits([exhibit({ drawing: { shield: knightley, basis: "x" } })], context([person("anne")]));
  assert.ok(drawnGrave.some((issue) => /only arms are drawn/.test(issue)));
});

test("a place profile reaches everyone with a real role there, not the merely associated", () => {
  const people = [
    person("baptized", { places: [{ name: "Ellastone", role: "baptism-place" }] }),
    person("lived", { places: [{ name: "Ellastone", role: "residence" }] }),
    person("associated", { places: [{ name: "Ellastone", role: "associated" }] }),
    person("elsewhere", { places: [{ name: "Ellastone", role: "residence", country: "United States" }] }),
    person("rejected", { places: [{ name: "Ellastone", role: "residence", assessment: "rejected" }] })
  ];
  const profile = exhibit({ id: "place-ellastone", kind: "place", title: "St Peter, Ellastone",
    appliesTo: { places: [{ name: "Ellastone", country: "England" }] } });
  assert.deepEqual(validateExhibits([profile], context(people)), []);
  assert.deepEqual([...projectExhibits([profile], context(people)).byPerson.keys()].sort(), ["baptized", "lived"]);
  const font = { ...profile, appliesTo: { places: [{ name: "Ellastone", country: "England", roles: ["baptism-place"] }] } };
  assert.deepEqual([...projectExhibits([font], context(people)).byPerson.keys()], ["baptized"]);
  const badRole = validateExhibits([{ ...profile, appliesTo: { places: [{ name: "Ellastone", country: "England", roles: ["visited"] }] } }], context(people));
  assert.ok(badRole.some((issue) => /unknown place role visited/.test(issue)));
});

test("a place profile also reaches people through their own dated facts at the place", () => {
  const withFacts = (personId, facts) => {
    const bundle = person(personId);
    for (const [index, fact] of facts.entries()) {
      bundle.assertions.push({ id: `${personId}-fact-${index}`, assessment: fact.assessment || "established", claim: fact.claim });
    }
    return bundle;
  };
  const lived = (place, extra = {}) => ({ claim: { kind: "life-fact", personId: "x", category: "residence", value: "Lived there", place, ...extra } });
  const event = (eventType, place) => ({ claim: { kind: "event", subjectType: "person", subjectId: "x", eventType, dateText: "1821", place } });
  const people = [
    withFacts("resident", [lived("Lane Farm, Wootton, Staffordshire", { country: "England" })]),
    withFacts("baptized", [event("baptism", "Wootton, Staffordshire")]),
    withFacts("commemorated", [{ claim: { kind: "life-fact", personId: "x", category: "other", value: "Is commemorated on a monument", place: "Wootton, Staffordshire", country: "England" } }]),
    withFacts("other-wootton", [lived("Wootton, Bedfordshire", { country: "England" })]),
    withFacts("bare-town", [event("burial", "Wootton")]),
    withFacts("candidate", [{ ...lived("Wootton, Staffordshire", { country: "England" }), assessment: "candidate" }]),
    withFacts("ohio", [lived("Wootton, Ohio")]),
    person("spouse-a"), person("spouse-b"), person("associated", { places: [{ name: "Wootton", role: "associated" }] })
  ];
  const store = { ...context(people).store, unions: [{ unionId: "u", personIds: ["spouse-a", "spouse-b"],
    assertions: [{ id: "u-marriage", assessment: "established", claim: { kind: "event", subjectType: "union", subjectId: "u", eventType: "marriage", dateText: "1848", place: "Wootton, Staffordshire" } }] }] };
  const reachOf = (rule) => [...projectExhibits([exhibit({ id: "place-wootton", kind: "place", title: "Wootton", appliesTo: { places: [rule] } })],
    { ...context(people), store }).byPerson.keys()].sort();

  // By name and country alone the two Woottons cannot be told apart; "within" settles it.
  assert.deepEqual(reachOf({ name: "Wootton", country: "England" }), ["baptized", "commemorated", "other-wootton", "resident", "spouse-a", "spouse-b"]);
  assert.deepEqual(reachOf({ name: "Wootton", country: "England", within: "Staffordshire" }), ["baptized", "commemorated", "resident", "spouse-a", "spouse-b"]);
  assert.deepEqual(reachOf({ name: "Wootton", country: "England", within: "Staffordshire", roles: ["residence"] }), ["resident"]);
  assert.deepEqual(reachOf({ name: "Wootton", country: "England", within: "Staffordshire", roles: ["marriage-place", "baptism-place"] }), ["baptized", "spouse-a", "spouse-b"]);
  assert.deepEqual(reachOf({ name: "Wootton", country: "United States", state: "Ohio" }), ["ohio"]);
  assert.deepEqual(reachOf({ name: "Staffordshire", country: "England" }).length, 5, "a county named in the facts can carry an exhibit too");
  const bad = validateExhibits([exhibit({ id: "place-wootton", kind: "place", title: "Wootton", appliesTo: { places: [{ name: "Wootton", country: "England", within: "" }] } })], context(people));
  assert.ok(bad.some((issue) => /within must name a county or district/.test(issue)));
});

test("a trade note reaches everyone with that trade", () => {
  const people = [person("flatman", { trades: ["Flatman"] }), person("farmer", { trades: ["Farmer"] })];
  const note = exhibit({ id: "trade-flatman", kind: "trade", title: "Flatman", image: undefined,
    text: "A flatman worked a flat, the shallow barge of the Weaver navigation.",
    appliesTo: { occupations: ["flatman"] } });
  assert.deepEqual(validateExhibits([note], context(people)), []);
  assert.deepEqual([...projectExhibits([note], context(people)).byPerson.keys()], ["flatman"]);
});

test("living people are left alone; the recently dead are treated like everyone else", () => {
  // The grave-or-obituary-only rule for the recently dead was removed at the user's request on 18 Nov 2026.
  const people = [
    person("alive", { lifeStatus: "living", places: [{ name: "Ellastone", role: "residence" }] }),
    person("recent", { died: "4 July 1984", places: [{ name: "Ellastone", role: "residence" }] })
  ];
  const named = validateExhibits([exhibit({ appliesTo: { people: [{ personId: "alive" }] } })], context(people));
  assert.ok(named.some((issue) => /alive may be living/.test(issue)));
  assert.deepEqual(validateExhibits([exhibit({ kind: "monument", appliesTo: { people: [{ personId: "recent" }] } })], context(people)), []);
  assert.deepEqual(validateExhibits([exhibit({ appliesTo: { people: [{ personId: "recent" }] } })], context(people)), []);
  const profile = exhibit({ id: "place-ellastone", kind: "place", appliesTo: { places: [{ name: "Ellastone", country: "England" }] } });
  assert.deepEqual([...projectExhibits([profile], context(people)).byPerson.keys()], ["recent"], "a place profile skips only the living");
});

test("references are checked against the canonical stores", () => {
  const people = [person("anne"), person("cousin", { scope: "collateral" })];
  const issues = validateExhibits([
    exhibit({ id: "Bad Id", kind: "crest", recordIds: ["missing"], image: undefined, text: "x", extra: true,
      sourceUrl: "http://example.org", appliesTo: { people: [{ personId: "nobody" }, { personId: "cousin" }], surnames: ["Heath"] } }),
    exhibit(), exhibit(),
    exhibit({ id: "empty", appliesTo: {} })
  ], context(people));
  for (const pattern of [/invalid id/, /invalid kind crest/, /no such manifest record missing/, /unknown field extra/,
    /sourceUrl must be an https URL/, /unknown person nobody/, /cousin is outside the main scope/, /unknown appliesTo rule surnames/,
    /grave-anne: duplicate id/, /empty: applies to nobody/]) {
    assert.ok(issues.some((issue) => pattern.test(issue)), `expected ${pattern} in ${issues.join(" | ")}`);
  }
});

test("exhibits are shown in a fixed order of kinds", () => {
  const people = [person("anne")];
  const grave = exhibit();
  const arms = exhibit({ id: "arms-z", kind: "arms", image: undefined, drawing: { shield: moreton, basis: "Drawn from p. 97." } });
  const projected = projectExhibits([grave, arms], context(people));
  assert.deepEqual(projected.byPerson.get("anne").map((entry) => entry.id), ["arms-z", "grave-anne"]);
  assert.ok(exhibitKinds.indexOf("arms") < exhibitKinds.indexOf("grave"));
});

test("the shield renderer draws what a blazon states and refuses what it cannot draw", () => {
  const svg = renderShield({ ...knightley, difference: { type: "crescent", tincture: "sable" } }, { title: "Knightley <of> Calais" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 400 490" role="img"><title>Knightley &lt;of&gt; Calais<\/title>/);
  assert.equal((svg.match(/#efc12f/g) || []).length, 6, "two paly quarters of three gold pales each");
  assert.doesNotMatch(svg, /<script|\son[a-z]+=|href=/);
  assert.match(renderShield({ impaled: [moreton, knightley] }), /clip-path="url\(#ci0\)"/);
  assert.match(renderShield({ field: { tincture: "argent" }, ordinary: { type: "bend", tincture: "azure" },
    charges: [{ type: "mascle", tincture: "argent", count: 3, arrangement: "on-ordinary" }] }), /rotate\(-40\)/);

  assert.deepEqual(validateShield(moreton), []);
  assert.deepEqual(validateShield({ field: { tincture: "argent" }, charges: [{ type: "griffin", tincture: "gules", count: 1, arrangement: "centre" }] }),
    ["shield: cannot draw charge griffin"]);
  assert.deepEqual(validateShield({ field: { tincture: "tenne" } }), ["shield: unknown tincture tenne in field"]);
  assert.deepEqual(validateShield({ quarterly: [moreton] }), ["shield: quarterly takes four coats"]);
  assert.deepEqual(validateShield({ field: { fur: "vair" } }), ["shield: only ermine can be drawn as a fur"]);
  assert.deepEqual(validateShield({ field: { tincture: "or" }, charges: [{ type: "mullet", tincture: "sable", count: 3, arrangement: "on-ordinary" }] }),
    ["shield: charges on an ordinary need the ordinary"]);
  assert.deepEqual(validateShield({ field: { tincture: "or" }, crest: "a buck's head" }), ["shield: unknown key crest"]);
  assert.throws(() => renderShield({ field: {} }), /field needs a tincture/);
});

test("the renderer draws rows of charges, a label, a chief, a canton, a bendlet and a cross patonce", () => {
  const stAndrew = { field: { tincture: "gules" }, charges: [{ type: "mascle", tincture: "or", count: 7, arrangement: "three-three-one" }], label: { tincture: "argent" } };
  const zouch = { field: { tincture: "azure" }, charges: [{ type: "roundel", tincture: "or", count: 10, arrangement: "four-three-two-one" }] };
  assert.deepEqual(validateShield({ impaled: [stAndrew, zouch] }), []);
  const svg = renderShield({ impaled: [stAndrew, zouch] });
  assert.equal((svg.match(/<circle /g) || []).length, 10, "ten roundles");
  assert.equal((svg.match(/fill-rule="evenodd" fill="#efc12f"/g) || []).length, 7, "seven gold mascles");
  assert.match(svg, /scale\(1,0\.5\)/, "an impaled half keeps its charges round");
  assert.deepEqual(validateShield({ ...stAndrew, charges: [{ ...stAndrew.charges[0], count: 6 }] }), ["shield: three-three-one takes 7 charges"]);
  const fitzherbert = { field: { tincture: "argent" }, chief: { vair: ["or", "gules"] }, overall: { type: "bendlet", tincture: "sable" } };
  const aston = { field: { tincture: "argent" }, ordinary: { type: "fess", tincture: "sable" },
    charges: [{ type: "lozenge", tincture: "sable", count: 3, arrangement: "in-chief" }, { type: "mullet", tincture: "argent", count: 1, arrangement: "on-ordinary" }] };
  const marshall = { field: { tincture: "argent" }, ordinary: { type: "two-bars", tincture: "sable" }, canton: { fur: "ermine" } };
  const dickens = { field: { fur: "ermine" }, ordinary: { type: "cross-patonce", tincture: "sable" } };
  for (const coat of [fitzherbert, aston, marshall, dickens]) assert.deepEqual(validateShield(coat), []);
  assert.match(renderShield(fitzherbert), /#c4122f/, "the vair chief carries red bells");
  assert.deepEqual(validateShield({ field: { tincture: "argent" }, chief: { vair: ["or"] } }), ["shield: a vair chief takes two tinctures"]);
  assert.deepEqual(validateShield({ field: { tincture: "argent" }, overall: { type: "baton", tincture: "sable" } }), ["shield: cannot draw baton over all"]);
});

test("heraldry is a life-fact category tied to a named person, never a surname", () => {
  assert.ok(lifeFactCategories.has("heraldry"));
  const fact = (value) => ({ id: "a", claim: { kind: "life-fact", personId: "william", category: "heraldry", value } });
  assert.deepEqual(validateLifeFact(fact("Bore the arms of Knightley with a crescent sable for difference")), []);
  assert.deepEqual(validateLifeFact(fact("The Knightley family crest")),
    ["a heraldry belongs to the person or line a source names, not to a family name"]);
});

test("an exhibit may not rest on a record that is only a candidate match for the person", () => {
  const people = [person("anne")];
  const source = (status) => ({ id: "photo-1", personLinks: [{ personId: "anne", identificationStatus: status }] });
  const candidate = { ...context(people), store: { people, sources: [source("candidate")] } };
  assert.deepEqual(validateExhibits([exhibit()], candidate),
    ["exhibit grave-anne: record photo-1 is only a candidate match for anne; the identification must be confirmed first"]);
  const confirmed = { ...context(people), store: { people, sources: [source("confirmed")] } };
  assert.deepEqual(validateExhibits([exhibit()], confirmed), []);
  const unlinked = { ...context(people), store: { people, sources: [{ id: "photo-1", personLinks: [] }] } };
  assert.deepEqual(validateExhibits([exhibit()], unlinked), [], "a record that names nobody, such as a family monument, may still be shown");
});

test("a life fact listed only among the details still reaches the timeline", () => {
  const local = new Map([
    ["a-migration", { id: "a-migration", claim: { kind: "life-fact" } }],
    ["a-will", { id: "a-will", claim: { kind: "life-fact" } }],
    ["a-name", { id: "a-name", claim: { kind: "name" } }],
    ["a-birth", { id: "a-birth", claim: { kind: "event" } }]
  ]);
  const entries = timelineFactEntries({
    detailAssertionIds: ["a-name", "a-birth", "a-migration", "a-will", "a-missing"],
    biographyFacts: [{ assertionId: "a-will", prominence: "core" }]
  }, local);
  assert.deepEqual(entries, [
    { assertionId: "a-will", prominence: "core" },
    { assertionId: "a-migration", prominence: "supporting" }
  ], "explicit entries keep their prominence and are not repeated; names and events are not timeline facts");
  assert.deepEqual(timelineFactEntries({}, local), []);
});

test("a context paragraph needs no caption, but every other exhibit does", () => {
  const people = [person("anne")];
  const paragraph = exhibit({ id: "world-0123456789abcdef", kind: "context", caption: undefined, image: undefined, text: "Ellastone was a village of farms." });
  assert.deepEqual(validateExhibits([paragraph], context(people)), []);
  assert.equal("caption" in projectExhibits([paragraph], context(people)).exhibits[0], false);
  assert.match(validateExhibits([exhibit({ caption: undefined })], context(people)).join(), /requires caption/);
  assert.match(validateExhibits([exhibit({ kind: "context", caption: undefined, image: undefined })], context(people)).join(), /requires caption/);
});
