(function exposeFamilyTreeLineage(globalObject) {
  "use strict";

  const DEFAULTS = Object.freeze({
    nodeWidth: 180,
    nodeHeight: 132,
    generationGap: 44,
    coupleGap: 6,
    familyBarOffset: 18,
    marginX: 20,
    marginY: 20
  });

  function parseOccurrencePath(instanceId) {
    const value = typeof instanceId === "string" ? instanceId : "";
    if (!value.startsWith("occ:")) return [];
    const encodedParts = value.slice(4).split("/").filter(Boolean);
    try {
      return encodedParts.map((part) => decodeURIComponent(part));
    } catch {
      return [];
    }
  }

  function occurrenceId(path) {
    return `occ:${path.map((part) => encodeURIComponent(part).replaceAll("'", "%27")).join("/")}`;
  }

  function findAncestorPaths({ rootId, targetId, links, limit = 2 }) {
    if (!rootId || !targetId || !Array.isArray(links)) return [];
    const parentsByChild = new Map();
    for (const link of links) {
      if (!link?.from || !link?.to) continue;
      if (!parentsByChild.has(link.to)) parentsByChild.set(link.to, []);
      parentsByChild.get(link.to).push(link.from);
    }
    for (const parents of parentsByChild.values()) parents.sort((first, second) => first.localeCompare(second));

    const paths = [];
    const visit = (personId, trail) => {
      if (paths.length >= limit) return;
      if (personId === targetId) {
        paths.push(trail);
        return;
      }
      for (const parentId of parentsByChild.get(personId) || []) {
        if (trail.includes(parentId)) continue;
        visit(parentId, [...trail, parentId]);
      }
    };
    visit(rootId, [rootId]);
    return paths;
  }

  function buildFocusedLineage(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("buildFocusedLineage requires an input object");
    }
    const path = Array.isArray(input.path) ? [...input.path] : parseOccurrencePath(input.instanceId);
    const links = Array.isArray(input.links) ? input.links : [];
    const coupleLinks = Array.isArray(input.coupleLinks) ? input.coupleLinks : [];
    if (path.length < 2 || path.some((personId) => typeof personId !== "string" || !personId)) {
      throw new Error("a focused lineage requires at least two people");
    }
    if (new Set(path).size !== path.length) throw new Error("a focused lineage cannot contain a cycle");

    const config = readConfig(input);
    const linksByChild = new Map();
    for (const link of links) {
      if (!link?.from || !link?.to) continue;
      if (!linksByChild.has(link.to)) linksByChild.set(link.to, []);
      linksByChild.get(link.to).push(link);
    }
    const couplesByPair = new Map(coupleLinks
      .filter((link) => link?.from && link?.to)
      .map((link) => [pairKey(link.from, link.to), link]));

    const rows = [];
    for (let pathIndex = path.length - 1; pathIndex >= 0; pathIndex -= 1) {
      const personId = path[pathIndex];
      const childId = pathIndex > 0 ? path[pathIndex - 1] : null;
      const directLink = childId
        ? (linksByChild.get(childId) || []).find((link) => link.from === personId)
        : null;
      if (childId && !directLink) {
        throw new Error(`${personId} is not recorded as a parent of ${childId}`);
      }
      const coParentLinks = childId
        ? (linksByChild.get(childId) || []).filter((link) => link.from !== personId)
        : [];
      const parentLinks = childId ? [directLink, ...coParentLinks] : [];
      const orderedIds = childId
        ? orderParentIds(parentLinks, couplesByPair)
        : [personId];
      rows.push({
        pathIndex,
        childId,
        directPersonId: personId,
        personIds: orderedIds,
        links: parentLinks
      });
    }

    const maximumRowSize = Math.max(...rows.map((row) => row.personIds.length));
    const contentWidth = maximumRowSize * config.nodeWidth
      + Math.max(0, maximumRowSize - 1) * config.coupleGap;
    const width = contentWidth + config.marginX * 2;
    const rowStep = config.nodeHeight + config.generationGap;
    const height = rows.length * config.nodeHeight
      + Math.max(0, rows.length - 1) * config.generationGap
      + config.marginY * 2;
    const nodes = [];
    const rowNodes = new Map();

    rows.forEach((row, rowIndex) => {
      const rowWidth = row.personIds.length * config.nodeWidth
        + Math.max(0, row.personIds.length - 1) * config.coupleGap;
      const startX = (width - rowWidth) / 2;
      const y = config.marginY + rowIndex * rowStep;
      const prefix = path.slice(0, row.pathIndex);
      const positioned = row.personIds.map((personId, index) => ({
        personId,
        instanceId: occurrenceId([...prefix, personId]),
        x: startX + index * (config.nodeWidth + config.coupleGap),
        y,
        generation: path.length - 1 - row.pathIndex,
        component: 0,
        lineageRole: personId === row.directPersonId ? "direct" : "co-parent"
      }));
      nodes.push(...positioned);
      rowNodes.set(row.pathIndex, positioned);
    });

    const connectors = [];
    for (let pathIndex = path.length - 1; pathIndex > 0; pathIndex -= 1) {
      const parentRow = rowNodes.get(pathIndex) || [];
      const child = (rowNodes.get(pathIndex - 1) || [])
        .find((node) => node.personId === path[pathIndex - 1]);
      if (!parentRow.length || !child) throw new Error("focused lineage layout is missing a row");
      const childId = child.personId;
      const parentLinks = new Map((linksByChild.get(childId) || []).map((link) => [link.from, link]));
      const parents = parentRow.map((node) => ({ node, link: parentLinks.get(node.personId) }));
      const parentCenters = parents.map(({ node }) => node.x + config.nodeWidth / 2);
      const childCenter = child.x + config.nodeWidth / 2;
      const parentBottom = parentRow[0].y + config.nodeHeight;
      let segments;
      if (parents.length === 1) {
        segments = [verticalSegment(childCenter, parentBottom, child.y)];
      } else {
        const familyBarY = parentBottom + config.familyBarOffset;
        segments = [
          ...parentCenters.map((x) => verticalSegment(x, parentBottom, familyBarY)),
          horizontalSegment(Math.min(...parentCenters), familyBarY, Math.max(...parentCenters)),
          verticalSegment(childCenter, familyBarY, child.y)
        ];
      }
      const statuses = parents.map(({ link }) => link?.status || "unresolved");
      connectors.push({
        id: `lineage-family:${child.instanceId}`,
        kind: "family",
        status: weakestStatus(statuses),
        childInstanceId: child.instanceId,
        childPersonId: child.personId,
        parentInstanceIds: parents.map(({ node }) => node.instanceId),
        parentPersonIds: parents.map(({ node }) => node.personId),
        parentStatuses: statuses,
        segments
      });
    }

    const directInstanceIds = path.map((personId, pathIndex) => occurrenceId([...path.slice(0, pathIndex), personId]));
    const coParentIds = nodes.filter((node) => node.lineageRole === "co-parent").map((node) => node.personId);
    return {
      width,
      height,
      maxGeneration: path.length - 1,
      config: { ...config },
      axis: [],
      roots: [directInstanceIds.at(-1)],
      nodes,
      connectors,
      familyConnectors: connectors,
      coupleConnectors: [],
      lineage: {
        rootId: path[0],
        targetId: path.at(-1),
        path,
        directInstanceIds,
        coParentIds
      },
      labelGutter: 0,
      stagePaddingRight: 0,
      stagePaddingBottom: 0
    };
  }

  function readConfig(input) {
    const config = {};
    for (const key of Object.keys(DEFAULTS)) {
      const value = Number.isFinite(input[key]) ? input[key] : DEFAULTS[key];
      if (value < 0 || ((key === "nodeWidth" || key === "nodeHeight") && value === 0)) {
        throw new RangeError(`${key} must be ${key.startsWith("node") ? "positive" : "nonnegative"}`);
      }
      config[key] = value;
    }
    if (config.familyBarOffset > config.generationGap) {
      throw new RangeError("familyBarOffset cannot exceed generationGap");
    }
    return config;
  }

  function orderParentIds(links, couplesByPair) {
    const ids = [...new Set(links.map((link) => link.from))];
    if (ids.length === 2) {
      const couple = couplesByPair.get(pairKey(ids[0], ids[1]));
      if (couple) return [couple.from, couple.to];
    }
    const roleRank = { father: 0, mother: 1 };
    const roleById = new Map(links.map((link) => [link.from, link.role]));
    return ids.sort((first, second) =>
      (roleRank[roleById.get(first)] ?? 2) - (roleRank[roleById.get(second)] ?? 2)
        || first.localeCompare(second));
  }

  function pairKey(first, second) {
    return [first, second].sort().join("|");
  }

  function verticalSegment(x, y1, y2) {
    return { x1: x, y1, x2: x, y2 };
  }

  function horizontalSegment(x1, y, x2) {
    return { x1, y1: y, x2, y2: y };
  }

  function weakestStatus(statuses) {
    if (statuses.includes("unresolved")) return "unresolved";
    if (statuses.includes("candidate")) return "candidate";
    return statuses[0] || "confirmed";
  }

  globalObject.familyTreeLineage = Object.freeze({
    buildFocusedLineage,
    findAncestorPaths,
    parseOccurrencePath
  });
})(globalThis);
