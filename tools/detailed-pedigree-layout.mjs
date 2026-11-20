import { isAxisAlignedSegment, pairKey } from "./pedigree-layout.mjs";

const DEFAULT_COLLATERAL_NODE_GAP = 28;
const DEFAULT_COLLATERAL_COUPLE_GAP = 16;
const MAX_COLLATERAL_GENERATION = 3;
const EPSILON = 1e-7;

/**
 * Preserve a direct-line pedigree verbatim and place the detailed view's
 * bounded collateral people into unused intervals around that pedigree.
 */
export function layoutDetailedPedigree(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("layoutDetailedPedigree requires an input object");
  }
  const baseLayout = requireObject(input.baseLayout, "baseLayout");
  const view = requireObject(input.view, "view");
  const config = { ...requireObject(baseLayout.config, "baseLayout.config") };
  const nodeWidth = finite(config.nodeWidth, input.nodeWidth);
  const nodeHeight = finite(config.nodeHeight, input.nodeHeight);
  const generationGap = finite(config.generationGap);
  const marginX = finite(config.marginX, 20);
  const marginY = finite(config.marginY, 20);
  const axisOffset = finite(config.axisOffset, 42);
  if (![nodeWidth, nodeHeight, generationGap, marginX, marginY, axisOffset].every(Number.isFinite)) {
    throw new Error("detailed pedigree requires complete base geometry");
  }

  const specs = normalizeSpecs(view.nodes || []);
  const generationByPerson = new Map(specs.map((spec) => [spec.id, spec.generation]));
  const visibleIds = new Set(generationByPerson.keys());
  const baseVisibleIds = new Set(input.baseVisibleIds || baseLayout.nodes.map((node) => node.personId));
  for (const personId of baseVisibleIds) {
    if (!visibleIds.has(personId)) {
      throw new Error(`detailed pedigree omits base-view person ${personId}`);
    }
  }

  const generationOffset = Number.isInteger(view.baseGenerationOffset)
    ? view.baseGenerationOffset
    : 1;
  if (generationOffset < 0) throw new RangeError("baseGenerationOffset must be non-negative");
  const maxGeneration = baseLayout.maxGeneration + generationOffset;
  const rowStep = nodeHeight + generationGap;
  const baseNodes = structuredClone(baseLayout.nodes).map((node) => ({
    ...node,
    generation: node.generation + generationOffset
  }));

  const baseOccurrenceCounts = countBy(baseNodes, (node) => node.personId);
  for (const node of baseNodes) {
    if (baseOccurrenceCounts.get(node.personId) === 1
      && generationByPerson.get(node.personId) !== node.generation) {
      throw new Error(
        `detailed generation for ${node.personId} must be ${node.generation} to preserve the base pedigree`
      );
    }
  }

  const extraIds = [...visibleIds].filter((personId) => !baseVisibleIds.has(personId)).sort();
  for (const personId of extraIds) {
    const generation = generationByPerson.get(personId);
    if (generation > MAX_COLLATERAL_GENERATION) {
      throw new Error(
        `collateral person ${personId} is generation ${generation}; detailed expansion is limited to 0-${MAX_COLLATERAL_GENERATION}`
      );
    }
  }

  const allNodes = [...baseNodes];
  const nodesByPerson = indexOccurrences(allNodes);
  const pending = new Set(extraIds);
  const parentLinks = visibleLinks(input.links, visibleIds).sort(compareDirectedLinks);
  const coupleLinks = visibleLinks(input.coupleLinks, visibleIds).sort(comparePairLinks);
  const siblingLinks = visibleLinks(input.siblingLinks, visibleIds).sort(comparePairLinks);
  const couplePairs = new Set(coupleLinks.map((link) => pairKey(link.from, link.to)));
  const collateralNodeGap = finite(view.collateralNodeGap, DEFAULT_COLLATERAL_NODE_GAP);
  const collateralCoupleGap = finite(view.collateralCoupleGap, DEFAULT_COLLATERAL_COUPLE_GAP);

  while (pending.size) {
    let progress = false;
    for (const personId of [...pending].sort()) {
      const spec = specs.find((entry) => entry.id === personId);
      const anchor = findAnchor(personId, spec, nodesByPerson, parentLinks, coupleLinks, siblingLinks);
      if (!anchor) continue;
      const generation = generationByPerson.get(personId);
      const y = marginY + (maxGeneration - generation) * rowStep;
      const preferredX = preferredCollateralX({
        personId,
        generation,
        anchor,
        nodesByPerson,
        parentLinks,
        coupleLinks,
        siblingLinks,
        nodeWidth,
        collateralNodeGap,
        collateralCoupleGap
      });
      const x = nearestOpenX({
        personId,
        generation,
        preferredX,
        nodes: allNodes,
        nodeWidth,
        marginX,
        couplePairs,
        nodeGap: collateralNodeGap,
        coupleGap: collateralCoupleGap
      });
      const node = {
        instanceId: `detail:${view.id || "collateral"}:${personId}`,
        personId,
        x,
        y,
        generation,
        component: anchor.component ?? 0
      };
      allNodes.push(node);
      addOccurrence(nodesByPerson, node);
      pending.delete(personId);
      progress = true;
    }
    if (!progress) {
      throw new Error(`collateral people have no displayed relationship anchor: ${[...pending].sort().join(", ")}`);
    }
  }

  allNodes.sort(compareNodes);
  const primaryByPerson = new Map([...nodesByPerson].map(([personId, occurrences]) => [
    personId,
    primaryOccurrence(occurrences)
  ]));
  const displayedSharedParentPairs = sharedParentPairs(parentLinks);
  const overlayParentLinks = parentLinks.filter((link) => extraIds.includes(link.from) || extraIds.includes(link.to));
  const overlayCoupleLinks = coupleLinks.filter((link) => extraIds.includes(link.from) || extraIds.includes(link.to));
  const overlaySiblingLinks = siblingLinks.filter((link) =>
    (extraIds.includes(link.from) || extraIds.includes(link.to))
      && !displayedSharedParentPairs.has(pairKey(link.from, link.to)));
  const overlayConnectors = [
    ...overlayParentLinks.map((link, index) => makeParentConnector(link, primaryByPerson, config, index)),
    ...overlayCoupleLinks.map((link, index) => makeSameRowConnector(
      "couple", link, primaryByPerson, config, index, collateralCoupleGap
    )),
    ...overlaySiblingLinks.map((link, index) => makeSameRowConnector(
      "sibling", link, primaryByPerson, config, index, collateralCoupleGap
    ))
  ].sort((first, second) => first.id.localeCompare(second.id));

  const connectors = [...structuredClone(baseLayout.connectors), ...overlayConnectors];
  const right = Math.max(baseLayout.width - marginX, ...allNodes.map((node) => node.x + nodeWidth));
  const width = right + marginX;
  const height = Math.max(
    baseLayout.height + generationOffset * rowStep,
    marginY * 2 + nodeHeight + maxGeneration * rowStep
  );
  const axis = makeAxis(view.axis || [], maxGeneration, config);
  const result = {
    width,
    height,
    maxGeneration,
    config: {
      ...config,
      collateralNodeGap,
      collateralCoupleGap,
      baseGenerationOffset: generationOffset
    },
    axis,
    roots: structuredClone(baseLayout.roots),
    nodes: allNodes,
    connectors
  };

  const issues = validateDetailedPedigreeLayout(result, {
    baseLayout,
    baseVisibleIds,
    visibleIds,
    extraIds,
    view,
    links: parentLinks,
    coupleLinks,
    siblingLinks
  });
  if (issues.length) {
    throw new Error(`invalid generated detailed pedigree layout:\n- ${issues.join("\n- ")}`);
  }
  return result;
}

