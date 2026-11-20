#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildFamilyData } from "./build-family-data.mjs";
import { loadTreeLayouts } from "./tree-layout-data.mjs";
import { loadViewerReadings } from "./viewer-readings.mjs";
import { projectViewerRecords } from "./viewer-records.mjs";
import { displayPersonName } from "./person-names.mjs";
import { runtimePackageProjection } from "./runtime-package-projection.mjs";
import { VIEWER_BRANDING_FILE, viewerBrandingFile } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicTree = path.join(root, "public", "tree");
const serverDir = path.join(root, ".viewer-server");
const checkOnly = process.argv.includes("--check");

const familyData = projectFamilyData(buildFamilyData());
const familyTreeLayouts = projectLayouts(loadTreeLayouts());
const recordsManifest = JSON.parse(fs.readFileSync(path.join(root, "evidence", "records-manifest.json"), "utf8"));
const sourceRegistry = JSON.parse(fs.readFileSync(path.join(root, "evidence", "viewer-sources.json"), "utf8"));
const sourceInventory = JSON.parse(fs.readFileSync(path.join(root, "evidence", "source-atoms.json"), "utf8"));
const blobInventory = JSON.parse(fs.readFileSync(path.join(root, "evidence", "viewer-blob-inventory.json"), "utf8"));
// The shape of each exhibit image comes from its published thumbnail, so the page
// can lay it out before the picture arrives.
const deliveryByRecordId = new Map((blobInventory.records || []).map((item) => [item.id, item]));
for (const exhibit of familyData.exhibits || []) {
  const variant = deliveryByRecordId.get(exhibit.image?.recordId)?.thumbnail
    || deliveryByRecordId.get(exhibit.image?.recordId)?.preview;
  if (variant?.width > 0 && variant?.height > 0) exhibit.image.aspect = Math.round((variant.width / variant.height) * 1000) / 1000;
}
const flagDirectory = path.join(root, "assets", "flags");
const flagFiles = fs.readdirSync(flagDirectory)
  .filter((name) => /^[a-z0-9-]+\.svg$/.test(name))
  .sort();
const flagVersion = createHash("sha256");
for (const flag of flagFiles) {
  flagVersion.update(flag);
  flagVersion.update("\0");
  flagVersion.update(fs.readFileSync(path.join(flagDirectory, flag)));
  flagVersion.update("\0");
}
const flagVersionId = flagVersion.digest("hex");
const treeAssetNames = ["tree-lineage.js", "tree-recency.js", "tree-print.js", "tree-charts.js", "tree-places.js", "place-basemap.js"];
const treeAssetVersionIds = Object.fromEntries(treeAssetNames.map((name) => [
  name,
  createHash("sha256").update(fs.readFileSync(path.join(root, "assets", name))).digest("hex")
]));
const { familyRecords, privateRecords } = projectViewerRecords(
  recordsManifest,
  sourceRegistry,
  familyData,
  blobInventory,
  sourceInventory
);
const viewerReadings = loadViewerReadings(root, recordsManifest, familyData);
for (const record of familyRecords.records) {
  if (record.kind !== "document") continue;
  const reading = viewerReadings[record.id];
  record.readingStatus = reading?.status || "needs-review";
  record.highlightStatus = reading?.regions.length ? "reviewed" : "needs-review";
  record.readingsUrl = `/api/records/${encodeURIComponent(record.id)}/readings`;
}
const hostedPayload = `${JSON.stringify({ familyData, familyTreeLayouts, familyRecords }, null, 2)}\n`;
const privateRecordsPayload = `${JSON.stringify(privateRecords, null, 2)}\n`;
const sourceHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const hostedHtml = sourceHtml.replace(
  /\s*<script src="data\/family-data\.js[^>]*><\/script>\s*<script src="data\/tree-layouts\.js[^>]*><\/script>/,
  '\n  <link rel="stylesheet" href="/tree/hosted.css" />\n  <script src="/tree/hosted-loader.js"></script>'
).replaceAll(
  'href="favicon.svg"',
  'href="/tree/favicon.svg"'
).replaceAll(
  'src="assets/flags/',
  'src="/tree/assets/flags/'
).replaceAll(
  'src="assets/tree-lineage.js',
  'src="/tree/assets/tree-lineage.js'
).replaceAll(
  'src="assets/tree-recency.js',
  'src="/tree/assets/tree-recency.js'
).replaceAll(
  'src="assets/tree-print.js',
  'src="/tree/assets/tree-print.js'
).replaceAll(
  'src="assets/tree-charts.js',
  'src="/tree/assets/tree-charts.js'
).replaceAll(
  'src="assets/tree-places.js',
  'src="/tree/assets/tree-places.js'
).replaceAll(
  'src="assets/place-basemap.js',
  'src="/tree/assets/place-basemap.js'
).replaceAll(
  'url("assets/fonts/',
  'url("/tree/assets/fonts/'
).replace(
  /(src="\/tree\/assets\/flags\/[^"?]+\.svg)(?:\?[^" ]*)?"/g,
  `$1?v=${flagVersionId}"`
).replace(
  /(src="\/tree\/assets\/(tree-lineage|tree-recency|tree-print|tree-charts|tree-places|place-basemap)\.js)(?:\?[^" ]*)?"/g,
  (_match, prefix, assetStem) => `${prefix}?v=${treeAssetVersionIds[`${assetStem}.js`]}"`
);
if (hostedHtml === sourceHtml || /data\/(?:family-data|tree-layouts)\.js/.test(hostedHtml)) {
  throw new Error("could not replace local-only data scripts in hosted index");
}

