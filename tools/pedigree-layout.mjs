import { hierarchy, tree } from "d3-hierarchy";

/**
 * Geometry defaults for the build-time pedigree layout. All measurements are
 * CSS pixels. The node width and height are deliberately not defaulted: a
 * caller must make the generated geometry agree with the rendered cards.
 */
export const DEFAULT_PEDIGREE_LAYOUT = Object.freeze({
  generationGap: 44,
  nodeGap: 18,
  coupleGap: 22,
  componentGap: 72,
  familyBarOffset: 18,
  marginX: 20,
  marginY: 20,
  axisOffset: 42,
  maxOccurrences: 100_000
});

/**
 * Lay out a descendant-rooted pedigree.
 *
 * Semantic parent links point from parent to child. The generated occurrence
 * tree points the other way (child to parents), which means that a repeated
 * ancestor naturally receives one visual occurrence per ancestry path.
 *
 * @param {object} input
 * @param {{id: string}[]} input.people canonical people
 * @param {{from: string, to: string, status?: string}[]} input.links parent links
 * @param {{from: string, to: string, status?: string}[]} [input.coupleLinks]
 * @param {Iterable<string>} [input.visibleIds] canonical ids to include
 * @param {object} [input.view] view.nodes, view.axis, layoutFlipCouples and core are supported
 * @param {{generations: number}} [input.core] pack the root family and this
 *   many generations of its ancestors into one block (see applyFamilyCore)
 * @param {number} input.nodeWidth rendered card width
 * @param {number} input.nodeHeight rendered card height
 * @returns {object} occurrence nodes and pre-routed orthogonal connectors
 */
export function layoutPedigree(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("layoutPedigree requires an input object");
  }

  const view = objectOrEmpty(input.view);
  const config = readConfig(input, view);
  const people = requireArray(input.people, "people");
  const links = requireArray(input.links, "links");
  const coupleLinks = input.coupleLinks == null
    ? []
    : requireArray(input.coupleLinks, "coupleLinks");
  const peopleById = indexPeople(people);
  const visible = visiblePeople(input.visibleIds, view.nodes, peopleById);

  if (visible.size === 0) {
    return emptyLayout(config, axisSpecs(input, view));
  }

  const coreSetting = readCore(input, view);
  const semantic = normalizeSemanticLinks(links, coupleLinks, visible, peopleById, view, input);
  assertAcyclic(visible, semantic.parentsByChild);

  const roots = findRoots(visible, semantic.parentIds, input.rootIds ?? view.rootIds);
  const rootGroups = groupRoots(roots, semantic.couplesByPair);
  const occurrenceState = { count: 0, max: config.maxOccurrences };
  const occurrenceRoots = [];
  const rootOccurrenceByPerson = new Map();

  rootGroups.forEach((group, componentIndex) => {
    for (const personId of group) {
      const occurrence = buildOccurrence({
        personId,
        path: [personId],
        generation: 0,
        componentIndex,
        parentsByChild: semantic.parentsByChild,
        couplesByPair: semantic.couplesByPair,
        state: occurrenceState
      });
      occurrenceRoots.push(occurrence);
      rootOccurrenceByPerson.set(personId, occurrence.instanceId);
    }
  });

  // Spouses are laid out as one family unit: a unit holds the parents of
  // one child occurrence (or a root couple), side by side. Each member's own
  // parents form the unit above it, so the unit tree is still a tidy tree,
  // but a couple is never split apart by the width of its ancestry.
  const rootUnits = [];
  let rootIndex = 0;
  rootGroups.forEach((group, componentIndex) => {
    const members = occurrenceRoots.slice(rootIndex, rootIndex + group.length);
    rootIndex += group.length;
    rootUnits.push(buildUnit(members, null, componentIndex));
  });
  const virtualData = {
    virtual: true,
    instanceId: "virtual:root",
    children: rootUnits
  };
  const unitHierarchy = hierarchy(virtualData, (datum) => datum.children);
  const tidy = tree()
    .nodeSize([1, 1])
    .separation((a, b) => unitSeparation(a, b, config));
  tidy(unitHierarchy);

  const positionedUnits = unitHierarchy.descendants().filter((node) => !node.data.virtual);
  const positioned = positionedUnits.flatMap((unitNode) => {
    const width = unitWidth(unitNode.data, config);
    let left = unitNode.x - width / 2;
    return unitNode.data.members.map((member) => {
      const x = left;
      left += config.nodeWidth + config.coupleGap;
      return { data: member, left: x };
    });
  });
  const maxGeneration = Math.max(...positioned.map((node) => node.data.generation));
  const core = coreSetting
    ? applyFamilyCore(coreSetting, rootUnits, positioned, maxGeneration, config)
    : null;
  const minimumLeft = Math.min(...positioned.map((node) => node.left));
  const shiftX = config.marginX - minimumLeft;
  const rowStep = config.nodeHeight + config.generationGap;

  const nodes = positioned.map((node) => ({
    instanceId: node.data.instanceId,
    personId: node.data.personId,
    x: node.left + shiftX,
    // A row of the core sits lower by the zones its links need above it.
    y: config.marginY + (maxGeneration - node.data.generation) * rowStep
      + (core?.dropByGeneration.get(node.data.generation) ?? 0),
    generation: node.data.generation,
    component: node.data.componentIndex
  }));
  nodes.sort(comparePositionedNodes);

  const nodeByInstance = new Map(nodes.map((node) => [node.instanceId, node]));
  const occurrenceData = new Map(positioned.map((node) => [node.data.instanceId, node.data]));
  const familyConnectors = makeFamilyConnectors(nodes, nodeByInstance, occurrenceData, config, core);
  const coupleConnectors = makeRootCoupleConnectors(
    roots,
    rootOccurrenceByPerson,
    nodeByInstance,
    semantic,
    config
  );
  const connectors = [...familyConnectors, ...coupleConnectors].sort(compareConnectors);
  const right = Math.max(...nodes.map((node) => node.x + config.nodeWidth));
  const bottom = Math.max(...nodes.map((node) => node.y + config.nodeHeight));
  const width = right + config.marginX;
  const height = bottom + config.marginY;
  const axis = makeAxis(axisSpecs(input, view), nodes, config);

  const result = {
    width,
    height,
    maxGeneration,
    config: { ...config },
    ...(core ? {
      core: {
        generations: core.generations,
        unitGap: core.unitGap,
        trackStep: core.trackStep,
        labelRoom: core.labelRoom,
        zones: core.zones
      }
    } : {}),
    axis,
    roots: occurrenceRoots.map((node) => node.instanceId),
    nodes,
    connectors,
    familyConnectors,
    coupleConnectors
  };

  const issues = validatePedigreeLayout(result);
  if (issues.length) {
    throw new Error(`invalid generated pedigree layout:\n- ${issues.join("\n- ")}`);
  }
  return result;
}

