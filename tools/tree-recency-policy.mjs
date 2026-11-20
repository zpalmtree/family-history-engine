import { createHash } from "node:crypto";

export const TREE_RECENCY_POLICY_ID = "visible-tree-recency-v2";
export const LEGACY_VISIBLE_PERSON_IDS_SHA256 = "1321c3502c16f93788290d60dd0de51ebdcfe3e4d6b06020141fc186bc0d69ab";
export const EMPTY_LEGACY_SHA256 = createHash("sha256").update("[]").digest("hex");

export function validateTreeRecencyPolicy({ people, visualPersonIds, baseline, now = Date.now() }) {
  const issues = [];
  if (baseline?.schemaVersion !== 2 || baseline?.policyId !== TREE_RECENCY_POLICY_ID
    || !Array.isArray(baseline?.legacyVisiblePersonIds)
    || !Array.isArray(baseline?.firstVisibleEntries)) {
    return ["tree recency ledger has unsupported schema"];
  }

  const legacyIds = new Set();
  for (const personId of baseline.legacyVisiblePersonIds) {
    if (typeof personId !== "string" || !personId) {
      issues.push("tree recency legacy snapshot contains an invalid person ID");
      continue;
    }
    if (legacyIds.has(personId)) issues.push(`tree recency legacy snapshot repeats ${personId}`);
    legacyIds.add(personId);
  }
  const legacyDigest = createHash("sha256")
    .update(JSON.stringify(baseline.legacyVisiblePersonIds))
    .digest("hex");
  // A tree that adopted the policy from the start grandfathers nobody: its
  // legacy snapshot is empty. Otherwise the snapshot is frozen at its digest.
  const expectedLegacyDigest = baseline.legacyVisiblePersonIds.length ? LEGACY_VISIBLE_PERSON_IDS_SHA256 : EMPTY_LEGACY_SHA256;
  if (baseline.legacySnapshotSha256 !== expectedLegacyDigest
    || legacyDigest !== expectedLegacyDigest) {
    issues.push("tree recency legacy snapshot changed; it is frozen and cannot grandfather new people");
  }

  const firstVisibleById = new Map();
  for (const entry of baseline.firstVisibleEntries) {
    const personId = entry?.personId;
    if (typeof personId !== "string" || !personId) {
      issues.push("tree recency first-visible ledger contains an invalid person ID");
      continue;
    }
    if (legacyIds.has(personId)) {
      issues.push(`tree recency first-visible ledger repeats legacy person ${personId}`);
      continue;
    }
    if (firstVisibleById.has(personId)) {
      issues.push(`tree recency first-visible ledger repeats ${personId}`);
      continue;
    }
    if (strictTreeTimestamp(entry.firstVisibleAt) === null) {
      issues.push(`${personId} has invalid firstVisibleAt; use an RFC 3339 timestamp with an explicit offset`);
    }
    firstVisibleById.set(personId, entry.firstVisibleAt);
  }

  const visualIds = new Set(visualPersonIds);
  const peopleById = new Map(people.map((person) => [person.personId, person]));
  const nowMs = normalizeNow(now);

  for (const person of people) {
    const firstVisibleAt = firstVisibleById.get(person.personId);
    if (person.treeAddedAt !== undefined) {
      const addedAtMs = strictTreeTimestamp(person.treeAddedAt);
      if (addedAtMs === null) {
        issues.push(`${person.personId} has invalid treeAddedAt; use an RFC 3339 timestamp with an explicit offset`);
      } else if (!Number.isFinite(nowMs) || addedAtMs > nowMs) {
        issues.push(`${person.personId} has future treeAddedAt`);
      }
      if (!firstVisibleAt) {
        issues.push(`${person.personId} has treeAddedAt but no first-visible ledger entry`);
      } else if (person.treeAddedAt !== firstVisibleAt) {
        issues.push(`${person.personId} treeAddedAt does not match immutable firstVisibleAt`);
      }
    } else if (firstVisibleAt) {
      issues.push(`${person.personId} has a first-visible ledger entry but no canonical treeAddedAt`);
    }
  }

  for (const [personId, firstVisibleAt] of firstVisibleById) {
    if (!peopleById.has(personId)) {
      issues.push(`first-visible ledger entry ${personId} has no canonical person bundle`);
      continue;
    }
    const firstVisibleMs = strictTreeTimestamp(firstVisibleAt);
    if (firstVisibleMs !== null && (!Number.isFinite(nowMs) || firstVisibleMs > nowMs)) {
      issues.push(`${personId} has future firstVisibleAt`);
    }
  }

  for (const personId of visualIds) {
    const person = peopleById.get(personId);
    if (!person) {
      issues.push(`visible tree node ${personId} has no canonical person bundle`);
      continue;
    }
    if (!legacyIds.has(personId) && !firstVisibleById.has(personId)) {
      issues.push(`${personId} is newly visible; run npm run tree:recency:stamp -- --person ${personId}`);
    }
  }
  return issues;
}

export function createTreeRecencyStamp({ person, baseline, visualPersonIds, timestamp }) {
  const personId = person?.personId;
  if (typeof personId !== "string" || !personId) throw new Error("tree recency stamp requires a canonical person ID");
  if (!new Set(visualPersonIds).has(personId)) throw new Error(`${personId} is not visible in any protected tree view`);
  if (baseline?.schemaVersion !== 2 || baseline?.policyId !== TREE_RECENCY_POLICY_ID) {
    throw new Error("tree recency ledger has unsupported schema");
  }
  if (baseline.legacyVisiblePersonIds.includes(personId)) throw new Error(`${personId} is already in the frozen legacy snapshot`);
  if (baseline.firstVisibleEntries.some((entry) => entry.personId === personId)) {
    throw new Error(`${personId} already has a first-visible ledger entry`);
  }
  if (person.treeAddedAt !== undefined) throw new Error(`${personId} already has treeAddedAt without a ledger entry`);
  if (strictTreeTimestamp(timestamp) === null) {
    throw new Error("tree recency stamp requires an RFC 3339 timestamp with an explicit offset");
  }

  const { schemaVersion, personId: stablePersonId, ...rest } = person;
  return {
    person: {
      schemaVersion,
      personId: stablePersonId,
      treeAddedAt: timestamp,
      ...rest
    },
    baseline: {
      ...baseline,
      firstVisibleEntries: [
        ...baseline.firstVisibleEntries,
        { personId: stablePersonId, firstVisibleAt: timestamp }
      ]
    }
  };
}

export function strictTreeTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond = "000", zone, sign, offsetHour, offsetMinute] = match;
  if (Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59) return null;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return null;
  const offsetMinutes = zone === "Z"
    ? 0
    : (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const local = new Date(timestampMs + offsetMinutes * 60_000);
  const parts = [
    local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()
  ];
  const expected = [year, month, day, hour, minute, second, millisecond].map(Number);
  return parts.every((part, index) => part === expected[index]) ? timestampMs : null;
}

function normalizeNow(now) {
  return now instanceof Date ? now.getTime()
    : typeof now === "string" ? Date.parse(now) : Number(now);
}
