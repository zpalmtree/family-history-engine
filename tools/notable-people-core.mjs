// Notable people: a curated set of the tree's more interesting ancestors
// (knights, gentry, office-holders, the wealthy, unusual trades, voyagers).
//
// The canonical list is evidence/notable-people.json, kept by hand with the help
// of `npm run notable -- --candidates`, which scans established facts for signs
// of distinction. Each entry gives a category, one short reason line written for
// the viewer, and the assertion ids the reason rests on. The viewer shows an
// entry only while every basis assertion exists and is established, so a later
// correction to the research can never leave a boast standing on a withdrawn
// fact: the entry is withheld (and `npm run notable` lists it) instead of
// failing anyone's deploy.

import fs from "node:fs";

export const NOTABLE_FILE_SCHEMA_VERSION = 1;

// Annual consumer price indices (tools/data/price-history.json, with its sources)
// for showing a sum in approximate 2024 money.
let priceHistory = null;
export function loadPriceHistory() {
  priceHistory ||= JSON.parse(fs.readFileSync(new URL("./data/price-history.json", import.meta.url), "utf8"));
  return priceHistory;
}

const currencySymbols = { GBP: "£", USD: "$" };

/** Rounds to two significant figures, written for a reader: "£580,000", "$1.2 million". */
export function formatApproxMoney(value, currency) {
  const symbol = currencySymbols[currency];
  if (value >= 1e6) {
    const millions = value / 1e6;
    const shown = millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
    return `${symbol}${shown} million`;
  }
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(value, 1))) - 1);
  return `${symbol}${(Math.round(value / magnitude) * magnitude).toLocaleString("en-GB")}`;
}

/** A historical sum in approximate 2024 money, by consumer prices, or null when the year is not covered. */
export function moneyToday({ amount, currency, year }, prices = loadPriceHistory()) {
  const series = prices[String(currency).toLowerCase()];
  const then = series?.[String(year)];
  const now = series?.[String(prices.baseYear)];
  if (!then || !now || !(amount > 0)) return null;
  const value = amount * now / then;
  return { value: Math.round(value), baseYear: prices.baseYear, text: `about ${formatApproxMoney(value, currency)} today` };
}

// In the order the viewer lists them, most distinguished first.
export const notableCategories = Object.freeze([
  { id: "knight", label: "Knights and their ladies", short: "Knighthood" },
  { id: "gentry", label: "Gentry and arms", short: "Gentry" },
  { id: "office", label: "Office and standing", short: "Office" },
  { id: "wealth", label: "Wealth and land", short: "Wealth" },
  { id: "service", label: "War and service", short: "Service" },
  { id: "voyage", label: "Voyages and new beginnings", short: "Voyage" },
  { id: "trade", label: "Remarkable trades", short: "Trade" },
  { id: "story", label: "Remarkable lives", short: "Lives" }
]);
const categoryIds = new Set(notableCategories.map((category) => category.id));
const MAX_REASON = 90;
const ENTRY_KEYS = new Set(["personId", "category", "reason", "basis", "rank", "money"]);
const DECLINED_KEYS = new Set(["personId", "why"]);

