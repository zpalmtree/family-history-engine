import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  coupleUnitPartners,
  DEFAULT_FAMILY_CORE,
  DEFAULT_PEDIGREE_LAYOUT,
  isAxisAlignedSegment,
  layoutPedigree,
  requiredCardGap,
  validatePedigreeLayout
} from "./pedigree-layout.mjs";

const CARD = Object.freeze({ nodeWidth: 80, nodeHeight: 40 });

function people(...ids) {
  return ids.map((id) => ({ id, name: id }));
}

function parent(from, to, status = "confirmed") {
  return { from, to, status };
}

function couple(from, to, status = "confirmed") {
  return { from, to, status };
}

function node(layout, personId) {
  const matches = layout.nodes.filter((item) => item.personId === personId);
  assert.equal(matches.length, 1, `expected one visual occurrence of ${personId}`);
  return matches[0];
}

function centerX(layout, item) {
  return item.x + layout.config.nodeWidth / 2;
}

function assertOrthogonal(layout) {
  for (const connector of layout.connectors) {
    for (const segment of connector.segments) {
      assert.equal(
        isAxisAlignedSegment(segment),
        true,
        `${connector.id} must be axis aligned`
      );
    }
  }
}

test("two-parent families have fixed generation rows and an exact vertical trunk", () => {
  const layout = layoutPedigree({
    people: people("child", "father", "mother", "gf1", "gm1", "gf2", "gm2"),
    links: [
      parent("father", "child"),
      parent("mother", "child"),
      parent("gf1", "father"),
      parent("gm1", "father"),
      parent("gf2", "mother"),
      parent("gm2", "mother")
    ],
    coupleLinks: [
      couple("father", "mother"),
      couple("gf1", "gm1"),
      couple("gf2", "gm2")
    ],
    ...CARD
  });

  const child = node(layout, "child");
  const father = node(layout, "father");
  const mother = node(layout, "mother");
  // Spouses are one unit: side by side, and the child's trunk drops from the
  // middle of the gap between them.
  assert.equal(mother.x - (father.x + CARD.nodeWidth), DEFAULT_PEDIGREE_LAYOUT.coupleGap);
  assert.equal(centerX(layout, child), (centerX(layout, father) + centerX(layout, mother)) / 2);
  assert.equal(father.y, mother.y);
  assert.equal(child.y - father.y, CARD.nodeHeight + DEFAULT_PEDIGREE_LAYOUT.generationGap);
  for (const [a, b] of [["gf1", "gm1"], ["gf2", "gm2"]]) {
    assert.equal(node(layout, b).x - (node(layout, a).x + CARD.nodeWidth), DEFAULT_PEDIGREE_LAYOUT.coupleGap);
  }

  const family = layout.familyConnectors.find((item) => item.childPersonId === "child");
  assert.ok(family);
  assert.equal(family.style, "couple-unit");
  assert.equal(family.segments.length, 4);
  assert.deepEqual(family.parentStatuses, ["confirmed", "confirmed"]);
  const [fatherArm, motherArm, drop] = family.segments;
  assert.equal(fatherArm.x1, father.x + CARD.nodeWidth);
  assert.equal(motherArm.x1, mother.x);
  assert.equal(fatherArm.y1, father.y + CARD.nodeHeight / 2);
  assert.equal(drop.x1, family.junction.x);
  const trunk = family.segments.at(-1);
  assert.equal(trunk.x1, centerX(layout, child));
  assert.equal(trunk.x2, centerX(layout, child));
  assert.deepEqual(validatePedigreeLayout(layout), []);
  assertOrthogonal(layout);
});

test("parent connector arms retain independent evidence statuses", () => {
  const layout = layoutPedigree({
    people: people("child", "father", "mother"),
    links: [
      parent("father", "child", "confirmed"),
      parent("mother", "child", "unresolved")
    ],
    coupleLinks: [couple("father", "mother")],
    ...CARD
  });

  const family = layout.familyConnectors.find((item) => item.childPersonId === "child");
  assert.deepEqual(family.parentPersonIds, ["father", "mother"]);
  assert.deepEqual(family.parentStatuses, ["confirmed", "unresolved"]);
  assert.equal(family.status, "unresolved");
});

