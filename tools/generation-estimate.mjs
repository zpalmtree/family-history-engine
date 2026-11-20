// An estimated birth window for people with no dated birth or baptism, reckoned
// from their relatives' dates at a typical generation length. It is a display
// aid, never a claim: the viewer labels it as an estimate and names the dated
// relative it is nearest to.
//
// Model: each person's birth year is a variable. A parent is born about 32
// (father) or 28 (mother) years before a child, spouses about 3 years apart, a
// death or burial about 55 years after birth, a marriage about 27, and the first
// record naming someone about 30. Those are Gaussian links; people with a dated
// birth or baptism are fixed. Solving each connected group of undated people by
// least squares pools every dated relative at once (a son's baptism and a
// grandfather's burial both count) and gives a spread that widens with each
// generation from a date. Hard limits then trim the window: nobody is born after
// their own burial, the first record naming them, a visitation pedigree listing
// them, or less than 13 years before a child.

const VITAL_YEAR = /\b(1[0-9]{3}|20[0-9]{2})(?:\/(\d{1,2}))?\b/g;

const STEP = {
  father: { gap: 32, sd: 8 },
  mother: { gap: 28, sd: 6 },
  unknown: { gap: 30, sd: 7.5 }
};
const SPOUSE = { gap: 3, sd: 7 }; // husband born about 3 years before his wife
const DEATH = { gap: 55, sd: 18 };
const MARRIAGE = { gap: 27, sd: 7 };
const FIRST_RECORD = { gap: 30, sd: 15 };
const MIN_PARENT_AGE = 13;
const MAX_SD = 30; // wider than this says nothing useful
const Z = 1.28; // an 80% window

/** Years in a date text, Old Style read as modern; null when it has none. */
export function dateYears(text) {
  const years = [...String(text || "").matchAll(VITAL_YEAR)].map((match) => {
    const year = Number(match[1]);
    if (!match[2]) return year;
    const unit = match[2].length === 1 ? 10 : 100;
    let modern = year - (year % unit) + Number(match[2]);
    if (modern < year) modern += unit;
    return modern - year === 1 ? modern : year;
  });
  return years.length ? { low: Math.min(...years), high: Math.max(...years) } : null;
}

// A birth or baptism date as { year, sd }, or null.
function birthObservation(events) {
  for (const type of ["birth", "baptism"]) {
    for (const event of events || []) {
      if (event.type !== type) continue;
      const years = dateYears(event.date);
      if (!years) continue;
      const loose = /about|circa|\bc\.|abt|estimated|from age/i.test(event.date) ? 2 : 0;
      return {
        year: (years.low + years.high) / 2,
        sd: 1 + loose + (years.high - years.low) / 2,
        type,
        date: event.date
      };
    }
  }
  return null;
}

function firstYear(events, types) {
  const years = (events || []).filter((event) => types.includes(event.type))
    .map((event) => dateYears(event.date)).filter(Boolean);
  return years.length ? { low: Math.min(...years.map((y) => y.low)), high: Math.max(...years.map((y) => y.high)) } : null;
}

/**
 * personId -> { from, to, nearest: { personId, type, date, generations } } for
 * every deceased or unknown-status person with no dated birth or baptism whose
 * relatives place them within a useful window. `nearest` is the closest
 * relative (never a living one) with a dated birth or baptism; `generations` is
 * how many generations they sit below (positive) or above (negative) the person.
 */
