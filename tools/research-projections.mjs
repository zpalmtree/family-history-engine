import { generatedSourceTitle } from "./source-person-links.mjs";
import { assertionMap, entityMap } from "./research-store.mjs";
import { reconcileAcquisitionTarget } from "./research-acquisition.mjs";
import {
  documentarySourceRequiresAcquisitionTarget,
  projectAcquisitionArtifactPolicy
} from "./source-acquisition-authority.mjs";
import { formatPlaceRow } from "./place-labels.mjs";
import { buildLifeStoryIndex, buildLifeStoryPacket, projectLifeStory } from "./life-story-core.mjs";
import { projectExhibits } from "./exhibit-store.mjs";
import { projectNotablePeople } from "./notable-people-core.mjs";
import { generationsFromRoots } from "./page-depth-core.mjs";
import { recordYearsByPerson, recordedSpan } from "./recorded-span.mjs";
import { generationEstimates } from "./generation-estimate.mjs";
import {
  buildCitationIdsByAssertion,
  citationSupportsAssertion
} from "./citation-coherence.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

export function buildResearchProjections(store, { manifest }) {
  const assertions = assertionMap(store);
  const sources = entityMap(store.sources, "id", "source");
  const citations = entityMap(store.citations, "id", "citation");
  const recordsById = new Map(manifest.records.map((record) => [record.id, record]));
  const recordsBySourceId = new Map(manifest.records.map((record) => [record.sourceAtomId || record.id, record]));
  const citationIdsByAssertion = buildCitationIdsByAssertion(store.citations, assertions);
  const citationIdsBySource = reverseRefs(store.citations, "sourceIds");
  const evidenceContext = {
    sources, citations, recordsBySourceId, citationIdsByAssertion, lifeStoryIndex: buildLifeStoryIndex(store)
  };

  const relationships = projectRelationships(store, evidenceContext);
  const exhibits = projectExhibits(store.exhibits || [], {
    store,
    records: manifest.records,
    generations: generationsFromRoots(store.treePresentation.visualTree?.directLineRoots || [], relationships.parents)
  });
  const recordYears = recordYearsByPerson(manifest.records, kinMaps(relationships));
  const notable = projectNotablePeople(store.notablePeople, store).byPerson;
  const projected = store.people.map((bundle) =>
    withRecordedSpan(projectPerson(bundle, store, evidenceContext), recordYears.get(bundle.personId), recordsById));
  const estimates = generationEstimates(projected, relationships);
  const people = store.people.map((bundle, index) => {
    const person = withBirthEstimate(projected[index], estimates.get(bundle.personId));
    const shown = exhibits.byPerson.get(bundle.personId);
    const distinction = notable.get(bundle.personId);
    return {
      ...person,
      ...(shown?.length ? { exhibits: shown } : {}),
      ...(distinction ? { distinction } : {})
    };
  });
  const tree = projectTree(store.treePresentation, people, relationships);
  const viewerSources = projectViewerSources(store, assertions, sources);
  const sourceAtoms = projectSourceAtoms(store, citationIdsBySource);
  const acquisitionSession = projectAcquisitionSession(store, {
    sources,
    recordsById,
    recordsBySourceId
  });

  return {
    people: { schemaVersion: 5, people, ...(exhibits.exhibits.length ? { exhibits: exhibits.exhibits } : {}) },
    relationships: { schemaVersion: 3, ...relationships },
    tree: { schemaVersion: 2, visualTree: tree },
    viewerSources,
    sourceAtoms,
    acquisitionSession
  };
}

function kinMaps(relationships) {
  const add = (map, key, value) => map.set(key, (map.get(key) || new Set()).add(value));
  const childrenOf = new Map();
  const spousesOf = new Map();
  for (const link of relationships.parents) add(childrenOf, link.parentId, link.childId);
  for (const link of relationships.couples) {
    add(spousesOf, link.leftPersonId, link.rightPersonId);
    add(spousesOf, link.rightPersonId, link.leftPersonId);
  }
  return { childrenOf, spousesOf };
}

// Placed after the events so the projected key order reads naturally.
function withRecordedSpan(person, years, recordsById) {
  const span = recordedSpan(person, years, { recordsById });
  if (!span) return person;
  const ordered = {};
  for (const [key, value] of Object.entries(person)) {
    ordered[key] = value;
    if (key === "events") ordered.recordedSpan = span;
  }
  return ordered;
}

