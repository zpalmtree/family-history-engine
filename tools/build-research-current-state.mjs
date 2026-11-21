#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import {
  isLiveResearchQuestion,
  questionConclusionState,
  questionDependenciesSatisfied
} from "./research-question-state.mjs";
import { targetResearchRole } from "./research-target-state.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const questionIdPrefixes = loadTreeConfig().research?.questionIdPrefixes || ["rq-frontier-"];

const start = "<!-- research-current:start -->";
const end = "<!-- research-current:end -->";

function main() {
  const checkOnly = process.argv.includes("--check");
  const store = loadResearchStore();
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
  const acquisition = buildResearchProjections(store, { manifest }).acquisitionSession;
  const targetsByQuestion = new Map();
  for (const target of acquisition.targets) for (const questionId of target.questionIds || []) {
    if (!targetsByQuestion.has(questionId)) targetsByQuestion.set(questionId, []);
    targetsByQuestion.get(questionId).push(target);
  }
  const stale = [];
  const establishedAssertionIds = new Set([
    ...store.people, ...store.unions, ...(store.kinships || [])
  ].flatMap((bundle) => bundle.assertions || [])
    .filter((assertion) => assertion.assessment === "established")
    .map((assertion) => assertion.id));

  for (const branch of store.branches.branches) {
    const file = path.join(projectRoot, branch.currentStateFile);
    const current = fs.readFileSync(file, "utf8");
    const questions = store.questions.filter((question) => question.branchId === branch.id)
      .sort(compareQuestions);
    const questionIds = new Set(questions.map((question) => question.id));
    const branchTargets = acquisition.targets.filter((target) =>
      (target.questionIds || []).some((questionId) => questionIds.has(questionId)));
    const block = renderCurrentStateBlock({
      questions,
      targetsByQuestion,
      branchTargets,
      establishedAssertionIds
    });
    const next = replaceOrInsert(current, block);
    if (current === next) continue;
    if (checkOnly) stale.push(branch.currentStateFile);
    else fs.writeFileSync(file, next);
  }

  if (stale.length) {
    console.error(`generated research summaries are stale:\n- ${stale.join("\n- ")}\nRun npm run research:current.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${checkOnly ? "checked" : "updated"} ${store.branches.branches.length} branch current-state summaries`);
}

export function renderCurrentStateBlock({ questions, targetsByQuestion, branchTargets, establishedAssertionIds = new Set() }) {
  const stateOptions = { establishedAssertionIds };
  const targetRoleById = new Map(branchTargets.map((target) => [
    target.id,
    targetResearchRole(target, questions, stateOptions)
  ]));
  const activeQuestions = questions.filter((question) => question.schemaVersion === 1
    ? ["open", "blocked"].includes(question.status)
    : isLiveResearchQuestion(question, stateOptions));
  const closedQuestions = questions.filter((question) => !activeQuestions.includes(question));
  const deferredQuestions = questions.filter((question) => question.deferred
    && !isLiveResearchQuestion(question, stateOptions));
  const satisfiedTargets = branchTargets.filter((target) => target.reconciliation.state === "satisfied");
  const nonSatisfiedTargets = branchTargets.filter((target) => target.reconciliation.state !== "satisfied")
    .sort(compareTargets);
  const targetCounts = countBy(nonSatisfiedTargets, (target) => target.reconciliation.state);
  const questionCounts = countBy(activeQuestions, (question) => questionOperationalLabel(question, stateOptions));
  const lines = [
    start,
    "## Generated current state",
    "",
    `Questions: **${questionCounts.open || questionCounts.unresolved || 0} open/unresolved**, **${questionCounts.blocked || 0} blocked**. `
      + `Targets: **${targetCounts.actionable || 0} actionable**, **${targetCounts.blocked || 0} blocked**, `
      + `**${nonSatisfiedTargets.length - (targetCounts.actionable || 0) - (targetCounts.blocked || 0)} other**. `
      + "The default target role is recovery-only.",
    "",
    `History: **${closedQuestions.length - deferredQuestions.length} closed**, **${deferredQuestions.length} deferred** in the `
      + `[question store](../research/questions/); **${satisfiedTargets.length} satisfied** in the `
      + `[acquisition store](../acquisition/targets/).`,
    ""
  ];
  if (!activeQuestions.length) lines.push("No open or blocked canonical questions are assigned to this branch.", "");
  const renderedTargetIds = new Set();
  // Person-scoped frontiers add many small schema-2 questions that carry no
  // workstream, resume condition or open target. A full heading and link per
  // question made the rollup grow by ~160 bytes per new ancestor and kept
  // breaching its budget; group those into one line per priority/state/action
  // summary listing the exact canonical IDs (each is a file name in the
  // question store).
  const compactGroups = new Map();
  const openActionSummary = (question) => {
    const openActions = (question.actions || []).filter((action) => action.status !== "completed");
    const actionCounts = countBy(openActions, (action) => action.status);
    return Object.entries(actionCounts).sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${count} ${status}`).join(", ");
  };
  for (const question of activeQuestions) {
    const questionLink = `../research/questions/${question.id}.json`;
    if (question.schemaVersion !== 1 && !question.workstream
      && !((question.status === "blocked" || question.routeAssessment?.state === "current-no-known-route")
        && question.reopenWhen?.length)
      && !(targetsByQuestion.get(question.id) || [])
        .some((target) => target.reconciliation.state !== "satisfied" && !renderedTargetIds.has(target.id))) {
      const actionSummary = openActionSummary(question);
      const key = `${question.priority} — **${questionOperationalLabel(question, stateOptions)}**`
        + (actionSummary ? ` (actions: ${actionSummary})` : "");
      if (!compactGroups.has(key)) compactGroups.set(key, []);
      compactGroups.get(key).push(question.id);
      continue;
    }
    if (question.schemaVersion === 1) {
      lines.push(
        `### ${question.priority} — [${question.question}](${questionLink})`,
        "",
        `Canonical ID: \`${question.id}\`. State: **${questionOperationalLabel(question, stateOptions)}**.`,
        ""
      );
    } else {
      // A person-scoped frontier creates many intentionally small questions.
      // Link the canonical ID and keep only operational state in this rollup;
      // the canonical file owns the prompt, criteria, and full action notes.
      // Fold the open-action summary onto the heading so a large frontier
      // branch stays within its rollup budget.
      const openActions = (question.actions || []).filter((action) => action.status !== "completed");
      const actionCounts = countBy(openActions, (action) => action.status);
      const actionSummary = Object.entries(actionCounts).sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${count} ${status}`).join(", ");
      lines.push(
        `### ${question.priority} — [\`${compactId(question.id)}\`](${questionLink}) — **${questionOperationalLabel(question, stateOptions)}**`
          + (actionSummary ? ` (actions: ${actionSummary})` : ""),
        ""
      );
    }
    if (question.workstream) {
      lines.push(`Workstream: \`${question.workstream}\`, queue position **${question.queueOrder}**.`, "");
    }
    if ((question.status === "blocked" || question.routeAssessment?.state === "current-no-known-route")
      && question.reopenWhen?.length) {
      // The canonical question file keeps the full resume condition; 120
      // characters keep the gist while a large branch stays within budget.
      lines.push(`Resume when: ${compactText(question.reopenWhen.join(" "), 120)}`, "");
    }
    const actions = (question.actions || []).filter((action) => action.status !== "completed");
    if (actions.length && question.schemaVersion === 1) {
      if (question.schemaVersion === 1) {
        lines.push("Current actions:", "");
        for (const action of actions) {
          const note = action.status === "ready" && action.note ? `: ${compactText(action.note, 220)}` : "";
          lines.push(`- \`${action.id}\` — **${action.status}** (${action.kind})${note}`);
        }
      }
      lines.push("");
    }
    const targets = (targetsByQuestion.get(question.id) || [])
      .filter((target) => target.reconciliation.state !== "satisfied" && !renderedTargetIds.has(target.id))
      .sort(compareTargets);
    if (targets.length) {
      for (const target of targets) renderedTargetIds.add(target.id);
      lines.push(...renderTargets(targets, targetRoleById));
      lines.push("");
    }
  }
  if (compactGroups.size) {
    lines.push("### Other live questions", "");
    for (const [key, ids] of [...compactGroups].sort(([left], [right]) => left.localeCompare(right))) {
      // Frontier and branch-scoped bridge ids share long prefixes; naming each
      // prefix once per group keeps every id recoverable while a large branch
      // stays in budget. A tree names its own branch prefixes in
      // tree.config.json (research.questionIdPrefixes).
      const prefixes = questionIdPrefixes;
      const sorted = ids.sort();
      const parts = [];
      const grouped = new Set();
      for (const prefix of prefixes) {
        const members = sorted.filter((id) => id.startsWith(prefix) && !grouped.has(id));
        if (members.length < 2) continue;
        for (const id of members) grouped.add(id);
        // Within a prefix, ids that end in the same place name (four or more)
        // also name that suffix once: `rq-frontier-` + (`-monreale`: `a`, `b`).
        const stems = members.map((id) => id.slice(prefix.length));
        const suffixCounts = new Map();
        for (const stem of stems) {
          const suffix = stem.includes("-") ? stem.slice(stem.lastIndexOf("-")) : "";
          if (suffix) suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
        }
        const bySuffix = new Map();
        const plain = [];
        for (const stem of stems) {
          const suffix = stem.includes("-") ? stem.slice(stem.lastIndexOf("-")) : "";
          if (suffix && suffixCounts.get(suffix) >= 4) {
            if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
            bySuffix.get(suffix).push(stem.slice(0, -suffix.length));
          } else plain.push(stem);
        }
        const pieces = plain.map((stem) => `\`${stem}\``);
        for (const [suffix, heads] of bySuffix) pieces.push(`(\`${suffix}\`: ${heads.map((head) => `\`${head}\``).join(", ")})`);
        parts.push(`\`${prefix}\` + ${pieces.join(", ")}`);
      }
      const others = sorted.filter((id) => !grouped.has(id));
      if (others.length) parts.unshift(others.map((id) => `\`${id}\``).join(", "));
      lines.push(`- ${key}: ${parts.join("; ")}`);
    }
    lines.push("");
  }
  const remainingTargets = nonSatisfiedTargets.filter((target) => !renderedTargetIds.has(target.id));
  if (remainingTargets.length) {
    lines.push("### Other targets", "");
    lines.push(...renderTargets(remainingTargets, targetRoleById), "");
  }
  lines.push(end);
  return lines.join("\n");
}

