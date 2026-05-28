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

// Helper API for manual testing from the SW DevTools console.
// Once the DevTools panel UI exists this gets replaced by port-based RPC.
const ldExt = {
  listTabs(): Array<[number, TabEntry]> {
    return Array.from(tabs.entries());
  },
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
  async setOverridesOnActiveTab(
    overrides: Record<string, unknown>,
  ): Promise<void> {
    const [tab] = await chrome.tabs.query({
      active: true,
      // SWs have no "current window" — lastFocusedWindow is the working
      // equivalent from a background context.
      lastFocusedWindow: true,
    });
    if (!tab?.id) {
      throw new Error("No active tab in current window");
    }
    await chrome.tabs.sendMessage(tab.id, {
      source: PROTOCOL,
      type: "set-overrides",
      overrides,
    });
  },
  async clearOverridesOnTab(tabId: number): Promise<void> {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "clear-overrides",
    });
  },
  async clearOverridesOnActiveTab(): Promise<void> {
    const [tab] = await chrome.tabs.query({
      active: true,
      // SWs have no "current window" — lastFocusedWindow is the working
      // equivalent from a background context.
      lastFocusedWindow: true,
    });
    if (!tab?.id) {
      throw new Error("No active tab in current window");
    }
    await chrome.tabs.sendMessage(tab.id, {
      source: PROTOCOL,
      type: "clear-overrides",
    });
  },
};

(globalThis as unknown as Record<string, unknown>).ldExt = ldExt;
