/**
 * ISOLATED-world content script.
 *
 * Bridges between the MAIN-world hook (injected.ts, which sets
 * window.__LD_DEVTOOLS_HOOK__) and the extension's background service
 * worker.
 *
 * The MAIN-world script and this one share the same `window` object but
 * live in different JS realms — they can only exchange data via
 * `window.postMessage`. Chrome extension APIs (chrome.runtime, etc.) are
 * only available to ISOLATED-world scripts, hence this shim.
 *
 *   page JS  ←→  MAIN world (hook)
 *                    │  window.postMessage
 *                    ▼
 *               ISOLATED world (this file)
 *                    │  chrome.runtime
 *                    ▼
 *               background service worker
 *
 * Also responsible for catching incoming share URLs: when the page loads
 * with `?ld-ext-state=<base64>` set, this script decodes the payload,
 * hands it to the background SW to merge into persisted state, and
 * cleans the parameter out of the visible URL. The page itself never
 * parses this parameter.
 */

import { extractSharedState, SHARE_PARAM_NAME } from "./shared/shareState";

const PROTOCOL = "ld-devtools-ext";

type FromPage = "from-page";
type FromExt = "from-ext";

interface Envelope {
  source: typeof PROTOCOL;
  direction: FromPage | FromExt;
  type: string;
  [k: string]: unknown;
}

// Forward background SW → MAIN world.
chrome.runtime.onMessage.addListener((message: Envelope) => {
  if (!message || message.source !== PROTOCOL) return;
  window.postMessage(
    { ...message, direction: "from-ext" satisfies FromExt },
    window.location.origin,
  );
});

// Forward MAIN world → background SW.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as Envelope | null;
  if (!data || data.source !== PROTOCOL || data.direction !== "from-page") {
    return;
  }
  chrome.runtime.sendMessage(data).catch(() => {
    // Background SW may be asleep for fire-and-forget events. Acceptable.
  });
});

// Announce ourselves so the background SW can register this tab.
chrome.runtime
  .sendMessage({
    source: PROTOCOL,
    direction: "from-page" satisfies FromPage,
    type: "content-script-loaded",
  } satisfies Envelope)
  .catch(() => {
    /* sw asleep, will catch us on the next event */
  });

// Process incoming share URL (if any). Runs at document_start so the
// param is intercepted before the page's JS has any chance to read
// window.location.search.
(function applyIncomingSharedState() {
  const url = window.location.href;
  const { payload, cleanedUrl, error } = extractSharedState(url);

  if (error) {
    // eslint-disable-next-line no-console
    console.warn(`[LD Toolbar Extension] ignoring ?${SHARE_PARAM_NAME}: ${error}`);
    return;
  }
  if (!payload) return;

  chrome.runtime
    .sendMessage({
      source: PROTOCOL,
      direction: "from-page" satisfies FromPage,
      type: "apply-shared-state",
      overrides: payload.overrides,
    } satisfies Envelope)
    .catch(() => {
      /* sw asleep, will retry via the persistence pathway anyway */
    });

  // Strip the param from the visible URL so it doesn't leak into
  // bookmarks/screenshots/referrer headers and so a manual refresh
  // doesn't reapply.
  if (cleanedUrl && cleanedUrl !== url) {
    try {
      window.history.replaceState(window.history.state, "", cleanedUrl);
    } catch {
      // Some pages have strict CSP that blocks this; not fatal.
    }
  }
})();
