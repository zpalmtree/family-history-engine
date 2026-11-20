#!/usr/bin/env node

import { loadFamilyData } from "./family-data.mjs";
import {
  displayPersonName,
  validateAggregateProofProjection,
  validatePersonNames,
  validateProofProjection
} from "./person-names.mjs";
import { placeCountries, placeRoles, usStateCodes } from "./place-labels.mjs";
import { biographyProminences, lifeFactCategories } from "./biography-schema.mjs";
import { flaglessTreePeople } from "./tree-flags.mjs";
import { runTreeHook } from "./tree-hooks.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const familyData = loadFamilyData();
const issues = [];
const personStatuses = new Set(["candidate", "confirmed", "unresolved"]);
const relationshipStatuses = new Set(["candidate", "confirmed", "unresolved"]);
const privacyLevels = new Set(["private", "public", "restricted"]);
const eventTypes = new Set(["birth", "baptism", "death", "burial", "marriage"]);
const parentRoles = new Set(["father", "mother"]);
const lifeStatuses = new Set(["living", "deceased", "unknown"]);
const ancestryOrigins = placeCountries;

if (familyData.schemaVersion !== 6) {
  issues.push(`unsupported generated schemaVersion: ${familyData.schemaVersion}`);
}
for (const archivedKey of ["subject", "knownFacts", "generations", "timeline", "leads", "sources"]) {
  if (Object.hasOwn(familyData, archivedKey)) {
    issues.push(`generated browser bundle still contains archived ${archivedKey}`);
  }
}

