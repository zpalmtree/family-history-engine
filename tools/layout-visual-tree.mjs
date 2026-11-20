#!/usr/bin/env node

import { buildTreeLayouts } from "./build-tree-layouts.mjs";
import { loadFamilyData, writeFamilyData } from "./family-data.mjs";
import { loadTreeLayouts, writeTreeLayouts } from "./tree-layout-data.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const shouldCheck = args.has("--check");

if (!shouldWrite && !shouldCheck) {
  console.error("Usage: node tools/layout-visual-tree.mjs --write|--check");
  process.exit(2);
}

const familyData = loadFamilyData();
const generated = buildTreeLayouts(familyData);

if (shouldCheck) {
  const current = loadTreeLayouts({ optional: true });
  if (!current || JSON.stringify(current) !== JSON.stringify(generated)) {
    console.error("visual tree generated layout is stale; run `npm run tree:layout`");
    process.exit(1);
  }
  console.log(`visual tree generated layout is current (${generated.sourceHash.slice(0, 12)})`);
}

if (shouldWrite) {
  writeTreeLayouts(generated);

  // Generated coordinates used to live inside the semantic data file. Remove
  // them once during migration so future layout runs only touch the artifact.
  if (Object.hasOwn(familyData.visualTree, "generatedLayouts")) {
    delete familyData.visualTree.generatedLayouts;
    writeFamilyData(familyData);
  }

  console.log(`wrote generated visual tree layouts for ${Object.keys(generated.views).length} views`);
}
