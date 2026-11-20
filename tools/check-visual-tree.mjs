#!/usr/bin/env node

import { loadFamilyData } from "./family-data.mjs";
import { loadTreeLayouts } from "./tree-layout-data.mjs";
import { validateDetailedPedigreeLayout } from "./detailed-pedigree-layout.mjs";
import { coupleUnitPartners, requiredCardGap } from "./pedigree-layout.mjs";

const AXIS_EPSILON = 1e-7;
const ALIGNMENT_TOLERANCE = 0.5;
const CARD_CLEARANCE = 4;
let coupleGapSetting = Infinity;
const LONG_OVERLAP = 28;
const MAX_GEOMETRY_ISSUES_PER_VIEW = 24;

const issues = [];
let familyData;
let layouts;

try {
  familyData = loadFamilyData();
} catch (error) {
  fail([`could not load semantic family data: ${error.message}`]);
}

try {
  layouts = loadTreeLayouts();
} catch (error) {
  fail([
    `could not load generated tree layouts: ${error.message}`,
    "run `npm run tree:layout` to generate data/tree-layouts.js"
  ]);
}

const chart = objectOrEmpty(familyData.visualTree);
const people = Array.isArray(familyData.people) ? familyData.people : [];
const peopleById = new Map(people.map((person) => [person?.id, person]));
const semanticViews = objectOrEmpty(chart.views);
const artifactViews = objectOrEmpty(layouts.views);
const semanticParentLinks = Array.isArray(chart.links) ? chart.links : [];
const semanticCoupleLinks = Array.isArray(chart.coupleLinks) ? chart.coupleLinks : [];
const semanticSiblingLinks = Array.isArray(chart.siblingLinks) ? chart.siblingLinks : [];
const parentLinks = new Set(semanticParentLinks.map((link) => directedKey(link?.from, link?.to)));
const parentStatusByLink = new Map(semanticParentLinks.map((link) => [
  directedKey(link?.from, link?.to),
  link?.status
]));
const coupleLinks = new Set(semanticCoupleLinks.map((link) => pairKey(link?.from, link?.to)));
const coupleOrderByPair = new Map(semanticCoupleLinks.map((link) => [
  pairKey(link?.from, link?.to),
  { left: link?.from, right: link?.to }
]));

if (chart.layout?.parentOrder !== "father-left") {
  issues.push("visual tree must declare layout.parentOrder as father-left");
}
for (const [viewName, view] of Object.entries(semanticViews)) {
  if (Array.isArray(view?.layoutFlipCouples) && view.layoutFlipCouples.length) {
    issues.push(`${viewName}: layoutFlipCouples violates the father-left parent-order invariant`);
  }
}

if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) {
  issues.push("generated tree layout artifact must be an object");
}
if (!layouts.sourceHash || typeof layouts.sourceHash !== "string") {
  issues.push("generated tree layout artifact is missing sourceHash");
}
if (!layouts.views || typeof layouts.views !== "object" || Array.isArray(layouts.views)) {
  issues.push("generated tree layout artifact is missing its views object");
}

for (const viewName of Object.keys(semanticViews)) {
  if (!Object.hasOwn(artifactViews, viewName)) {
    issues.push(`${viewName}: generated layout is missing`);
  }
}
for (const viewName of Object.keys(artifactViews)) {
  if (!Object.hasOwn(semanticViews, viewName)) {
    issues.push(`${viewName}: generated layout has no matching semantic view`);
  }
}

let nodeCount = 0;
let connectorCount = 0;
for (const [viewName, semanticView] of Object.entries(semanticViews)) {
  const layout = artifactViews[viewName];
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    continue;
  }
  const counts = checkView(viewName, semanticView, layout);
  nodeCount += counts.nodeCount;
  connectorCount += counts.connectorCount;
}

if (issues.length) {
  fail(issues);
}

console.log(
  `visual tree ok: ${Object.keys(artifactViews).length} views, `
    + `${nodeCount} card occurrences, ${connectorCount} connectors`
);

