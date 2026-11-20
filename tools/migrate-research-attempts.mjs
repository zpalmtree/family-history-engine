#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, writeJsonCreateOnlyAtomic } from "./atomic-json.mjs";
import {
  jsonFiles,
  projectRoot,
  readJson,
  readResearchAttemptShards,
  researchAttemptDocument,
  researchAttemptFile,
  researchPaths
} from "./research-store.mjs";

const write = process.argv.includes("--write");
const questionFiles = jsonFiles(researchPaths.questions);
const existingShards = readResearchAttemptShards(researchPaths.researchAttempts, {
  requireDirectory: false
});
const attemptsByKey = new Map();
const attemptsByQuestion = new Map();
const issues = [];
let inlineAttemptCount = 0;
let createdShardCount = 0;
let changedQuestionCount = 0;

for (const attempt of existingShards) registerAttempt(attempt.__questionId, attempt, "existing shard");

for (const file of questionFiles) {
  const question = readJson(file);
  const inlineAttempts = Object.hasOwn(question, "attempts") ? question.attempts : [];
  if (!Array.isArray(inlineAttempts)) {
    issues.push(`${relative(file)} has a non-array attempts field`);
    continue;
  }

  inlineAttemptCount += inlineAttempts.length;
  for (const attempt of inlineAttempts) {
    if (!validAttempt(question.id, attempt)) continue;
    const key = attemptKey(question.id, attempt.fingerprint);
    const existing = attemptsByKey.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(attempt)) {
      issues.push(`${question.id}/${attempt.fingerprint} conflicts with its immutable shard`);
      continue;
    }
    if (!existing) registerAttempt(question.id, attempt, "inline question");
    if (write) {
      const created = writeJsonCreateOnlyAtomic(
        researchAttemptFile(question.id, attempt.fingerprint),
        researchAttemptDocument(question.id, attempt)
      );
      if (created) createdShardCount += 1;
    }
  }

  if (!write) {
    if (Object.hasOwn(question, "attempts")) {
      issues.push(`${relative(file)} still embeds attempts`);
    }
    continue;
  }

  let changed = Object.hasOwn(question, "attempts");
  delete question.attempts;
  const ownedAttempts = attemptsByQuestion.get(question.id) || [];
  for (const action of question.actions || []) {
    if (action.lastAttemptId) continue;
    const matching = ownedAttempts
      .filter((attempt) => attempt.actionId === action.id && attempt.attemptedAt === action.lastAttemptAt)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (matching.length === 1) {
      action.lastAttemptId = matching[0].id;
      changed = true;
    }
  }
  if (changed) {
    writeJsonAtomic(file, question);
    changedQuestionCount += 1;
  }
}

const questionIds = new Set(questionFiles.map((file) => readJson(file).id));
for (const [questionId, attempts] of attemptsByQuestion) {
  if (!questionIds.has(questionId)) issues.push(`attempt directory belongs to unknown question ${questionId}`);
  const ids = new Set();
  for (const attempt of attempts) {
    if (ids.has(attempt.id)) issues.push(`${questionId} repeats attempt id ${attempt.id}`);
    ids.add(attempt.id);
  }
}

if (issues.length) {
  console.error(`research attempt migration ${write ? "failed" : "check failed"}:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

if (write) {
  const remainingInline = questionFiles.filter((file) => Object.hasOwn(readJson(file), "attempts"));
  if (remainingInline.length) throw new Error(`attempt migration left ${remainingInline.length} inline question file(s)`);
}

console.log(
  `research attempt shards ${write ? "migrated" : "checked"}: ${attemptsByKey.size} attempt(s), `
  + `${createdShardCount} shard(s) created, ${changedQuestionCount} question file(s) changed, `
  + `${inlineAttemptCount} inline attempt(s) observed`
);

function registerAttempt(questionId, attempt, source) {
  if (!validAttempt(questionId, attempt, source)) return;
  const key = attemptKey(questionId, attempt.fingerprint);
  if (attemptsByKey.has(key)) return;
  attemptsByKey.set(key, attempt);
  if (!attemptsByQuestion.has(questionId)) attemptsByQuestion.set(questionId, []);
  attemptsByQuestion.get(questionId).push(attempt);
}

function validAttempt(questionId, attempt, source = "inline question") {
  const label = `${questionId || "(missing question)"}/${attempt?.id || "(missing attempt)"}`;
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
    issues.push(`${label} is not an object in ${source}`);
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(attempt.fingerprint || "")) {
    issues.push(`${label} has an invalid fingerprint in ${source}`);
    return false;
  }
  return true;
}

function attemptKey(questionId, fingerprint) {
  return `${questionId}:${fingerprint}`;
}

function relative(file) {
  return path.relative(projectRoot, file);
}
