// Exhibits: the things a person's page shows beside the documented life.
//
// An exhibit is stored once and reaches everyone it applies to: arms reach the
// people a source blazons them for, a place profile reaches everyone with a real
// role there, a trade note reaches everyone with that trade. Each one names the
// archived record that carries it, its credit and licence, and the date it was
// checked against its source. Nothing here is a fact about a person: facts stay in
// the proof store, and an exhibit only illustrates or explains.

import { areaForPlace, placeRoles } from "./place-labels.mjs";
import { renderShield, validateShield } from "./heraldry-shield.mjs";
import { privacyRestriction } from "./page-depth-core.mjs";

// In the order a page shows them.
export const exhibitKinds = Object.freeze([
  "portrait", "arms", "herald-ruling", "monument", "grave", "signature", "ship", "place", "trade", "print", "context"
]);
const REAL_PLACE_ROLES = [...placeRoles].filter((role) => role !== "associated");
// What an established, dated fact with a place says the place was to the person.
const EVENT_PLACE_ROLE = { birth: "birthplace", baptism: "baptism-place", marriage: "marriage-place", death: "death-place", burial: "burial-place" };
const LIVED_OR_WORKED = new Set(["residence", "business", "property", "employment", "education"]);

/**
 * The places a person's own established facts put them in: a baptism "at Ellastone,
 * Staffordshire", a residence "at Lane Farm, Wootton, Staffordshire". Most place rows are
 * still only "associated", so a place exhibit also reaches people through these. A fact
 * counts only when its place can be located (its own country, or a county or state at
 * the end of the place); nothing is guessed from a bare town.
 */
function placedFacts(assertions) {
  return assertions.filter((assertion) => assertion?.assessment === "established" && assertion.claim?.place)
    .map((assertion) => {
      const claim = assertion.claim;
      const area = claim.country ? { country: claim.country, ...(claim.state ? { state: claim.state } : {}) } : areaForPlace(claim.place);
      const role = claim.kind === "event" ? EVENT_PLACE_ROLE[claim.eventType] || null
        : claim.kind === "life-fact" ? (LIVED_OR_WORKED.has(claim.category) ? "residence" : null) : undefined;
      return role === undefined || !area ? null
        : { parts: String(claim.place).split(",").map((part) => part.trim().toLowerCase()).filter(Boolean), area, role };
    }).filter(Boolean);
}
const TOP_LEVEL = new Set([
  "schemaVersion", "id", "kind", "title", "caption", "citation", "credit", "licence", "sourceUrl",
  "checkedAt", "recordIds", "image", "drawing", "text", "appliesTo"
]);

const filled = (value) => typeof value === "string" && value.trim().length > 0;
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const isFraction = (value) => typeof value === "number" && value >= 0 && value <= 1;
const hasLivingPortraitApproval = (exhibit, person) =>
  exhibit.kind === "portrait" && isDate(person?.livingPhotoApprovedAt);

function personLinkForRecord(record, personId, sourcesById) {
  const source = sourcesById.get(record?.sourceAtomId || record?.id);
  return source?.personLinks?.find((item) => item.personId === personId);
}

function canShowImage(record) {
  return record?.viewer?.approved === true && record.rights === "family-viewer-approved" && record.privacy !== "restricted";
}