export function generationEstimates(people, { parents = [], couples = [] } = {}) {
  const byId = new Map(people.map((person) => [person.id, person]));
  const fixed = new Map();
  for (const person of people) {
    const observed = birthObservation(person.events);
    // Someone who may still be alive is used for the reckoning but never named.
    const living = person.lifeStatus === "living"
      || (person.lifeStatus !== "deceased" && observed?.year > new Date().getFullYear() - 110);
    if (observed) fixed.set(person.id, { ...observed, living });
  }
  const free = people.filter((person) => !fixed.has(person.id)).map((person) => person.id);
  const unary = new Map(free.map((id) => [id, []]));
  const pairs = [];
  const neighbours = new Map(people.map((person) => [person.id, []]));
  const upper = new Map(); // birth no later than
  const lower = new Map(); // birth no earlier than
  const tighten = (map, id, value, pick) => {
    if (value == null || !Number.isFinite(value)) return;
    map.set(id, map.has(id) ? pick(map.get(id), value) : value);
  };

  for (const id of free) {
    const person = byId.get(id);
    const death = firstYear(person.events, ["death", "burial"]);
    if (death) {
      unary.get(id).push({ mean: (death.low + death.high) / 2 - DEATH.gap, sd: DEATH.sd + (death.high - death.low) / 2 });
      tighten(upper, id, death.high, Math.min);
    }
    const marriage = firstYear(person.events, ["marriage"]);
    if (marriage) {
      unary.get(id).push({ mean: (marriage.low + marriage.high) / 2 - MARRIAGE.gap, sd: MARRIAGE.sd + (marriage.high - marriage.low) / 2 });
      tighten(upper, id, marriage.low - MIN_PARENT_AGE, Math.min);
    }
    const span = person.recordedSpan;
    if (span && span.kind !== "pedigree") {
      if (!death && !marriage) unary.get(id).push({ mean: span.from - FIRST_RECORD.gap, sd: FIRST_RECORD.sd });
      tighten(upper, id, span.from, Math.min);
      tighten(lower, id, span.to - 100, Math.max);
    }
    if (span?.kind === "pedigree") tighten(upper, id, span.from, Math.min);
  }

  // Edge from a to b: birth(b) - birth(a) ~ N(gap, sd).
  const link = (a, b, gap, sd) => {
    neighbours.get(a)?.push({ id: b, generations: gap > 15 ? 1 : gap < -15 ? -1 : 0 });
    neighbours.get(b)?.push({ id: a, generations: gap > 15 ? -1 : gap < -15 ? 1 : 0 });
    const fa = fixed.get(a);
    const fb = fixed.get(b);
    if (fa && fb) return;
    if (fa) return unary.get(b).push({ mean: fa.year + gap, sd: Math.hypot(sd, fa.sd) });
    if (fb) return unary.get(a).push({ mean: fb.year - gap, sd: Math.hypot(sd, fb.sd) });
    pairs.push({ a, b, gap, sd });
  };
  for (const relation of parents) {
    if (!byId.has(relation.parentId) || !byId.has(relation.childId)) continue;
    const step = STEP[relation.role] || STEP.unknown;
    link(relation.parentId, relation.childId, step.gap, step.sd);
  }
  for (const couple of couples) {
    if (!byId.has(couple.leftPersonId) || !byId.has(couple.rightPersonId)) continue;
    const [husband, wife] = couple.rightRole === "father"
      ? [couple.rightPersonId, couple.leftPersonId] : [couple.leftPersonId, couple.rightPersonId];
    link(husband, wife, SPOUSE.gap, SPOUSE.sd);
  }

  const solved = solveGroups(free, unary, pairs);
  propagateBounds(parents, byId, fixed, upper, lower);

  const estimates = new Map();
  for (const id of free) {
    const person = byId.get(id);
    if (person.lifeStatus === "living") continue;
    const result = solved.get(id);
    if (!result || result.sd > MAX_SD) continue;
    let from = result.mean - Z * result.sd;
    let to = result.mean + Z * result.sd;
    if (upper.has(id)) to = Math.min(to, upper.get(id));
    if (lower.has(id)) from = Math.max(from, lower.get(id));
    if (from > to) from = to - 10;
    from = Math.floor(from / 5) * 5;
    to = Math.ceil(to / 5) * 5;
    if (upper.has(id)) to = Math.min(to, upper.get(id));
    if (person.lifeStatus !== "deceased" && to > new Date().getFullYear() - 110) continue;
    const nearest = nearestDated(id, neighbours, fixed);
    if (!nearest) continue;
    estimates.set(id, { from, to, nearest });
  }
  return estimates;
}

