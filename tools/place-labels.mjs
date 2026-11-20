import { loadTreeConfig } from "./tree-config.mjs";

// The countries the engine ships flags for, plus any a tree adds in
// tree.config.json places.countries ([{ name, flag }]).
export const baseCountryFlags = Object.freeze({
  England: "england",
  Germany: "de",
  Ireland: "ie",
  Italy: "it",
  Scotland: "scotland",
  "United States": "us",
  Wales: "wales"
});

// ISO 3166 codes for countries a tree commonly adds; a country without flag
// artwork in assets/flags shows its code as a badge instead.
export const countryCodes = Object.freeze({
  Argentina: "ar", Australia: "au", Austria: "at", Belgium: "be", Brazil: "br", Canada: "ca", Chile: "cl", China: "cn",
  Croatia: "hr", Cuba: "cu", "Czech Republic": "cz", Czechia: "cz", Denmark: "dk", Estonia: "ee", Finland: "fi", France: "fr",
  Greece: "gr", Hungary: "hu", India: "in", Jamaica: "jm", Japan: "jp", Latvia: "lv", Lithuania: "lt", Luxembourg: "lu",
  Malta: "mt", Mexico: "mx", Netherlands: "nl", "New Zealand": "nz", "Northern Ireland": "gb-nir", Norway: "no",
  Philippines: "ph", Poland: "pl", Portugal: "pt", "Puerto Rico": "pr", Romania: "ro", Russia: "ru", Serbia: "rs",
  Slovakia: "sk", Slovenia: "si", "South Africa": "za", Spain: "es", Sweden: "se", Switzerland: "ch", Ukraine: "ua"
});

export function configuredCountries(config = loadTreeConfig()) {
  return (config.places?.countries || []).filter((entry) => entry && typeof entry.name === "string" && entry.name.trim())
    .map((entry) => ({ name: entry.name.trim(), flag: entry.flag || countryCodes[entry.name.trim()] || null }));
}

export const placeCountries = new Set([...Object.keys(baseCountryFlags), ...configuredCountries().map((entry) => entry.name)]);

export const placeRoles = new Set([
  "associated",
  "baptism-place",
  "birthplace",
  "burial-place",
  "death-place",
  "marriage-place",
  "residence"
]);

export const usStateCodes = new Map(Object.entries({
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "District of Columbia": "DC"
}));

const forbiddenPlaceName = /(?:\/|;|\b(?:avenue|cemetery|county|farm|lead|road|street|township)\b)/i;

export function formatPlaceRow(row) {
  const name = clean(row?.name);
  const state = clean(row?.state);
  const country = clean(row?.country);
  if (country === "United States") {
    return [name, state, "USA"].filter(Boolean).join(", ");
  }
  return name ? `${name}, ${country}` : country;
}

export function validatePlaceRow(row, label = "place row") {
  const issues = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return [`${label} must be an object`];
  if (!Array.isArray(row.assertionIds) || !row.assertionIds.length
    || row.assertionIds.some((id) => typeof id !== "string" || !id)) {
    issues.push(`${label} requires non-empty assertionIds`);
  }
  const name = clean(row.name);
  const state = clean(row.state);
  const country = clean(row.country);
  if (!placeCountries.has(country)) issues.push(`${label} has invalid country: ${country || "(missing)"}`);
  if (row.name !== undefined && row.name !== name) issues.push(`${label} name is not trimmed`);
  if (row.recordedYear !== undefined && (!Number.isInteger(row.recordedYear)
    || row.recordedYear < 1000 || row.recordedYear > 2100)) {
    issues.push(`${label} recordedYear must be a documented calendar year`);
  }
  if (row.state !== undefined && row.state !== state) issues.push(`${label} state is not trimmed`);
  if (name && forbiddenPlaceName.test(name)) issues.push(`${label} name is not a compact locality: ${name}`);
  if (name?.includes(",")) issues.push(`${label} name must not contain a comma: ${name}`);
  if (country === "United States") {
    if (state && !usStateCodes.has(state)) issues.push(`${label} has invalid U.S. state: ${state}`);
    if (name && !state) issues.push(`${label} U.S. locality requires a state`);
  } else if (state) {
    issues.push(`${label} non-U.S. place must not contain a state`);
  }
  if (!formatPlaceRow(row)) issues.push(`${label} produces a blank display value`);
  return issues;
}

export function placeRowKey(row, role = row?.role) {
  return `${role || ""}\u0000${row.country}\u0000${formatPlaceRow(row).toLocaleLowerCase()}`;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

const ENGLISH_COUNTIES = ["Bedfordshire", "Berkshire", "Buckinghamshire", "Cambridgeshire", "Cheshire", "Cornwall", "Cumberland", "Derbyshire", "Devon", "Dorset", "Durham",
  "Essex", "Gloucestershire", "Hampshire", "Herefordshire", "Hertfordshire", "Huntingdonshire", "Isle of Wight", "Kent", "Lancashire", "Leicestershire", "Lincolnshire", "London",
  "Middlesex", "Norfolk", "Northamptonshire", "Northumberland", "Nottinghamshire", "Oxfordshire", "Rutland", "Shropshire", "Somerset", "Staffordshire", "Suffolk", "Surrey",
  "Sussex", "Warwickshire", "Westmorland", "Wiltshire", "Worcestershire", "Yorkshire"];
const WELSH_COUNTIES = ["Anglesey", "Breconshire", "Caernarfonshire", "Cardiganshire", "Carmarthenshire", "Denbighshire", "Flintshire", "Glamorgan", "Merionethshire",
  "Monmouthshire", "Montgomeryshire", "Pembrokeshire", "Radnorshire"];

/**
 * The present-day country (and American state) of a place written "town, county" or
 * "town, state", read from its last part. A place it does not recognise gets nothing:
 * a story names a country only when a fact supplies one, so this never guesses.
 */
export function areaForPlace(place) {
  const last = String(place || "").split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  if (usStateCodes.has(last)) return { country: "United States", state: last };
  if (placeCountries.has(last)) return { country: last };
  if (ENGLISH_COUNTIES.includes(last)) return { country: "England" };
  if (WELSH_COUNTIES.includes(last)) return { country: "Wales" };
  return null;
}
