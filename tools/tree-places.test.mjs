import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildFamilyData } from "./build-family-data.mjs";
import { loadGazetteer, missingPlaces, placeCoordinatesFor, validateGazetteer } from "./place-gazetteer.mjs";
import { project as buildProject } from "./build-place-basemap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "assets", "tree-places.js"), "utf8"), sandbox, { filename: "assets/tree-places.js" });
vm.runInNewContext(fs.readFileSync(path.join(root, "assets", "place-basemap.js"), "utf8"), sandbox, { filename: "assets/place-basemap.js" });
const places = sandbox.globalThis.familyTreePlaces;
const basemap = sandbox.globalThis.familyPlaceBasemap;

// Arrays made inside the vm context have another realm's prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));
const at = (value, role, lat, lon, precision = "locality") => ({ value, role, lat, lon, precision });

test("a person is shown where they were born, else baptised, else their first recorded locality", () => {
  assert.equal(places.originPlace({ places: [at("Ohio, USA", "residence", 40, -82, "state"), at("Rose, Italy", "birthplace", 39.4, 16.3)] }).value, "Rose, Italy");
  assert.equal(places.originPlace({ places: [at("Dover, England", "residence", 51.1, 1.3), at("Lyminge, England", "baptism-place", 51.1, 1.1)] }).value, "Lyminge, England");
  assert.equal(places.originPlace({ places: [at("Ohio, USA", "associated", 40, -82, "state"), at("Haskins, OH, USA", "residence", 41.5, -83.7)] }).value, "Haskins, OH, USA");
  assert.equal(places.originPlace({ places: [at("Ohio, USA", "associated", 40, -82, "state")] }).value, "Ohio, USA");
  assert.equal(places.originPlace({ places: [{ value: "Nowhere", role: "birthplace" }] }), null, "a place without coordinates is never chosen");
});

test("places collect each person once in origin mode and at every place in all mode", () => {
  const people = [
    { id: "a", name: "A", places: [at("X", "birthplace", 52, -1), at("Y", "residence", 53, -2), at("Y", "burial-place", 53, -2)] },
    { id: "b", name: "B", places: [at("X", "residence", 52, -1)] }
  ];
  const origin = places.collectPlaces(people, "origin", 100000);
  assert.deepEqual(plain(origin.map((place) => [place.value, place.entries.map((entry) => entry.person.id)])), [["X", ["a", "b"]]]);
  const all = places.collectPlaces(people, "all", 100000);
  assert.deepEqual(plain(all.map((place) => place.value)), ["X", "Y"]);
  assert.deepEqual(plain(all[1].entries[0].roles), ["residence", "burial-place"], "one entry per person per place, with every role");
});

test("clustering is greedy from the busiest place, lets markers touch but not pile up, and depends only on scale", () => {
  const people = [
    { id: "a", name: "A", places: [at("Big", "birthplace", 52.9, -1.8)] },
    { id: "b", name: "B", places: [at("Big", "birthplace", 52.9, -1.8)] },
    { id: "c", name: "C", places: [at("Near", "birthplace", 52.95, -1.82)] },
    { id: "d", name: "D", places: [at("Far", "birthplace", 41.5, -83.7)] }
  ];
  const collected = places.collectPlaces(people, "origin", 100000);
  const far = places.clusterPlaces(collected, 0.05, 0);
  assert.deepEqual(plain(far.map((cluster) => cluster.places.map((place) => place.value))), [["Big", "Near"], ["Far"]]);
  assert.equal(far[0].people.length, 3);
  const close = places.clusterPlaces(collected, 20, 0);
  assert.equal(close.length, 3);
  // Two groups never overlap by more than a fifth of their radii.
  for (const k of [0.03, 0.2, 1, 4]) {
    const groups = places.clusterPlaces(collected, k, 0);
    for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
      const reach = (places.markerRadius(groups[i].people.length) + places.markerRadius(groups[j].people.length)) * 0.8;
      assert.ok(Math.hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y) * k >= reach);
    }
  }
  assert.deepEqual(plain(places.clusterPlaces(collected, 0.05, 0).map((cluster) => cluster.key)), plain(far.map((cluster) => cluster.key)));
});

test("line shares order a group's family colours by count", () => {
  assert.deepEqual(plain(places.lineShares([{ lineColor: "#1" }, { lineColor: "#2" }, { lineColor: "#2" }, {}])),
    [["#2", 2], ["#1", 1], ["var(--line-core)", 1]]);
});

test("the browser and the basemap builder share one projection", () => {
  for (const [lon, lat] of [[-1.83, 52.99], [16.3, 39.4], [-83.7, 41.5]]) {
    const [x1, y1] = places.project(basemap.world, lon, lat);
    const [x2, y2] = buildProject(lon, lat);
    assert.ok(Math.abs(x1 - x2) < 1e-6 && Math.abs(y1 - y2) < 1e-6);
  }
  assert.equal(basemap.projection, "web-mercator");
  assert.ok(basemap.countries.some((country) => country.name === "United Kingdom"));
  assert.ok(basemap.countries.every((country) => /^M-?\d/.test(country.d)), "outlines are path data");
});

test("the canonical gazetteer is valid and covers the tree's places", () => {
  const gazetteer = loadGazetteer();
  assert.deepEqual(validateGazetteer(gazetteer), []);
  const familyData = buildFamilyData();
  const visual = new Set(familyData.visualTree.nodes.map((node) => node.id));
  const people = familyData.people.filter((person) => visual.has(person.id));
  const used = new Set(people.flatMap((person) => person.places.map((place) => place.value)));
  const missing = missingPlaces(people, gazetteer);
  // New research adds places faster than they are mapped: missing ones only
  // stay off the map, but most of the tree must be on it.
  assert.ok(missing.length <= used.size * 0.1, `${missing.length} of ${used.size} places have no coordinates`);
  assert.deepEqual(Object.keys(familyData.placeCoordinates).sort(), Object.keys(placeCoordinatesFor(people, gazetteer)).sort());
  for (const point of Object.values(familyData.placeCoordinates)) assert.deepEqual(Object.keys(point), ["lat", "lon", "precision"]);
});

test("gazetteer validation rejects bad entries", () => {
  const issues = validateGazetteer({ schemaVersion: 1, places: {
    "Ok, England": { lat: 52.1, lon: -1.2, precision: "locality", name: "Ok", basis: "test" },
    "Sydney, Australia": { lat: -33.9, lon: 151.2, precision: "locality", name: "Sydney", basis: "test" },
    "Vague, England": { lat: 52.123456, lon: -1, precision: "parish", name: "", basis: "" }
  } });
  assert.equal(issues.filter((issue) => issue.includes("Ok, England")).length, 0);
  assert.ok(issues.some((issue) => issue.includes("Sydney") && issue.includes("outside")));
  assert.ok(issues.some((issue) => issue.includes("Vague") && issue.includes("decimals")));
  assert.ok(issues.some((issue) => issue.includes("Vague") && issue.includes("precision")));
  assert.ok(issues.some((issue) => issue.includes("Vague") && issue.includes("basis")));
});
