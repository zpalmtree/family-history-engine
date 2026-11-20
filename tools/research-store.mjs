import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const researchPaths = Object.freeze({
  proofPeople: path.join(projectRoot, "evidence", "proof", "people"),
  personIdAliases: path.join(projectRoot, "evidence", "proof", "person-id-aliases.json"),
  proofUnions: path.join(projectRoot, "evidence", "proof", "unions"),
  proofKinships: path.join(projectRoot, "evidence", "proof", "kinships"),
  sources: path.join(projectRoot, "evidence", "sources"),
  citations: path.join(projectRoot, "evidence", "citations"),
  questions: path.join(projectRoot, "evidence", "research", "questions"),
  researchAttempts: path.join(projectRoot, "evidence", "research", "attempts"),
  branches: path.join(projectRoot, "evidence", "research", "branches.json"),
  treePresentation: path.join(projectRoot, "evidence", "research", "tree-presentation.json"),
  acquisitionTargets: path.join(projectRoot, "evidence", "acquisition", "targets"),
  acquisitionRequests: path.join(projectRoot, "evidence", "acquisition", "requests"),
  acquisitionRuns: path.join(projectRoot, "evidence", "acquisition", "runs"),
  lifeStories: path.join(projectRoot, "evidence", "life-stories", "people"),
  lifeStoriesFull: path.join(projectRoot, "evidence", "life-stories", "full"),
  exhibits: path.join(projectRoot, "evidence", "exhibits"),
  notablePeople: path.join(projectRoot, "evidence", "notable-people.json")
});

export function loadResearchStore({ requireAll = true, researchAttemptScope } = {}) {
  const people = readEntityDirectory(researchPaths.proofPeople, "personId", { requireDirectory: requireAll });
  const personIdAliases = fs.existsSync(researchPaths.personIdAliases)
    ? readJson(researchPaths.personIdAliases)
    : requireAll ? missing(researchPaths.personIdAliases) : { schemaVersion: 1, aliases: [] };
  const unions = readEntityDirectory(researchPaths.proofUnions, "unionId", { requireDirectory: requireAll });
  const kinships = readEntityDirectory(researchPaths.proofKinships, "kinshipId", { requireDirectory: requireAll });
  const sources = readEntityDirectory(researchPaths.sources, "id", { recursive: true, requireDirectory: requireAll });
  const citations = readEntityDirectory(researchPaths.citations, "id", { requireDirectory: requireAll });
  const questions = readEntityDirectory(researchPaths.questions, "id", { requireDirectory: requireAll });
  const attemptOwnerQuestionIds = researchAttemptScope
    ? new Set(questions.filter((question) => (question.researchScope || "main") === researchAttemptScope)
      .map((question) => question.id))
    : undefined;
  attachResearchAttempts(questions, readResearchAttemptShards(researchPaths.researchAttempts, {
    requireDirectory: requireAll,
    ownerQuestionIds: attemptOwnerQuestionIds
  }));
  const acquisitionTargets = readEntityDirectory(researchPaths.acquisitionTargets, "id", {
    requireDirectory: requireAll
  });
  const externalRequests = readEntityDirectory(researchPaths.acquisitionRequests, "id", {
    requireDirectory: requireAll
  });
  const acquisitionRuns = readEntityDirectory(researchPaths.acquisitionRuns, "id", {
    requireDirectory: false
  });
  const lifeStories = readEntityDirectory(researchPaths.lifeStories, "personId", {
    requireDirectory: false
  });
  const lifeStoriesFull = readEntityDirectory(researchPaths.lifeStoriesFull, "personId", {
    requireDirectory: false
  });
  const exhibits = readEntityDirectory(researchPaths.exhibits, "id", {
    requireDirectory: false
  });
  const notablePeople = fs.existsSync(researchPaths.notablePeople) ? readJson(researchPaths.notablePeople) : null;
  const branches = fs.existsSync(researchPaths.branches)
    ? readJson(researchPaths.branches)
    : requireAll ? missing(researchPaths.branches) : { schemaVersion: 1, branches: [] };
  const treePresentation = fs.existsSync(researchPaths.treePresentation)
    ? readJson(researchPaths.treePresentation)
    : requireAll ? missing(researchPaths.treePresentation) : { schemaVersion: 1, visualTree: {} };

  return {
    people,
    personIdAliases,
    unions,
    kinships,
    sources,
    citations,
    questions,
    branches,
    treePresentation,
    acquisitionTargets,
    externalRequests,
    acquisitionRuns,
    lifeStories,
    lifeStoriesFull,
    exhibits,
    notablePeople
  };
}

export function resolvePersonId(store, requestedId) {
  const match = store.personIdAliases?.aliases?.find((item) => item.alias === requestedId);
  return match?.canonicalPersonId || requestedId;
}