// An estimated birth window from relatives' dates (see generation-estimate.mjs),
// placed after the events and any recorded span.
function withBirthEstimate(person, estimate) {
  if (!estimate) return person;
  const ordered = {};
  const after = "recordedSpan" in person ? "recordedSpan" : "events";
  for (const [key, value] of Object.entries(person)) {
    ordered[key] = value;
    if (key === after) ordered.birthEstimate = estimate;
  }
  return ordered;
}

export function supportClass(assertion, sources) {
  if ((assertion.evidence || []).some((evidence) => evidence.role === "contradicts")) return "conflicted";
  const linked = (assertion.evidence || []).map((evidence) => sources.get(evidence.sourceId)).filter(Boolean);
  if (linked.some((source) => source.kind === "documentary")) return "documented";
  if (linked.some((source) => source.kind === "family-statement")) return "family-information";
  return "legacy-unsourced";
}

function projectPerson(bundle, store, context) {
  const local = new Map(bundle.assertions.map((assertion) => [assertion.id, assertion]));
  const detail = (bundle.presentation.detailAssertionIds || []).map((id) => local.get(id)).filter(active);
  const displayName = local.get(bundle.presentation.displayNameAssertionId);
  const identity = bundle.assertions.find((assertion) => assertion.claim.kind === "person-identity");
  const names = detail.filter((assertion) => assertion.claim.kind === "name").map((assertion) => ({
    value: assertion.claim.value,
    type: assertion.claim.nameType,
    ...(assertion.claim.display ? { display: true } : {}),
    ...(assertion.claim.from ? { from: assertion.claim.from } : {}),
    ...(assertion.claim.to ? { to: assertion.claim.to } : {}),
    ...(assertion.claim.associatedPersonId ? { associatedPersonId: assertion.claim.associatedPersonId } : {}),
    proof: proofProjection(assertion, context)
  }));
  const personEvents = detail.filter((assertion) => assertion.claim.kind === "event")
    .map((assertion) => eventProjection(assertion, context));
  const unionEvents = store.unions.filter((union) => union.personIds.includes(bundle.personId))
    .flatMap((union) => union.presentation.eventAssertionIds || [])
    .map((id) => store.unions.find((union) => union.assertions.some((assertion) => assertion.id === id))
      ?.assertions.find((assertion) => assertion.id === id))
    .filter(active)
    .map((assertion) => eventProjection(assertion, context));
  const events = dedupeBy([...personEvents, ...unionEvents], (event) => `${event.type}:${event.date}`);
  const places = projectPlaces(bundle.presentation.placeRows || [], local, context);
  const occupations = detail.filter((assertion) => assertion.claim.kind === "occupation");
  const origin = detail.find((assertion) => assertion.claim.kind === "ancestry-origin");
  const life = detail.find((assertion) => assertion.claim.kind === "life-status");
  const summaryBlock = bundle.presentation.summaryBlock;
  const noteBlocks = bundle.presentation.noteBlocks || [];
  const biographyFacts = timelineFactEntries(bundle.presentation, local)
    .map((entry) => ({ entry, assertion: local.get(entry.assertionId) }))
    .filter(({ assertion }) => active(assertion) && assertion.claim.kind === "life-fact")
    .map(({ entry, assertion }) => ({
      category: assertion.claim.category,
      value: assertion.claim.value,
      prominence: entry.prominence,
      ...(assertion.claim.dateText ? { dateText: assertion.claim.dateText } : {}),
      ...(assertion.claim.fromDateText ? { fromDateText: assertion.claim.fromDateText } : {}),
      ...(assertion.claim.toDateText ? { toDateText: assertion.claim.toDateText } : {}),
      ...(assertion.claim.place ? { place: assertion.claim.place } : {}),
      ...(assertion.claim.fromPlace ? { fromPlace: assertion.claim.fromPlace } : {}),
      ...(assertion.claim.toPlace ? { toPlace: assertion.claim.toPlace } : {}),
      ...(assertion.claim.organization ? { organization: assertion.claim.organization } : {}),
      ...(assertion.claim.role ? { role: assertion.claim.role } : {}),
      ...(assertion.claim.rank ? { rank: assertion.claim.rank } : {}),
      ...(assertion.claim.employer ? { employer: assertion.claim.employer } : {}),
      proof: proofProjection(assertion, context)
    }));
  const lifeStory = store.lifeStories.find((story) => story.personId === bundle.personId);

  return {
    id: bundle.personId,
    status: statusProjection(identity?.assessment),
    privacy: bundle.privacy,
    ...(bundle.treeAddedAt ? { treeAddedAt: bundle.treeAddedAt } : {}),
    ...(origin?.assessment === "established" && supportClass(origin, context.sources) !== "conflicted"
      ? { ancestryOrigin: origin.claim.value }
      : origin && ["candidate", "unresolved", "established"].includes(origin.assessment)
        ? { probableOrigin: origin.claim.value } : {}),
    lifeStatus: life?.claim.value || "unknown",
    events,
    places,
    occupations: occupations.map((assertion) => assertion.claim.value),
    summary: summaryBlock?.text || "",
    notes: noteBlocks.map((block) => block.text),
    biographyFacts,
    lifeStory: projectLifeStory(lifeStory, buildLifeStoryPacket(store, bundle.personId, context.lifeStoryIndex),
      (store.lifeStoriesFull || []).find((story) => story.personId === bundle.personId)),
    names,
    factEvidence: {
      identity: identity ? proofProjection(identity, context) : null,
      displayName: displayName ? proofProjection(displayName, context) : null,
      ...(life ? { lifeStatus: proofProjection(life, context) } : {}),
      ...(origin ? { ancestryOrigin: proofProjection(origin, context) } : {}),
      occupations: occupations.map((assertion) => ({
        value: assertion.claim.value,
        ...(assertion.claim.dateText ? { dateText: assertion.claim.dateText } : {}),
        ...proofProjection(assertion, context)
      })),
      ...(summaryBlock ? { summary: blockProof(summaryBlock, local, context) } : {}),
      notes: noteBlocks.map((block) => ({ text: block.text, ...blockProof(block, local, context) }))
    }
  };
}