// A name that reads naturally from build scripts while keeping layoutPedigree
// short in fixture tests and downstream callers.
export const computePedigreeLayout = layoutPedigree;

export function pairKey(first, second) {
  return [String(first), String(second)].sort().join("|");
}

export function isAxisAlignedSegment(segment, epsilon = 1e-9) {
  return Math.abs(segment.x1 - segment.x2) <= epsilon
    || Math.abs(segment.y1 - segment.y2) <= epsilon;
}

/**
 * Validate the invariants the renderer relies on. Returns descriptions rather
 * than throwing so build checks can report every problem in one pass.
 */
export function validatePedigreeLayout(layout, epsilon = 1e-7) {
  const issues = [];
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const connectors = Array.isArray(layout?.connectors) ? layout.connectors : [];
  const nodeByInstance = new Map(nodes.map((node) => [node.instanceId, node]));
  const nodeWidth = layout?.config?.nodeWidth;
  const nodeHeight = layout?.config?.nodeHeight;

  const yByGeneration = new Map();
  const nodesByGeneration = new Map();
  for (const node of nodes) {
    const rowY = yByGeneration.get(node.generation);
    if (rowY == null) {
      yByGeneration.set(node.generation, node.y);
    } else if (Math.abs(rowY - node.y) > epsilon) {
      issues.push(`generation ${node.generation} does not have a fixed y coordinate`);
    }
    if (!nodesByGeneration.has(node.generation)) {
      nodesByGeneration.set(node.generation, []);
    }
    nodesByGeneration.get(node.generation).push(node);
  }

  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    for (const generationNodes of nodesByGeneration.values()) {
      const row = [...generationNodes].sort((a, b) => a.x - b.x || a.instanceId.localeCompare(b.instanceId));
      for (let index = 1; index < row.length; index += 1) {
        const first = row[index - 1];
        const second = row[index];
        if (first.x + nodeWidth > second.x + epsilon) {
          issues.push(`${first.instanceId} overlaps ${second.instanceId}`);
        }
      }
    }
  }

  for (const connector of connectors) {
    for (const segment of connector.segments || []) {
      if (!isAxisAlignedSegment(segment, epsilon)) {
        issues.push(`${connector.id} contains a diagonal segment`);
      }
    }
    if (connector.kind !== "family") {
      continue;
    }
    const child = nodeByInstance.get(connector.childInstanceId);
    const parents = connector.parentInstanceIds
      .map((instanceId) => nodeByInstance.get(instanceId))
      .filter(Boolean);
    if (!child || parents.length !== connector.parentInstanceIds.length) {
      issues.push(`${connector.id} references a missing occurrence`);
      continue;
    }
    const childCenter = child.x + nodeWidth / 2;
    const trunk = connector.segments.at(-1);
    if (!trunk || Math.abs(trunk.x1 - childCenter) > epsilon || Math.abs(trunk.x2 - childCenter) > epsilon
      || Math.abs(trunk.y2 - child.y) > epsilon) {
      issues.push(`${connector.id} does not end in a trunk into the child's top centre`);
    }
    if (parents.length === 2) {
      const [left, right] = [...parents].sort((a, b) => a.x - b.x);
      const gap = right.x - (left.x + nodeWidth);
      if (gap < -epsilon || gap > (layout?.config?.coupleGap ?? gap) + epsilon) {
        issues.push(`${connector.id} parents are not adjacent`);
      }
    }
  }

  return [...new Set(issues)];
}

