export const identificationStatuses = new Set(["confirmed", "candidate"]);
export const personLinkBases = new Set(["named", "directly-evidenced"]);
export const nameReadingOrigins = new Set([
  "original",
  "index",
  "transcript",
  "catalogue",
  "webpage",
  "family-statement"
]);
export const sourceTitleModes = new Set(["people", "category-only"]);

export function preferredSourceName(link) {
  const reading = link?.names?.find((name) => name.preferred === true);
  return reading ? reading.interpretation || reading.asRecorded : "";
}

export function safePersonLinks(atom, allowedPersonIds) {
  return (atom?.personLinks || [])
    .filter((link) => allowedPersonIds.has(link.personId))
    .map((link) => ({
      personId: link.personId,
      identificationStatus: link.identificationStatus,
      evidenceBasis: link.evidenceBasis,
      ...(link.names?.length ? {
        names: link.names.map((name) => ({
          asRecorded: name.asRecorded,
          ...(name.interpretation ? { interpretation: name.interpretation } : {}),
          origin: name.origin,
          ...(name.preferred ? { preferred: true } : {})
        }))
      } : {})
    }));
}

export function safeUnlinkedNames(atom) {
  return (atom?.unlinkedNames || []).map((name) => ({
    id: name.id,
    asRecorded: name.asRecorded,
    ...(name.interpretation ? { interpretation: name.interpretation } : {}),
    origin: name.origin
  }));
}

