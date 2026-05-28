/**
 * MAIN-world content script.
 *
 * Runs at document_start, before any page JavaScript. Plants the sentinel
 * global on `window` that the @launchdarkly/toolbar-extension-bridge SDK
 * plugin looks for to confirm the extension is installed, and exposes a
 * subscription API the plugin uses to receive override commands.
 *
 * Modeled after React DevTools' __REACT_DEVTOOLS_GLOBAL_HOOK__ pattern.
 *
 * Communication with the rest of the extension happens via
 * `window.postMessage` to the ISOLATED-world content script — see
 * content-script.ts for the bridge to chrome.runtime.
 */

const PROTOCOL = "ld-devtools-ext";
const EXTENSION_VERSION = "0.0.1";

declare global {
  interface Window {
    __LD_DEVTOOLS_HOOK__?: LDDevtoolsHook;
  }
}

export interface LDDevtoolsHook {
  /** Wire protocol version. Bump if message shape changes. */
  version: 1;
  /** Extension build version. */
  extensionVersion: string;
  /** Called by the bridge plugin once the LD SDK has registered it. */
  onSdkReady: (info: SdkReadyInfo) => void;
  /** Called by the bridge plugin to receive override commands. */
  subscribeToOverrides: (listener: OverrideListener) => Unsubscribe;
  /** Called by the bridge plugin when the LD SDK's flag set changes. */
  notifyFlagsChanged: (snapshot: FlagsSnapshot) => void;
  /**
   * Called by the bridge plugin whenever its in-memory override map
   * changes for any reason — including changes driven by direct
   * `bridge.setOverride()` calls from page code (not just from the
   * extension). Lets the panel stay in sync.
   */
  notifyOverridesChanged: (overrides: Record<string, unknown>) => void;
}

export interface FlagsSnapshot {
  /** Wall-clock timestamp the snapshot was taken. */
  timestamp: number;
  flags: Array<{ key: string; value: unknown }>;
}

export interface SdkReadyInfo {
  sdkName?: string;
  sdkVersion?: string;
  clientSideId?: string;
  applicationId?: string;
  applicationVersion?: string;
}

export type OverrideMessage =
  | { type: "set-overrides"; overrides: Record<string, unknown> }
  | { type: "remove-override"; flagKey: string }
  | { type: "clear-overrides" };

export type OverrideListener = (msg: OverrideMessage) => void;
export type Unsubscribe = () => void;

const overrideListeners: Set<OverrideListener> = new Set();

const hook: LDDevtoolsHook = {
  version: 1,
  extensionVersion: EXTENSION_VERSION,

  onSdkReady(info) {
    window.postMessage(
      {
        source: PROTOCOL,
        direction: "from-page",
        type: "sdk-ready",
        info,
      },
      window.location.origin,
    );
  },

  subscribeToOverrides(listener) {
    overrideListeners.add(listener);
    return () => {
      overrideListeners.delete(listener);
    };
  },

  notifyFlagsChanged(snapshot) {
    window.postMessage(
      {
        source: PROTOCOL,
        direction: "from-page",
        type: "flags-snapshot",
        snapshot,
      },
      window.location.origin,
    );
  },

  notifyOverridesChanged(overrides) {
    window.postMessage(
      {
        source: PROTOCOL,
        direction: "from-page",
        type: "overrides-snapshot",
        overrides,
      },
      window.location.origin,
    );
  },
};

if (!window.__LD_DEVTOOLS_HOOK__) {
  window.__LD_DEVTOOLS_HOOK__ = hook;
}

// Receive override commands from the extension (background SW → ISOLATED
// content script → here via window.postMessage) and fan out to subscribed
// listeners — typically just the bridge plugin.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as
    | {
        source?: string;
        direction?: string;
        type?: string;
        overrides?: unknown;
        flagKey?: unknown;
      }
    | null;
  if (!data || data.source !== PROTOCOL || data.direction !== "from-ext") {
    return;
  }

  if (data.type === "set-overrides" && data.overrides && typeof data.overrides === "object") {
    fanOut({
      type: "set-overrides",
      overrides: data.overrides as Record<string, unknown>,
    });
  } else if (data.type === "remove-override" && typeof data.flagKey === "string") {
    fanOut({ type: "remove-override", flagKey: data.flagKey });
  } else if (data.type === "clear-overrides") {
    fanOut({ type: "clear-overrides" });
  }
});

function fanOut(msg: OverrideMessage): void {
  for (const listener of overrideListeners) {
    try {
      listener(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[LD Toolbar Extension] override listener threw:", err);
    }
  }
}
