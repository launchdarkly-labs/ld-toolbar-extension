import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        // Keep generated filenames stable across builds so the extension dir
        // doesn't churn between rebuilds when loaded unpacked.
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
});
