import { EventEmitter } from "node:events";
import { assertOwnedPage, waitForOwnedPopup } from "./owned-browser-popup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openSharedChromeTask, sharedChromeEndpoint } from "./shared-chrome-task.mjs";
import { selectStaleParkedLeases, sweepStaleParkedLeases } from "./shared-browser-bridge-client.mjs";

test("FamilySearch shared-window actions do not emulate latency or throttle bandwidth", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Network\.emulateNetworkConditions/);
  assert.doesNotMatch(source, /downloadThroughput|uploadThroughput/);
  assert.doesNotMatch(source, /FAMILYSEARCH_(?:NETWORK_LIMIT|DOWNLOAD_KBPS|UPLOAD_KBPS)/);
});

test("FamilySearch free image browsing keeps record navigation and bounded index scans explicit", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const viewerNavigationSource = browserSource.slice(
    browserSource.indexOf("async function navigateViewerToImage"),
    browserSource.indexOf("async function assertViewerGroup")
  );
  const dispatcherSource = fs.readFileSync(new URL("./familysearch-cdp-dispatch-windows.ps1", import.meta.url), "utf8");
  const wrapperSource = fs.readFileSync(new URL("./familysearch-windows.ps1", import.meta.url), "utf8");
  assert.match(browserSource, /args\.has\("--links"\) \? "links" : args\.has\("--scan-index"\) \? "scan-index" : args\.has\("--scan-results"\) \? "scan-results" : args\.has\("--scan-transcripts"\) \? "scan-transcripts" : args\.has\("--context"\) \? "context" : args\.has\("--record"\) \? "record"/);
  assert.match(browserSource, /imageCount < 1 \|\| imageCount > 500/);
  assert.match(browserSource, /const startImage = Number\(imageNumber \|\| "1"\)/);
  assert.match(browserSource, /for \(let image = startImage; image <= endImage; image \+= 1\)/);
  assert.match(browserSource, /capture" && !recordUrl && imageNumber/);
  assert.match(browserSource, /selectedImageThumbnailUrl = await navigateViewerToImage\(page, imageNumber\)/);
  assert.match(browserSource, /--capture-count requires --image and a bounded count from 1 through 50/);
  assert.match(browserSource, /--capture-images requires 1 through 100 unique comma-separated positive image numbers/);
  assert.match(browserSource, /saveExactThumbnailDistribution\(page, context, job\.thumbnailUrl, job\.numberedPath, \{ auditCapture: true \}\)/);
  assert.match(browserSource, /captureWorkerCount = Math\.min\(4, captureJobs\.length\)/);
  assert.match(browserSource, /auditCapture[\s\S]*\? \[`\$\{selectedBase\}\/dist\.jpg`\]/);
  assert.match(browserSource, /const thumbnailUrl = await navigateViewerToImage\(page, String\(currentImage\), \{ quiet: true \}\)/);
  assert.doesNotMatch(browserSource, /navigateViewerToImage\(page, String\(currentImage\), \{ quiet: true, select: false \}\)/);
  assert.match(browserSource, /FamilySearch selected film index \$\{selectedIndex\} after requesting image \$\{requestedImage\}/);
  assert.match(browserSource, /deepzoomcloud\/dz\/v1\/\$\{selectedArk\}\/thumb_p200\.jpg/);
  assert.match(browserSource, /Completed bounded exact-image capture/);
  assert.match(browserSource, /refusing a possibly stale frame/);
  assert.match(browserSource, /refusing cross-group evidence/);
  assert.match(browserSource, /scan-index[\s\S]*assertViewerGroup\(page, target\.searchParams\.get\("groupId"\)\)/);
  assert.match(browserSource, /img\[alt\^="Image \$\{formattedRequestedImage\} "\]/);
  assert.match(browserSource, /\[aria-label\^="Image \$\{formattedRequestedImage\} of "\]/);
  assert.match(browserSource, /const requestedImageText = String\(requestedImage \?\? ""\)\.trim\(\)/);
  assert.match(browserSource, /if \(!\/\^\\d\+\$\/\.test\(requestedImageText\)\)/);
  assert.match(browserSource, /Number\.isSafeInteger\(requestedImageNumber\)/);
  assert.match(browserSource, /const normalizedRequestedImage = String\(requestedImageNumber\)/);
  assert.match(browserSource, /requestedImageNumber\.toLocaleString\("en-US"\)/);
  assert.match(browserSource, /const numberedGridItems = page\.locator\('\[class\*="gridItem"\]'\)/);
  assert.match(browserSource, /attempt < 80 && !numberedGridItem/);
  assert.match(browserSource, /numberedGridItems\.evaluateAll/);
  assert.match(browserSource, /viewerUrl\.pathname\.match\(\/\\\/ark:\\\/61903\\\//);
  assert.match(browserSource, /Number\(selectedIndex\) \+ 1 === requestedImageNumber/);
  assert.doesNotMatch(browserSource, /Number\(requestedImage\)/);
  assert.match(browserSource, /item\.getClientRects\(\)\.length > 0/);
  assert.match(browserSource, /replace\(\/,\/g, ""\)\.trim\(\) === wanted/);
  assert.match(browserSource, /for \(let attempt = 0; attempt < 80; attempt \+= 1\)/);
  assert.match(browserSource, /if \(deepZoomSource\) return deepZoomSource/);
  assert.match(browserSource, /numberedGridItem\.locator\('img\[src\*="thumb_p200"\]'\)/);
  assert.match(browserSource, /selected image \$\{selectedImageValue\} after requesting \$\{requestedImage\}/);
  assert.match(browserSource, /const firstGridImage = page\.locator\('\[aria-label\^="Image "\]'\)/);
  assert.doesNotMatch(viewerNavigationSource, /input\[name\*="image" i\], input\[type="number"\]/);
  assert.match(viewerNavigationSource, /getByRole\("spinbutton", \{ name: "Enter Image number", exact: true \}\)/);
  assert.match(viewerNavigationSource, /const selectedViewerUrl = new URL\(page\.url\(\)\)/);
  assert.match(viewerNavigationSource, /const selectedIndex = selectedViewerUrl\.searchParams\.get\("i"\)/);
  assert.match(viewerNavigationSource, /Number\(selectedIndex\) \+ 1 !== requestedImageNumber/);
  assert.match(viewerNavigationSource, /name: `Go to image \$\{formattedRequestedImage\}`, exact: true/);
  assert.match(browserSource, /if \(!thumbnailUrl\) \{[\s\S]*did not return the exact image distribution for audit capture/);
  assert.match(browserSource, /pageCount < 1 \|\| pageCount > 50/);
  assert.match(browserSource, /Completed bounded result scan/);
  assert.match(browserSource, /Transcript match on image \$\{image\}.*\$\{page\.url\(\)\}/);
  assert.match(browserSource, /Finding catalog results just got easier\|Search for records using full-text search while in catalog/);
  assert.match(browserSource, /for \(let currentPage = 1; currentPage < requestedPage; currentPage \+= 1\) \{\s*await dismissCatalogTourIfVisible\(page\);/);
  assert.match(browserSource, /await nextPage\.click\([\s\S]*?await page\.waitForTimeout\(1_500\);\s*await dismissCatalogTourIfVisible\(page\);/);
  assert.match(browserSource, /dismissCatalogTourIfVisible/);
  assert.match(browserSource, /target\.hostname !== "www\.familysearch\.org"/);
  assert.match(dispatcherSource, /"scan-index"/);
  assert.match(dispatcherSource, /"scan-index"[\s\S]*if \(\$Image -gt 0\) \{ \$nodeArgs \+= @\("--image", \[string\]\$Image\) \}/);
  assert.match(dispatcherSource, /"scan-transcripts"/);
  assert.match(dispatcherSource, /"scan-results"/);
  assert.match(wrapperSource, /"scan-index"/);
  assert.match(wrapperSource, /"scan-transcripts"/);
  assert.match(wrapperSource, /"scan-results"/);
});

test("FamilySearch source and context inspection stay scoped to the requested item", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const dispatcherSource = fs.readFileSync(new URL("./familysearch-cdp-dispatch-windows.ps1", import.meta.url), "utf8");
  assert.match(browserSource, /shortestMatch/);
  assert.match(browserSource, /xpath=ancestor::\*\[\.\/\/button\[normalize-space\(\.\)='View'\]\]\[1\]/);
  assert.match(browserSource, /--context --record accepts only https:\/\/www\.familysearch\.org URLs/);
  assert.match(dispatcherSource, /if \(\$Record\) \{ \$nodeArgs \+= @\("--record", \$Record\) \}/);
});

test("FamilySearch ARK fallback capture prefers the full-resolution distribution", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const fallbackBlock = browserSource.match(/else if \(fallbackImageArk\) \{([\s\S]*?)\n    \}/)?.[1] || "";
  assert.match(fallbackBlock, /deepzoomcloud\/dz\/v1\/3:1:\$\{fallbackImageArk\}/);
  assert.match(fallbackBlock, /captureUrls\.push\(`\$\{fallbackBase\}\/dist\.jpg`, `\$\{fallbackBase\}\/thumb_p200\.jpg`\)/);
  assert.ok(
    fallbackBlock.indexOf("/dist.jpg") < fallbackBlock.indexOf("/thumb_p200.jpg"),
    "the source master fallback must try the full-resolution distribution before the thumbnail"
  );
});

test("FamilySearch exact record pages capture their one embedded source image instead of the viewer grid", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  assert.match(browserSource, /exactRecordPage/);
  assert.match(browserSource, /page\.locator\("img"\)\.evaluateAll/);
  assert.match(browserSource, /source\.includes\("\/deepzoomcloud\/dz\/v1\/"\)/);
  assert.match(browserSource, /exactRecordImageSources\.length !== 1/);
  assert.match(browserSource, /refusing an ambiguous source-master capture/);
  assert.match(browserSource, /exactRecordBase.*replace\(\/\\\/scale/);
  assert.match(browserSource, /captureUrls\.push\(`\$\{exactRecordBase\}\/dist\.jpg`, `\$\{exactRecordBase\}\/thumb_p1000\.jpg`\)/);
});

test("FamilySearch source-master downloads use the exact record-page distribution before opening the viewer grid", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const downloadBlock = browserSource.slice(
    browserSource.indexOf('if (mode === "download-record")'),
    browserSource.indexOf('if (mode === "inspect" && recordUrl)')
  );
  assert.match(downloadBlock, /: await saveDeepZoomDistribution\(page, context, downloadPath\)/);
  assert.ok(
    downloadBlock.indexOf("saveDeepZoomDistribution(page, context, downloadPath)") < downloadBlock.indexOf("Check Image Availability"),
    "the exact record-page image must be attempted before the viewer is opened"
  );
  assert.match(browserSource, /refusing an ambiguous source-master download/);
  assert.match(browserSource, /for \(const name of \["dist\.jpg", "thumb_p1000\.jpg"\]\)/);
});

test("FamilySearch numbered source-master downloads bind the exact requested film frame before saving", () => {
  const browserSource = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const downloadBlock = browserSource.slice(
    browserSource.indexOf('if (mode === "download-record")'),
    browserSource.indexOf('if (mode === "inspect" && recordUrl)')
  );
  assert.match(downloadBlock, /if \(imageNumber\) \{\s*selectedDownloadThumbnailUrl = await navigateViewerToImage\(page, imageNumber\)/);
  assert.match(downloadBlock, /selectedDownloadThumbnailUrl[\s\S]*saveExactThumbnailDistribution\(page, context, selectedDownloadThumbnailUrl, downloadPath\)/);
  assert.ok(
    downloadBlock.indexOf("navigateViewerToImage(page, imageNumber)") < downloadBlock.indexOf("saveDeepZoomDistribution(page, context, downloadPath)"),
    "the requested film frame must be selected before any viewer distribution can be saved"
  );
});

test("FamilySearch temporary captures receive a guarded Windows temp path", () => {
  const dispatcherSource = fs.readFileSync(new URL("./familysearch-cdp-dispatch-windows.ps1", import.meta.url), "utf8");
  assert.match(dispatcherSource, /-OutFile is required for capture mode/);
  assert.match(dispatcherSource, /FAMILYSEARCH_CAPTURE_PATH = Join-Path \(\[IO\.Path\]::GetTempPath\(\)\) \$OutFile/);
  assert.match(dispatcherSource, /FamilySearch temporary capture did not create the expected first output for \$OutFile/);
  assert.match(dispatcherSource, /Remove-Item Env:FAMILYSEARCH_CAPTURE_PATH/);
});

test("FamilySearch affinity slots bind a reusable background tab and routine modes never foreground it", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const affinityBlock = source.slice(source.indexOf("async function getOrCreateSharedAffinityPage"), source.indexOf("async function windowIdForTarget"));
  assert.match(source, /family-history-familysearch-affinity-\$\{affinitySlot\}\.json/);
  assert.match(source, /getOrCreateSharedAffinityPage/);
  assert.match(source, /controlled\.reused \? "Reusing" : "Created"/);
  assert.match(source, /if \(mode === "signin"\) \{\s*await page\.bringToFront\(\);/);
  assert.equal((source.match(/\.bringToFront\(/g) || []).length, 1);
  assert.match(affinityBlock, /connection\.adoptPage\(controlled\.page, \{ root: true \}\)/);
  assert.match(affinityBlock, /connection\.adoptPage\(page, \{ root: true \}\)/);
  assert.match(affinityBlock, /savedWindowMatches/);
  assert.doesNotMatch(affinityBlock, /windowIds|exactly one page window|sole shared window/);
  assert.match(source, /sharedConnection\.ownedPages\(\)\.filter\(\(item\) => item !== sharedPersistentPage\)/);
  assert.doesNotMatch(source, /sharedBaselinePages|context\.pages\(\)\.filter\(\(item\) => !sharedBaselinePages\.has/);
  assert.match(source, /clearFamilySearchAffinityRecords\(\)/);
});

test("FamilySearch pause remains available for multi-window cleanup and closes only owned tabs", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const cleanupBlock = source.match(/if \(mode === "stop" \|\| mode === "pause"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(cleanupBlock, /bridgeControl\("lease\.list"\)/);
  assert.match(cleanupBlock, /leasedTargetIds\.has\(item\.targetId\) \|\|[\s\S]*recordedTargetIds\.has\(item\.targetId\)/);
  assert.match(cleanupBlock, /recordedTargetIds\.has\(item\.targetId\) && isFamilySearchUrl\(item\.page\.url\(\)\)/);
  assert.doesNotMatch(cleanupBlock, /\.filter\(\(item\) => isFamilySearchUrl\(item\.page\.url\(\)\) \|\|/);
  assert.match(cleanupBlock, /await Promise\.all\(pages\.map/);
  assert.match(cleanupBlock, /clearFamilySearchAffinityRecords\(\);[\s\S]*process\.exit\(0\);/);
  assert.ok(source.indexOf('if (mode === "stop" || mode === "pause")') < source.indexOf("getOrCreateSharedAffinityPage"));
});

test("family clients acquire a broker lease before attaching to shared Chrome", () => {
  const source = fs.readFileSync(new URL("./shared-browser-bridge-client.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('bridgeControl("lease.acquire"') < source.indexOf("chromium.connectOverCDP(browserState.cdpEndpoint"));
  assert.match(source, /bridgeControl\("browser\.ensure"\)/);
  assert.doesNotMatch(source, /bridgeControl\("status"\)/);
  assert.match(source, /expectedTargets\.has\(identity\.targetId\)/);
  assert.match(source, /opener[\s\S]*ownedPages\.has\(opener\)/);
  assert.match(source, /if \(lifetime === "session"\)[\s\S]*lease\.release[\s\S]*lease\.park/);
});

test("every family client sweeps abandoned parked leases after acquiring its own", () => {
  const source = fs.readFileSync(new URL("./shared-browser-bridge-client.mjs", import.meta.url), "utf8");
  const acquire = source.indexOf('bridgeControl("lease.acquire"');
  const sweep = source.indexOf("await sweepStaleParkedLeases({ namespace, affinitySlot, currentLeaseId: lease.leaseId })");
  assert.ok(acquire > 0 && sweep > acquire);
  assert.ok(sweep < source.indexOf("chromium.connectOverCDP(browserState.cdpEndpoint"));
});

test("stale parked lease selection supersedes same-slot parks and expires abandoned ones", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const lease = (leaseId, extra) => ({ leaseId, namespace: "family-history", state: "parked", lifetime: "manual", heartbeatAt: ago(5), ...extra });
  const leases = [
    lease("current", { affinitySlot: "archion-geradstetten", heartbeatAt: ago(600) }),
    lease("same-slot-old", { affinitySlot: "archion-geradstetten", heartbeatAt: ago(45) }),
    lease("same-slot-fresh", { affinitySlot: "archion-geradstetten", heartbeatAt: ago(10) }),
    lease("other-slot-recent", { affinitySlot: "gro-orders", heartbeatAt: ago(120) }),
    lease("other-slot-abandoned", { affinitySlot: "gro-orders", heartbeatAt: ago(7 * 60) }),
    lease("active", { state: "active", affinitySlot: "archion-geradstetten", heartbeatAt: ago(900) }),
    lease("released", { state: "released", heartbeatAt: ago(900) }),
    lease("foreign-namespace", { namespace: "generic", heartbeatAt: ago(900) }),
    lease("persistent-recent", { lifetime: "persistent", affinitySlot: "archion-geradstetten", heartbeatAt: ago(23 * 60) }),
    lease("persistent-old", { lifetime: "persistent", affinitySlot: "monreale-dgs56", heartbeatAt: ago(25 * 60) }),
    lease("protected", { lifetime: "persistent", affinitySlot: "subscription-providers", heartbeatAt: ago(9_000) }),
    lease("undated", { heartbeatAt: undefined, updatedAt: undefined, createdAt: undefined })
  ];
  const selected = selectStaleParkedLeases(leases, {
    namespace: "family-history",
    affinitySlot: "archion-geradstetten",
    currentLeaseId: "current",
    now
  }).map((item) => item.leaseId);
  assert.deepEqual(selected, ["same-slot-old", "other-slot-abandoned", "persistent-old"]);
  assert.deepEqual(selectStaleParkedLeases(null, { namespace: "family-history" }), []);
});

test("stale parked lease sweep releases each lease with its exact targets closed", async () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const calls = [];
  const control = async (method, params) => {
    calls.push([method, params]);
    if (method === "lease.list") return [
      { leaseId: "old", namespace: "family-history", state: "parked", lifetime: "manual", heartbeatAt: "2026-11-08T09:38:00Z" },
      { leaseId: "fails", namespace: "family-history", state: "parked", lifetime: "manual", heartbeatAt: "2026-11-08T09:38:00Z" },
      { leaseId: "new", namespace: "family-history", state: "parked", lifetime: "manual", heartbeatAt: "2026-11-11T11:59:00Z" }
    ];
    if (params.leaseId === "fails") throw new Error("Unknown lease");
    return { state: "released" };
  };
  const released = await sweepStaleParkedLeases({ namespace: "family-history", affinitySlot: "x", currentLeaseId: "mine", control, now });
  assert.deepEqual(released, ["old"]);
  assert.deepEqual(calls.slice(1), [
    ["lease.release", { leaseId: "old", closeTargets: true }],
    ["lease.release", { leaseId: "fails", closeTargets: true }]
  ]);
});

test("subscription stop targets only leased or affinity-recorded tabs", () => {
  const source = fs.readFileSync(new URL("./subscription-cdp.mjs", import.meta.url), "utf8");
  const cleanupBlock = source.slice(source.indexOf("async function stopDedicatedBrowser"), source.indexOf("function readSubscriptionAffinityRecords"));
  assert.match(cleanupBlock, /connection\.lease\?\.descendants/);
  assert.match(cleanupBlock, /recordedTargets\.has\(targetInfo\.targetId\)/);
  assert.match(cleanupBlock, /if \(!recordedTargets\.has\(targetInfo\.targetId\)\) return false;/);
  assert.match(cleanupBlock, /Boolean\(providerForUrl\(page\.url\(\)\)\)/);
});

test("FamilySearch routine cleanup closes only the exact recorded affinity tab", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const dispatcherSource = fs.readFileSync(new URL("./familysearch-cdp-dispatch-windows.ps1", import.meta.url), "utf8");
  const wrapperSource = fs.readFileSync(new URL("./familysearch-windows.ps1", import.meta.url), "utf8");
  const cleanupBlock = source.match(/if \(mode === "close-affinity"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(cleanupBlock, /inventory\.find\(\(item\) => item\.targetId === saved\.targetId\)/);
  assert.match(cleanupBlock, /isFamilySearchUrl\(controlled\.page\.url\(\)\)/);
  assert.match(cleanupBlock, /inventory\.length <= 1/);
  assert.match(cleanupBlock, /await controlled\.page\.close/);
  assert.match(cleanupBlock, /fs\.rmSync\(affinityPath, \{ force: true \}\)/);
  assert.doesNotMatch(cleanupBlock, /clearFamilySearchAffinityRecords/);
  assert.match(dispatcherSource, /"close-affinity" \{ \$nodeArgs \+= "--close-affinity" \}/);
  assert.match(wrapperSource, /"close-affinity"/);
});

test("shared Chrome tasks lease the exact created background target and close only owned pages", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [41] });
  const task = await openSharedChromeTask({
    chromium: fixture.chromium,
    endpoint: sharedChromeEndpoint,
    taskLabel: "GRO",
    affinitySlot: "gro-orders",
    bridgeClient: fixture.bridgeClient
  });

  assert.equal(task.windowId, 41);
  assert.equal(task.affinitySlot, "gro-orders");
  assert.deepEqual(fixture.createdTargetOptions, {
    url: "about:blank",
    newWindow: false,
    background: true
  });
  assert.equal(fixture.baselinePages[0].closed, false);
  assert.equal(task.page.frontCount, 0);

  assert.equal(task.manualStepRevealed, false);
  await task.showForManualStep("payment review");
  assert.equal(task.page.frontCount, 1);
  assert.equal(task.manualStepRevealed, true);
  await task.close();

  assert.equal(task.page.closed, true);
  assert.equal(fixture.baselinePages[0].closed, false);
  assert.equal(fixture.browser.closed, true);
});

test("shared Chrome tasks tolerate unrelated page targets in multiple windows", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [41, 42] });
  const task = await openSharedChromeTask({ chromium: fixture.chromium, taskLabel: "GRO", bridgeClient: fixture.bridgeClient });
  assert.equal(task.windowId, 41);
  assert.deepEqual(fixture.adoptedTargets, [{ targetId: task.targetId, root: true, windowId: 41 }]);
  assert.equal(fixture.baselinePages.every((page) => !page.closed), true);
  await task.close();
  assert.equal(fixture.baselinePages.every((page) => !page.closed), true);
});

test("shared Chrome tasks reconnect one exact parked affinity target for a manual-step retry", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [41, 42], parkedRootIndex: 1 });
  const task = await openSharedChromeTask({
    chromium: fixture.chromium,
    taskLabel: "research-findmypast",
    affinitySlot: "hannah-brown-fmp-r565",
    reconnectExisting: true,
    bridgeClient: fixture.bridgeClient,
  });

  assert.equal(task.reused, true);
  assert.equal(task.targetId, fixture.baselinePages[1].targetId);
  assert.equal(fixture.createdTargetOptions, null);
  assert.equal(fixture.connectArgs.reconnectExisting, true);
  await task.leaveOpen();
  assert.equal(fixture.baselinePages[1].closed, false);
  assert.equal(fixture.parked, true);
});

test("shared Chrome tasks ignore a windowless page target when one real shared window remains", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [41, null] });
  const task = await openSharedChromeTask({ chromium: fixture.chromium, taskLabel: "research-familysearch", bridgeClient: fixture.bridgeClient });

  assert.equal(task.windowId, 41);
  assert.equal(fixture.createdTargetOptions?.newWindow, false);
  await task.close();
  assert.equal(fixture.baselinePages.every((page) => !page.closed), true);
});