function checkView(viewName, semanticView, layout) {
  if (semanticView.engine === "pedigree-collateral-overlay") {
    return checkDetailedPedigreeView(viewName, semanticView, layout);
  }
  if (semanticView.engine === "kinship-layered") {
    return checkKinshipView(viewName, semanticView, layout);
  }
  const nodes = Array.isArray(layout.nodes) ? layout.nodes : [];
  const connectors = Array.isArray(layout.connectors) ? layout.connectors : [];
  if (!Array.isArray(layout.nodes)) {
    issues.push(`${viewName}: nodes must be an array`);
  }
  if (!Array.isArray(layout.connectors)) {
    issues.push(`${viewName}: connectors must be an array`);
  }

  const config = objectOrEmpty(layout.config);
  const nodeWidth = finiteSetting(config.nodeWidth, chart.nodeWidth);
  const nodeHeight = finiteSetting(config.nodeHeight, chart.nodeHeight);
  const nodeGap = finiteSetting(config.nodeGap, chart.layout?.nodeGap, 18);
  const generationGap = finiteSetting(config.generationGap, chart.layout?.generationGap, 44);
  const width = layout.width;
  const height = layout.height;

  requirePositiveFinite(viewName, "node width", nodeWidth);
  requirePositiveFinite(viewName, "node height", nodeHeight);
  requirePositiveFinite(viewName, "layout width", width);
  requirePositiveFinite(viewName, "layout height", height);
  if (Number.isFinite(config.nodeWidth) && Number.isFinite(chart.nodeWidth)
    && !nearlyEqual(config.nodeWidth, chart.nodeWidth, ALIGNMENT_TOLERANCE)) {
    issues.push(`${viewName}: generated node width does not match the rendered card width`);
  }
  if (Number.isFinite(config.nodeHeight) && Number.isFinite(chart.nodeHeight)
    && !nearlyEqual(config.nodeHeight, chart.nodeHeight, ALIGNMENT_TOLERANCE)) {
    issues.push(`${viewName}: generated node height does not match the rendered card height`);
  }

  const visibleIds = semanticVisibleIds(semanticView);
  const byInstance = new Map();
  const instancesByPerson = new Map();

  nodes.forEach((node, index) => {
    const label = `${viewName}: node ${index}`;
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      issues.push(`${label} must be an object`);
      return;
    }
    const instanceId = node.instanceId;
    const personId = node.personId;
    if (typeof instanceId !== "string" || !instanceId) {
      issues.push(`${label} requires a non-empty instanceId`);
    } else if (byInstance.has(instanceId)) {
      issues.push(`${viewName}: duplicate instanceId ${instanceId}`);
    } else {
      byInstance.set(instanceId, node);
    }
    if (typeof personId !== "string" || !peopleById.has(personId)) {
      issues.push(`${viewName}: ${instanceId || `node ${index}`} references missing person ${String(personId)}`);
    } else {
      if (!visibleIds.has(personId)) {
        issues.push(`${viewName}: ${instanceId || `node ${index}`} contains ${personId}, which is not in the semantic view`);
      }
      if (!instancesByPerson.has(personId)) {
        instancesByPerson.set(personId, []);
      }
      instancesByPerson.get(personId).push(node);
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      issues.push(`${viewName}: ${instanceId || `node ${index}`} has non-finite x/y coordinates`);
    }
    if (!Number.isInteger(node.generation) || node.generation < 0) {
      issues.push(`${viewName}: ${instanceId || `node ${index}`} has invalid generation ${String(node.generation)}`);
    }
    if (Number.isFinite(node.x) && Number.isFinite(node.y)
      && Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)
      && Number.isFinite(width) && Number.isFinite(height)) {
      if (node.x < -ALIGNMENT_TOLERANCE || node.y < -ALIGNMENT_TOLERANCE
        || node.x + nodeWidth > width + ALIGNMENT_TOLERANCE
        || node.y + nodeHeight > height + ALIGNMENT_TOLERANCE) {
        issues.push(`${viewName}: ${instanceId || `node ${index}`} falls outside the declared layout bounds`);
      }
    }
  });

  for (const personId of visibleIds) {
    if (!instancesByPerson.has(personId)) {
      issues.push(`${viewName}: semantic person ${personId} has no generated card occurrence`);
    }
  }

  coupleGapSetting = finiteSetting(config.coupleGap, chart.layout?.coupleGap, nodeGap);
  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    checkCardSpacing(viewName, nodes, nodeWidth, nodeHeight, nodeGap, coupleGapSetting,
      coupleUnitPartners(connectors));
    checkGenerationRows(viewName, nodes, nodeHeight, generationGap, checkFamilyCore(viewName, semanticView, layout));
  }

  const connectorIds = new Set();
  const segmentRecords = [];
  const familyConnectorCountByChild = new Map();
  const renderedCouplePairs = new Set();
  connectors.forEach((connector, index) => {
    const label = `${viewName}: connector ${index}`;
    if (!connector || typeof connector !== "object" || Array.isArray(connector)) {
      issues.push(`${label} must be an object`);
      return;
    }
    if (typeof connector.id !== "string" || !connector.id) {
      issues.push(`${label} requires a non-empty id`);
    } else if (connectorIds.has(connector.id)) {
      issues.push(`${viewName}: duplicate connector id ${connector.id}`);
    } else {
      connectorIds.add(connector.id);
    }
    if (!Array.isArray(connector.segments) || connector.segments.length === 0) {
      issues.push(`${viewName}: ${connector.id || `connector ${index}`} has no segments`);
      return;
    }

    const participantResult = resolveConnectorParticipants(
      connector,
      byInstance,
      instancesByPerson,
      peopleById
    );
    for (const token of participantResult.unknown) {
      issues.push(`${viewName}: ${connector.id || `connector ${index}`} references unknown participant ${token}`);
    }

    connector.segments.forEach((segment, segmentIndex) => {
      const segmentLabel = `${viewName}: ${connector.id || `connector ${index}`} segment ${segmentIndex}`;
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
        issues.push(`${segmentLabel} must be an object`);
        return;
      }
      const coordinates = [segment.x1, segment.y1, segment.x2, segment.y2];
      if (!coordinates.every(Number.isFinite)) {
        issues.push(`${segmentLabel} has non-finite coordinates`);
        return;
      }
      const horizontal = nearlyEqual(segment.y1, segment.y2, AXIS_EPSILON);
      const vertical = nearlyEqual(segment.x1, segment.x2, AXIS_EPSILON);
      if (!horizontal && !vertical) {
        issues.push(`${segmentLabel} is diagonal`);
        return;
      }
      if (horizontal && vertical) {
        issues.push(`${segmentLabel} has zero length`);
        return;
      }
      if (Number.isFinite(width) && Number.isFinite(height)
        && (Math.min(segment.x1, segment.x2) < -ALIGNMENT_TOLERANCE
          || Math.max(segment.x1, segment.x2) > width + ALIGNMENT_TOLERANCE
          || Math.min(segment.y1, segment.y2) < -ALIGNMENT_TOLERANCE
          || Math.max(segment.y1, segment.y2) > height + ALIGNMENT_TOLERANCE)) {
        issues.push(`${segmentLabel} falls outside the declared layout bounds`);
      }
      segmentRecords.push({
        ...segment,
        horizontal,
        vertical,
        connector,
        connectorId: connector.id || `connector ${index}`,
        participantInstances: participantResult.instances
      });
    });

    if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
      checkCoupleOrder(viewName, connector, byInstance);
      if (connector.kind === "family") {
        const roles = checkFamilyConnector({
          viewName,
          connector,
          byInstance,
          instancesByPerson,
          nodeWidth,
          nodeHeight
        });
        if (roles) {
          familyConnectorCountByChild.set(
            roles.childInstanceId,
            (familyConnectorCountByChild.get(roles.childInstanceId) || 0) + 1
          );
        }
      } else if (connector.kind === "couple") {
        const references = checkCoupleConnector({
          viewName,
          connector,
          byInstance,
          instancesByPerson
        });
        if (references) {
          renderedCouplePairs.add(pairKey(references[0], references[1]));
        }
      } else {
        issues.push(`${viewName}: ${connector.id || `connector ${index}`} has unsupported kind ${String(connector.kind)}`);
      }
    }
  });

  checkConnectorCompleteness({
    viewName,
    nodes,
    visibleIds,
    instancesByPerson,
    familyConnectorCountByChild,
    renderedCouplePairs
  });

  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    checkConnectorClearance(viewName, segmentRecords, nodes, nodeWidth, nodeHeight);
    checkConnectorIntersections(viewName, segmentRecords);
  }

  return { nodeCount: nodes.length, connectorCount: connectors.length };
}

