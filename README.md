# LaunchDarkly Dev Toolbar — Chrome Extension Edition

A Chrome extension + lightweight SDK plugin for overriding LaunchDarkly feature flags during development, QA, and production validation — **without writing anything to the host page's `localStorage`**, **without requiring a LaunchDarkly login**, and **without rendering any UI into the host application**.

> **Status:** v0. Functional but minimal. See [Roadmap](#roadmap) for what's intentionally out of scope right now.

> **LaunchDarkly Labs:** This repository is maintained as a Labs project. It is not officially supported by LaunchDarkly. For officially supported tooling, see the [LaunchDarkly Dev Toolbar](https://docs.launchdarkly.com/home/getting-started/dev-toolbar).

## Why this exists

The official [`@launchdarkly/toolbar`](https://docs.launchdarkly.com/home/getting-started/dev-toolbar) is the right tool for most teams — it's actively developed by LaunchDarkly, ships a rich UI directly into the app, integrates with the LaunchDarkly product, and covers a lot more than just flag overrides (contexts, event interception, observability, session replay). If you don't have any specific constraints below, **use the official toolbar.**

This project exists for a narrower set of scenarios where the official toolbar's design choices don't fit:

1. **Apps that can't write to `localStorage` / `sessionStorage` / cookies on their own origin** — security policies, compliance posture, or embedded environments that lock down browser storage. The official toolbar's override mechanism is `localStorage`-backed (correctly — that's the right primitive for an in-page tool), but it means the override path is unavailable when those storage APIs are blocked.
2. **Workflows where requiring a LaunchDarkly login adds friction** — for example, a QA engineer who needs to force a flag variation but doesn't have a seat in the project, or a contractor working in a sandbox environment. The official toolbar's full UI is gated behind LD authentication for good reasons (it shows project state); this extension trades that integration for a no-auth override-only experience.
3. **Validating flag behavior in production without any UI visible to end users.** The official toolbar's floating button is the right default — it's how authenticated devs find their tools. For the specific case of "force a flag in prod for 30 seconds to confirm an incident workaround, then revert," moving the UI into Chrome DevTools keeps the host app pixel-identical to what users see.

This project does much less than the official toolbar by design: it focuses tightly on flag overrides and the supporting workflow (persistence, share links, flag discovery), and skips the rest. The two coexist — you can register both plugins in the same SDK config if you want both surfaces available.

## Architecture at a glance

The system has two cooperating halves:

```
Chrome Extension (this repo)              Host App (any LD-SDK app)
─────────────────────────────             ─────────────────────────
                                                                   
 DevTools Panel (React)                                            
   │  chrome.runtime.Port                                          
   ▼                                                               
 Background Service Worker                                         
   │  chrome.tabs.sendMessage                                      
   ▼                                                               
 Content Scripts                          @launchdarkly/toolbar-   
   - ISOLATED world (RPC)         ──▶     extension-bridge         
   - MAIN world (window hook)             - SDK plugin             
                                          - In-memory override map 
                                          - Uses LDDebugOverride   
                                          ▼                        
                                          LD JS SDK serves the     
                                          overridden value         
```

Two things make this work:

- The **bridge plugin** (`@launchdarkly/toolbar-extension-bridge`) implements LaunchDarkly's official `LDPlugin` interface and applies overrides via `LDDebugOverride.setOverride(...)` — the same sanctioned SDK hook the official toolbar uses. No monkey-patching, no fragility. Overrides live in memory only.
- The **extension** stores override state in `chrome.storage.local` (the extension's own sandbox, completely separate from the page's storage). The page never sees this; CDW-style restrictions on `window.localStorage` don't apply.

## Quick start

You need to do two things: install the Chrome extension, and add the bridge plugin to your app's LD SDK config.

### 1. Install the Chrome extension (unpacked)

This repo ships the extension as source; the v0 distribution path is sideloading.

```bash
git clone https://github.com/launchdarkly-labs/ld-toolbar-extension.git
cd ld-toolbar-extension
corepack pnpm install
corepack pnpm --filter ./packages/extension run build
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `packages/extension/dist` directory

You should see **LaunchDarkly Toolbar Extension** in the list. (Chrome Web Store distribution is a future option — see [Roadmap](#roadmap).)

### 2. Add the bridge plugin to your app

The bridge plugin works with **any** browser-side LaunchDarkly SDK that supports the `plugins` config option (JS Client v3.6.0+ — which includes React, Vue, and Angular wrappers).

**Vanilla JS:**

```js
import { initialize } from "launchdarkly-js-client-sdk";
import { ExtensionBridgePlugin } from "@launchdarkly/toolbar-extension-bridge";

const bridge = new ExtensionBridgePlugin();

const client = initialize("YOUR_CLIENT_SIDE_ID", context, {
  plugins: [bridge],
});

await client.waitForInitialization();
```

**React SDK:**

```jsx
import { asyncWithLDProvider } from "launchdarkly-react-client-sdk";
import { ExtensionBridgePlugin } from "@launchdarkly/toolbar-extension-bridge";

const bridge = new ExtensionBridgePlugin();

const LDProvider = await asyncWithLDProvider({
  clientSideID: "YOUR_CLIENT_SIDE_ID",
  context: { kind: "user", key: "user-key", anonymous: true },
  options: {
    plugins: [bridge],
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <LDProvider>
    <App />
  </LDProvider>,
);
```

That's the entire integration. The plugin auto-detects whether the Chrome extension is installed; if it's not present, it does nothing (no network calls, no listeners, no overhead). If it is present, it announces itself and starts receiving override commands.

### 3. Use it

1. Open your app in Chrome with the extension installed.
2. Open Chrome DevTools (F12 or Cmd+Opt+I).
3. Click the **LaunchDarkly** tab in the DevTools tab strip (it may be behind the `»` overflow if you have many panels).
4. The panel shows the SDK status, current overrides, and an "Add override" form.
5. Type a flag key, type a value (JSON-parsed: `true`, `false`, `42`, `"string"`, or `{"foo":1}`), click **Add**. The flag flips immediately on the page.
6. **Share a configuration:** once you've set overrides, click **Copy share link** in the panel. Send the resulting URL to a teammate. When they open it (with the extension installed), the overrides apply to their page automatically. The URL parameter is read by the extension and never by the host page, so it works in environments that block `localStorage`.

## Programmatic API

The bridge plugin exposes a small API on the instance you create. Useful for Playwright/Cypress tests, console debugging, or driving overrides from your own code:

```ts
const bridge = new ExtensionBridgePlugin();

// In your SDK config:
new LDClient(..., { plugins: [bridge] });

// Then from app code, tests, or the console:
bridge.setOverride("my-flag", true);
bridge.setOverride("greeting", "hello");
bridge.setOverride("config", { theme: "dark", limit: 50 });

bridge.removeOverride("my-flag");
bridge.clearAllOverrides();

bridge.getAllOverrides();  // → Record<flagKey, value>
bridge.getClient();        // → LDClient (or null before SDK register())
```

By default the instance is also exposed at `window.__ldBridge` for convenient console access. Disable this in production builds by passing `new ExtensionBridgePlugin({ exposeOnWindow: false })`.

The programmatic API works **with or without the extension installed**. The extension just gives you a UI on top of the same operations.

## Comparison to the official `@launchdarkly/toolbar`

These are different tools with overlapping but distinct surface areas. Pick based on what your environment can support and which features you need; the table below is a quick orientation, not a scorecard.

| | Official Dev Toolbar | This (Extension Edition) |
|---|---|---|
| Flag overrides | Yes | Yes |
| Override UI surface | In-app floating button | Chrome DevTools panel |
| Override storage backend | Browser `localStorage` on the page origin | In-memory page-side + `chrome.storage.local` in the extension sandbox |
| LaunchDarkly login | Required for full functionality (project integration, share state, etc.) | Not used |
| UI rendered into host app DOM | Yes (floating button) | No |
| SDK plugin interface | `LDPlugin` | `LDPlugin` (identical contract) |
| Framework support | JS / React / Vue / Angular | JS / React / Vue / Angular |
| Context switching | Yes | Not in v0 |
| Event interception / evaluation log | Yes | Not in v0 |
| Share state via URL | Yes (writes to `localStorage` on receive) | Yes (writes to `chrome.storage.local`; both parties need the extension) |
| Observability / session replay integration | Yes | No |
| Distribution | Published npm package + CDN bundle | Sideloaded unpacked Chrome extension (Web Store TBD) |

Use the **official toolbar** if you have a LaunchDarkly account for everyone who'll use it, your app can write to `localStorage`, and you want the broader feature set. Use **this extension** if any of those don't hold and you just need flag overrides.

The two implementations are independent — this project doesn't depend on `@launchdarkly/toolbar` — and they happily coexist in the same SDK config if you want both surfaces available at once.

## How it works (deeper)

If you're integrating, debugging, or extending the project, this section covers the message flow.

**Page load sequence** (assuming the extension is installed):

1. Page navigation begins.
2. At `document_start`, before any page script runs, Chrome injects two content scripts:
   - `injected.ts` runs in the page's **MAIN** world and sets `window.__LD_DEVTOOLS_HOOK__` (the same pattern React DevTools uses with `__REACT_DEVTOOLS_GLOBAL_HOOK__`).
   - `content-script.ts` runs in the **ISOLATED** world and bridges `window.postMessage` ↔ `chrome.runtime`.
3. Your page loads, runs, and initializes the LD SDK with the bridge plugin in `plugins`.
4. The SDK calls `bridge.register(client)`. The plugin sees `window.__LD_DEVTOOLS_HOOK__`, announces itself via `hook.onSdkReady(...)` (which postMessages out to the ISOLATED content script → background SW), and subscribes to override commands via `hook.subscribeToOverrides(...)`.
5. The background SW now knows the tab has an active SDK.

**Setting an override from the DevTools panel:**

1. User types a flag key + value in the panel and clicks Add.
2. Panel sends `{ type: "set-overrides", overrides: { ... } }` over its `chrome.runtime.Port` to the background SW.
3. Background SW forwards via `chrome.tabs.sendMessage(tabId, msg)` to the ISOLATED content script.
4. ISOLATED content script rebroadcasts to MAIN world via `window.postMessage`.
5. MAIN-world hook fans out to subscribed listeners (i.e., the bridge plugin).
6. Bridge plugin calls `debugOverride.setOverride(flagKey, value)` on the SDK.
7. Next `variation()` call returns the override.

No localStorage write anywhere on the page side. The override survives until the bridge plugin is cleared, the page reloads, or the override is removed. (Persistence across reloads — re-sending the saved overrides from `chrome.storage.local` after page reload — is on the roadmap.)

## Project structure

```
ld-toolbar-extension/
├── README.md
├── PLAN.md                                    Architecture + roadmap (deep dive)
├── CLAUDE.md                                  Notes for AI-assisted development
├── LICENSE                                    Apache 2.0
├── package.json                               pnpm workspace root
├── pnpm-workspace.yaml
└── packages/
    ├── bridge-plugin/                         npm package: @launchdarkly/toolbar-extension-bridge
    │   ├── src/index.ts                       LDPlugin implementation
    │   ├── tsup.config.ts                     ESM + CJS + .d.ts output
    │   └── package.json
    └── extension/                             Chrome extension (MV3)
        ├── manifest.config.ts                 crxjs manifest (typed)
        ├── src/
        │   ├── injected.ts                    MAIN-world script: sets the hook
        │   ├── content-script.ts              ISOLATED-world script: postMessage ↔ runtime bridge
        │   ├── background.ts                  Service worker: tab registry + RPC
        │   └── devtools/
        │       ├── devtools.html              Hidden DevTools entry point
        │       ├── devtools.ts                Calls chrome.devtools.panels.create
        │       ├── panel.html                 The visible panel iframe
        │       ├── panel.tsx                  React entry
        │       ├── PanelApp.tsx               Panel UI
        │       ├── usePanelRpc.ts             Port-based RPC hook
        │       └── panel.css
        ├── vite.config.ts
        └── package.json
```

## Development

### Prerequisites

- Node.js 20+ (works on 23+)
- pnpm 10+ — the repo pins `pnpm@10.14.0` via `packageManager` in `package.json`. Use `corepack pnpm <cmd>` to avoid global installs.
- Chrome (or any Chromium browser supporting Manifest V3)

### Setup

```bash
corepack pnpm install
```

### Build

Bridge plugin only:

```bash
corepack pnpm --filter @launchdarkly/toolbar-extension-bridge run build
```

Extension only:

```bash
corepack pnpm --filter ./packages/extension run build
```

Everything:

```bash
corepack pnpm -r build
```

### Watch mode

The bridge plugin supports watch mode via `tsup`:

```bash
corepack pnpm --filter @launchdarkly/toolbar-extension-bridge run dev
```

The extension uses Vite, which can also watch:

```bash
corepack pnpm --filter ./packages/extension run dev
```

After rebuilds, you'll need to hit the reload button (↻) on the extension in `chrome://extensions/` to pick up changes. Then **close and reopen DevTools** for the panel to update.

### Local-link the bridge plugin into a host app

While iterating, point your app's `package.json` at the local source instead of an npm install:

```json
{
  "dependencies": {
    "@launchdarkly/toolbar-extension-bridge": "file:../path/to/ld-toolbar-extension/packages/bridge-plugin"
  }
}
```

Run `npm install` (or your equivalent) in the host app. After rebuilding the bridge plugin, the host app picks up the new `dist/` automatically.

## Roadmap

What's intentionally **not** in v0, in rough priority order:

- **Per-context overrides.** Maintain different override sets for different LD contexts (currently per-origin only).
- **Per-context overrides.** Maintain different override sets for different LD contexts.
- **Chrome Web Store / Edge Add-ons / Firefox.** Currently sideload-only.
- **Browser action popup** (not just DevTools panel).
- **Event interception view** (parity with the official toolbar's event log).

If you need any of these and want to contribute, open an issue first to discuss the approach.

## For AI assistants / Claude integration

If you're feeding this README to Claude (or another assistant) to help set up the integration in a specific codebase, here's what it needs to know:

- **The integration point is the LD SDK's `plugins` array.** Find where `launchdarkly-*-client-sdk` is initialized (look for `initialize`, `asyncWithLDProvider`, `LDProvider`, `useLDClient`, or imports from `launchdarkly-*-client-sdk`).
- **Add the bridge plugin to that array.** Import `ExtensionBridgePlugin` from `@launchdarkly/toolbar-extension-bridge`, instantiate once, pass it in the SDK options as `{ plugins: [bridge] }`.
- **Don't remove other plugins.** If `@launchdarkly/toolbar`'s `FlagOverridePlugin` or `EventInterceptionPlugin` is already there, keep them. The bridge plugin coexists.
- **No localStorage anywhere.** If your task is to make an existing flag-override pattern compliant with a no-`localStorage` policy, the bridge plugin is the answer. Replace any localStorage-backed override logic; do not add new localStorage writes.
- **The Chrome extension must be installed separately** by the developer. It is not a code dependency — it's a browser tool. Tell the user to follow the [Install the Chrome extension](#1-install-the-chrome-extension-unpacked) section to load it unpacked.
- **For Playwright/Cypress tests, drive overrides directly via the programmatic API** (`bridge.setOverride('flag', value)`). The extension is not required for tests — only the bridge plugin needs to be in the SDK config.

A minimal integration diff in a React app looks like this:

```diff
 import { asyncWithLDProvider } from "launchdarkly-react-client-sdk";
+import { ExtensionBridgePlugin } from "@launchdarkly/toolbar-extension-bridge";

+const bridge = new ExtensionBridgePlugin();
+
 const LDProvider = await asyncWithLDProvider({
   clientSideID: clientSideId,
   context: loggedOutContext,
   options: {
     evaluationReasons: true,
+    plugins: [bridge],
   },
 });
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
