// The years in which archived records name a person, for people with no dated
// birth, baptism, death or burial. The viewer shows it as "Named in records
// 1675–1689": it anchors a person in time without claiming when they were born
// or died, so a baptism is still never read as a birth and a record naming
// someone after their death ("son of the late John") stays truthful.

// Records whose date is not the date a person was named: later printed or
// compiled works and directories. Gravestones are left out because no fact is
// taken from a stone. (A "-control" record id is only an acquisition label: its
// verified people are named in it like any other record's.)
const LATER_OR_SECONDARY = /history|printed|compiled|pedigree|directory|catalogue|gravestone|memorial/i;
// A heralds' visitation pedigree was taken in its visitation year, but it also
// lists earlier generations, so its year is only a last-resort anchor and is
// labelled as a pedigree.
const VISITATION = /visitation/i;
const VITAL_TYPES = new Set(["birth", "baptism", "death", "burial"]);
const YEAR = /\b(1[0-9]{3}|20[0-9]{2})(?:\/(\d{1,2}))?\b/g;

/** One year for a record's viewer date, or null when the date is missing, spans years, or is not the record's own. */
export function recordYear(record) {
  const years = recordYears(record);
  return years.length === 1 ? years[0] : null;
}

/**
 * The years of a record's own dated entries: one for a single date, several for
 * a list of separate dates ("1762 and 1764"), none for a span or a later work.
 */
export function recordYears(record, { allowLater = false } = {}) {
  const date = String(record?.viewer?.date || "");
  if (!date || /undated|catalogued|unresolved/i.test(date)) return [];
  if (!allowLater && LATER_OR_SECONDARY.test(String(record?.viewer?.category || ""))) return [];
  if (/\bbetween\b/i.test(date)) return [dateYear(date)].filter(Boolean);
  const parts = date.split(/\s+and\s+|\s*;\s*/);
  if (parts.length > 1 && parts.every((part) => dateYear(part))) return [...new Set(parts.map(dateYear))];
  return [dateYear(date)].filter(Boolean);
}

// One year for one date, or null when it spans more than a year.
function dateYear(date) {
  const years = [...String(date).matchAll(YEAR)].map((match) => {
    const year = Number(match[1]);
    if (!match[2]) return year;
    // Old Style "17 Feb 1722/23" is 1723 by the modern year.
    const unit = match[2].length === 1 ? 10 : 100;
    let modern = year - (year % unit) + Number(match[2]);
    if (modern < year) modern += unit;
    return modern - year === 1 ? modern : year;
  });
  if (!years.length) return null;
  const low = Math.min(...years);
  const high = Math.max(...years);
  return high - low <= 1 ? high : null;
}

// A child's or spouse's death record, or a child's marriage, often names a person
// long after their own death ("son of the late John"), so it is only a later
// mention: its earliest year is used when nothing else names them. Their own
// marriage, a child's baptism, a census, deed or will names them directly.
const DEATH_CATEGORY = /death|burial|buried|obituar|funeral|interment|cemetery/i;
const MARRIAGE_CATEGORY = /marriage|wedding|banns|allegation|matrimon/i;

/** personId -> { years, laterMentions, pedigrees }: distinct years of the records verified to name them. */
export function recordYearsByPerson(records, { childrenOf = new Map(), spousesOf = new Map() } = {}) {
  const byPerson = new Map();
  const entry = (personId) => {
    if (!byPerson.has(personId)) byPerson.set(personId, { years: new Set(), laterMentions: new Set(), pedigrees: new Set() });
    return byPerson.get(personId);
  };
  for (const record of records || []) {
    const category = String(record.viewer?.category || "");
    const named = new Set(record.people || []);
    if (VISITATION.test(category)) {
      const [year] = recordYears(record, { allowLater: true });
      if (year && recordYears(record, { allowLater: true }).length === 1) for (const personId of named) entry(personId).pedigrees.add(year);
      continue;
    }
    const years = recordYears(record);
    if (!years.length) continue;
    const namesAny = (ids) => [...(ids || [])].some((id) => named.has(id));
    for (const personId of named) {
      const children = childrenOf.get(personId);
      const later = (DEATH_CATEGORY.test(category) && !/will/i.test(category)
        && (namesAny(children) || namesAny(spousesOf.get(personId))))
        || (MARRIAGE_CATEGORY.test(category) && namesAny(children));
      for (const year of years) entry(personId)[later ? "laterMentions" : "years"].add(year);
    }
  }
  return byPerson;
}

function eventYear(value) {
  const match = String(value || "").match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * { from, to } for a deceased or unknown-status person with no dated vital event,
 * from their other dated events (a marriage), their established dated life facts
 * (a residence, an age stated in 1614) and the records that name them. With
 * none of those, the earliest visitation pedigree naming them gives
 * { from, to, kind: "pedigree" }.
 */
export function recordedSpan({ lifeStatus, events, biographyFacts }, named, { recordsById = new Map() } = {}) {
  if (lifeStatus === "living") return null;
  if ((events || []).some((event) => VITAL_TYPES.has(event.type) && eventYear(event.date))) return null;
  // A fact dated only by the later history that reports it ("the 1897 sketch
  // reports...") carries that book's year, not a year of the person's life.
  const reportedLater = (fact, year) => (fact.proof?.viewerRecordIds || []).some((id) => {
    const record = recordsById.get(id);
    if (!record || VISITATION.test(String(record.viewer?.category || ""))) return false;
    return LATER_OR_SECONDARY.test(String(record.viewer?.category || ""))
      && recordYears(record, { allowLater: true }).includes(year);
  });
  const facts = (biographyFacts || [])
    .filter((fact) => fact.proof?.assessment === "established")
    .map((fact) => ({ fact, year: dateYear(fact.dateText || "") }))
    .filter(({ fact, year }) => year && !reportedLater(fact, year))
    .map(({ year }) => year);
  const years = [
    ...(named?.years || []),
    ...(events || []).map((event) => eventYear(event.date)).filter(Boolean),
    ...facts
  ];
  if (!years.length && named?.laterMentions?.size) years.push(Math.min(...named.laterMentions));
  if (years.length) return { from: Math.min(...years), to: Math.max(...years) };
  if (named?.pedigrees?.size) {
    const year = Math.min(...named.pedigrees);
    return { from: year, to: year, kind: "pedigree" };
  }
  return null;
}
