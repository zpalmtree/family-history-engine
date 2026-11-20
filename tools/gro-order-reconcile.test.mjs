import assert from "node:assert/strict";
import test from "node:test";
import { confirmationBasis, knownGroReferences, parseGroOrders, reconcileGroOrder, ukTimeToUtc } from "./gro-order-reconcile.mjs";

// The shape gro-check-orders prints: JSON strings with escaped tabs.
const output = [
  '"Order Reference Number:\\tCOL100001/2026\\t \\tOrder Submitted:\\t10 Nov 2026 08:10",',
  '"Your Reference:\\t\\t \\tOrder Amount:\\t£3.00",',
  '"Order Reference Number:\\tCOL100002/2026\\t \\tOrder Submitted:\\t10 Nov 2026 08:24",',
  '"Your Reference:\\t\\t \\tOrder Amount:\\t£3.00",',
  '"Order Reference Number:\\tCOL100004/2026\\t \\tOrder Submitted:\\t28 Oct 2026 07:24",',
  '"Your Reference:\\t\\t \\tOrder Amount:\\t£12.50",'
].join("\n");

test("UK civil time converts to UTC across British Summer Time", () => {
  assert.equal(ukTimeToUtc("10 Nov 2026 08:10").toISOString(), "2026-11-10T08:10:00.000Z");
  assert.equal(ukTimeToUtc("15 Jul 2026 04:03").toISOString(), "2026-07-15T03:03:00.000Z");
  // BST ended at 01:00 UTC on Sunday 25 Oct 2026.
  assert.equal(ukTimeToUtc("24 Oct 2026 12:00").toISOString(), "2026-10-24T11:00:00.000Z");
  assert.equal(ukTimeToUtc("26 Oct 2026 12:00").toISOString(), "2026-10-26T12:00:00.000Z");
  assert.equal(ukTimeToUtc("not a date"), null);
});

test("parses each order once with its reference, time and amount", () => {
  const orders = parseGroOrders(output + "\n" + output);
  assert.deepEqual(orders.map((order) => [order.reference, order.amount]), [["COL100001/2026", 3], ["COL100002/2026", 3], ["COL100004/2026", 12.5]]);
});

test("confirms the single unexplained order in the payment window", () => {
  const result = reconcileGroOrder({ orders: parseGroOrders(output), startedAt: "2026-11-10T08:23:32Z", amount: 3, knownReferences: new Set(["COL100001/2026"]) });
  assert.equal(result.status, "confirmed");
  assert.equal(result.order.reference, "COL100002/2026");
  assert.match(confirmationBasis(result.order, "2026-11-10T08:23:32Z"), /COL100002\/2026.*GBP 3\.00/);
});

test("an order already recorded on another request never confirms this one", () => {
  const result = reconcileGroOrder({ orders: parseGroOrders(output), startedAt: "2026-11-10T08:08:56Z", amount: 3, knownReferences: new Set(["COL100001/2026"]) });
  assert.equal(result.status, "unresolved");
});

test("two unexplained orders in the window stay for a person to match", () => {
  const close = output + '\n"Order Reference Number:\\tCOL100003/2026\\t \\tOrder Submitted:\\t10 Nov 2026 08:11",\n"Your Reference:\\t\\t \\tOrder Amount:\\t£3.00",';
  const result = reconcileGroOrder({ orders: parseGroOrders(close), startedAt: "2026-11-10T08:09:00Z", amount: 3, knownReferences: new Set() });
  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /2 unexplained/);
});

test("an order above the authorized amount or outside the window does not confirm", () => {
  assert.equal(reconcileGroOrder({ orders: parseGroOrders(output), startedAt: "2026-10-28T07:23:00Z", amount: 3 }).status, "unresolved");
  assert.equal(reconcileGroOrder({ orders: parseGroOrders(output), startedAt: "2026-11-09T08:00:00Z", amount: 3 }).status, "unresolved");
  assert.equal(reconcileGroOrder({ orders: parseGroOrders(output), startedAt: "", amount: 3 }).status, "unresolved");
});

test("known references come from other requests' event text only", () => {
  const references = knownGroReferences([
    { id: "a", events: [{ basis: "order COL1/2026 placed" }] },
    { id: "b", events: [{ note: "COL2/2026" }] }
  ], "b");
  assert.deepEqual([...references], ["COL1/2026"]);
});
