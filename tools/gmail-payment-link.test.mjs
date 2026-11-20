import assert from "node:assert/strict";
import test from "node:test";

import { choosePaymentLink, describeLink, summarizeConversation, unwrapGmailRedirect } from "./gmail-payment-link.mjs";

const linkHosts = [/^myinvoice\.izettle\.com$/i];

test("a link is reported only by host and label, never by its tokenized path", () => {
  const described = describeLink("https://myinvoice.izettle.com/invoice/secret-token?x=1", "  Show\ninvoice ");
  assert.deepEqual(described, { host: "myinvoice.izettle.com", protocol: "https", label: "Show invoice" });
  assert.equal(describeLink("mailto:someone@example.org", "mail"), null);
  const summary = summarizeConversation([{ anchors: [
    { href: "https://myinvoice.izettle.com/invoice/one", label: "Show invoice" },
    { href: "https://myinvoice.izettle.com/invoice/one", label: "Show invoice" }
  ], attachments: ["Payment options.pdf"] }]);
  assert.equal(JSON.stringify(summary).includes("/invoice/"), false);
  assert.equal(summary[0].links.length, 1);
});

test("Gmail's redirector is unwrapped to the provider's own link", () => {
  const wrapped = `https://www.google.com/url?q=${encodeURIComponent("https://myinvoice.izettle.com/invoice/one")}&sa=D`;
  assert.equal(unwrapGmailRedirect(wrapped), "https://myinvoice.izettle.com/invoice/one");
  assert.equal(unwrapGmailRedirect("https://example.org/a"), "https://example.org/a");
});

test("exactly one labelled HTTPS link on an allowlisted invoice host is followed", () => {
  const link = choosePaymentLink([
    { href: "https://myinvoice.izettle.com/invoice/one", label: "Show invoice" },
    { href: "https://www.paypal.com/x", label: "" }
  ], { labelPattern: /^show invoice$/i, linkHosts });
  assert.equal(link.host, "myinvoice.izettle.com");
  assert.throws(() => choosePaymentLink([{ href: "https://evil.example/pay", label: "Show invoice" }],
    { labelPattern: /^show invoice$/i, linkHosts }), /not an allowlisted invoice-link host/);
  assert.throws(() => choosePaymentLink([
    { href: "https://myinvoice.izettle.com/invoice/one", label: "Show invoice" },
    { href: "https://myinvoice.izettle.com/invoice/two", label: "Show invoice" }
  ], { labelPattern: /^show invoice$/i, linkHosts }), /2 different links/);
  assert.throws(() => choosePaymentLink([{ href: "http://myinvoice.izettle.com/invoice/one", label: "Show invoice" }],
    { labelPattern: /^show invoice$/i, linkHosts }), /not HTTPS/);
  assert.throws(() => choosePaymentLink([], { labelPattern: /^show invoice$/i, linkHosts }), /No link/);
  assert.throws(() => choosePaymentLink([{ href: "https://myinvoice.izettle.com/i", label: "Show invoice" }],
    { labelPattern: /^show invoice$/i, linkHosts: [] }), /no allowlisted invoice-link host/);
});
