import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assertPortalUrl, describeField, explorationClickRefusal } from "./wuppertal-serviceportal-policy.mjs";

test("only https Wuppertal portal hosts are allowed", () => {
  assert.equal(assertPortalUrl("https://serviceportal.wuppertal.de/web/guest/login").hostname, "serviceportal.wuppertal.de");
  assert.throws(() => assertPortalUrl("http://serviceportal.wuppertal.de/"));
  assert.throws(() => assertPortalUrl("https://serviceportal.wuppertal.de.evil.example/"));
  assert.throws(() => assertPortalUrl("https://user:pw@serviceportal.wuppertal.de/"));
  assert.throws(() => assertPortalUrl("https://id.bund.de/"));
});

test("exploration refuses committing, payment and account controls", () => {
  for (const label of ["Absenden", "Kostenpflichtig bestellen", "Jetzt bezahlen", "PayPal", "Antrag stellen", "Anmelden", "Mit BundID anmelden", "Registrieren", "Submit"]) {
    assert.ok(explorationClickRefusal(label), label);
  }
  for (const label of ["Stadtarchiv", "Registerauszüge und Reproduktionen", "Weiter zur Leistung", "Online-Dienste"]) {
    assert.equal(explorationClickRefusal(label), null, label);
  }
  assert.ok(explorationClickRefusal(""));
});

test("field descriptions never carry a value", () => {
  const field = describeField({ tag: "input", type: "text", name: "vorname", label: "Vorname", required: true, value: "secret" });
  assert.equal("value" in field, false);
  assert.deepEqual(Object.keys(field).sort(), ["label", "name", "options", "required", "tag", "type"]);
});

test("the browser helper reads no field values and types nothing", () => {
  const source = fs.readFileSync(new URL("./wuppertal-serviceportal.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.value\b(?!\s*\|\|)/);
  assert.doesNotMatch(source, /\.(fill|type|press|setInputFiles)\(/);
  assert.match(source, /explorationClickRefusal\(clickText\)/);
});
