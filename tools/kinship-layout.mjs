import { isAxisAlignedSegment, pairKey } from "./pedigree-layout.mjs";

export const DEFAULT_KINSHIP_LAYOUT = Object.freeze({
  generationGap: 72,
  nodeGap: 28,
  coupleGap: 12,
  componentGap: 64,
  marginX: 24,
  marginY: 24,
  axisOffset: 42
});

export function layoutKinshipLayered(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("layoutKinshipLayered requires an input object");
  }
  const view = objectOrEmpty(input.view);
  const config = readConfig(input, view);
  const peopleById = new Map((input.people || []).map((person) => [person.id, person]));
  const specs = (view.nodes || []).map((spec) => typeof spec === "string" ? { id: spec } : spec);
  const generationById = new Map();
  for (const spec of specs) {
    if (!peopleById.has(spec.id)) throw new Error(`visible person is missing from people: ${spec.id}`);
    if (!Number.isInteger(spec.generation) || spec.generation < 0) {
      throw new Error(`kinship view person ${spec.id} requires a non-negative generation`);
    }
    if (generationById.has(spec.id)) throw new Error(`kinship view repeats person ${spec.id}`);
    generationById.set(spec.id, spec.generation);
  }
  if (!generationById.size) return emptyLayout(config, view.axis || []);

  const visible = new Set(generationById.keys());
  const coupleLinks = (input.coupleLinks || []).filter((link) =>
    visible.has(link.from) && visible.has(link.to));
  const parentLinks = (input.links || []).filter((link) =>
    visible.has(link.from) && visible.has(link.to));
  const siblingLinks = (input.siblingLinks || []).filter((link) =>
    visible.has(link.from) && visible.has(link.to));

  for (const link of parentLinks) {
    const parentGeneration = generationById.get(link.from);
    const childGeneration = generationById.get(link.to);
    if (parentGeneration !== childGeneration + 1) {
      throw new Error(`kinship parent generations conflict for ${link.from}->${link.to}`);
    }
  }
  for (const link of [...coupleLinks, ...siblingLinks]) {
    if (generationById.get(link.from) !== generationById.get(link.to)) {
      throw new Error(`same-generation relationship conflicts for ${link.from}+${link.to}`);
    }
  }

  const configuredMax = Math.max(0, (view.axis || []).length - 1);
  const maxGeneration = Math.max(configuredMax, ...generationById.values());
  const rowStep = config.nodeHeight + config.generationGap;
  const provisionalRows = new Map();
  for (let generation = 0; generation <= maxGeneration; generation += 1) {
    const ids = [...generationById]
      .filter(([, value]) => value === generation)
      .map(([id]) => id);
    provisionalRows.set(generation, orderRelationshipBlocks(ids, coupleLinks, siblingLinks));
  }
  improveRowOrder(provisionalRows, parentLinks, coupleLinks, siblingLinks, maxGeneration);

  const rowWidths = new Map();
  for (const [generation, ids] of provisionalRows) {
    let width = 0;
    for (let index = 0; index < ids.length; index += 1) {
      if (index) width += pairConnected(ids[index - 1], ids[index], coupleLinks)
        ? config.coupleGap : config.nodeGap;
      width += config.nodeWidth;
    }
    rowWidths.set(generation, width);
  }
  const contentWidth = Math.max(...rowWidths.values(), config.nodeWidth);
  const nodes = [];
  for (let generation = maxGeneration; generation >= 0; generation -= 1) {
    const ids = provisionalRows.get(generation) || [];
    let x = config.marginX + (contentWidth - rowWidths.get(generation)) / 2;
    ids.forEach((personId, index) => {
      if (index) x += pairConnected(ids[index - 1], personId, coupleLinks)
        ? config.coupleGap : config.nodeGap;
      nodes.push({
        instanceId: `kin:${view.id || "collateral"}:${personId}`,
        personId,
        x,
        y: config.marginY + (maxGeneration - generation) * rowStep,
        generation,
        component: 0
      });
      x += config.nodeWidth;
    });
  }
  nodes.sort((first, second) => first.y - second.y || first.x - second.x || first.personId.localeCompare(second.personId));
  const nodeByPerson = new Map(nodes.map((node) => [node.personId, node]));
  parentLinks.sort(compareDirectedLinks);
  coupleLinks.sort(comparePairLinks);
  siblingLinks.sort(comparePairLinks);
  const parentConnectors = parentLinks.map((link, index) =>
    makeParentConnector(link, nodeByPerson, config, index));
  const coupleConnectors = coupleLinks.map((link, index) =>
    makeSameRowConnector("couple", link, nodeByPerson, config, index));
  const displayedSharedParentPairs = sharedParentPairs(parentLinks);
  const siblingConnectors = siblingLinks
    .filter((link) => !displayedSharedParentPairs.has(pairKey(link.from, link.to)))
    .map((link, index) => makeSameRowConnector("sibling", link, nodeByPerson, config, index));
  const connectors = [...parentConnectors, ...coupleConnectors, ...siblingConnectors]
    .sort((first, second) => first.id.localeCompare(second.id));
  const width = contentWidth + config.marginX * 2;
  const height = config.marginY * 2 + config.nodeHeight + maxGeneration * rowStep;
  const axis = (view.axis || []).map((entry, index) => {
    const generation = entry.generation === "max"
      ? maxGeneration
      : Number.isInteger(entry.generation) ? entry.generation : maxGeneration - index;
    if (generation < 0 || generation > maxGeneration) {
      throw new Error(`kinship axis generation ${entry.generation} is outside 0-${maxGeneration}`);
    }
    return {
      ...entry,
      y: config.marginY + (maxGeneration - generation) * rowStep + config.nodeHeight / 2
    };
  });
  const result = {
    width,
    height,
    maxGeneration,
    config,
    axis,
    roots: nodes.filter((node) => node.generation === maxGeneration).map((node) => node.instanceId),
    nodes,
    connectors
  };
  const issues = validateKinshipLayout(result);
  if (issues.length) throw new Error(`invalid generated kinship layout:\n- ${issues.join("\n- ")}`);
  return result;
}

