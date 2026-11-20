import assert from "node:assert/strict";
import test from "node:test";
import {
  distributionAccessDenied,
  distributionAttempt,
  distributionFailureMessage
} from "./familysearch-distribution.mjs";

const response = (status, contentType) => ({ status: () => status, headers: () => ({ "content-type": contentType }) });
const base = "https://sg30p0.familysearch.org/service/records/storage/deepzoomcloud/dz/v1/3:1:EXAMPLE";

test("a failed distribution names each candidate's status by file name only", () => {
  const attempts = [
    distributionAttempt(`${base}/dist.jpg`, response(404, "text/html; charset=utf-8")),
    distributionAttempt(`${base}/thumb_p1000.jpg`, null, new Error("timeout"))
  ];
  const message = distributionFailureMessage("flora-167.jpg", attempts);
  assert.match(message, /flora-167\.jpg \(dist\.jpg: HTTP 404 text\/html; thumb_p1000\.jpg: timeout\)/);
  assert.doesNotMatch(message, /deepzoomcloud|3:1:EXAMPLE/);
  assert.doesNotMatch(message, /access gate/);
});

test("only an all-401/403 failure is labelled an access gate", () => {
  const denied = [distributionAttempt(`${base}/dist.jpg`, response(403, "application/json"))];
  assert.equal(distributionAccessDenied(denied), true);
  assert.match(distributionFailureMessage("x-1.jpg", denied), /HTTP 403 application\/json\)\. The provider denied access to the image; record an access gate, not negative evidence\./);
  const mixed = [...denied, distributionAttempt(`${base}/thumb_p1000.jpg`, response(500, "text/html"))];
  assert.equal(distributionAccessDenied(mixed), false);
  assert.equal(distributionAccessDenied([]), false);
  assert.match(distributionFailureMessage("x-1.jpg", []), /\(no candidates\)\.$/);
});