export function validatePersonLinks(atom, { personIds } = {}) {
  const issues = [];
  if (!Array.isArray(atom?.personLinks)) {
    return [`source ${atom?.id || "(missing id)"} must have a personLinks array`];
  }
  const legacyPeople = Array.isArray(atom.people) ? atom.people : [];
  const seenPeople = new Set();
  for (const link of atom.personLinks) {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      issues.push(`source ${atom.id} has an invalid person link`);
      continue;
    }
    if (typeof link.personId !== "string" || !link.personId
      || (personIds && !personIds.has(link.personId))) {
      issues.push(`source ${atom.id} links an unknown person: ${link.personId || "(missing)"}`);
    }
    if (seenPeople.has(link.personId)) issues.push(`source ${atom.id} repeats person link ${link.personId}`);
    seenPeople.add(link.personId);
    if (!identificationStatuses.has(link.identificationStatus)) {
      issues.push(`source ${atom.id} has invalid identificationStatus for ${link.personId}`);
    }
    if (!personLinkBases.has(link.evidenceBasis)) {
      issues.push(`source ${atom.id} has invalid evidenceBasis for ${link.personId}`);
    }
    const names = link.names || [];
    if (link.evidenceBasis === "named" && (!Array.isArray(names) || !names.length)) {
      issues.push(`source ${atom.id} named link ${link.personId} requires a name reading`);
    }
    if (link.evidenceBasis === "directly-evidenced" && names.length) {
      issues.push(`source ${atom.id} directly-evidenced link ${link.personId} cannot claim a recorded name`);
    }
    if (Array.isArray(names)) {
      const seenNames = new Set();
      for (const name of names) {
        if (typeof name?.asRecorded !== "string" || !name.asRecorded.trim()) {
          issues.push(`source ${atom.id} has a blank recorded name for ${link.personId}`);
          continue;
        }
        const key = `${name.origin}:${name.asRecorded.trim().toLocaleLowerCase()}`;
        if (seenNames.has(key)) issues.push(`source ${atom.id} repeats recorded name ${name.asRecorded}`);
        seenNames.add(key);
        if (!nameReadingOrigins.has(name.origin)) {
          issues.push(`source ${atom.id} has invalid name origin for ${link.personId}: ${name.origin}`);
        }
        if (name.interpretation !== undefined
          && (typeof name.interpretation !== "string" || !name.interpretation.trim()
            || name.interpretation.trim() === name.asRecorded.trim())) {
          issues.push(`source ${atom.id} has invalid name interpretation for ${link.personId}`);
        }
        const allowedNameFields = new Set(["asRecorded", "interpretation", "origin", "preferred"]);
        for (const field of Object.keys(name)) {
          if (!allowedNameFields.has(field)) issues.push(`source ${atom.id} recorded name has unknown field: ${field}`);
        }
      }
      if (link.evidenceBasis === "named" && names.filter((name) => name.preferred === true).length !== 1) {
        issues.push(`source ${atom.id} named link ${link.personId} requires exactly one preferred reading`);
      }
    }
    const allowedLinkFields = new Set(["personId", "identificationStatus", "evidenceBasis", "names"]);
    for (const field of Object.keys(link)) {
      if (!allowedLinkFields.has(field)) issues.push(`source ${atom.id} person link has unknown field: ${field}`);
    }
  }
  if (legacyPeople.length !== seenPeople.size
    || legacyPeople.some((personId) => !seenPeople.has(personId))) {
    issues.push(`source ${atom.id} people must exactly match its structured personLinks`);
  }
  if (!atom.personLinksVerifiedAt || typeof atom.personLinksVerifiedAt !== "string") {
    issues.push(`source ${atom.id} structured person links require personLinksVerifiedAt`);
  }
  if (!atom.personLinksVerificationBasis || typeof atom.personLinksVerificationBasis !== "string") {
    issues.push(`source ${atom.id} structured person links require personLinksVerificationBasis`);
  }
  if (atom.unlinkedNames !== undefined && !Array.isArray(atom.unlinkedNames)) {
    issues.push(`source ${atom.id} has invalid unlinkedNames`);
  }
  const seenUnlinkedNames = new Set();
  for (const name of atom.unlinkedNames || []) {
    if (!name?.id || typeof name.id !== "string") {
      issues.push(`source ${atom.id} has an unlinked name without an id`);
    } else if (seenUnlinkedNames.has(name.id)) {
      issues.push(`source ${atom.id} repeats unlinked name id ${name.id}`);
    }
    seenUnlinkedNames.add(name?.id);
    if (typeof name?.asRecorded !== "string" || !name.asRecorded.trim()) {
      issues.push(`source ${atom.id} has a blank unlinked recorded name`);
    }
    if (!nameReadingOrigins.has(name?.origin)) {
      issues.push(`source ${atom.id} has invalid unlinked name origin: ${name?.origin}`);
    }
    if (name?.interpretation !== undefined
      && (typeof name.interpretation !== "string" || !name.interpretation.trim()
        || name.interpretation.trim() === name.asRecorded?.trim())) {
      issues.push(`source ${atom.id} has invalid unlinked name interpretation for ${name?.id}`);
    }
    const allowedFields = new Set(["id", "asRecorded", "interpretation", "origin"]);
    for (const field of Object.keys(name || {})) {
      if (!allowedFields.has(field)) issues.push(`source ${atom.id} unlinked name has unknown field: ${field}`);
    }
  }
  return issues;
}

// An interpretation often carries research commentary ("deceased; daughter of
// ...", "collateral, not a direct ancestor"). A title shows it only when it
// reads as a name; otherwise the name exactly as recorded.
export function titleNameFromReading(reading) {
  if (!reading) return "";
  const interpretation = String(reading.interpretation || "").trim();
  const nameLike = interpretation
    && interpretation.length <= 60
    && /^[\p{Lu}]/u.test(interpretation)
    && !/[;:\d]/.test(interpretation)
    && !/\.\s|\.$/.test(interpretation.replace(/\b\p{Lu}\./gu, ""))
    && !/\b(?:of|son|daughter|wife|husband|widow|deceased|born|died|baptised|baptized|buried|collateral|candidate|identified|grantor|testator|administrator|executor|informant|named|not)\b/i.test(interpretation);
  return nameLike ? interpretation : String(reading.asRecorded || "").trim();
}

