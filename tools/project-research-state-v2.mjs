#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";
import { buildResearchProjections } from "./research-projections.mjs";
import { assertionMap, loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { projectQuestionStateV2, projectTargetStateV2 } from "./research-state-v2.mjs";

export function buildStateV2MigrationProjection({
  questions = [],
  targets = [],
  assertions = [],
  questionId,
  targetId
} = {}) {
  const selectedQuestions = questionId ? questions.filter((question) => question.id === questionId) : questions;
  const selectedTargets = targetId
    ? targets.filter((target) => target.id === targetId)
    : questionId
      ? targets.filter((target) => (target.questionIds || []).includes(questionId))
      : targets;
  if (questionId && !selectedQuestions.length) throw new Error(`Unknown canonical question: ${questionId}`);
  if (targetId && !selectedTargets.length) throw new Error(`Unknown canonical acquisition target: ${targetId}`);
  return {
    generatedFrom: "read-only schema-v1 compatibility projection",
    writesCanonicalState: false,
    questions: selectedQuestions.map((question) => ({
      id: question.id,
      projection: projectQuestionStateV2(question, { questions, assertions })
    })),
    targets: selectedTargets.map((target) => ({
      id: target.id,
      projection: projectTargetStateV2(target, questions)
    }))
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const store = loadResearchStore();
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
  const targets = buildResearchProjections(store, { manifest }).acquisitionSession.targets;
  const result = buildStateV2MigrationProjection({
    questions: store.questions,
    targets,
    assertions: assertionMap(store),
    questionId: valueAfter(args, "--question"),
    targetId: valueAfter(args, "--target")
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