export function validateDetailedPedigreeLayout(layout, context = {}) {
  const issues = [];
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const connectors = Array.isArray(layout?.connectors) ? layout.connectors : [];
  const baseLayout = context.baseLayout;
  const nodeWidth = layout?.config?.nodeWidth;
  const nodeHeight = layout?.config?.nodeHeight;
  const generationGap = layout?.config?.generationGap;
  const generationOffset = layout?.config?.baseGenerationOffset ?? 1;
  const nodeByInstance = new Map(nodes.map((node) => [node.instanceId, node]));
  const nodesByPerson = indexOccurrences(nodes);

  if (baseLayout) {
    const baseNodeByInstance = new Map((baseLayout.nodes || []).map((node) => [node.instanceId, node]));
    for (const [instanceId, baseNode] of baseNodeByInstance) {
      const node = nodeByInstance.get(instanceId);
      if (!node) {
        issues.push(`missing base occurrence ${instanceId}`);
        continue;
      }
      for (const field of ["personId", "x", "y", "component"]) {
        if (node[field] !== baseNode[field]) issues.push(`${instanceId} changed base ${field}`);
      }
      if (node.generation !== baseNode.generation + generationOffset) {
        issues.push(`${instanceId} did not shift generation metadata by ${generationOffset}`);
      }
    }
    const connectorById = new Map(connectors.map((connector) => [connector.id, connector]));
    for (const baseConnector of baseLayout.connectors || []) {
      const connector = connectorById.get(baseConnector.id);
      if (!connector) issues.push(`missing base connector ${baseConnector.id}`);
      else if (JSON.stringify(connector) !== JSON.stringify(baseConnector)) {
        issues.push(`${baseConnector.id} changed base connector geometry or metadata`);
      }
    }
  }

  const visibleIds = new Set(context.visibleIds || []);
  const extraIds = new Set(context.extraIds || []);
  for (const personId of visibleIds) {
    if (!nodesByPerson.has(personId)) issues.push(`semantic person ${personId} has no card occurrence`);
  }
  for (const personId of extraIds) {
    const occurrences = nodesByPerson.get(personId) || [];
    if (occurrences.length !== 1) issues.push(`collateral person ${personId} must have exactly one occurrence`);
    if (occurrences.some((node) => node.generation > MAX_COLLATERAL_GENERATION)) {
      issues.push(`collateral person ${personId} exceeds generation ${MAX_COLLATERAL_GENERATION}`);
    }
  }

  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    for (let index = 0; index < nodes.length; index += 1) {
      for (let other = index + 1; other < nodes.length; other += 1) {
        if (rectanglesOverlap(nodes[index], nodes[other], nodeWidth, nodeHeight)) {
          issues.push(`${nodes[index].instanceId} overlaps ${nodes[other].instanceId}`);
        }
      }
    }
  }
  if (Number.isFinite(nodeHeight) && Number.isFinite(generationGap)) {
    const yByGeneration = new Map();
    for (const node of nodes) {
      const prior = yByGeneration.get(node.generation);
      if (prior != null && Math.abs(prior - node.y) > EPSILON) {
        issues.push(`generation ${node.generation} does not have a fixed y coordinate`);
      } else yByGeneration.set(node.generation, node.y);
    }
  }

  const connectorIds = new Set();
  for (const connector of connectors) {
    if (connectorIds.has(connector.id)) issues.push(`duplicate connector id ${connector.id}`);
    connectorIds.add(connector.id);
    if (!Array.isArray(connector.segments) || !connector.segments.length) {
      issues.push(`${connector.id} has no segments`);
      continue;
    }
    for (const segment of connector.segments) {
      if (!isAxisAlignedSegment(segment)) issues.push(`${connector.id} contains a diagonal segment`);
    }
    for (const instanceId of connectorInstances(connector)) {
      if (!nodeByInstance.has(instanceId)) issues.push(`${connector.id} references missing occurrence ${instanceId}`);
    }
  }

  const expectedOverlay = expectedOverlayRelationshipKeys(context, extraIds);
  const renderedOverlay = new Set(connectors
    .filter((connector) => connector.kind !== "family" && connector.id.startsWith("overlay:"))
    .map(connectorRelationshipKey));
  for (const key of expectedOverlay) {
    if (!renderedOverlay.has(key)) issues.push(`missing overlay connector ${key}`);
  }

  return [...new Set(issues)];
}