/**
 * Occurrences the layout draws as one couple unit, keyed by instance id: the
 * two parents under a family connector, or the two ends of a root couple
 * connector.
 */
export function coupleUnitPartners(connectors) {
  const partners = new Map();
  const join = (first, second) => {
    if (typeof first !== "string" || typeof second !== "string" || first === second) {
      return;
    }
    for (const [from, to] of [[first, second], [second, first]]) {
      if (!partners.has(from)) {
        partners.set(from, new Set());
      }
      partners.get(from).add(to);
    }
  };
  for (const connector of Array.isArray(connectors) ? connectors : []) {
    if (connector?.kind === "family" && connector.parentInstanceIds?.length === 2) {
      join(connector.parentInstanceIds[0], connector.parentInstanceIds[1]);
    } else if (connector?.kind === "couple") {
      join(connector.fromInstanceId, connector.toInstanceId);
    }
  }
  return partners;
}

/**
 * Smallest gap two neighbouring cards of one generation row may have.
 *
 * A couple needs the couple gap, which holds the junction of its family
 * connector. A couple reached by two neighbouring lines of descent is drawn
 * twice, though, and the right-hand card of the first unit then sits beside
 * the left-hand card of the second: the same two people, but each already
 * joined to its own partner on its far side. Those two cards are ordinary
 * neighbours and need only the node gap. Without `unitPartners` (a layout
 * that draws every person once) the pair alone decides.
 */
export function requiredCardGap(left, right, { isCouple, unitPartners, nodeGap, coupleGap }) {
  if (!isCouple) {
    return nodeGap;
  }
  if (!unitPartners) {
    return coupleGap;
  }
  const leftPartners = unitPartners.get(left.instanceId);
  if (leftPartners?.has(right.instanceId)) {
    return coupleGap;
  }
  const rightPartners = unitPartners.get(right.instanceId);
  return leftPartners?.size && rightPartners?.size ? nodeGap : coupleGap;
}

function readConfig(input, view) {
  const options = objectOrEmpty(input.options);
  const config = {};
  const names = [
    "generationGap",
    "nodeGap",
    "coupleGap",
    "componentGap",
    "familyBarOffset",
    "marginX",
    "marginY",
    "axisOffset",
    "maxOccurrences"
  ];
  for (const name of names) {
    config[name] = finiteSetting(input[name], view[name], options[name], DEFAULT_PEDIGREE_LAYOUT[name]);
  }
  config.nodeWidth = finiteSetting(input.nodeWidth, view.nodeWidth, options.nodeWidth);
  config.nodeHeight = finiteSetting(input.nodeHeight, view.nodeHeight, options.nodeHeight);

  positive(config.nodeWidth, "nodeWidth");
  positive(config.nodeHeight, "nodeHeight");
  positive(config.maxOccurrences, "maxOccurrences");
  for (const name of [
    "generationGap",
    "nodeGap",
    "coupleGap",
    "componentGap",
    "familyBarOffset",
    "marginX",
    "marginY",
    "axisOffset"
  ]) {
    nonnegative(config[name], name);
  }
  if (config.familyBarOffset > config.generationGap) {
    throw new RangeError("familyBarOffset cannot exceed generationGap");
  }
  config.maxOccurrences = Math.floor(config.maxOccurrences);
  return config;
}

function finiteSetting(...values) {
  return values.find((value) => Number.isFinite(value));
}

export const DEFAULT_FAMILY_CORE = Object.freeze({
  // Gap between two couples of one core row. Wider than the couple gap, so
  // that a packed row still reads as couples.
  unitGap: 72,
  // Distance between two boughs stacked in the trunk zone.
  trackStep: 28,
  // Room kept clear above the core's top row for the names on the boughs.
  labelRoom: 20
});

