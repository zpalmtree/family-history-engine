import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archionPurchaseNavigationUrl,
  assertArchionAccessMode,
  parseArchionViewerPageSelection
} from './archion-access-policy.mjs';

const helper = fs.readFileSync(new URL('./archion-access.mjs', import.meta.url), 'utf8');
const wrapper = fs.readFileSync(new URL('./archion-windows.ps1', import.meta.url), 'utf8');
// The needs-user projection, including the paid-route resume instructions this
// file asserts on, moved out of research-status.mjs into needs-user.mjs so the
// venue worklist could share one copy of the venue rules. Read both so the
// assertions keep holding wherever that code lives.
const status = [
  fs.readFileSync(new URL('./research-status.mjs', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('./needs-user.mjs', import.meta.url), 'utf8')
].join('\n');

test('Archion purchase flow is exact-target, exact-phrase, cost-guarded, and shared-window only', () => {
  assert.match(helper, /openSharedChromeTask/);
  assert.match(helper, /confirmation !== authorizationRequest\.guard\?\.requiredPhrase/);
  assert.match(helper, /item\.targetId === target\.id && item\.routeId === route\.id/);
  assert.match(helper, /authorizationRequest\.guard\?\.maxAmount !== 19\.9/);
  assert.match(helper, /exactPrice: \/19,90/);
  assert.match(helper, /locator\('#buybtn'\)/);
  assert.match(helper, /getByRole\('link', \{ name: \/Jetzt\\s\+1-Monats-Pass/);
  assert.match(wrapper, /127\.0\.0\.1:9226/);
  assert.match(wrapper, /FamilyHistorySubscriptionChromeSharedWindow/);
  assert.match(wrapper, /CreateAccount/);
  assert.match(helper, /Neues Konto erstellen/);
  assert.match(helper, /needsManualAccountStep/);
  assert.doesNotMatch(helper, /preserveTaskTab/);
  assert.match(helper, /if \(session\.manualStepRevealed\) await session\.leaveOpen\(\);\s*else await session\.close\(\);/);
  assert.match(helper, /Digitalisat anzeigen \\\(Viewer\\\)/);
  assert.match(wrapper, /viewer-inspect/);
  assert.match(wrapper, /capture/);
  assert.match(wrapper, /cleanup/);
  assert.match(wrapper, /\\d\{1,3\}/);
  assert.match(wrapper, /Pages/);
  assert.match(wrapper, /ZoomSteps/);
  assert.match(wrapper, /PanTop/);
  assert.match(wrapper, /PanMiddle/);
  assert.match(wrapper, /PanBottom/);
  assert.match(wrapper, /PanDeepBottom/);
  assert.match(wrapper, /CaptureTriplet/);
  assert.match(wrapper, /ReadRecognizedText/);
  assert.match(wrapper, /node @nodeArgs 2>&1 \| ForEach-Object/);
  assert.match(wrapper, /if \(\$nodeExitCode -ne 0\)/);
  assert.match(helper, /parseArchionViewerPageSelection/);
  assert.match(helper, /selectViewerPage/);
  assert.match(helper, /readViewerPageIndex/);
  assert.match(helper, /lastLabel: labels\.at\(-1\)/);
  assert.match(helper, /readViewerRenderState/);
  assert.match(helper, /settledRender\.pixelFingerprint === currentRender\.pixelFingerprint/);
  assert.match(helper, /Page\.captureScreenshot/);
  assert.match(helper, /createHash\('sha256'\)/);
  assert.match(helper, /did not render the requested zoom step/);
  assert.match(helper, /panViewerToTop/);
  assert.match(helper, /captureViewerImageInspectionMiddle/);
  assert.match(helper, /requested bounded top pan/);
  assert.match(helper, /panViewerToBottom/);
  assert.match(helper, /requested bounded bottom pan/);
  assert.match(helper, /captureViewerImageInspectionDeepBottom/);
  assert.match(helper, /pan-deep-bottom/);
  assert.match(helper, /captureTriplet/);
  assert.match(helper, /capture-triplet/);
  assert.match(helper, /pan-middle/);
  assert.match(helper, /span\.download:visible/);
  assert.match(helper, /captureViewerImageInspection/);
  assert.match(helper, /captured-scaled-viewer-inspection/);
  assert.match(helper, /inspectionPan/);
  assert.match(helper, /panBottom \? 'bottom' : panTop \? 'top' : 'default'/);
  assert.match(helper, /\.dvtoolbar:has\(a\.zoom-out\):visible/);
  assert.match(helper, /overlapping-viewer-toolbar-hidden-and-restored/);
  assert.match(helper, /element\.style\.setProperty\('visibility', 'hidden', 'important'\)/);
  assert.match(helper, /element\.style\.removeProperty\('visibility'\)/);
  assert.match(helper, /inspectExistingRecognizedText/);
  assert.match(helper, /span\.ocrtext:visible/);
  assert.match(helper, /requestRecognitionControlPresent/);
  assert.match(helper, /Texterkennung beauftragen/);
  assert.doesNotMatch(helper, /locator\('a\.ocr-text-scan:visible'\)/);
  assert.match(helper, /waitForEvent\('download'/);
  assert.match(helper, /requires one explicit viewer page index/);
  assert.match(helper, /reuse-confirmation-target/);
  assert.match(helper, /safe authorized subscription target ID/);
  assert.match(helper, /active subscription entitlement/);
  assert.match(helper, /exact-viewer-tabs-closed/);
  assert.match(helper, /candidate === page \|\| candidate\.isClosed\(\)/);
  assert.match(helper, /url\.origin === expectedOrigin && url\.pathname === expectedPath/);
  assert.match(helper, /resolveRouteAccessEntitlement/);
  assert.match(helper, /assertArchionAccessMode/);
  assert.match(helper, /const cleanupOnly = mode === 'cleanup'/);
  assert.match(helper, /const postAuditViewerInspection = mode === 'viewer-inspect'/);
  assert.match(helper, /target\.disposition === 'search-audit'/);
  assert.match(helper, /!cleanupOnly && !postAuditViewerInspection && !authorizedAccessRouteStatuses\.has\(route\.status\)/);
  assert.match(helper, /!cleanupOnly && Date\.parse\(route\.accessEntitlement\.expiresAt\) <= Date\.now\(\)/);
  assert.match(helper, /route\?\.provider !== 'Archion'/);
  assert.doesNotMatch(helper, /target\.provider !== 'Archion \/ FamilySearch'/);
  assert.match(wrapper, /ReuseConfirmationTarget/);
});

test('Archion mode policy prevents duplicate purchases and premature unknown-page capture', () => {
  assert.throws(() => assertArchionAccessMode({
    mode: 'purchase',
    directPurchase: false,
    routeStatus: 'ready-subscription-capture'
  }), /cannot enter purchase mode/);
  assert.doesNotThrow(() => assertArchionAccessMode({
    mode: 'purchase',
    directPurchase: true,
    routeStatus: 'needs-interactive-payment'
  }));
  assert.throws(() => assertArchionAccessMode({
    mode: 'capture',
    directPurchase: false,
    routeStatus: 'subscription-first'
  }), /exact Bild before capture/);
  for (const mode of ['inspect', 'viewer-inspect']) {
    assert.doesNotThrow(() => assertArchionAccessMode({
      mode,
      directPurchase: false,
      routeStatus: 'subscription-first'
    }));
  }
  assert.doesNotThrow(() => assertArchionAccessMode({
    mode: 'capture',
    directPurchase: false,
    routeStatus: 'ready-subscription-capture'
  }));
});

test('Archion inspection screenshots skip credential, contact, checkout, and payment states', () => {
  assert.match(helper, /input\[type="password"\]:visible/);
  assert.match(helper, /input\[autocomplete\^="cc-"\]:visible/);
  assert.match(helper, /sensitiveRoute/);
  assert.match(helper, /skipped-sensitive-state/);
  assert.doesNotMatch(helper, /\.fill\([^)]*(?:password|card|cvv)/i);
});

test('Archion viewer page batches are bounded, distinct, and inspection-only', () => {
  assert.deepEqual(parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '50,100,520',
    zoomStepsValue: '3'
  }), {
    requestedPage: '',
    requestedPages: ['50', '100', '520'],
    zoomSteps: 3
  });
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    requestedPagesValue: '75,100'
  }), /either one Archion viewer page or one bounded page batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'capture',
    requestedPagesValue: '50,75'
  }), /inspection-only/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: Array.from({ length: 21 }, (_, index) => String(index + 1)).join(',')
  }), /one to twenty/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '50,50'
  }), /cannot repeat/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'capture',
    requestedPage: '50',
    zoomStepsValue: '2'
  }), /zoom steps are inspection-only/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '5'
  }), /zero to four exact steps/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    panTop: true
  }), /requires one exact Bild or bounded page batch and at least one inspection zoom step/);
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '1',
    panTop: true
  }));
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '48',
    zoomStepsValue: '2',
    panMiddle: true
  }));
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '63',
    zoomStepsValue: '2',
    panDeepBottom: true
  }));
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '1',
    panBottom: true
  }));
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '50,51',
    zoomStepsValue: '1',
    panBottom: true
  }));
  assert.doesNotThrow(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '50,51',
    zoomStepsValue: '1',
    captureTriplet: true
  }));
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '50,51',
    captureTriplet: true
  }), /capture triplet requires one exact Bild/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    panMiddle: true
  }), /requires one single-item Bild batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '2',
    panMiddle: true
  }), /requires one single-item Bild batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '43,48',
    zoomStepsValue: '2',
    panMiddle: true
  }), /requires one single-item Bild batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '63',
    zoomStepsValue: '2',
    panDeepBottom: true
  }), /requires one single-item Bild batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPagesValue: '63,74',
    zoomStepsValue: '2',
    panDeepBottom: true
  }), /requires one single-item Bild batch/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '1',
    panMiddle: true,
    panBottom: true
  }), /only one bounded Archion pan direction or capture triplet/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '1',
    panTop: true,
    panBottom: true
  }), /only one bounded Archion pan direction or capture triplet/);
  assert.throws(() => parseArchionViewerPageSelection({
    mode: 'viewer-inspect',
    requestedPage: '50',
    zoomStepsValue: '1',
    panTop: true,
    captureTriplet: true
  }), /only one bounded Archion pan direction or capture triplet/);
  assert.match(helper, /captureViewerImageInspection\(page, requestedPage, 'middle'\)/);
  assert.match(helper, /one-item --pages batch/);
  assert.match(helper, /selectedLabel,[\s\S]*captureViewerImageInspectionMiddle/);
  assert.match(helper, /captureViewerImageInspection\(page, requestedPage, 'deep-bottom'\)/);
  assert.match(helper, /selectedLabel,[\s\S]*captureViewerImageInspectionDeepBottom/);
});