test("shared Chrome tasks refuse a profile with only windowless page targets", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [null] });
  await assert.rejects(
    openSharedChromeTask({ chromium: fixture.chromium, taskLabel: "research-familysearch", bridgeClient: fixture.bridgeClient }),
    /exact window-backed target/
  );
  assert.equal(fixture.createdTargetOptions?.newWindow, false);
  assert.equal(fixture.baselinePages.every((page) => !page.closed), true);
});

test("shared Chrome tasks refuse alternate CDP endpoints", async () => {
  const fixture = fakeChrome({ baselineWindowIds: [41] });
  await assert.rejects(
    openSharedChromeTask({ chromium: fixture.chromium, endpoint: "http://127.0.0.1:9999", taskLabel: "GRO", bridgeClient: fixture.bridgeClient }),
    /restricted to the one shared localhost/
  );
  assert.equal(fixture.browser.closed, false);
});

function fakeChrome({ baselineWindowIds, parkedRootIndex = null }) {
  let serial = 0;
  const listeners = new Map();
  const targetWindows = new Map();
  const pages = baselineWindowIds.map((windowId) => page(`baseline-${++serial}`, windowId));
  const baselinePages = [...pages];
  const adoptedTargets = [];
  let connectArgs = null;
  let parked = false;
  for (const item of pages) targetWindows.set(item.targetId, item.windowId);
  let createdTargetOptions = null;

  const context = {
    pages: () => pages.filter((item) => !item.closed),
    browser: () => browser,
    on: (name, listener) => listeners.set(name, listener),
    off: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    async newCDPSession(item) {
      return {
        async send(method) {
          if (method === "Target.getTargetInfo") return { targetInfo: { targetId: item.targetId } };
          throw new Error(`unexpected page CDP method ${method}`);
        },
        async detach() {}
      };
    }
  };
  const browserSession = {
    async send(method, params) {
      if (method === "Browser.getWindowForTarget") {
        const windowId = targetWindows.get(params.targetId);
        if (windowId === null) throw new Error("Protocol error (Browser.getWindowForTarget): Browser window not found");
        return { windowId };
      }
      if (method === "Target.createTarget") {
        createdTargetOptions = params;
        const windowId = baselineWindowIds.find((candidate) => Number.isFinite(candidate)) ?? null;
        const item = page(`created-${++serial}`, windowId);
        pages.push(item);
        targetWindows.set(item.targetId, windowId);
        await listeners.get("page")?.(item);
        return { targetId: item.targetId };
      }
      if (method === "Target.closeTarget") {
        const item = pages.find((candidate) => candidate.targetId === params.targetId);
        if (item) item.closed = true;
        return { success: true };
      }
      throw new Error(`unexpected browser CDP method ${method}`);
    },
    async detach() {}
  };
  const browser = {
    closed: false,
    contexts: () => [context],
    async newBrowserCDPSession() { return browserSession; },
    async close() { this.closed = true; }
  };
  const chromium = { async connectOverCDP() { return browser; } };
  const bridgeClient = {
    async connect(args) {
      connectArgs = args;
      return {
        browser,
        context,
        ...(Number.isInteger(parkedRootIndex) ? { lease: { rootTargetId: baselinePages[parkedRootIndex].targetId } } : {}),
        async adoptPage(item, { root = false } = {}) {
          const identity = { targetId: item.targetId, ...(Number.isFinite(item.windowId) ? { windowId: item.windowId } : {}) };
          adoptedTargets.push({ ...identity, root });
          return identity;
        },
        async forgetTarget() {},
        async park() { parked = true; },
        async closeClient() { await browser.close(); }
      };
    }
  };

  return {
    chromium,
    bridgeClient,
    get connectArgs() { return connectArgs; },
    get parked() { return parked; },
    browser,
    baselinePages,
    adoptedTargets,
    get createdTargetOptions() { return createdTargetOptions; }
  };
}

