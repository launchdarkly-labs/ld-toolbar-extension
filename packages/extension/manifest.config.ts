import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "LaunchDarkly Toolbar Extension",
  version: pkg.version,
  description:
    "Drives LaunchDarkly flag overrides in dev/staging/prod without localStorage, login, or in-page UI.",
  permissions: ["storage"],
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  devtools_page: "src/devtools/devtools.html",
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/injected.ts"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["<all_urls>"],
      js: ["src/content-script.ts"],
      run_at: "document_start",
    },
  ],
});
