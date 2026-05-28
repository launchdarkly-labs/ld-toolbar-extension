import type {
  Hook,
  LDClient,
  LDDebugOverride,
  LDFlagSet,
  LDFlagValue,
  LDPlugin,
  LDPluginEnvironmentMetadata,
  LDPluginMetadata,
} from "launchdarkly-js-client-sdk";

const PLUGIN_NAME = "ExtensionBridgePlugin";
const HOOK_GLOBAL = "__LD_DEVTOOLS_HOOK__";
const DEBUG_GLOBAL = "__ldBridge";

export interface ExtensionBridgePluginConfig {
  /**
   * Attach the plugin instance to `window.__ldBridge` for ad-hoc console use.
   * Defaults to true. Set false in production builds if you don't want it exposed.
   */
  exposeOnWindow?: boolean;
}

interface LDDevtoolsHookShape {
  version: number;
  extensionVersion?: string;
  onSdkReady?: (info: SdkReadyInfo) => void;
  subscribeToOverrides?: (
    listener: (msg: OverrideMessage) => void,
  ) => () => void;
}

interface SdkReadyInfo {
  sdkName?: string;
  sdkVersion?: string;
  clientSideId?: string;
  applicationId?: string;
  applicationVersion?: string;
}

type OverrideMessage =
  | { type: "set-overrides"; overrides: Record<string, LDFlagValue> }
  | { type: "remove-override"; flagKey: string }
  | { type: "clear-overrides" };

/**
 * SDK plugin that lets the LaunchDarkly Dev Toolbar Chrome extension drive
 * flag overrides without touching localStorage or rendering UI into the host
 * application.
 *
 * Override state is held in memory only. The plugin uses the SDK's
 * LDDebugOverride hook to apply overrides — the same sanctioned mechanism the
 * official FlagOverridePlugin uses internally, just without the persistence.
 *
 * Works standalone (call `setOverride(key, value)` directly from app or test
 * code) and also picks up commands from the extension via
 * `window.__LD_DEVTOOLS_HOOK__` when present.
 */
export class ExtensionBridgePlugin implements LDPlugin {
  private debugOverride: LDDebugOverride | null = null;
  private ldClient: LDClient | null = null;
  private envMetadata: LDPluginEnvironmentMetadata | null = null;
  private overrides: Map<string, LDFlagValue> = new Map();
  private unsubscribeFromHook: (() => void) | null = null;
  private readonly config: Required<ExtensionBridgePluginConfig>;

  constructor(config: ExtensionBridgePluginConfig = {}) {
    this.config = {
      exposeOnWindow: config.exposeOnWindow ?? true,
    };

    if (this.config.exposeOnWindow && typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = this;
    }
  }

  getMetadata(): LDPluginMetadata {
    return { name: PLUGIN_NAME };
  }

  getHooks(metadata: LDPluginEnvironmentMetadata): Hook[] {
    this.envMetadata = metadata;
    return [];
  }

  register(ldClient: LDClient): void {
    this.ldClient = ldClient;
    this.connectToExtensionIfPresent();
  }

