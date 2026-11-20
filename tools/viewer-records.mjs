import {
  generatedSourceTitle,
  safePersonLinks,
  safeUnlinkedNames,
  validateTitlePresentation
} from "./source-person-links.mjs";

export function projectViewerRecords(
  manifest,
  sourceRegistry,
  projectedFamilyData,
  blobInventory = { records: [] },
  sourceInventory = { atoms: [], citationCoverage: [] }
) {
  const visualIds = new Set(projectedFamilyData.people.map((person) => person.id));
  const atomMap = new Map((sourceInventory.atoms || []).map((atom) => [atom.id, atom]));
  const deliveryById = new Map((blobInventory.records || []).map((record) => [record.id, record]));
  const approved = (manifest.records || []).filter((record) => record.viewer?.approved === true
    && record.rights === "family-viewer-approved"
    && record.privacy !== "restricted"
    && Array.isArray(record.people));
  const records = approved.map((record) => {
    const people = record.people.filter((personId) => visualIds.has(personId));
    const namedPeople = new Set(record.people);
    const atom = atomMap.get(record.sourceAtomId);
    const structured = Boolean(Array.isArray(atom?.personLinks) && record.viewer.titleMode);
    const principalNameIds = new Set((record.viewer.titlePrincipals || []).map(principal => principal.unlinkedNameId).filter(Boolean));
    const principalNames = safeUnlinkedNames(atom).filter(name => principalNameIds.has(name.id));
    const delivery = deliveryById.get(record.id);
    if (delivery && delivery.sourceSha256 !== record.sha256) {
      throw new Error(`viewer Blob inventory is stale for ${record.id}`);
    }
    return {
      id: record.id,
      kind: "document",
      title: structured
        ? generatedSourceTitle(record.viewer, atomMap, namedPeople)
        : record.viewer.title,
      category: record.viewer.category,
      date: record.viewer.date || record.acquiredAt,
      ...(record.viewer.approvedAt ? { addedAt: record.viewer.approvedAt } : {}),
      source: record.source,
      reference: record.reference,
      mediaType: record.mediaType,
      people,
      ...(structured
        ? {
            sourcePeople: safePersonLinks(atom, visualIds),
            ...(principalNames.length ? { sourceNames: principalNames } : {})
          }
        : { nameReviewPending: true }),
      ...(record.viewer.description ? { description: record.viewer.description } : {}),
      fileUrl: `/api/records/${encodeURIComponent(record.id)}`,
      ...(safeSourceUrl(record.catalogueUrl) ? { sourceUrl: record.catalogueUrl } : {}),
      ...(delivery?.thumbnail
        ? { thumbnailUrl: `/api/records/${encodeURIComponent(record.id)}?variant=thumbnail&v=${thumbnailVersion(delivery.thumbnail)}` }
        : {}),
      ...(delivery?.preview
        ? { previewUrl: `/api/records/${encodeURIComponent(record.id)}?variant=preview` }
        : {})
    };
  });
  const privateRecords = approved.map((record) => {
    const delivery = deliveryById.get(record.id);
    return {
      id: record.id,
      mediaType: record.mediaType,
      blobPath: record.viewer.blobPath,
      ...(delivery ? {
        variants: Object.fromEntries(["thumbnail", "preview"]
          .filter((variant) => delivery[variant])
          .map((variant) => [variant, {
            blobPath: delivery[variant].blobPath,
            mediaType: delivery[variant].mediaType
          }]))
      } : {})
    };
  });
  const citations = projectViewerSources(sourceRegistry, projectedFamilyData, {
    filterUnlinked: true,
    sourceInventory
  });
  const duplicate = citations.find((citation) => records.some((record) => record.id === citation.id));
  if (duplicate) throw new Error(`duplicate viewer record id: ${duplicate.id}`);
  return { familyRecords: { records: [...records, ...citations] }, privateRecords };
}

function thumbnailVersion(thumbnail) {
  const value = thumbnail.sha256 || thumbnail.etag || thumbnail.profile || "1";
  return encodeURIComponent(String(value).replace(/^"|"$/g, "").slice(0, 16));
}