export function validateExhibits(exhibits, { store, records, generations = new Map() }) {
  const issues = [];
  const peopleById = new Map(store.people.map((bundle) => [bundle.personId, bundle]));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const sourcesById = new Map((store.sources || []).map((source) => [source.id, source]));
  // An exhibit shows a record as this person's own, so the record's link to the
  // person must be a confirmed identification. A candidate match belongs to the
  // research question until it is reviewed.
  const personLink = (recordId, personId) => personLinkForRecord(recordsById.get(recordId), personId, sourcesById);
  const seen = new Set();
  for (const exhibit of exhibits) {
    const label = `exhibit ${exhibit?.id || "(no id)"}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(exhibit?.id || ""))) issues.push(`${label}: invalid id`);
    if (seen.has(exhibit.id)) issues.push(`${label}: duplicate id`);
    seen.add(exhibit.id);
    if (exhibit.schemaVersion !== 1) issues.push(`${label}: unsupported schemaVersion`);
    for (const key of Object.keys(exhibit)) if (!TOP_LEVEL.has(key)) issues.push(`${label}: unknown field ${key}`);
    if (!exhibitKinds.includes(exhibit.kind)) issues.push(`${label}: invalid kind ${exhibit.kind}`);
    for (const field of ["title", "citation", "credit", "licence"]) {
      if (!filled(exhibit[field])) issues.push(`${label}: requires ${field}`);
    }
    // A context paragraph speaks for itself; every other exhibit needs a caption.
    if (!filled(exhibit.caption) && !(exhibit.kind === "context" && filled(exhibit.text))) issues.push(`${label}: requires caption`);
    if (filled(exhibit.caption) && exhibit.caption.length > 600) issues.push(`${label}: caption is over 600 characters; use text for the body`);
    if (exhibit.sourceUrl != null && !/^https:\/\/[^\s]+$/.test(String(exhibit.sourceUrl))) issues.push(`${label}: sourceUrl must be an https URL`);
    if (!isDate(exhibit.checkedAt)) issues.push(`${label}: requires checkedAt (YYYY-MM-DD)`);

    // Every exhibit rests on something archived, a drawn shield included.
    const recordIds = exhibit.recordIds;
    if (!Array.isArray(recordIds) || !recordIds.length) issues.push(`${label}: requires the archived record that carries it`);
    for (const id of Array.isArray(recordIds) ? recordIds : []) {
      if (!recordsById.has(id)) issues.push(`${label}: no such manifest record ${id}`);
    }

    if (!exhibit.image && !exhibit.drawing && !filled(exhibit.text)) issues.push(`${label}: needs an image, a drawing or text`);
    if (exhibit.kind === "portrait" && !exhibit.image) issues.push(`${label}: portrait requires an approved image`);
    if (exhibit.image) {
      const record = recordsById.get(exhibit.image.recordId);
      if (!(recordIds || []).includes(exhibit.image.recordId)) issues.push(`${label}: image record must be listed in recordIds`);
      else if (!canShowImage(record)) {
        issues.push(`${label}: image record ${exhibit.image.recordId} is not approved for the family viewer`);
      } else if (!/^image\//.test(record.mediaType || "")) {
        issues.push(`${label}: image record ${exhibit.image.recordId} is ${record.mediaType}; an exhibit image must be an image master`);
      }
      const crop = exhibit.image.crop;
      if (crop != null) {
        if (![crop.x, crop.y, crop.width, crop.height].every(isFraction) || crop.width <= 0 || crop.height <= 0
          || crop.x + crop.width > 1.0001 || crop.y + crop.height > 1.0001) {
          issues.push(`${label}: crop must be fractions of the image, inside it`);
        }
      }
      if (exhibit.image.alt != null && !filled(exhibit.image.alt)) issues.push(`${label}: image alt must not be empty`);
      if (exhibit.image.large != null && typeof exhibit.image.large !== "boolean") issues.push(`${label}: image large must be true or false`);
      for (const key of Object.keys(exhibit.image)) {
        if (!["recordId", "crop", "alt", "large"].includes(key)) issues.push(`${label}: unknown image field ${key}`);
      }
    }
    if (exhibit.drawing) {
      if (exhibit.kind !== "arms") issues.push(`${label}: only arms are drawn`);
      if (!filled(exhibit.drawing.basis)) issues.push(`${label}: a drawing must say what it is drawn from`);
      issues.push(...validateShield(exhibit.drawing.shield, `${label} drawing`));
    }

    const rules = exhibit.appliesTo || {};
    const people = rules.people || [];
    const places = rules.places || [];
    const occupations = rules.occupations || [];
    if (!people.length && !places.length && !occupations.length) issues.push(`${label}: applies to nobody`);
    for (const key of Object.keys(rules)) {
      if (!["people", "places", "occupations"].includes(key)) issues.push(`${label}: unknown appliesTo rule ${key}`);
    }
    // Arms belong to the people a source blazons them for, never to a surname or a place.
    if (["portrait", "arms", "herald-ruling", "signature", "grave"].includes(exhibit.kind) && (places.length || occupations.length)) {
      issues.push(`${label}: ${exhibit.kind} is linked to named people only`);
    }
    const listed = new Set();
    for (const entry of people) {
      const bundle = peopleById.get(entry?.personId);
      if (!bundle) {
        issues.push(`${label}: unknown person ${entry?.personId}`);
        continue;
      }
      if (listed.has(entry.personId)) issues.push(`${label}: lists ${entry.personId} twice`);
      listed.add(entry.personId);
      if ((bundle.researchScope || "main") !== "main") issues.push(`${label}: ${entry.personId} is outside the main scope`);
      if (entry.note != null && !filled(entry.note)) issues.push(`${label}: note for ${entry.personId} must not be empty`);
      if (entry.livingPhotoApprovedAt != null && !hasLivingPortraitApproval(exhibit, entry)) {
        issues.push(`${label}: living photo approval requires a portrait and date (YYYY-MM-DD)`);
      }
      const restriction = privacyRestriction(bundle, generations.has(entry.personId) ? generations.get(entry.personId) : null);
      if (restriction === "living" && !hasLivingPortraitApproval(exhibit, entry)) {
        issues.push(`${label}: ${entry.personId} may be living`);
      }
      if (exhibit.kind === "portrait" && personLink(exhibit.image?.recordId, entry.personId)?.identificationStatus !== "confirmed") {
        issues.push(`${label}: portrait image requires a confirmed source link to ${entry.personId}`);
      }
      for (const recordId of Array.isArray(recordIds) ? recordIds : []) {
        const link = personLink(recordId, entry.personId);
        if (link && link.identificationStatus !== "confirmed") {
          issues.push(`${label}: record ${recordId} is only a candidate match for ${entry.personId}; the identification must be confirmed first`);
        }
      }
    }
    for (const place of places) {
      if (!filled(place?.name) || !filled(place?.country)) issues.push(`${label}: a place rule needs name and country`);
      if (place?.within !== undefined && !filled(place.within)) issues.push(`${label}: a place rule's within must name a county or district`);
      for (const role of place?.roles || []) if (!placeRoles.has(role)) issues.push(`${label}: unknown place role ${role}`);
    }
    for (const value of occupations) if (!filled(value)) issues.push(`${label}: an occupation rule must be a trade as recorded`);
  }
  return issues;
}

