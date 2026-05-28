/**
 * Service worker — MV3 background.
 *
 * Responsibilities:
 *  - Tab registry: which tabs have a content script loaded + an LD SDK active
 *  - Receive messages from the ISOLATED-world content script
 *  - Maintain long-lived ports to DevTools panels, keyed by inspected tabId
 *  - Forward override commands from panels to content scripts in the
 *    matching tab
 *  - Push tab-status updates to subscribed panels on relevant changes
 *
 * Persistence to chrome.storage.local + per-origin scoping is still TODO.
 *
 * The legacy `globalThis.ldExt` helpers stay around for SW-console testing.
 */

const PROTOCOL = "ld-devtools-ext";
const PORT_NAME_PREFIX = "panel:";

interface TabEntry {
  url?: string;
  sdkInfo?: unknown;
  loadedAt: number;
}

const tabs: Map<number, TabEntry> = new Map();
/** DevTools panels currently open, keyed by the tabId they are inspecting. */
const panelPorts: Map<number, chrome.runtime.Port> = new Map();

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

// ─── content-script ←→ background ──────────────────────────────────────
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
    pushTabStatus(tabId);
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
    pushTabStatus(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  const port = panelPorts.get(tabId);
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    panelPorts.delete(tabId);
  }
});

// ─── DevTools panel ←→ background ──────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(PORT_NAME_PREFIX)) return;

  const tabId = parseInt(port.name.slice(PORT_NAME_PREFIX.length), 10);
  if (Number.isNaN(tabId)) {
    port.disconnect();
    return;
  }

  panelPorts.set(tabId, port);
  // eslint-disable-next-line no-console
  console.info(`[LD Toolbar Extension] panel connected for tab ${tabId}`);

  port.onMessage.addListener(async (message) => {
    if (!message || message.source !== PROTOCOL) return;

    if (message.type === "get-tab-status") {
      pushTabStatus(tabId);
      return;
    }

    if (
      message.type === "set-overrides" ||
      message.type === "remove-override" ||
      message.type === "clear-overrides"
    ) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LD Toolbar Extension] failed to forward ${message.type} to tab ${tabId}:`,
          err,
        );
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (panelPorts.get(tabId) === port) {
      panelPorts.delete(tabId);
    }
    // eslint-disable-next-line no-console
    console.info(`[LD Toolbar Extension] panel disconnected for tab ${tabId}`);
  });
});

function pushTabStatus(tabId: number): void {
  const port = panelPorts.get(tabId);
  if (!port) return;
  const entry = tabs.get(tabId);
  try {
    port.postMessage({
      source: PROTOCOL,
      type: "tab-status",
      tabId,
      url: entry?.url,
      sdkInfo: entry?.sdkInfo,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to push status to panel for tab ${tabId}:`,
      err,
    );
  }
}

// ─── SW console helpers (still useful while UI is in flight) ──────────
const ldExt = {
  listTabs: () => Array.from(tabs.entries()),
  listSdkTabs: () =>
    Array.from(tabs.entries()).filter(([, entry]) => entry.sdkInfo),
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
          .catch(() => undefined),
      ),
    );
    return sdkTabs.length;
  },
  async clearOverridesOnTab(tabId: number): Promise<void> {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "clear-overrides",
    });
  },
  async clearOverrides(): Promise<number> {
    const sdkTabs = this.listSdkTabs();
    await Promise.all(
      sdkTabs.map(([tabId]) =>
        chrome.tabs
          .sendMessage(tabId, {
            source: PROTOCOL,
            type: "clear-overrides",
          })
          .catch(() => undefined),
      ),
    );
    return sdkTabs.length;
  },
};

(globalThis as unknown as Record<string, unknown>).ldExt = ldExt;