export function readEntityDirectory(directory, idField, {
  recursive = false,
  requireDirectory = true
} = {}) {
  if (!fs.existsSync(directory)) {
    if (requireDirectory) missing(directory);
    return [];
  }
  const files = jsonFiles(directory, { recursive });
  const values = files.map((file) => {
    const value = readJson(file);
    Object.defineProperty(value, "__file", { value: file, enumerable: false });
    return value;
  });
  values.sort((first, second) => String(first[idField] || "").localeCompare(String(second[idField] || "")));
  return values;
}

export function researchAttemptFile(questionId, fingerprint) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(questionId || ""))) {
    throw new Error(`invalid research question id for attempt shard: ${questionId || "(missing)"}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(fingerprint || ""))) {
    throw new Error(`invalid research attempt fingerprint: ${fingerprint || "(missing)"}`);
  }
  return path.join(researchPaths.researchAttempts, questionId, `${fingerprint}.json`);
}

export function researchAttemptDocument(questionId, attempt) {
  if (attempt?.fingerprint === undefined) throw new Error("research attempt requires a fingerprint");
  researchAttemptFile(questionId, attempt.fingerprint);
  return {
    schemaVersion: 1,
    questionId,
    attempt
  };
}

export function researchQuestionDocument(question) {
  const document = { ...question };
  delete document.attempts;
  return document;
}

export function readResearchAttemptShards(directory, { requireDirectory = true, ownerQuestionIds } = {}) {
  if (!fs.existsSync(directory)) {
    if (requireDirectory) missing(directory);
    return [];
  }

  return jsonFiles(directory, { recursive: true }).filter((file) => {
    if (!ownerQuestionIds) return true;
    const relative = path.relative(directory, file);
    return ownerQuestionIds.has(relative.split(path.sep)[0]);
  }).map((file) => {
    const relative = path.relative(directory, file);
    const parts = relative.split(path.sep);
    if (parts.length !== 2) throw new Error(`invalid research attempt shard path: ${relative}`);
    const [questionId, filename] = parts;
    const fingerprint = path.basename(filename, ".json");
    const document = readJson(file);
    if (document.schemaVersion !== 1 || document.questionId !== questionId
      || !document.attempt || typeof document.attempt !== "object" || Array.isArray(document.attempt)) {
      throw new Error(`invalid research attempt shard: ${relative}`);
    }
    if (document.attempt.fingerprint !== fingerprint) {
      throw new Error(`research attempt shard fingerprint disagrees with its path: ${relative}`);
    }
    const attempt = document.attempt;
    Object.defineProperty(attempt, "__file", { value: file, enumerable: false });
    Object.defineProperty(attempt, "__questionId", { value: questionId, enumerable: false });
    return attempt;
  });
}

function attachResearchAttempts(questions, attempts) {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const attemptsByQuestion = new Map(questions.map((question) => [question.id, []]));

  for (const question of questions) {
    if (Object.hasOwn(question, "attempts")) {
      Object.defineProperty(question, "__inlineAttempts", {
        value: question.attempts,
        enumerable: false
      });
      delete question.attempts;
    }
  }

  for (const attempt of attempts) {
    if (!questionsById.has(attempt.__questionId)) {
      throw new Error(`research attempt shard belongs to unknown question: ${attempt.__questionId}`);
    }
    attemptsByQuestion.get(attempt.__questionId).push(attempt);
  }

  for (const question of questions) {
    const owned = attemptsByQuestion.get(question.id);
    owned.sort((left, right) => Date.parse(left.attemptedAt) - Date.parse(right.attemptedAt)
      || String(left.id || "").localeCompare(String(right.id || "")));
    Object.defineProperty(question, "attempts", {
      value: Object.freeze(owned),
      enumerable: false,
      writable: false
    });
  }
}

export function entityMap(values, idField = "id", label = "entity") {
  const result = new Map();
  for (const value of values) {
    const id = value?.[idField];
    if (typeof id !== "string" || !id) throw new Error(`${label} is missing ${idField}`);
    if (result.has(id)) throw new Error(`duplicate ${label} id: ${id}`);
    result.set(id, value);
  }
  return result;
}

export function assertionMap(store) {
  const assertions = new Map();
  for (const owner of [...store.people, ...store.unions, ...(store.kinships || [])]) {
    for (const assertion of owner.assertions || []) {
      if (!assertion?.id) throw new Error(`assertion in ${owner.personId || owner.unionId || owner.kinshipId} has no id`);
      if (assertions.has(assertion.id)) throw new Error(`duplicate assertion id: ${assertion.id}`);
      assertions.set(assertion.id, assertion);
    }
  }
  return assertions;
}

export function jsonFiles(directory, { recursive = false } = {}) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .sort((first, second) => first.name.localeCompare(second.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) output.push(...jsonFiles(target, { recursive: true }));
    if (entry.isFile() && entry.name.endsWith(".json")) output.push(target);
  }
  return output;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function canonicalProviderSlug(value) {
  const first = String(value || "source").split(",")[0];
  return first.toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "source";
}

export function canonicalText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function missing(file) {
  throw new Error(`research store is missing: ${path.relative(projectRoot, file)}`);
}
