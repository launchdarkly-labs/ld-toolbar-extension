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
 * code) and also picks up commands from the extension when present.
 */
export class ExtensionBridgePlugin implements LDPlugin {
  private debugOverride: LDDebugOverride | null = null;
  private ldClient: LDClient | null = null;
  private overrides: Map<string, LDFlagValue> = new Map();
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

  getHooks(_metadata: LDPluginEnvironmentMetadata): Hook[] {
    return [];
  }

  register(ldClient: LDClient): void {
    this.ldClient = ldClient;

    if (typeof window === "undefined") {
      return;
    }

    const hook = (window as unknown as Record<string, unknown>)[HOOK_GLOBAL];
    if (hook) {
      // Extension is installed. Transport wiring will live here in a later
      // slice — for now we just record presence so the console can see it.
      // eslint-disable-next-line no-console
      console.info(
        "[ExtensionBridgePlugin] Dev Toolbar extension detected",
        hook,
      );
    }
  }

  registerDebug(debugOverride: LDDebugOverride): void {
    this.debugOverride = debugOverride;

    // Replay any overrides that were set before the SDK's debug interface
    // became available (e.g., setOverride called immediately after construct).
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
}
