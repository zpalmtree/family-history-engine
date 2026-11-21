import "./test-tree-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { deleteSecret, getSecret, secretBackend, secretCommands, serviceName, setSecret } from "./secret-store.mjs";

test("the platform picks its own store, and Windows keeps DPAPI", () => {
  assert.equal(secretBackend("darwin"), "keychain");
  assert.equal(secretBackend("linux"), "secret-service");
  assert.equal(secretBackend("win32"), null);
  assert.throws(() => secretCommands(null, "s"), /DPAPI/);
});

test("secrets are named per tree and never put on the command line", () => {
  const service = serviceName("archive-request-profile");
  assert.equal(service, "family-history/fixture-tree/archive-request-profile");
  assert.throws(() => serviceName("Bad Name"), /slug/);
  for (const backend of ["keychain", "secret-service"]) {
    const calls = [];
    const run = (command, input) => { calls.push({ command, input }); return { status: 0, stdout: "s3cret\n" }; };
    setSecret("api-key", "s3cret", { backend, run });
    assert.equal(getSecret("api-key", { backend, run }), "s3cret");
    assert.equal(deleteSecret("api-key", { backend, run }), true);
    for (const { command } of calls) assert.ok(!command[1].some((arg) => arg.includes("s3cret")), `${backend} keeps the value off argv`);
    assert.match(calls[0].input, /s3cret/, "the value travels on stdin");
  }
});

test("a missing secret reads as null and an empty one is refused", () => {
  const run = () => ({ status: 44, stdout: "" });
  assert.equal(getSecret("absent", { backend: "secret-service", run }), null);
  assert.throws(() => setSecret("x", "", { backend: "keychain", run }), /empty/);
});

test("a locked store says so instead of reporting the secret missing", () => {
  const keychain = () => ({ status: 36, stdout: "", stderr: "security: SecKeychainCopySettings: User interaction is not allowed." });
  assert.throws(() => getSecret("api-key", { backend: "keychain", run: keychain }), /Keychain is locked/);
  assert.throws(() => setSecret("api-key", "v", { backend: "keychain", run: keychain }), /Keychain is locked/);
  const service = () => ({ status: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" });
  assert.throws(() => getSecret("api-key", { backend: "secret-service", run: service }), /Secret Service/);
});