test("asymmetric ancestry cannot split a couple apart", () => {
  const layout = layoutPedigree({
    people: people("child", "left", "right", "l1", "l2", "l3", "l4", "l5"),
    links: [
      parent("left", "child"),
      parent("right", "child"),
      parent("l1", "left"),
      parent("l2", "left"),
      parent("l3", "l1"),
      parent("l4", "l1"),
      parent("l5", "l3")
    ],
    coupleLinks: [couple("left", "right"), couple("l1", "l2"), couple("l3", "l4")],
    ...CARD
  });

  const left = node(layout, "left");
  const right = node(layout, "right");
  const l1 = node(layout, "l1");
  const l2 = node(layout, "l2");
  assert.equal(right.x - (left.x + CARD.nodeWidth), DEFAULT_PEDIGREE_LAYOUT.coupleGap);
  assert.equal(l2.x - (l1.x + CARD.nodeWidth), DEFAULT_PEDIGREE_LAYOUT.coupleGap);
  const family = layout.familyConnectors.find((item) => item.childPersonId === "left");
  assert.equal(family.segments.at(-1).x1, centerX(layout, left));
  assert.deepEqual(validatePedigreeLayout(layout), []);
  assertOrthogonal(layout);
});

test("a one-parent branch is vertically aligned and remains valid when a view is truncated", () => {
  const allPeople = people("child", "known-parent", "hidden-parent", "grandparent");
  const allLinks = [
    parent("known-parent", "child"),
    parent("hidden-parent", "child"),
    parent("grandparent", "known-parent")
  ];
  const layout = layoutPedigree({
    people: allPeople,
    links: allLinks,
    visibleIds: ["child", "known-parent", "grandparent"],
    coupleLinks: [couple("known-parent", "hidden-parent")],
    ...CARD
  });

  const child = node(layout, "child");
  const knownParent = node(layout, "known-parent");
  assert.equal(centerX(layout, child), centerX(layout, knownParent));
  const family = layout.familyConnectors.find((item) => item.childPersonId === "child");
  assert.equal(family.parentInstanceIds.length, 1);
  assert.deepEqual(family.parentStatuses, ["confirmed"]);
  const barY = knownParent.y + CARD.nodeHeight + DEFAULT_PEDIGREE_LAYOUT.familyBarOffset;
  assert.deepEqual(family.segments, [{
    x1: centerX(layout, child),
    y1: knownParent.y + CARD.nodeHeight,
    x2: centerX(layout, child),
    y2: barY
  }, {
    x1: centerX(layout, child),
    y1: barY,
    x2: centerX(layout, child),
    y2: child.y
  }]);
  assert.deepEqual(validatePedigreeLayout(layout), []);
});

test("pedigree collapse creates stable path-derived occurrences", () => {
  const input = {
    people: people("child", "father", "mother", "shared"),
    links: [
      parent("father", "child"),
      parent("mother", "child"),
      parent("shared", "father"),
      parent("shared", "mother")
    ],
    coupleLinks: [couple("father", "mother")],
    ...CARD
  };
  const layout = layoutPedigree(input);
  const occurrences = layout.nodes.filter((item) => item.personId === "shared");

  assert.equal(occurrences.length, 2);
  assert.deepEqual(
    occurrences.map((item) => item.instanceId).sort(),
    ["occ:child/father/shared", "occ:child/mother/shared"]
  );
  assert.notEqual(occurrences[0].x, occurrences[1].x);
  assert.deepEqual(validatePedigreeLayout(layout), []);

  const second = layoutPedigree({
    ...input,
    people: [...input.people].reverse(),
    links: [...input.links].reverse(),
    coupleLinks: [...input.coupleLinks].reverse()
  });
  assert.deepEqual(second, layout, "semantic array order must not perturb generated geometry");
});

