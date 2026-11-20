import { isLiveResearchQuestion } from "./research-question-state.mjs";

export const targetResearchRoles = Object.freeze([
  "proof-blocking",
  "recovery-only",
  "control",
  "satisfied-equivalent"
]);

const roles = new Set(targetResearchRoles);

export function targetResearchRole(target = {}, questions = [], options = {}) {
  if (roles.has(target.researchRole)) return target.researchRole;
  if (target.reconciliation?.state === "satisfied"
    || target.status === "satisfied-by-equivalent-route") return "satisfied-equivalent";
  if (["control", "search-audit"].includes(target.disposition)
    || /(?:^|-)control(?:-|$)/.test(target.id || "")) return "control";
  const byId = new Map(questions.map((question) => [question.id, question]));
  return (target.questionIds || []).some((id) => isLiveResearchQuestion(byId.get(id), options))
    ? "proof-blocking"
    : "recovery-only";
}

export function isProofBlockingTarget(target, questions = [], options = {}) {
  return targetResearchRole(target, questions, options) === "proof-blocking";
}

export function validateTargetResearchRole(target = {}) {
  if (target.researchRole === undefined) return [];
  return roles.has(target.researchRole)
    ? []
    : [`${target.id || "acquisition target"} has invalid researchRole ${target.researchRole}`];
}