function page(targetId, windowId) {
  return {
    targetId,
    windowId,
    closed: false,
    frontCount: 0,
    isClosed() { return this.closed; },
    async close() { this.closed = true; },
    async bringToFront() { this.frontCount += 1; },
    async opener() { return null; }
  };
}

// Regression: another shared-profile task may create a tab while our leased
// FamilySearch page navigates in place or opens its own popup.

function popupFixture() {
  const context = new EventEmitter();
  const events = new EventEmitter();
  let resolvePopup, rejectPopup;
  const origin = {
    waitForEvent(event) {
      assert.equal(event, "popup");
      return new Promise((resolve, reject) => {
        resolvePopup = resolve;
        rejectPopup = reject;
        events.once(event, resolve);
      });
    }
  };
  const owned = new Set([origin]);
  const adopted = [];
  const connection = {
    ownedPages: () => [...owned],
    async adoptPage(page) { adopted.push(page); owned.add(page); }
  };
  const foreign = new Proxy({}, { get(_target, key) {
    if (key === "then") return undefined; // Promise resolution inspects thenables.
    throw new Error("Foreign page was accessed");
  } });
  return { context, events, origin, owned, adopted, connection, foreign,
    popup: () => ({ opener: async () => origin }),
    timeout: () => rejectPopup(Object.assign(new Error("popup timeout"), { name: "TimeoutError" })),
    fail: (error) => rejectPopup(error), resolve: (page) => resolvePopup(page) };
}