export function validateKinshipLayout(layout) {
  const issues = [];
  const nodes = layout?.nodes || [];
  const width = layout?.config?.nodeWidth;
  const height = layout?.config?.nodeHeight;
  const seenPeople = new Set();
  for (const node of nodes) {
    if (seenPeople.has(node.personId)) issues.push(`duplicate person occurrence ${node.personId}`);
    seenPeople.add(node.personId);
  }
  for (let index = 0; index < nodes.length; index += 1) for (let other = index + 1; other < nodes.length; other += 1) {
    const first = nodes[index];
    const second = nodes[other];
    if (first.x < second.x + width && first.x + width > second.x
      && first.y < second.y + height && first.y + height > second.y) {
      issues.push(`${first.instanceId} overlaps ${second.instanceId}`);
    }
  }
  for (const connector of layout?.connectors || []) for (const segment of connector.segments || []) {
    if (!isAxisAlignedSegment(segment)) issues.push(`${connector.id} contains a diagonal segment`);
  }
  return [...new Set(issues)];
}

function improveRowOrder(rows, parentLinks, coupleLinks, siblingLinks, maxGeneration) {
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let generation = maxGeneration - 1; generation >= 0; generation -= 1) {
      sortByAdjacentBarycenter(rows, generation, generation + 1, parentLinks, coupleLinks, siblingLinks);
    }
    for (let generation = 1; generation <= maxGeneration; generation += 1) {
      sortByAdjacentBarycenter(rows, generation, generation - 1, parentLinks, coupleLinks, siblingLinks);
    }
  }
}

