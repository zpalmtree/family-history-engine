#!/usr/bin/env node
// The place gazetteer: where on the map each place the viewer names lies.
//
// evidence/places/gazetteer.json is canonical. It is keyed by the place's
// display value exactly as the viewer shows it ("Ellastone, England",
// "Haskins, OH, USA"), the value build-family-data gives each person's place.
// Each entry gives settlement-level coordinates (never a street address),
// the locality it was resolved to, its precision and the basis of the match.
// The viewer's Places chart reads the projection familyData.placeCoordinates,
// which carries only the places tree people use.
//
//   npm run places:gazetteer              report coverage
//   npm run places:gazetteer -- --missing list places without coordinates, with context
//   npm run places:gazetteer -- --check   fail on an invalid entry (missing ones only warn)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const gazetteerPath = path.join(root, "evidence", "places", "gazetteer.json");
export const placePrecisions = new Set(["locality", "county", "state", "region", "country"]);
const confidences = new Set(["high", "medium", "low"]);
// The basemap's region (tools/build-place-basemap.mjs): a place outside it
// would be drawn off the pannable map, so it is almost certainly a bad match.
const REGION = { west: -128, east: 46, south: 14, north: 71 };

export function loadGazetteer(file = gazetteerPath) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, places: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateGazetteer(gazetteer) {
  const issues = [];
  if (gazetteer?.schemaVersion !== 1) issues.push("gazetteer schemaVersion must be 1");
  const places = gazetteer?.places;
  if (!places || typeof places !== "object" || Array.isArray(places)) return [...issues, "gazetteer places must be an object"];
  for (const [value, entry] of Object.entries(places)) {
    const label = `gazetteer place "${value}"`;
    if (value !== value.trim() || !value) issues.push(`${label} key must be a trimmed display value`);
    if (!entry || typeof entry !== "object") { issues.push(`${label} must be an object`); continue; }
    for (const axis of ["lat", "lon"]) {
      if (!Number.isFinite(entry[axis])) issues.push(`${label} ${axis} must be a number`);
      else if (Number(entry[axis].toFixed(4)) !== entry[axis]) issues.push(`${label} ${axis} must have at most 4 decimals`);
    }
    if (Number.isFinite(entry.lat) && Number.isFinite(entry.lon)
      && (entry.lon < REGION.west || entry.lon > REGION.east || entry.lat < REGION.south || entry.lat > REGION.north)) {
      issues.push(`${label} lies outside the map region`);
    }
    if (!placePrecisions.has(entry.precision)) issues.push(`${label} precision must be one of ${[...placePrecisions].join(", ")}`);
    if (typeof entry.name !== "string" || !entry.name.trim()) issues.push(`${label} needs the resolved locality name`);
    if (typeof entry.basis !== "string" || !entry.basis.trim()) issues.push(`${label} needs a basis`);
    if (entry.wikidata !== undefined && !/^Q\d+$/.test(entry.wikidata)) issues.push(`${label} wikidata must be a Q identifier`);
    if (entry.confidence !== undefined && !confidences.has(entry.confidence)) issues.push(`${label} confidence must be high, medium or low`);
  }
  return issues;
}

// The coordinates of every place the given people use, keyed by display value.
export function placeCoordinatesFor(people, gazetteer = loadGazetteer()) {
  const used = new Set(people.flatMap((person) => (person.places || []).map((place) => place.value)));
  const coordinates = {};
  for (const value of [...used].sort()) {
    const entry = gazetteer.places?.[value];
    if (!entry) continue;
    coordinates[value] = { lat: entry.lat, lon: entry.lon, precision: entry.precision };
  }
  return coordinates;
}

export function missingPlaces(people, gazetteer = loadGazetteer()) {
  const byValue = new Map();
  for (const person of people) {
    for (const place of person.places || []) {
      if (gazetteer.places?.[place.value]) continue;
      if (!byValue.has(place.value)) byValue.set(place.value, { value: place.value, people: [], roles: new Set() });
      const entry = byValue.get(place.value);
      if (!entry.people.includes(person.id)) entry.people.push(person.id);
      entry.roles.add(place.role);
    }
  }
  return [...byValue.values()].map((entry) => ({ ...entry, roles: [...entry.roles] })).sort((a, b) => a.value.localeCompare(b.value));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Read the generated people directly: build-family-data imports this module.
  const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));
  const visual = new Set(readJson("data", "family", "tree.json").visualTree.nodes.map((node) => node.id));
  const people = readJson("data", "family", "people.json").people.filter((person) => visual.has(person.id));
  const gazetteer = loadGazetteer();
  const issues = validateGazetteer(gazetteer);
  const missing = missingPlaces(people, gazetteer);
  const used = new Set(people.flatMap((person) => (person.places || []).map((place) => place.value)));
  const unused = Object.keys(gazetteer.places || {}).filter((value) => !used.has(value));
  if (process.argv.includes("--missing")) {
    for (const entry of missing) console.log(`${entry.value}\t${entry.roles.join(",")}\t${entry.people.slice(0, 4).join(", ")}${entry.people.length > 4 ? ` +${entry.people.length - 4}` : ""}`);
  }
  for (const issue of issues) console.error(`ERROR ${issue}`);
  console.log(`place gazetteer: ${used.size - missing.length} of ${used.size} tree places mapped`
    + `${missing.length ? `; ${missing.length} without coordinates (npm run places:gazetteer -- --missing)` : ""}`
    + `${unused.length ? `; ${unused.length} entries no longer used` : ""}`);
  if (issues.length) process.exit(1);
}