test("a couple reached by two neighbouring lines is two units a node gap apart", () => {
  // Both parents of the child descend from the same couple, and nothing
  // stands between the two occurrences in the grandparent row.
  const layout = layoutPedigree({
    people: people("child", "father", "mother", "thomas", "sarah"),
    links: [
      parent("father", "child"),
      parent("mother", "child"),
      parent("thomas", "father"),
      parent("sarah", "father"),
      parent("thomas", "mother"),
      parent("sarah", "mother")
    ],
    coupleLinks: [couple("father", "mother"), couple("thomas", "sarah")],
    nodeGap: 16,
    coupleGap: 24,
    ...CARD
  });
  const row = layout.nodes
    .filter((item) => item.generation === 2)
    .sort((first, second) => first.x - second.x);
  assert.deepEqual(row.map((item) => item.instanceId), [
    "occ:child/father/thomas",
    "occ:child/father/sarah",
    "occ:child/mother/thomas",
    "occ:child/mother/sarah"
  ]);
  const gaps = row.slice(1).map((item, index) => item.x - (row[index].x + CARD.nodeWidth));
  assert.deepEqual(gaps, [24, 16, 24]);

  const unitPartners = coupleUnitPartners(layout.connectors);
  assert.deepEqual([...unitPartners.get("occ:child/father/sarah")], ["occ:child/father/thomas"]);
  const settings = { isCouple: true, unitPartners, nodeGap: 16, coupleGap: 24 };
  assert.deepEqual(
    row.slice(1).map((item, index) => requiredCardGap(row[index], item, settings)),
    [24, 16, 24],
    "the two inner cards are the same couple by name but belong to different units"
  );

  // Everything else keeps the stricter rule: a couple without connector data,
  // a couple whose cards are not both joined elsewhere, and unrelated cards.
  assert.equal(requiredCardGap(row[1], row[2], { ...settings, unitPartners: null }), 24);
  assert.equal(requiredCardGap(row[1], row[2], { ...settings, unitPartners: new Map() }), 24);
  assert.equal(
    requiredCardGap(row[1], row[2], {
      ...settings,
      unitPartners: new Map([[row[1].instanceId, unitPartners.get(row[1].instanceId)]])
    }),
    24
  );
  assert.equal(requiredCardGap(row[1], row[2], { ...settings, isCouple: false }), 16);
});

test("couple units are read from family and root couple connectors", () => {
  const spouses = layoutPedigree({
    people: people("root-a", "root-b"),
    links: [],
    coupleLinks: [couple("root-a", "root-b")],
    ...CARD
  });
  const partners = coupleUnitPartners(spouses.connectors);
  assert.deepEqual([...partners.get("occ:root-a")], ["occ:root-b"]);
  assert.deepEqual([...partners.get("occ:root-b")], ["occ:root-a"]);
  assert.equal(coupleUnitPartners(undefined).size, 0);
  assert.equal(coupleUnitPartners([{ kind: "family", parentInstanceIds: ["occ:a/only"] }]).size, 0);
});

test("layoutFlipCouples reverses the configured left/right ordering", () => {
  const input = {
    people: people("child", "alpha", "omega"),
    links: [parent("alpha", "child"), parent("omega", "child")],
    coupleLinks: [couple("alpha", "omega")],
    ...CARD
  };
  const normal = layoutPedigree(input);
  const flipped = layoutPedigree({
    ...input,
    view: { layoutFlipCouples: [["omega", "alpha"]] }
  });

  assert.ok(node(normal, "alpha").x < node(normal, "omega").x);
  assert.ok(node(flipped, "omega").x < node(flipped, "alpha").x);
  const flippedChild = node(flipped, "child");
  assert.equal(
    centerX(flipped, flippedChild),
    (centerX(flipped, node(flipped, "alpha")) + centerX(flipped, node(flipped, "omega"))) / 2
  );
});