// Least squares per connected group of undated people, with the variance of
// each solution from the inverse of the group's precision matrix.
function solveGroups(free, unary, pairs) {
  const index = new Map(free.map((id, i) => [id, i]));
  const parent = free.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const { a, b } of pairs) parent[find(index.get(a))] = find(index.get(b));
  const groups = new Map();
  free.forEach((id, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  });
  const pairsByGroup = new Map();
  for (const pair of pairs) {
    const root = find(index.get(pair.a));
    if (!pairsByGroup.has(root)) pairsByGroup.set(root, []);
    pairsByGroup.get(root).push(pair);
  }
  const out = new Map();
  for (const [root, ids] of groups) {
    if (!ids.some((id) => unary.get(id).length)) continue;
    const n = ids.length;
    const local = new Map(ids.map((id, i) => [id, i]));
    const Q = Array.from({ length: n }, () => new Float64Array(n));
    const h = new Float64Array(n);
    ids.forEach((id, i) => {
      Q[i][i] += 1e-8; // keeps a group with one dated end solvable
      h[i] += 1e-8 * 1700;
      for (const { mean, sd } of unary.get(id)) {
        Q[i][i] += 1 / sd ** 2;
        h[i] += mean / sd ** 2;
      }
    });
    for (const { a, b, gap, sd } of pairsByGroup.get(root) || []) {
      const i = local.get(a);
      const j = local.get(b);
      const w = 1 / sd ** 2;
      Q[i][i] += w; Q[j][j] += w; Q[i][j] -= w; Q[j][i] -= w;
      h[i] -= gap * w; h[j] += gap * w;
    }
    const inverse = invert(Q);
    ids.forEach((id, i) => {
      let mean = 0;
      for (let k = 0; k < n; k += 1) mean += inverse[i][k] * h[k];
      out.set(id, { mean, sd: Math.sqrt(inverse[i][i]) });
    });
  }
  return out;
}

// Gauss-Jordan inverse of a symmetric positive-definite matrix.
function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row) => Float64Array.from(row));
  const inv = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    row[i] = 1;
    return row;
  });
  for (let col = 0; col < n; col += 1) {
    const pivot = a[col][col];
    for (let k = 0; k < n; k += 1) { a[col][k] /= pivot; inv[col][k] /= pivot; }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let k = 0; k < n; k += 1) { a[row][k] -= factor * a[col][k]; inv[row][k] -= factor * inv[col][k]; }
    }
  }
  return inv;
}

// A parent is born at least 13 years before a child: a child's latest possible
// birth caps the parent's, and a parent's earliest floors the child's.
function propagateBounds(parents, byId, fixed, upper, lower) {
  const latest = (id) => fixed.get(id)?.year ?? upper.get(id);
  const earliest = (id) => fixed.get(id)?.year ?? lower.get(id);
  for (let pass = 0; pass < 40; pass += 1) {
    let changed = false;
    for (const { parentId, childId } of parents) {
      if (!byId.has(parentId) || !byId.has(childId)) continue;
      const childLatest = latest(childId);
      if (childLatest != null && !fixed.has(parentId)) {
        const cap = childLatest - MIN_PARENT_AGE;
        if (!upper.has(parentId) || upper.get(parentId) > cap) { upper.set(parentId, cap); changed = true; }
      }
      const parentEarliest = earliest(parentId);
      if (parentEarliest != null && !fixed.has(childId)) {
        const floor = parentEarliest + MIN_PARENT_AGE;
        if (!lower.has(childId) || lower.get(childId) < floor) { lower.set(childId, floor); changed = true; }
      }
    }
    if (!changed) break;
  }
}

// The closest relative with a dated birth or baptism, by steps through parents,
// children and spouses (fewest steps, then fewest generations). A living
// relative is passed through but never named.
function nearestDated(start, neighbours, fixed) {
  const seen = new Set([start]);
  let frontier = [{ id: start, generations: 0 }];
  while (frontier.length) {
    const found = frontier.filter(({ id }) => id !== start && fixed.has(id) && !fixed.get(id).living);
    if (found.length) {
      const best = found.sort((x, y) => Math.abs(x.generations) - Math.abs(y.generations) || x.id.localeCompare(y.id))[0];
      const observed = fixed.get(best.id);
      return { personId: best.id, type: observed.type, date: observed.date, generations: best.generations };
    }
    const next = [];
    for (const { id, generations } of frontier) {
      for (const edge of neighbours.get(id) || []) {
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        next.push({ id: edge.id, generations: generations + edge.generations });
      }
    }
    frontier = next;
  }
  return null;
}
