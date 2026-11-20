import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { layoutKinshipLayered, validateKinshipLayout } from "./kinship-layout.mjs";

const people = (...ids) => ids.map((id) => ({ id }));
const view = (entries) => ({
  id: "root-b-detailed",
  nodes: entries.map(([id, generation]) => ({ id, generation })),
  axis: ["Older", "Parents", "Current", "Children"].map((label) => ({ label }))
});

test("kinship layout renders each person once on a deterministic generation row", () => {
  const input = {
    people: people("grand", "parent", "aunt", "root-b", "cousin", "partner"),
    links: [
      { from: "grand", to: "parent", status: "confirmed" },
      { from: "grand", to: "aunt", status: "candidate" },
      { from: "parent", to: "root-b", status: "confirmed" },
      { from: "aunt", to: "cousin", status: "confirmed" }
    ],
    coupleLinks: [{ from: "root-b", to: "partner", status: "confirmed" }],
    siblingLinks: [{ from: "parent", to: "aunt", status: "candidate" }],
    view: view([
      ["grand", 3], ["parent", 2], ["aunt", 2], ["root-b", 1], ["cousin", 1], ["partner", 1]
    ]),
    nodeWidth: 80,
    nodeHeight: 40
  };
  const layout = layoutKinshipLayered(input);
  assert.equal(new Set(layout.nodes.map((node) => node.personId)).size, 6);
  assert.equal(layout.nodes.find((node) => node.personId === "grand").generation, 3);
  assert.deepEqual(validateKinshipLayout(layout), []);
  assert.deepEqual(layoutKinshipLayered({
    ...input,
    people: [...input.people].reverse(),
    links: [...input.links].reverse(),
    coupleLinks: [...input.coupleLinks].reverse()
  }), layout);
});

test("kinship layout rejects recursive generation conflicts", () => {
  assert.throws(() => layoutKinshipLayered({
    people: people("parent", "child"),
    links: [{ from: "parent", to: "child", status: "confirmed" }],
    coupleLinks: [],
    siblingLinks: [],
    view: view([["parent", 2], ["child", 0]]),
    nodeWidth: 80,
    nodeHeight: 40
  }), /generations conflict/);
});

test("an explicit sibling stays beside the focal couple and uses a separate upper channel", () => {
  const layout = layoutKinshipLayered({
    people: people("focal", "partner", "sibling"),
    links: [],
    coupleLinks: [{ from: "partner", to: "focal", status: "confirmed" }],
    siblingLinks: [{ from: "focal", to: "sibling", status: "confirmed" }],
    view: view([["focal", 3], ["partner", 3], ["sibling", 3]]),
    nodeWidth: 80,
    nodeHeight: 40
  });
  assert.deepEqual(layout.nodes.map((node) => node.personId), ["partner", "focal", "sibling"]);
  const sibling = layout.connectors.find((connector) => connector.kind === "sibling");
  assert.ok(sibling.segments.every((segment) => segment.y1 <= 24 && segment.y2 <= 24));
});

test("generation-aware axis labels stay attached to recent rows in a deep tree", () => {
  const input = {
    people: people("oldest", "grandparent", "parent", "root-b", "child"),
    links: [
      { from: "oldest", to: "grandparent", status: "confirmed" },
      { from: "grandparent", to: "parent", status: "confirmed" },
      { from: "parent", to: "root-b", status: "confirmed" },
      { from: "root-b", to: "child", status: "confirmed" }
    ],
    coupleLinks: [],
    siblingLinks: [],
    view: {
      id: "root-b-detailed",
      nodes: [["oldest", 4], ["grandparent", 3], ["parent", 2], ["root-b", 1], ["child", 0]]
        .map(([id, generation]) => ({ id, generation })),
      axis: [
        { label: "Earlier", generation: "max" },
        { label: "Parents", generation: 2 },
        { label: "Current", generation: 1 },
        { label: "Children", generation: 0 }
      ]
    },
    nodeWidth: 80,
    nodeHeight: 40
  };
  const layout = layoutKinshipLayered(input);
  const yByGeneration = new Map(layout.nodes.map((node) => [node.generation, node.y + 20]));
  assert.deepEqual(layout.axis.map((axis) => axis.y), [
    yByGeneration.get(4), yByGeneration.get(2), yByGeneration.get(1), yByGeneration.get(0)
  ]);
});