/** Structural problems in the curation file itself. These fail the check. */
export function validateNotableFile(file) {
  const issues = [];
  if (!file || file.schemaVersion !== NOTABLE_FILE_SCHEMA_VERSION) return [`schemaVersion must be ${NOTABLE_FILE_SCHEMA_VERSION}`];
  if (!Array.isArray(file.people)) issues.push("people must be an array");
  if (!Array.isArray(file.declined)) issues.push("declined must be an array");
  if (issues.length) return issues;
  const seen = new Set();
  for (const [index, entry] of file.people.entries()) {
    const where = `people[${index}]${entry?.personId ? ` (${entry.personId})` : ""}`;
    for (const key of Object.keys(entry || {})) if (!ENTRY_KEYS.has(key)) issues.push(`${where}: unknown key ${key}`);
    if (typeof entry?.personId !== "string" || !entry.personId) { issues.push(`${where}: personId is required`); continue; }
    if (seen.has(entry.personId)) issues.push(`${where}: listed twice`);
    seen.add(entry.personId);
    if (!categoryIds.has(entry.category)) issues.push(`${where}: unknown category ${entry.category}`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) issues.push(`${where}: reason is required`);
    else if (entry.reason.length > MAX_REASON) issues.push(`${where}: reason is over ${MAX_REASON} characters`);
    else if (/\s$|^\s|\.$/.test(entry.reason)) issues.push(`${where}: reason must be trimmed and carry no full stop`);
    if (!Array.isArray(entry.basis) || !entry.basis.length || entry.basis.some((id) => typeof id !== "string" || !id)) {
      issues.push(`${where}: basis must list at least one assertion id`);
    }
    if (entry.rank !== undefined && !(Number.isInteger(entry.rank) && entry.rank >= 1 && entry.rank <= 9)) {
      issues.push(`${where}: rank must be an integer from 1 (most notable) to 9`);
    }
    if (entry.money !== undefined) {
      const money = entry.money || {};
      if (Object.keys(money).some((key) => !["amount", "currency", "year"].includes(key))) issues.push(`${where}: money takes only amount, currency and year`);
      if (!(typeof money.amount === "number" && money.amount > 0)) issues.push(`${where}: money.amount must be a positive number`);
      if (!currencySymbols[money.currency]) issues.push(`${where}: money.currency must be GBP or USD`);
      else if (!Number.isInteger(money.year) || !moneyToday(money)) issues.push(`${where}: money.year ${money.year} has no ${money.currency} price index`);
    }
  }
  for (const [index, entry] of file.declined.entries()) {
    const where = `declined[${index}]${entry?.personId ? ` (${entry.personId})` : ""}`;
    for (const key of Object.keys(entry || {})) if (!DECLINED_KEYS.has(key)) issues.push(`${where}: unknown key ${key}`);
    if (typeof entry?.personId !== "string" || !entry.personId) issues.push(`${where}: personId is required`);
    else if (seen.has(entry.personId)) issues.push(`${where}: also listed as notable`);
    if (typeof entry?.why !== "string" || !entry.why.trim()) issues.push(`${where}: why is required`);
  }
  return issues;
}

/**
 * Which entries can be shown. An entry is shown only when its person exists and
 * every basis assertion exists and is established. Returns the distinctions by
 * person id and the withheld entries with their reason.
 */
export function projectNotablePeople(file, store) {
  const byPerson = new Map();
  const withheld = [];
  if (!file || validateNotableFile(file).length) return { byPerson, withheld };
  const people = new Map(store.people.map((bundle) => [bundle.personId, bundle]));
  const aliases = new Map((store.personIdAliases?.aliases || []).map((item) => [item.alias, item.canonicalPersonId]));
  // A basis may be a union or kinship assertion too (a knight's wife rests on
  // his knighthood and their marriage).
  const assertions = new Map();
  for (const owner of [...store.people, ...(store.unions || []), ...(store.kinships || [])]) {
    for (const assertion of owner.assertions || []) assertions.set(assertion.id, assertion);
  }
  for (const entry of file.people) {
    const personId = aliases.get(entry.personId) || entry.personId;
    if (!people.has(personId)) { withheld.push({ entry, why: "person not found" }); continue; }
    const weak = entry.basis.filter((id) => assertions.get(id)?.assessment !== "established");
    if (weak.length) {
      withheld.push({ entry, why: weak.map((id) => assertions.has(id) ? `${id} is ${assertions.get(id).assessment}` : `${id} not found`).join("; ") });
      continue;
    }
    byPerson.set(personId, {
      category: entry.category,
      reason: entry.reason,
      ...(entry.rank ? { rank: entry.rank } : {}),
      ...(entry.money ? { today: moneyToday(entry.money).text } : {}),
      assertionIds: [...entry.basis]
    });
  }
  return { byPerson, withheld };
}

