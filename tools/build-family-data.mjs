#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serializeFamilyData, dataPath } from "./family-data.mjs";
import { displayPersonName } from "./person-names.mjs";
import { loadGazetteer, placeCoordinatesFor } from "./place-gazetteer.mjs";
import { viewerProfile } from "./tree-config.mjs";

const peoplePath = new URL("../data/family/people.json", import.meta.url);
const relationshipsPath = new URL("../data/family/relationships.json", import.meta.url);
const treePath = new URL("../data/family/tree.json", import.meta.url);

export function loadCanonicalSources() {
  return {
    people: readJson(peoplePath),
    relationships: readJson(relationshipsPath),
    tree: readJson(treePath),
    gazetteer: loadGazetteer()
  };
}

export function buildFamilyData(sources = loadCanonicalSources()) {
  const { people, relationships, tree, gazetteer } = sources;
  if (people.schemaVersion !== 5 || relationships.schemaVersion !== 3 || tree.schemaVersion !== 2) {
    throw new Error("unsupported canonical family source schema");
  }
  const visualPersonIds = new Set(tree.visualTree.nodes.map((node) => node.id));
  const links = relationships.parents
    .filter((relationship) =>
      visualPersonIds.has(relationship.parentId) && visualPersonIds.has(relationship.childId)
    )
    .map((relationship) => ({
      from: relationship.parentId,
      to: relationship.childId,
      status: relationship.status,
      role: relationship.role,
      proof: relationship.proof
    }));
  const coupleLinks = relationships.couples
    .filter((relationship) =>
      visualPersonIds.has(relationship.leftPersonId) && visualPersonIds.has(relationship.rightPersonId)
    )
    .map((relationship) => ({
      from: relationship.leftPersonId,
      to: relationship.rightPersonId,
      status: relationship.status,
      leftRole: relationship.leftRole,
      rightRole: relationship.rightRole,
      proof: relationship.proof,
      ...(relationship.unionStatus ? { unionStatus: relationship.unionStatus } : {})
    }));
  const siblingLinks = relationships.siblings
    .filter((relationship) =>
      visualPersonIds.has(relationship.leftPersonId) && visualPersonIds.has(relationship.rightPersonId)
    )
    .map((relationship) => ({
      from: relationship.leftPersonId,
      to: relationship.rightPersonId,
      status: relationship.status,
      relationshipType: relationship.relationshipType,
      proof: relationship.proof
    }));
  const namedPeople = people.people.map((person) => ({
    ...person,
    name: displayPersonName(person)
  }));
  const nameById = new Map(namedPeople.map((person) => [person.id, person.name]));
  return {
    schemaVersion: 6,
    // Title, roots and home people for the viewer, from tree.config.json.
    viewerProfile: {
      ...viewerProfile(undefined, (id) => nameById.get(id)),
      // Flag artwork the engine ships (assets/flags/<code>.svg).
      flagArtwork: fs.readdirSync(new URL("../assets/flags/", import.meta.url)).filter((name) => name.endsWith(".svg")).map((name) => name.slice(0, -4)).sort()
    },
    people: namedPeople,
    ...(people.exhibits?.length ? { exhibits: people.exhibits } : {}),
    ...(gazetteer ? { placeCoordinates: placeCoordinatesFor(people.people.filter((person) => visualPersonIds.has(person.id)), gazetteer) } : {}),
    visualTree: {
      ...tree.visualTree,
      links,
      coupleLinks,
      siblingLinks
    }
  };
}

if (isMainModule()) {
  const requestedMode = process.argv.includes("--write")
    ? "write"
    : process.argv.includes("--check") ? "check" : "print";
  const rendered = serializeFamilyData(buildFamilyData());

  if (requestedMode === "write") {
    fs.writeFileSync(dataPath, rendered);
    console.log("wrote generated browser family data");
  } else if (requestedMode === "check") {
    const current = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, "utf8") : "";
    if (current !== rendered) {
      console.error("data/family-data.js is stale; run npm run data:build");
      process.exit(1);
    }
    console.log("generated browser family data is current");
  } else {
    process.stdout.write(rendered);
  }
}

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}