function readCore(input, view) {
  const setting = input.core ?? view.core;
  if (setting == null || setting === false) {
    return null;
  }
  const options = typeof setting === "number" ? { generations: setting } : objectOrEmpty(setting);
  if (!Number.isInteger(options.generations) || options.generations < 1) {
    throw new RangeError("core.generations must be a whole number of generations, 1 or more");
  }
  const core = { generations: options.generations };
  for (const name of ["unitGap", "trackStep", "labelRoom"]) {
    core[name] = finiteSetting(options[name], DEFAULT_FAMILY_CORE[name]);
    nonnegative(core[name], `core.${name}`);
  }
  positive(core.trackStep, "core.trackStep");
  return core;
}

/**
 * The family core. A tidy tree centres every couple under its own ancestors,
 * so the root family, where two whole ancestries meet, ends up a long way
 * from its parents, and they from theirs. The core takes the root family and
 * the first few generations above it out of that rule: each of those rows is
 * packed, couple beside couple, as nearly above its children as the packing
 * allows. Everything above the core keeps its tidy position. A person in the
 * core's top row is then joined to their parents by a bough: an ordinary
 * family connector with a long bar.
 *
 * Packing means the bars of one level can run past each other, inside the
 * core as well as above it, so each bar that would meet another takes a
 * track of its own, and the rows below move down by the zone those tracks
 * need. No two links of the core then overlap or cross.
 *
 * Moves the core's cards in `positioned`; the caller lowers the rows by
 * `dropByGeneration` and draws each link on its track from `trackByChild`.
 */
function applyFamilyCore(setting, rootUnits, positioned, maxGeneration, config) {
  if (rootUnits.length !== 1) {
    throw new Error(`a family core needs one root family; this view has ${rootUnits.length}`);
  }
  const generations = Math.min(setting.generations, maxGeneration);
  const placed = new Map(positioned.map((node) => [node.data.instanceId, node]));
  const centreOf = (occurrence) => placed.get(occurrence.instanceId).left + config.nodeWidth / 2;
  const unitCentre = (unit) => {
    const lefts = unit.members.map((member) => placed.get(member.instanceId).left);
    return (Math.min(...lefts) + Math.max(...lefts) + config.nodeWidth) / 2;
  };
  // The units holding the parents of each member of a row, in order, each
  // with the member it belongs to.
  const parentUnits = (row) => row.flatMap(({ unit }) => unit.children.map((parentUnit) => ({
    unit: parentUnit,
    child: unit.members.find((member) => member.instanceId === parentUnit.childInstanceId)
  })));

  const firstGeneration = rootUnits[0].members[0].generation;
  const rows = new Map([[firstGeneration, [{ unit: rootUnits[0], child: null }]]]);
  for (let generation = firstGeneration + 1; generation <= generations; generation += 1) {
    const row = parentUnits(rows.get(generation - 1));
    rows.set(generation, row);
    const widths = row.map(({ unit }) => unitWidth(unit, config));
    const centres = packInOrder(
      row.map(({ child }) => centreOf(child)),
      widths.slice(1).map((width, index) => (widths[index] + width) / 2 + setting.unitGap)
    );
    row.forEach(({ unit }, index) => {
      let left = centres[index] - widths[index] / 2;
      for (const member of unit.members) {
        placed.get(member.instanceId).left = left;
        left += config.nodeWidth + config.coupleGap;
      }
    });
  }

  // Tracks, level by level. A bar runs from the parents' junction to the
  // child. Take two bars that run leftwards and share some ground: the one
  // further left must turn below the other, or the other's drop from its
  // parents would cut through it. So going outwards on each side, a bar
  // that meets its inner neighbour takes the next track down; one that
  // doesn't starts again at the top. Bars running in opposite directions
  // never share ground, because the rows keep their order.
  const trackByChild = new Map();
  const boughChildren = new Set();
  const zones = [];
  const dropByGeneration = new Map();
  let drop = 0;
  for (let generation = generations; generation >= firstGeneration; generation -= 1) {
    const links = parentUnits(rows.get(generation))
      .map(({ unit, child }) => ({ child, from: unitCentre(unit), to: centreOf(child), track: 0 }));
    const leftward = links.filter((link) => link.from < link.to - 1e-9);
    const rightward = links.filter((link) => link.from > link.to + 1e-9);
    for (let index = leftward.length - 2; index >= 0; index -= 1) {
      const inner = leftward[index + 1];
      leftward[index].track = inner.from < leftward[index].to + config.coupleGap ? inner.track + 1 : 0;
    }
    for (let index = 1; index < rightward.length; index += 1) {
      const inner = rightward[index - 1];
      rightward[index].track = rightward[index].to < inner.from + config.coupleGap ? inner.track + 1 : 0;
    }
    const top = generation === generations;
    const tracks = links.length ? Math.max(...links.map((link) => link.track)) + 1 : 0;
    const zone = Math.max(0, tracks - 1) * setting.trackStep + (top && tracks ? setting.labelRoom : 0);
    for (const link of links) {
      trackByChild.set(link.child.instanceId, link.track);
      if (top) {
        boughChildren.add(link.child.instanceId);
      }
    }
    if (zone > 0) {
      zones.push({ generation, tracks, height: zone });
    }
    drop += zone;
    dropByGeneration.set(generation, drop);
  }
  return {
    ...setting,
    generations,
    zones: zones.reverse(),
    dropByGeneration,
    trackByChild,
    boughChildren
  };
}