function renderTargets(targets, targetRoleById) {
  const groups = [];
  for (const target of targets) {
    const researchRole = targetRoleById.get(target.id);
    const role = researchRole === "recovery-only" ? "" : `; ${researchRole}`;
    const status = `${target.reconciliation.state}/${target.reconciliation.status}${role}`;
    // Short labels: the link path already carries the full id, and a branch
    // can list well over a hundred targets within its byte budget.
    const link = `[${compactId(target.id, 19, 8)}](../acquisition/targets/${target.id}.json)`;
    const previous = groups.at(-1);
    // Combine consecutive matching statuses while preserving target priority order.
    if (previous?.status === status) previous.links.push(link);
    else groups.push({ status, links: [link] });
  }
  return groups.map(({ status, links }) => `- ${status}: ${links.join(" · ")}`);
}

function compactId(value, maxLength = 27, tailLength = 12) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - tailLength - 1)}…${value.slice(-tailLength)}`;
}

function questionOperationalLabel(question, options = {}) {
  if (question.schemaVersion === 1) return question.status;
  if (question.deferred && !questionDependenciesSatisfied(question, options)) return "deferred";
  return questionConclusionState(question);
}

function compactText(value, maxLength) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const prefix = normalized.slice(0, maxLength - 1);
  const lastSpace = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, lastSpace > maxLength * 0.7 ? lastSpace : prefix.length).trimEnd()}…`;
}