function normalizeSpecs(rawSpecs) {
  const specs = rawSpecs.map((spec) => typeof spec === "string" ? { id: spec } : spec);
  const seen = new Set();
  for (const spec of specs) {
    if (!spec || typeof spec.id !== "string" || !spec.id) {
      throw new TypeError("detailed view nodes require non-empty person ids");
    }
    if (!Number.isInteger(spec.generation) || spec.generation < 0) {
      throw new Error(`detailed view person ${spec.id} requires a non-negative generation`);
    }
    if (seen.has(spec.id)) throw new Error(`detailed view repeats person ${spec.id}`);
    seen.add(spec.id);
  }
  return specs;
}

function visibleLinks(links, visibleIds) {
  return (Array.isArray(links) ? links : []).filter((link) =>
    visibleIds.has(link.from) && visibleIds.has(link.to));
}

function findAnchor(personId, spec, nodesByPerson, parentLinks, coupleLinks, siblingLinks) {
  const reasonIds = (spec.membershipReasons || [])
    .map((reason) => typeof reason === "string" ? reason.split(":").slice(1).join(":") : "")
    .filter(Boolean);
  for (const anchorId of reasonIds) {
    if (nodesByPerson.has(anchorId)) return primaryOccurrence(nodesByPerson.get(anchorId));
  }
  const neighbors = [];
  for (const link of [...coupleLinks, ...siblingLinks, ...parentLinks]) {
    if (link.from === personId && nodesByPerson.has(link.to)) neighbors.push(link.to);
    if (link.to === personId && nodesByPerson.has(link.from)) neighbors.push(link.from);
  }
  const anchorId = [...new Set(neighbors)].sort()[0];
  return anchorId ? primaryOccurrence(nodesByPerson.get(anchorId)) : null;
}

