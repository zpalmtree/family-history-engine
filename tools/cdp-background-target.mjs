// Opens one background task target in the shared Chrome profile.
//
// The task normally joins an existing window (newWindow: false) so that it
// never steals focus. When every Chrome window has been closed while the
// process keeps running, Chrome refuses that request with "Failed to open new
// tab - no browser is open"; the only way to obtain a task target is then a
// new background window. The fallback is limited to that exact refusal.

export const NO_BROWSER_WINDOW = /no browser is open/i;

export async function createBackgroundTarget(browserSession, url) {
  try {
    return await browserSession.send("Target.createTarget", { url, newWindow: false, background: true });
  } catch (error) {
    if (!NO_BROWSER_WINDOW.test(String(error?.message || error))) throw error;
    return browserSession.send("Target.createTarget", { url, newWindow: true, background: true });
  }
}
