// Test-only, never shipped. It does nothing on its own: the web e2e calls chrome.tabs.setZoom through this service
// worker (Playwright's serviceWorker.evaluate, tests/browserZoom.ts) to set a tab's real browser zoom.