function checkDetailedPedigreeView(viewName, semanticView, layout) {
  const baseViewName = semanticView.baseView;
  const baseView = semanticViews[baseViewName];
  const baseLayout = artifactViews[baseViewName];
  if (!baseView || !baseLayout) {
    issues.push(`${viewName}: detailed pedigree base view ${String(baseViewName)} is missing`);
    return { nodeCount: layout.nodes?.length || 0, connectorCount: layout.connectors?.length || 0 };
  }
  const visibleIds = semanticVisibleIds(semanticView);
  const baseVisibleIds = semanticVisibleIds(baseView);
  const extraIds = [...visibleIds].filter((personId) => !baseVisibleIds.has(personId));
  const validationIssues = validateDetailedPedigreeLayout(layout, {
    baseLayout,
    baseVisibleIds,
    visibleIds,
    extraIds,
    view: semanticView,
    links: semanticParentLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to)),
    coupleLinks: semanticCoupleLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to)),
    siblingLinks: semanticSiblingLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to))
  });
  issues.push(...validationIssues.map((issue) => `${viewName}: ${issue}`));
  return {
    nodeCount: Array.isArray(layout.nodes) ? layout.nodes.length : 0,
    connectorCount: Array.isArray(layout.connectors) ? layout.connectors.length : 0
  };
}

function checkKinshipView(viewName, semanticView, layout) {
  const nodes = Array.isArray(layout.nodes) ? layout.nodes : [];
  const connectors = Array.isArray(layout.connectors) ? layout.connectors : [];
  const config = objectOrEmpty(layout.config);
  const nodeWidth = finiteSetting(config.nodeWidth, chart.nodeWidth);
  const nodeHeight = finiteSetting(config.nodeHeight, chart.nodeHeight);
  const nodeGap = finiteSetting(config.nodeGap, chart.layout?.nodeGap, 18);
  const generationGap = finiteSetting(config.generationGap, chart.layout?.generationGap, 44);
  const visibleIds = semanticVisibleIds(semanticView);
  const byInstance = new Map();
  const countByPerson = new Map();

  for (const node of nodes) {
    if (!node?.instanceId || byInstance.has(node.instanceId)) {
      issues.push(`${viewName}: kinship layout has a missing or duplicate instance id`);
      continue;
    }
    byInstance.set(node.instanceId, node);
    if (!visibleIds.has(node.personId)) issues.push(`${viewName}: kinship node ${node.personId} is not in the semantic view`);
    countByPerson.set(node.personId, (countByPerson.get(node.personId) || 0) + 1);
    if (!Number.isInteger(node.generation) || node.generation < 0) {
      issues.push(`${viewName}: ${node.instanceId} has invalid generation`);
    }
  }
  for (const personId of visibleIds) {
    if (countByPerson.get(personId) !== 1) {
      issues.push(`${viewName}: kinship person ${personId} must have exactly one card occurrence`);
    }
  }
  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    checkCardSpacing(viewName, nodes, nodeWidth, nodeHeight, nodeGap,
      finiteSetting(config.coupleGap, chart.layout?.coupleGap, nodeGap));
    checkGenerationRows(viewName, nodes, nodeHeight, generationGap);
  }

  const visibleParentLinks = semanticParentLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to));
  const visibleCoupleLinks = semanticCoupleLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to));
  const visibleSiblingLinks = semanticSiblingLinks.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to));
  const parentKeys = new Map(visibleParentLinks.map((link) => [directedKey(link.from, link.to), link.status]));
  const coupleKeys = new Map(visibleCoupleLinks.map((link) => [pairKey(link.from, link.to), link.status]));
  const siblingKeys = new Map(visibleSiblingLinks.map((link) => [pairKey(link.from, link.to), link.status]));
  const renderedParents = new Set();
  const renderedCouples = new Set();
  const renderedSiblings = new Set();
  const segmentRecords = [];

  for (const connector of connectors) {
    if (!new Set(["parent", "couple", "sibling"]).has(connector?.kind)) {
      issues.push(`${viewName}: ${connector?.id || "connector"} has unsupported kinship kind ${connector?.kind}`);
      continue;
    }
    const instanceIds = connector.kind === "parent"
      ? [connector.parentInstanceId, connector.childInstanceId]
      : [connector.fromInstanceId, connector.toInstanceId];
    const participants = new Set(instanceIds.filter((id) => byInstance.has(id)));
    if (participants.size !== 2) issues.push(`${viewName}: ${connector.id} lacks two kinship participants`);
    const first = byInstance.get(instanceIds[0]);
    const second = byInstance.get(instanceIds[1]);
    if (first && second) {
      const key = connector.kind === "parent"
        ? directedKey(first.personId, second.personId)
        : pairKey(first.personId, second.personId);
      const semantic = connector.kind === "parent" ? parentKeys
        : connector.kind === "couple" ? coupleKeys : siblingKeys;
      if (!semantic.has(key)) issues.push(`${viewName}: ${connector.id} has no matching semantic relationship`);
      else if (semantic.get(key) !== connector.status) issues.push(`${viewName}: ${connector.id} status disagrees with its semantic relationship`);
      if (connector.kind === "parent") renderedParents.add(key);
      if (connector.kind === "couple") renderedCouples.add(key);
      if (connector.kind === "sibling") renderedSiblings.add(key);
    }
    if (!Array.isArray(connector.segments) || !connector.segments.length) {
      issues.push(`${viewName}: ${connector.id} has no segments`);
      continue;
    }
    for (const segment of connector.segments) {
      const values = [segment?.x1, segment?.y1, segment?.x2, segment?.y2];
      if (!values.every(Number.isFinite)) {
        issues.push(`${viewName}: ${connector.id} has non-finite geometry`);
        continue;
      }
      const horizontal = nearlyEqual(segment.y1, segment.y2, AXIS_EPSILON);
      const vertical = nearlyEqual(segment.x1, segment.x2, AXIS_EPSILON);
      if (!horizontal && !vertical) issues.push(`${viewName}: ${connector.id} contains a diagonal segment`);
      segmentRecords.push({ ...segment, horizontal, vertical, connector, connectorId: connector.id, participantInstances: participants });
    }
  }
  for (const key of parentKeys.keys()) if (!renderedParents.has(key)) issues.push(`${viewName}: missing parent connector ${key}`);
  for (const key of coupleKeys.keys()) if (!renderedCouples.has(key)) issues.push(`${viewName}: missing couple connector ${key}`);
  const sharedPairs = sharedDisplayedParentPairs(visibleParentLinks);
  for (const key of siblingKeys.keys()) {
    if (!sharedPairs.has(key) && !renderedSiblings.has(key)) issues.push(`${viewName}: missing sibling connector ${key}`);
  }
  if (Number.isFinite(nodeWidth) && Number.isFinite(nodeHeight)) {
    checkConnectorClearance(viewName, segmentRecords, nodes, nodeWidth, nodeHeight);
  }
  return { nodeCount: nodes.length, connectorCount: connectors.length };
}

