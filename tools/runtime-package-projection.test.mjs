import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildEntryScript,
  reachableScripts,
  runtimePackageProjection
} from "./runtime-package-projection.mjs";

const vercel = JSON.stringify({ framework: "nextjs", buildCommand: "npm run site:build" });

const pkg = (scripts, extra = {}) => JSON.stringify({
  name: "app",
  version: "0.1.0",
  dependencies: { next: "15.0.0" },
  devDependencies: { typescript: "5" },
  scripts,
  ...extra
});

test("reads the build entry from vercel.json rather than assuming it", () => {
  assert.equal(buildEntryScript(vercel), "site:build");
  assert.equal(buildEntryScript(JSON.stringify({ buildCommand: "npm run custom:build" })), "custom:build");
});

test("follows npm run references transitively", () => {
  const scripts = { "site:build": "npm run site:check && next build", "site:check": "npm run tree:check", "tree:check": "node x.mjs", unrelated: "node y.mjs" };
  assert.deepEqual([...reachableScripts(scripts, "site:build")].sort(), ["site:build", "site:check", "tree:check"]);
});

test("a research script outside the build closure does not change the projection", () => {
  const scripts = { "site:build": "npm run site:check", "site:check": "node check.mjs" };
  const before = runtimePackageProjection(pkg(scripts), vercel);
  const after = runtimePackageProjection(pkg({ ...scripts, "research:worklist": "node worklist.mjs" }), vercel);
  assert.equal(after, before, "adding a tooling script must not force a redeploy");
});

test("a script inside the build closure does change the projection", () => {
  const scripts = { "site:build": "npm run site:check", "site:check": "node check.mjs" };
  const before = runtimePackageProjection(pkg(scripts), vercel);
  const after = runtimePackageProjection(pkg({ ...scripts, "site:check": "node check.mjs --strict" }), vercel);
  assert.notEqual(after, before);
});

test("a newly reachable script is picked up when the build command grows", () => {
  const scripts = { "site:build": "npm run site:check", "site:check": "node c.mjs", extra: "node e.mjs" };
  const before = runtimePackageProjection(pkg(scripts), vercel);
  const after = runtimePackageProjection(
    pkg({ ...scripts, "site:build": "npm run site:check && npm run extra" }), vercel);
  assert.notEqual(after, before);
  assert.match(after, /"extra"/);
});

test("dependency changes always change the projection", () => {
  const scripts = { "site:build": "next build" };
  for (const field of ["dependencies", "devDependencies", "engines", "type", "packageManager"]) {
    const before = runtimePackageProjection(pkg(scripts), vercel);
    const after = runtimePackageProjection(pkg(scripts, { [field]: { changed: "yes" } }), vercel);
    assert.notEqual(after, before, `${field} must affect the fingerprint`);
  }
});

test("script ordering does not affect the projection", () => {
  const a = { "site:build": "npm run x", x: "node x.mjs", z: "node z.mjs" };
  const b = { z: "node z.mjs", x: "node x.mjs", "site:build": "npm run x" };
  assert.equal(runtimePackageProjection(pkg(a), vercel), runtimePackageProjection(pkg(b), vercel));
});

test("unparseable input falls back to the raw source rather than narrowing scope", () => {
  assert.equal(runtimePackageProjection("{not json", vercel), "{not json");
  // A vercel.json without a recognisable npm build command must not silently
  // produce an empty script closure.
  const raw = pkg({ "site:build": "next build" });
  assert.equal(runtimePackageProjection(raw, "{}"), raw);
  assert.equal(runtimePackageProjection(raw, "{bad"), raw);
});

test("the real repository build closure excludes research tooling and keeps the build chain", () => {
  const real = JSON.parse(runtimePackageProjection(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
  ));
  assert.ok(real.scripts["site:build"], "the build entry itself is in scope");
  assert.ok(real.scripts["site:check"], "the build gate is in scope");
  assert.ok(!real.scripts["research:worklist"], "venue worklist tooling is out of scope");
  assert.ok(!real.scripts["research:question:reopen"], "question tooling is out of scope");
  assert.ok(real.dependencies, "dependencies are always in scope");
});
