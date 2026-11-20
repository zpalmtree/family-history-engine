#!/usr/bin/env node

// Payment dispatcher: takes every authorized payment as far as the guarded
// helpers can, leaving the user only the step AGENTS.md reserves for a person
// (a card security code, Wise's Send now, 2FA).
//
//   npm run payments:run                                   plan only: what would run, in order, and why the rest cannot
//   npm run payments:run -- --execute [--id <request-id>]  run the automated steps one after another
//   npm run payments:run -- --scope <scope> ...             another research scope (omitted scope means the default)
//
// Only fully automated, reviewed routes execute: the GRO, MSA and TNA order
// drivers and the Wise transfer helper, the read-only GRO order-history check
// for a started or overdue GRO order, the payment reminder once its chase
// alarm fires, and the read-only inspection of the provider's own thread
// wherever that thread is the route (an unknown channel, an accepted quote
// awaiting instructions, a payment without a recorded result, a provider-side
// hold, an overdue delivery). The inspector's sanitized output is echoed with
// the channel the provider's words describe; when the recorded message cannot
// be opened, the dispatcher searches every folder of the shared mailbox for
// the provider and, finding nothing, records provider-message-unavailable
// through the request-event command so the ledger hands the step to the user
// instead of printing a command that fails. A payment whose provider has no
// reviewed profile, or whose next step is the user's, is listed with its exact
// next step instead. The helpers record their own request events.
//
// Run --execute only while the user is at the computer: each payment helper
// reveals its tab and waits up to ten minutes for the human step.

import { execFileSync } from "node:child_process";
import { automatedInvocation, buildPaymentLedger, classifyChannelText, formatLedgerEntry, formatMoney } from "./payment-ledger.mjs";
import { confirmationBasis, knownGroReferences, parseGroOrders, reconcileGroOrder } from "./gro-order-reconcile.mjs";
import { loadResearchStore, projectRoot } from "./research-store.mjs";
import { parseResearchScope } from "./research-scope.mjs";

const args = process.argv.slice(2);
const scope = parseResearchScope(args);
const execute = args.includes("--execute");
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? "" : args[index + 1] || "";
};
const onlyId = valueAfter("--id");
if (args.includes("--id") && !/^[a-z0-9][a-z0-9-]*$/.test(onlyId)) throw new Error("--id requires a safe request id");

function loadLedger() {
  const store = loadResearchStore();
  const establishedAssertionIds = new Set([...store.people, ...store.unions, ...(store.kinships || [])]
    .flatMap((bundle) => bundle.assertions || [])
    .filter((assertion) => assertion.assessment === "established")
    .map((assertion) => assertion.id));
  return buildPaymentLedger(store, { establishedAssertionIds });
}

const ledger = loadLedger();
const candidates = ledger.entries.filter((entry) => entry.scope === scope
  && ["in-flight", "retryable", "authorized", "awaiting-instructions", "provider-processing", "paid"].includes(entry.stage)
  && (!onlyId || entry.requestId === onlyId)
  && (entry.stage !== "paid" || entry.alarm === "OVERDUE"));
if (onlyId && !candidates.length) throw new Error(`${onlyId} has no open payment step in scope ${scope}.`);

const runnable = candidates.filter((entry) => automatedInvocation(entry));
const manual = candidates.filter((entry) => !automatedInvocation(entry));

console.log(`${candidates.length} open payment step(s) in scope ${scope}: ${runnable.length} automated, ${manual.length} need an agent decision or the user.`);
if (!runnable.length && !manual.length) process.exit(0);
if (runnable.length) {
  console.log(execute ? "Running in order (the user must be at the computer; each helper reveals its tab for the human step):" : "Automated steps (add --execute to run them, with the user at the computer):");
  for (const entry of runnable) {
    console.log(`  ${entry.requestId} — ${entry.provider} ${formatMoney(entry.amount, entry.currency)}: ${automatedInvocation(entry).label}`);
  }
}
if (manual.length) {
  console.log("Not automated; exact next step:");
  for (const entry of manual) console.log(formatLedgerEntry(entry));
}
if (!execute) process.exit(0);

