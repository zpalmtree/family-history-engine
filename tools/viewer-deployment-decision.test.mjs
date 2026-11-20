import assert from "node:assert/strict";
import test from "node:test";
import { decideViewerDeployment } from "./viewer-deployment-decision.mjs";

const old = "a".repeat(64);
const current = "b".repeat(64);
const runs = [3, 2, 1].map((id) => ({ id, head_sha: String(id).repeat(40), head_branch: "main", status: "completed", updated_at: `2026-10-08T07:00:0${id}Z` }));
function fixture({ uploads = { 3: "skipped", 2: "skipped", 1: "success" }, deployed = old } = {}) {
  return {
    eventName: "push", current, repository: "owner/repository",
    api: async (route) => {
      if (route.includes("/workflows/")) return { workflow_runs: runs };
      const match = route.match(/\/runs\/(\d+)\/jobs/);
      if (match) return { total_count: 1, jobs: [{ steps: [{ name: "Deploy only the prebuilt artifact", conclusion: uploads[match[1]] }] }] };
      if (route.includes("/contents/")) return { encoding: "base64", content: Buffer.from(JSON.stringify({ sha256: deployed })).toString("base64") };
      throw new Error("Unexpected API route");
    },
  };
}

test("canceled predecessors and successful skips do not cover an unpublished artifact", async () => {
  const decision = await decideViewerDeployment(fixture());
  assert.equal(decision.deploy, true);
  assert.equal(decision.receiptRunId, 1);
});

test("an unchanged artifact skips only against a successful upload receipt", async () => {
  const decision = await decideViewerDeployment(fixture({ deployed: current }));
  assert.equal(decision.deploy, false);
  assert.equal(decision.receiptRunId, 1);
});

test("explicit reruns always deploy without consulting history", async () => {
  const decision = await decideViewerDeployment({ ...fixture(), eventName: "workflow_dispatch", api: () => assert.fail("History must not be queried") });
  assert.equal(decision.deploy, true);
});

test("an interrupted or failed upload prevents trusting an older matching receipt", async () => {
  for (const conclusion of ["cancelled", "failure", "timed_out"]) {
    const decision = await decideViewerDeployment(fixture({ uploads: { 3: conclusion, 2: "skipped", 1: "success" }, deployed: current }));
    assert.equal(decision.deploy, true, conclusion);
  }
});

test("unknown, incomplete, or unavailable upload history deploys conservatively", async () => {
  for (const api of [
    async () => { throw new Error("Unavailable"); },
    async () => ({ workflow_runs: [] }),
    async (route) => route.includes("/workflows/") ? { workflow_runs: runs } : { total_count: 2, jobs: [] },
    async (route) => route.includes("/contents/") ? { encoding: "base64", content: Buffer.from("{}").toString("base64") } : fixture().api(route),
  ]) assert.equal((await decideViewerDeployment({ ...fixture(), api })).deploy, true);
});


test("a rerun of an older commit takes precedence over newer-created runs", async () => {
  const f = fixture({ uploads: { 3: "success", 2: "skipped", 1: "success" } });
  const api = f.api;
  f.api = async (route) => route.includes("/workflows/")
    ? { workflow_runs: runs.map((r) => ({ ...r, updated_at: r.id === 1 ? "2026-10-08T08:00:00Z" : r.updated_at })) }
    : api(route);
  const decision = await decideViewerDeployment(f);
  assert.equal(decision.receiptRunId, 1);
  assert.equal(decision.deploy, true);
});

test("multiple upload attempts in a rerun are treated conservatively", async () => {
  const f = fixture({ deployed: current });
  const api = f.api;
  f.api = async (route) => route.includes("/jobs?")
    ? { total_count: 2, jobs: Array.from({ length: 2 }, () => ({ steps: [{ name: "Deploy only the prebuilt artifact", conclusion: "success" }] })) }
    : api(route);
  assert.equal((await decideViewerDeployment(f)).deploy, true);
});