/**
 * The facts a person's Life timeline shows: every entry of biographyFacts, then any
 * life fact listed only among the details. Sessions record life facts in either
 * list; one listed only in detailAssertionIds reached the story but never the page.
 */
export function timelineFactEntries(presentation, local) {
  const explicit = presentation.biographyFacts || [];
  const listed = new Set(explicit.map((entry) => entry.assertionId));
  const fromDetails = (presentation.detailAssertionIds || [])
    .filter((id) => !listed.has(id) && local.get(id)?.claim?.kind === "life-fact")
    .map((assertionId) => ({ assertionId, prominence: "supporting" }));
  return [...explicit, ...fromDetails];
}

function projectPlaces(rows, local, context) {
  const projected = rows.map((row) => {
    const linked = row.assertionIds.map((id) => local.get(id)).filter(active);
    const roles = [...new Set(linked.map((assertion) => assertion.claim.placeRole))];
    if (roles.length !== 1) throw new Error(`place row ${row.assertionIds.join(", ")} has mixed roles`);
    return {
      value: formatPlaceRow(row),
      country: row.country,
      ...(row.recordedYear ? { recordedYear: row.recordedYear } : {}),
      role: roles[0],
      latestResidenceInCountry: false,
      proof: aggregateProofProjection(linked, context)
    };
  });
  const latestResidenceByCountry = new Map();
  projected.forEach((place, index) => {
    if (place.role === "residence" && place.proof.assessment === "established"
      && place.proof.supportClass !== "conflicted") {
      latestResidenceByCountry.set(place.country, index);
    }
  });
  return projected.map((place, index) => ({
    ...place,
    latestResidenceInCountry: latestResidenceByCountry.get(place.country) === index
  }));
}

function eventProjection(assertion, context) {
  return {
    type: assertion.claim.eventType,
    date: assertion.claim.dateText,
    proof: proofProjection(assertion, context)
  };
}

function blockProof(block, local, context) {
  const linked = block.assertionIds.map((id) => local.get(id)).filter(Boolean);
  return {
    assertionIds: linked.map((assertion) => assertion.id),
    assessment: weakestAssessment(linked.map((assertion) => assertion.assessment)),
    supportClass: weakestSupport(linked.map((assertion) => supportClass(assertion, context.sources))),
    viewerSourceIds: [...new Set(linked.flatMap((assertion) =>
      context.citationIdsByAssertion.get(assertion.id) || []))].sort()
  };
}

