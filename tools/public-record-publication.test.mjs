import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { writeRegistryAtomic } from "./registry-write.mjs";

const register = fs.readFileSync(new URL("./register-public-record.mjs", import.meta.url), "utf8");
const importPublic = fs.readFileSync(new URL("./import-public-records.mjs", import.meta.url), "utf8");
const publish = fs.readFileSync(new URL("./publish-public-records.mjs", import.meta.url), "utf8");
const publishSubscription = fs.readFileSync(new URL("./publish-subscription-records.mjs", import.meta.url), "utf8");
const publishFamilySearch = fs.readFileSync(new URL("./publish-familysearch-records.mjs", import.meta.url), "utf8");
const checkViewerBlobInventory = fs.readFileSync(new URL("./check-viewer-blob-inventory.mjs", import.meta.url), "utf8");
const importFamilySearch = fs.readFileSync(new URL("./import-familysearch-records.mjs", import.meta.url), "utf8");
const registerFamilySearch = fs.readFileSync(new URL("./register-familysearch-record.mjs", import.meta.url), "utf8");
const archiveFamilySearch = fs.readFileSync(new URL("./archive-familysearch-download-windows.ps1", import.meta.url), "utf8");
const verifyRecordPeople = fs.readFileSync(new URL("./verify-record-people.mjs", import.meta.url), "utf8");
const replacePublicMaster = fs.readFileSync(new URL("./replace-public-master-windows.ps1", import.meta.url), "utf8");
const recoverPublic = fs.readFileSync(new URL("./recover-public-records-windows.ps1", import.meta.url), "utf8");
const recordAcquisitionAttempt = fs.readFileSync(new URL("./record-acquisition-attempt.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("FamilySearch import preserves reviewed recovery decisions and current source metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familysearch-import-policy-"));
  try {
    const evidence = path.join(root, "evidence");
    const targets = path.join(evidence, "acquisition", "targets");
    const archive = path.join(root, "archive");
    fs.mkdirSync(targets, { recursive: true });
    fs.mkdirSync(archive);
    const statuses = ["published", "needs-alternate-route", "preserved-withheld", "ready-download"];
    const sources = [];
    const queue = { targets: statuses.map((status, index) => {
      const id = `record-${index}`;
      const sourceUrl = `https://www.familysearch.org/ark:/61903/3:1:EXACT-${index}`;
      const viewer = { titleMode: "people", title: "obsolete manual title" };
      fs.writeFileSync(path.join(targets, `${id}.json`), JSON.stringify({
        id, viewer, routes: [{ id, targetId: id, provider: "FamilySearch", sourceUrl, status }]
      }));
      fs.writeFileSync(path.join(archive, `${id}.jpg`), "fixture bytes");
      sources.push({ id, source: "Canonical provider", reference: "Current reading",
        personLinks: [{ personId: "verified-person" }], personLinksVerifiedAt: "2026-10-02",
        personLinksVerificationBasis: "Current original review" });
      return { id, atomId: id, archiveFile: `${id}.jpg`, status: "acquired", viewer,
        viewerPublishState: status === "published" ? "published" : "withheld-control",
        viewerPublishedAt: "2026-10-02", people: ["stale-person"], reference: "Stale reading" };
    }) };
    fs.writeFileSync(path.join(evidence, "familysearch-recovery-queue.json"), JSON.stringify(queue));
    fs.writeFileSync(path.join(evidence, "records-manifest.json"), JSON.stringify({
      records: [{ id: "record-0", viewer: { approvedAt: "2026-07-12" } }]
    }));
    const executable = importFamilySearch.replace(/^#!.*\n/, "").replace(/^import .*;\n/gm, "")
      .replaceAll("import.meta.url", "'fixture'");
    new Function("fs", "path", "createHash", "fileURLToPath", "writeJsonAtomic", "writeRegistryAtomic", "loadResearchStore", "process", "console", executable)(
      fs, path, createHash, () => path.join(root, "tools", "import.mjs"),
      (file, value) => fs.writeFileSync(file, JSON.stringify(value)), writeRegistryAtomic, () => ({ sources }),
      { env: { FAMILY_RECORD_ARCHIVE: archive } }, { log() {} }
    );
    const imported = JSON.parse(fs.readFileSync(path.join(evidence, "familysearch-recovery-queue.json")));
    assert.deepEqual(imported.targets.map((target) => target.status),
      ["published", "needs-alternate-route", "preserved-withheld", "acquired"]);
    for (const target of imported.targets) {
      assert.deepEqual(target.people, ["verified-person"]);
      assert.equal(target.reference, "Current reading");
      assert.equal(target.peopleVerificationBasis, "Current original review");
      assert.equal(target.viewer.title, undefined);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(evidence, "records-manifest.json")));
    assert.equal(manifest.records[0].viewer.approvedAt, "2026-07-12");
    assert.ok(manifest.records.slice(1).every((record) => !record.viewer));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical public registration feeds the compatibility publisher queue", () => {
  assert.match(register, /\["ready-download", "acquired", "published"\]\.includes\(candidate\.status\)/);
  assert.doesNotMatch(register, /\["ready", "acquired"\]/);
  assert.match(register, /const queuePath = path\.join\(projectRoot, "evidence", "record-recovery-queue\.json"\)/);
  assert.match(register, /const compatibilityTarget = \{/);
  assert.match(register, /queue\.targets\.push\(compatibilityTarget\)/);
  assert.match(register, /writeRegistryAtomic\(queuePath, queueBase, queue\)/);
});

test("canonical public registration can refresh a published record without resetting upload state", () => {
  assert.match(register, /\["ready-download", "acquired", "published"\]/);
  assert.match(register, /const alreadyPublished = route\.status === "published" && target\.viewerPublishState === "published"/);
  assert.match(register, /target\.viewerPublishState = alreadyPublished[\s\S]*?"published"/);
});

test("public publication validates viewer rights before uploading", () => {
  const rightsGuard = publish.indexOf('target.rights !== "family-viewer-approved"');
  const upload = publish.indexOf("await put(");
  assert.ok(rightsGuard >= 0);
  assert.ok(upload > rightsGuard);
});

test("GSP public PDFs are accepted consistently by recovery and attempt recording", () => {
  assert.match(recoverPublic, /"genpa\.org"/);
  assert.match(recordAcquisitionAttempt, /hostname === "genpa\.org"/);
});

test("legacy TLCPL public PDFs have a narrow plaintext registration exception", () => {
  assert.match(register, /url\.hostname === "obits\.toledolibrary\.org"/);
  assert.match(register, /\^\\\/obitfiles\\\/\\d\+\\\/\[\^\/\]\+\\\.pdf\$/);
  assert.doesNotMatch(register, /url\.hostname === "toledolibrary\.org"/);
});

test("public recovery can safely resume one canonical target after queue generation", () => {
  assert.match(recoverPublic, /\[string\]\$TargetId/);
  assert.match(recoverPublic, /\$queueTarget\.status -notin @\("ready", "acquired"\)/);
  assert.match(recoverPublic, /evidence\\acquisition\\targets\\\$TargetId\.json/);
  assert.match(recoverPublic, /\$_\.status -in @\("ready-download", "acquired"\)/);
  assert.match(recoverPublic, /status = "ready"/);
  assert.match(recoverPublic, /if \(\$TargetId -and \$target\.id -ne \$TargetId\) \{ continue \}/);
  assert.match(recoverPublic, /No ready public-record target matched \$TargetId/);
});

test("public source-master custody preserves TIFF and JPEG 2000 media types and extensions", () => {
  assert.match(register, /\["\.tif", "\.tiff"\]\.includes\(extension\).*"image\/tiff"/s);
  assert.match(importPublic, /mediaType === "image\/tiff".*return "\.tif"/s);
  assert.match(register, /extension === "\.jp2".*"image\/jp2"/s);
  assert.match(importPublic, /mediaType === "image\/jp2".*return "\.jp2"/s);
});

test("public recovery accepts NARA TIFF masters with matching signatures", () => {
  assert.match(recoverPublic, /image\/\(jpeg\|png\|webp\|tiff\)/);
  assert.match(recoverPublic, /\$isTiff/);
  assert.match(recoverPublic, /"\.tif" \{ \$isTiff \}/);
  assert.match(recoverPublic, /"\.tiff" \{ \$isTiff \}/);
});

test("public publication advances both compatibility and canonical custody state", () => {
  assert.match(publish, /canonical\.viewerPublishState = "published"/);
  assert.match(publish, /if \(route\) route\.status = "published"/);
  assert.match(publish, /writeJsonAtomic\(canonicalPath, canonical\)/);
});

test("provider publication advances canonical custody state for every private-record queue", () => {
  for (const implementation of [publishSubscription, publishFamilySearch]) {
    assert.match(implementation, /canonical\.viewerPublishState = "published"/);
    assert.match(implementation, /if \(route\) route\.status = "published"/);
    assert.match(implementation, /writeJsonAtomic\(canonicalPath, canonical\)/);
  }
});

test("record publication rebuilds every deployment projection after custody changes", () => {
  assert.equal(packageJson.scripts["records:atoms:migrate"], "npm run research:sync:inputs && npm run build");
});

test("pre-publication validation permits only canonically pending Blob inventory entries", () => {
  assert.match(checkViewerBlobInventory, /target\.viewerPublishState === "pending-upload"/);
  assert.match(checkViewerBlobInventory, /if \(pendingPublicationIds\.has\(record\.id\)\) continue/);
  assert.match(checkViewerBlobInventory, /missing viewer Blob inventory entry/);
});

test("FamilySearch custody imports refresh stale compatibility URLs and viewer presentation", () => {
  assert.match(importFamilySearch, /canonicalTargetRoot/);
  assert.match(importFamilySearch, /canonicalRoute/);
  assert.match(importFamilySearch, /target\.recordUrl = canonicalRoute\.sourceUrl/);
  assert.match(importFamilySearch, /target\.viewer = canonicalTarget\.viewer/);
});

test("canonical FamilySearch registration uses its declared archive filename", () => {
  assert.match(
    registerFamilySearch,
    /requestedArchiveFile \|\| baseTarget\?\.archiveFile \|\| canonicalTarget\?\.archiveFile/
  );
  assert.match(registerFamilySearch, /const target = canonicalTarget \|\| baseTarget/);
  assert.match(registerFamilySearch, /if \(canonicalTarget\) \{\s*registerCanonicalTarget/s);
  assert.match(registerFamilySearch, /\["ready-download", "acquired", "published"\]/);
  assert.match(registerFamilySearch, /if \(route\.status !== "published"\) route\.status = "acquired"/);
  assert.match(registerFamilySearch, /published \? "published" : "pending-upload"/);
  assert.match(registerFamilySearch, /familysearch\\\.org\\\/en\\\/memories\\\/memory\\\/\\d\+/);
});

test("FamilySearch archive intake accepts a new canonical target before queue projection", () => {
  assert.match(archiveFamilySearch, /ValidatePattern\('\^\[a-z0-9\]/);
  assert.match(archiveFamilySearch, /evidence\\acquisition\\targets\\\$TargetId\.json/);
  assert.match(archiveFamilySearch, /Get-Content -LiteralPath \$canonicalTargetPath -Raw \| ConvertFrom-Json/);
  assert.match(archiveFamilySearch, /if \(\$target\.id -ne \$TargetId\)/);
});

test("FamilySearch registration accepts both exact image ARK forms, but not index or catalogue pages", () => {
  const start = registerFamilySearch.indexOf("function isExactFamilySearchDownloadRoute(value)");
  const end = registerFamilySearch.indexOf("function registerCompatibilityTarget", start);
  const accepts = new Function(`${registerFamilySearch.slice(start, end)}; return isExactFamilySearchDownloadRoute;`)();
  for (const url of [
    "https://www.familysearch.org/ark:/61903/3:2:77XR-8F8M?groupId=M9SJ-2MJ",
    "https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS7X-W718",
    "https://www.familysearch.org/en/memories/memory/123456",
  ]) assert.equal(accepts(url), true, url);
  for (const url of [
    "https://www.familysearch.org/ark:/61903/1:1:JWM7-FWL",
    "https://www.familysearch.org/en/search/catalog/koha:244906",
    "https://www.familysearch.org/en/search/catalog/film?dgs=004450845",
    "https://www.familysearch.org.evil.example/ark:/61903/3:2:77XR-8F8M",
    "http://www.familysearch.org/ark:/61903/3:2:77XR-8F8M",
  ]) assert.equal(accepts(url), false, url);
});

test("FamilySearch gallery registration requires an exact person URL and item title", () => {
  const start = registerFamilySearch.indexOf("function isTitledMemoryRoute(route)");
  const end = registerFamilySearch.indexOf("function registerCompatibilityTarget", start);
  const accepts = new Function(`${registerFamilySearch.slice(start, end)}; return isTitledMemoryRoute;`)();
  const sourceUrl = "https://www.familysearch.org/en/tree/person/memories/ABCD-123";
  const memoryTitle = "Family photograph";
  assert.equal(accepts({ sourceUrl, memoryTitle }), true);
  assert.equal(accepts({ sourceUrl }), false);
  assert.equal(accepts({ sourceUrl, memoryTitle: " " }), false);
  assert.equal(accepts({ sourceUrl: `${sourceUrl}?personId=OTHER`, memoryTitle }), false);
  assert.equal(accepts({ sourceUrl: sourceUrl.replace("familysearch.org/", "familysearch.org.example/"), memoryTitle }), false);
});

test("parallel FamilySearch registrations serialize compatibility-queue writes", () => {
  assert.match(registerFamilySearch, /withFileLockSync\(queuePath/);
  assert.match(registerFamilySearch, /const currentQueue = JSON\.parse\(fs\.readFileSync\(queuePath/);
  assert.match(registerFamilySearch, /writeJsonAtomic\(queuePath, currentQueue\)/);
});

test("FamilySearch registration refreshes verified people and preserves withheld controls", () => {
  assert.match(registerFamilySearch, /const exactPeople = \(source\.personLinks \|\| \[\]\)\.map/);
  assert.match(registerFamilySearch, /previous\?\.acquiredAt \|\| target\.acquiredAt \|\| acquiredAt/);
  assert.match(registerFamilySearch, /viewerPublishState: publishEligible \? \(published \? "published" : "pending-upload"\) : "withheld-control"/);
});

test("person reverification cannot publish a withheld control record", () => {
  assert.match(
    verifyRecordPeople,
    /if \(target\.viewerPublishState === "withheld-control"\) \{\s*delete record\.viewer;/
  );
});

test("public source-master repairs require exact old and replacement byte guards", () => {
  assert.match(replacePublicMaster, /ExpectedOldSha256/);
  assert.match(replacePublicMaster, /ExpectedNewSha256/);
  assert.match(replacePublicMaster, /ExpectedNewLength/);
  assert.match(replacePublicMaster, /Existing archive SHA-256 does not match ExpectedOldSha256/);
  assert.match(replacePublicMaster, /The staged replacement is not EFS encrypted/);
  assert.match(replacePublicMaster, /Move-Item -LiteralPath \$destination -Destination \$backup/);
  assert.match(replacePublicMaster, /register-public-record\.mjs --target \$TargetId/);
  assert.equal(
    packageJson.scripts["records:archive:replace:win"],
    "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File tools/replace-public-master-windows.ps1"
  );
});

test("subscription publication writes its own manifest viewer block and never reruns the stale-copy import", () => {
  assert.match(publishSubscription, /manifestViewerFor\(\{ canonical, item: target, record \}, publishedAt\)/);
  assert.match(publishSubscription, /record\.viewer = viewer;\n  writeRegistryAtomic\(manifestPath, manifestBase, manifest\)/);
  assert.match(publishSubscription, /queueFieldsFromManifest\(record\)/);
  assert.match(publishSubscription, /register its source master in the records manifest first/);
  assert.ok(publishSubscription.indexOf("register its source master in the records manifest first") < publishSubscription.indexOf("await put("));
  assert.doesNotMatch(packageJson.scripts["records:publish:subscriptions"], /records:import:subscriptions/);
});