function preferredCollateralX({
  personId,
  generation,
  anchor,
  nodesByPerson,
  parentLinks,
  coupleLinks,
  siblingLinks,
  nodeWidth,
  collateralNodeGap,
  collateralCoupleGap
}) {
  const couple = coupleLinks.find((link) => link.from === personId || link.to === personId);
  if (couple) {
    const otherId = couple.from === personId ? couple.to : couple.from;
    const other = nodesByPerson.has(otherId) ? primaryOccurrence(nodesByPerson.get(otherId)) : anchor;
    return couple.from === personId
      ? other.x - nodeWidth - collateralCoupleGap
      : other.x + nodeWidth + collateralCoupleGap;
  }
  const parents = parentLinks
    .filter((link) => link.to === personId && nodesByPerson.has(link.from))
    .map((link) => primaryOccurrence(nodesByPerson.get(link.from)));
  if (parents.length) {
    return parents.reduce((sum, node) => sum + node.x + nodeWidth / 2, 0) / parents.length - nodeWidth / 2;
  }
  const children = parentLinks
    .filter((link) => link.from === personId && nodesByPerson.has(link.to))
    .map((link) => primaryOccurrence(nodesByPerson.get(link.to)));
  if (children.length) {
    return children.reduce((sum, node) => sum + node.x + nodeWidth / 2, 0) / children.length - nodeWidth / 2;
  }
  const sibling = siblingLinks.find((link) =>
    (link.from === personId && nodesByPerson.has(link.to))
      || (link.to === personId && nodesByPerson.has(link.from)));
  if (sibling) {
    const otherId = sibling.from === personId ? sibling.to : sibling.from;
    const other = primaryOccurrence(nodesByPerson.get(otherId));
    return other.x + nodeWidth + collateralNodeGap;
  }
  if (anchor.generation === generation) return anchor.x + nodeWidth + collateralNodeGap;
  return anchor.x;
}

