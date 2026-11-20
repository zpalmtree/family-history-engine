import assert from "node:assert/strict";
import test from "node:test";

import { downloadFileName, downloadLinkFor, isPdf, orderSummaryProblem, tnaRoute } from "./tna-digital-download.mjs";

const reference = "PROB 11/219/28";
const summary = {
  url: "https://discovery.nationalarchives.gov.uk/checkout/ordersummary",
  text: "Review your order\nDigital item\nTitle: Will of William Done\nCatalogue reference: PROB 11/219/28\nPrice: £0.00\nSubtotal: £0.00\nTotal: £0.00",
  prices: ["£0.00", "£0.00", "£0.00"],
  fields: ["input termsAndConditionsAccepted (checkbox)", "input  (submit)"]
};

test("accepts exactly one free item with only the terms checkbox", () => {
  assert.equal(orderSummaryProblem(summary, reference), "");
});

test("refuses a charge, a second item, the wrong record, extra inputs or another page", () => {
  assert.match(orderSummaryProblem({ ...summary, prices: ["£0.00", "£3.50"] }, reference), /other than £0.00/);
  assert.match(orderSummaryProblem({ ...summary, text: summary.text.replace("Total: £0.00", "Total: £3.50") }, reference), /£0.00 total/);
  assert.match(orderSummaryProblem({ ...summary, text: `${summary.text}\nCatalogue reference: PROB 11/1/1` }, reference), /2 items/);
  assert.match(orderSummaryProblem(summary, "PROB 11/220/1"), /not PROB 11\/220\/1/);
  assert.match(orderSummaryProblem({ ...summary, fields: [...summary.fields, "input cardNumber (text)"] }, reference), /unexpected inputs/);
  assert.match(orderSummaryProblem({ ...summary, url: "https://pay.example.com/checkout/ordersummary" }, reference), /unexpected page/);
});

test("download link must be Discovery's Your-orders link for this exact record", () => {
  const good = "https://discovery.nationalarchives.gov.uk/account/yourorders/download?iaid=D765011&reference=PROB%2011%2F219%2F28&ordernumber=C%2F1&edocId=0";
  assert.equal(downloadLinkFor([{ href: "https://discovery.nationalarchives.gov.uk/account/copyorder/RC1" }, { href: good }], "D765011", reference), good);
  assert.equal(downloadLinkFor([{ href: good }], "D765012", reference), "");
  assert.equal(downloadLinkFor([{ href: good }], "D765011", "PROB 11/219/29"), "");
  assert.equal(downloadLinkFor([{ href: good.replace("discovery.nationalarchives.gov.uk", "evil.example.com") }], "D765011", reference), "");
  assert.equal(downloadLinkFor([{ href: "" }], "D765011", reference), "");
});

test("routes, file names and PDF signature", () => {
  assert.throws(() => tnaRoute({ id: "x", provider: "Ancestry", routes: [] }), /not a National Archives/);
  assert.throws(() => tnaRoute({ id: "x", provider: "The National Archives", routes: [{ provider: "The National Archives", sourceUrl: "https://example.com/details/r/D1" }] }), /exact Discovery/);
  assert.equal(tnaRoute({ id: "x", provider: "The National Archives", routes: [{ provider: "The National Archives", sourceUrl: "https://discovery.nationalarchives.gov.uk/details/r/D765011" }] }).sourceUrl.endsWith("D765011"), true);
  assert.throws(() => downloadFileName("../x"), /safe slug/);
  assert.equal(downloadFileName("tna-a"), "tna-a.pdf");
  assert.equal(isPdf(Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(2000)])), true);
  assert.equal(isPdf(Buffer.from("<html>")), false);
});