test("virtual-root components are separated while root spouses get a horizontal couple link", () => {
  const components = layoutPedigree({
    people: people("alpha", "omega"),
    links: [],
    coupleLinks: [],
    marginX: 0,
    marginY: 0,
    ...CARD
  });
  const alpha = node(components, "alpha");
  const omega = node(components, "omega");
  assert.ok(omega.x - (alpha.x + CARD.nodeWidth) >= DEFAULT_PEDIGREE_LAYOUT.componentGap);

  const spouses = layoutPedigree({
    people: people("root-a", "root-b"),
    links: [],
    coupleLinks: [couple("root-a", "root-b", "candidate")],
    marginX: 0,
    marginY: 0,
    ...CARD
  });
  assert.equal(spouses.coupleConnectors.length, 1);
  assert.equal(spouses.coupleConnectors[0].status, "candidate");
  assert.equal(spouses.coupleConnectors[0].segments.length, 1);
  const segment = spouses.coupleConnectors[0].segments[0];
  assert.equal(segment.y1, segment.y2);
  assert.equal(Math.abs(segment.x2 - segment.x1), DEFAULT_PEDIGREE_LAYOUT.coupleGap);
  assertOrthogonal(spouses);
});

test("view nodes, axis labels, and geometry settings are accepted as configuration", () => {
  const layout = layoutPedigree({
    people: people("child", "parent", "excluded"),
    links: [parent("parent", "child"), parent("excluded", "child")],
    coupleLinks: [],
    view: {
      nodes: [{ id: "child" }, { id: "parent" }],
      axis: [{ label: "Earlier" }, { label: "Present" }],
      generationGap: 60
    },
    options: { nodeGap: 25 },
    ...CARD
  });

  assert.deepEqual(layout.nodes.map((item) => item.personId).sort(), ["child", "parent"]);
  assert.equal(layout.config.generationGap, 60);
  assert.equal(layout.config.nodeGap, 25);
  assert.deepEqual(layout.axis.map((item) => item.label), ["Earlier", "Present"]);
  assert.ok(layout.axis[0].y <= layout.axis[1].y);
});

test("invalid cycles and impossible geometry fail with actionable errors", () => {
  assert.throws(() => layoutPedigree({
    people: people("a", "b"),
    links: [parent("a", "b"), parent("b", "a")],
    coupleLinks: [],
    ...CARD
  }), /parent links contain a cycle/);

  assert.throws(() => layoutPedigree({
    people: people("child", "parent"),
    links: [parent("parent", "child")],
    coupleLinks: [],
    generationGap: 10,
    familyBarOffset: 18,
    ...CARD
  }), /familyBarOffset cannot exceed generationGap/);
});

// A whole pedigree: every person down to `depth` generations above the root
// has both parents. Ids spell the path: "r", "rf", "rm", "rff", ...
function wholePedigree(depth, { skip = () => false } = {}) {
  const ids = ["r"];
  const links = [];
  const coupleLinks = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id.length > depth || skip(id)) {
      continue;
    }
    ids.push(`${id}f`, `${id}m`);
    links.push(parent(`${id}f`, id), parent(`${id}m`, id));
    coupleLinks.push(couple(`${id}f`, `${id}m`));
  }
  return { people: people(...ids), links, coupleLinks };
}

function row(layout, generation) {
  return layout.nodes.filter((item) => item.generation === generation).sort((a, b) => a.x - b.x);
}

// Every place two different connectors cross, or run along each other.
function connectorClashes(layout) {
  const lines = layout.connectors.flatMap((connector) => connector.segments.map((segment) => ({
    id: connector.id,
    horizontal: segment.y1 === segment.y2,
    at: segment.y1 === segment.y2 ? segment.y1 : segment.x1,
    from: segment.y1 === segment.y2 ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2),
    to: segment.y1 === segment.y2 ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2)
  })));
  const clashes = [];
  for (const [index, first] of lines.entries()) {
    for (const second of lines.slice(index + 1)) {
      if (first.id === second.id) {
        continue;
      }
      const clash = first.horizontal === second.horizontal
        ? first.at === second.at && Math.min(first.to, second.to) - Math.max(first.from, second.from) > 1e-9
        : first.at > second.from + 1e-9 && first.at < second.to - 1e-9
          && second.at > first.from + 1e-9 && second.at < first.to - 1e-9;
      if (clash) {
        clashes.push(`${first.id} x ${second.id}`);
      }
    }
  }
  return clashes;
}

