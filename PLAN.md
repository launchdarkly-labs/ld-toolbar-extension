# LaunchDarkly Toolbar Chrome Extension — Plan

## Goals (must-haves)

1. **No localStorage / sessionStorage / cookies** in the host app. Override state lives in extension-owned storage (`chrome.storage.local`) and an in-memory map on the page side. Solves the CDW constraint.
2. **No LaunchDarkly login required** for the developer using the extension or for anyone they share configurations with. The extension never authenticates with LD's backend.
3. **No floating UI on the host app.** All UI lives in the Chrome extension (DevTools panel). Lets devs validate flags in production without polluting the customer-facing app.

## Non-goals (for v0)

- Replacing the full feature set of the existing toolbar (contexts, settings, share state, event interception, observability, session replay). MVP is override-focused.
- Supporting non-Chromium browsers. Manifest V3 + Chrome first; Firefox/Edge later.
- Server-side SDK overrides. Browser SDKs only.
- Chrome Web Store distribution. Stays as a sideloaded/unpacked dev extension for private use.

## Decisions locked in

| Decision | Value |
|---|---|
| Bridge plugin npm name | `@launchdarkly/toolbar-extension-bridge` |
| Distribution | Private only for now. No Chrome Web Store, no public npm publish until validated. |
| Bridge plugin programmatic API | Yes — expose `setOverride(key, value)` / `clearOverride(key)` / `clearAll()` so customers can drive overrides from their own code (e.g., Playwright tests) even when the extension isn't open. |
| License | Apache 2.0 (consistent with other LD repos) |

## Architecture

Adopting the **React DevTools pattern** end-to-end. Five communication hops:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Chrome Extension                                                   │
│                                                                     │
│  DevTools Panel  <──port──>  Background SW  <──port──>  Content    │
│  (React UI)                  (chrome.storage)           Script      │
│                                                            │        │
└────────────────────────────────────────────────────────────┼────────┘
                                                             │
                            window.postMessage / CustomEvent │ (page boundary)
                                                             │