/**
 * Centres for a row of boxes that must keep their order and stay at least
 * `separations[i]` apart (centre i to centre i + 1), as near as possible to
 * the `wanted` centres in the least-squares sense. Taking the running
 * minimum separation off each centre turns "at least this far apart" into
 * "not decreasing", which pooling adjacent violators solves exactly.
 */
function packInOrder(wanted, separations) {
  const offsets = [0];
  for (const separation of separations) {
    offsets.push(offsets.at(-1) + separation);
  }
  const blocks = [];
  wanted.forEach((value, index) => {
    blocks.push({ sum: value - offsets[index], count: 1 });
    while (blocks.length > 1
      && blocks.at(-2).sum / blocks.at(-2).count > blocks.at(-1).sum / blocks.at(-1).count) {
      const last = blocks.pop();
      blocks.at(-1).sum += last.sum;
      blocks.at(-1).count += last.count;
    }
  });
  return blocks
    .flatMap((block) => Array.from({ length: block.count }, () => block.sum / block.count))
    .map((value, index) => value + offsets[index]);
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function indexPeople(people) {
  const peopleById = new Map();
  for (const person of people) {
    const id = person?.id;
    if (typeof id !== "string" || !id) {
      throw new TypeError("every person requires a non-empty string id");
    }
    if (peopleById.has(id)) {
      throw new Error(`duplicate person id: ${id}`);
    }
    peopleById.set(id, person);
  }
  return peopleById;
}

function visiblePeople(explicitIds, viewNodes, peopleById) {
  let ids;
  if (explicitIds != null) {
    if (typeof explicitIds[Symbol.iterator] !== "function") {
      throw new TypeError("visibleIds must be iterable");
    }
    ids = [...explicitIds];
  } else if (Array.isArray(viewNodes)) {
    ids = viewNodes.map((node) => typeof node === "string" ? node : node?.id);
  } else {
    ids = [...peopleById.keys()];
  }

  const visible = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || !id) {
      throw new TypeError("visibleIds and view.nodes require non-empty string ids");
    }
    if (!peopleById.has(id)) {
      throw new Error(`visible person is missing from people: ${id}`);
    }
    visible.add(id);
  }
  return visible;
}

function normalizeSemanticLinks(links, coupleLinks, visible, peopleById, view, input) {
  const normalizedParentLinks = normalizeLinks(links, "parent", peopleById)
    .filter((link) => visible.has(link.from) && visible.has(link.to));
  const flippedPairs = new Set((input.layoutFlipCouples ?? view.layoutFlipCouples ?? [])
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError("layoutFlipCouples entries must contain exactly two ids");
      }
      return pairKey(pair[0], pair[1]);
    }));
  const normalizedCoupleLinks = normalizeLinks(coupleLinks, "couple", peopleById)
    .filter((link) => visible.has(link.from) && visible.has(link.to))
    .map((link) => flippedPairs.has(pairKey(link.from, link.to))
      ? { ...link, from: link.to, to: link.from }
      : link)
    .sort(compareSemanticLinks);

  const parentsByChild = new Map();
  const parentIds = new Set();
  for (const link of normalizedParentLinks.sort(compareSemanticLinks)) {
    parentIds.add(link.from);
    if (!parentsByChild.has(link.to)) {
      parentsByChild.set(link.to, new Map());
    }
    const existing = parentsByChild.get(link.to).get(link.from);
    parentsByChild.get(link.to).set(link.from, existing
      ? { ...existing, status: weakestStatus([existing.status, link.status]) }
      : link);
  }

  const couplesByPair = new Map();
  for (const link of normalizedCoupleLinks) {
    const key = pairKey(link.from, link.to);
    const existing = couplesByPair.get(key);
    if (!existing) {
      couplesByPair.set(key, link);
    } else if (existing.from === link.from && existing.to === link.to) {
      existing.status = weakestStatus([existing.status, link.status]);
    } else {
      throw new Error(`conflicting couple direction for ${key}`);
    }
  }

  return { parentsByChild, parentIds, couplesByPair };
}

