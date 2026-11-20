#!/usr/bin/env node

// npm run research:question:reopen -- \
//   --id <question-id> \
//   --reason "what changed that justifies re-entry" \
//   --action-id <new-action-id> --action-kind search --action-note "exactly what will be attempted"
//
// Optional: --trigger <id> to bind a fired reopen trigger, --dry-run to print
// the resulting document without writing it.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildReopenedQuestion } from "./reopen-question.mjs";
import { isResearchActionKind } from "./research-actions.mjs";
import { projectRoot } from "./research-store.mjs";
import { assertResearchScope, parseResearchScope } from "./research-scope.mjs";

const args = process.argv.slice(2);
const requestedScope = parseResearchScope(args);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const id = value("--id");
const reason = value("--reason");
const actionId = value("--action-id");
const actionKind = value("--action-kind");
const actionNote = value("--action-note");
const triggerId = value("--trigger");

if (!id) {
  console.error("usage: --id <question-id> --reason <text> --action-id <id> --action-kind <kind> --action-note <text>");
  process.exit(2);
}
if (actionKind && !isResearchActionKind(actionKind)) {
  console.error(`invalid action kind: ${actionKind}`);
  process.exit(2);
}

const file = path.join(projectRoot, "evidence", "research", "questions", `${id}.json`);
let question;
try {
  question = JSON.parse(readFileSync(file, "utf8"));
} catch {
  console.error(`no canonical question at ${file}`);
  process.exit(2);
}
assertResearchScope(question, requestedScope, `question ${id}`);

let reopened;
try {
  reopened = buildReopenedQuestion(question, {
    reason,
    action: actionId || actionKind || actionNote ? { id: actionId, kind: actionKind, note: actionNote } : undefined,
    at: new Date().toISOString(),
    triggerId
  });
} catch (error) {
  console.error(`reopen refused: ${error.message}`);
  process.exit(1);
}

if (args.includes("--dry-run")) {
  console.log(JSON.stringify(reopened, null, 2));
  process.exit(0);
}

writeFileSync(file, `${JSON.stringify(reopened, null, 2)}\n`);
const fromState = question.status || question.routeAssessment?.state;
const toState = reopened.status || reopened.routeAssessment?.state;
console.log(`reopened ${id}: ${fromState} -> ${toState}, ready action ${actionId}.`);
console.log("Prior attempts and conclusion are unchanged. Run npm run research:check before committing.");
