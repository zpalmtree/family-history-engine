import fs from "node:fs";
import path from "node:path";

const checklist = ["sourceMasterOpened", "visualAtSourceResolution", "allPagesReviewed", "structuredPersonLinksCompared", "sourceSpellingsPreserved", "neighboringMaterialExcluded", "questionEffectsAssessed"];
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

// Reviews sometimes embed machine reports in textAsRecorded. Such material is
// not a transcription and must stay private, even on a viewer-approved record.
export function safeDisplayExcerpt(value) {
  return nonempty(value) && value.length <= 4000
    && !/[{}]|(?:^|[\s"'])\[(?:\s*[{"\[])/.test(value)
    && !/(?:\/mnt\/|\/home\/|[A-Z]:[\\/]|file:\/\/|\\\\|\.json\b|\.model-evals|rootInitial|blind[12]|reviewerId|sourceMaster|canonicalPersonId|assertionId|adjudication|canonical|reconcil|\breviewer\b|\bpacket\b|\br\d{3,}\b|\b(?:independent|blind|primary) review\b|\bsource master\b|\b(?:assert|question|target)-[a-z0-9])/i.test(value);
}

// Deliberate publication boundary: never spread a research review into the viewer.
export function projectRecordReading(record, review, annotation, visualIds) {
  if (!record.viewer?.approved || record.rights !== "family-viewer-approved" || record.privacy === "restricted") return null;
  const eligible = review?.recordId === record.id && review.sha256 === record.sha256
    && review.state === "current" && review.method === "original-visual"
    && (review.researchScope || "main") === "main"
    && review.reconciliation?.status === "complete"
    && ["complete", "not-required"].includes(review.secondReview?.status)
    && !["refetch-required", "deferred-dormant-scope"].includes(review.outcome)
    && checklist.every((field) => review.checklist?.[field] === true);
  const readings = eligible ? (review.readings || []).filter((reading) => !/frozen|exclusion|neighbor|peripheral|reconcil|correlation|omission/i.test(reading.id) && nonempty(reading.id) && safeDisplayExcerpt(reading.textAsRecorded) && (!reading.locator || safeDisplayExcerpt(reading.locator))).map((reading) => ({
    id: reading.id,
    locator: reading.locator || "",
    text: reading.textAsRecorded,
    ...(reading.note || reading.interpretation ? { notesPending: true } : {}),
    people: [...new Set((review.participants || []).filter((person) =>
      person.identificationStatus === "confirmed" && person.readingIds?.includes(reading.id)
      && record.people.includes(person.canonicalPersonId) && visualIds.has(person.canonicalPersonId)
    ).map((person) => person.canonicalPersonId))]
  })) : [];
  const displayReviewed = annotation?.visualReview?.method === "original-visual"
    && annotation.visualReview.status === "complete" && annotation.visualReview.sourceMasterOpened === true
    && annotation.sha256 === record.sha256 && nonempty(annotation.reviewedAt)
    && (record.researchScope || "main") === "main";
  if (annotation?.readings?.length) {
    if (!displayReviewed) throw new Error(`unreviewed display transcription: ${record.id}`);
    for (const reading of annotation.readings) {
      if (!nonempty(reading.id) || !safeDisplayExcerpt(reading.text)
        || (reading.locator && !safeDisplayExcerpt(reading.locator))
        || !Array.isArray(reading.people) || reading.people.some(id => !record.people.includes(id))) {
        throw new Error(`invalid display transcription: ${record.id}/${reading.id}`);
      }
      const projected = { id: reading.id, locator: reading.locator || "", text: reading.text, ...(reading.notesPending === true ? { notesPending: true } : {}), people: [...new Set(reading.people.filter(id => visualIds.has(id)))] };
      const existing = readings.findIndex(item => item.id === reading.id);
      if (existing < 0) readings.push(projected); else readings[existing] = projected;
    }
  }
  if (annotation?.omitReadingIds?.length) {
    if (!displayReviewed || !annotation.omitReadingIds.every(id => readings.some(reading => reading.id === id))) {
      throw new Error(`invalid superseded display reading: ${record.id}`);
    }
    for (let index = readings.length - 1; index >= 0; index--) {
      if (annotation.omitReadingIds.includes(readings[index].id)) readings.splice(index, 1);
    }
  }
  const result = { status: readings.length ? "reviewed" : "needs-review", readings, regions: [] };
  if (readings.length) result.reviewedAt = displayReviewed ? annotation.reviewedAt : review.reviewedAt;
  if (!annotation) return { status: "needs-review", readings: [], regions: [] };
  if ((!eligible && !displayReviewed) || annotation.sha256 !== record.sha256 || !nonempty(annotation.reviewedAt)) {
    throw new Error(`stale or unreviewed viewer annotation: ${record.id}`);
  }
  const readingIds = new Set(readings.map((reading) => reading.id));
  const regionIds = new Set();
  result.regions = (annotation.regions || []).map((region) => {
    const [x, y, width, height] = region.rect || [];
    if ((!record.mediaType.startsWith("image/") && record.mediaType !== "application/pdf") || !nonempty(region.id) || regionIds.has(region.id)
      || (record.mediaType === "application/pdf" && (!Number.isInteger(region.page) || region.page < 1))
      || !nonempty(region.label) || ![x, y, width, height].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1
      || !Array.isArray(region.readingIds) || !region.readingIds.length
      || region.readingIds.some((id) => !readingIds.has(id))) {
      throw new Error(`invalid viewer region: ${record.id}/${region.id}`);
    }
    regionIds.add(region.id);
    return { id: region.id, label: region.label, rect: [x, y, width, height], readingIds: [...region.readingIds], ...(record.mediaType === "application/pdf" ? { page: region.page } : {}) };
  });
  for (const translation of annotation.translations || []) {
    const reading = readings.find((item) => item.id === translation.readingId);
    if (!reading || !safeDisplayExcerpt(translation.text) || !safeDisplayExcerpt(translation.language)) throw new Error(`invalid translation: ${record.id}`);
    reading.translation = { language: translation.language, text: translation.text };
  }
  const highlightedIds = new Set(result.regions.flatMap(region => region.readingIds));
  result.readings = readings.filter(reading => highlightedIds.has(reading.id));
  result.status = result.readings.length ? "reviewed" : "needs-review";
  return result;
}

export function loadViewerReadings(root, manifest, familyData) {
  const annotations = JSON.parse(fs.readFileSync(path.join(root, "evidence/viewer-annotations.json"), "utf8"));
  if (annotations.schemaVersion !== 1) throw new Error("Unsupported viewer annotations schema");
  const visualIds = new Set(familyData.people.map((person) => person.id));
  const output = {};
  for (const record of manifest.records) {
    if (!/^[a-z0-9-]+$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.sha256 || "")) continue;
    const file = path.join(root, "evidence/extraction/reviews", record.id, `${record.sha256}.json`);
    const review = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const projected = projectRecordReading(record, review, annotations.records[record.id], visualIds);
    if (projected) output[record.id] = projected;
  }
  for (const id of Object.keys(annotations.records)) {
    if (!output[id]) throw new Error(`annotation is not viewer-approved: ${id}`);
  }
  return output;
}
