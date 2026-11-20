#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { openSharedChromeTask, sharedChromeEndpoint } from './shared-chrome-task.mjs';
import {
  archionPurchaseNavigationUrl,
  assertArchionAccessMode,
  parseArchionViewerPageSelection
} from './archion-access-policy.mjs';
import {
  authorizedAccessRouteStatuses,
  resolveRouteAccessEntitlement
} from './research-access-preemption.mjs';
import { requireConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetId = valueAfter('--target');
const routeId = valueAfter('--route') || targetId;
const confirmation = valueAfter('--confirmation');
const reuseConfirmationTargetId = valueAfter('--reuse-confirmation-target');
const mode = valueAfter('--mode');
const endpoint = valueAfter('--endpoint') || sharedChromeEndpoint;
const affinitySlot = valueAfter('--affinity-slot') || 'archion-access';
const requestedPageValue = valueAfter('--page');
const requestedPagesValue = valueAfter('--pages');
const zoomStepsValue = valueAfter('--zoom-steps');
const panTop = process.argv.includes('--pan-top');
const panMiddle = process.argv.includes('--pan-middle');
const panBottom = process.argv.includes('--pan-bottom');
const panDeepBottom = process.argv.includes('--pan-deep-bottom');
const captureTriplet = process.argv.includes('--capture-triplet');
const readRecognizedText = process.argv.includes('--read-recognized-text');
const createAccount = process.argv.includes('--create-account');
if (createAccount) requireConsent('account-registration');

if (!process.argv.includes('--shared-window') || endpoint !== sharedChromeEndpoint) {
  throw new Error(`Archion actions must use the shared Windows Chrome wrapper at ${sharedChromeEndpoint}.`);
}
if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(targetId)) throw new Error('Pass one safe Archion target ID.');
if (reuseConfirmationTargetId && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(reuseConfirmationTargetId)) {
  throw new Error('Pass one safe authorized subscription target ID.');
}
if (!['inspect', 'purchase', 'viewer-inspect', 'capture', 'cleanup'].includes(mode)) {
  throw new Error('Archion mode must be inspect, purchase, viewer-inspect, capture, or cleanup.');
}
const { requestedPage, requestedPages, zoomSteps } = parseArchionViewerPageSelection({
  mode,
  requestedPage: requestedPageValue,
  requestedPagesValue,
  zoomStepsValue,
  panTop,
  panMiddle,
  panBottom,
  panDeepBottom,
  captureTriplet
});
if (readRecognizedText && (mode !== 'viewer-inspect' || !requestedPage || requestedPages.length)) {
  throw new Error('Archion recognized-text inspection requires viewer-inspect mode and one exact Bild.');
}

// A viewer-only read may use a temporary target description kept outside the
// repository, so a volume can be read on screen before it has a canonical
// acquisition target. It still needs the exact authorized pass entitlement
// below, and it can never capture (download), purchase or be published.
const targetFile = valueAfter('--target-file');
if (targetFile) {
  if (mode !== 'viewer-inspect') {
    throw new Error('A temporary Archion target file allows viewer-inspect only: it is a read, never a capture or purchase.');
  }
  const relativeToProject = path.relative(projectRoot, path.resolve(targetFile));
  if (!path.isAbsolute(targetFile) || !(relativeToProject.startsWith('..') || path.isAbsolute(relativeToProject))) {
    throw new Error('A temporary Archion target file must be an absolute path outside the repository.');
  }
}
const target = readJson(targetFile || path.join(projectRoot, 'evidence', 'acquisition', 'targets', `${targetId}.json`));
if (targetFile && (target.id !== targetId || target.temporaryReadOnly !== true)) {
  throw new Error('The temporary Archion target file must carry the exact --target id and temporaryReadOnly: true.');
}
const route = target.routes?.find((candidate) => candidate.id === routeId);
if (!route) throw new Error(`Archion target ${targetId} has no exact route ${routeId}.`);
const directRequestPath = path.join(
  projectRoot,
  'evidence',
  'acquisition',
  'requests',
  `${route.requestId || targetId}.json`
);
const request = fs.existsSync(directRequestPath) ? readJson(directRequestPath) : null;
let authorizationRequest = request;
let authorizationTarget = target;
let authorizationRoute = route;
const isDirectArchionPurchase = target.provider === 'Archion'
  && route?.provider === 'Archion'
  && request?.provider === 'Archion'
  && request.kind === 'paid-order'
  && route.requestId === request.id
  && request.items?.some((item) => item.targetId === target.id && item.routeId === route.id)
  && route.route === 'paid-provider-subscription';
