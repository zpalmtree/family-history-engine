import test from "node:test";
import assert from "node:assert/strict";

import { createBackgroundTarget } from "./cdp-background-target.mjs";

function session(failures) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      return { targetId: `target-${calls.length}` };
    }
  };
}

test("a background task target joins an existing window when one is open", async () => {
  const browserSession = session([]);
  const created = await createBackgroundTarget(browserSession, "about:blank");
  assert.equal(created.targetId, "target-1");
  assert.deepEqual(browserSession.calls.map((call) => call.params.newWindow), [false]);
});

test("a windowless Chrome gets one new background window instead of failing", async () => {
  const browserSession = session(["Protocol error (Target.createTarget): Failed to open new tab - no browser is open"]);
  const created = await createBackgroundTarget(browserSession, "about:blank");
  assert.equal(created.targetId, "target-2");
  assert.deepEqual(browserSession.calls.map((call) => call.params), [
    { url: "about:blank", newWindow: false, background: true },
    { url: "about:blank", newWindow: true, background: true }
  ]);
});

test("any other target failure is not retried in a new window", async () => {
  const browserSession = session(["Protocol error (Target.createTarget): Target closed"]);
  await assert.rejects(createBackgroundTarget(browserSession, "about:blank"), /Target closed/);
  assert.equal(browserSession.calls.length, 1);
});