const people = Array.isArray(familyData.people) ? familyData.people : [];
if (!people.length) issues.push("people must be a non-empty array");
const exhibitIds = new Set((familyData.exhibits || []).map((exhibit) => exhibit.id));
for (const person of people) for (const entry of person.exhibits || []) {
  if (!exhibitIds.has(entry.id)) issues.push(`person ${person.id} shows unknown exhibit ${entry.id}`);
}
for (const exhibit of familyData.exhibits || []) {
  if (!people.some((person) => (person.exhibits || []).some((entry) => entry.id === exhibit.id))) {
    issues.push(`exhibit ${exhibit.id} reaches nobody`);
  }
  if (exhibit.drawing && !/^<svg [^>]*>[\s\S]*<\/svg>$/.test(exhibit.drawing.svg || "")) issues.push(`exhibit ${exhibit.id} has an invalid drawing`);
  if (/<script|\son[a-z]+\s*=|javascript:/i.test(exhibit.drawing?.svg || "")) issues.push(`exhibit ${exhibit.id} drawing contains active content`);
}
const peopleById = new Map();
for (const person of people) {
  if (!person?.id || typeof person.id !== "string") {
    issues.push("person is missing a stable id");
    continue;
  }
  if (peopleById.has(person.id)) issues.push(`duplicate person id: ${person.id}`);
  peopleById.set(person.id, person);
  issues.push(...validatePersonNames(person, { personIds: new Set(people.map((item) => item.id)) }));
  if (!displayPersonName(person)) issues.push(`person ${person.id} is missing a display name`);
  if (!personStatuses.has(person.status)) {
    issues.push(`person ${person.id} has invalid status: ${person.status}`);
  }
  if (!privacyLevels.has(person.privacy)) {
    issues.push(`person ${person.id} has invalid privacy: ${person.privacy}`);
  }
  if (person.treeAddedAt !== undefined
    && (typeof person.treeAddedAt !== "string" || !Number.isFinite(Date.parse(person.treeAddedAt)))) {
    issues.push(`person ${person.id} has invalid treeAddedAt timestamp`);
  }
  if (!lifeStatuses.has(person.lifeStatus)) {
    issues.push(`person ${person.id} has invalid lifeStatus: ${person.lifeStatus}`);
  }
  if (person.ancestryOrigin != null && !ancestryOrigins.has(person.ancestryOrigin)) {
    issues.push(`person ${person.id} has invalid ancestryOrigin: ${person.ancestryOrigin}`);
  }
  if (person.probableOrigin != null && !ancestryOrigins.has(person.probableOrigin)) {
    issues.push(`person ${person.id} has invalid probableOrigin: ${person.probableOrigin}`);
  }
  if (person.probableOrigin != null && person.ancestryOrigin != null) {
    issues.push(`person ${person.id} has both an established and a probable origin`);
  }
  for (const field of ["events", "places", "occupations", "notes", "biographyFacts"]) {
    if (!Array.isArray(person[field])) issues.push(`person ${person.id} ${field} must be an array`);
  }
  if (typeof person.summary !== "string") {
    issues.push(`person ${person.id} summary must be a string`);
  }
  if (!person.lifeStory || !new Set(["fresh", "stale", "missing", "invalidated", "refresh-failed", "unavailable"]).has(person.lifeStory.status)
      || !Array.isArray(person.lifeStory.paragraphs)
      || (person.lifeStory.full !== undefined && !(Array.isArray(person.lifeStory.full) && person.lifeStory.full.length
        && person.lifeStory.full.every((text) => typeof text === "string" && text)))) {
    issues.push(`person ${person.id} has invalid lifeStory projection`);
  }
  for (const [index, fact] of (person.biographyFacts || []).entries()) {
    const label = `person ${person.id} biographyFacts[${index}]`;
    if (!lifeFactCategories.has(fact.category)) issues.push(`${label} has invalid category ${fact.category}`);
    if (!biographyProminences.has(fact.prominence)) issues.push(`${label} has invalid prominence ${fact.prominence}`);
    if (!fact.value || typeof fact.value !== "string") issues.push(`${label} requires value`);
    issues.push(...validateProofProjection(fact.proof, `${label} proof`));
  }
  const seenEventTypes = new Set();
  for (const event of person.events || []) {
    if (!eventTypes.has(event?.type)) {
      issues.push(`person ${person.id} has invalid event type: ${event?.type}`);
      continue;
    }
    if (seenEventTypes.has(event.type) && event.type !== "marriage") {
      issues.push(`person ${person.id} has duplicate ${event.type} events`);
    }
    seenEventTypes.add(event.type);
    if (!event.date || typeof event.date !== "string") {
      issues.push(`person ${person.id} ${event.type} event requires a display date`);
    }
    issues.push(...validateProofProjection(event.proof, `person ${person.id} ${event.type} event`));
  }
  if (!person.factEvidence || typeof person.factEvidence !== "object") {
    issues.push(`person ${person.id} is missing factEvidence`);
  } else {
    for (const field of ["identity", "displayName"]) {
      issues.push(...validateProofProjection(person.factEvidence[field], `person ${person.id} ${field}`));
    }
    for (const field of ["occupations"]) {
      if (!Array.isArray(person.factEvidence[field]) || person.factEvidence[field].length !== person[field].length) {
        issues.push(`person ${person.id} ${field} proof count does not match displayed values`);
      } else {
        person.factEvidence[field].forEach((proof, index) => {
          if (proof.value !== person[field][index]) issues.push(`person ${person.id} ${field} proof value is stale`);
          issues.push(...validateProofProjection(proof, `person ${person.id} ${field}[${index}]`));
        });
      }
    }
  }
  validatePlaces(person);
  for (const field of ["occupations", "notes"]) {
    if ((person[field] || []).some((value) => typeof value !== "string" || !value.trim())) {
      issues.push(`person ${person.id} ${field} must contain non-empty strings`);
    }
  }
}