assertArchionAccessMode({
  mode,
  directPurchase: isDirectArchionPurchase,
  routeStatus: route.status
});
const cleanupOnly = mode === 'cleanup';
const postAuditViewerInspection = mode === 'viewer-inspect'
  && target.disposition === 'search-audit'
  && route.status === 'needs-alternate-route';
if (!isDirectArchionPurchase) {
  if (!reuseConfirmationTargetId) {
    throw new Error('The canonical target is not a direct Archion purchase; pass the exact authorized subscription target to reuse.');
  }
  if (route.accessEntitlement?.authorizationTargetId !== reuseConfirmationTargetId) {
    throw new Error('The alternate Archion route entitlement does not match the exact reuse confirmation target.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(route.accessEntitlement?.requestId || '')) {
    throw new Error('The alternate Archion route entitlement has no safe paid-order request ID.');
  }
  const authorizationTargetPath = path.join(projectRoot, 'evidence', 'acquisition', 'targets', `${reuseConfirmationTargetId}.json`);
  authorizationTarget = readJson(authorizationTargetPath);
  const authorizationRequestPath = path.join(
    projectRoot,
    'evidence',
    'acquisition',
    'requests',
    `${route.accessEntitlement?.requestId || 'missing'}.json`
  );
  authorizationRequest = readJson(authorizationRequestPath);
  const resolvedEntitlement = resolveRouteAccessEntitlement(route, {
    target,
    requests: new Map([[authorizationRequest.id, authorizationRequest]])
  });
  if (resolvedEntitlement.issues.length || !resolvedEntitlement.reused) {
    throw new Error(`The alternate Archion route has no valid reusable entitlement: ${resolvedEntitlement.issues.join('; ')}`);
  }
  authorizationRoute = authorizationTarget.routes?.find(
    (candidate) => candidate.id === resolvedEntitlement.authorizationItem?.routeId
  );
  if (authorizationTarget.id !== reuseConfirmationTargetId
      || route?.provider !== 'Archion'
      || route.sourceQueue !== 'archion-access' || route.route !== 'paid-provider-subscription'
      || (!cleanupOnly && !postAuditViewerInspection && !authorizedAccessRouteStatuses.has(route.status))
      || !authorizationRoute || authorizationRoute.targetId !== reuseConfirmationTargetId
      // A pass bought to serve several volumes is usable once its access-confirmed
      // event exists (checked by resolveRouteAccessEntitlement), even before the
      // purchase target's own record is captured.
      || !['acquired', 'published', 'ready-subscription-capture'].includes(authorizationRoute.status)
      || (!cleanupOnly && Date.parse(route.accessEntitlement.expiresAt) <= Date.now())) {
    throw new Error('The requested Archion alternate route is not explicitly covered by a confirmed active subscription entitlement.');
  }
} else if (route.accessEntitlement) {
  const resolvedEntitlement = resolveRouteAccessEntitlement(route, {
    target,
    requests: new Map([[authorizationRequest.id, authorizationRequest]])
  });
  if (resolvedEntitlement.issues.length) {
    throw new Error(`The direct Archion route has an invalid access entitlement: ${resolvedEntitlement.issues.join('; ')}`);
  }
}
if (!authorizationRequest || authorizationRequest.kind !== 'paid-order'
    || confirmation !== authorizationRequest.guard?.requiredPhrase) {
  throw new Error(`Archion access requires the exact confirmation phrase: ${authorizationRequest?.guard?.requiredPhrase || '(missing)'}`);
}
if (authorizationRequest.guard?.costMode !== 'maximum'
    || authorizationRequest.guard?.currency !== 'EUR'
    || authorizationRequest.guard?.maxAmount !== 19.9) {
  throw new Error('The canonical Archion EUR cost guard is missing or changed.');
}
if (isDirectArchionPurchase && confirmation !== route.confirmationPhrase) {
  throw new Error(`Archion purchase requires the exact confirmation phrase: ${route.confirmationPhrase}`);
}
if (!/^https:\/\/www\.archion\.de\//.test(route?.sourceUrl || '')) {
  throw new Error('The canonical Archion source route is missing.');
}

const session = await openSharedChromeTask({
  chromium,
  endpoint,
  taskLabel: 'Archion access',
  affinitySlot,
  timeoutMs: 20_000
});

try {
  const page = session.page;
  page.setDefaultTimeout(15_000);
  if (mode === 'cleanup') {
    const objectId = new URL(route.sourceUrl).pathname.match(/\/(\d+)\/?$/)?.[1];
    if (!objectId) throw new Error('The canonical Archion route has no exact numeric object ID for cleanup.');
    const expectedOrigin = 'https://www.archion.de';
    const expectedPath = `/de/viewer/churchRegister/${objectId}`;
    const exactTaskPages = session.context.pages().filter((candidate) => {
      if (candidate === page || candidate.isClosed()) return false;
      try {
        const url = new URL(candidate.url());
        return url.origin === expectedOrigin && url.pathname === expectedPath;
      } catch {
        return false;
      }
    });
    for (const candidate of exactTaskPages) {
      await candidate.close({ runBeforeUnload: false });
    }
    console.log(JSON.stringify({
      targetId,
      mode,
      state: 'exact-viewer-tabs-closed',
      objectId: Number(objectId),
      exactViewerPath: expectedPath,
      closedTabs: exactTaskPages.length
    }, null, 2));
  } else {
    await page.goto(route.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

  if (mode === 'purchase') {
    // Archion currently renders the same label in the header and archive body.
    // Use the stable top-level control so strict locator mode cannot stop on a
    // harmless duplicate before we reach the verified purchase route.
    const purchaseLink = page.locator('#buybtn');
    await purchaseLink.waitFor({ state: 'attached' });
    if (await purchaseLink.isVisible()) {
      await purchaseLink.click();
    } else {
      // A narrow background tab collapses the header menu; follow the same
      // control's link, verified to be the exact Archion purchase page.
      const purchaseUrl = archionPurchaseNavigationUrl(await purchaseLink.getAttribute('href'), page.url());
      await page.goto(purchaseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2_000);
    let summary = await summarizePage(page, 'purchase-route');
    console.log(JSON.stringify({ targetId, mode, state: 'purchase-route-inspected', ...summary }, null, 2));
    const pageText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const terms = {
      oneMonth: /1-Monats-Pass/i.test(pageText),
      exactPrice: /19,90\s*€/.test(pageText),
      thirtyDays: /30\s+Tage/i.test(pageText),
      fiftyDownloads: /50\s+Downloads/i.test(pageText),
      tenRecognitions: /10\s+(?:On-Demand-)?Texterkennungen/i.test(pageText),
      noAutoRenewal: /verlängert\s+sich\s+nicht\s+von\s+selbst/i.test(pageText)
    };
    if (Object.values(terms).some((value) => !value)) {
      throw new Error(`The visible Archion one-month product does not match the canonical guard: ${JSON.stringify(terms)}`);
    }
    const oneMonth = page.getByRole('link', { name: /Jetzt\s+1-Monats-Pass\s+buchen/i }).first();
    if (await oneMonth.count() !== 1) throw new Error('Archion exposed no unique exact one-month purchase control.');
    await oneMonth.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2_000);
    summary = await summarizePage(page, 'one-month-selected');
    console.log(JSON.stringify({ targetId, mode, state: await hasCredentialFields(page) ? 'manual-signin-required' : 'one-month-selected', terms, ...summary }, null, 2));
    if (await hasCredentialFields(page)) {
      if (createAccount) {
        const registration = page.getByRole('link', { name: 'Neues Konto erstellen', exact: true });
        await registration.waitFor({ state: 'visible' });
        await registration.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1_000);
      }
      await session.showForManualStep(createAccount ? 'manual Archion account creation' : 'manual Archion sign-in');
      console.log(`Archion ${createAccount ? 'account creation' : 'sign-in'} is manual. Waiting up to five minutes without reading credential or contact fields.`);
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        if (!await needsManualAccountStep(page, createAccount)) break;
      }
      if (await needsManualAccountStep(page, createAccount)) {
        throw new Error(`Archion ${createAccount ? 'account creation' : 'sign-in'} was not completed within five minutes; no purchase action was taken.`);
      }
      await page.waitForTimeout(2_000);
      summary = await summarizePage(page, 'post-signin');
      console.log(JSON.stringify({ targetId, mode, state: 'signed-in-route-inspected', ...summary }, null, 2));
    }
    // Payment is always the user's step. Reveal the parked checkout tab even
    // when no sign-in was needed, so the person can find it and pay.
    if (/^\/de\/zugang-kaufen\/checkout\b/.test(new URL(page.url()).pathname)) {
      await session.showForManualStep('manual Archion checkout and payment');
      console.log('Archion checkout is ready for the user to pay; no payment field was read or filled.');
    }
  } else if (mode === 'viewer-inspect' || mode === 'capture') {
    const viewer = page.getByRole('link', { name: /Digitalisat anzeigen \(Viewer\)/i }).first();
    if (await viewer.count() !== 1) throw new Error('Archion exposed no unique digitized-viewer control.');
    await viewer.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(4_000);
    const viewerPageIndex = await readViewerPageIndex(page);
    if (requestedPage) {
      await selectViewerPage(page, requestedPage);
      await applyViewerZoom(page, zoomSteps);
      if (panTop) await panViewerToTop(page);
      if (panBottom) await panViewerToBottom(page);
    }
    const recognizedTextInspection = readRecognizedText
      ? await inspectExistingRecognizedText(page)
      : null;
    const viewerImageInspections = [];
    for (const [pageIndex, pageLabel] of requestedPages.entries()) {
      const selectedLabel = await selectViewerPage(page, pageLabel);
      if (pageIndex === 0) await applyViewerZoom(page, zoomSteps);
      if (captureTriplet) {
        viewerImageInspections.push(...(await captureViewerImageInspectionTriplet(page, pageLabel))
          .map((inspection) => ({ selectedLabel, ...inspection })));
        continue;
      }
      if (panMiddle) {
        viewerImageInspections.push({
          selectedLabel,
          ...await captureViewerImageInspectionMiddle(page, pageLabel)
        });
        continue;
      }
      if (panDeepBottom) {
        viewerImageInspections.push({
          selectedLabel,
          ...await captureViewerImageInspectionDeepBottom(page, pageLabel)
        });
        continue;
      }
      if (panTop) await panViewerToTop(page);
      if (panBottom) await panViewerToBottom(page);
      viewerImageInspections.push({
        selectedLabel,
        ...await captureViewerImageInspection(page, pageLabel, panBottom ? 'bottom' : panTop ? 'top' : 'default')
      });
    }
    let captureCompleted = false;
    if (mode === 'capture') {
      if (!requestedPage) throw new Error('Archion capture requires one explicit viewer page index.');
      const pageImage = page.locator('.zoom-thumb:visible').first();
      await pageImage.waitFor({ state: 'visible' });
      const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
      const downloadControl = page.locator('span.download:visible');
      if (await downloadControl.count() !== 1) throw new Error('Archion viewer exposed no unique download control.');
      await downloadControl.click();
      let download = await downloadPromise;
      if (!download) {
        await page.waitForTimeout(2_000);
        const modalDownload = page.getByText('Herunterladen', { exact: true }).last();
        if (await modalDownload.count() > 0 && await modalDownload.isVisible().catch(() => false)) {
          const modalDownloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
          await modalDownload.click();
          download = await modalDownloadPromise;
        }
      }
      if (!download) {
        await page.waitForTimeout(2_000);
        const state = await page.locator('body').innerText().then((value) => value.replace(/\s+/g, ' ').trim().slice(0, 3000));
        const visibleDialogs = await page.locator('[role="dialog"], .modal:visible, .swal2-popup:visible').evaluateAll((elements) => elements
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
            text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 800)
          })));
        const visibleControls = await page.locator('button:visible, a:visible, [role="button"]:visible, label:visible, input[type="radio"]:visible, input[type="checkbox"]:visible')
          .evaluateAll((elements) => elements
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
              text: (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            }))
            .filter((item) => /download|herunter|pdf|bild|seite|ausschnitt|limit|kontingent/i.test(`${item.text} ${item.className}`))
            .slice(0, 40));
        console.log(JSON.stringify({
          targetId,
          mode,
          state: /Download-Kontingent[^.]*erreicht/i.test(state) ? 'download-quota-reached' : 'download-control-no-event',
          visibleControls,
          page: Number(requestedPage),
          url: new URL(page.url()).origin + new URL(page.url()).pathname,
          visibleDialogs,
          bodyText: state
        }, null, 2));
        captureCompleted = true;
      }
      if (captureCompleted) {
        // The provider control may open a browser-managed transfer instead of a
        // Playwright download event. Leave the verified viewer tab open for the
        // next bounded inspection; no source master is claimed here.
      } else {
        const downloadsDir = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : '';
        if (!downloadsDir || !fs.existsSync(downloadsDir)) throw new Error('Windows Downloads directory is unavailable.');
        const suggested = sanitizeFilename(download.suggestedFilename() || `archion-${targetId}-page-${requestedPage}.bin`);
        const outputPath = path.join(downloadsDir, `${targetId}-page-${requestedPage}-${suggested}`);
        await download.saveAs(outputPath);
        const stat = fs.statSync(outputPath);
        console.log(JSON.stringify({
          targetId,
          mode,
          state: 'captured-download',
          page: Number(requestedPage),
          downloadedFile: outputPath,
          suggestedFilename: suggested,
          bytes: stat.size
        }, null, 2));
        captureCompleted = true;
      }
    }
    if (!captureCompleted) {
      if (requestedPages.length > 0) {
        console.log(JSON.stringify({
          targetId,
          mode,
          state: 'viewer-pages-inspected',
          viewerPageIndex,
          viewerImageInspections
        }, null, 2));
      } else {
        const summary = await summarizePage(page, 'viewer-inspect');
        const viewerImageInspection = requestedPage && !captureTriplet
          ? await captureViewerImageInspection(page, requestedPage, panBottom ? 'bottom' : panTop ? 'top' : 'default')
          : null;
        const viewerImageInspectionTriplet = requestedPage && captureTriplet
          ? await captureViewerImageInspectionTriplet(page, requestedPage)
          : [];
        const viewerControls = await page.locator('a,button,input,select,[role="button"],svg').evaluateAll((elements) => elements
          .filter((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
          })
          .slice(0, 240)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
            role: element.getAttribute('role') || '',
            title: element.getAttribute('title') || '',
            ariaLabel: element.getAttribute('aria-label') || '',
            href: element.getAttribute('href') || '',
            parentTag: element.parentElement?.tagName?.toLowerCase() || '',
            parentClass: typeof element.parentElement?.className === 'string' ? element.parentElement.className.slice(0, 180) : '',
            parentTitle: element.parentElement?.getAttribute('title') || '',
            parentAriaLabel: element.parentElement?.getAttribute('aria-label') || '',
            value: element.tagName === 'INPUT' || element.tagName === 'SELECT' ? element.value : '',
            text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
          })));
        const viewerGeometry = await page.evaluate(() => ({
          viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
          elements: [...document.querySelectorAll('#documentViewer *')].map((element) => {
            const box = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              id: element.id || '',
              className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
              title: element.getAttribute('title') || '',
              ariaLabel: element.getAttribute('aria-label') || '',
              href: element.getAttribute('href') || '',
              x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
              text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
            };
          }).filter((item) => item.width > 0 && item.height > 0 && item.y < 360).slice(0, 260)
        }));
        console.log(JSON.stringify({
          targetId,
          mode,
          state: 'viewer-opened',
          viewerPageIndex,
          viewerImageInspection,
          viewerImageInspectionTriplet,
          viewerImageInspections,
          recognizedTextInspection,
          viewerGeometry,
          viewerControls,
          ...summary
        }, null, 2));
      }
    }
  } else {
    const summary = await summarizePage(page, 'inspect');
    console.log(JSON.stringify({ targetId, mode: 'inspect', ...summary }, null, 2));
  }
  }
} finally {
  // Park the tab only for a revealed human step (sign-in, checkout); every
  // routine read closes its tab so repeated captures do not accumulate tabs.
  if (session.manualStepRevealed) await session.leaveOpen();
  else await session.close();
}

