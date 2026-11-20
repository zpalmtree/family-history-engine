// Provider access gates: one identity per provider account, and reopening of
// sign-in/subscription gates once access is known to be back.
//
// Before this module, a sign-in gate was recorded per acquisition route and
// stayed active until someone hand-edited it, even after the provider was
// visibly working again: FamilySearch gates from July 2026 were still listed as
// NEEDS USER in October while dozens of FamilySearch reads succeeded. Venue
// labels were also built from the target's collection-laden provider string,
// so one Findmypast sign-in appeared as several unrelated user actions.

export const signInStatus = "needs-interactive-sign-in";
export const subscriptionStatus = "needs-subscription-purchase";
export const reopenNotePrefix = "Access gate reopened";
export const maxAutomaticReopens = 2;

const providerLabels = {
  familysearch: "FamilySearch",
  findmypast: "Findmypast",
  ancestry: "Ancestry",
  tna: "The National Archives",
  mdlandrec: "MDLandRec",
  msa: "Maryland State Archives",
  archion: "Archion",
  antenati: "Antenati"
};

// Outcomes that can only be produced by reading a record behind the
// provider's account wall. Search-result outcomes are excluded because
// Ancestry and Findmypast show masked results to signed-out visitors.
const authenticatedAcquisitionOutcomes = new Set(["acquired-original", "archived-pending-upload"]);
const familySearchQuestionOutcomes = new Set(["located", "candidate-found", "not-found-bounded"]);

export function canonicalAccessProvider(label = "", sourceUrl = "") {
  const value = String(label).trim().toLowerCase();
  if (value.startsWith("familysearch")) return "familysearch"; // the Digital Library uses the same account
  if (value.startsWith("findmypast")) return "findmypast";
  if (value.startsWith("ancestry")) return "ancestry";
  if (value.startsWith("the national archives") || value === "tna" || value.startsWith("tna ")) return "tna";
  if (value.startsWith("maryland state archives land records") || value.startsWith("mdlandrec")) return "mdlandrec";
  if (value.startsWith("maryland state archives")) return "msa";
  if (value.startsWith("archion")) return "archion";
  if (value.startsWith("antenati")) return "antenati";
  const host = hostOf(sourceUrl);
  if (host.endsWith("familysearch.org")) return "familysearch";
  if (/(^|\.)findmypast\.co(m|\.uk)$/.test(host)) return "findmypast";
  if (/(^|\.)ancestry\.(com|co\.uk)$/.test(host)) return "ancestry";
  if (host.endsWith("nationalarchives.gov.uk")) return "tna";
  return value.split(",")[0].replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown-provider";
}

export function accessProviderLabel(providerId, fallback = "") {
  return providerLabels[providerId] || String(fallback).split(",")[0].trim() || providerId;
}

export function routeAccessProvider(route = {}, target = {}) {
  return canonicalAccessProvider(route.provider || target.provider, route.sourceUrl);
}

export function signInVenue(providerId, fallbackLabel) {
  return { id: `sign-in-${providerId}`, label: `${accessProviderLabel(providerId, fallbackLabel)} sign-in` };
}

export function subscriptionVenue(providerId, fallbackLabel) {
  return {
    id: `subscription-${providerId}`,
    label: `${accessProviderLabel(providerId, fallbackLabel)} subscription access or supplied originals`
  };
}

// Latest evidence, per provider, that its account session was live (an
// authenticated read) or was not (a sign-in gate). The later of the two wins.
export function providerAccessSignals({ acquisitionTargets = [], questionAttempts = [] } = {}) {
  const signals = new Map();
  const note = (providerId, kind, at) => {
    const time = Date.parse(at);
    if (!providerId || !Number.isFinite(time)) return;
    const entry = signals.get(providerId) || { lastSuccessAt: 0, lastSignInGateAt: 0 };
    if (kind === "success") entry.lastSuccessAt = Math.max(entry.lastSuccessAt, time);
    else entry.lastSignInGateAt = Math.max(entry.lastSignInGateAt, time);
    signals.set(providerId, entry);
  };
  for (const target of acquisitionTargets) {
    for (const route of target.routes || []) {
      const providerId = routeAccessProvider(route, target);
      for (const attempt of route.attempts || []) {
        if (authenticatedAcquisitionOutcomes.has(attempt.outcome)) note(providerId, "success", attempt.attemptedAt);
        if (attempt.outcome === signInStatus) note(providerId, "gate", attempt.attemptedAt);
      }
    }
  }
  // FamilySearch requires a signed-in account for historical-record search, so
  // a recorded FamilySearch search result also proves a live session.
  for (const attempt of questionAttempts) {
    if (familySearchQuestionOutcomes.has(attempt?.outcome) && /familysearch/i.test(`${attempt.source || ""} ${attempt.query || ""}`)
      && !/\b(local|held|canonical)\b/i.test(attempt.source || "")) {
      note("familysearch", "success", attempt.attemptedAt);
    }
  }
  return signals;
}