let failures = 0;
const seenReadOnly = new Set();
for (const entry of runnable) {
  const invocation = automatedInvocation(entry);
  if (invocation.readOnly && seenReadOnly.has(invocation.label)) continue;
  if (invocation.readOnly) seenReadOnly.add(invocation.label);
  console.log(`\n=== ${entry.requestId}: ${invocation.label}`);
  if (invocation.kind === "inspect") {
    if (!inspectProviderThread(entry, invocation)) failures += 1;
  } else if (invocation.kind === "gro-reconcile") {
    if (!reconcileGroFromOrderHistory(entry)) failures += 1;
  } else {
    try {
      npm(invocation.npmArgs);
    } catch (error) {
      failures += 1;
      console.error(`${entry.requestId}: the helper stopped without finishing (${firstLine(error)}).`);
    }
    // A GRO order whose result page went unrecognized is settled from GRO's
    // own order history straight away, so the user is never asked about it.
    const settled = loadLedger().entries.find((candidate) => candidate.requestId === entry.requestId);
    if (/-GroOrder$/.test(invocation.label) && settled?.stage === "in-flight") {
      if (!reconcileGroFromOrderHistory(settled)) failures += 1;
    }
  }
  const after = loadLedger().entries.find((candidate) => candidate.requestId === entry.requestId);
  if (after) console.log(`${entry.requestId} is now ${after.stage}${after.alarm ? ` (${after.alarm})` : ""}: ${after.next.text}`);
}
if (failures) process.exitCode = 1;

function npm(npmArgs, { capture = false, timeout = 25 * 60 * 1000 } = {}) {
  return execFileSync("npm", npmArgs, {
    cwd: projectRoot,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    ...(capture ? { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] } : { stdio: "inherit" })
  });
}

function firstLine(error) {
  return String(error?.message || error).split("\n")[0];
}

function jsonStrings(output, key) {
  return [...String(output).matchAll(new RegExp(`"${key}":\\s*("(?:[^"\\\\]|\\\\.)*")`, "g"))].map((match) => JSON.parse(match[1]));
}