function aggregateProofProjection(linked, context) {
  const sourceIds = linked.flatMap((assertion) => (assertion.evidence || []).map((evidence) => evidence.sourceId))
    .filter((id) => context.sources.get(id)?.kind !== "legacy-project-data");
  return {
    assertionIds: linked.map((assertion) => assertion.id),
    assessment: weakestAssessment(linked.map((assertion) => assertion.assessment)),
    supportClass: weakestSupport(linked.map((assertion) => supportClass(assertion, context.sources))),
    viewerSourceIds: [...new Set(linked.flatMap((assertion) =>
      context.citationIdsByAssertion.get(assertion.id) || []))].sort(),
    viewerRecordIds: [...new Set(sourceIds.map((id) => context.recordsBySourceId.get(id))
      .filter((record) => record?.viewer?.approved)
      .map((record) => record.id))].sort()
  };
}

function proofProjection(assertion, context) {
  const sourceIds = (assertion.evidence || []).map((evidence) => evidence.sourceId)
    .filter((id) => context.sources.get(id)?.kind !== "legacy-project-data");
  return {
    assertionId: assertion.id,
    assessment: assertion.assessment,
    supportClass: supportClass(assertion, context.sources),
    viewerSourceIds: [...new Set(context.citationIdsByAssertion.get(assertion.id) || [])].sort(),
    viewerRecordIds: [...new Set(sourceIds.map((id) => context.recordsBySourceId.get(id))
      .filter((record) => record?.viewer?.approved)
      .map((record) => record.id))].sort()
  };
}

function projectRelationships(store, context) {
  const parents = [];
  for (const bundle of store.people) {
    const local = new Map(bundle.assertions.map((assertion) => [assertion.id, assertion]));
    for (const id of bundle.presentation.treeParentAssertionIds || []) {
      const assertion = local.get(id);
      if (!active(assertion)) continue;
      parents.push({
        parentId: assertion.claim.parentId,
        childId: assertion.claim.childId,
        role: assertion.claim.role,
        status: statusProjection(assertion.assessment),
        relationshipType: assertion.claim.relationshipType,
        proof: proofProjection(assertion, context)
      });
    }
  }
  const couples = store.unions.map((bundle) => {
    const assertion = bundle.assertions.find((item) => item.id === bundle.presentation.unionAssertionId);
    if (!active(assertion)) return null;
    return {
      leftPersonId: bundle.presentation.leftPersonId,
      rightPersonId: bundle.presentation.rightPersonId,
      leftRole: bundle.presentation.leftRole,
      rightRole: bundle.presentation.rightRole,
      status: statusProjection(assertion.assessment),
      ...(assertion.claim.unionStatus ? { unionStatus: assertion.claim.unionStatus } : {}),
      proof: proofProjection(assertion, context)
    };
  }).filter(Boolean);
  const siblings = (store.kinships || []).map((bundle) => {
    const assertion = bundle.assertions.find((item) => item.id === bundle.presentation.siblingAssertionId);
    if (!active(assertion)) return null;
    const [leftPersonId, rightPersonId] = [...bundle.personIds].sort();
    return {
      leftPersonId,
      rightPersonId,
      status: statusProjection(assertion.assessment),
      relationshipType: assertion.claim.relationshipType || "sibling",
      proof: proofProjection(assertion, context)
    };
  }).filter(Boolean);
  return {
    parents: parents.sort(compareParents),
    couples: couples.sort(compareCouples),
    siblings: siblings.sort(compareSiblings)
  };
}

function projectTree(treePresentation, people, relationships) {
  if (treePresentation.schemaVersion !== 2) throw new Error("unsupported tree presentation schema");
  const chart = structuredClone(treePresentation.visualTree);
  const peopleIds = new Set(people.map((person) => person.id));
  const directIds = expandSelector(chart.selector, relationships.parents, peopleIds);
  delete chart.selector;
  const viewMemberships = [];
  for (const view of Object.values(chart.views || {})) {
    const selector = view.selector;
    delete view.selector;
    const nodes = selector?.familyNetwork
      ? expandFamilyNetwork(selector.familyNetwork, relationships, peopleIds)
      : expandSelector(selector, relationships.parents, peopleIds).map((id) => ({ id }));
    view.nodes = nodes;
    viewMemberships.push(...nodes.map((node) => node.id));
  }
  chart.nodes = [...new Set([...directIds, ...viewMemberships])].sort().map((id) => ({ id }));
  return chart;
}