test("a family core packs the root family and the generations above it into one block", () => {
  const tree = wholePedigree(6);
  const tidy = layoutPedigree({ ...tree, ...CARD });
  const layout = layoutPedigree({ ...tree, core: { generations: 3 }, ...CARD });
  const { nodeWidth, coupleGap } = layout.config;
  const coupleWidth = 2 * nodeWidth + coupleGap;
  const rootCentre = centerX(layout, node(layout, "r"));

  assert.equal(layout.core.generations, 3);
  assert.equal(tidy.core, undefined);
  for (const generation of [1, 2, 3]) {
    const cards = row(layout, generation);
    const couples = cards.length / 2;
    // Couples side by side, the core's gap apart, centred on the root.
    assert.equal(
      cards.at(-1).x + nodeWidth - cards[0].x,
      couples * coupleWidth + (couples - 1) * DEFAULT_FAMILY_CORE.unitGap
    );
    assert.equal((cards[0].x + cards.at(-1).x + nodeWidth) / 2, rootCentre);
  }
  // In the tidy tree the same grandparents are spread under their ancestors.
  assert.ok(row(tidy, 3).at(-1).x - row(tidy, 3)[0].x > 3 * (row(layout, 3).at(-1).x - row(layout, 3)[0].x));

  // Everything above the core is where the tidy tree puts it.
  const drop = layout.core.zones.reduce((sum, zone) => sum + zone.height, 0);
  const shift = node(layout, "rffff").x - node(tidy, "rffff").x;
  for (const item of layout.nodes.filter((entry) => entry.generation > 3)) {
    const before = node(tidy, item.personId);
    assert.equal(item.x - before.x, shift);
    assert.equal(item.y, before.y);
  }
  assert.equal(node(layout, "r").y, node(tidy, "r").y + drop);
  assert.deepEqual(validatePedigreeLayout(layout), []);
  assertOrthogonal(layout);
});

test("each person in the core's top row is joined to their parents by a bough on its own track", () => {
  for (const generations of [2, 3, 4]) {
    const layout = layoutPedigree({ ...wholePedigree(6), core: { generations }, ...CARD });
    const boughs = layout.connectors.filter((connector) => connector.bough);
    const top = row(layout, generations);
    assert.deepEqual(
      boughs.map((connector) => connector.childPersonId).sort(),
      top.map((item) => item.personId).sort()
    );
    // On each side the bars step down going outwards, one track apart.
    const bars = top.map((item) => boughs.find((connector) => connector.childPersonId === item.personId).junction.y);
    const half = bars.length / 2;
    for (let index = 1; index < half; index += 1) {
      assert.equal(bars[index - 1] - bars[index], DEFAULT_FAMILY_CORE.trackStep);
      assert.equal(bars[half + index] - bars[half + index - 1], DEFAULT_FAMILY_CORE.trackStep);
    }
    // The zone above the top row holds those tracks and room for the names.
    const zone = layout.core.zones.find((entry) => entry.generation === generations);
    assert.equal(zone.tracks, half);
    assert.equal(zone.height, (half - 1) * DEFAULT_FAMILY_CORE.trackStep + DEFAULT_FAMILY_CORE.labelRoom);
    assert.equal(
      row(layout, generations)[0].y - row(layout, generations + 1)[0].y,
      layout.config.nodeHeight + layout.config.generationGap + zone.height
    );
    for (const connector of boughs) {
      const parentBottom = node(layout, connector.parentPersonIds[0]).y + layout.config.nodeHeight;
      assert.ok(connector.junction.y > parentBottom && connector.junction.y < top[0].y);
    }
    assert.deepEqual(connectorClashes(layout), [], `core of ${generations} generations`);
  }
});

