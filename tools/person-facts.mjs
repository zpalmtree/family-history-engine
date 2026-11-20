const PLACE_NAMES = [
  "Nottinghamshire", "Whitehouse", "Waterville", "Maumee", "Staffordshire",
  "Stafford", "Bournemouth", "Christchurch", "Cardiff", "Bridgend", "Swansea",
  "Uttoxeter", "Ashbourne", "Kingstone", "Woodcock Heath", "Wall Heath",
  "Great Gidding", "Offord D'Arcy", "Offord", "Whittlesey", "Gnosall",
  "Newport Shropshire", "Hampton Lovett", "Droitwich", "Kidderminster",
  "Glapthorn", "Warmington", "Little Stukeley", "Finedon", "Ellastone",
  "Ellis Hill", "Blore Ray", "Wootton", "Wirksworth", "Gorseybank",
  "Hardywick", "Pickley Bank", "Sandon", "Over Fole", "Church Leigh",
  "Abbots Bromley", "Blithfield", "Newton", "Heatley", "Colwich", "Stowe",
  "Dover, Kent", "Dover", "Folksworth", "Weston", "Haskins", "Montour",
  "Albany, New York", "New York", "Pennsylvania", "Hancock, Ohio",
  "Pickaway", "Bloom Township", "Maryland", "Germany", "Italy", "Ohio"
].sort((first, second) => second.length - first.length);

const OCCUPATION_PATTERNS = [
  [/licensed victualler/i, "Licensed victualler"],
  [/labourer\s*\/\s*poulterer/i, "Labourer / poulterer"],
  [/farmer and wheelwright/i, "Farmer / wheelwright"],
  [/cattle dealer/i, "Cattle dealer"],
  [/pig dealer/i, "Pig dealer"],
  [/\bblacksmith\b/i, "Blacksmith"],
  [/\bbricklayer\b/i, "Bricklayer"],
  [/\bschoolmaster\b/i, "Schoolmaster"],
  [/\bcarpenter\b/i, "Carpenter"],
  [/\bsawyer\b/i, "Sawyer"],
  [/\bgrocer\b/i, "Grocer"],
  [/\bpoulterer\b/i, "Poulterer"],
  [/\blabourer\b/i, "Labourer"],
  [/\bwheelwright\b/i, "Wheelwright"],
  [/\bfarmer\b/i, "Farmer"],
  [/\bclerk\b/i, "Clerk"]
];

const EVENT_DATE_SOURCE = "(?:about\\s+|c\\.?\\s*)?(?:\\d{1,2}\\s+[A-Za-z]{3,9}\\s+)?(?:1[5-9]\\d{2}|20\\d{2})(?:/\\d{2,4})?";

export function structuredPerson(person, generationProfiles = []) {
  const profile = bestGenerationProfile(person, generationProfiles);
  const eventFacts = personEvents(person, profile);
  const notes = [text(profile?.note), text(person.meta)]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(readableLegacyText)
    .filter((value, index, values) => values.indexOf(value) === index);
  return {
    id: person.id,
    name: person.name,
    status: person.status,
    privacy: person.privacy,
    lifeStatus: eventFacts.living ? "living" : eventFacts.died ? "deceased" : "unknown",
    events: [
      eventFacts.born ? { type: "birth", date: eventFacts.born } : null,
      eventFacts.baptized ? { type: "baptism", date: eventFacts.baptized } : null,
      eventFacts.died ? { type: "death", date: eventFacts.died } : null,
      eventFacts.married ? { type: "marriage", date: eventFacts.married } : null
    ].filter(Boolean),
    places: associatedPlaces(person, profile),
    occupations: occupations(person, profile),
    summary: readableLegacyText(text(person.meta).trim()),
    notes
  };
}

function readableLegacyText(value) {
  return text(value)
    .replace(/(^|\|\s*)bap\.\s*/gi, "$1Baptized ")
    .replace(/(^|\|\s*)b\.\s*/gi, "$1Born ")
    .replace(/(^|\|\s*)d\.\s*/gi, "$1Died ")
    .replace(/(^|\|\s*)m\.\s*/gi, "$1Married ")
    .trim();
}

function yearsIn(value) {
  return [...text(value).matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]));
}

function bestGenerationProfile(person, candidates) {
  if (!candidates.length) return null;
  const canonicalYears = new Set(yearsIn(person.meta));
  return [...candidates].sort((first, second) => {
    const score = (candidate) => {
      const sharedYears = yearsIn(candidate.dates)
        .filter((year) => canonicalYears.has(year)).length;
      return sharedYears * 10 + (candidate.name === person.name ? 2 : 0);
    };
    return score(second) - score(first);
  })[0];
}

function personEvents(person, generationProfile) {
  const events = { living: false, born: "", baptized: "", died: "", married: "" };
  const source = [generationProfile?.dates, person.meta].filter(Boolean).join(" | ");
  events.living = /\bliving\b(?!\s+status\s+unknown)/i.test(source);
  const labelledEvents = [
    ["baptized", /(?:bap\.?|baptised|baptized)/i],
    ["married", /(?:m\.?|married|marriage)/i],
    ["born", /(?:b\.?|born|birth)/i],
    ["died", /(?:d\.?|died|death)/i]
  ];
  for (const segment of source.split(/[|;]/)) {
    const cleanSegment = segment.trim();
    for (const [key, label] of labelledEvents) {
      const prefix = cleanSegment.match(new RegExp(`^${label.source}\\s*(?::|on)?\\s*(${EVENT_DATE_SOURCE})`, "i"));
      const phrase = cleanSegment.match(new RegExp(`\\b${label.source}\\s*(?::|on)?\\s*(${EVENT_DATE_SOURCE})`, "i"));
      const match = prefix || phrase;
      if (match) events[key] = preferEventDate(events[key], match[1]);
    }
  }
  const range = source.match(new RegExp(
    `(?:^|[|;]\\s*)(${EVENT_DATE_SOURCE})\\s*(?:-|–|—|to)\\s*(${EVENT_DATE_SOURCE})(?=\\s*(?:[|;]|$|,))`,
    "i"
  ));
  if (range) {
    events.born = preferEventDate(events.born, range[1]);
    events.died = preferEventDate(events.died, range[2]);
  }
  return events;
}

function cleanerEventDate(value) {
  return text(value).replace(/\s+/g, " ").replace(/^c\.\s*/i, "c. ").trim();
}

function preferEventDate(current, candidate) {
  if (!candidate) return current;
  const clean = cleanerEventDate(candidate);
  return !current || clean.length > current.length ? clean : current;
}

function associatedPlaces(person, generationProfile) {
  const profilePlace = text(generationProfile?.place).trim();
  if (profilePlace && !/unknown|not supplied/i.test(profilePlace)) {
    return [profilePlace];
  }
  const source = text(person.meta);
  const matches = [];
  for (const place of PLACE_NAMES) {
    if (source.toLowerCase().includes(place.toLowerCase())
      && !matches.some((existing) => existing.toLowerCase().includes(place.toLowerCase())
        || place.toLowerCase().includes(existing.toLowerCase()))) {
      matches.push(place);
    }
  }
  return matches.slice(0, 3);
}

function occupations(person, generationProfile) {
  const source = `${text(person.meta)} ${text(generationProfile?.note)}`;
  const match = OCCUPATION_PATTERNS.find(([pattern]) => pattern.test(source));
  return match ? [match[1]] : [];
}

function text(value) {
  return value == null ? "" : String(value);
}
