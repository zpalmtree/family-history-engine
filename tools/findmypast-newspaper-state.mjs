// Serialized into an exact, bridge-leased newspaper results page. This reads
// only allowlisted historical controls; URL parameters are not applied evidence.
export function inspectNewspaperSearchDom(expected) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (node) => {
    const style = getComputedStyle(node);
    return style.display !== "none" && !["hidden", "collapse"].includes(style.visibility) && Number(style.opacity) !== 0 &&
      [...node.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
  };
  if (document.querySelector('input[type="password"],input[autocomplete="username"],input[autocomplete^="cc-"]')) {
    throw new Error("Newspaper filter inspection stopped at a sensitive form.");
  }
  if ([...document.querySelectorAll('iframe[src*="captcha" i],iframe[src*="challenge" i],[role="alert"],[role="dialog"]')]
    .some((node) => visible(node) && (node.tagName === "IFRAME" || /captcha|challenge|verify (?:you|your)|verification/i.test(node.textContent || "")))) {
    throw new Error("Newspaper filter inspection stopped at a challenge.");
  }
  const mains = [...document.querySelectorAll('main,[role="main"]')];
  const main = mains.length === 1 ? mains[0] : null;
  if (!main) return { state: "unverified", reason: "unique-main-unavailable", controls: [], appliedFiltersVerified: false };
  const excluded = (node) => node.closest('nav,header,footer,[id*="account" i],[class*="account" i],[id*="profile" i],[class*="profile" i],[id*="signin" i],[class*="signin" i]');
  const definitions = [
    ["keywords", /^(?:Keywords?|Search keywords?)$/i, ["text", "search"]],
    ["exactKeywords", /^(?:Exact keywords?|Exact phrase|Exact search)$/i, ["checkbox"]],
    ["startdate", /^(?:Start date|Date from|From)$/i, ["text", "date"]],
    ["enddate", /^(?:End date|Date to|To)$/i, ["text", "date"]],
  ];
  const controls = definitions.map(([field, labelPattern, types]) => {
    const matches = [...main.querySelectorAll('input')].filter((node) => node.id === field || node.name === field);
    if (matches.length !== 1) return { field, state: matches.length ? "ambiguous" : "missing" };
    const node = matches[0];
    if (excluded(node) || !types.includes(node.type) || /password|username|email|cc-/i.test(node.autocomplete || "")) return { field, state: "unsafe-boundary" };
    const label = clean(node.getAttribute("aria-label") || [...(node.labels || [])].map((item) => item.textContent).join(" "));
    if (!labelPattern.test(label)) return { field, state: "unexpected-label" };
    if (!visible(node)) return { field, state: "hidden", label };
    if (field === "exactKeywords") return { field, state: "visible", matchesExpected: typeof expected[field] === "boolean" && node.checked === expected[field] };
    const value = clean(node.value);
    return { field, state: "visible", matchesExpected: typeof expected[field] === "string" && value === expected[field] };
  });
  const headings = [...main.querySelectorAll('h1,h2')].filter((node) => visible(node) && !excluded(node))
    .map((node) => clean(node.textContent)).filter((text) => /newspapers?/i.test(text));
  return {
    state: "observed", controls, newspaperHeadingPresent: headings.length > 0,
    // Editable control values alone do not establish that a search was applied.
    appliedFiltersVerified: false, interactionPerformed: false,
  };
}

export function assertNewspaperStateRoute(rawUrl) {
  const route = new URL(rawUrl);
  if (route.protocol !== "https:" || !/^(?:www\.)?findmypast\.(?:com|co\.uk)$/.test(route.hostname) || route.pathname !== "/search-newspapers/results" ||
      route.username || route.password || route.port || route.hash) {
    throw new Error("Newspaper state inspection requires the exact Findmypast newspaper results route.");
  }
}

export async function readNewspaperSearchState(page, expectedUrl) {
  const startingUrl = page.url();
  assertNewspaperStateRoute(startingUrl);
  assertNewspaperStateRoute(expectedUrl);
  const query = new URL(expectedUrl).searchParams;
  const expected = Object.fromEntries(["keywords", "startdate", "enddate"].map((field) => [field, query.getAll(field).length === 1 ? query.get(field) : null]));
  expected.exactKeywords = query.getAll("exactKeywords").length === 1 && ["true", "false"].includes(query.get("exactKeywords")) ? query.get("exactKeywords") === "true" : null;
  const state = await page.evaluate(inspectNewspaperSearchDom, expected);
  if (page.url() !== startingUrl) throw new Error("Newspaper route changed during filter inspection.");
  return state;
}
