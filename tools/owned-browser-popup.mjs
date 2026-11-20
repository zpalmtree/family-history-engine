export function assertOwnedPage(page, connection) {
  if (!connection.ownedPages().includes(page)) {
    throw new Error("Refusing to use a page outside the current browser task lease.");
  }
}

// Context-wide page events include tabs opened by other concurrent tasks.
// Only the leased origin's popup event may select a replacement page.
export function waitForOwnedPopup(origin, connection, options) {
  const pending = resolveOwnedPopup(origin, connection, options);
  // The caller arms this wait before awaiting its click. Observe rejection
  // immediately, including when that click fails and never awaits the popup.
  // Return the original promise so awaiting it still propagates every error.
  void pending.catch(() => {});
  return pending;
}

async function resolveOwnedPopup(origin, connection, { timeoutMs = 10_000 } = {}) {
  assertOwnedPage(origin, connection);
  let popup;
  try {
    popup = await origin.waitForEvent("popup", { timeout: timeoutMs });
  } catch (error) {
    if (error?.name === "TimeoutError") return null; // Same-tab navigation.
    throw error;
  }
  if (await popup.opener() !== origin) {
    throw new Error("Refusing a popup whose opener is not the leased origin page.");
  }
  assertOwnedPage(origin, connection);
  await connection.adoptPage(popup);
  assertOwnedPage(popup, connection);
  return popup;
}