const files = new Map([
  [path.join(publicTree, "index.html"), hostedHtml],
  [path.join(publicTree, "hosted-loader.js"), hostedLoader()],
  [path.join(publicTree, "hosted.css"), hostedCss()],
  [path.join(publicTree, "favicon.svg"), fs.readFileSync(path.join(root, "favicon.svg"))],
  [path.join(serverDir, "family.json"), hostedPayload],
  [path.join(serverDir, "records.json"), privateRecordsPayload],
  [path.join(serverDir, "readings.json"), `${JSON.stringify(viewerReadings)}\n`]
]);
for (const flag of flagFiles) {
  files.set(
    path.join(publicTree, "assets", "flags", flag),
    fs.readFileSync(path.join(flagDirectory, flag))
  );
}
files.set(
  path.join(publicTree, "assets", "tree-lineage.js"),
  fs.readFileSync(path.join(root, "assets", "tree-lineage.js"))
);
files.set(
  path.join(publicTree, "assets", "tree-recency.js"),
  fs.readFileSync(path.join(root, "assets", "tree-recency.js"))
);
files.set(
  path.join(publicTree, "assets", "tree-print.js"),
  fs.readFileSync(path.join(root, "assets", "tree-print.js"))
);
files.set(
  path.join(publicTree, "assets", "tree-charts.js"),
  fs.readFileSync(path.join(root, "assets", "tree-charts.js"))
);
for (const name of ["tree-places.js", "place-basemap.js"]) {
  files.set(path.join(publicTree, "assets", name), fs.readFileSync(path.join(root, "assets", name)));
}
const fontDirectory = path.join(root, "assets", "fonts");
for (const font of fs.readdirSync(fontDirectory).filter((name) => /^[a-z0-9-]+\.(woff2|txt)$/.test(name)).sort()) {
  files.set(path.join(publicTree, "assets", "fonts", font), fs.readFileSync(path.join(fontDirectory, font)));
}
const runtimeFiles = [
  "app/api/family/route.js",
  "app/api/login/route.js",
  "app/api/logout/route.js",
  "app/api/records/[recordId]/route.js",
  "app/api/records/[recordId]/readings/route.js",
  "app/layout.js",
  "app/login/page.js",
  "app/page.js",
  "app/viewer.css",
  "lib/viewer-auth.js",
  "lib/viewer-blob-delivery.js",
  "lib/viewer-branding.js",
  "lib/viewer-password.js",
  "lib/viewer-pdf-annotations.js",
  "middleware.js",
  "next.config.mjs",
  "package-lock.json",
  "package.json",
  "vercel.json"
];
// The server pages' title must match tree.config.json.
if (fs.readFileSync(path.join(root, VIEWER_BRANDING_FILE), "utf8") !== viewerBrandingFile()) {
  throw new Error(`${VIEWER_BRANDING_FILE} does not match tree.config.json; run node tools/tree-config.mjs --write-branding`);
}
const fingerprint = deploymentFingerprint(files, runtimeFiles);
files.set(
  path.join(root, "viewer-deploy-fingerprint.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    sha256: fingerprint,
    stagedFileCount: files.size,
    runtimeFileCount: runtimeFiles.length
  }, null, 2)}\n`
);

if (checkOnly) {
  const problems = [];
  for (const [target, expected] of files) {
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const wanted = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
    if (!current?.equals(wanted)) problems.push(path.relative(root, target));
  }
  const unexpected = listFiles(publicTree)
    .filter((item) => !files.has(item))
    .map((item) => path.relative(root, item));
  if (problems.length || unexpected.length) {
    throw new Error(`hosted viewer staging mismatch; changed: ${problems.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }
  console.log(`hosted viewer staging is current: ${familyData.people.length} people, ${files.size} files`);
} else {
  fs.rmSync(publicTree, { recursive: true, force: true });
  fs.rmSync(serverDir, { recursive: true, force: true });
  for (const [target, contents] of files) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  console.log(`staged protected viewer: ${familyData.people.length} people, ${files.size} files`);
}