function sharedDisplayedParentPairs(links) {
  const childrenByParent = new Map();
  for (const link of links) {
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

function checkCoupleOrder(viewName, connector, byInstance) {
  let personIds;
  let instanceIds;
  if (connector.kind === "family" && connector.parentPersonIds?.length === 2) {
    personIds = connector.parentPersonIds;
    instanceIds = connector.parentInstanceIds;
  } else if (connector.kind === "couple") {
    personIds = [connector.fromPersonId, connector.toPersonId];
    instanceIds = [connector.fromInstanceId, connector.toInstanceId];
  } else {
    return;
  }

  const declared = coupleOrderByPair.get(pairKey(personIds[0], personIds[1]));
  if (!declared) return;
  const leftIndex = personIds.indexOf(declared.left);
  const rightIndex = personIds.indexOf(declared.right);
  const leftNode = byInstance.get(instanceIds[leftIndex]);
  const rightNode = byInstance.get(instanceIds[rightIndex]);
  if (leftNode && rightNode && leftNode.x >= rightNode.x) {
    issues.push(
      `${viewName}: ${declared.left} must be left of ${declared.right} under father-left ordering`
    );
  }
}

function semanticVisibleIds(view) {
  const specs = Array.isArray(view?.nodes)
    ? view.nodes
    : Array.isArray(chart.nodes) ? chart.nodes : [];
  return new Set(specs
    .map((spec) => typeof spec === "string" ? spec : spec?.id)
    .filter((id) => typeof id === "string"));
}

function checkCardSpacing(viewName, nodes, nodeWidth, nodeHeight, nodeGap, coupleGap = nodeGap, unitPartners = null) {
  const validNodes = nodes.filter((node) =>
    node && Number.isFinite(node.x) && Number.isFinite(node.y)
  );
  for (let index = 0; index < validNodes.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < validNodes.length; otherIndex += 1) {
      const first = validNodes[index];
      const second = validNodes[otherIndex];
      if (rectanglesOverlap(first, second, nodeWidth, nodeHeight, AXIS_EPSILON)) {
        issues.push(`${viewName}: ${first.instanceId} overlaps ${second.instanceId}`);
      }
    }
  }

  const rows = groupBy(validNodes, (node) => node.generation);
  for (const [generation, row] of rows) {
    row.sort((first, second) => first.x - second.x);
    for (let index = 1; index < row.length; index += 1) {
      const left = row[index - 1];
      const right = row[index];
      const gap = right.x - (left.x + nodeWidth);
      const requiredGap = requiredCardGap(left, right, {
        isCouple: coupleLinks.has(pairKey(left.personId, right.personId)),
        unitPartners,
        nodeGap,
        coupleGap
      });
      if (gap < requiredGap - ALIGNMENT_TOLERANCE) {
        issues.push(
          `${viewName}: generation ${generation} cards ${left.instanceId} and ${right.instanceId} `
            + `are crowded (${round(gap)}px gap; ${round(requiredGap)}px required)`
        );
      }
    }
  }
}

// A view may pack its root family and the first generations above it into a
// family core (see applyFamilyCore in pedigree-layout.mjs). The layout then
// records the core and the extra height of each zone its links run in.
// Returns that extra height by the generation of the row below the zone.
function checkFamilyCore(viewName, semanticView, layout) {
  const zoneByGeneration = new Map();
  const wanted = semanticView.core;
  const core = layout.core;
  if (wanted == null || wanted === false) {
    if (core != null) {
      issues.push(`${viewName}: generated layout has a family core the view does not ask for`);
    }
    return zoneByGeneration;
  }
  const wantedGenerations = typeof wanted === "number" ? wanted : wanted?.generations;
  if (!core || typeof core !== "object") {
    issues.push(`${viewName}: the view asks for a family core but the generated layout has none`);
    return zoneByGeneration;
  }
  if (!Number.isInteger(core.generations) || core.generations < 1 || core.generations > wantedGenerations) {
    issues.push(`${viewName}: family core covers ${core.generations} generations; the view asks for ${wantedGenerations}`);
    return zoneByGeneration;
  }
  if (Array.isArray(layout.roots) && new Set((layout.nodes || [])
    .filter((node) => layout.roots.includes(node.instanceId)).map((node) => node.component)).size > 1) {
    issues.push(`${viewName}: a family core needs one root family`);
  }
  for (const zone of Array.isArray(core.zones) ? core.zones : []) {
    if (!Number.isInteger(zone?.generation) || zone.generation < 0 || zone.generation > core.generations
      || !Number.isFinite(zone.height) || zone.height <= 0 || zoneByGeneration.has(zone.generation)) {
      issues.push(`${viewName}: family core has an invalid zone ${JSON.stringify(zone)}`);
      continue;
    }
    zoneByGeneration.set(zone.generation, zone.height);
  }
  // A bough is the link from a person in the core's top row to parents
  // above the core: every such link, and no other.
  const generationByInstance = new Map((layout.nodes || []).map((node) => [node.instanceId, node.generation]));
  for (const connector of layout.connectors || []) {
    if (connector?.kind !== "family") {
      continue;
    }
    const leavesCore = generationByInstance.get(connector.childInstanceId) === core.generations;
    if (Boolean(connector.bough) !== leavesCore) {
      issues.push(leavesCore
        ? `${viewName}: ${connector.id} leaves the family core but is not marked as a bough`
        : `${viewName}: ${connector.id} is marked as a bough but does not leave the family core`);
    }
  }
  return zoneByGeneration;
}

function checkGenerationRows(viewName, nodes, nodeHeight, generationGap, zoneByGeneration = new Map()) {
  const yByGeneration = new Map();
  for (const node of nodes) {
    if (!node || !Number.isFinite(node.y) || !Number.isInteger(node.generation)) {
      continue;
    }
    if (!yByGeneration.has(node.generation)) {
      yByGeneration.set(node.generation, node.y);
      continue;
    }
    const expected = yByGeneration.get(node.generation);
    if (!nearlyEqual(node.y, expected, ALIGNMENT_TOLERANCE)) {
      issues.push(
        `${viewName}: generation ${node.generation} is split across y=${round(expected)} `
          + `and y=${round(node.y)}`
      );
    }
  }

  const entries = [...yByGeneration.entries()].sort((first, second) => first[0] - second[0]);
  const rowStep = nodeHeight + generationGap;
  for (let index = 1; index < entries.length; index += 1) {
    const [lowerGeneration, lowerY] = entries[index - 1];
    const [upperGeneration, upperY] = entries[index];
    const generationDelta = upperGeneration - lowerGeneration;
    let zones = 0;
    for (let generation = lowerGeneration; generation < upperGeneration; generation += 1) {
      zones += zoneByGeneration.get(generation) ?? 0;
    }
    const expectedUpperY = lowerY - rowStep * generationDelta - zones;
    if (!nearlyEqual(upperY, expectedUpperY, ALIGNMENT_TOLERANCE)) {
      issues.push(
        `${viewName}: generations ${lowerGeneration} and ${upperGeneration} do not use the fixed `
          + `${round(rowStep)}px row step${zones ? ` plus the family core's ${round(zones)}px zone` : ""}`
      );
    }
  }
}

function checkFamilyConnector({
  viewName,
  connector,
  byInstance,
  instancesByPerson,
  nodeWidth,
  nodeHeight
}) {
  const roles = familyRoles(connector, byInstance, instancesByPerson);
  if (!roles) {
    issues.push(
      `${viewName}: ${connector.id} lacks unambiguous child/parent occurrence metadata`
    );
    return null;
  }
  const child = byInstance.get(roles.childInstanceId);
  const parents = roles.parentInstanceIds.map((id) => byInstance.get(id));
  if (!child || parents.some((parent) => !parent)) {
    issues.push(`${viewName}: ${connector.id} references a missing child or parent occurrence`);
    return null;
  }
  if (parents.length < 1 || parents.length > 2) {
    issues.push(`${viewName}: ${connector.id} must connect one or two parents`);
    return null;
  }
  if (new Set(roles.parentInstanceIds).size !== roles.parentInstanceIds.length
    || roles.parentInstanceIds.includes(roles.childInstanceId)) {
    issues.push(`${viewName}: ${connector.id} repeats an occurrence in its family metadata`);
    return null;
  }
  if (connector.childPersonId && connector.childPersonId !== child.personId) {
    issues.push(`${viewName}: ${connector.id} childPersonId does not match its child occurrence`);
  }
  if (Array.isArray(connector.parentPersonIds)
    && !arraysEqual(connector.parentPersonIds, parents.map((parent) => parent.personId))) {
    issues.push(`${viewName}: ${connector.id} parentPersonIds do not match its parent occurrences`);
  }
  if (!Array.isArray(connector.parentStatuses)
    || connector.parentStatuses.length !== parents.length) {
    issues.push(`${viewName}: ${connector.id} must carry one status for each parent arm`);
  }

  for (const [index, parent] of parents.entries()) {
    if (parent.generation !== child.generation + 1) {
      issues.push(`${viewName}: ${connector.id} parent and child are not in adjacent generations`);
    }
    if (!parentLinks.has(directedKey(parent.personId, child.personId))) {
      issues.push(
        `${viewName}: ${connector.id} has no semantic parent link ${parent.personId}->${child.personId}`
      );
    } else if (connector.parentStatuses?.[index]
      !== parentStatusByLink.get(directedKey(parent.personId, child.personId))) {
      issues.push(
        `${viewName}: ${connector.id} parent-arm status does not match ${parent.personId}->${child.personId}`
      );
    }
  }

  const childCenter = centerX(child, nodeWidth);
  const parentCenters = parents.map((parent) => centerX(parent, nodeWidth));
  const segments = validAxisSegments(connector.segments);
  if (!hasPortSegment(segments, childCenter, child.y, "top")) {
    issues.push(`${viewName}: ${connector.id} has no vertical trunk into the child's top-center port`);
  }

  if (connector.style === "couple-unit") {
    // Couple units: spouses sit side by side, joined at mid-height across
    // the gap between them; one vertical drop from that junction meets a
    // bar that feeds a straight trunk into the child.
    const parentBottom = Math.max(...parents.map((parent) => parent.y + nodeHeight));
    const barY = connector.junction?.y;
    if (!Number.isFinite(barY) || barY <= parentBottom - ALIGNMENT_TOLERANCE || barY >= child.y + ALIGNMENT_TOLERANCE) {
      issues.push(`${viewName}: ${connector.id} family bar is not between the parent and child rows`);
      return roles;
    }
    let junctionX;
    if (parents.length === 1) {
      junctionX = parentCenters[0];
      if (!hasPortSegment(segments, junctionX, parents[0].y + nodeHeight, "bottom")) {
        issues.push(`${viewName}: ${connector.id} has no vertical drop from parent ${parents[0].instanceId}`);
      }
    } else {
      const [left, right] = [...parents].sort((a, b) => a.x - b.x);
      const gap = right.x - (left.x + nodeWidth);
      const armY = left.y + nodeHeight / 2;
      junctionX = left.x + nodeWidth + gap / 2;
      if (gap < -ALIGNMENT_TOLERANCE || gap > coupleGapSetting + ALIGNMENT_TOLERANCE) {
        issues.push(`${viewName}: ${connector.id} parents are not adjacent (${round(gap)}px apart)`);
      }
      for (const [parent, edgeX] of [[left, left.x + nodeWidth], [right, right.x]]) {
        const arm = segments.some((segment) => segment.horizontal
          && nearlyEqual(segment.y1, armY, ALIGNMENT_TOLERANCE)
          && (nearlyEqual(segment.x1, edgeX, ALIGNMENT_TOLERANCE) || nearlyEqual(segment.x2, edgeX, ALIGNMENT_TOLERANCE)));
        if (!arm) issues.push(`${viewName}: ${connector.id} has no arm from parent ${parent.instanceId}`);
      }
      if (!verticalCoverage(segments, junctionX, armY, barY)) {
        issues.push(`${viewName}: ${connector.id} has no drop from the couple junction to the family bar`);
      }
    }
    if (!nearlyEqual(junctionX, connector.junction.x, ALIGNMENT_TOLERANCE)) {
      issues.push(`${viewName}: ${connector.id} junction metadata does not match its parents`);
    }
    if (!nearlyEqual(junctionX, childCenter, ALIGNMENT_TOLERANCE)) {
      const bar = segments.some((segment) => segment.horizontal
        && nearlyEqual(segment.y1, barY, ALIGNMENT_TOLERANCE)
        && Math.min(segment.x1, segment.x2) <= Math.min(junctionX, childCenter) + ALIGNMENT_TOLERANCE
        && Math.max(segment.x1, segment.x2) >= Math.max(junctionX, childCenter) - ALIGNMENT_TOLERANCE);
      if (!bar) issues.push(`${viewName}: ${connector.id} family bar does not reach the child trunk`);
    }
    if (!verticalCoverage(segments, childCenter, barY, child.y)) {
      issues.push(`${viewName}: ${connector.id} family bar does not feed a straight vertical child trunk`);
    }
    return roles;
  }

  const expectedCenter = parentCenters.reduce((sum, x) => sum + x, 0) / parentCenters.length;
  if (!nearlyEqual(childCenter, expectedCenter, ALIGNMENT_TOLERANCE)) {
    issues.push(
      `${viewName}: ${connector.id} child center is ${round(Math.abs(childCenter - expectedCenter))}px `
        + `from its parent anchor`
    );
  }
  for (let index = 0; index < parents.length; index += 1) {
    if (!hasPortSegment(segments, parentCenters[index], parents[index].y + nodeHeight, "bottom")) {
      issues.push(
        `${viewName}: ${connector.id} has no vertical drop from parent ${parents[index].instanceId}`
      );
    }
  }

  if (parents.length === 1) {
    const parentBottom = parents[0].y + nodeHeight;
    if (!verticalCoverage(segments, childCenter, parentBottom, child.y)) {
      issues.push(`${viewName}: ${connector.id} does not provide one straight parent-to-child trunk`);
    }
  } else {
    const left = Math.min(...parentCenters);
    const right = Math.max(...parentCenters);
    const bars = segments.filter((segment) => segment.horizontal
      && Math.min(segment.x1, segment.x2) <= left + ALIGNMENT_TOLERANCE
      && Math.max(segment.x1, segment.x2) >= right - ALIGNMENT_TOLERANCE
      && segment.y1 > Math.max(...parents.map((parent) => parent.y + nodeHeight)) - ALIGNMENT_TOLERANCE
      && segment.y1 < child.y + ALIGNMENT_TOLERANCE);
    if (!bars.length) {
      issues.push(`${viewName}: ${connector.id} has no family bar spanning both parent centers`);
    } else if (!bars.some((bar) => verticalCoverage(segments, childCenter, bar.y1, child.y))) {
      issues.push(`${viewName}: ${connector.id} family bar does not feed a straight vertical child trunk`);
    }
  }
  return roles;
}

function checkCoupleConnector({ viewName, connector, byInstance, instancesByPerson }) {
  const references = coupleRoles(connector, byInstance, instancesByPerson);
  if (!references || references.length !== 2) {
    issues.push(`${viewName}: ${connector.id} lacks two unambiguous couple occurrences`);
    return null;
  }
  const first = byInstance.get(references[0]);
  const second = byInstance.get(references[1]);
  if (!first || !second) {
    issues.push(`${viewName}: ${connector.id} references a missing couple occurrence`);
    return null;
  }
  if (first.generation !== second.generation) {
    issues.push(`${viewName}: ${connector.id} connects a couple across generations`);
  }
  if (!coupleLinks.has(pairKey(first.personId, second.personId))) {
    issues.push(
      `${viewName}: ${connector.id} has no semantic couple link for ${first.personId}+${second.personId}`
    );
  }
  for (const [index, segment] of connector.segments.entries()) {
    if (segment && Number.isFinite(segment.x1) && Number.isFinite(segment.y1)
      && Number.isFinite(segment.x2) && Number.isFinite(segment.y2)
      && !nearlyEqual(segment.y1, segment.y2, AXIS_EPSILON)) {
      issues.push(`${viewName}: ${connector.id} segment ${index} is not horizontal`);
    }
  }
  return references;
}

function checkConnectorCompleteness({
  viewName,
  nodes,
  visibleIds,
  instancesByPerson,
  familyConnectorCountByChild,
  renderedCouplePairs
}) {
  const visibleParentsByChild = new Map();
  const peopleWhoAreParents = new Set();
  for (const link of semanticParentLinks) {
    if (!visibleIds.has(link?.from) || !visibleIds.has(link?.to)) {
      continue;
    }
    peopleWhoAreParents.add(link.from);
    if (!visibleParentsByChild.has(link.to)) {
      visibleParentsByChild.set(link.to, new Set());
    }
    visibleParentsByChild.get(link.to).add(link.from);
  }

  for (const node of nodes) {
    if (!node || typeof node.instanceId !== "string" || typeof node.personId !== "string") {
      continue;
    }
    const expectedParentCount = visibleParentsByChild.get(node.personId)?.size || 0;
    const actualCount = familyConnectorCountByChild.get(node.instanceId) || 0;
    if (expectedParentCount > 0 && actualCount !== 1) {
      issues.push(
        `${viewName}: ${node.instanceId} has ${actualCount} family connectors; exactly one is required`
      );
    } else if (expectedParentCount === 0 && actualCount > 0) {
      issues.push(`${viewName}: ${node.instanceId} has a family connector but no visible semantic parents`);
    }
  }

  const rootPeople = new Set([...visibleIds].filter((personId) => !peopleWhoAreParents.has(personId)));
  for (const couple of semanticCoupleLinks) {
    if (!rootPeople.has(couple?.from) || !rootPeople.has(couple?.to)) {
      continue;
    }
    const fromRoots = (instancesByPerson.get(couple.from) || [])
      .filter((node) => node.generation === 0);
    const toRoots = (instancesByPerson.get(couple.to) || [])
      .filter((node) => node.generation === 0);
    if (fromRoots.length !== 1 || toRoots.length !== 1) {
      continue;
    }
    const key = pairKey(fromRoots[0].instanceId, toRoots[0].instanceId);
    if (!renderedCouplePairs.has(key)) {
      issues.push(
        `${viewName}: root couple ${couple.from}+${couple.to} has no generated couple connector`
      );
    }
  }
}

function checkConnectorClearance(viewName, segments, nodes, nodeWidth, nodeHeight) {
  let count = 0;
  outer: for (const segment of segments) {
    for (const node of nodes) {
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)
        || segment.participantInstances.has(node.instanceId)) {
        continue;
      }
      if (!segmentIntersectsRect(segment, {
        left: node.x - CARD_CLEARANCE,
        right: node.x + nodeWidth + CARD_CLEARANCE,
        top: node.y - CARD_CLEARANCE,
        bottom: node.y + nodeHeight + CARD_CLEARANCE
      })) {
        continue;
      }
      issues.push(
        `${viewName}: connector ${segment.connectorId} crosses or crowds unrelated card ${node.instanceId}`
      );
      count += 1;
      if (count >= MAX_GEOMETRY_ISSUES_PER_VIEW) {
        issues.push(`${viewName}: additional connector/card clearance issues omitted`);
        break outer;
      }
    }
  }
}