test('paid-route status instructions use the active service and cost instead of GRO-specific wording', () => {
  assert.match(status, /route\?\.serviceOption \|\| "purchase"/);
  assert.match(status, /formattedCost\(route\)/);
  assert.doesNotMatch(status, /authorized £12\.50 standard-certificate order/);
});

test('a hidden Archion purchase control may be followed only to the exact purchase page', () => {
  const base = 'https://www.archion.de/de/alle-archive/niedersachsen/x/braunschweig-st-martini/310721';
  assert.equal(archionPurchaseNavigationUrl('/de/zugang-kaufen', base), 'https://www.archion.de/de/zugang-kaufen');
  assert.equal(archionPurchaseNavigationUrl('https://www.archion.de/de/zugang-kaufen#top', base), 'https://www.archion.de/de/zugang-kaufen');
  for (const bad of ['/de/zugang-kaufen?voucher=1', '/de/konto', 'https://evil.example/de/zugang-kaufen', 'http://www.archion.de/de/zugang-kaufen', '', 'javascript:alert(1)']) {
    assert.throws(() => archionPurchaseNavigationUrl(bad, base), /Archion purchase control/);
  }
  assert.match(helper, /archionPurchaseNavigationUrl\(await purchaseLink\.getAttribute\('href'\), page\.url\(\)\)/);
  assert.match(helper, /if \(await purchaseLink\.isVisible\(\)\)/);
});