test("owned popup wait ignores foreign context tabs during same-tab navigation", async () => {
  const f = popupFixture();
  const pending = waitForOwnedPopup(f.origin, f.connection);
  f.context.emit("page", f.foreign);
  f.timeout();
  assert.equal(await pending, null);
  assert.deepEqual(f.adopted, []);
  assert.deepEqual(f.connection.ownedPages(), [f.origin]);
});

test("only a leased origin popup is adopted before it can be read or closed", async () => {
  const f = popupFixture();
  const pending = waitForOwnedPopup(f.origin, f.connection);
  f.context.emit("page", f.foreign);
  const popup = f.popup();
  f.events.emit("popup", popup);
  f.context.emit("page", f.foreign);
  assert.equal(await pending, popup);
  assert.deepEqual(f.adopted, [popup]);
  assertOwnedPage(popup, f.connection);
  assert.throws(() => assertOwnedPage(f.foreign, f.connection), /outside the current browser task lease/);
});

test("popup ownership fails closed on mismatched opener or rejected adoption", async () => {
  const f = popupFixture();
  const bad = waitForOwnedPopup(f.origin, f.connection);
  f.resolve({ opener: async () => f.foreign });
  await assert.rejects(bad, /opener is not the leased origin/);
  assert.deepEqual(f.adopted, []);
  const good = f.popup();
  f.connection.adoptPage = async () => { throw new Error("lease adoption denied"); };
  const rejected = waitForOwnedPopup(f.origin, f.connection);
  f.resolve(good);
  await assert.rejects(rejected, /lease adoption denied/);
  assert.deepEqual(f.connection.ownedPages(), [f.origin]);
});