export function expandFamilyNetwork(selector, relationships, peopleIds) {
  const allowed = new Set(selector.expansionStatuses || ["confirmed", "candidate"]);
  const eligibleParents = (relationships.parents || []).filter((link) =>
    allowed.has(link.status) && peopleIds.has(link.parentId) && peopleIds.has(link.childId));
  const eligibleCouples = (relationships.couples || []).filter((link) =>
    allowed.has(link.status) && peopleIds.has(link.leftPersonId) && peopleIds.has(link.rightPersonId));
  const eligibleSiblings = (relationships.siblings || []).filter((link) =>
    allowed.has(link.status) && peopleIds.has(link.leftPersonId) && peopleIds.has(link.rightPersonId));
  const membership = new Map();
  const detailedBloodIds = new Set();

  const add = (personId, generation, bloodRelative, reason) => {
    if (!peopleIds.has(personId)) return;
    const current = membership.get(personId);
    if (current && current.generation !== generation) {
      // A direct ancestor reached by two lines of different length (pedigree
      // collapse, e.g. a couple who were second cousins once removed) keeps the
      // nearer generation; the breadth-first walk always reaches it first.
      if (!String(reason).startsWith("direct-ancestor-of:")) {
        throw new Error(`family network generation conflict for ${personId}: ${current.generation} and ${generation}`);
      }
      current.generation = Math.min(current.generation, generation);
    }
    if (!current) {
      membership.set(personId, { id: personId, generation, bloodRelative, membershipReasons: [reason] });
      return;
    }
    current.bloodRelative ||= bloodRelative;
    if (!current.membershipReasons.includes(reason)) current.membershipReasons.push(reason);
  };

  const focals = [];
  for (const [generationText, ids] of Object.entries(selector.focalGenerations || {})) {
    const generation = Number(generationText);
    if (!Number.isInteger(generation) || generation < 0) {
      throw new Error(`family network has invalid focal generation ${generationText}`);
    }
    for (const personId of ids || []) {
      add(personId, generation, true, "focal");
      detailedBloodIds.add(personId);
      focals.push({ personId, generation });
    }
  }

  const directAncestorStatuses = new Set(selector.directAncestorStatuses
    || ["confirmed", "candidate", "unresolved"]);
  const directAncestorParents = (relationships.parents || []).filter((link) =>
    directAncestorStatuses.has(link.status)
    && peopleIds.has(link.parentId)
    && peopleIds.has(link.childId));
  for (const rootId of selector.includeDirectAncestorsOf || []) {
    const root = membership.get(rootId);
    if (!root) throw new Error(`direct-ancestor root ${rootId} requires a focal generation`);
    const queue = [{ personId: rootId, generation: root.generation }];
    const expanded = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (expanded.has(current.personId)) continue;
      expanded.add(current.personId);
      for (const link of directAncestorParents) {
        if (link.childId !== current.personId) continue;
        const generation = current.generation + 1;
        add(link.parentId, generation, true, `direct-ancestor-of:${rootId}`);
        queue.push({ personId: link.parentId, generation });
      }
    }
  }

  const siblingByPerson = new Map(focals.map(({ personId }) => [personId, new Set()]));
  if (selector.includeSiblings !== false) {
    for (const link of eligibleSiblings) {
      if (siblingByPerson.has(link.leftPersonId)) siblingByPerson.get(link.leftPersonId).add(link.rightPersonId);
      if (siblingByPerson.has(link.rightPersonId)) siblingByPerson.get(link.rightPersonId).add(link.leftPersonId);
    }
    const childrenByParent = new Map();
    for (const link of eligibleParents) {
      if (!childrenByParent.has(link.parentId)) childrenByParent.set(link.parentId, new Set());
      childrenByParent.get(link.parentId).add(link.childId);
    }
    for (const { personId } of focals) {
      const parentIds = eligibleParents.filter((link) => link.childId === personId).map((link) => link.parentId);
      for (const parentId of parentIds) {
        for (const siblingId of childrenByParent.get(parentId) || []) {
          if (siblingId !== personId) siblingByPerson.get(personId).add(siblingId);
        }
      }
    }
  }

  const siblingEntries = [];
  for (const focal of focals) for (const siblingId of siblingByPerson.get(focal.personId) || []) {
    add(siblingId, focal.generation, true, `sibling-of:${focal.personId}`);
    detailedBloodIds.add(siblingId);
    siblingEntries.push({ personId: siblingId, generation: focal.generation });
  }

  const childSeeds = selector.includeFocalChildren === false ? siblingEntries : [...focals, ...siblingEntries];
  if ((selector.siblingChildDepth ?? 1) > 0) {
    for (const seed of childSeeds) for (const link of eligibleParents) {
      if (link.parentId === seed.personId && seed.generation > 0) {
        add(link.childId, seed.generation - 1, true, `child-of:${seed.personId}`);
        detailedBloodIds.add(link.childId);
      }
    }
  }

  if (selector.includePartnersOfBloodRelatives !== false) {
    const blood = [...membership.values()].filter((entry) => detailedBloodIds.has(entry.id));
    for (const entry of blood) for (const link of eligibleCouples) {
      const partnerId = link.leftPersonId === entry.id ? link.rightPersonId
        : link.rightPersonId === entry.id ? link.leftPersonId : null;
      if (partnerId) add(partnerId, entry.generation, false, `partner-of:${entry.id}`);
    }
  }

  return [...membership.values()]
    .map((entry) => ({ ...entry, membershipReasons: entry.membershipReasons.sort() }))
    .sort((first, second) => second.generation - first.generation || first.id.localeCompare(second.id));
}