function normalizeLinks(links, kind, peopleById) {
  return links.map((link, index) => {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw new TypeError(`${kind} link ${index} must be an object`);
    }
    const { from, to } = link;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) {
      throw new TypeError(`${kind} link ${index} requires string from/to ids`);
    }
    if (!peopleById.has(from) || !peopleById.has(to)) {
      throw new Error(`${kind} link references a missing person: ${from}->${to}`);
    }
    if (from === to) {
      throw new Error(`${kind} link cannot connect ${from} to itself`);
    }
    return { from, to, status: normalizedStatus(link.status) };
  });
}

function normalizedStatus(status) {
  return typeof status === "string" && status ? status : "confirmed";
}

function compareSemanticLinks(first, second) {
  return first.from.localeCompare(second.from)
    || first.to.localeCompare(second.to)
    || first.status.localeCompare(second.status);
}

function assertAcyclic(visible, parentsByChild) {
  const visiting = new Set();
  const visited = new Set();
  const path = [];

  function visit(personId) {
    if (visiting.has(personId)) {
      const cycleStart = path.indexOf(personId);
      throw new Error(`parent links contain a cycle: ${[...path.slice(cycleStart), personId].join(" -> ")}`);
    }
    if (visited.has(personId)) {
      return;
    }
    visiting.add(personId);
    path.push(personId);
    for (const parentId of [...(parentsByChild.get(personId)?.keys() || [])].sort()) {
      visit(parentId);
    }
    path.pop();
    visiting.delete(personId);
    visited.add(personId);
  }

  for (const personId of [...visible].sort()) {
    visit(personId);
  }
}

function findRoots(visible, parentIds, requestedRootIds) {
  const inferred = [...visible].filter((personId) => !parentIds.has(personId)).sort();
  if (requestedRootIds == null) {
    return inferred;
  }
  if (typeof requestedRootIds[Symbol.iterator] !== "function") {
    throw new TypeError("rootIds must be iterable");
  }
  const requested = [];
  for (const personId of requestedRootIds) {
    if (!visible.has(personId)) {
      continue;
    }
    if (!requested.includes(personId)) {
      requested.push(personId);
    }
  }
  return [...requested, ...inferred.filter((personId) => !requested.includes(personId))];
}