export function generatedSourceTitle(presentation, atomMap, allowedPersonIds) {
  if (!sourceTitleModes.has(presentation?.titleMode)) throw new Error("invalid source title mode");
  const category = String(presentation.category || "").trim();
  if (!category) throw new Error("source title requires a category");
  const qualifier = String(presentation.titleQualifier || "").trim();
  const suffix = [category, qualifier].filter(Boolean).join(" — ");
  if (presentation.titleMode === "category-only") return suffix;
  const principals = presentation.titlePrincipals || [];
  const names = principals.flatMap((principal) => {
    const atom = atomMap.get(principal.sourceAtomId);
    if (principal.unlinkedNameId) {
      const name = atom?.unlinkedNames?.find((item) => item.id === principal.unlinkedNameId);
      return name ? [titleNameFromReading(name)].filter(Boolean) : [];
    }
    if (!allowedPersonIds.has(principal.personId)) return [];
    const link = atom?.personLinks?.find((item) => item.personId === principal.personId);
    const value = titleNameFromReading(link?.names?.find((name) => name.preferred === true));
    return value ? [value] : [];
  });
  return names.length ? `${joinNames(names)} — ${suffix}` : suffix;
}

export function validateTitlePresentation(presentation, atomMap, linkedPersonIds) {
  const issues = [];
  if (!sourceTitleModes.has(presentation?.titleMode)) return ["source presentation requires a valid titleMode"];
  if (!presentation.category || typeof presentation.category !== "string") issues.push("source presentation requires category");
  if (presentation.titleQualifier !== undefined
    && (typeof presentation.titleQualifier !== "string" || !presentation.titleQualifier.trim())) {
    issues.push("source presentation has an invalid titleQualifier");
  }
  const principals = presentation.titlePrincipals || [];
  if (presentation.titleMode === "people" && !principals.length) {
    issues.push("people title mode requires at least one title principal");
  }
  if (presentation.titleMode === "category-only" && principals.length) {
    issues.push("category-only title mode cannot include title principals");
  }
  if (presentation.titleMode === "category-only" && presentation.titleQualifier
    && !/^(?:part \d+|(?:first|second|third|fourth) sheet|continuation(?: page)?|reverse|verso|recto|page \d+)$/i
      .test(presentation.titleQualifier.trim())) {
    issues.push("category-only titleQualifier must describe document structure, not a person name");
  }
  const seen = new Set();
  for (const principal of principals) {
    const hasPersonId = typeof principal?.personId === "string" && Boolean(principal.personId);
    const hasUnlinkedNameId = typeof principal?.unlinkedNameId === "string" && Boolean(principal.unlinkedNameId);
    const principalId = hasPersonId ? principal.personId : principal?.unlinkedNameId;
    const key = `${principal?.sourceAtomId}:${principalId}`;
    if (seen.has(key)) issues.push(`duplicate title principal: ${key}`);
    seen.add(key);
    const atom = atomMap.get(principal?.sourceAtomId);
    if (hasPersonId === hasUnlinkedNameId) {
      issues.push(`title principal must identify exactly one linked or unlinked source name: ${key}`);
    } else if (hasPersonId) {
      if (!linkedPersonIds.has(principal.personId)) issues.push(`title principal is not linked: ${principal.personId}`);
      const link = atom?.personLinks?.find((item) => item.personId === principal.personId);
      if (!link || !preferredSourceName(link)) issues.push(`title principal has no preferred source name: ${key}`);
    } else if (!atom?.unlinkedNames?.some((name) => name.id === principal.unlinkedNameId)) {
      issues.push(`title principal has no unlinked source name: ${key}`);
    }
    if (Object.keys(principal || {}).some((field) => !new Set(["personId", "unlinkedNameId", "sourceAtomId"]).has(field))) {
      issues.push(`title principal has unknown fields: ${key}`);
    }
  }
  return issues;
}

function joinNames(names) {
  if (names.length < 2) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others`;
}
