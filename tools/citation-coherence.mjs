export const legacyCitationContextNote = "Legacy citation association retained for source discovery only; these assertions have no canonical evidence edge to a source in this citation and are excluded from fact-level proof navigation.";

export function citationProofSourceIds(citation, assertion) {
  const citationSourceIds = new Set(citation?.sourceIds || []);
  return [...new Set((assertion?.evidence || [])
    .map((item) => item.sourceId)
    .filter((sourceId) => citationSourceIds.has(sourceId)))];
}

export function citationSupportsAssertion(citation, assertion) {
  return citationProofSourceIds(citation, assertion).length > 0;
}

export function partitionCitationAssertions(citation, assertions) {
  const proofAssertionIds = [];
  const contextAssertionIds = [];
  const ids = [...new Set([
    ...(citation?.assertionIds || []),
    ...(citation?.contextAssertionIds || [])
  ])];
  for (const assertionId of ids) {
    const assertion = assertions.get(assertionId);
    if (assertion && citationSupportsAssertion(citation, assertion)) proofAssertionIds.push(assertionId);
    else contextAssertionIds.push(assertionId);
  }
  return { proofAssertionIds, contextAssertionIds };
}

export function buildCitationIdsByAssertion(citations, assertions) {
  const result = new Map();
  for (const citation of citations) {
    for (const assertionId of citation.assertionIds || []) {
      const assertion = assertions.get(assertionId);
      if (!assertion || !citationSupportsAssertion(citation, assertion)) continue;
      if (!result.has(assertionId)) result.set(assertionId, []);
      result.get(assertionId).push(citation.id);
    }
  }
  return result;
}
