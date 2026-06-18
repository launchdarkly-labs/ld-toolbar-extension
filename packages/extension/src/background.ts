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
/**
 * chrome.storage.session key holding a snapshot of the in-memory `tabs`
 * registry. MV3 evicts the service worker aggressively (≈30s idle, and a
 * hard recycle even with an open port), which wipes `tabs`. Session storage
 * survives SW restarts within a browser session, so we rehydrate from it on
 * boot — otherwise the panel reports "no LD SDK has registered yet" until a
 * full page reload re-fires the handshake.
 */
const SESSION_TABS_KEY = "tabRegistry";

interface TabEntry {
  url?: string;
  sdkInfo?: unknown;
  loadedAt: number;
  /** Latest flag snapshot reported by the bridge plugin in this tab. */
  flags?: Array<{ key: string; value: unknown }>;
  flagsTimestamp?: number;
}

type OverridesByOrigin = Record<string, Record<string, unknown>>;

const tabs: Map<number, TabEntry> = new Map();
/** DevTools panels currently open, keyed by the tabId they are inspecting. */
const panelPorts: Map<number, chrome.runtime.Port> = new Map();

// eslint-disable-next-line no-console
console.info("[LD Toolbar Extension] service worker booted");

// ─── Service-worker-restart resilience ────────────────────────────────
/**
 * Rehydrate `tabs` from chrome.storage.session. Runs once per SW lifetime.
 * Idempotent and cheap, but several event paths may race to call it on a
 * cold start, so we memoize the in-flight promise.
 */
let rehydratePromise: Promise<void> | null = null;
function rehydrateTabs(): Promise<void> {
  if (rehydratePromise) return rehydratePromise;
  rehydratePromise = (async () => {
    try {
      const result = await chrome.storage.session.get(SESSION_TABS_KEY);
      const stored = result[SESSION_TABS_KEY] as
        | Record<string, TabEntry>
        | undefined;
      if (!stored) return;
      for (const [id, entry] of Object.entries(stored)) {
        const tabId = parseInt(id, 10);
        // Don't clobber anything a live event already populated this boot.
        if (!Number.isNaN(tabId) && !tabs.has(tabId)) {
          tabs.set(tabId, entry);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[LD Toolbar Extension] failed to rehydrate tabs:", err);
    }
  })();
  return rehydratePromise;
}

/** Persist the current `tabs` registry so the next SW boot can recover it. */
async function persistTabs(): Promise<void> {
  try {
    const obj: Record<number, TabEntry> = {};
    for (const [id, entry] of tabs) obj[id] = entry;
    await chrome.storage.session.set({ [SESSION_TABS_KEY]: obj });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[LD Toolbar Extension] failed to persist tabs:", err);
  }
}

// Kick off rehydration immediately on boot. Event handlers that read `tabs`
// await this first so a panel reconnecting right after a restart sees the
// recovered state rather than an empty registry.
void rehydrateTabs();

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
    void persistTabs();
    // eslint-disable-next-line no-console
    console.info(
      `[LD Toolbar Extension] content script loaded in tab ${tabId}`,
      sender.tab?.url,
    );
    pushTabStatus(tabId);
  } else if (message.type === "apply-shared-state") {
    // Incoming share URL parsed by the content script. Merge into
    // chrome.storage.local for this origin and push to the SDK if it
    // has already registered.
    void handleSharedStateApply(tabId, sender.tab?.url, message.overrides);
  } else if (message.type === "sdk-ready") {
    const entry: TabEntry = tabs.get(tabId) ?? { loadedAt: Date.now() };
    entry.sdkInfo = message.info;
    entry.url = sender.tab?.url ?? entry.url;
    tabs.set(tabId, entry);
    void persistTabs();
    // eslint-disable-next-line no-console
    console.info(
      `[LD Toolbar Extension] SDK ready in tab ${tabId}`,
      message.info,
    );
    // Restore any persisted overrides for this origin and push status.
    void restoreStoredOverrides(tabId);
    pushTabStatus(tabId);
  } else if (message.type === "overrides-snapshot") {
    // Bridge plugin is telling us its current override state. Replace
    // storage for this origin to match — this handles overrides set
    // directly via window.__ldBridge from page code as well as the
    // round-trip echo from extension-driven changes.
    void handleOverridesSnapshot(
      tabId,
      sender.tab?.url,
      message.overrides,
    );
  } else if (message.type === "flags-snapshot") {
    const entry: TabEntry = tabs.get(tabId) ?? { loadedAt: Date.now() };
    const snap = message.snapshot as
      | { timestamp?: number; flags?: Array<{ key: string; value: unknown }> }
      | undefined;
    if (snap && Array.isArray(snap.flags)) {
      entry.flags = snap.flags;
      entry.flagsTimestamp = snap.timestamp;
      entry.url = sender.tab?.url ?? entry.url;
      tabs.set(tabId, entry);
      void persistTabs();
      pushTabStatus(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  void persistTabs();
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
      void requestResyncIfNeeded(tabId);
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

async function handleOverridesSnapshot(
  tabId: number,
  url: string | undefined,
  overrides: unknown,
): Promise<void> {
  const origin = originFromUrl(url);
  if (!origin) return;
  if (overrides === null || overrides === undefined) return;
  if (typeof overrides !== "object") return;

  const snapshot = overrides as Record<string, unknown>;
  try {
    await replaceOverridesForOrigin(origin, snapshot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to persist override snapshot for tab ${tabId}:`,
      err,
    );
  }
  pushTabStatus(tabId);
}

async function handleSharedStateApply(
  tabId: number,
  url: string | undefined,
  overrides: unknown,
): Promise<void> {
  const origin = originFromUrl(url);
  if (!origin) return;
  if (!overrides || typeof overrides !== "object") return;

  const additions = overrides as Record<string, unknown>;
  if (Object.keys(additions).length === 0) return;

  try {
    await mergeOverridesForOrigin(origin, additions);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LD Toolbar Extension] failed to persist shared state for tab ${tabId}:`,
      err,
    );
  }

  // Push to the SDK now if it's listening. If sdk-ready hasn't fired
  // yet, the existing restore-on-sdk-ready path will catch it shortly.
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "set-overrides",
      overrides: additions,
    });
  } catch {
    /* bridge plugin may not be registered yet — restore path handles it */
  }

  pushTabStatus(tabId);
  // eslint-disable-next-line no-console
  console.info(
    `[LD Toolbar Extension] applied shared state to tab ${tabId} (${Object.keys(additions).length} override(s) for ${origin})`,
  );
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

/**
 * When a panel asks for status but we have no record that an SDK registered
 * in that tab, ping the page. If the bridge plugin is still alive there (it
 * is, as long as the page wasn't reloaded), it re-announces and the panel
 * recovers — no reload required. A no-op when we already know the SDK, when
 * the page has no content script, or when the page genuinely has no SDK.
 */
async function requestResyncIfNeeded(tabId: number): Promise<void> {
  await rehydrateTabs();
  if (tabs.get(tabId)?.sdkInfo) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: PROTOCOL,
      type: "request-resync",
    });
  } catch {
    /* no content script / page not loaded — nothing to resync */
  }
}

async function pushTabStatus(tabId: number): Promise<void> {
  await rehydrateTabs();
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
      flags: entry?.flags ?? [],
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

async function replaceOverridesForOrigin(
  origin: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const all = await getAllStoredOverrides();
  if (Object.keys(overrides).length === 0) {
    delete all[origin];
  } else {
    all[origin] = { ...overrides };
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
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
