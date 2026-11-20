// Research scopes come from tree.config.json: the default scope plus any
// additional ones. Dormant scopes keep their records visible but are worked
// only when the user's prompt authorizes them.
import { dormantScopes, loadTreeConfig, researchScopes as configuredResearchScopes } from "./tree-config.mjs";

const config = loadTreeConfig();
export const defaultResearchScope = config.scopes.default;
export const researchScopes = Object.freeze(configuredResearchScopes(config));
export const dormantResearchScopes = Object.freeze(dormantScopes(config));

export function isDormantScope(scope) {
  return dormantResearchScopes.includes(scope);
}

export function researchScopeOf(value) {
  return value?.researchScope || defaultResearchScope;
}

export function parseResearchScope(args, { defaultScope = defaultResearchScope } = {}) {
  const indexes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scope") indexes.push(index);
  }
  if (indexes.length > 1) throw new Error("--scope may be supplied only once");
  if (!indexes.length) return defaultScope;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`--scope requires ${researchScopes.join(" or ")}`);
  if (!researchScopes.includes(value)) {
    throw new Error(`unsupported research scope ${value}; expected ${researchScopes.join(" or ")}`);
  }
  return value;
}

export function inResearchScope(value, scope) {
  return researchScopeOf(value) === scope;
}

export function assertResearchScope(value, scope, label = "item") {
  const actual = researchScopeOf(value);
  if (actual !== scope) {
    throw new Error(`${label} belongs to research scope ${actual}, not ${scope}`);
  }
  return value;
}