test('the Archion one-month guard requires ten recognitions and no automatic renewal in either wording', () => {
  const recognitions = /10\s+(?:On-Demand-)?Texterkennungen/i;
  assert.match('10 Texterkennungen', recognitions);
  assert.match('10 On-Demand-Texterkennungen Bis zu 10', recognitions);
  assert.doesNotMatch('25-Extra-Texterkennungen', recognitions);
  assert.match(helper, /tenRecognitions: \/10\\s\+\(\?:On-Demand-\)\?Texterkennungen\/i/);
  assert.match(helper, /noAutoRenewal: \/verlängert/);
});

test('the Archion purchase helper reveals the checkout tab for the user without touching payment', () => {
  assert.match(helper, /showForManualStep\('manual Archion checkout and payment'\)/);
  assert.match(helper, /zugang-kaufen\\\/checkout/);
});

test('a reused Archion route may rely on an access-confirmed pass that is ready for capture', () => {
  assert.match(helper, /\['acquired', 'published', 'ready-subscription-capture'\]\.includes\(authorizationRoute\.status\)/);
  assert.match(helper, /resolveRouteAccessEntitlement\(route,/);
});

test('Archion capture reports an exhausted download quota instead of a silent no-event', () => {
  assert.match(helper, /Download-Kontingent\[\^\.\]\*erreicht\/i\.test\(state\) \? 'download-quota-reached' : 'download-control-no-event'/);
  const detect = (text) => /Download-Kontingent[^.]*erreicht/i.test(text) ? 'download-quota-reached' : 'download-control-no-event';
  assert.equal(detect('Bildausschnitt herunterladen Das Download-Kontingent für diese Periode wurde erreicht.'), 'download-quota-reached');
  assert.equal(detect('Bildausschnitt herunterladen'), 'download-control-no-event');
});

test('a temporary Archion target file is viewer-only, outside the repository and explicitly marked', () => {
  const helperPath = fileURLToPath(new URL('./archion-access.mjs', import.meta.url));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archion-target-file-'));
  const run = (mode, file) => spawnSync(process.execPath, [
    helperPath, '--shared-window', '--endpoint', 'http://127.0.0.1:9226', '--mode', mode,
    '--target', 'archion-temporary-read', '--route', 'archion-temporary-read-route',
    '--confirmation', 'PAY archion-example-pass-2026-11',
    '--reuse-confirmation-target', 'archion-example-pass-2026-11',
    '--affinity-slot', 'archion-test', '--page', '70', '--target-file', file
  ], { encoding: 'utf8' });
  try {
    const marked = path.join(scratch, 'marked.json');
    fs.writeFileSync(marked, JSON.stringify({ id: 'archion-temporary-read', temporaryReadOnly: true, routes: [] }));
    const unmarked = path.join(scratch, 'unmarked.json');
    fs.writeFileSync(unmarked, JSON.stringify({ id: 'archion-temporary-read', routes: [] }));

    const capture = run('capture', marked);
    assert.notEqual(capture.status, 0);
    assert.match(capture.stderr, /allows viewer-inspect only/);

    const inRepository = run('viewer-inspect', fileURLToPath(new URL('../package.json', import.meta.url)));
    assert.notEqual(inRepository.status, 0);
    assert.match(inRepository.stderr, /outside the repository/);

    const notMarked = run('viewer-inspect', unmarked);
    assert.notEqual(notMarked.status, 0);
    assert.match(notMarked.stderr, /temporaryReadOnly: true/);

    // A marked file passes the file guard and stops at the ordinary route check.
    const noRoute = run('viewer-inspect', marked);
    assert.notEqual(noRoute.status, 0);
    assert.match(noRoute.stderr, /has no exact route archion-temporary-read-route/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const wrapper = fs.readFileSync(new URL('./archion-windows.ps1', import.meta.url), 'utf8');
  assert.match(wrapper, /-TargetFile is accepted only with -Mode viewer-inspect/);
});
