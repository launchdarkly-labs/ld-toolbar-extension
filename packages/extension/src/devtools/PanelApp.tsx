import { FormEvent, useEffect, useMemo, useState } from "react";
import { usePanelRpc } from "./usePanelRpc";

/**
 * v0 panel UI.
 *
 * Override state comes from chrome.storage.local, scoped per-origin, and
 * is pushed to the panel by the background SW via tab-status messages.
 * The panel renders that state directly — we no longer maintain a
 * separate optimistic copy.
 *
 * The page-side bridge plugin is the runtime source of truth, but we
 * don't subscribe to changes there for v0. If you use
 * `window.__ldBridge.setOverride(...)` directly from the page console
 * the panel won't reflect it (bidirectional sync is a later slice).
 */
export function PanelApp() {
  const rpc = usePanelRpc();
  const overridesFromStorage = rpc.tabStatus?.overrides ?? {};
  const [flagKey, setFlagKey] = useState("");
  const [valueText, setValueText] = useState("");
  const [valueError, setValueError] = useState<string | null>(null);

  const sdkDetected = Boolean(rpc.tabStatus?.sdkInfo);
  const sdkInfo = rpc.tabStatus?.sdkInfo;

  const overrideEntries = useMemo(
    () => Object.entries(overridesFromStorage),
    [overridesFromStorage],
  );

  // Clear the form errors whenever the persisted state arrives or changes
  // so stale validation messages don't linger after a successful add.
  useEffect(() => {
    setValueError(null);
  }, [overridesFromStorage]);

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    setValueError(null);

    const trimmedKey = flagKey.trim();
    if (!trimmedKey) {
      setValueError("Flag key is required");
      return;
    }

    const parsed = parseValue(valueText);
    if (parsed.error) {
      setValueError(parsed.error);
      return;
    }

    rpc.setOverride(trimmedKey, parsed.value);
    setFlagKey("");
    setValueText("");
  };

  const handleRemove = (key: string) => {
    rpc.removeOverride(key);
  };

  const handleClearAll = () => {
    rpc.clearOverrides();
  };

  return (
    <div className="ld-panel">
      <h1>LaunchDarkly Toolbar</h1>

      <div className={`ld-status ${sdkDetected ? "detected" : "missing"}`}>
        {sdkDetected && sdkInfo ? (
          <>
            ✓ LD SDK detected:{" "}
            <code>
              {sdkInfo.sdkName} v{sdkInfo.sdkVersion}
            </code>
            {sdkInfo.clientSideId && (
              <>
                {" · "}
                <code>{shortId(sdkInfo.clientSideId)}</code>
              </>
            )}
          </>
        ) : rpc.tabStatus ? (
          "Page is loaded but no LD SDK has registered yet. Reload the page if you expect the SDK to be present."
        ) : rpc.connected ? (
          "Waiting for tab info…"
        ) : (
          "Connecting to background service worker…"
        )}
      </div>

      <div className="ld-section">
        <h2>Active overrides ({overrideEntries.length})</h2>
        {overrideEntries.length === 0 ? (
          <div className="ld-empty">
            No overrides set. Use the form below to override a flag value
            for this tab.
          </div>
        ) : (
          <ul className="ld-override-list">
            {overrideEntries.map(([key, value]) => (
              <li key={key}>
                <span className="ld-override-key">{key}</span>
                <span className="ld-override-value">{JSON.stringify(value)}</span>
                <button
                  type="button"
                  className="ld-btn icon"
                  aria-label={`Remove override for ${key}`}
                  onClick={() => handleRemove(key)}
                  title="Remove override"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ld-section">
        <h2>Add override</h2>
        <form className="ld-form" onSubmit={handleAdd}>
          <input
            type="text"
            placeholder="flag-key"
            value={flagKey}
            onChange={(e) => setFlagKey(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
          <input
            type="text"
            placeholder='value (true, "hello", 42, {"k":1})'
            value={valueText}
            onChange={(e) => setValueText(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
          <button type="submit" className="ld-btn" disabled={!sdkDetected}>
            Add
          </button>
        </form>
        {valueError && (
          <div className="ld-hint" style={{ color: "#d33b3b" }}>{valueError}</div>
        )}
        <div className="ld-hint">
          Value is parsed as JSON. Examples: <code>true</code>, <code>false</code>,{" "}
          <code>42</code>, <code>"banner-text"</code>,{" "}
          <code>{`{"theme":"dark"}`}</code>.
        </div>
      </div>

      <div className="ld-section">
        <button
          type="button"
          className="ld-btn danger"
          onClick={handleClearAll}
          disabled={overrideEntries.length === 0}
        >
          Clear all overrides
        </button>
      </div>
    </div>
  );
}

function parseValue(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { error: "Value is required" };
  }
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    // Fall back: treat as a plain string. Helpful so users can type
    // `banner-text` without quotes.
    return { value: text };
  }
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
