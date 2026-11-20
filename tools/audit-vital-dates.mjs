#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const peopleDirectory = path.join(projectRoot, "evidence", "proof", "people");
const jsonMode = process.argv.includes("--json");
const assertionAbsenceOnly = process.argv.includes("--missing-assertion-only");

const profiles = fs.readdirSync(peopleDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync(path.join(peopleDirectory, name), "utf8")));

const people = profiles.map(auditPerson);
const strictGaps = people.filter((person) => person.birth.state !== "recorded"
  || person.death.state !== "recorded");
const assertionGaps = people.filter((person) => !person.birth.hasAssertion
  || !person.death.hasAssertion);
const selected = assertionAbsenceOnly ? assertionGaps : strictGaps;
const result = {
  generatedFrom: "evidence/proof/people",
  policy: {
    establishedOnly: "Only established birth and death assertions count as resolved.",
    proxyEvents: "Baptism and burial are reported as useful proxies but never converted to birth or death.",
    livingPeople: "Missing death dates for living people are privacy-deferred, not research defects.",
    unknownLifeStatus: "A missing death for a person whose life status is unknown requires a life-status review before death research.",
    candidatePeople: "Candidate identities must be resolved before their vital dates can be promoted."
  },
  counts: {
    people: people.length,
    noBirthAssertion: people.filter((person) => !person.birth.hasAssertion).length,
    noDeathAssertion: people.filter((person) => !person.death.hasAssertion).length,
    missingEitherAssertion: assertionGaps.length,
    noEstablishedBirth: people.filter((person) => person.birth.state !== "recorded").length,
    noEstablishedDeath: people.filter((person) => person.death.state !== "recorded").length,
    missingEitherEstablished: strictGaps.length,
    completeEstablished: people.length - strictGaps.length
  },
  resolutionPaths: {
    birth: countStates(people.map((person) => person.birth)),
    death: countStates(people.map((person) => person.death))
  },
  people: selected
};

if (jsonMode) console.log(JSON.stringify(result, null, 2));
else printMarkdown(result, assertionAbsenceOnly);

function auditPerson(profile) {
  const identity = profile.assertions.find((assertion) => assertion.claim?.kind === "person-identity");
  const life = profile.assertions.find((assertion) => assertion.claim?.kind === "life-status");
  const displayName = profile.assertions.find((assertion) =>
    assertion.id === profile.presentation?.displayNameAssertionId)?.claim?.value || profile.personId;
  return {
    id: profile.personId,
    name: displayName,
    identity: identity?.assessment || "unresolved",
    lifeStatus: life?.claim?.value || "unknown",
    birth: classifyDate(profile, "birth", identity, life),
    death: classifyDate(profile, "death", identity, life)
  };
}

function classifyDate(profile, eventType, identity, life) {
  const events = profile.assertions.filter((assertion) =>
    assertion.claim?.kind === "event" && assertion.claim.eventType === eventType);
  const established = events.find((assertion) => assertion.assessment === "established");
  if (established) return dateResult("recorded", events, established.claim.dateText, "none");

  if (eventType === "death" && life?.claim?.value === "living") {
    return dateResult("privacy-deferred", events, displayLead(events), "do not research a living person's death");
  }

  if (identity?.assessment === "candidate") {
    return dateResult("identity-first", events, displayLead(events), "resolve the candidate identity before promoting dates");
  }

  const candidateEvent = events.find((assertion) => assertion.assessment === "candidate");
  if (candidateEvent) {
    return dateResult(
      "event-match-first",
      events,
      candidateEvent.claim.dateText,
      "resolve the candidate event-to-person match before promoting the date"
    );
  }

  const supported = events.find(hasIndependentSupport);
  if (supported) {
    return dateResult(
      "existing-evidence-review",
      events,
      supported.claim.dateText,
      "review the linked non-legacy evidence and promote only if it supports this exact event"
    );
  }

  if (events.length) {
    return dateResult(
      "verify-legacy-lead",
      events,
      displayLead(events),
      "the date survives only as an unresolved legacy lead and needs corroborating research"
    );
  }

  const proxyType = eventType === "birth" ? "baptism" : "burial";
  const proxy = profile.assertions.find((assertion) => assertion.claim?.kind === "event"
    && assertion.claim.eventType === proxyType && assertion.assessment === "established");
  if (proxy) {
    return dateResult(
      "proxy-only",
      events,
      `${proxyType} ${proxy.claim.dateText}`,
      `retain the established ${proxyType}; research the distinct ${eventType} event only when useful`
    );
  }

  if (eventType === "death" && (!life || life.claim?.value === "unknown")) {
    return dateResult(
      "life-status-first",
      events,
      null,
      "establish whether the person is living or deceased before researching a death date"
    );
  }

  return dateResult("new-research", events, null, `search for a source that directly or indirectly dates the ${eventType}`);
}

function dateResult(state, events, value, action) {
  return {
    state,
    hasAssertion: events.length > 0,
    value,
    action
  };
}

function displayLead(events) {
  return events.map((assertion) => `${assertion.assessment}: ${assertion.claim.dateText}`).join("; ") || null;
}

function hasIndependentSupport(assertion) {
  return (assertion.evidence || []).some((item) =>
    ["direct", "indirect"].includes(item.role) && !item.sourceId.startsWith("legacy-project-data-"));
}

function countStates(items) {
  return Object.fromEntries([...new Set(items.map((item) => item.state))]
    .sort()
    .map((state) => [state, items.filter((item) => item.state === state).length]));
}

function printMarkdown(audit, absenceOnly) {
  console.log("# Vital-date audit");
  console.log("");
  console.log(`Canonical people: ${audit.counts.people}.`);
  console.log(`Profiles with no birth or death assertion: ${audit.counts.missingEitherAssertion} `
    + `(${audit.counts.noBirthAssertion} lack birth; ${audit.counts.noDeathAssertion} lack death).`);
  console.log(`Profiles without an established birth or death: ${audit.counts.missingEitherEstablished} `
    + `(${audit.counts.noEstablishedBirth} lack established birth; ${audit.counts.noEstablishedDeath} lack established death).`);
  console.log(`Profiles with both established: ${audit.counts.completeEstablished}.`);
  console.log("");
  console.log(`Mode: ${absenceOnly ? "missing assertion only" : "all missing established dates"}.`);
  console.log("");
  console.log("| Person | Life | Birth | Death |");
  console.log("| --- | --- | --- | --- |");
  for (const person of audit.people) {
    console.log(`| ${escapeCell(person.name)} (${person.id}) | ${person.lifeStatus} | `
      + `${formatDate(person.birth)} | ${formatDate(person.death)} |`);
  }
}

function formatDate(item) {
  const value = item.value ? `: ${item.value}` : "";
  return `${item.state}${value}`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