function sortByAdjacentBarycenter(rows, generation, adjacentGeneration, parentLinks, coupleLinks, siblingLinks) {
  const current = rows.get(generation) || [];
  const adjacent = rows.get(adjacentGeneration) || [];
  const adjacentIndex = new Map(adjacent.map((id, index) => [id, index]));
  const neighborIndexes = (id) => parentLinks.flatMap((link) => {
    if (link.from === id && adjacentIndex.has(link.to)) return [adjacentIndex.get(link.to)];
    if (link.to === id && adjacentIndex.has(link.from)) return [adjacentIndex.get(link.from)];
    return [];
  });
  const blocks = sameRowBlocks(current, coupleLinks, siblingLinks).map((ids) => {
    const indexes = ids.flatMap(neighborIndexes);
    return { ids, barycenter: indexes.length ? indexes.reduce((sum, value) => sum + value, 0) / indexes.length : Infinity };
  });
  blocks.sort((first, second) => first.barycenter - second.barycenter
    || first.ids[0].localeCompare(second.ids[0]));
  rows.set(generation, blocks.flatMap((block) => block.ids));
}

function orderRelationshipBlocks(ids, couples, siblings) {
  return sameRowBlocks(ids, couples, siblings).flat();
}

function sameRowBlocks(ids, couples, siblings) {
  const coupleUnits = relationshipBlocks(ids, couples);
  const unitByPerson = new Map(coupleUnits.flatMap((unit, index) => unit.map((id) => [id, index])));
  const neighbors = new Map(coupleUnits.map((ignored, index) => [index, new Set()]));
  for (const link of siblings) {
    const left = unitByPerson.get(link.from);
    const right = unitByPerson.get(link.to);
    if (left === undefined || right === undefined || left === right) continue;
    neighbors.get(left).add(right);
    neighbors.get(right).add(left);
  }
  const unitKey = (index) => coupleUnits[index][0];
  const seen = new Set();
  const blocks = [];
  for (const start of [...neighbors.keys()].sort((left, right) => unitKey(left).localeCompare(unitKey(right)))) {
    if (seen.has(start)) continue;
    const block = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const index = queue.shift();
      block.push(...coupleUnits[index]);
      for (const next of [...neighbors.get(index)].sort((left, right) => unitKey(left).localeCompare(unitKey(right)))) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    blocks.push(block);
  }
  return blocks;
}

function relationshipBlocks(ids, couples) {
  const visible = new Set(ids);
  const neighbors = new Map(ids.map((id) => [id, new Set()]));
  for (const link of couples) if (visible.has(link.from) && visible.has(link.to)) {
    neighbors.get(link.from).add(link.to);
    neighbors.get(link.to).add(link.from);
  }
  const seen = new Set();
  const blocks = [];
  for (const start of [...ids].sort()) {
    if (seen.has(start)) continue;
    const block = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift();
      block.push(id);
      for (const next of [...neighbors.get(id)].sort()) if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
    if (block.length === 2) {
      const edge = couples.find((link) => pairKey(link.from, link.to) === pairKey(block[0], block[1]));
      if (edge) block.splice(0, block.length, edge.from, edge.to);
    }
    blocks.push(block);
  }
  return blocks.sort((first, second) => first[0].localeCompare(second[0]));
}

function makeParentConnector(link, nodes, config, index) {
  const parent = nodes.get(link.from);
  const child = nodes.get(link.to);
  const parentX = parent.x + config.nodeWidth / 2;
  const childX = child.x + config.nodeWidth / 2;
  const startY = parent.y + config.nodeHeight;
  const endY = child.y;
  const channelY = startY + 18 + (index % 3) * 12;
  return {
    id: `parent:${link.from}->${link.to}`,
    kind: "parent",
    status: link.status || "confirmed",
    parentInstanceId: parent.instanceId,
    childInstanceId: child.instanceId,
    parentPersonId: link.from,
    childPersonId: link.to,
    segments: compactSegments([
      { x1: parentX, y1: startY, x2: parentX, y2: channelY },
      { x1: parentX, y1: channelY, x2: childX, y2: channelY },
      { x1: childX, y1: channelY, x2: childX, y2: endY }
    ])
  };
}