function nearestOpenX({
  personId,
  generation,
  preferredX,
  nodes,
  nodeWidth,
  marginX,
  couplePairs,
  nodeGap,
  coupleGap
}) {
  const row = nodes.filter((node) => node.generation === generation);
  const candidates = new Set([Math.max(marginX, preferredX)]);
  for (const node of row) {
    const gap = couplePairs.has(pairKey(personId, node.personId)) ? coupleGap : nodeGap;
    candidates.add(node.x + nodeWidth + gap);
    candidates.add(Math.max(marginX, node.x - nodeWidth - gap));
  }
  const ordered = [...candidates].sort((first, second) =>
    Math.abs(first - preferredX) - Math.abs(second - preferredX)
      || Number(second >= preferredX) - Number(first >= preferredX)
      || first - second);
  for (const candidate of ordered) {
    if (row.every((node) => {
      const gap = couplePairs.has(pairKey(personId, node.personId)) ? coupleGap : nodeGap;
      return candidate + nodeWidth + gap <= node.x + EPSILON
        || candidate >= node.x + nodeWidth + gap - EPSILON;
    })) return candidate;
  }
  const right = Math.max(marginX, ...row.map((node) => node.x + nodeWidth + nodeGap));
  return right;
}

function makeParentConnector(link, nodes, config, index) {
  const parent = nodes.get(link.from);
  const child = nodes.get(link.to);
  const parentX = parent.x + config.nodeWidth / 2;
  const childX = child.x + config.nodeWidth / 2;
  const startY = parent.y + config.nodeHeight;
  const endY = child.y;
  const channelY = startY + 18 + (index % 3) * 8;
  return {
    id: `overlay:parent:${link.from}->${link.to}`,
    kind: "parent",
    status: link.status || "confirmed",
    parentInstanceId: parent.instanceId,
    childInstanceId: child.instanceId,
    parentPersonId: link.from,
    childPersonId: link.to,
    segments: compactSegments([
      segment(parentX, startY, parentX, channelY),
      segment(parentX, channelY, childX, channelY),
      segment(childX, channelY, childX, endY)
    ])
  };
}

function makeSameRowConnector(kind, link, nodes, config, index, coupleGap) {
  const from = nodes.get(link.from);
  const to = nodes.get(link.to);
  const left = from.x <= to.x ? from : to;
  const right = left === from ? to : from;
  const adjacent = Math.abs(right.x - left.x - config.nodeWidth - coupleGap) < 0.01;
  let segments;
  if (kind === "couple" && adjacent) {
    const y = left.y + config.nodeHeight / 2;
    segments = [segment(left.x + config.nodeWidth, y, right.x, y)];
  } else if (kind === "sibling") {
    const leftX = left.x + config.nodeWidth / 2;
    const rightX = right.x + config.nodeWidth / 2;
    const channelY = Math.max(2, left.y - 12 - (index % 2) * 8);
    segments = [
      segment(leftX, left.y, leftX, channelY),
      segment(leftX, channelY, rightX, channelY),
      segment(rightX, channelY, rightX, right.y)
    ];
  } else {
    const leftX = left.x + config.nodeWidth / 2;
    const rightX = right.x + config.nodeWidth / 2;
    const channelY = left.y + config.nodeHeight + 16 + (index % 3) * 8;
    segments = [
      segment(leftX, left.y + config.nodeHeight, leftX, channelY),
      segment(leftX, channelY, rightX, channelY),
      segment(rightX, channelY, rightX, right.y + config.nodeHeight)
    ];
  }
  return {
    id: `overlay:${kind}:${[link.from, link.to].sort().join("+")}`,
    kind,
    status: link.status || "confirmed",
    fromInstanceId: from.instanceId,
    toInstanceId: to.instanceId,
    fromPersonId: link.from,
    toPersonId: link.to,
    segments: compactSegments(segments)
  };
}

function makeAxis(specs, maxGeneration, config) {
  const rowStep = config.nodeHeight + config.generationGap;
  return specs.map((raw, index) => {
    const entry = typeof raw === "string" ? { label: raw } : { ...raw };
    const generation = entry.generation === "max"
      ? maxGeneration
      : Number.isInteger(entry.generation) ? entry.generation : maxGeneration - index;
    if (generation < 0 || generation > maxGeneration) {
      throw new Error(`detailed axis generation ${entry.generation} is outside 0-${maxGeneration}`);
    }
    return {
      ...entry,
      generation,
      y: Math.max(0, config.marginY + (maxGeneration - generation) * rowStep - config.axisOffset)
    };
  });
}