// Signs of distinction in an established fact's wording. Matching is only a
// shortlist for a person to judge: nothing is shown until it is curated.
const SIGNS = [
  ["knight", /\bknight(ed|hood)?\b|\bSir [A-Z]|\bdame\b|\bbaronet\b|\blord of\b|\bbaron(e|essa)?\b|\bnobil[ei]\b|\bcavalier[ei]\b|\bRitter\b|\bFreiherr|\bAdel/i],
  ["gentry", /\besquire\b|\besq\.?\b|\bgentleman\b|\bgentlemen\b|\bgent\.?\b|\barmiger|\bcoat of arms\b|\bvisitation\b|\bpedigree\b.*\bherald|\bcrest\b|\bmanor\b|\bpossident[ei]\b|\bproprietari[oa]\b|\bbenestant[ei]\b|\bgalantuom|\bcivile\b|\b(Don|Donna|Magnifico|Signor)\s+[A-Z]|\bJunker\b|\bGutsbesitzer|\bHofbauer|\bgenerosus\b|\bdominus\b/i],
  ["office", /\bmayor\b|\balderman\b|\bsheriff\b|\bbailiff\b|\bchurchwarden\b|\bconstable\b|\bjustice of the peace\b|\bcoroner\b|\bparliament\b|\bschulthei|\bvillage (court|council)\b|\bGerichtsverwandter\b|\bdes Raths\b|\bofficial\b|\bsteward\b|\breeve\b|\bpostmaster\b|\bcouncillor\b|\bmagistrate\b|\btreasurer\b|\btrustee\b|\bMaster Mason\b|\bschoolmaster\b|\bclerk of\b|\bsindac[oi]\b|\bdecurion|\bcancellier|\beletto\b|\bcamerlengo\b|\bB(ü|ue)rgermeister|\bAmtmann|\bVogt\b|\bRichter\b|\bGericht|\bAnwalt|\bconsul\b/i],
  ["wealth", /£\s?\d|GBP\s?\d|\$\s?\d|\bacres\b|\bestate\b.*\b(valued|worth|sworn|of)\b|\bpersonal estate\b|\breal estate\b|\bplantation\b|\bfarms?\b.*\bowned\b/i],
  ["service", /\bregiment\b|\bmilitia\b|\bsoldier\b|\btrooper\b|\barmy\b|\bnavy\b|\bR\.?A\.?F\b|\bair force\b|\byeomanry\b|\bserved in\b|\bveteran\b|\bcalled up\b|\bdemobili[sz]ed\b|\bwar\b|\bofficer\b|\bcaptain\b|\blieutenant\b|\bsergeant\b|\bcorporal\b/i],
  ["voyage", /\bemigrat|\bimmigra|\bnaturali[sz]|\bsailed\b|\baboard\b|\barrived at New York\b|\bcame to America\b|\bpioneer|\bfirst of the\b/i],
  ["trade", /\bmariner\b|\bsea\b|\bcaptain\b|\bmaster of\b|\btower-?keeper\b|\btorriere\b|\bmidwife\b|\binnkeeper\b|\bhotel keeper\b|\bvictualler\b|\bmerchant\b|\bironmonger\b|\bminer\b|\brockgetter\b|\bband leader\b|\bmusician\b|\bschoolmaster\b|\bforest|\bboatman\b|\bwaterman\b|\bflatman\b|\bcoachmaker\b|\bwagon-?maker\b|\bbrazier\b|\bcopper ?smith\b|\bclockmaker\b|\bsurgeon\b|\bphysician\b|\bapothecary\b|\bclergy|\bvicar\b|\brector\b|\bminister\b|\bpriest\b|\bvaticale\b|\bmulattier|\bnotai?[oa]\b|\bnotar|\bsacerdot|\bprete\b|\bcanonico\b|\bmedico\b|\bspeziale\b|\bfarmacist|\bmaestro\b|\bmastro\b|\bguardia\b|\bcarabinier|\bPfarrer\b|\bSchulmeister|\bM(ü|ue)ller\b|\bWirt\b|\bApotheker|\bChirurg|\bBader\b/i],
  ["story", /\bfoundling\b|\besposit[oa]\b|\babandoned\b|\bruota\b|\btwins?\b|\btriplets\b|\bcentenarian|\baged (9[5-9]|1\d\d)\b|\bmurder|\bdrowned\b|\bexecuted\b|\bshipwreck|\bprison|\bgaol\b|\bjail\b|\bbankrupt|\bdivorce|\billegitimate\b|\bmafi(a|oso|osi)\b|\bblack hand\b|\bmano nera\b|\bcamorr|\bndrangheta|\bpicciott|\bbrigan(d|te|ti)\b|\bgang(ster|land)?\b|\bracketeer|\bbootleg|\bprohibition\b|\bextortion|\bestorsion|\barrested\b|\bcharged with\b|\bindicted\b|\bconvicted\b|\bsentenced\b|\bacquitted\b|\bpenitentiary\b|\bcarcer|\bcondannat|\bfugitive\b|\bdeported\b/i]
];
const SCANNED_KINDS = new Set(["life-fact", "occupation", "narrative", "event"]);
const LONG_LIFE_YEARS = 90;