┌────────────────────────────────────────────────────────────▼────────┐
│  Host App (customer's site)                                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  @launchdarkly/toolbar-extension-bridge                      │  │
│  │  - Implements LD SDK plugin interface                        │  │
│  │  - Uses LDDebugOverride.setOverride() (sanctioned SDK hook)  │  │
│  │  - Holds override map in memory                              │  │
│  │  - Detects extension via window.__LD_DEVTOOLS_HOOK__         │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Connection lifecycle (the colleague's refined flow)

1. **Extension injection at `document_start`.** Manifest sets the content script to `run_at: document_start`. The content script injects a tiny shim into the page (via `<script>` tag or `chrome.scripting.executeScript` with `world: 'MAIN'`) that sets `window.__LD_DEVTOOLS_HOOK__ = { version: 1, ... }` **before any page JS runs**. This is the React DevTools `__REACT_DEVTOOLS_GLOBAL_HOOK__` pattern.

2. **Bridge plugin detects presence.** When the SDK calls `bridge.register(client)`, the plugin checks `window.__LD_DEVTOOLS_HOOK__`. If absent → plugin is dormant, no messaging, zero overhead. If present → proceed to step 3.

3. **Bridge announces itself.** Plugin dispatches a `CustomEvent('ld-devtools:sdk-ready', { detail: { sdkVersion, clientSideId, environmentKey, ... } })` on `window`. The hook shim (or content script via `window.postMessage`) picks this up.

4. **Content script forwards to background.** Content script tells the background service worker "tab X has an LD SDK active, here's the metadata."

5. **Long-lived RPC channel.** Background opens a `chrome.runtime.Port` to the content script. Content script opens a paired postMessage channel to the page. Page-side plugin attaches a listener and they have a duplex RPC for the lifetime of the tab.

### Why this structure (vs. my original simpler sketch)

- **Presence detection avoids overhead.** Customers who don't have the extension installed pay zero cost — no postMessage spam, no listeners. Same way React DevTools doesn't slow apps that don't have it installed.
- **Handshake gives the extension visibility into multi-tab and multi-SDK cases.** Background knows "tabs A, B, C have LD active." The DevTools panel can show "no LD detected" vs "LD detected" cleanly.
- **Port-based RPC** beats one-shot `sendMessage` for ongoing bidirectional traffic. Cleaner connect/disconnect, automatic cleanup on tab close.

## Repo layout (pnpm workspace)

```
ld-toolbar-extension/
├── README.md
├── PLAN.md                          ← this file
├── CLAUDE.md                        ← for future Claude sessions
├── LICENSE                          (Apache 2.0)
├── package.json                     (workspace root)
├── pnpm-workspace.yaml
├── packages/
│   ├── extension/                   ← Chrome extension (MV3)
│   │   ├── manifest.json
│   │   ├── src/
│   │   │   ├── background.ts        (service worker; owns chrome.storage; tab registry)
│   │   │   ├── content-script.ts    (page bridge; runs at document_start)
│   │   │   ├── injected.ts          (the hook shim, injected into page MAIN world)
│   │   │   ├── devtools/
│   │   │   │   ├── devtools.html
│   │   │   │   ├── devtools.ts      (creates the panel)
│   │   │   │   ├── panel.html
│   │   │   │   └── panel/           (React UI for the panel)
│   │   │   └── shared/
│   │   │       └── protocol.ts      (RPC message types, version constant)
│   │   └── vite.config.ts
│   └── bridge-plugin/               ← npm package consumers install
│       ├── package.json             (name: @launchdarkly/toolbar-extension-bridge)
│       ├── src/
│       │   ├── index.ts             (public API)
│       │   ├── plugin.ts            (LD SDK plugin impl)
│       │   └── transport.ts         (postMessage / CustomEvent layer)
│       └── tsconfig.json
└── examples/
    └── README.md                    (points at /demos/weather-demo as the test app)
```

## RPC protocol

Versioned. Message envelope:

```ts
type Envelope = {
  source: 'ld-devtools-ext';        // distinguishes from unrelated postMessage traffic
  protocolVersion: 1;
  type: string;
  payload?: unknown;
};
```

Initial message types:

**Page → Extension (via the hook shim → content script → background):**
- `sdk-ready` — `{ sdkVersion, clientSideId, environmentKey, anonymous }`
- `flags-snapshot` — `{ flags: Array<{key, currentValue, defaultValue, variation}> }`
- `evaluation` — (optional, for later) `{ flagKey, value, defaultValue, reason }`

**Extension → Page:**
- `set-overrides` — `{ overrides: Record<flagKey, value> }` (idempotent full replace)
- `clear-overrides`
- `request-snapshot` — asks for a fresh flags-snapshot

Unknown types are ignored on both sides (forward compat).

## Bridge plugin API (programmatic surface)

```ts
import { ExtensionBridgePlugin } from '@launchdarkly/toolbar-extension-bridge';

const bridge = new ExtensionBridgePlugin();

// Standard LD SDK plugin lifecycle (called by the SDK):
bridge.getMetadata();
bridge.getHooks(envMetadata);
bridge.register(ldClient);
bridge.registerDebug(debugOverride);   // <-- this is where the magic happens

// Programmatic API for customer code (e.g. Playwright):
bridge.setOverride('flag-key', true);
bridge.clearOverride('flag-key');
bridge.clearAll();
bridge.getOverrides();                 // returns current in-memory map

// Mirrors how the existing FlagOverridePlugin is shaped.
```

Internally: `setOverride` updates the in-memory map and calls `debugOverride.setOverride(key, value)` on the SDK. Extension messages route through the same `setOverride` path. Customer code and extension are equivalent input methods.

## State storage shape (`chrome.storage.local`)

```ts
{
  "overrides": {
    "<origin>": {
      "<flagKey>": <value>
    }
  },
  "lastActiveTab": <tabId | null>
}
```

Per-origin scoping: overrides on `staging.example.com` don't leak to `prod.example.com`. Cleared on extension uninstall (Chrome handles this).

## MVP scope (v0)

Build order:

1. **Bridge plugin** standalone — implements the LD plugin interface, exposes programmatic `setOverride()`, has stub transport that no-ops if no extension hook detected. Wire into `weather-demo`. Console-driven test: `window.__bridge.setOverride('flag', true)` flips the flag. **No extension yet.**
2. **Hook shim + content script.** Manifest at MV3, content script at `document_start`, injects `window.__LD_DEVTOOLS_HOOK__`. Bridge plugin detects it and dispatches `sdk-ready`. Verify in the console.
3. **Background service worker + port-based RPC.** Tab registry, port plumbing. Background knows which tabs have LD active.
4. **DevTools panel UI.** Flat list of flags from the latest `flags-snapshot`. Each row has a value input. Setting a value sends `set-overrides` down the channel.
5. **Persistence via `chrome.storage.local`.** Per-origin scoping. Hydrate overrides on tab load and re-send to bridge plugin.
6. **End-to-end smoke** in `weather-demo`: install extension unpacked, open DevTools panel, override a flag, see it apply.

Out of scope for v0 (parking lot):
- Browser action popup (devtools is enough for now)
- Contexts / context switching
- Share-state URLs
- Event interception / evaluation log
- Firefox / non-Chrome
- Tooltips, theming, polish

## Testing strategy

- Unit tests on the bridge plugin (override precedence, plugin lifecycle, message handling).
- Manual end-to-end test using `/Users/kathymorris/Documents/kathy/demos/weather-demo` as the host app.
- Playwright E2E after the surface stabilizes.

## Reference material to keep open while implementing

- `~/Documents/kathy/launchdarkly-toolbar/packages/toolbar/src/types/plugins/flagOverridePlugin.ts` — canonical plugin shape
- `~/Documents/kathy/launchdarkly-toolbar/packages/toolbar/src/types/plugins/eventInterceptionPlugin.ts` — second plugin example
- React DevTools repo (`facebook/react/packages/react-devtools-extensions`) for the injection / hook / RPC pattern

## First slice (1-2 hour vertical to validate the foundation)

1. `packages/bridge-plugin/` with the plugin class — register + registerDebug + programmatic setOverride. No extension yet.
2. Wire into `weather-demo` alongside or replacing the current toolbar plugin.
3. Open browser console: `window.__ldBridge.setOverride('some-flag', true)` → flag flips, no localStorage touched, no UI rendered.

If that works, the whole rest of the project is plumbing. If it doesn't (e.g., `LDDebugOverride` doesn't behave like I think it does), we discover that on day one with ~100 lines of code instead of after building the extension.
