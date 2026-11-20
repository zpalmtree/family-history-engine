export function assertArchionAccessMode({
  mode,
  directPurchase,
  routeStatus
} = {}) {
  if (mode === "purchase" && !directPurchase) {
    throw new Error("An alternate Archion subscription route cannot enter purchase mode.");
  }
  if (mode === "capture" && routeStatus === "subscription-first") {
    throw new Error("An Archion subscription-first route must locate and canonically promote its exact Bild before capture.");
  }
}

export function parseArchionViewerPageSelection({
  mode,
  requestedPage = '',
  requestedPagesValue = '',
  zoomStepsValue = '',
  panTop = false,
  panMiddle = false,
  panBottom = false,
  panDeepBottom = false,
  captureTriplet = false
}) {
  if (requestedPage && requestedPagesValue) {
    throw new Error('Pass either one Archion viewer page or one bounded page batch, not both.');
  }
  if (requestedPage && !/^\d{1,3}$/.test(requestedPage)) {
    throw new Error('Archion viewer page must be a numeric Bild label.');
  }
  if (requestedPagesValue && !/^\d{1,3}(,\d{1,3}){0,19}$/.test(requestedPagesValue)) {
    throw new Error('Archion viewer page batches require one to twenty comma-delimited numeric Bild labels.');
  }
  if (requestedPagesValue && mode !== 'viewer-inspect') {
    throw new Error('Archion viewer page batches are inspection-only.');
  }
  const requestedPages = requestedPagesValue ? requestedPagesValue.split(',') : [];
  if (new Set(requestedPages).size !== requestedPages.length) {
    throw new Error('Archion viewer page batches cannot repeat Bild labels.');
  }
  if (zoomStepsValue && !/^[0-4]$/.test(zoomStepsValue)) {
    throw new Error('Archion viewer inspection zoom requires zero to four exact steps.');
  }
  if (zoomStepsValue && mode !== 'viewer-inspect') {
    throw new Error('Archion viewer zoom steps are inspection-only.');
  }
  if (zoomStepsValue && !requestedPage && requestedPages.length === 0) {
    throw new Error('Archion viewer zoom steps require an exact Bild label or bounded page batch.');
  }
  if ([panTop, panMiddle, panBottom, panDeepBottom, captureTriplet].filter(Boolean).length > 1) {
    throw new Error('Pass only one bounded Archion pan direction or capture triplet.');
  }
  if (panMiddle && (requestedPage || requestedPages.length !== 1)) {
    throw new Error('Archion middle-pan inspection requires one single-item Bild batch so the task tab can close without carrying pan state.');
  }
  if (panDeepBottom && (requestedPage || requestedPages.length !== 1)) {
    throw new Error('Archion deep-bottom inspection requires one single-item Bild batch so the task tab can close without carrying pan state.');
  }
  if ((panTop || panMiddle || panBottom || panDeepBottom || captureTriplet)
      && (mode !== 'viewer-inspect'
        || (!requestedPage && requestedPages.length === 0)
        || !zoomStepsValue
        || zoomStepsValue === '0')) {
    throw new Error('Archion bounded pan or capture triplet requires one exact Bild or bounded page batch and at least one inspection zoom step.');
  }
  return {
    requestedPage,
    requestedPages,
    zoomSteps: zoomStepsValue ? Number(zoomStepsValue) : 0
  };
}

// Archion's header "Zugang kaufen" control collapses into a hidden menu at
// narrow (background-tab) widths. When it cannot be clicked, the helper may
// follow its href, but only to the exact Archion access-purchase page.
export const archionPurchasePageUrl = "https://www.archion.de/de/zugang-kaufen";

export function archionPurchaseNavigationUrl(href, baseUrl) {
  let resolved;
  try {
    resolved = new URL(String(href || ""), String(baseUrl || ""));
  } catch {
    throw new Error("Archion purchase control has no resolvable link.");
  }
  resolved.hash = "";
  if (resolved.search || resolved.href !== archionPurchasePageUrl) {
    throw new Error(`Archion purchase control points outside the exact purchase page: ${resolved.origin}${resolved.pathname}`);
  }
  return resolved.href;
}