async function inspectExistingRecognizedText(page) {
  const recognizedText = page.locator('span.ocrtext:visible');
  if (await recognizedText.count() !== 1) {
    throw new Error('Archion exposed no unique existing recognized-text control.');
  }
  await recognizedText.click();
  await page.waitForTimeout(750);
  const panels = await page.locator('[role="dialog"]:visible, .modal:visible, .offcanvas:visible, .swal2-popup:visible, .toolbarRight:visible')
    .evaluateAll((elements) => elements.map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
      text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12000)
    })));
  const requestRecognitionControlPresent = await page.getByRole('button', { name: /Texterkennung beauftragen/i }).count() > 0
    || await page.getByRole('link', { name: /Texterkennung beauftragen/i }).count() > 0;
  return {
    state: requestRecognitionControlPresent
      || panels.some((panel) => /Bisher keine Texterkennung/i.test(panel.text))
      ? 'no-existing-recognized-text'
      : panels.length ? 'recognized-text-panel-opened' : 'no-recognized-text-panel',
    requestRecognitionControlPresent,
    panels
  };
}

async function summarizePage(page, phase) {
  const controls = await page.locator('a,button').evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    })
    .slice(0, 180)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      label: (element.getAttribute('aria-label') || element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 180),
      path: element.tagName === 'A'
        ? new URL(element.href, window.location.href).pathname.slice(0, 500)
        : ''
    }))
    .filter((item) => item.label));
  const headings = await page.locator('h1,h2,h3').allTextContents();
  const sensitiveFields = await hasSensitiveFields(page);
  const sensitiveRoute = /\/(?:login|account|checkout|payment|billing)(?:\/|$)/i.test(new URL(page.url()).pathname);
  let screenshotPath = null;
  let screenshotStatus = sensitiveFields || sensitiveRoute ? 'skipped-sensitive-state' : 'not-attempted';
  if (!sensitiveFields && !sensitiveRoute) {
    screenshotPath = path.join(os.tmpdir(), `family-history-archion-${phase}-${process.pid}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled', timeout: 5_000 });
      screenshotStatus = 'captured';
    } catch {
      const cdp = await page.context().newCDPSession(page);
      try {
        const capture = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        });
        fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
        screenshotStatus = 'captured-cdp-fallback';
      } catch {
        screenshotPath = null;
        screenshotStatus = 'capture-timeout';
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
  }
  return {
    title: (await page.title()).slice(0, 200),
    url: new URL(page.url()).origin + new URL(page.url()).pathname,
    headings: headings.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20),
    controls,
    hasSensitiveFields: sensitiveFields,
    screenshotPath,
    screenshotStatus
  };
}

async function captureViewerImageInspection(page, requestedPage, inspectionPan = 'default') {
  const image = page.locator('.zoom-thumb:visible').first();
  await image.waitFor({ state: 'visible' });
  const box = await image.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error('Archion viewer exposed no inspectable image bounds.');
  }
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const floatingToolbar = await page.locator('.dvtoolbar:has(a.zoom-out):visible').elementHandle();
  let toolbarState = null;
  let overlaySuppression = 'not-needed';
  if (floatingToolbar) {
    toolbarState = await floatingToolbar.evaluate((element, imageBounds) => {
      const bounds = element.getBoundingClientRect();
      const overlapsImage = bounds.right > imageBounds.x
        && bounds.left < imageBounds.x + imageBounds.width
        && bounds.bottom > imageBounds.y
        && bounds.top < imageBounds.y + imageBounds.height;
      if (!overlapsImage) return null;
      const previous = {
        value: element.style.getPropertyValue('visibility'),
        priority: element.style.getPropertyPriority('visibility')
      };
      element.style.setProperty('visibility', 'hidden', 'important');
      return {
        previous,
        geometry: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height)
        }
      };
    }, box);
    if (toolbarState) {
      overlaySuppression = 'overlapping-viewer-toolbar-hidden-and-restored';
      await page.waitForTimeout(50);
    }
  }
  const scale = Math.max(1, Math.min(4, Math.floor(7_000 / Math.max(box.width, box.height))));
  const screenshotPath = path.join(
    os.tmpdir(),
    `family-history-archion-viewer-bild-${requestedPage}-${inspectionPan}-${process.pid}.png`
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: box.x + scroll.x,
        y: box.y + scroll.y,
        width: box.width,
        height: box.height,
        scale
      }
    });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
  } finally {
    try {
      if (floatingToolbar && toolbarState) {
        await floatingToolbar.evaluate((element, previous) => {
          if (previous.value) {
            element.style.setProperty('visibility', previous.value, previous.priority);
          } else {
            element.style.removeProperty('visibility');
          }
        }, toolbarState.previous);
      }
    } finally {
      await floatingToolbar?.dispose();
      await cdp.detach().catch(() => {});
    }
  }
  return {
    requestedPage: Number(requestedPage),
    inspectionPan,
    screenshotPath,
    screenshotStatus: 'captured-scaled-viewer-inspection',
    cssWidth: Math.round(box.width),
    cssHeight: Math.round(box.height),
    scale,
    overlaySuppression,
    suppressedOverlayGeometry: toolbarState?.geometry || null
  };
}

async function captureViewerImageInspectionTriplet(page, requestedPage) {
  const inspections = [await captureViewerImageInspection(page, requestedPage, 'default')];
  await panViewerToTop(page);
  inspections.push(await captureViewerImageInspection(page, requestedPage, 'top'));
  await panViewerToBottom(page);
  await panViewerToBottom(page);
  inspections.push(await captureViewerImageInspection(page, requestedPage, 'bottom'));
  // Archion preserves the drag offset when the selected Bild changes. Return
  // to center so the next batch item starts from the same certified geometry.
  await panViewerToTop(page);
  return inspections;
}

async function captureViewerImageInspectionMiddle(page, requestedPage) {
  // Policy restricts this to a one-item --pages batch. The task tab closes
  // after capture, so no drag offset can carry into another Bild.
  await panViewerToTop(page, 120);
  return await captureViewerImageInspection(page, requestedPage, 'middle');
}

async function captureViewerImageInspectionDeepBottom(page, requestedPage) {
  // Policy restricts this to a one-item --pages batch. The task tab closes
  // after capture, so the deliberately deeper drag cannot carry to a new Bild.
  await panViewerToBottom(page);
  await panViewerToBottom(page);
  return await captureViewerImageInspection(page, requestedPage, 'deep-bottom');
}

async function readViewerPageIndex(page) {
  const pageSelect = page.locator('select.page-select:visible');
  await pageSelect.waitFor({ state: 'visible' });
  const labels = (await pageSelect.locator('option').allTextContents())
    .map((value) => value.trim())
    .filter(Boolean);
  if (!labels.length) throw new Error('Archion viewer exposed no Bild labels.');
  return {
    count: labels.length,
    firstLabel: labels[0],
    lastLabel: labels.at(-1),
    selectedLabel: (await pageSelect.locator('option:checked').textContent())?.trim() || ''
  };
}

async function selectViewerPage(page, requestedPage) {
  const pageSelect = page.locator('select.page-select:visible');
  const image = page.locator('.zoom-thumb:visible').first();
  await image.waitFor({ state: 'visible' });
  const cdp = await page.context().newCDPSession(page);
  let previousRender;
  let lastRender;
  try {
    const previousLabel = (await pageSelect.locator('option:checked').textContent())?.trim() || '';
    previousRender = await readViewerRenderState(page, cdp);
    lastRender = previousRender;
    await pageSelect.selectOption({ label: String(requestedPage) });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await page.waitForTimeout(250);
      const selectedLabel = (await pageSelect.locator('option:checked').textContent())?.trim() || '';
      if (selectedLabel !== String(requestedPage)) continue;
      if (previousLabel === selectedLabel) return selectedLabel;
      const currentRender = await readViewerRenderState(page, cdp);
      lastRender = currentRender;
      if (currentRender.pixelFingerprint === previousRender.pixelFingerprint) continue;
      await page.waitForTimeout(1_000);
      const settledRender = await readViewerRenderState(page, cdp);
      lastRender = settledRender;
      if (settledRender.pixelFingerprint === currentRender.pixelFingerprint) return selectedLabel;
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  throw new Error(`Archion did not render exact Bild label ${requestedPage} before inspection: ${JSON.stringify({
    previous: previousRender.diagnostic,
    last: lastRender.diagnostic,
    domSignatureChanged: lastRender.domSignature !== previousRender.domSignature,
    pixelFingerprintChanged: lastRender.pixelFingerprint !== previousRender.pixelFingerprint
  })}`);
}

async function readViewerRenderState(page, cdp) {
  const state = await page.evaluate(() => {
    const image = [...document.querySelectorAll('.zoom-thumb')].find((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    });
    const imageState = image ? {
      outerHtml: image.outerHTML,
      backgroundImage: getComputedStyle(image).backgroundImage,
      childImages: [...image.querySelectorAll('img')].map((child) => ({
        currentSrc: child.currentSrc,
        complete: child.complete,
        naturalWidth: child.naturalWidth,
        naturalHeight: child.naturalHeight
      }))
    } : null;
    const childImages = imageState?.childImages || [];
    return {
      domSignature: JSON.stringify({ imageState }),
      diagnostic: {
        imagePresent: Boolean(imageState),
        outerHtmlLength: imageState?.outerHtml?.length || 0,
        backgroundImagePresent: Boolean(imageState?.backgroundImage && imageState.backgroundImage !== 'none'),
        childImageCount: childImages.length,
        completeChildImageCount: childImages.filter((child) => child.complete).length,
        naturalChildImageCount: childImages.filter((child) => child.naturalWidth > 0 && child.naturalHeight > 0).length
      }
    };
  });
  const image = page.locator('.zoom-thumb:visible').first();
  const box = await image.boundingBox();
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error('Archion viewer exposed no image bounds for render verification.');
  }
  const capture = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 35,
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: box.x + scroll.x,
      y: box.y + scroll.y,
      width: box.width,
      height: box.height,
      scale: 0.25
    }
  });
  return {
    ...state,
    pixelFingerprint: createHash('sha256').update(Buffer.from(capture.data, 'base64')).digest('hex')
  };
}

async function applyViewerZoom(page, zoomSteps) {
  if (!zoomSteps) return;
  const zoomIn = page.locator('a.zoom-in:visible');
  if (await zoomIn.count() !== 1) {
    throw new Error('Archion viewer exposed no unique zoom-in control.');
  }
  for (let step = 0; step < zoomSteps; step += 1) {
    const image = page.locator('.zoom-thumb:visible').first();
    const previousBox = await image.boundingBox();
    if (!previousBox) throw new Error('Archion viewer exposed no image bounds before zoom.');
    await zoomIn.click();
    let zoomRendered = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await page.waitForTimeout(100);
      const currentBox = await image.boundingBox();
      if (currentBox && currentBox.width > previousBox.width * 1.5) {
        zoomRendered = true;
        break;
      }
    }
    if (!zoomRendered) throw new Error('Archion viewer did not render the requested zoom step.');
  }
}

async function panViewerToTop(page, distance = 240) {
  const image = page.locator('.zoom-thumb:visible').first();
  const beforeBox = await image.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!beforeBox || !viewport) throw new Error('Archion viewer exposed no pannable image bounds.');
  const visibleLeft = Math.max(0, beforeBox.x);
  const visibleRight = Math.min(viewport.width, beforeBox.x + beforeBox.width);
  const visibleTop = Math.max(0, beforeBox.y);
  const visibleBottom = Math.min(viewport.height, beforeBox.y + beforeBox.height);
  const startX = (visibleLeft + visibleRight) / 2;
  const startY = Math.max(visibleTop + 30, visibleBottom - (distance + 40));
  const endY = Math.min(viewport.height - 20, startY + distance);
  if (visibleRight - visibleLeft < 80 || endY - startY < 80) {
    throw new Error('Archion viewer has insufficient visible image area for bounded top pan.');
  }
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, endY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(750);
  const afterBox = await image.boundingBox();
  if (!afterBox || afterBox.y <= beforeBox.y + 40) {
    throw new Error('Archion viewer did not render the requested bounded top pan.');
  }
}

async function panViewerToBottom(page, distance = 240) {
  const image = page.locator('.zoom-thumb:visible').first();
  const beforeBox = await image.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!beforeBox || !viewport) throw new Error('Archion viewer exposed no pannable image bounds.');
  const visibleLeft = Math.max(0, beforeBox.x);
  const visibleRight = Math.min(viewport.width, beforeBox.x + beforeBox.width);
  const visibleTop = Math.max(0, beforeBox.y);
  const visibleBottom = Math.min(viewport.height, beforeBox.y + beforeBox.height);
  const startX = (visibleLeft + visibleRight) / 2;
  const startY = Math.min(visibleBottom - 30, visibleTop + distance + 40);
  const endY = Math.max(20, startY - distance);
  if (visibleRight - visibleLeft < 80 || startY - endY < 80) {
    throw new Error('Archion viewer has insufficient visible image area for bounded bottom pan.');
  }
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, endY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(750);
  const afterBox = await image.boundingBox();
  if (!afterBox || afterBox.y >= beforeBox.y - 40) {
    throw new Error('Archion viewer did not render the requested bounded bottom pan.');
  }
}

async function hasSensitiveFields(page) {
  return await page.locator([
    'input[type="password"]:visible',
    'input[type="email"]:visible',
    'input[type="tel"]:visible',
    'input[autocomplete^="cc-"]:visible',
    'input[autocomplete="name"]:visible',
    'input[autocomplete^="address-"]:visible'
  ].join(',')).count() > 0;
}

async function hasCredentialFields(page) {
  return await page.locator('input[type="password"]:visible').count() > 0;
}

async function needsManualAccountStep(page, creatingAccount) {
  const pathname = new URL(page.url()).pathname;
  if (creatingAccount && /\/registrieren(?:\/|$)/i.test(pathname)) return true;
  return await hasCredentialFields(page);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sanitizeFilename(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 180) || 'archion-download.bin';
}
