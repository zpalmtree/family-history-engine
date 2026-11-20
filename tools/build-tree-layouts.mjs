import { createHash } from "node:crypto";
import { layoutDetailedPedigree } from "./detailed-pedigree-layout.mjs";
import { layoutPedigree } from "./pedigree-layout.mjs";
import { layoutKinshipLayered } from "./kinship-layout.mjs";

export const treeLayoutSchemaVersion = 5;

export function buildTreeLayouts(familyData) {
  const chart = familyData.visualTree;
  const peopleById = new Map((familyData.people || []).map((person) => [person.id, person]));
  const layouts = {};
  const building = new Set();

  function buildView(viewName) {
    if (layouts[viewName]) return layouts[viewName];
    if (building.has(viewName)) throw new Error(`tree layout views contain a base-view cycle at ${viewName}`);
    const view = chart.views?.[viewName];
    if (!view) throw new Error(`tree layout references missing view ${viewName}`);
    building.add(viewName);
    const specs = view.nodes || chart.nodes || [];
    const visibleIds = specs
      .map((spec) => spec?.id)
      .filter((id) => typeof id === "string" && peopleById.has(id));

    let layout;
    if (view.engine === "pedigree-collateral-overlay") {
      const baseViewName = view.baseView;
      if (typeof baseViewName !== "string" || !baseViewName) {
        throw new Error(`${viewName} must declare a baseView for its collateral overlay`);
      }
      const baseView = chart.views?.[baseViewName];
      const baseLayout = buildView(baseViewName);
      layout = layoutDetailedPedigree({
        people: familyData.people || [],
        links: chart.links || [],
        coupleLinks: chart.coupleLinks || [],
        siblingLinks: chart.siblingLinks || [],
        visibleIds,
        baseVisibleIds: (baseView.nodes || chart.nodes || []).map((spec) => spec?.id),
        baseLayout,
        view: { ...view, id: viewName },
        nodeWidth: chart.nodeWidth,
        nodeHeight: chart.nodeHeight,
        options: chart.layout || {}
      });
    } else {
      const layoutEngine = view.engine === "kinship-layered" ? layoutKinshipLayered : layoutPedigree;
      layout = layoutEngine({
        people: familyData.people || [],
        links: chart.links || [],
        coupleLinks: chart.coupleLinks || [],
        siblingLinks: chart.siblingLinks || [],
        visibleIds,
        view: { ...view, id: viewName },
        nodeWidth: chart.nodeWidth,
        nodeHeight: chart.nodeHeight,
        options: chart.layout || {}
      });
    }
    const { familyConnectors, coupleConnectors, ...artifactLayout } = layout;
    layouts[viewName] = artifactLayout;
    building.delete(viewName);
    return artifactLayout;
  }

  for (const viewName of Object.keys(chart.views || {})) {
    buildView(viewName);
  }

  return {
    schemaVersion: treeLayoutSchemaVersion,
    sourceHash: treeLayoutSourceHash(familyData),
    views: layouts
  };
}

export function treeLayoutSourceHash(familyData) {
  const chart = familyData.visualTree || {};
  const semanticChart = { ...chart };
  delete semanticChart.generatedLayouts;

  const input = {
    people: (familyData.people || []).map((person) => ({
      id: person.id,
      status: person.status
    })),
    visualTree: semanticChart
  };

  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