export function projectViewerSources(
  registry,
  projectedFamilyData,
  { filterUnlinked = false, sourceInventory = { atoms: [], citationCoverage: [] } } = {}
) {
  if (![1, 2].includes(registry?.schemaVersion) || !Array.isArray(registry.records)) {
    throw new Error("unsupported viewer source registry");
  }
  const visualIds = new Set(projectedFamilyData.people.map((person) => person.id));
  const atomMap = new Map((sourceInventory.atoms || []).map((atom) => [atom.id, atom]));
  const coverageByCitation = new Map((sourceInventory.citationCoverage || [])
    .filter((row) => ["documentary", "source-atoms"].includes(row.disposition))
    .map((row) => [row.citationId, row.atomIds || []]));
  const ids = new Set();
  return registry.records.map((source) => {
    if (!source?.id || ids.has(source.id)) throw new Error(`invalid or duplicate viewer source id: ${source?.id || "(missing)"}`);
    ids.add(source.id);
    for (const field of ["category", "source", "reference", "status"]) {
      if (!source[field] || typeof source[field] !== "string") throw new Error(`${source.id} is missing ${field}`);
    }
    if (!Array.isArray(source.people) || !source.people.length || source.people.some((personId) => typeof personId !== "string" || !personId)) {
      throw new Error(`${source.id} has an invalid person link`);
    }
    const people = source.people.filter((personId) => visualIds.has(personId));
    if (!filterUnlinked && people.length !== source.people.length) throw new Error(`${source.id} links an unknown person`);
    if (!people.length) return null;
    if (source.sourceUrl !== undefined && !safeSourceUrl(source.sourceUrl)) {
      throw new Error(`${source.id} has an unsafe source URL`);
    }
    const citationAtomIds = coverageByCitation.get(source.id) || [];
    const citationAtoms = citationAtomIds.map((atomId) => atomMap.get(atomId)).filter(Boolean);
    const linkedVisualIds = new Set(people);
    const structuredTitle = Boolean(source.titleMode);
    const structuredNameAtoms = citationAtoms.filter((atom) => Array.isArray(atom.personLinks));
    const nameReviewPending = citationAtoms.some(requiresNameReview)
      && citationAtoms.some((atom) => requiresNameReview(atom) && !Array.isArray(atom.personLinks));
    if (structuredTitle) {
      if (registry.schemaVersion === 1 && source.title !== undefined) throw new Error(`${source.id} structured title cannot retain a manual title`);
      const titleIssues = validateTitlePresentation(source, atomMap, new Set(source.people));
      if (registry.schemaVersion === 1 && titleIssues.length) throw new Error(`${source.id} ${titleIssues.join("; ")}`);
      if (!structuredNameAtoms.length) {
        throw new Error(`${source.id} structured title has no structured citation atom`);
      }
      for (const principal of source.titlePrincipals || []) {
        if (!citationAtomIds.includes(principal.sourceAtomId)) {
          throw new Error(`${source.id} title principal is outside its citation coverage`);
        }
      }
    } else if (!source.title || typeof source.title !== "string") {
      throw new Error(`${source.id} is missing title`);
    }
    return {
      id: source.id,
      kind: "citation",
      title: structuredTitle
        ? (registry.schemaVersion === 2 ? source.title : generatedSourceTitle(source, atomMap, linkedVisualIds))
        : source.title,
      category: source.category,
      source: source.source,
      reference: source.reference,
      status: source.status,
      people,
      ...(structuredNameAtoms.length
        ? {
            sourcePeople: aggregateSourcePeople(structuredNameAtoms, linkedVisualIds),
            ...(structuredNameAtoms.some((atom) => atom.unlinkedNames?.length)
              ? { sourceNames: aggregateSourceNames(structuredNameAtoms) }
              : {})
          }
        : {}),
      ...(nameReviewPending || !structuredNameAtoms.length ? { nameReviewPending: true } : {}),
      sortOrder: Number.isInteger(source.ledgerIndex) ? source.ledgerIndex : 9999,
      ...(source.description ? { description: source.description } : {}),
      ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {})
    };
  }).filter(Boolean);
}

function requiresNameReview(atom) {
  return atom.recordClass !== "search-audit"
    || Boolean(atom.recordId)
    || atom.viewerPolicy === "approved-private";
}

function aggregateSourceNames(atoms) {
  const names = atoms.flatMap((atom) => safeUnlinkedNames(atom));
  return names.filter((name, index) => names.findIndex((candidate) =>
    candidate.origin === name.origin
      && candidate.asRecorded === name.asRecorded
      && candidate.interpretation === name.interpretation
  ) === index);
}

function aggregateSourcePeople(atoms, allowedPersonIds) {
  const byPerson = new Map();
  for (const atom of atoms) {
    for (const link of safePersonLinks(atom, allowedPersonIds)) {
      const existing = byPerson.get(link.personId);
      if (!existing) {
        byPerson.set(link.personId, structuredClone(link));
        continue;
      }
      if (link.identificationStatus === "candidate") existing.identificationStatus = "candidate";
      if (link.evidenceBasis === "named") existing.evidenceBasis = "named";
      const readings = [...(existing.names || []), ...(link.names || [])];
      existing.names = readings.filter((reading, index) => readings.findIndex((candidate) =>
        candidate.origin === reading.origin
          && candidate.asRecorded === reading.asRecorded
          && candidate.interpretation === reading.interpretation
      ) === index);
    }
  }
  return [...byPerson.values()];
}

function safeSourceUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