// Only the places the projected people show, with nothing but the point and
// its precision (the gazetteer's basis notes stay in the repository).
function projectPlaceCoordinates(coordinates, people) {
  const used = new Set(people.flatMap((person) => person.places.map((place) => place.value)));
  return Object.fromEntries(Object.entries(coordinates).filter(([value]) => used.has(value))
    .map(([value, point]) => [value, { lat: point.lat, lon: point.lon, precision: point.precision }]));
}

function projectFamilyData(source) {
  const visualIds = new Set(source.visualTree.nodes.map((item) => item.id));
  const people = source.people.filter((person) => visualIds.has(person.id)).map((person) => ({
    id: person.id,
    name: displayPersonName(person),
    names: person.names.map((name) => ({
      value: name.value,
      type: name.type,
      ...(name.display ? { display: true } : {}),
      ...(name.from ? { from: name.from } : {}),
      ...(name.to ? { to: name.to } : {}),
      ...(name.associatedPersonId && visualIds.has(name.associatedPersonId)
        ? { associatedPersonId: name.associatedPersonId }
        : {}),
      proof: projectProof(name.proof)
    })),
    status: person.status,
    privacy: person.privacy,
    ...(person.treeAddedAt ? { treeAddedAt: person.treeAddedAt } : {}),
    ...(person.ancestryOrigin ? { ancestryOrigin: person.ancestryOrigin } : {}),
    ...(person.probableOrigin ? { probableOrigin: person.probableOrigin } : {}),
    lifeStatus: person.lifeStatus,
    events: person.events.map((event) => ({ type: event.type, date: event.date, proof: projectProof(event.proof) })),
    ...(person.recordedSpan ? {
      recordedSpan: {
        from: person.recordedSpan.from,
        to: person.recordedSpan.to,
        ...(person.recordedSpan.kind === "pedigree" ? { kind: "pedigree" } : {})
      }
    } : {}),
    ...(person.birthEstimate ? {
      birthEstimate: {
        from: person.birthEstimate.from,
        to: person.birthEstimate.to,
        ...(visualIds.has(person.birthEstimate.nearest?.personId) ? {
          nearest: {
            personId: person.birthEstimate.nearest.personId,
            type: person.birthEstimate.nearest.type,
            date: person.birthEstimate.nearest.date,
            generations: person.birthEstimate.nearest.generations
          }
        } : {})
      }
    } : {}),
    places: person.places.map((place) => ({
      value: place.value,
      country: place.country,
      ...(place.recordedYear ? { recordedYear: place.recordedYear } : {}),
      role: place.role,
      latestResidenceInCountry: place.latestResidenceInCountry,
      proof: projectAggregateProof(place.proof)
    })),
    occupations: [...person.occupations],
    biographyFacts: (person.biographyFacts || []).map((fact) => Object.fromEntries([
      ...["category", "value", "prominence", "dateText", "fromDateText", "toDateText", "place", "fromPlace", "toPlace", "organization", "role", "rank", "employer"]
        .filter((key) => typeof fact[key] === "string" && fact[key]).map((key) => [key, fact[key]]),
      ["proof", projectProof(fact.proof)]
    ])),
    summary: person.summary,
    notes: [...person.notes],
    lifeStory: {
      status: person.lifeStory.status,
      paragraphs: [...person.lifeStory.paragraphs],
      ...(person.lifeStory.full?.length ? { full: [...person.lifeStory.full] } : {})
    },
    factEvidence: projectFactEvidence(person.factEvidence),
    ...(person.exhibits?.length ? { exhibits: person.exhibits.map((entry) => ({
      id: entry.id, ...(entry.note ? { note: entry.note } : {})
    })) } : {}),
    ...(person.distinction ? { distinction: {
      category: person.distinction.category,
      reason: person.distinction.reason,
      ...(person.distinction.rank ? { rank: person.distinction.rank } : {}),
      ...(person.distinction.today ? { today: person.distinction.today } : {})
    } } : {})
  }));
  // Only exhibits that reach someone on the tree are sent.
  const shownExhibitIds = new Set(people.flatMap((person) => (person.exhibits || []).map((entry) => entry.id)));
  const exhibits = (source.exhibits || []).filter((exhibit) => shownExhibitIds.has(exhibit.id)).map((exhibit) => ({
    id: exhibit.id,
    kind: exhibit.kind,
    title: exhibit.title,
    ...(exhibit.caption ? { caption: exhibit.caption } : {}),
    citation: exhibit.citation,
    credit: exhibit.credit,
    licence: exhibit.licence,
    ...(exhibit.sourceUrl ? { sourceUrl: exhibit.sourceUrl } : {}),
    checkedAt: exhibit.checkedAt,
    recordIds: [...exhibit.recordIds],
    ...(exhibit.image ? { image: {
      recordId: exhibit.image.recordId,
      ...(exhibit.image.crop ? { crop: {
        x: exhibit.image.crop.x, y: exhibit.image.crop.y, width: exhibit.image.crop.width, height: exhibit.image.crop.height
      } } : {}),
      ...(exhibit.image.alt ? { alt: exhibit.image.alt } : {}),
      ...(exhibit.image.large ? { large: true } : {})
    } } : {}),
    ...(exhibit.drawing ? { drawing: { svg: exhibit.drawing.svg, basis: exhibit.drawing.basis } } : {}),
    ...(exhibit.text ? { text: exhibit.text } : {})
  }));
  const chart = source.visualTree;
  const projectNode = (node) => ({
    id: node.id,
    ...(Number.isInteger(node.generation) ? { generation: node.generation } : {}),
    ...(typeof node.bloodRelative === "boolean" ? { bloodRelative: node.bloodRelative } : {}),
    ...(node.membershipReasons ? { membershipReasons: [...node.membershipReasons] } : {})
  });
  const projectAxis = (axis) => ({ label: axis.label });
  const projectFocus = (focus) => focus ? {
    ...(focus.personId ? { personId: focus.personId } : {}),
    ...(focus.personIds ? { personIds: [...focus.personIds] } : {}),
    ...(Number.isFinite(focus.scale) ? { scale: focus.scale } : {}),
    ...(focus.fit === true || focus.fit === "all" ? { fit: focus.fit } : {}),
    ...(Number.isFinite(focus.maxScale) ? { maxScale: focus.maxScale } : {}),
    ...(Number.isFinite(focus.anchorX) ? { anchorX: focus.anchorX } : {}),
    ...(Number.isFinite(focus.anchorY) ? { anchorY: focus.anchorY } : {})
  } : undefined;
  const views = Object.fromEntries(Object.entries(chart.views).map(([id, view]) => [id, {
    label: view.label,
    note: view.note,
    ...(view.engine ? { engine: view.engine } : {}),
    ...(view.baseView ? { baseView: view.baseView } : {}),
    ...(view.relationRoot ? { relationRoot: view.relationRoot } : {}),
    ...(view.allowCollateral ? { allowCollateral: true } : {}),
    ...(view.allowDescendants ? { allowDescendants: true } : {}),
    ...(view.width ? { width: view.width } : {}),
    ...(view.height ? { height: view.height } : {}),
    ...(view.defaultFocus ? { defaultFocus: projectFocus(view.defaultFocus) } : {}),
    ...(view.axis ? { axis: view.axis.map(projectAxis) } : {}),
    ...(view.nodes ? { nodes: view.nodes.map(projectNode) } : {})
  }]));
  const profile = source.viewerProfile;
  return {
    schemaVersion: source.schemaVersion,
    ...(profile ? { viewerProfile: {
      title: profile.title,
      shortTitle: profile.shortTitle,
      subtitle: profile.subtitle,
      exportTitle: profile.exportTitle,
      exportSlug: profile.exportSlug,
      roots: profile.roots.map((root) => ({ personId: root.personId, name: root.name, sideLabel: root.sideLabel, ...(root.sideViewId ? { sideViewId: root.sideViewId } : {}) })),
      homePersonIds: [...profile.homePersonIds]
    } } : {}),
    people,
    ...(exhibits.length ? { exhibits } : {}),
    ...(source.placeCoordinates ? { placeCoordinates: projectPlaceCoordinates(source.placeCoordinates, people) } : {}),
    visualTree: {
      width: chart.width,
      height: chart.height,
      nodeWidth: chart.nodeWidth,
      nodeHeight: chart.nodeHeight,
      layout: {
        engine: chart.layout.engine,
        parentOrder: chart.layout.parentOrder,
        generationGap: chart.layout.generationGap,
        nodeGap: chart.layout.nodeGap,
        coupleGap: chart.layout.coupleGap,
        componentGap: chart.layout.componentGap,
        familyBarOffset: chart.layout.familyBarOffset
      },
      labelGutter: chart.labelGutter,
      stagePaddingRight: chart.stagePaddingRight,
      stagePaddingBottom: chart.stagePaddingBottom,
      minScale: chart.minScale,
      directLineRoots: [...chart.directLineRoots],
      axis: chart.axis.map(projectAxis),
      nodes: chart.nodes.map(projectNode),
      links: chart.links.filter((link) => visualIds.has(link.from) && visualIds.has(link.to)).map((link) => ({
        from: link.from, to: link.to, status: link.status, role: link.role, proof: projectProof(link.proof)
      })),
      coupleLinks: chart.coupleLinks.filter((link) => visualIds.has(link.from) && visualIds.has(link.to)).map((link) => ({
        from: link.from,
        to: link.to,
        status: link.status,
        leftRole: link.leftRole,
        rightRole: link.rightRole,
        proof: projectProof(link.proof),
        ...(link.unionStatus ? { unionStatus: link.unionStatus } : {})
      })),
      siblingLinks: chart.siblingLinks.filter((link) => visualIds.has(link.from) && visualIds.has(link.to)).map((link) => ({
        from: link.from,
        to: link.to,
        status: link.status,
        relationshipType: link.relationshipType,
        proof: projectProof(link.proof)
      })),
      views
    }
  };
}