function checkConnectorIntersections(viewName, segments) {
  let count = 0;
  for (let index = 0; index < segments.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < segments.length; otherIndex += 1) {
      const first = segments[index];
      const second = segments[otherIndex];
      if (first.connector === second.connector) {
        continue;
      }
      const overlap = collinearOverlap(first, second);
      if (overlap > LONG_OVERLAP - AXIS_EPSILON) {
        issues.push(
          `${viewName}: connectors ${first.connectorId} and ${second.connectorId} overlap for `
            + `${round(overlap)}px`
        );
        count += 1;
      } else {
        const crossing = perpendicularIntersection(first, second);
        if (crossing && !allowedSharedEndpoint(first, second, crossing)) {
          issues.push(
            `${viewName}: connectors ${first.connectorId} and ${second.connectorId} cross at `
              + `${round(crossing.x)},${round(crossing.y)}`
          );
          count += 1;
        }
      }
      if (count >= MAX_GEOMETRY_ISSUES_PER_VIEW) {
        issues.push(`${viewName}: additional connector intersection issues omitted`);
        return;
      }
    }
  }
}

function familyRoles(connector, byInstance, instancesByPerson) {
  const participantObject = objectOrEmpty(connector.participants);
  const childToken = connector.childInstanceId
    ?? participantObject.childInstanceId
    ?? participantObject.child;
  const parentTokens = connector.parentInstanceIds
    ?? participantObject.parentInstanceIds
    ?? participantObject.parents;
  const childId = resolveSingleInstance(childToken, byInstance, instancesByPerson);
  const parentIds = resolveInstanceList(parentTokens, byInstance, instancesByPerson);
  if (childId && parentIds && parentIds.length) {
    return { childInstanceId: childId, parentInstanceIds: parentIds };
  }

  const resolved = resolveConnectorParticipants(
    connector,
    byInstance,
    instancesByPerson,
    peopleById
  ).instances;
  const candidates = [...resolved].map((id) => byInstance.get(id)).filter(Boolean);
  if (candidates.length < 2 || candidates.length > 3) {
    return null;
  }
  const minimumGeneration = Math.min(...candidates.map((node) => node.generation));
  const children = candidates.filter((node) => node.generation === minimumGeneration);
  const parents = candidates.filter((node) => node.generation === minimumGeneration + 1);
  if (children.length !== 1 || parents.length !== candidates.length - 1) {
    return null;
  }
  return {
    childInstanceId: children[0].instanceId,
    parentInstanceIds: parents.map((node) => node.instanceId)
  };
}

