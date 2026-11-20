const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

// The third column is the mother's maiden surname in the birth index and the
// age at death in the death index. A target that names its event must see
// that event's column; without one either index layout is recognized.
const thirdColumnByEvent = { birth: "mother's maiden surname", death: "age at death (in years)" };

export function groIndexEventOfHeaders(headers) {
  const labels = headers.map((header) => normalize(header).replace(/[’‘]/g, "'").replace(/:$/, "").toLowerCase());
  if (labels.length !== 3 || labels[1] !== "name") return null;
  return Object.keys(thirdColumnByEvent).find((event) => thirdColumnByEvent[event] === labels[2]) || null;
}

export function hasGroIndexHeaders(headers, event) {
  const found = groIndexEventOfHeaders(headers);
  return found !== null && (!normalize(event) || found === normalize(event).toLowerCase());
}

export function groIndexCoverage({ kind, count, text, candidateCount, entries, headers, event }) {
  const headerRecognized = hasGroIndexHeaders(headers, event);
  return {
    candidateCount, capturedCount: entries.length, headers, headerRecognized,
    complete: headerRecognized && kind === "results" && count === entries.length
      && candidateCount <= 50 && /Showing Page 1 of 1\b/i.test(text)
  };
}

function volumeKey(value) {
  const text = normalize(value).toUpperCase();
  if (/^\d+[A-Z]?$/.test(text)) return text.replace(/^0+(?=\d)/, "");
  if (!/^[IVXLCDM]+$/.test(text)) return text;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return String([...text].reduce((sum, letter, index) =>
    sum + (values[letter] < (values[text[index + 1]] || 0) ? -values[letter] : values[letter]), 0));
}

// GRO puts the name/MMN in one row and its reference in the next row.
// Only immediate pairs supplied by the DOM reader are eligible; never search
// forward through another candidate to find a matching reference.
export function parseGroIndexPairs(pairs, target) {
  const names = normalize(target.person).toUpperCase().split(" ");
  const surname = names.at(-1);
  const firstName = names[0];
  const quarter = { MAR: "M", JUN: "J", SEP: "S", DEC: "D" }[normalize(target.quarter).slice(0, 3).toUpperCase()];
  if (!quarter) return [];
  return pairs.flatMap((pair) => {
    const name = normalize(pair.name);
    const match = name.toUpperCase().match(/^([^,]+),\s*(\S+)(?:\s|$)/);
    const reference = normalize(pair.reference);
    const ref = reference.match(/^GRO Reference:\s*(\d{4})\s+([MJSD])\s+Quarter in\s+(.+?)\s+Volume\s+(\S+)\s+Page\s+(\d+)\s*$/i);
    if (!match || match[1] !== surname || match[2] !== firstName || !ref) return [];
    if (ref[1] !== String(target.year) || (quarter && ref[2].toUpperCase() !== quarter)
        || volumeKey(ref[4]) !== volumeKey(target.volume)
        || Number(ref[5]) !== Number(target.page)) return [];
    // The DOM reader always puts the third cell in maternalSurname; in the death
    // index that cell is the age, kept there for pair identity and named here.
    if (normalize(target.event).toLowerCase() === "death") {
      const ageAtDeath = normalize(pair.maternalSurname);
      if (normalize(target.groAgeAtDeath) && normalize(target.groAgeAtDeath) !== ageAtDeath) return [];
      return [{ name, maternalSurname: ageAtDeath, ageAtDeath, reference }];
    }
    return [{ name, maternalSurname: normalize(pair.maternalSurname), reference }];
  });
}

export function groIndexRowText(entry) {
  return entry.ageAtDeath !== undefined
    ? `${entry.name} | Age at death: ${entry.ageAtDeath} | ${entry.reference}`
    : `${entry.name} | Mother's maiden surname: ${entry.maternalSurname} | ${entry.reference}`;
}