function groupRoots(roots, couplesByPair) {
  const rootSet = new Set(roots);
  const priority = new Map(roots.map((personId, index) => [personId, index]));
  const adjacency = new Map(roots.map((personId) => [personId, new Set()]));
  const directed = [];
  for (const couple of couplesByPair.values()) {
    if (!rootSet.has(couple.from) || !rootSet.has(couple.to)) {
      continue;
    }
    adjacency.get(couple.from).add(couple.to);
    adjacency.get(couple.to).add(couple.from);
    directed.push(couple);
  }

  const remaining = new Set(roots);
  const components = [];
  while (remaining.size) {
    const start = [...remaining].sort((a, b) => compareByPriority(a, b, priority))[0];
    const stack = [start];
    const component = [];
    remaining.delete(start);
    while (stack.length) {
      const personId = stack.pop();
      component.push(personId);
      for (const neighbor of [...adjacency.get(personId)].sort().reverse()) {
        if (remaining.delete(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
    components.push(orderRootComponent(component, directed, priority));
  }
  components.sort((first, second) => {
    const firstRank = Math.min(...first.map((id) => priority.get(id)));
    const secondRank = Math.min(...second.map((id) => priority.get(id)));
    return firstRank - secondRank || first[0].localeCompare(second[0]);
  });
  return components;
}

function orderRootComponent(component, directed, priority) {
  const members = new Set(component);
  const indegree = new Map(component.map((id) => [id, 0]));
  const outgoing = new Map(component.map((id) => [id, []]));
  for (const link of directed) {
    if (!members.has(link.from) || !members.has(link.to)) {
      continue;
    }
    outgoing.get(link.from).push(link.to);
    indegree.set(link.to, indegree.get(link.to) + 1);
  }
  const ready = component
    .filter((id) => indegree.get(id) === 0)
    .sort((a, b) => compareByPriority(a, b, priority));
  const ordered = [];
  while (ready.length) {
    const personId = ready.shift();
    ordered.push(personId);
    for (const neighbor of outgoing.get(personId).sort()) {
      indegree.set(neighbor, indegree.get(neighbor) - 1);
      if (indegree.get(neighbor) === 0) {
        ready.push(neighbor);
        ready.sort((a, b) => compareByPriority(a, b, priority));
      }
    }
  }
  // A multi-marriage orientation cycle should not make layout impossible; the
  // semantic couple order still gets a deterministic lexical fallback.
  return ordered.length === component.length
    ? ordered
    : [...component].sort((a, b) => compareByPriority(a, b, priority));
}

function compareByPriority(first, second, priority) {
  return priority.get(first) - priority.get(second) || first.localeCompare(second);
}

function buildOccurrence({
  personId,
  path,
  generation,
  componentIndex,
  parentsByChild,
  couplesByPair,
  state
}) {
  state.count += 1;
  if (state.count > state.max) {
    throw new Error(`pedigree exceeds maxOccurrences (${state.max})`);
  }
  const instanceId = `occ:${path.map(pathPart).join("/")}`;
  const parentLinkMap = parentsByChild.get(personId) || new Map();
  const orderedParentIds = orderParents([...parentLinkMap.keys()], couplesByPair);
  const occurrence = {
    instanceId,
    personId,
    generation,
    componentIndex,
    parentLinks: orderedParentIds.map((parentId) => parentLinkMap.get(parentId)),
    children: []
  };
  occurrence.children = orderedParentIds.map((parentId) => buildOccurrence({
    personId: parentId,
    path: [...path, parentId],
    generation: generation + 1,
    componentIndex,
    parentsByChild,
    couplesByPair,
    state
  }));
  return occurrence;
}

function pathPart(personId) {
  return encodeURIComponent(personId).replaceAll("'", "%27");
}

function orderParents(parentIds, couplesByPair) {
  const ids = [...new Set(parentIds)].sort();
  if (ids.length !== 2) {
    return ids;
  }
  const couple = couplesByPair.get(pairKey(ids[0], ids[1]));
  return couple ? [couple.from, couple.to] : ids;
}

function buildUnit(members, childOccurrence, componentIndex) {
  return {
    instanceId: `unit:${members.map((member) => member.instanceId).join("+")}`,
    members,
    childInstanceId: childOccurrence?.instanceId || null,
    componentIndex,
    children: members
      .filter((member) => member.children.length)
      .map((member) => buildUnit(member.children, member, componentIndex))
  };
}

function unitWidth(unit, config) {
  const count = Math.max(1, unit.members?.length || 1);
  return count * config.nodeWidth + (count - 1) * config.coupleGap;
}

function unitSeparation(a, b, config) {
  const half = (unitWidth(a.data, config) + unitWidth(b.data, config)) / 2;
  if (a.data.virtual || b.data.virtual) {
    return half + config.nodeGap;
  }
  if (a.data.componentIndex !== b.data.componentIndex) {
    return half + config.componentGap;
  }
  return half + config.nodeGap;
}

function comparePositionedNodes(first, second) {
  return first.y - second.y
    || first.x - second.x
    || first.instanceId.localeCompare(second.instanceId);
}

// Family connectors join a couple at mid-height across the gap between their
// cards, drop from that junction to a bar below the couple, then run along
// the bar to a straight trunk into the child's top centre. A single known
// parent drops from the bottom centre of its card instead. A bough of the
// family core is the same shape with its bar on its own track.
function makeFamilyConnectors(nodes, nodeByInstance, occurrenceData, config, core = null) {
  const connectors = [];
  for (const childNode of nodes) {
    const childData = occurrenceData.get(childNode.instanceId);
    if (!childData?.children.length) {
      continue;
    }
    const parents = childData.children.map((parent) => nodeByInstance.get(parent.instanceId));
    const parentInstanceIds = parents.map((parent) => parent.instanceId);
    const parentPersonIds = parents.map((parent) => parent.personId);
    const parentStatuses = childData.parentLinks.map((link) => link.status);
    const childCenterX = centerX(childNode, config.nodeWidth);
    const parentBottomY = parents[0].y + config.nodeHeight;
    const track = core?.trackByChild.get(childNode.instanceId);
    const familyBarY = parentBottomY + config.familyBarOffset + (track ?? 0) * (core?.trackStep ?? 0);
    let segments;
    let junctionX;
    if (parents.length === 1) {
      junctionX = centerX(parents[0], config.nodeWidth);
      segments = [verticalSegment(junctionX, parentBottomY, familyBarY)];
    } else if (parents.length === 2) {
      const [left, right] = [...parents].sort((a, b) => a.x - b.x);
      const armY = parents[0].y + config.nodeHeight / 2;
      junctionX = (left.x + config.nodeWidth + right.x) / 2;
      segments = parents.map((parent) => parent === left
        ? horizontalSegment(left.x + config.nodeWidth, armY, junctionX)
        : horizontalSegment(right.x, armY, junctionX));
      segments.push(verticalSegment(junctionX, armY, familyBarY));
    } else {
      // More than two recorded parents: each drops from its own card to a
      // shared bar.
      const centres = parents.map((parent) => centerX(parent, config.nodeWidth));
      junctionX = (Math.min(...centres) + Math.max(...centres)) / 2;
      segments = centres.map((x) => verticalSegment(x, parentBottomY, familyBarY));
      segments.push(horizontalSegment(Math.min(...centres), familyBarY, Math.max(...centres)));
    }
    if (Math.abs(junctionX - childCenterX) > 1e-9) {
      segments.push(horizontalSegment(junctionX, familyBarY, childCenterX));
    }
    segments.push(verticalSegment(childCenterX, familyBarY, childNode.y));
    connectors.push({
      id: `family:${childNode.instanceId}`,
      kind: "family",
      style: "couple-unit",
      status: weakestStatus(parentStatuses),
      childInstanceId: childNode.instanceId,
      childPersonId: childNode.personId,
      parentInstanceIds,
      parentPersonIds,
      parentStatuses,
      junction: { x: junctionX, y: familyBarY },
      ...(core?.boughChildren.has(childNode.instanceId) ? { bough: true } : {}),
      segments
    });
  }
  return connectors;
}

function makeRootCoupleConnectors(roots, rootOccurrenceByPerson, nodeByInstance, semantic, config) {
  const rootSet = new Set(roots);
  const connectors = [];
  for (const couple of [...semantic.couplesByPair.values()].sort(compareSemanticLinks)) {
    if (!rootSet.has(couple.from) || !rootSet.has(couple.to)) {
      continue;
    }
    const fromInstanceId = rootOccurrenceByPerson.get(couple.from);
    const toInstanceId = rootOccurrenceByPerson.get(couple.to);
    const from = nodeByInstance.get(fromInstanceId);
    const to = nodeByInstance.get(toInstanceId);
    if (!from || !to || from.generation !== to.generation) {
      continue;
    }
    const left = from.x <= to.x ? from : to;
    const right = left === from ? to : from;
    const centerY = left.y + config.nodeHeight / 2;
    connectors.push({
      id: `couple:${pairKey(fromInstanceId, toInstanceId)}`,
      kind: "couple",
      status: couple.status,
      fromInstanceId,
      toInstanceId,
      fromPersonId: couple.from,
      toPersonId: couple.to,
      segments: [horizontalSegment(left.x + config.nodeWidth, centerY, right.x)]
    });
  }
  return connectors;
}

function compareConnectors(first, second) {
  return first.kind.localeCompare(second.kind) || first.id.localeCompare(second.id);
}

function horizontalSegment(x1, y, x2) {
  return { x1, y1: y, x2, y2: y };
}

function verticalSegment(x, y1, y2) {
  return { x1: x, y1, x2: x, y2 };
}

function centerX(node, nodeWidth) {
  return node.x + nodeWidth / 2;
}

function weakestStatus(statuses) {
  if (statuses.includes("unresolved")) {
    return "unresolved";
  }
  if (statuses.includes("candidate")) {
    return "candidate";
  }
  return statuses[0] || "confirmed";
}

function axisSpecs(input, view) {
  const specs = input.axis ?? view.axis ?? [];
  return Array.isArray(specs) ? specs : [];
}

function makeAxis(specs, nodes, config) {
  if (!specs.length || !nodes.length) {
    return [];
  }
  const rows = [...new Set(nodes.map((node) => node.y))].sort((a, b) => a - b);
  return specs.map((spec, index) => {
    const rowIndex = specs.length === 1
      ? 0
      : Math.round(index / (specs.length - 1) * Math.max(0, rows.length - 1));
    const normalized = typeof spec === "string" ? { label: spec } : { ...spec };
    return {
      ...normalized,
      generation: Math.max(0, rows.length - 1 - rowIndex),
      y: Math.max(0, rows[rowIndex] - config.axisOffset)
    };
  });
}

function emptyLayout(config, specs) {
  return {
    width: config.marginX * 2,
    height: config.marginY * 2,
    maxGeneration: 0,
    config: { ...config },
    axis: specs.map((spec) => typeof spec === "string" ? { label: spec, generation: 0, y: 0 } : {
      ...spec,
      generation: 0,
      y: 0
    }),
    roots: [],
    nodes: [],
    connectors: [],
    familyConnectors: [],
    coupleConnectors: []
  };
}

export default layoutPedigree;
