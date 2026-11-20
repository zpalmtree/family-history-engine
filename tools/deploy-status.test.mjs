import assert from "node:assert/strict";
import test from "node:test";

import { classifyDeploymentCoverage } from "./deploy-status.mjs";

const target = "aaaaaaaa";
const descendant = "bbbbbbbb";
const isAncestor = async (ancestor, candidate) => ancestor === target && candidate === descendant;

test("a successful descendant deployment covers its target", async () => {
  const result = await classifyDeploymentCoverage({ targetSha: target, isAncestor, runs: [{ databaseId: 2, headSha: descendant, status: "completed", conclusion: "success", createdAt: "2026-01-02T00:00:00Z" }] });
  assert.equal(result.coverage, "covered");
  assert.equal(result.relation, "descendant");
});

test("an abbreviated target SHA is classified as the exact run", async () => {
  const result = await classifyDeploymentCoverage({ targetSha: "aaaaaaaa", isAncestor, runs: [{ databaseId: 4, headSha: "aaaaaaaa11111111111111111111111111111111", status: "completed", conclusion: "success", createdAt: "2026-01-02T00:00:00Z" }] });
  assert.equal(result.coverage, "covered");
  assert.equal(result.relation, "exact");
});

test("a cancelled exact run is not covered until a descendant succeeds", async () => {
  const result = await classifyDeploymentCoverage({ targetSha: target, isAncestor, runs: [{ databaseId: 1, headSha: target, status: "completed", conclusion: "cancelled", createdAt: "2026-01-01T00:00:00Z" }] });
  assert.equal(result.coverage, "not-covered");
});

test("an in-progress descendant reports pending coverage", async () => {
  const result = await classifyDeploymentCoverage({ targetSha: target, isAncestor, runs: [{ databaseId: 3, headSha: descendant, status: "in_progress", conclusion: "", createdAt: "2026-01-03T00:00:00Z" }] });
  assert.equal(result.coverage, "pending");
});