test("packed rows wider than the row below take tracks inside the core too", () => {
  // Four generations: the eight great-grandparent couples are twice as wide
  // as the grandparents beneath them, so their bars would run together.
  const layout = layoutPedigree({ ...wholePedigree(6), core: { generations: 4 }, ...CARD });
  const inner = layout.core.zones.find((zone) => zone.generation === 3);
  assert.ok(inner.tracks > 1);
  assert.equal(inner.height, (inner.tracks - 1) * DEFAULT_FAMILY_CORE.trackStep);
  assert.equal(layout.connectors.filter((connector) => connector.bough).length, 16);
  assert.deepEqual(connectorClashes(layout), []);
});

test("an uneven core keeps each couple as nearly above its child as packing allows", () => {
  // Only the father's side is known beyond the parents.
  const tree = wholePedigree(4, { skip: (id) => id.startsWith("rm") });
  const layout = layoutPedigree({ ...tree, core: { generations: 3 }, ...CARD });
  // One couple above the father: exactly above him, not above the root.
  const grandparents = row(layout, 2);
  assert.deepEqual(grandparents.map((item) => item.personId), ["rff", "rfm"]);
  assert.equal(
    (grandparents[0].x + grandparents[1].x + layout.config.nodeWidth) / 2,
    centerX(layout, node(layout, "rf"))
  );
  assert.ok(Math.min(...layout.nodes.map((item) => item.x)) >= layout.config.marginX);
  assert.deepEqual(validatePedigreeLayout(layout), []);
  assert.deepEqual(connectorClashes(layout), []);
});

test("a core as deep as the tree has no boughs and adds no height", () => {
  const tree = wholePedigree(2);
  const tidy = layoutPedigree({ ...tree, ...CARD });
  const layout = layoutPedigree({ ...tree, view: { core: { generations: 9 } }, ...CARD });
  assert.equal(layout.core.generations, 2);
  assert.deepEqual(layout.core.zones, []);
  assert.equal(layout.connectors.some((connector) => connector.bough), false);
  assert.equal(layout.height, tidy.height);
  assert.deepEqual(connectorClashes(layout), []);
});

test("an unusable family core setting fails with an actionable error", () => {
  const tree = wholePedigree(2);
  assert.throws(() => layoutPedigree({ ...tree, core: { generations: 0 }, ...CARD }),
    /core\.generations must be a whole number of generations, 1 or more/);
  assert.throws(() => layoutPedigree({ ...tree, core: { generations: 2, trackStep: 0 }, ...CARD }),
    /core\.trackStep must be a positive finite number/);
  assert.throws(() => layoutPedigree({
    people: people("alpha", "omega"),
    links: [],
    coupleLinks: [],
    core: { generations: 2 },
    ...CARD
  }), /a family core needs one root family; this view has 2/);
});

// An uneven pedigree: some lines run deep and narrow, others stop early, so
// a tidy tree leaves wide gaps between its rigid subtrees.
function unevenPedigree() {
  const keep = new Set(["r"]);
  const grow = (id, depth, every) => {
    for (let level = 0, row = [id]; level < depth; level += 1) {
      row = row.flatMap((person, index) => (index % every === 0 ? [`${person}f`, `${person}m`] : []));
      row.forEach((person) => keep.add(person));
    }
  };
  for (const person of ["rf", "rm", "rff", "rfm", "rmf", "rmm"]) {
    keep.add(person);
  }
  grow("rff", 7, 1);
  grow("rfm", 3, 1);
  grow("rmf", 8, 3);
  grow("rmm", 5, 2);
  const ids = [...keep];
  const links = [];
  const coupleLinks = [];
  for (const id of ids) {
    if (keep.has(`${id}f`)) {
      links.push(parent(`${id}f`, id), parent(`${id}m`, id));
      coupleLinks.push(couple(`${id}f`, `${id}m`));
    }
  }
  return { people: people(...ids), links, coupleLinks };
}