// Reads the provider's own thread with the inspector (whose output is already
// sanitized) and echoes it for the agent together with the channel the
// provider's words describe. When the recorded message cannot be opened, the
// whole-mailbox lookup runs and its negative result is recorded. Returns false
// only when nothing could be learned or recorded.
function inspectProviderThread(entry, invocation) {
  let output;
  try {
    output = npm(invocation.npmArgs, { capture: true });
  } catch (error) {
    console.log(`${entry.requestId}: the recorded provider message did not open (${firstLine(error)}).`);
    return lookupProviderReply(entry, invocation.lookup);
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  const hint = classifyChannelText(jsonStrings(output, "responseExcerpt").join("\n"));
  if (hint.kind === "unknown") {
    console.log(`${entry.requestId}: the provider's words name no payment channel the ledger recognizes; read the excerpt above and record what it says.`);
  } else {
    const eventType = entry.quoteAccepted ? "payment-requested" : "provider-acknowledged";
    console.log(`${entry.requestId}: the provider's own words read as ${hint.kind} (${JSON.stringify(hint.match)}). Record them so the ledger routes the payment: npm run research:requests:event -- --request ${entry.requestId} --type ${eventType} --expected-revision ${entry.revision} --basis "gmail-message-<id from the output above>" --note "<the provider's instruction in its own words>"`);
  }
  return true;
}

// Bounded Gmail searches of every folder for the provider's name; when all of
// them are empty, records provider-message-unavailable on the request (through
// the request-event command, which re-syncs the projections), so the ledger's
// next step becomes the user's. Candidate threads are listed by subject only.
function lookupProviderReply(entry, lookup) {
  if (!lookup?.queries?.length) return false;
  console.log(`${entry.requestId}: searching every folder of the shared mailbox for ${lookup.queries.map((query) => JSON.stringify(query)).join(", then ")}.`);
  for (const query of lookup.queries) {
    let output;
    try {
      output = npm(["run", "-s", "archive:win:audit-inbox", "--", "-Query", query, "-Scope", "anywhere"], { capture: true, timeout: 10 * 60 * 1000 });
    } catch (error) {
      console.error(`${entry.requestId}: the mailbox audit for ${JSON.stringify(query)} failed (${firstLine(error)}); nothing was recorded.`);
      return false;
    }
    const count = /"threadCount":\s*(\d+)/.exec(output);
    if (!count) {
      console.error(`${entry.requestId}: the mailbox audit for ${JSON.stringify(query)} returned no thread count; nothing was recorded.`);
      return false;
    }
    console.log(`  in:anywhere ${query}: ${count[1]} thread(s)`);
    if (Number(count[1]) > 0) {
      for (const subject of jsonStrings(output, "subject").slice(0, 8)) console.log(`    - ${subject}`);
      console.log(`${entry.requestId}: candidate threads exist; inspect the right one by its subject or Gmail id before recording anything.`);
      return true;
    }
  }
  const current = loadLedger().entries.find((candidate) => candidate.requestId === entry.requestId);
  const event = lookup.event(new Date().toISOString());
  try {
    npm(["run", "-s", "research:requests:event", "--", "--request", entry.requestId, "--type", event.type,
      "--expected-revision", String(current?.revision ?? entry.revision), "--basis", event.basis, "--note", event.note], { timeout: 5 * 60 * 1000 });
  } catch (error) {
    console.error(`${entry.requestId}: recording ${event.type} failed (${firstLine(error)}).`);
    return false;
  }
  console.log(`${entry.requestId}: recorded ${event.type}; the ledger now shows the user's step.`);
  return true;
}

// Reads GRO's order history for this request (read-only) and reports the one
// unexplained order of at most the authorized amount submitted just after the
// helper pressed pay. It records nothing: the request stays in-flight until
// payment itself is shown.
function reconcileGroFromOrderHistory(entry) {
  const store = loadResearchStore();
  const request = (store.externalRequests || []).find((candidate) => candidate.id === entry.requestId);
  const started = [...(request?.events || [])].filter((event) => event.type === "submission-started").at(-1);
  if (!started) {
    console.log(`${entry.requestId}: no submission-started event, so there is no payment to reconcile.`);
    return false;
  }
  console.log(`${entry.requestId}: reading GRO's order history to settle the payment started at ${started.at}.`);
  let output;
  try {
    output = npm(["run", "-s", "gro:win:check-orders", "--", "-Target", entry.requestId], { capture: true, timeout: 15 * 60 * 1000 });
  } catch (error) {
    console.error(`${entry.requestId}: the GRO order-history check failed (${firstLine(error)}); the request stays in-flight.`);
    return false;
  }
  const orders = parseGroOrders(output);
  const result = reconcileGroOrder({ orders, startedAt: started.at, amount: Number(entry.amount), knownReferences: knownGroReferences(store.externalRequests, entry.requestId) });
  if (result.status !== "confirmed") {
    console.log(`${entry.requestId}: not settled automatically: ${result.reason}. Read GRO My Orders before anything is retried.`);
    return false;
  }
  // GRO lists an order once its basket is submitted, possibly before the card
  // is charged, so a listed order alone never proves payment (10 Nov 2026:
  // four orders were listed while their tabs still showed Complete Payment).
  // Report the match; a person confirms from GRO's emailed confirmation or the
  // card charge before submission-confirmed is recorded.
  console.log(`${entry.requestId}: GRO lists ${result.order.reference} (GBP ${result.order.amount.toFixed(2)}, submitted ${result.order.submitted} UK time) for this payment, but a listed order does not prove the card was charged. Confirm it from GRO's confirmation email or the card statement, then record submission-confirmed with: ${confirmationBasis(result.order, started.at)}`);
  return true;
}