function expandSelector(selector, parentLinks, peopleIds) {
  const result = new Set();
  for (const rootId of selector?.ancestorsOf || []) if (peopleIds.has(rootId)) result.add(rootId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relationship of parentLinks) {
      if (result.has(relationship.childId) && peopleIds.has(relationship.parentId) && !result.has(relationship.parentId)) {
        result.add(relationship.parentId);
        changed = true;
      }
    }
  }
  for (const personId of selector?.include || []) if (peopleIds.has(personId)) result.add(personId);
  return [...result].sort();
}

function projectViewerSources(store, assertions, sources) {
  const peopleIds = new Set(store.people.map((bundle) => bundle.personId));
  const records = [...store.citations].sort((first, second) =>
    first.presentation.sortOrder - second.presentation.sortOrder || first.id.localeCompare(second.id))
    .map((citation) => {
      const proofAssertions = (citation.assertionIds || [])
        .map((id) => assertions.get(id))
        .filter((assertion) => assertion && citationSupportsAssertion(citation, assertion));
      const contextAssertions = (citation.contextAssertionIds || [])
        .map((id) => assertions.get(id))
        .filter(Boolean);
      const linkedAssertions = dedupeBy([...proofAssertions, ...contextAssertions], (assertion) => assertion.id);
      const linkedSources = citation.sourceIds.map((id) => sources.get(id)).filter(Boolean);
      const title = citation.presentation.title || generatedSourceTitle(
        citation.presentation.titlePresentation,
        sources,
        peopleIds
      );
      const personIds = [...new Set(linkedAssertions.flatMap(assertionPeople))].sort();
      const derivedStatus = weakestAssessment(proofAssertions.map((assertion) => assertion.assessment));
      const sourceLabel = citation.presentation.source
        || [...new Set(linkedSources.map((source) => source.source))].join("; ");
      const reference = citation.presentation.reference
        || linkedSources.map((source) => source.reference).filter(Boolean).join("; ");
      const titlePresentation = citation.presentation.titlePresentation;
      return {
        id: citation.id,
        title,
        category: citation.presentation.category,
        source: sourceLabel,
        reference,
        status: proofAssertions.length ? citationStatus(derivedStatus) : "Context only — not claim-level proof",
        people: personIds,
        ledgerIndex: citation.presentation.sortOrder,
        ...(!proofAssertions.length && citation.contextNote ? { description: citation.contextNote } : {}),
        ...(citation.presentation.sourceUrl ? { sourceUrl: citation.presentation.sourceUrl } : {}),
        ...(titlePresentation ? {
          titleMode: titlePresentation.titleMode,
          titlePrincipals: titlePresentation.titlePrincipals,
          ...(titlePresentation.titleQualifier ? { titleQualifier: titlePresentation.titleQualifier } : {})
        } : {})
      };
    });
  return { schemaVersion: 2, records };
}