test("compaction closes the gaps between subtrees and keeps every rule of the drawing", () => {
  const tree = unevenPedigree();
  const tidy = layoutPedigree({ ...tree, ...CARD });
  const layout = layoutPedigree({ ...tree, compact: true, ...CARD });
  assert.equal(layout.compact, true);
  assert.equal(tidy.compact, undefined);
  assert.ok(layout.width < tidy.width, `${layout.width} against ${tidy.width}`);
  assert.equal(layout.height, tidy.height);
  // The same people in the same rows, each row in the same order.
  for (let generation = 0; generation <= layout.maxGeneration; generation += 1) {
    assert.deepEqual(
      row(layout, generation).map((item) => item.personId),
      row(tidy, generation).map((item) => item.personId)
    );
  }
  // No one further from their parents than the tidy tree had them at worst.
  const offsets = (result) => result.connectors.filter((connector) => connector.kind === "family")
    .map((connector) => Math.abs(connector.junction.x - centerX(result, node(result, connector.childPersonId))));
  assert.ok(Math.max(...offsets(layout)) <= Math.max(...offsets(tidy)) + 1e-6);
  // All the links of one space between rows still share one track.
  for (const connector of layout.connectors.filter((item) => item.kind === "family")) {
    const parentBottom = node(layout, connector.parentPersonIds[0]).y + layout.config.nodeHeight;
    assert.equal(connector.junction.y, parentBottom + layout.config.familyBarOffset);
  }
  // Two bars on one track keep well apart, and nobody's line comes down
  // under the couple next to their parents.
  const families = layout.connectors.filter((item) => item.kind === "family").map((connector) => {
    const child = node(layout, connector.childPersonId);
    const parents = connector.parentPersonIds.map((id) => node(layout, id));
    const centre = centerX(layout, child);
    return {
      generation: child.generation,
      centre,
      from: Math.min(connector.junction.x, centre),
      to: Math.max(connector.junction.x, centre),
      left: Math.min(...parents.map((item) => item.x)),
      right: Math.max(...parents.map((item) => item.x)) + layout.config.nodeWidth
    };
  });
  for (const first of families) {
    for (const second of families) {
      if (first === second || first.generation !== second.generation || first.centre > second.centre) {
        continue;
      }
      assert.ok(second.from - first.to >= Math.round(layout.config.nodeWidth * 0.3) - 1e-6);
      assert.ok(first.centre <= second.left - layout.config.coupleGap + 1e-6);
      assert.ok(second.centre >= first.right + layout.config.coupleGap - 1e-6);
    }
  }
  assert.deepEqual(validatePedigreeLayout(layout), []);
  assert.deepEqual(connectorClashes(layout), []);
  assertOrthogonal(layout);
  // The same input gives the same layout.
  assert.deepEqual(layoutPedigree({ ...tree, compact: true, ...CARD }).nodes, layout.nodes);
});

test("compaction leaves an already tight tree its width and works with a family core", () => {
  const whole = wholePedigree(4);
  const tidy = layoutPedigree({ ...whole, ...CARD });
  const compact = layoutPedigree({ ...whole, view: { compact: true }, ...CARD });
  assert.ok(compact.width <= tidy.width + 1e-6);
  assert.deepEqual(connectorClashes(compact), []);

  const tree = unevenPedigree();
  const cored = layoutPedigree({ ...tree, compact: true, core: { generations: 2 }, ...CARD });
  const loose = layoutPedigree({ ...tree, core: { generations: 2 }, ...CARD });
  assert.ok(cored.width < loose.width);
  const length = (result) => result.connectors.filter((connector) => connector.bough)
    .reduce((sum, connector) => sum + Math.abs(connector.junction.x - centerX(result, node(result, connector.childPersonId))), 0);
  assert.ok(length(cored) < length(loose), "boughs are shorter once the rows above are compacted");
  assert.deepEqual(validatePedigreeLayout(cored), []);
  assert.deepEqual(connectorClashes(cored), []);
});