/**
 * Resolve every exhibit to the people it reaches.
 * @returns {{ exhibits: Array<object>, byPerson: Map<string, Array<{id: string, note?: string}>> }}
 */
export function projectExhibits(exhibits, { store, records, generations = new Map() }) {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const sourcesById = new Map((store.sources || []).map((source) => [source.id, source]));
  const byPerson = new Map();
  const reach = (personId, exhibit, note) => {
    if (!byPerson.has(personId)) byPerson.set(personId, new Map());
    const current = byPerson.get(personId);
    if (!current.has(exhibit.id) || note) current.set(exhibit.id, { id: exhibit.id, ...(note ? { note } : {}) });
  };
  const ordered = [...exhibits].sort((a, b) => exhibitKinds.indexOf(a.kind) - exhibitKinds.indexOf(b.kind) || a.id.localeCompare(b.id));

  for (const bundle of store.people) {
    if ((bundle.researchScope || "main") !== "main") continue;
    const personId = bundle.personId;
    const restriction = privacyRestriction(bundle, generations.has(personId) ? generations.get(personId) : null);
    const local = new Map((bundle.assertions || []).map((assertion) => [assertion.id, assertion]));
    const active = (id) => {
      const assertion = local.get(id);
      return assertion && assertion.assessment !== "rejected" ? assertion : null;
    };
    const placeRows = (bundle.presentation?.placeRows || []).map((row) => ({
      name: row.name, state: row.state, country: row.country,
      roles: new Set((row.assertionIds || []).map(active).filter(Boolean).map((assertion) => assertion.claim?.placeRole))
    }));
    const placed = placedFacts([
      ...(bundle.assertions || []),
      ...(store.unions || []).filter((union) => (union.personIds || []).includes(personId)).flatMap((union) => union.assertions || [])
    ]);
    const trades = new Set((bundle.presentation?.detailAssertionIds || []).map(active).filter(Boolean)
      .filter((assertion) => assertion.claim?.kind === "occupation")
      .map((assertion) => String(assertion.claim.value || "").trim().toLowerCase()));

    for (const exhibit of ordered) {
      const rules = exhibit.appliesTo || {};
      const named = (rules.people || []).find((entry) => entry.personId === personId);
      if (exhibit.kind === "portrait") {
        const record = recordsById.get(exhibit.image?.recordId);
        if (named && (restriction !== "living" || hasLivingPortraitApproval(exhibit, named))
          && canShowImage(record) && personLinkForRecord(record, personId, sourcesById)?.identificationStatus === "confirmed") {
          reach(personId, exhibit, named.note);
        }
        continue;
      }
      if (restriction === "living") continue;
      if (named) reach(personId, exhibit, named.note);
      for (const place of rules.places || []) {
        const roles = place.roles?.length ? place.roles : REAL_PLACE_ROLES;
        const name = String(place.name).trim().toLowerCase();
        const within = place.within ? String(place.within).trim().toLowerCase() : null;
        if (placeRows.some((row) => row.name === place.name && row.country === place.country
          && (!place.state || row.state === place.state) && roles.some((role) => row.roles.has(role)))
          // or a dated fact of the person's own names the place; "within" tells two Woottons apart.
          || placed.some((fact) => fact.parts.includes(name) && fact.area.country === place.country
            && (!place.state || fact.area.state === place.state) && (!within || fact.parts.includes(within))
            && (!place.roles?.length || (fact.role && place.roles.includes(fact.role))))) {
          reach(personId, exhibit);
        }
      }
      if ((rules.occupations || []).some((value) => trades.has(String(value).trim().toLowerCase()))) reach(personId, exhibit);
    }
  }

  const projected = ordered.map((exhibit) => {
    // The viewer can open only what is published to it.
    const openable = (exhibit.recordIds || []).filter((id) => canShowImage(recordsById.get(id)));
    return {
      id: exhibit.id,
      kind: exhibit.kind,
      title: exhibit.title,
      ...(exhibit.caption ? { caption: exhibit.caption } : {}),
      citation: exhibit.citation,
      credit: exhibit.credit,
      licence: exhibit.licence,
      ...(exhibit.sourceUrl ? { sourceUrl: exhibit.sourceUrl } : {}),
      checkedAt: exhibit.checkedAt,
      recordIds: openable,
      ...(exhibit.image && openable.includes(exhibit.image.recordId) ? { image: {
        recordId: exhibit.image.recordId,
        ...(exhibit.image.crop ? { crop: { ...exhibit.image.crop } } : {}),
        ...(exhibit.image.alt ? { alt: exhibit.image.alt } : {}),
        ...(exhibit.image.large ? { large: true } : {})
      } } : {}),
      ...(exhibit.drawing ? { drawing: {
        svg: renderShield(exhibit.drawing.shield, { title: exhibit.title }),
        basis: exhibit.drawing.basis
      } } : {}),
      ...(exhibit.text ? { text: exhibit.text } : {})
    };
  });
  return {
    exhibits: projected,
    byPerson: new Map([...byPerson].map(([personId, entries]) => [personId, [...entries.values()]]))
  };
}
