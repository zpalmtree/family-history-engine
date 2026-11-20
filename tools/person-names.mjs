export const personNameTypes = new Set([
  "birth",
  "married",
  "adopted",
  "anglicized",
  "nickname",
  "alternate",
  "spelling-variant"
]);

export const proofAssessments = new Set(["established", "candidate", "unresolved"]);
export const proofSupportClasses = new Set([
  "documented", "family-information", "legacy-unsourced", "conflicted"
]);

export function validateProofProjection(proof, label) {
  const issues = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return [`${label} is missing proof metadata`];
  if (!proof.assertionId || typeof proof.assertionId !== "string") issues.push(`${label} has no assertionId`);
  if (!proofAssessments.has(proof.assessment)) issues.push(`${label} has invalid assessment: ${proof.assessment}`);
  if (!proofSupportClasses.has(proof.supportClass)) issues.push(`${label} has invalid supportClass: ${proof.supportClass}`);
  for (const field of ["viewerSourceIds", "viewerRecordIds"]) {
    if (!Array.isArray(proof[field]) || proof[field].some((id) => typeof id !== "string" || !id)) {
      issues.push(`${label} has invalid ${field}`);
    }
  }
  return issues;
}

export function validateAggregateProofProjection(proof, label) {
  const issues = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return [`${label} is missing proof metadata`];
  if (!Array.isArray(proof.assertionIds) || !proof.assertionIds.length
    || proof.assertionIds.some((id) => typeof id !== "string" || !id)) {
    issues.push(`${label} has invalid assertionIds`);
  }
  if (!proofAssessments.has(proof.assessment)) issues.push(`${label} has invalid assessment: ${proof.assessment}`);
  if (!proofSupportClasses.has(proof.supportClass)) issues.push(`${label} has invalid supportClass: ${proof.supportClass}`);
  for (const field of ["viewerSourceIds", "viewerRecordIds"]) {
    if (!Array.isArray(proof[field]) || proof[field].some((id) => typeof id !== "string" || !id)) {
      issues.push(`${label} has invalid ${field}`);
    }
  }
  return issues;
}

export function displayPersonName(person) {
  return person?.names?.find((name) => name.display === true)?.value || "";
}

export function searchablePersonNames(person) {
  return [...new Set((person?.names || [])
    .map((name) => name?.value?.trim())
    .filter(Boolean))];
}

export function validatePersonNames(person, { personIds, atomIds } = {}) {
  const issues = [];
  const names = person?.names;
  if (!Array.isArray(names) || !names.length) {
    return [`person ${person?.id || "(missing id)"} must have a non-empty names array`];
  }
  const displayNames = names.filter((name) => name?.display === true);
  if (displayNames.length !== 1) {
    issues.push(`person ${person.id} must have exactly one display name`);
  }
  const seen = new Set();
  for (const name of names) {
    if (!name || typeof name !== "object" || Array.isArray(name)) {
      issues.push(`person ${person.id} has an invalid name entry`);
      continue;
    }
    if (typeof name.value !== "string" || !name.value.trim()) {
      issues.push(`person ${person.id} has a blank name value`);
      continue;
    }
    const key = name.value.trim().toLocaleLowerCase();
    if (seen.has(key)) issues.push(`person ${person.id} has duplicate name: ${name.value}`);
    seen.add(key);
    if (!personNameTypes.has(name.type)) {
      issues.push(`person ${person.id} has invalid name type: ${name.type}`);
    }
    for (const field of ["from", "to"]) {
      if (name[field] !== undefined && (typeof name[field] !== "string" || !name[field].trim())) {
        issues.push(`person ${person.id} name ${name.value} has invalid ${field}`);
      }
    }
    if (name.associatedPersonId !== undefined) {
      if (name.type !== "married") {
        issues.push(`person ${person.id} name ${name.value} may associate a person only when type is married`);
      }
      if (name.associatedPersonId === person.id || (personIds && !personIds.has(name.associatedPersonId))) {
        issues.push(`person ${person.id} name ${name.value} has invalid associatedPersonId`);
      }
    }
    if (name.sourceAtomIds !== undefined) {
      if (!Array.isArray(name.sourceAtomIds) || !name.sourceAtomIds.length
        || name.sourceAtomIds.some((id) => typeof id !== "string" || !id || (atomIds && !atomIds.has(id)))) {
        issues.push(`person ${person.id} name ${name.value} has invalid sourceAtomIds`);
      }
    }
    issues.push(...validateProofProjection(name.proof, `person ${person.id} name ${name.value}`));
    const allowed = new Set([
      "value", "type", "display", "from", "to", "associatedPersonId", "sourceAtomIds", "proof"
    ]);
    for (const field of Object.keys(name)) {
      if (!allowed.has(field)) issues.push(`person ${person.id} name ${name.value} has unknown field: ${field}`);
    }
  }
  return issues;
}
