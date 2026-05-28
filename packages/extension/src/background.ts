/**
 * Service worker — MV3 background.
 *
 * Placeholder for now. Will own:
 *  - chrome.storage.local for override persistence (per-origin)
 *  - tab registry of which tabs have LD SDKs active
 *  - port-based RPC between DevTools panels and content scripts
 *
 * Currently just logs lifecycle events so we can confirm it loaded.
 */

chrome.runtime.onInstalled.addListener((details) => {
  // eslint-disable-next-line no-console
  console.info("[LD Toolbar Extension] installed", details);
});

chrome.runtime.onStartup.addListener(() => {
  // eslint-disable-next-line no-console
  console.info("[LD Toolbar Extension] startup");
});