function makeSameRowConnector(kind, link, nodes, config, index) {
  const first = nodes.get(link.from);
  const second = nodes.get(link.to);
  const left = first.x <= second.x ? first : second;
  const right = left === first ? second : first;
  const adjacent = Math.abs(right.x - (left.x + config.nodeWidth) - config.coupleGap) < 0.01;
  let segments;
  if (kind === "couple" && adjacent) {
    const y = left.y + config.nodeHeight / 2;
    segments = [{ x1: left.x + config.nodeWidth, y1: y, x2: right.x, y2: y }];
  } else if (kind === "sibling") {
    const leftX = left.x + config.nodeWidth / 2;
    const rightX = right.x + config.nodeWidth / 2;
    const startY = left.y;
    const channelY = Math.max(2, startY - 12 - (index % 2) * 8);
    segments = [
      { x1: leftX, y1: startY, x2: leftX, y2: channelY },
      { x1: leftX, y1: channelY, x2: rightX, y2: channelY },
      { x1: rightX, y1: channelY, x2: rightX, y2: startY }
    ];
  } else {
    const leftX = left.x + config.nodeWidth / 2;
    const rightX = right.x + config.nodeWidth / 2;
    const startY = left.y + config.nodeHeight;
    const channelY = startY + 16 + (index % 3) * 12;
    segments = [
      { x1: leftX, y1: startY, x2: leftX, y2: channelY },
      { x1: leftX, y1: channelY, x2: rightX, y2: channelY },
      { x1: rightX, y1: channelY, x2: rightX, y2: startY }
    ];
  }
  return {
    id: `${kind}:${[link.from, link.to].sort().join("+")}`,
    kind,
    status: link.status || "confirmed",
    fromInstanceId: first.instanceId,
    toInstanceId: second.instanceId,
    fromPersonId: link.from,
    toPersonId: link.to,
    segments: compactSegments(segments)
  };
}

function sharedParentPairs(parentLinks) {
  const childrenByParent = new Map();
  for (const link of parentLinks) {
    if (!childrenByParent.has(link.from)) childrenByParent.set(link.from, []);
    childrenByParent.get(link.from).push(link.to);
  }
  const pairs = new Set();
  for (const children of childrenByParent.values()) for (let index = 0; index < children.length; index += 1) {
    for (let other = index + 1; other < children.length; other += 1) {
      pairs.add(pairKey(children[index], children[other]));
    }
  }
  return pairs;
}

function pairConnected(first, second, links) {
  return links.some((link) => pairKey(link.from, link.to) === pairKey(first, second));
}

function compareDirectedLinks(first, second) {
  return first.from.localeCompare(second.from) || first.to.localeCompare(second.to);
}

function comparePairLinks(first, second) {
  return pairKey(first.from, first.to).localeCompare(pairKey(second.from, second.to));
}

function compactSegments(segments) {
  return segments.filter((segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2);
}

function readConfig(input, view) {
  const options = objectOrEmpty(input.options);
  const value = (name) => [input[name], view[name], options[name], DEFAULT_KINSHIP_LAYOUT[name]]
    .find((entry) => Number.isFinite(entry));
  const config = Object.fromEntries(Object.keys(DEFAULT_KINSHIP_LAYOUT).map((name) => [name, value(name)]));
  config.nodeWidth = value("nodeWidth");
  config.nodeHeight = value("nodeHeight");
  for (const [name, setting] of Object.entries(config)) {
    if (!Number.isFinite(setting) || setting < 0 || (["nodeWidth", "nodeHeight"].includes(name) && setting === 0)) {
      throw new RangeError(`${name} must be a valid finite layout setting`);
    }
  }
  return config;
}

function emptyLayout(config, axis) {
  return { width: 0, height: 0, maxGeneration: 0, config, axis, roots: [], nodes: [], connectors: [] };
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