  registerDebug(debugOverride: LDDebugOverride): void {
    this.debugOverride = debugOverride;

    // Replay any overrides that were set before the SDK's debug interface
    // became available (e.g., setOverride called immediately after construct,
    // or overrides delivered by the extension before registerDebug fired).
    for (const [flagKey, value] of this.overrides) {
      try {
        debugOverride.setOverride(flagKey, value);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `[ExtensionBridgePlugin] Failed to replay override for ${flagKey}:`,
          error,
        );
      }
    }
  }

  /**
   * Set an override value for a flag. Takes effect immediately on the SDK if
   * the debug interface is available; otherwise queued in memory and applied
   * when the SDK calls registerDebug().
   */
  setOverride(flagKey: string, value: LDFlagValue): void {
    if (!flagKey || typeof flagKey !== "string") {
      // eslint-disable-next-line no-console
      console.error("[ExtensionBridgePlugin] Invalid flag key:", flagKey);
      return;
    }
    if (value === undefined) {
      // eslint-disable-next-line no-console
      console.error(
        "[ExtensionBridgePlugin] Cannot override flag with undefined value",
      );
      return;
    }

    this.overrides.set(flagKey, value);

    if (this.debugOverride) {
      try {
        this.debugOverride.setOverride(flagKey, value);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[ExtensionBridgePlugin] Failed to set override on SDK:",
          error,
        );
      }
    }
  }

  /**
   * Remove the override for a single flag. The flag reverts to its
   * server-evaluated value on the next variation() call.
   */
  removeOverride(flagKey: string): void {
    if (!flagKey || typeof flagKey !== "string") {
      // eslint-disable-next-line no-console
      console.error("[ExtensionBridgePlugin] Invalid flag key:", flagKey);
      return;
    }

    this.overrides.delete(flagKey);

    if (this.debugOverride) {
      try {
        this.debugOverride.removeOverride(flagKey);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[ExtensionBridgePlugin] Failed to remove override on SDK:",
          error,
        );
      }
    }
  }

  /** Remove every override. */
  clearAllOverrides(): void {
    this.overrides.clear();

    if (this.debugOverride) {
      try {
        this.debugOverride.clearAllOverrides();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[ExtensionBridgePlugin] Failed to clear overrides on SDK:",
          error,
        );
      }
    }
  }

  /** Snapshot of the current in-memory overrides. */
  getAllOverrides(): LDFlagSet {
    const snapshot: LDFlagSet = {};
    for (const [key, value] of this.overrides) {
      snapshot[key] = value;
    }
    return snapshot;
  }

  /** The LDClient the SDK passed in at register(). Null before that. */
  getClient(): LDClient | null {
    return this.ldClient;
  }

  /**
   * Detach from the extension hook. Useful in tests and during HMR.
   */
  disconnect(): void {
    if (this.unsubscribeFromHook) {
      try {
        this.unsubscribeFromHook();
      } catch {
        /* ignore */
      }
      this.unsubscribeFromHook = null;
    }
  }

  private connectToExtensionIfPresent(): void {
    if (typeof window === "undefined") return;

    const hook = (window as unknown as Record<string, unknown>)[
      HOOK_GLOBAL
    ] as LDDevtoolsHookShape | undefined;
    if (!hook) return;

    // eslint-disable-next-line no-console
    console.info(
      "[ExtensionBridgePlugin] Dev Toolbar extension detected",
      hook,
    );

    // Announce ourselves with whatever environment info we have.
    if (typeof hook.onSdkReady === "function") {
      try {
        hook.onSdkReady({
          sdkName: this.envMetadata?.sdk?.name,
          sdkVersion: this.envMetadata?.sdk?.version,
          clientSideId: this.envMetadata?.clientSideId,
          applicationId: this.envMetadata?.application?.id,
          applicationVersion: this.envMetadata?.application?.version,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[ExtensionBridgePlugin] onSdkReady threw:", error);
      }
    }

    // Subscribe to override commands from the extension.
    if (typeof hook.subscribeToOverrides === "function") {
      try {
        this.unsubscribeFromHook = hook.subscribeToOverrides((msg) => {
          this.handleExtensionMessage(msg);
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[ExtensionBridgePlugin] Failed to subscribe to extension overrides:",
          error,
        );
      }
    }
  }

  private handleExtensionMessage(msg: OverrideMessage): void {
    if (msg.type === "set-overrides") {
      for (const [key, value] of Object.entries(msg.overrides)) {
        this.setOverride(key, value);
      }
    } else if (msg.type === "remove-override") {
      this.removeOverride(msg.flagKey);
    } else if (msg.type === "clear-overrides") {
      this.clearAllOverrides();
    }
  }
}
