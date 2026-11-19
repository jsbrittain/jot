# UI tests

`pnpm test:ui` compiles the frontend and runs `tests/ui/run.mjs` with Playwright.

- It serves the real `ui/` directory over localhost with the app's CSP header.
- It injects a mock Tauri bridge (`core.invoke` + `event.listen`) before the app
  module loads, so the real typescript and DOM code runs without the desktop shell.
- It covers the page/board/archive flow, commit and undo, return-to-page, the
  resizable splitter, independent scrolling, Markdown rendering, external-link
  dispatch, sanitizing, Read mode, and the project picker.
- Screenshots are written to `/tmp/snippets-ui-*.png`.

Install the browser once:

```sh
pnpm exec playwright install chromium
```

This is not a native WKWebView test. The OS-level link opener and desktop window
behaviour are verified manually.