function coupleRoles(connector, byInstance, instancesByPerson) {
  const participantObject = objectOrEmpty(connector.participants);
  const tokens = [
    connector.fromInstanceId ?? participantObject.fromInstanceId ?? participantObject.from,
    connector.toInstanceId ?? participantObject.toInstanceId ?? participantObject.to
  ];
  if (tokens.every((token) => token != null)) {
    const ids = tokens.map((token) => resolveSingleInstance(token, byInstance, instancesByPerson));
    if (ids.every(Boolean)) {
      return ids;
    }
  }
  const resolved = [...resolveConnectorParticipants(
    connector,
    byInstance,
    instancesByPerson,
    peopleById
  ).instances];
  return resolved.length === 2 ? resolved : null;
}

function resolveConnectorParticipants(connector, byInstance, instancesByPerson, allPeopleById) {
  const tokens = [];
  collectTokens(connector.participants, tokens);
  collectTokens(connector.childInstanceId, tokens);
  collectTokens(connector.parentInstanceIds, tokens);
  collectTokens(connector.fromInstanceId, tokens);
  collectTokens(connector.toInstanceId, tokens);
  const hasExplicitOccurrenceMetadata = connector.childInstanceId != null
    || connector.parentInstanceIds != null
    || connector.fromInstanceId != null
    || connector.toInstanceId != null;
  if (!hasExplicitOccurrenceMetadata) {
    collectTokens(connector.childPersonId, tokens);
    collectTokens(connector.parentPersonIds, tokens);
    collectTokens(connector.fromPersonId, tokens);
    collectTokens(connector.toPersonId, tokens);
  }

  const instances = new Set();
  const unknown = new Set();
  for (const token of tokens) {
    if (byInstance.has(token)) {
      instances.add(token);
      continue;
    }
    if (!hasExplicitOccurrenceMetadata && instancesByPerson.has(token)) {
      for (const node of instancesByPerson.get(token)) {
        instances.add(node.instanceId);
      }
      continue;
    }
    if (!allPeopleById.has(token)) {
      unknown.add(token);
    }
  }
  return { instances, unknown };
}