test("non-timeout popup errors propagate and unleased origins cannot arm a wait", async () => {
  const f = popupFixture();
  const pending = waitForOwnedPopup(f.origin, f.connection);
  f.fail(new Error("page closed"));
  await assert.rejects(pending, /page closed/);
  await assert.rejects(waitForOwnedPopup(f.foreign, f.connection), /outside the current browser task lease/);
});

test("FamilySearch viewer and download routes never select context-wide popup events", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /context\.waitForEvent\("page"/);
  assert.match(source, /assertOwnedPage\(page, sharedConnection\);\s*const status = await page\.evaluate/);
  assert.match(source, /sharedConnection\.ownedPages\(\)\.filter\(\(item\) => isFamilySearchUrl/);
});

test("popup errors are observed while the initiating click is pending", async () => {
  const f = popupFixture();
  f.connection.adoptPage = async () => { throw new Error("lease adoption denied"); };
  const popupPromise = waitForOwnedPopup(f.origin, f.connection);
  f.resolve(f.popup());
  // Model the click's pending work; no unhandled rejection may escape here.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(popupPromise, /lease adoption denied/);
  assert.deepEqual(f.connection.ownedPages(), [f.origin]);
});

test("a failed click may abandon its armed popup wait without an unhandled rejection", async () => {
  const f = popupFixture();
  await assert.rejects(async () => {
    waitForOwnedPopup(f.origin, f.connection);
    f.fail(new Error("page closed during click"));
    throw new Error("click failed");
  }, /click failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.adopted, []);
});

test("FamilySearch's saved sign-in flag is declared before any top-level action can reach it", () => {
  const source = fs.readFileSync(new URL("./familysearch-film.mjs", import.meta.url), "utf8");
  const declaration = source.indexOf("let savedSignInAttempted = false;");
  const firstAwait = source.search(/^await /m);
  assert.ok(declaration > 0, "declaration present");
  assert.ok(firstAwait === -1 || declaration < firstAwait, "declared before the first top-level await");
  assert.ok(declaration < source.indexOf("async function assertFamilySearchSignedIn"), "declared before its user");
});