function projectSourceAtoms(store, citationIdsBySource) {
  const atoms = store.sources.filter((source) => source.includeInLegacyAtomProjection !== false)
    .map((source) => {
      const {
        schemaVersion: ignoredSchema,
        kind: ignoredKind,
        artifactPurpose,
        includeInLegacyAtomProjection: ignoredProjection,
        intendedPersonIds,
        personLinks,
        group: ignoredGroup,
        ...rest
      } = source;
      return {
        ...rest,
        ...(personLinks ? {
          personLinks: personLinks.map(({ biographicalReview: ignoredBiographyReview, ...link }) => link)
        } : {}),
        ...(source.kind === "family-statement" ? { recordClass: "family-statement" } : {}),
        artifactPurpose,
        people: (personLinks || []).map((link) => link.personId),
        ...(intendedPersonIds?.length ? { intendedPersonIds } : {}),
        ...(source.scope === "planned-source" && !(rest.citationIds || citationIdsBySource.get(source.id))?.length
          ? { standaloneReason: "planned acquisition target; no source artifact located yet" } : {}),
        ...(citationIdsBySource.get(source.id)?.length
          ? { citationIds: [...citationIdsBySource.get(source.id)].sort() } : {})
      };
    }).sort((first, second) => first.id.localeCompare(second.id));
  const groupsById = new Map();
  for (const source of store.sources) {
    if (!source.group) continue;
    if (!groupsById.has(source.group.id)) groupsById.set(source.group.id, {
      id: source.group.id,
      title: source.group.title,
      atomIds: [],
      completeness: source.group.completeness
    });
    groupsById.get(source.group.id).atomIds.push({ id: source.id, position: source.group.position });
  }
  const groups = [...groupsById.values()].map((group) => ({
    ...group,
    atomIds: group.atomIds.sort((first, second) => first.position - second.position).map((item) => item.id)
  })).sort((first, second) => first.id.localeCompare(second.id));
  const citationCoverage = store.citations.map((citation) => {
    const linked = citation.sourceIds.map((id) => store.sources.find((source) => source.id === id)).filter(Boolean);
    if (linked.length && linked.every((source) => source.kind === "family-statement")) {
      return { citationId: citation.id, disposition: "non-documentary", reasonCode: "family-statement" };
    }
    return { citationId: citation.id, disposition: "source-atoms", atomIds: [...citation.sourceIds].sort() };
  }).sort((first, second) => first.citationId.localeCompare(second.citationId));
  return {
    schemaVersion: 3,
    objective: "Canonical source identity and artifact policy; genealogical evidence roles live on assertion links.",
    atoms,
    groups,
    citationCoverage
  };
}

export function projectAcquisitionSession(store, { sources, recordsById, recordsBySourceId }) {
  const targets = store.acquisitionTargets.map((target) => {
    const source = sources.get(target.sourceId);
    const artifact = projectAcquisitionArtifactPolicy(source, target);
    const reconciliation = reconcileAcquisitionTarget(target, { recordsById, recordsBySourceId, sourcesById: sources });
    const record = recordsBySourceId.get(target.sourceId);
    return compact({
      id: target.id,
      atomId: target.sourceId,
      sourceId: target.sourceId,
      scope: source?.scope || "planned-source",
      sourceQueue: "research-store",
      provider: target.provider,
      route: target.routes?.[0]?.route || "unassigned",
      priority: target.priority,
      status: reconciliation.status,
      reconciliation,
      people: source?.personLinks?.map((link) => link.personId) || source?.intendedPersonIds || [],
      artifactPurpose: artifact.artifactPurpose,
      publishEligible: artifact.publishEligible,
      reference: target.reference,
      recordClass: artifact.recordClass,
      artifactPolicy: artifact.artifactPolicy,
      viewerPolicy: artifact.viewerPolicy,
      questionIds: target.questionIds || [],
      researchRole: target.researchRole,
      disposition: target.disposition,
      gate: target.gate,
      gates: target.gates,
      researchScope: target.researchScope,
      satisfaction: target.satisfaction,
      supersession: target.supersession,
      routes: target.routes || [],
      artifact: record ? artifactFor(record) : undefined
    });
  }).sort(compareAcquisitionTargets);
  const targetsBySource = new Map(targets.map((target) => [target.sourceId, target]));
  const citationCoverage = store.citations.map((citation) => {
    const linkedSources = citation.sourceIds.map((id) => sources.get(id)).filter(Boolean);
    if (linkedSources.length && linkedSources.every((source) => source.kind === "family-statement")) {
      return { citationId: citation.id, disposition: "non-documentary", status: "non-documentary", reasonCode: "family-statement" };
    }
    const linkedTargets = citation.sourceIds.map((id) => targetsBySource.get(id)).filter(Boolean);
    const missingTargetSourceIds = linkedSources
      .filter((source) => !targetsBySource.has(source.id) && documentarySourceRequiresAcquisitionTarget(source))
      .map((source) => source.id)
      .sort();
    const states = new Set(linkedTargets.map((target) => target.reconciliation.state));
    const status = missingTargetSourceIds.length ? "explicit-gaps"
      : states.has("actionable") ? "actionable-source-atoms"
      : states.has("blocked") || states.has("exhausted") ? "explicit-gaps" : "exactly-satisfied";
    return {
      citationId: citation.id,
      disposition: "source-atoms",
      status,
      atomIds: citation.sourceIds,
      ...(missingTargetSourceIds.length ? {
        reasonCode: "documentary-source-needs-acquisition-target",
        missingTargetSourceIds
      } : {})
    };
  }).sort((first, second) => first.citationId.localeCompare(second.citationId));
  return {
    schemaVersion: 3,
    objective: "One deterministic acquisition view generated from source, target, attempt, and custody authorities.",
    policy: {
      browser: "Windows Chrome project wrappers only",
      artifactStorage: "Encrypted external archive; hashes and rights remain in records-manifest.json",
      paidCheckpoints: [],
      submissionCheckpoints: loadTreeConfig().research?.submissionCheckpoints || [],
      credentialStorage: "No credentials, contact details, payment data, or tokens in the research store."
    },
    phaseOrder: [
      "reconcile-existing-artifacts",
      "pending-external-deliveries",
      "free-public-downloads",
      "free-familysearch-recovery-and-search",
      "subscription-capture-after-explicit-pay-authorization",
      "alternate-and-center-routes",
      "publish-audit-and-viewer-validation"
    ],
    runs: store.acquisitionRuns.map(({ schemaVersion: ignoredSchema, id: ignoredId, ...run }) => run),
    targets,
    citationCoverage,
    summary: {
      targetCount: targets.length,
      byStatus: countBy(targets, "status"),
      byProvider: countBy(targets, "provider"),
      byPriority: countBy(targets, "priority"),
      citations: {
        total: citationCoverage.length,
        byStatus: countBy(citationCoverage, "status")
      }
    }
  };
}

