import assert from "node:assert/strict";
import test from "node:test";
import { basketProblem, forwardControl, reviewControlAllowed, scotlandsPeopleCreditSpecs } from "./scotlandspeople-credits-order.mjs";

const spec = scotlandsPeopleCreditSpecs["scotlandspeople-isabel-mcdonald-baptism-dundee-1797"];
const row = { item: "30 credits", price: "£7.50", quantity: "1", lineTotal: "£7.50" };

test("the basket must hold exactly the reviewed bundle, once, at its price", () => {
  assert.equal(basketProblem({ rows: [row], total: "£7.50" }, spec), null);
  assert.match(basketProblem({ rows: [], total: "" }, spec), /0 line/);
  assert.match(basketProblem({ rows: [row, row], total: "£15.00" }, spec), /2 line/);
  assert.match(basketProblem({ rows: [{ ...row, item: "40 credits", price: "£10.00", lineTotal: "£10.00" }], total: "£10.00" }, spec), /not the reviewed bundle/);
  assert.match(basketProblem({ rows: [{ ...row, quantity: "2", lineTotal: "£15.00" }], total: "£15.00" }, spec), /2 times/);
  assert.match(basketProblem({ rows: [{ ...row, price: "£8.00", lineTotal: "£8.00" }], total: "£8.00" }, spec), /not the reviewed price/);
  assert.match(basketProblem({ rows: [row], total: "£9.00" }, spec), /total is not the reviewed price/);
});

test("a checkout step moves forward only through its one forward control", () => {
  assert.equal(forwardControl(["Back to basket", "Continue"]), "Continue");
  assert.equal(forwardControl(["Go back", "Pay and complete purchase"]), "Pay and complete purchase");
  assert.equal(forwardControl(["Continue", "Pay now"]), null);
  assert.equal(forwardControl(["Back to basket"]), null);
});

test("the review step is left only through a control that plainly pays", () => {
  assert.equal(reviewControlAllowed("Pay and complete purchase"), true);
  assert.equal(reviewControlAllowed(" Continue to payment "), true);
  assert.equal(reviewControlAllowed("Continue"), false);
  assert.equal(reviewControlAllowed("Subscribe"), false);
  assert.equal(reviewControlAllowed(null), false);
});
