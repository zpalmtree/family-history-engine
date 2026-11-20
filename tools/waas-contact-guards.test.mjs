import test from "node:test";
import assert from "node:assert/strict";
import { waasEnquiryUrl, waasReviewMatches, waasReceipt } from "./waas-contact-guards.mjs";
const identity = { displayName: "Example Researcher", email: "example@example.invalid" };
const question = "Please provide free holdings advice.\nNo paid work is authorized.";
const body = `Archive Enquiry\nPlease confirm details of enquiry\nContact Details${identity.displayName}\n${identity.email}\nServiceArchive Enquiry\nEnquiry Details${question}\nImportant\nPrivacy notice\nBackSubmit`;
const input = { url: waasEnquiryUrl, body, question, identity };

test("WAAS accepts only the complete approved review and requester", () => {
  assert.equal(waasReviewMatches(input), true);
  for (const changed of [
    { url: waasEnquiryUrl.replace("ARCHENQ", "COPY") },
    { url: waasEnquiryUrl.replace("capublic.worcestershire.gov.uk", "example.invalid") },
    { body: body.replace("No paid work is authorized.", "Please charge for work.") },
    { body: body.replace("\nImportant", " Extra instructions.\nImportant") },
    { identity: { ...identity, email: "other@example.invalid" } },
    { body: body.replace("Please confirm details of enquiry", "Request form") }
  ]) assert.equal(waasReviewMatches({ ...input, ...changed }), false);
});

test("only the observed provider completion page and receipt prove delivery", () => {
  const url = "https://capublic.worcestershire.gov.uk/WAASPublic/ConfirmationScreenFree.aspx";
  const success = "Confirmation\nThank you for contacting Worcestershire Archive and Archaeology Service. Your enquiry has been logged, and we aim to respond within 7 working days.\nThe reference number for your application is #1889650. Please quote this number in any correspondence.";
  const receipt = body => waasReceipt({ url, body, hasSubmitControl: false });
  assert.deepEqual(receipt(success), { reference: "1889650" });
  assert.deepEqual(receipt(success.replaceAll(" ", "\n")), { reference: "1889650" });
  for (const invalid of [body, "Thank you. Enquiry form", "Thank you. Your enquiry could not be submitted.", "Thank you. Your enquiry will be submitted after verification.", success.replace("has been logged", "has not been logged"), success.replace("#1889650.", ""), "Enquiry Details\n" + success]) assert.equal(receipt(invalid), null);
  assert.equal(waasReceipt({ url: waasEnquiryUrl, body: success, hasSubmitControl: false }), null);
  assert.equal(waasReceipt({ url: url.replace("capublic.worcestershire.gov.uk", "example.invalid"), body: success, hasSubmitControl: false }), null);
  assert.equal(waasReceipt({ url, body: success, hasSubmitControl: true }), null);
});