export function automaticReopenCount(route = {}) {
  return (route.attempts || []).filter((attempt) => String(attempt.note || "").startsWith(reopenNotePrefix)).length;
}

// Providers that currently hold at least one open sign-in gate.
export function signInGatedProviders(acquisitionTargets = []) {
  const providers = new Set();
  for (const target of acquisitionTargets) {
    for (const route of target.routes || []) {
      if (route.status === signInStatus) providers.add(routeAccessProvider(route, target));
    }
  }
  return providers;
}

// Which gated routes may be reopened, and why. `signedIn` and `entitlement`
// carry providers whose access was just verified or reported; without them,
// only sign-in gates superseded by a later authenticated read are stale.
export function planGateReopenings(acquisitionTargets, {
  signals = providerAccessSignals({ acquisitionTargets }),
  signedIn = [],
  entitlement = [],
  force = false,
  targetIds = null
} = {}) {
  const signedInSet = new Set(signedIn);
  const entitlementSet = new Set(entitlement);
  const plan = [];
  const skipped = [];
  for (const target of acquisitionTargets) {
    if (targetIds && !targetIds.has(target.id)) continue;
    for (const route of target.routes || []) {
      if (![signInStatus, subscriptionStatus].includes(route.status)) continue;
      const providerId = routeAccessProvider(route, target);
      const lastGateAt = Math.max(0, ...(route.attempts || [])
        .filter((attempt) => attempt.outcome === route.status || attempt.outcome === signInStatus)
        .map((attempt) => Date.parse(attempt.attemptedAt) || 0), Date.parse(route.lastAttemptAt) || 0);
      let reason = null;
      if (route.status === subscriptionStatus) {
        if (entitlementSet.has(providerId)) reason = `${accessProviderLabel(providerId)} access was reported as changed`;
      } else if (signedInSet.has(providerId) || entitlementSet.has(providerId)) {
        reason = `${accessProviderLabel(providerId)} sign-in was verified`;
      } else {
        const signal = signals.get(providerId);
        if (signal && signal.lastSuccessAt > lastGateAt && signal.lastSuccessAt > signal.lastSignInGateAt) {
          reason = `a later authenticated ${accessProviderLabel(providerId)} read on ${new Date(signal.lastSuccessAt).toISOString().slice(0, 10)} superseded this sign-in gate`;
        }
      }
      if (!reason) continue;
      const priorReopens = automaticReopenCount(route);
      if (!force && priorReopens >= maxAutomaticReopens) {
        skipped.push({ target, route, providerId, reason: `already reopened ${priorReopens} times and gated again; treat it as a collection-specific restriction` });
        continue;
      }
      plan.push({ target, route, providerId, reason, restoredStatus: restoredRouteStatus(route, providerId) });
    }
  }
  return { plan, skipped };
}

export function restoredRouteStatus(route, providerId) {
  if (providerId === "ancestry" || providerId === "findmypast") return "ready-subscription-capture";
  if (providerId === "familysearch") return "ready-download";
  return "error-retryable";
}

// Mutates the target: records an auditable attempt and resolves the route gate.
export function applyGateReopening({ route, reason, restoredStatus }, { now, fingerprint }) {
  const timestamp = now.toISOString();
  const note = `${reopenNotePrefix}: ${reason}. Retry the route; a new gate is recorded if access is still missing.`.slice(0, 500);
  const attempt = {
    id: `attempt-${fingerprint({ routeId: route.id, outcome: restoredStatus, note }).slice(0, 16)}`,
    fingerprint: fingerprint({ routeId: route.id, outcome: restoredStatus, note }),
    attemptedAt: timestamp,
    outcome: outcomeForRouteStatus(restoredStatus),
    note
  };
  route.status = restoredStatus;
  route.lastAttemptAt = timestamp;
  route.attempts = [...(route.attempts || []), attempt];
  for (const gate of [route.gate, ...(route.gates || [])].filter(Boolean)) {
    if (gate.state === "active" && gate.actor === "user") {
      gate.state = "resolved";
      gate.resolvedAt = timestamp;
      gate.resolution = note;
    }
  }
  return attempt;
}

function outcomeForRouteStatus(status) {
  return status === "error-retryable" ? "retryable-error" : status;
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}