function validatePlaces(person) {
  const seen = new Set();
  const latestResidenceCounts = new Map();
  for (const [index, place] of (person.places || []).entries()) {
    const label = `person ${person.id} places[${index}]`;
    if (!place || typeof place !== "object" || Array.isArray(place)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (typeof place.value !== "string" || !place.value.trim()) issues.push(`${label} requires a value`);
    if (!placeCountries.has(place.country)) issues.push(`${label} has invalid country: ${place.country}`);
    if (!placeRoles.has(place.role)) issues.push(`${label} has invalid role: ${place.role}`);
    if (typeof place.latestResidenceInCountry !== "boolean") issues.push(`${label} requires latestResidenceInCountry`);
    const key = `${place.role}\u0000${place.value.toLocaleLowerCase()}`;
    if (seen.has(key)) issues.push(`person ${person.id} repeats ${place.role} place ${place.value}`);
    seen.add(key);
    if (place.latestResidenceInCountry) {
      if (place.role !== "residence" || place.proof?.assessment !== "established"
        || place.proof?.supportClass === "conflicted") {
        issues.push(`${label} selects a non-established or conflicted residence for the card`);
      }
      latestResidenceCounts.set(place.country, (latestResidenceCounts.get(place.country) || 0) + 1);
    }
    issues.push(...validateAggregateProofProjection(place.proof, `${label} proof`));
    if (/[\/;]|\b(?:avenue|cemetery|county|farm|lead|road|street|township)\b/i.test(place.value)) {
      issues.push(`${label} is not a compact place label: ${place.value}`);
    }
    if (place.country === "United States") {
      const region = place.value.replace(/, USA$/, "");
      const isState = usStateCodes.has(region);
      const isLocality = [...usStateCodes.keys()].some((state) => region.endsWith(`, ${state}`));
      if (place.value !== "USA" && (!place.value.endsWith(", USA") || (!isState && !isLocality))) {
        issues.push(`${label} is not a U.S. locality/state/country label: ${place.value}`);
      }
    } else if (place.value !== place.country && !place.value.endsWith(`, ${place.country}`)) {
      issues.push(`${label} does not end with its country: ${place.value}`);
    }
  }
  const residenceCountries = new Set((person.places || [])
    .filter((place) => place?.role === "residence" && place.proof?.assessment === "established"
      && place.proof?.supportClass !== "conflicted")
    .map((place) => place.country));
  for (const country of residenceCountries) {
    if (latestResidenceCounts.get(country) !== 1) {
      issues.push(`person ${person.id} must have exactly one latest established residence for ${country}`);
    }
  }
}

const chart = familyData.visualTree || {};
if (chart.layout?.parentOrder !== "father-left") {
  issues.push("visualTree.layout.parentOrder must be father-left");
}
const visualIds = new Set();
for (const node of chart.nodes || []) {
  if (!node?.id || !peopleById.has(node.id)) {
    issues.push(`visual node references missing person: ${node?.id || "(missing id)"}`);
    continue;
  }
  if (visualIds.has(node.id)) issues.push(`duplicate visual node id: ${node.id}`);
  visualIds.add(node.id);
  if (Object.keys(node).some((key) => key !== "id")) {
    issues.push(`visual node ${node.id} must only contain its canonical id`);
  }
}

const couplesByPair = new Map();
for (const relationship of chart.coupleLinks || []) {
  checkVisualRelationship(relationship, "couple");
  if (relationship.leftRole !== "father" || relationship.rightRole !== "mother") {
    issues.push(`couple ${relationship.from}->${relationship.to} must declare father-left/mother-right roles`);
  }
  const key = pairKey(relationship.from, relationship.to);
  if (couplesByPair.has(key)) issues.push(`duplicate couple relationship: ${key}`);
  couplesByPair.set(key, relationship);
}
const siblingsByPair = new Map();
for (const relationship of chart.siblingLinks || []) {
  checkVisualRelationship(relationship, "sibling");
  const key = pairKey(relationship.from, relationship.to);
  if (siblingsByPair.has(key)) issues.push(`duplicate sibling relationship: ${key}`);
  siblingsByPair.set(key, relationship);
}
for (const person of people) {
  for (const name of person.names || []) {
    if (name.associatedPersonId && !couplesByPair.has(pairKey(person.id, name.associatedPersonId))) {
      issues.push(`person ${person.id} married name ${name.value} references a person without a couple relationship`);
    }
  }
}

const parentsByChild = new Map();
for (const relationship of chart.links || []) {
  checkVisualRelationship(relationship, "parent");
  if (!parentRoles.has(relationship.role)) {
    issues.push(`parent ${relationship.from}->${relationship.to} has invalid role: ${relationship.role}`);
  }
  if (!parentsByChild.has(relationship.to)) parentsByChild.set(relationship.to, []);
  parentsByChild.get(relationship.to).push(relationship);
}
for (const [childId, parents] of parentsByChild) {
  if (parents.length > 2) {
    issues.push(`${childId} must have no more than two direct-parent records; found ${parents.length}`);
    continue;
  }
  // A source can identify only one parent. Preserve that supported partial
  // relationship instead of inventing an unknown spouse merely to complete a
  // visual pair. Couple/left-right validation applies once both are known.
  if (parents.length === 1) continue;
  const father = parents.find((relationship) => relationship.role === "father");
  const mother = parents.find((relationship) => relationship.role === "mother");
  if (!father || !mother) {
    issues.push(`${childId} must have one father and one mother role`);
    continue;
  }
  const couple = couplesByPair.get(pairKey(father.from, mother.from));
  if (!couple) {
    issues.push(`${childId}'s parents are missing a couple record`);
  } else if (couple.from !== father.from || couple.to !== mother.from) {
    issues.push(`${childId}'s couple record does not put father left and mother right`);
  }
}

const directLineRoots = chart.directLineRoots;
let directLineIds = null;
let directDescendantIds = null;
if (!Array.isArray(directLineRoots) || !directLineRoots.length) {
  issues.push("visualTree.directLineRoots must name at least one displayed starting person");
} else {
  directLineIds = new Set();
  for (const rootId of directLineRoots) {
    if (!visualIds.has(rootId)) issues.push(`direct-line root references missing visual person: ${rootId}`);
    directLineIds.add(rootId);
  }
  let addedParent = true;
  while (addedParent) {
    addedParent = false;
    for (const relationship of chart.links || []) {
      if (directLineIds.has(relationship.to) && !directLineIds.has(relationship.from)) {
        directLineIds.add(relationship.from);
        addedParent = true;
      }
    }
  }
  directDescendantIds = new Set(directLineRoots);
  let addedChild = true;
  while (addedChild) {
    addedChild = false;
    for (const relationship of chart.links || []) {
      if (directDescendantIds.has(relationship.from) && !directDescendantIds.has(relationship.to)) {
        directDescendantIds.add(relationship.to);
        addedChild = true;
      }
    }
  }
}

const viewMembership = new Set();
for (const [viewName, view] of Object.entries(chart.views || {})) {
  if (Array.isArray(view.layoutFlipCouples) && view.layoutFlipCouples.length) {
    issues.push(`${viewName} cannot flip couples under father-left ordering`);
  }
  for (const node of view.nodes || chart.nodes || []) {
    if (!visualIds.has(node.id)) issues.push(`view ${viewName} references missing visual person: ${node.id}`);
    viewMembership.add(node.id);
    const permittedDescendant = view.allowDescendants === true && directDescendantIds?.has(node.id);
    if (!view.allowCollateral && directLineIds && !directLineIds.has(node.id) && !permittedDescendant) {
      issues.push(`view ${viewName} contains non-direct person: ${node.id}`);
    }
    if (["kinship-layered", "pedigree-collateral-overlay"].includes(view.engine)
      && (!Number.isInteger(node.generation) || node.generation < 0)) {
      issues.push(`view ${viewName} person ${node.id} requires a non-negative generation`);
    }
  }
}
for (const personId of visualIds) {
  if (!viewMembership.has(personId)) issues.push(`visual person ${personId} is not present in any view`);
}
// Tree-specific view rules (e.g. a collateral overlay view) live in
// tree/hooks/check-family-data.mjs.
await runTreeHook("check-family-data", { familyData, chart, issues });

// A tree may require a flag on every tree person (tree.config.json
// viewer.requireFlags).
if (!issues.length && loadTreeConfig().viewer.requireFlags) {
  for (const personId of flaglessTreePeople(familyData)) {
    issues.push(`person ${personId} is on the tree with no flag: add a best-guess ancestry-origin assertion (candidate strength is fine) and list it in presentation.detailAssertionIds; originFlagOmissionReason alone no longer suffices`);
  }
}

if (issues.length) {
  console.error(`family data check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

const structuredCounts = {
  events: people.filter((person) => person.events.length).length,
  places: people.filter((person) => person.places.length).length,
  occupations: people.filter((person) => person.occupations.length).length
};
console.log(
  `family data ok: ${peopleById.size} people, ${visualIds.size} visual nodes; `
    + `${structuredCounts.events} event profiles, ${structuredCounts.places} place profiles, `
    + `${structuredCounts.occupations} occupation profiles`
);

function checkVisualRelationship(relationship, label) {
  if (!visualIds.has(relationship?.from) || !visualIds.has(relationship?.to)) {
    issues.push(`${label} relationship references missing visual person: ${relationship?.from}->${relationship?.to}`);
  }
  if (!relationshipStatuses.has(relationship?.status)) {
    issues.push(`${label} ${relationship?.from}->${relationship?.to} has invalid status: ${relationship?.status}`);
  }
  issues.push(...validateProofProjection(
    relationship?.proof,
    `${label} ${relationship?.from}->${relationship?.to}`
  ));
}

function pairKey(first, second) {
  return [String(first), String(second)].sort().join("|");
}
