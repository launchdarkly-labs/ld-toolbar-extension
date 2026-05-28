import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Long-lived RPC port between this DevTools panel and the background SW.
 * Background does the actual chrome.tabs.sendMessage to the inspected tab.
 *
 * The port is reconnected if it drops (which happens when the SW idles out).
 */

const PORT_NAME_PREFIX = "panel:";

export interface SdkInfo {
  sdkName?: string;
  sdkVersion?: string;
  clientSideId?: string;
  applicationId?: string;
  applicationVersion?: string;
}

export interface FlagSnapshotEntry {
  key: string;
  value: unknown;
}

export interface TabStatusMessage {
  type: "tab-status";
  tabId: number;
  url?: string;
  origin?: string | null;
  sdkInfo?: SdkInfo;
  /** Overrides persisted in chrome.storage.local for this tab's origin. */
  overrides?: Record<string, unknown>;
  /** Latest flag snapshot reported by the bridge plugin. */
  flags?: FlagSnapshotEntry[];
}

interface InboundEnvelope {
  source: "ld-devtools-ext";
  type: string;
  [k: string]: unknown;
}

export interface RpcState {
  connected: boolean;
  tabStatus: TabStatusMessage | null;
}

export function usePanelRpc() {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [state, setState] = useState<RpcState>({
    connected: false,
    tabStatus: null,
  });

  // (Re)connect to the background SW.
  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const port = chrome.runtime.connect({ name: `${PORT_NAME_PREFIX}${tabId}` });
      portRef.current = port;
      setState((s) => ({ ...s, connected: true }));

      port.onMessage.addListener((message: InboundEnvelope) => {
        if (!message || message.source !== "ld-devtools-ext") return;
        if (message.type === "tab-status") {
          setState((s) => ({ ...s, tabStatus: message as unknown as TabStatusMessage }));
        }
      });

      port.onDisconnect.addListener(() => {
        portRef.current = null;
        setState((s) => ({ ...s, connected: false }));
        // Reconnect after a short delay so the SW has time to recover.
        setTimeout(connect, 500);
      });

      // Request initial status.
      port.postMessage({
        source: "ld-devtools-ext",
        type: "get-tab-status",
      });
    };

    connect();

    return () => {
      cancelled = true;
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [tabId]);

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const port = portRef.current;
    if (!port) {
      // eslint-disable-next-line no-console
      console.warn("[LD Panel] cannot send, port not connected:", type);
      return;
    }
    port.postMessage({ source: "ld-devtools-ext", type, ...payload });
  }, []);

  const setOverride = useCallback(
    (flagKey: string, value: unknown) => {
      send("set-overrides", { overrides: { [flagKey]: value } });
    },
    [send],
  );

  const removeOverride = useCallback(
    (flagKey: string) => {
      send("remove-override", { flagKey });
    },
    [send],
  );

  const clearOverrides = useCallback(() => {
    send("clear-overrides");
  }, [send]);

  const requestStatus = useCallback(() => {
    send("get-tab-status");
  }, [send]);

  return {
    tabId,
    ...state,
    setOverride,
    removeOverride,
    clearOverrides,
    requestStatus,
  };
}
