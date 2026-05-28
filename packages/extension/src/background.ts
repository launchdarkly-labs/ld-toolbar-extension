/**
 * Service worker — MV3 background.
 *
 * v0 responsibilities:
 *  - Track which tabs have an LD SDK active (tab registry)
 *  - Receive messages from the ISOLATED-world content script
 *  - Send override commands down to specific tabs on demand
 *  - Expose a small helper API on `globalThis.ldExt` so we can drive
 *    overrides manually from the SW DevTools console while we build the
 *    DevTools panel UI
 *
 * Persistence to chrome.storage.local + per-origin scoping comes in a
 * later slice.
 */

const PROTOCOL = "ld-devtools-ext";

interface TabEntry {
  url?: string;
  sdkInfo?: unknown;
  loadedAt: number;
}

const tabs: Map<number, TabEntry> = new Map();

// eslint-disable-next-line no-console
console.info("[LD Toolbar Extension] service worker booted");

chrome.runtime.onInstalled.addListener((details) => {
  // eslint-disable-next-line no-console
  console.info("[LD Toolbar Extension] installed", details);
});

chrome.runtime.onStartup.addListener(() => {
  // eslint-disable-next-line no-console
  console.info("[LD Toolbar Extension] startup");
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.source !== PROTOCOL) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === "content-script-loaded") {
    tabs.set(tabId, { url: sender.tab?.url, loadedAt: Date.now() });
    // eslint-disable-next-line no-console
    console.info(
      `[LD Toolbar Extension] content script loaded in tab ${tabId}`,
      sender.tab?.url,
    );
  } else if (message.type === "sdk-ready") {
    const entry: TabEntry = tabs.get(tabId) ?? { loadedAt: Date.now() };
    entry.sdkInfo = message.info;
    entry.url = sender.tab?.url ?? entry.url;
    tabs.set(tabId, entry);
    // eslint-disable-next-line no-console
    console.info(
      `[LD Toolbar Extension] SDK ready in tab ${tabId}`,
      message.info,
    );
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

// Helper API for manual testing from the SW DevTools console. Operates on
// the tab registry we maintain ourselves — using chrome.tabs.query from a
// SW is unreliable because the SW DevTools window itself becomes the
// "current"/"last focused" window. Once the DevTools panel UI exists this
// gets replaced by port-based RPC scoped to whichever tab the panel is
// inspecting.
const ldExt = {
  /** List all tabs we know about (have a loaded content script). */
  listTabs(): Array<[number, TabEntry]> {
    return Array.from(tabs.entries());
  },

  /** List only tabs where the LD SDK has registered. */
  listSdkTabs(): Array<[number, TabEntry]> {
    return Array.from(tabs.entries()).filter(([, entry]) => entry.sdkInfo);
  },

  /** Send overrides to a specific tab. Use this when you know the tab ID. */
  async setOverridesOnTab(
    tabId: number,
    overrides: Record<string, unknown>,
  ): Promise<void> {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "set-overrides",
      overrides,
    });
  },

  /**
   * Send overrides to every tab in the registry that has an active SDK.
   * Convenient when there's only one demo tab open during manual testing.
   */
  async setOverrides(overrides: Record<string, unknown>): Promise<number> {
    const sdkTabs = this.listSdkTabs();
    await Promise.all(
      sdkTabs.map(([tabId]) =>
        chrome.tabs
          .sendMessage(tabId, {
            source: PROTOCOL,
            type: "set-overrides",
            overrides,
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[LD Toolbar Extension] failed to send overrides to tab ${tabId}:`,
              err,
            );
          }),
      ),
    );
    return sdkTabs.length;
  },

  /** Clear overrides on a specific tab. */
  async clearOverridesOnTab(tabId: number): Promise<void> {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "clear-overrides",
    });
  },

  /** Clear overrides on every tab in the registry that has an active SDK. */
  async clearOverrides(): Promise<number> {
    const sdkTabs = this.listSdkTabs();
    await Promise.all(
      sdkTabs.map(([tabId]) =>
        chrome.tabs
          .sendMessage(tabId, {
            source: PROTOCOL,
            type: "clear-overrides",
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[LD Toolbar Extension] failed to clear overrides on tab ${tabId}:`,
              err,
            );
          }),
      ),
    );
    return sdkTabs.length;
  },
};

(globalThis as unknown as Record<string, unknown>).ldExt = ldExt;
