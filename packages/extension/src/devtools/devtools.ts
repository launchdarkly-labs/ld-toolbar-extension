/**
 * DevTools-page entry. Runs once per DevTools window, in a hidden page.
 * Its only job is to register our panel with chrome.devtools.panels —
 * the panel itself is a separate HTML/JS bundle (panel.html / panel.tsx).
 */

chrome.devtools.panels.create(
  "LaunchDarkly",
  "", // icon path — none for v0
  "src/devtools/panel.html",
);
