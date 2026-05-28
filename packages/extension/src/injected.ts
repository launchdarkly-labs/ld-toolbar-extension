/**
 * MAIN-world content script.
 *
 * Runs at document_start, before any page JavaScript. Plants a sentinel
 * global on `window` so the @launchdarkly/toolbar-extension-bridge SDK
 * plugin can detect that the extension is installed when it initializes.
 *
 * Modeled after React DevTools' __REACT_DEVTOOLS_GLOBAL_HOOK__ pattern.
 *
 * No messaging yet — that's the next slice. For now this just announces
 * "extension is here" so the bridge plugin's `register()` lights up its
 * detection branch.
 */

declare global {
  interface Window {
    __LD_DEVTOOLS_HOOK__?: LDDevtoolsHook;
  }
}

export interface LDDevtoolsHook {
  /** Protocol version. Bump if the wire shape changes. */
  version: 1;
  /** Filled in by the extension build; useful for diagnostics. */
  extensionVersion: string;
  /**
   * Called by the bridge plugin to announce it has registered with an
   * LD SDK instance in this page. Wired to real RPC in a later slice;
   * for now it just logs.
   */
  onSdkReady: (info: SdkReadyInfo) => void;
}

export interface SdkReadyInfo {
  sdkName?: string;
  sdkVersion?: string;
  clientSideId?: string;
  environmentKey?: string;
}

const EXTENSION_VERSION = "0.0.1";

const hook: LDDevtoolsHook = {
  version: 1,
  extensionVersion: EXTENSION_VERSION,
  onSdkReady(info) {
    // eslint-disable-next-line no-console
    console.info(
      "[LD Toolbar Extension] SDK announced via __LD_DEVTOOLS_HOOK__",
      info,
    );
  },
};

if (!window.__LD_DEVTOOLS_HOOK__) {
  window.__LD_DEVTOOLS_HOOK__ = hook;
}