function expectedOverlayRelationshipKeys(context, extraIds) {
  const parentLinks = context.links || [];
  const sharedPairs = sharedParentPairs(parentLinks);
  return new Set([
    ...parentLinks
      .filter((link) => extraIds.has(link.from) || extraIds.has(link.to))
      .map((link) => `parent:${link.from}->${link.to}`),
    ...(context.coupleLinks || [])
      .filter((link) => extraIds.has(link.from) || extraIds.has(link.to))
      .map((link) => `couple:${pairKey(link.from, link.to)}`),
    ...(context.siblingLinks || [])
      .filter((link) => (extraIds.has(link.from) || extraIds.has(link.to))
        && !sharedPairs.has(pairKey(link.from, link.to)))
      .map((link) => `sibling:${pairKey(link.from, link.to)}`)
  ]);
}

function connectorRelationshipKey(connector) {
  if (connector.kind === "parent") {
    return `parent:${connector.parentPersonId}->${connector.childPersonId}`;
  }
  return `${connector.kind}:${pairKey(connector.fromPersonId, connector.toPersonId)}`;
}

function connectorInstances(connector) {
  if (connector.kind === "family") {
    return [connector.childInstanceId, ...(connector.parentInstanceIds || [])].filter(Boolean);
  }
  if (connector.kind === "parent") {
    return [connector.parentInstanceId, connector.childInstanceId].filter(Boolean);
  }
  return [connector.fromInstanceId, connector.toInstanceId].filter(Boolean);
}

function primaryOccurrence(occurrences) {
  return [...occurrences].sort((first, second) =>
    first.generation - second.generation || first.instanceId.localeCompare(second.instanceId))[0];
}

function indexOccurrences(nodes) {
  const result = new Map();
  for (const node of nodes) addOccurrence(result, node);
  return result;
}

function addOccurrence(index, node) {
  if (!index.has(node.personId)) index.set(node.personId, []);
  index.get(node.personId).push(node);
}

function sharedParentPairs(parentLinks) {
  const childrenByParent = new Map();
  for (const link of parentLinks) {
    if (!childrenByParent.has(link.from)) childrenByParent.set(link.from, []);
    childrenByParent.get(link.from).push(link.to);
  }
  const pairs = new Set();
  for (const children of childrenByParent.values()) {
    const sorted = [...new Set(children)].sort();
    for (let index = 0; index < sorted.length; index += 1) {
      for (let other = index + 1; other < sorted.length; other += 1) {
        pairs.add(pairKey(sorted[index], sorted[other]));
      }
    }
  }
  return pairs;
}

function rectanglesOverlap(first, second, width, height) {
  return first.x < second.x + width - EPSILON
    && first.x + width > second.x + EPSILON
    && first.y < second.y + height - EPSILON
    && first.y + height > second.y + EPSILON;
}

function compactSegments(segments) {
  return segments.filter((entry) => entry.x1 !== entry.x2 || entry.y1 !== entry.y2);
}

function segment(x1, y1, x2, y2) {
  return { x1, y1, x2, y2 };
}

function compareNodes(first, second) {
  return first.y - second.y || first.x - second.x || first.instanceId.localeCompare(second.instanceId);
}

function compareDirectedLinks(first, second) {
  return first.from.localeCompare(second.from) || first.to.localeCompare(second.to);
}

function comparePairLinks(first, second) {
  return pairKey(first.from, first.to).localeCompare(pairKey(second.from, second.to));
}

function countBy(values, key) {
  const result = new Map();
  for (const value of values) {
    const entry = key(value);
    result.set(entry, (result.get(entry) || 0) + 1);
  }
  return result;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function finite(...values) {
  return values.find(Number.isFinite);
}

export default layoutDetailedPedigree;