function collectTokens(value, target) {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTokens(item, target);
    }
    return;
  }
  if (value && typeof value === "object") {
    if (typeof value.instanceId === "string") {
      target.push(value.instanceId);
      return;
    }
    if (typeof value.personId === "string") {
      target.push(value.personId);
      return;
    }
    for (const item of Object.values(value)) {
      collectTokens(item, target);
    }
  }
}

function resolveSingleInstance(token, byInstance, instancesByPerson) {
  if (token && typeof token === "object") {
    token = token.instanceId ?? token.personId;
  }
  if (typeof token !== "string") {
    return null;
  }
  if (byInstance.has(token)) {
    return token;
  }
  const occurrences = instancesByPerson.get(token) || [];
  return occurrences.length === 1 ? occurrences[0].instanceId : null;
}

function resolveInstanceList(tokens, byInstance, instancesByPerson) {
  if (!Array.isArray(tokens)) {
    return null;
  }
  const resolved = tokens.map((token) => resolveSingleInstance(token, byInstance, instancesByPerson));
  return resolved.every(Boolean) ? resolved : null;
}

function validAxisSegments(segments) {
  if (!Array.isArray(segments)) {
    return [];
  }
  return segments
    .filter((segment) => segment && [segment.x1, segment.y1, segment.x2, segment.y2].every(Number.isFinite))
    .map((segment) => ({
      ...segment,
      horizontal: nearlyEqual(segment.y1, segment.y2, AXIS_EPSILON),
      vertical: nearlyEqual(segment.x1, segment.x2, AXIS_EPSILON)
    }))
    .filter((segment) => segment.horizontal || segment.vertical);
}