/** Facts that hint a person may be notable, grouped by person. */
export function detectNotableSigns(store) {
  const found = new Map();
  for (const bundle of store.people) {
    for (const assertion of bundle.assertions || []) {
      const claim = assertion.claim || {};
      if (assertion.assessment !== "established" || !SCANNED_KINDS.has(claim.kind)) continue;
      const text = [claim.value, claim.organization, claim.role, claim.rank].filter((part) => typeof part === "string").join(" ");
      const categories = SIGNS.filter(([category, pattern]) =>
        pattern.test(text) || (category === "gentry" && claim.category === "heraldry")
          || (category === "office" && claim.category === "civic-community-role")
          || (category === "service" && /^military/.test(claim.category || ""))
          || (category === "voyage" && (["migration", "naturalization"].includes(claim.category) || claim.eventType === "emigration")))
        .map(([category]) => category);
      if (!categories.length) continue;
      if (!found.has(bundle.personId)) found.set(bundle.personId, []);
      found.get(bundle.personId).push({ assertionId: assertion.id, categories, text: text || claim.eventType || claim.kind });
    }
    // A long life, from established birth (or baptism) and death (or burial) years.
    const year = (types) => (bundle.assertions || []).filter((assertion) => assertion.assessment === "established"
      && assertion.claim?.kind === "event" && types.includes(assertion.claim.eventType))
      .map((assertion) => ({ id: assertion.id, year: Number(String(assertion.claim.dateText || "").match(/\b(1\d{3}|20\d{2})\b/)?.[0]) }))
      .filter((item) => item.year);
    const born = year(["birth", "baptism"]).sort((a, b) => a.year - b.year)[0];
    const died = year(["death", "burial"]).sort((a, b) => b.year - a.year)[0];
    if (born && died && died.year - born.year >= LONG_LIFE_YEARS) {
      if (!found.has(bundle.personId)) found.set(bundle.personId, []);
      found.get(bundle.personId).push({ assertionId: died.id, categories: ["story"], text: `Lived to about ${died.year - born.year} (${born.id} and ${died.id})` });
    }
  }
  return found;
}

/** People with signs who are neither listed nor declined in the curation file. */
export function uncuratedCandidates(file, store, { onTree = null } = {}) {
  const curated = new Set([...(file?.people || []), ...(file?.declined || [])].map((entry) => entry.personId));
  return [...detectNotableSigns(store)]
    .filter(([personId]) => !curated.has(personId) && (!onTree || onTree.has(personId)))
    .map(([personId, signs]) => ({ personId, signs }));
}