function replaceOrInsert(current, block) {
  const pattern = new RegExp(`${escape(start)}[\\s\\S]*?${escape(end)}`);
  if (pattern.test(current)) return `${current.replace(pattern, block).trimEnd()}\n`;
  const title = current.match(/^# .+$/m);
  if (!title) return `${block}\n\n${current.trimStart()}`;
  const index = title.index + title[0].length;
  return `${current.slice(0, index)}\n\n${block}\n${current.slice(index).trimStart()}`;
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareQuestions(first, second) {
  return workstreamRank(first) - workstreamRank(second)
    || queueRank(first) - queueRank(second)
    || priorityRank(first.priority) - priorityRank(second.priority)
    || first.id.localeCompare(second.id);
}

function compareTargets(first, second) {
  return targetStateRank(first.reconciliation.state) - targetStateRank(second.reconciliation.state)
    || priorityRank(first.priority) - priorityRank(second.priority)
    || first.id.localeCompare(second.id);
}

function targetStateRank(state) {
  const rank = ["actionable", "blocked", "exhausted", "not-applicable"].indexOf(state);
  return rank < 0 ? 99 : rank;
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function priorityRank(priority) {
  const value = Number(priority?.slice(1));
  return Number.isInteger(value) ? value : 99;
}

function workstreamRank(question) {
  return question.workstream === "tree-evidence-resolution" ? 0 : 1;
}

function queueRank(question) {
  return question.workstream ? question.queueOrder : Number.MAX_SAFE_INTEGER;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