function artifactFor(record) {
  return compact({
    archivePath: record.archivePath,
    sha256: record.sha256,
    length: record.length,
    mediaType: record.mediaType,
    viewerPublishState: record.viewer?.approved ? "published" : undefined,
    blobPath: record.viewer?.blobPath
  });
}

function assertionPeople(assertion) {
  const claim = assertion.claim || {};
  return [...new Set([
    claim.personId,
    claim.subjectType === "person" ? claim.subjectId : null,
    claim.childId,
    claim.parentId,
    ...(claim.personIds || [])
  ].filter(Boolean))];
}

function reverseRefs(values, field) {
  const result = new Map();
  for (const value of values) for (const id of value[field] || []) {
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(value.id);
  }
  return result;
}

function active(assertion) {
  return Boolean(assertion) && assertion.assessment !== "rejected";
}

function statusProjection(assessment) {
  if (assessment === "established") return "confirmed";
  if (assessment === "candidate") return "candidate";
  return "unresolved";
}

function weakestAssessment(values) {
  const rank = { established: 3, candidate: 2, unresolved: 1, rejected: 0 };
  return [...values].sort((first, second) => rank[first] - rank[second])[0] || "unresolved";
}

function weakestSupport(values) {
  const rank = { documented: 3, "family-information": 2, "legacy-unsourced": 1, conflicted: 0 };
  return [...values].sort((first, second) => rank[first] - rank[second])[0] || "legacy-unsourced";
}

function citationStatus(assessment) {
  return assessment === "established" ? "Established"
    : assessment === "candidate" ? "Candidate evidence" : "Unresolved or legacy-supported";
}

function compareParents(first, second) {
  return first.childId.localeCompare(second.childId)
    || first.role.localeCompare(second.role)
    || first.parentId.localeCompare(second.parentId);
}

function compareCouples(first, second) {
  return first.leftPersonId.localeCompare(second.leftPersonId)
    || first.rightPersonId.localeCompare(second.rightPersonId);
}

function compareSiblings(first, second) {
  return first.leftPersonId.localeCompare(second.leftPersonId)
    || first.rightPersonId.localeCompare(second.rightPersonId);
}

function compareAcquisitionTargets(first, second) {
  return first.priority.localeCompare(second.priority)
    || first.provider.localeCompare(second.provider)
    || first.id.localeCompare(second.id);
}

function dedupeBy(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function countBy(values, field) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = value[field] || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([first], [second]) => first.localeCompare(second)));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
