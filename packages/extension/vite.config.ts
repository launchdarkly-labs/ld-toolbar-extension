import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2020",
    rollupOptions: {
      // The panel HTML is referenced at runtime by chrome.devtools.panels.create
      // rather than from the manifest, so it needs an explicit Vite input.
      input: {
        panel: resolve(__dirname, "src/devtools/panel.html"),
      },
      output: {
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
});
