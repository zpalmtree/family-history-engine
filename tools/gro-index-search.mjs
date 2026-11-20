const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function unparsedGroIndexPairs(pairs, entries) {
  return pairs.filter((pair) => !entries.some((entry) =>
    ["name", "maternalSurname", "reference"].every((field) => clean(entry[field]) === clean(pair[field]))));
}

// Exploratory index searches never share the exact-reference/order matcher.
export function groIndexSearchBounds(target, mode = "index") {
  if (target.groIndexSearch == null) return null;
  const range = target.groIndexSearch.yearRange;
  // A surname-only pass leaves the forename blank so every same-sex entry under
  // the exact surname, district and range is read; it must be asked for
  // explicitly and its target names the surname alone.
  const surnameOnly = target.groIndexSearch.surnameOnly;
  const nameWords = clean(target.person).split(" ").filter(Boolean).length;
  if (mode !== "index" || target.readyForPaidOrder !== false || target.event !== "birth"
      || !Number.isInteger(range) || range < 0 || range > 2
      || !/^\d{4}$/.test(String(target.year)) || !/^(Male|Female)$/.test(target.sex)
      || ![undefined, true, false].includes(surnameOnly)
      || (surnameOnly === true ? nameWords !== 1 : nameWords < 2) || !clean(target.groDistrict)
      || target.quarter || target.volume || target.page || target.groMotherMaidenSurname
      || target.nationalIndex?.motherMaidenSurname) {
    throw new Error("Exploratory GRO search requires index-only paused birth target, exact name, sex, district and a 0–2 year range; reference/MMN filters are forbidden.");
  }
  const names = clean(target.person).toUpperCase().split(" ");
  return { surname: names.at(-1), forename: surnameOnly === true ? "" : names[0], surnameOnly: surnameOnly === true,
    year: Number(target.year), yearRange: range, from: Number(target.year) - range, to: Number(target.year) + range,
    sex: target.sex, district: clean(target.groDistrict) };
}

export function verifyGroIndexSearchFields(fields, target, birthSelected = false) {
  const bounds = groIndexSearchBounds(target);
  if (!bounds) throw new Error("No exploratory GRO query supplied.");
  const expected = { surname: bounds.surname, ...(bounds.surnameOnly ? {} : { "first-forename": bounds.forename }),
    district: bounds.district, year: String(bounds.year), "year-range": String(bounds.yearRange), sex: bounds.sex };
  const issues = birthSelected ? [] : ["birth-event"];
  for (const [purpose, value] of Object.entries(expected)) {
    const candidates = fields.filter((field) => field.purpose === purpose);
    if (candidates.length !== 1 || ![candidates[0]?.value, candidates[0]?.text].some((actual) => clean(actual).toUpperCase() === value.toUpperCase())) issues.push(purpose);
  }
  if (bounds.surnameOnly && fields.some((field) => field.purpose === "first-forename")) issues.push("first-forename");
  const cleared = ["second-forename-clear", "mother-maiden-surname-clear", "volume-clear", "page-clear", "quarter-clear"];
  for (const purpose of bounds.surnameOnly ? ["first-forename-clear", ...cleared] : cleared) {
    const found = fields.filter((field) => field.purpose === purpose);
    if (found.length !== 1 || clean(found[0]?.value)) issues.push(purpose);
  }
  for (const purpose of ["match-mode-SurnameMatches", "match-mode-ForenameMatches", "match-mode-MothersSurnameMatches"]) {
    const matches = fields.filter((field) => field.purpose === purpose);
    if (matches.length !== 1 || !/^exact(?: matches)?(?: only)?$/i.test(clean(matches[0]?.text))) issues.push(purpose);
  }
  return { ok: issues.length === 0, issues, bounds };
}

export function parseGroIndexSearchPairs(pairs, target) {
  const bounds = groIndexSearchBounds(target);
  if (!bounds) throw new Error("No exploratory GRO query supplied.");
  return pairs.flatMap((pair) => {
    const name = clean(pair.name);
    const named = bounds.surnameOnly
      ? name.toUpperCase().match(/^([^,]+)(?:,\s*(.*))?$/)
      : name.toUpperCase().match(/^([^,]+),\s*(\S+)(?:\s|$)/);
    const reference = clean(pair.reference);
    const ref = reference.match(/^GRO Reference:\s*(\d{4})\s+([MJSD])\s+Quarter in\s+(.+?)\s+Volume\s+(\S+)\s+Page\s+(\d+)\s*$/i);
    // GRO prints some districts with a county suffix ("CHRISTCHURCH, HANTS"); the
    // query district never carries one, so compare on the district name alone.
    const districtKey = (value) => clean(value).toUpperCase().replace(/,.*$/, "").trim().replace(/^THE /, "").replace(/ UNION$/, "");
    if (!named || clean(named[1]) !== bounds.surname || (!bounds.surnameOnly && named[2] !== bounds.forename) || !ref
        || districtKey(ref[3]) !== districtKey(bounds.district)
        || Number(ref[1]) < bounds.from || Number(ref[1]) > bounds.to) return [];
    return [{ name, maternalSurname: clean(pair.maternalSurname), reference }];
  });
}