function deploymentFingerprint(stagedFiles, runtimePaths) {
  const hash = createHash("sha256");
  for (const [target, contents] of [...stagedFiles.entries()]
    .sort(([left], [right]) => path.relative(root, left).localeCompare(path.relative(root, right)))) {
    addFingerprintEntry(hash, path.relative(root, target), contents);
  }
  for (const relative of [...runtimePaths].sort()) {
    addFingerprintEntry(hash, relative, runtimeFileContents(relative));
  }
  return hash.digest("hex");
}

// package.json is hashed through a projection rather than whole. Nearly all of
// this repository's ~194 scripts are research tooling that cannot reach the
// build, so hashing the raw file made every tooling commit move the deployment
// fingerprint -- forcing redeploys of a byte-identical viewer and turning a
// forgotten restage into red CI. The projection keeps dependency and runtime
// metadata plus every script transitively reachable from vercel.json's build
// command, so it errs toward extra deploys and never toward skipped ones.
function runtimeFileContents(relative) {
  const raw = fs.readFileSync(path.join(root, relative), "utf8");
  if (relative !== "package.json") return fs.readFileSync(path.join(root, relative));
  return runtimePackageProjection(raw, fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
}

function addFingerprintEntry(hash, name, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
  hash.update(bytes);
}

function projectFactEvidence(value = {}) {
  return {
    identity: projectProof(value.identity),
    displayName: projectProof(value.displayName),
    ...(value.lifeStatus ? { lifeStatus: projectProof(value.lifeStatus) } : {}),
    ...(value.ancestryOrigin ? { ancestryOrigin: projectProof(value.ancestryOrigin) } : {}),
    occupations: (value.occupations || []).map(({ value: label, dateText, ...proof }) => ({ value: label, ...(dateText ? { dateText } : {}), ...projectProof(proof) })),
    ...(value.summary ? { summary: projectBlockProof(value.summary) } : {}),
    notes: (value.notes || []).map(({ text, ...proof }) => ({ text, ...projectBlockProof(proof) }))
  };
}

function projectAggregateProof(value = {}) {
  return {
    assertionIds: [...(value.assertionIds || [])],
    assessment: value.assessment,
    supportClass: value.supportClass,
    viewerSourceIds: [...(value.viewerSourceIds || [])],
    viewerRecordIds: [...(value.viewerRecordIds || [])]
  };
}

function projectProof(value = {}) {
  return {
    assertionId: value.assertionId,
    assessment: value.assessment,
    supportClass: value.supportClass,
    viewerSourceIds: [...(value.viewerSourceIds || [])],
    viewerRecordIds: [...(value.viewerRecordIds || [])]
  };
}

function projectBlockProof(value = {}) {
  return {
    assertionIds: [...(value.assertionIds || [])],
    assessment: value.assessment,
    supportClass: value.supportClass,
    viewerSourceIds: [...(value.viewerSourceIds || [])]
  };
}

function projectLayouts(source) {
  return {
    schemaVersion: source.schemaVersion,
    sourceHash: source.sourceHash,
    views: Object.fromEntries(Object.entries(source.views).map(([id, view]) => [id, {
      width: view.width,
      height: view.height,
      maxGeneration: view.maxGeneration,
      config: Object.fromEntries([
        "generationGap", "nodeGap", "coupleGap", "componentGap", "familyBarOffset",
        "marginX", "marginY", "axisOffset", "maxOccurrences", "nodeWidth", "nodeHeight"
      ].map((key) => [key, view.config[key]])),
      ...(view.core ? { core: { generations: view.core.generations } } : {}),
      axis: view.axis.map((axis) => ({ label: axis.label, generation: axis.generation, y: axis.y })),
      roots: [...view.roots],
      nodes: view.nodes.map((node) => ({
        instanceId: node.instanceId,
        personId: node.personId,
        x: node.x,
        y: node.y,
        generation: node.generation,
        component: node.component
      })),
      connectors: view.connectors.map((connector) => ({
        id: connector.id,
        kind: connector.kind,
        status: connector.status,
        childInstanceId: connector.childInstanceId,
        childPersonId: connector.childPersonId,
        parentInstanceId: connector.parentInstanceId,
        parentPersonId: connector.parentPersonId,
        parentInstanceIds: connector.parentInstanceIds ? [...connector.parentInstanceIds] : undefined,
        parentPersonIds: connector.parentPersonIds ? [...connector.parentPersonIds] : undefined,
        parentStatuses: connector.parentStatuses ? [...connector.parentStatuses] : undefined,
        fromInstanceId: connector.fromInstanceId,
        toInstanceId: connector.toInstanceId,
        fromPersonId: connector.fromPersonId,
        toPersonId: connector.toPersonId,
        ...(connector.style ? { style: connector.style } : {}),
        ...(connector.junction ? { junction: { x: connector.junction.x, y: connector.junction.y } } : {}),
        ...(connector.bough ? { bough: true } : {}),
        segments: connector.segments.map((segment) => ({
          x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2
        }))
      }))
    }]))
  };
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function hostedLoader() {
  return `globalThis.hostedFamilyDataEndpoint = "/api/family";\n`;
}

function hostedCss() {
  return "";
}