function hasPortSegment(segments, x, y, side) {
  return segments.some((segment) => {
    if (!segment.vertical || !nearlyEqual(segment.x1, x, ALIGNMENT_TOLERANCE)) {
      return false;
    }
    const low = Math.min(segment.y1, segment.y2);
    const high = Math.max(segment.y1, segment.y2);
    if (!nearlyEqual(side === "top" ? high : low, y, ALIGNMENT_TOLERANCE)) {
      return false;
    }
    return high - low > AXIS_EPSILON;
  });
}

function verticalCoverage(segments, x, startY, endY) {
  const low = Math.min(startY, endY);
  const high = Math.max(startY, endY);
  const ranges = segments
    .filter((segment) => segment.vertical && nearlyEqual(segment.x1, x, ALIGNMENT_TOLERANCE))
    .map((segment) => [Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)])
    .sort((first, second) => first[0] - second[0]);
  let coveredTo = low;
  for (const [rangeLow, rangeHigh] of ranges) {
    if (rangeHigh < coveredTo - ALIGNMENT_TOLERANCE) {
      continue;
    }
    if (rangeLow > coveredTo + ALIGNMENT_TOLERANCE) {
      return false;
    }
    coveredTo = Math.max(coveredTo, rangeHigh);
    if (coveredTo >= high - ALIGNMENT_TOLERANCE) {
      return true;
    }
  }
  return false;
}

function segmentIntersectsRect(segment, rect) {
  if (segment.horizontal) {
    const xLow = Math.min(segment.x1, segment.x2);
    const xHigh = Math.max(segment.x1, segment.x2);
    return segment.y1 >= rect.top - AXIS_EPSILON
      && segment.y1 <= rect.bottom + AXIS_EPSILON
      && xHigh >= rect.left - AXIS_EPSILON
      && xLow <= rect.right + AXIS_EPSILON;
  }
  const yLow = Math.min(segment.y1, segment.y2);
  const yHigh = Math.max(segment.y1, segment.y2);
  return segment.x1 >= rect.left - AXIS_EPSILON
    && segment.x1 <= rect.right + AXIS_EPSILON
    && yHigh >= rect.top - AXIS_EPSILON
    && yLow <= rect.bottom + AXIS_EPSILON;
}

function collinearOverlap(first, second) {
  if (first.horizontal && second.horizontal
    && nearlyEqual(first.y1, second.y1, AXIS_EPSILON)) {
    return intervalOverlap(first.x1, first.x2, second.x1, second.x2);
  }
  if (first.vertical && second.vertical
    && nearlyEqual(first.x1, second.x1, AXIS_EPSILON)) {
    return intervalOverlap(first.y1, first.y2, second.y1, second.y2);
  }
  return 0;
}

function intervalOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  return Math.max(0,
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd))
      - Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd))
  );
}

function perpendicularIntersection(first, second) {
  if (first.horizontal === second.horizontal) {
    return null;
  }
  const horizontal = first.horizontal ? first : second;
  const vertical = first.vertical ? first : second;
  const x = vertical.x1;
  const y = horizontal.y1;
  if (between(x, horizontal.x1, horizontal.x2)
    && between(y, vertical.y1, vertical.y2)) {
    return { x, y };
  }
  return null;
}

function allowedSharedEndpoint(first, second, point) {
  if (!setsIntersect(first.participantInstances, second.participantInstances)) {
    return false;
  }
  return segmentHasEndpoint(first, point) && segmentHasEndpoint(second, point);
}

function segmentHasEndpoint(segment, point) {
  return (nearlyEqual(segment.x1, point.x, ALIGNMENT_TOLERANCE)
      && nearlyEqual(segment.y1, point.y, ALIGNMENT_TOLERANCE))
    || (nearlyEqual(segment.x2, point.x, ALIGNMENT_TOLERANCE)
      && nearlyEqual(segment.y2, point.y, ALIGNMENT_TOLERANCE));
}

function rectanglesOverlap(first, second, width, height, epsilon) {
  return first.x < second.x + width - epsilon
    && first.x + width > second.x + epsilon
    && first.y < second.y + height - epsilon
    && first.y + height > second.y + epsilon;
}

function groupBy(values, keyFor) {
  const result = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!result.has(key)) {
      result.set(key, []);
    }
    result.get(key).push(value);
  }
  return result;
}

function requirePositiveFinite(viewName, label, value) {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(`${viewName}: ${label} must be a positive finite number`);
  }
}

function finiteSetting(...values) {
  return values.find(Number.isFinite);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function centerX(node, nodeWidth) {
  return node.x + nodeWidth / 2;
}

function directedKey(from, to) {
  return `${String(from)}\u0000${String(to)}`;
}

function pairKey(first, second) {
  return [String(first), String(second)].sort().join("\u0000");
}

function nearlyEqual(first, second, epsilon) {
  return Math.abs(first - second) <= epsilon;
}

function between(value, first, second) {
  return value >= Math.min(first, second) - AXIS_EPSILON
    && value <= Math.max(first, second) + AXIS_EPSILON;
}

function setsIntersect(first, second) {
  for (const value of first) {
    if (second.has(value)) {
      return true;
    }
  }
  return false;
}

function arraysEqual(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function fail(errors) {
  console.error("visual tree validation failed:\n- " + [...new Set(errors)].join("\n- "));
  process.exit(1);
}
