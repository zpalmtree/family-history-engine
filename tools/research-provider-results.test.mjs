import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertBoundedNegativeEligible,
  boundedNegativeAttemptFromAdapterResult,
  boundedNegativeEligibility,
  isVerifiedBoundedNegativeAttempt,
  normalizeProviderAdapterResult,
} from "./research-provider-results.mjs";

function zeroResult() {
  return {
    schemaVersion: 1,
    provider: "freereg",
    operation: "index-results",
    status: "completed",
    candidates: [],
    coverage: {
      scope: "All Staffordshire baptisms from 1780 through 1790 for three documented surname variants.",
      paginationComplete: true,
      truncated: false,
      providerCoverageVerified: true,
      verificationBasis: "The provider coverage page confirms the named parish, event class, and date range; every result page was read.",
    },
  };
}

test("normalizes provider results against scaffolded capability operations", () => {
  const result = zeroResult();
  result.candidates.push({
    url: "https://www.freereg.org.uk/search_records/abc?token=removed&locale=en",
    text: "  Jane   Example  ",
  });
  const normalized = normalizeProviderAdapterResult(result);
  assert.equal(normalized.candidates[0].text, "Jane Example");
  assert.equal(normalized.candidates[0].url, "https://www.freereg.org.uk/search_records/abc?locale=en");
});

test("only complete, untruncated, verified zero results qualify as bounded negatives", () => {
  const result = zeroResult();
  assert.equal(boundedNegativeEligibility(result).eligible, true);
  assert.equal(assertBoundedNegativeEligible(result).status, "completed");

  for (const mutation of [
    (value) => { value.coverage.paginationComplete = false; },
    (value) => { value.coverage.truncated = true; },
    (value) => { value.coverage.providerCoverageVerified = false; delete value.coverage.verificationBasis; },
    (value) => { value.candidates.push({ text: "one candidate" }); },
  ]) {
    const unsafe = zeroResult();
    mutation(unsafe);
    assert.equal(boundedNegativeEligibility(unsafe).eligible, false);
    assert.throws(() => assertBoundedNegativeEligible(unsafe), /complete, untruncated, verified provider coverage/);
  }
});

test("bounded-negative attempts carry a versioned structured coverage proof", () => {
  const attempt = boundedNegativeAttemptFromAdapterResult(zeroResult());
  assert.deepEqual(attempt, {
    outcome: "not-found-bounded",
    scope: {
      coverageContractVersion: 1,
      coverage: "All Staffordshire baptisms from 1780 through 1790 for three documented surname variants.",
      paginationComplete: true,
      truncated: false,
      providerCoverageVerified: true,
      verificationBasis: "The provider coverage page confirms the named parish, event class, and date range; every result page was read.",
    },
  });
  assert.equal(isVerifiedBoundedNegativeAttempt(attempt), true);
  assert.equal(isVerifiedBoundedNegativeAttempt({ outcome: "not-found-bounded", scope: { coverage: "legacy text only" } }), false);
});

test("gate actors remain explicit in normalized adapter results", () => {
  const signIn = normalizeProviderAdapterResult({
    schemaVersion: 1,
    provider: "familysearch",
    operation: "page-context",
    status: "needs-user",
    candidates: [],
    gate: { actor: "user", reason: "interactive-sign-in", retryWhen: "The shared profile sign-in completes." },
  });
  assert.equal(signIn.gate.actor, "user");
  assert.throws(() => normalizeProviderAdapterResult({ ...signIn, gate: { ...signIn.gate, actor: "system" } }), /require a user gate/);

  const systemWait = normalizeProviderAdapterResult({
    schemaVersion: 1,
    provider: "archion",
    operation: "catalog-results",
    status: "waiting-system",
    candidates: [],
    gate: { actor: "system", reason: "provider-rate-window", retryWhen: "The provider retry window opens." },
  });
  assert.equal(systemWait.gate.actor, "system");
});

test("attempt recorders require the structured bounded-negative coverage guard", () => {
  for (const name of ["record-research-attempt.mjs", "record-acquisition-attempt.mjs"]) {
    const source = fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.match(source, /--coverage-basis/);
    assert.match(source, /--pagination-complete/);
    assert.match(source, /--results-untruncated/);
    assert.match(source, /--provider-coverage-verified/);
    assert.match(source, /verifiedBoundedCoverage/);
  }
});
