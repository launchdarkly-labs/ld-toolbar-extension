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
 */

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
