# ld-toolbar-extension — Claude working notes

Chrome-extension version of the LaunchDarkly Dev Toolbar. **Completely independent** of the existing `@launchdarkly/toolbar` package — does not depend on it, does not extend it. Goals:

1. No localStorage / sessionStorage / cookies in the host app (CDW constraint).
2. No LaunchDarkly login required.
3. No floating UI in the host app — UI lives in the Chrome extension (DevTools panel).

See `PLAN.md` for full architecture and decisions.

## Workspace layout

pnpm workspace. `packageManager: pnpm@10.14.0` is pinned. Use `corepack pnpm <cmd>` (a global `pnpm` install fails with EACCES on `/usr/local/bin` on this machine).

```
ld-toolbar-extension/
├── PLAN.md
├── CLAUDE.md                                   ← this file
├── LICENSE                                     (Apache 2.0)
├── package.json                                (workspace root)
├── pnpm-workspace.yaml
└── packages/
    ├── bridge-plugin/                          ✅ DONE for v0 slice
    │   ├── src/index.ts                        (the SDK plugin)
    │   ├── dist/                               (tsup output: esm + cjs + dts)
    │   ├── package.json                        @launchdarkly/toolbar-extension-bridge
    │   ├── tsconfig.json
    │   └── tsup.config.ts
    └── extension/                              ⏳ not started yet
```

## What's done (v0 slice)

- `@launchdarkly/toolbar-extension-bridge` package implemented in `packages/bridge-plugin/src/index.ts`.
- Implements the LD SDK `LDPlugin` interface (`getMetadata`, `getHooks`, `register`, `registerDebug`).
- Holds overrides in an in-memory `Map<string, LDFlagValue>`. **No localStorage anywhere.**
- Applies overrides via `LDDebugOverride.setOverride()` — the same sanctioned SDK hook the official `FlagOverridePlugin` uses.
- Programmatic API: `setOverride(key, value)`, `removeOverride(key)`, `clearAllOverrides()`, `getAllOverrides()`, `getClient()`.
- Queues overrides set before `registerDebug()` fires and replays them when the debug interface becomes available.
- Detects the (future) extension via `window.__LD_DEVTOOLS_HOOK__` and logs presence. No transport wired yet.
- For ad-hoc testing, exposes itself on `window.__ldBridge` (toggleable via constructor option `exposeOnWindow`).

Wired into `~/Documents/kathy/demos/weather-demo` via a `file:` dep alongside the existing toolbar plugins. Both work independently — the bridge does not depend on `@launchdarkly/toolbar`.

## How to test the slice manually

1. Make sure `weather-demo` dev server is running (`npm run dev` from that dir).
2. Open the app in the browser. Load the SDK (paste a client-side ID if the app prompts for one).
3. Open DevTools console. The bridge is on `window.__ldBridge`.
4. Call `window.__ldBridge.setOverride('<some-flag-key>', true)` — the flag value seen by the React app should flip immediately without writing anything to `localStorage`.
5. `window.__ldBridge.clearAllOverrides()` reverts.

Verify no localStorage writes: in DevTools → Application → Local Storage. The bridge plugin should write nothing. (The existing FlagOverridePlugin still works alongside, so don't be confused if you see `ld-flag-override:*` keys from a previous toolbar UI session.)

## Build commands (from `packages/bridge-plugin/`)

```bash
corepack pnpm run build      # one-shot: tsup → dist/ (esm + cjs + dts)
corepack pnpm run dev        # watch mode
corepack pnpm run typecheck  # tsc --noEmit
```

After rebuilding, Vite picks up the new dist files automatically via the symlinked `node_modules/@launchdarkly/toolbar-extension-bridge` in weather-demo.

## What's next (per PLAN.md, in order)

2. **Hook shim + content script.** MV3 manifest, content script at `document_start`, injects `window.__LD_DEVTOOLS_HOOK__`. Bridge plugin detects it, dispatches `sdk-ready` CustomEvent.
3. **Background service worker + port-based RPC.** Tab registry, port plumbing.
4. **DevTools panel UI.** Flat list of flags from `flags-snapshot`. Override inputs.
5. **Persistence via `chrome.storage.local`** (per-origin scope).
6. **End-to-end smoke** in weather-demo.

## Reference material (open while coding)

- `~/Documents/kathy/launchdarkly-toolbar/packages/toolbar/src/types/plugins/flagOverridePlugin.ts` — canonical plugin shape
- `~/Documents/kathy/launchdarkly-toolbar/packages/toolbar/src/types/plugins/plugins.ts` — `IFlagOverridePlugin` / `LDPlugin` interfaces
- React DevTools (`facebook/react`, `packages/react-devtools-extensions/`) — for the document_start global-injection pattern we're adopting
