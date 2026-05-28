/**
 * Service worker — MV3 background.
 *
 * Responsibilities:
 *  - Tab registry: which tabs have a content script loaded + an LD SDK active
 *  - Receive messages from the ISOLATED-world content script
 *  - Maintain long-lived ports to DevTools panels, keyed by inspected tabId
 *  - Forward override commands from panels to content scripts in the
 *    matching tab
 *  - Persist override state per-origin to chrome.storage.local and
 *    re-apply on subsequent page loads
 *  - Push tab-status updates (including the current stored overrides) to
 *    subscribed panels on relevant changes
 *
 * The legacy `globalThis.ldExt` helpers stay around for SW-console testing.
 */

const PROTOCOL = "ld-devtools-ext";
const PORT_NAME_PREFIX = "panel:";
const STORAGE_KEY = "overrides";

interface TabEntry {
  url?: string;
  sdkInfo?: unknown;
  loadedAt: number;
}

type OverridesByOrigin = Record<string, Record<string, unknown>>;

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
    // Restore any persisted overrides for this origin and push status.
    void restoreStoredOverrides(tabId);
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

  port.onMessage.addListener((message) => {
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
      void handlePanelOverrideCommand(tabId, message);
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

async function handlePanelOverrideCommand(
  tabId: number,
  message: {
    type: "set-overrides" | "remove-override" | "clear-overrides";
    overrides?: Record<string, unknown>;
    flagKey?: string;
  },
): Promise<void> {
  const tab = tabs.get(tabId);
  const origin = originFromUrl(tab?.url);

  // Best-effort persistence. We update storage first so a quickly-closed
  // tab doesn't lose the override.
  if (origin) {
    try {
      if (message.type === "set-overrides" && message.overrides) {
        await mergeOverridesForOrigin(origin, message.overrides);
      } else if (message.type === "remove-override" && message.flagKey) {
        await removeOverrideForOrigin(origin, message.flagKey);
      } else if (message.type === "clear-overrides") {
        await clearOverridesForOrigin(origin);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[LD Toolbar Extension] persistence failed for tab ${tabId}:`,
        err,
      );
    }
  }

  // Forward to the page-side bridge plugin.
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      ...message,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to forward ${message.type} to tab ${tabId}:`,
      err,
    );
  }

  // Echo the new status back to the panel so its UI reflects storage.
  pushTabStatus(tabId);
}

async function restoreStoredOverrides(tabId: number): Promise<void> {
  const tab = tabs.get(tabId);
  const origin = originFromUrl(tab?.url);
  if (!origin) return;

  const stored = await getOverridesForOrigin(origin);
  if (!stored || Object.keys(stored).length === 0) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "set-overrides",
      overrides: stored,
    });
    // eslint-disable-next-line no-console
    console.info(
      `[LD Toolbar Extension] restored ${Object.keys(stored).length} override(s) on tab ${tabId} for ${origin}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to restore overrides on tab ${tabId}:`,
      err,
    );
  }
}

async function pushTabStatus(tabId: number): Promise<void> {
  const port = panelPorts.get(tabId);
  if (!port) return;
  const entry = tabs.get(tabId);
  const origin = originFromUrl(entry?.url);
  const overrides = origin ? await getOverridesForOrigin(origin) : {};
  try {
    port.postMessage({
      source: PROTOCOL,
      type: "tab-status",
      tabId,
      url: entry?.url,
      origin,
      sdkInfo: entry?.sdkInfo,
      overrides,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to push status to panel for tab ${tabId}:`,
      err,
    );
  }
}

// ─── Storage helpers ──────────────────────────────────────────────────
function originFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.origin;
    }
    return null;
  } catch {
    return null;
  }
}

async function getAllStoredOverrides(): Promise<OverridesByOrigin> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as OverridesByOrigin | undefined) ?? {};
}

async function getOverridesForOrigin(
  origin: string,
): Promise<Record<string, unknown>> {
  const all = await getAllStoredOverrides();
  return all[origin] ?? {};
}

async function mergeOverridesForOrigin(
  origin: string,
  additions: Record<string, unknown>,
): Promise<void> {
  const all = await getAllStoredOverrides();
  all[origin] = { ...(all[origin] ?? {}), ...additions };
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

async function removeOverrideForOrigin(
  origin: string,
  flagKey: string,
): Promise<void> {
  const all = await getAllStoredOverrides();
  if (!all[origin]) return;
  delete all[origin][flagKey];
  if (Object.keys(all[origin]).length === 0) {
    delete all[origin];
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

async function clearOverridesForOrigin(origin: string): Promise<void> {
  const all = await getAllStoredOverrides();
  if (!all[origin]) return;
  delete all[origin];
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

// ─── SW console helpers (still useful while UI is in flight) ──────────
const ldExt = {
  listTabs: () => Array.from(tabs.entries()),
  listSdkTabs: () =>
    Array.from(tabs.entries()).filter(([, entry]) => entry.sdkInfo),
  getStored: () => getAllStoredOverrides(),
  async setOverridesOnTab(
    tabId: number,
    overrides: Record<string, unknown>,
  ): Promise<void> {
    await handlePanelOverrideCommand(tabId, {
      type: "set-overrides",
      overrides,
    });
  },
  async setOverrides(overrides: Record<string, unknown>): Promise<number> {
    const sdkTabs = this.listSdkTabs();
    await Promise.all(
      sdkTabs.map(([tabId]) =>
        handlePanelOverrideCommand(tabId, {
          type: "set-overrides",
          overrides,
        }),
      ),
    );
    return sdkTabs.length;
  },
  async clearOverridesOnTab(tabId: number): Promise<void> {
    await handlePanelOverrideCommand(tabId, { type: "clear-overrides" });
  },
  async clearOverrides(): Promise<number> {
    const sdkTabs = this.listSdkTabs();
    await Promise.all(
      sdkTabs.map(([tabId]) =>
        handlePanelOverrideCommand(tabId, { type: "clear-overrides" }),
      ),
    );
    return sdkTabs.length;
  },
};

(globalThis as unknown as Record<string, unknown>).ldExt = ldExt;
