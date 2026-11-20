#!/usr/bin/env node

// The payment ledger: every request that carries money, with its stage, age,
// channel and the exact next step and actor.
//
//   npm run payments:status                       open entries, all scopes
//   npm run payments:status -- --scope main       one research scope
//   npm run payments:status -- --all              delivered and cancelled too
//   npm run payments:status -- --verbose          channel, state and question detail
//   npm run payments:status -- --id <request-id>  one request
//   npm run payments:status -- --json             the ledger as data
//
// Read-only. The rollup (research:status --needs-user) answers "what blocks
// research"; this answers "what money has the user approved that has not
// reached the provider, and who acts next", and it never hides an entry
// behind a deferred question, a recovery-only target or a provider hold.

import { buildPaymentLedger, formatPaymentLedger, openPaymentStages } from "./payment-ledger.mjs";
import { loadResearchStore } from "./research-store.mjs";
import { researchScopes } from "./research-scope.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? "" : args[index + 1] || "";
};
const scopeArg = valueAfter("--scope");
if (args.includes("--scope") && scopeArg !== "all" && !researchScopes.includes(scopeArg)) {
  throw new Error(`--scope must be all, ${researchScopes.join(" or ")}`);
}
const onlyId = valueAfter("--id");
if (args.includes("--id") && !/^[a-z0-9][a-z0-9-]*$/.test(onlyId)) throw new Error("--id requires a safe request id");

const store = loadResearchStore();
const establishedAssertionIds = new Set([...store.people, ...store.unions, ...(store.kinships || [])]
  .flatMap((bundle) => bundle.assertions || [])
  .filter((assertion) => assertion.assessment === "established")
  .map((assertion) => assertion.id));
const ledger = buildPaymentLedger(store, { establishedAssertionIds });
const scoped = {
  ...ledger,
  entries: ledger.entries.filter((entry) => (!scopeArg || scopeArg === "all" || entry.scope === scopeArg)
    && (!onlyId || entry.requestId === onlyId))
};
if (onlyId && !scoped.entries.length) throw new Error(`${onlyId} is not a payment-bearing request.`);
const { summarizeLedger } = await import("./payment-ledger.mjs");
scoped.summary = summarizeLedger(scoped.entries);

if (args.includes("--json")) {
  const includeClosed = args.includes("--all") || Boolean(onlyId);
  console.log(JSON.stringify({
    ...scoped,
    entries: scoped.entries.filter((entry) => includeClosed || openPaymentStages.includes(entry.stage))
  }, null, 2));
} else {
  console.log(formatPaymentLedger(scoped, {
    verbose: args.includes("--verbose") || Boolean(onlyId),
    includeClosed: args.includes("--all") || Boolean(onlyId)
  }));
  if (scoped.summary.dueCount) {
    console.log(`Run the due payments to their human step with: npm run payments:run -- --execute${scopeArg && scopeArg !== "all" ? ` --scope ${scopeArg}` : ""} (the user must be at the computer).`);
  }
}
