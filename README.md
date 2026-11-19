# Snippets

A page-first scratchpad. Write freely, then select a phrase and pin it to a project.
Pinned snippets become a board of current items: tick them, reorder them, unpin them.
Everything ever pinned stays searchable in the archive.

The page is the uncommitted remainder of your thinking. The board is the current
working set. The archive is the record.

## Requirements

- Rust (stable) — https://rustup.rs
- Node.js 20+ and pnpm
- **macOS:** Xcode command line tools
- **Linux:** `webkit2gtk-4.1` development packages (see Tauri prerequisites)
- **Windows:** WebView2 and the MSVC build tools

## Develop

```sh
pnpm install
pnpm dev          # compiles TypeScript, then launches the app
pnpm test         # Rust unit tests (in-memory SQLite)
```

TypeScript is compiled by `tsc`; there is no bundler and no dev server. `pnpm dev`
compiles once at startup, so run `pnpm watch` in a second terminal while editing
the UI and reload the window (`Cmd/Ctrl+R`).

If `cargo` is not found: `source "$HOME/.cargo/env"` or open a new terminal.

## Build

```sh
pnpm build        # platform installer/bundle in src-tauri/target/release/bundle
```

## Using it

| Action | Key |
| --- | --- |
| Pin the selection (or current paragraph) | `Cmd/Ctrl+Enter` |
| Toggle the board | `Cmd/Ctrl+B` |
| Search the archive | `Cmd/Ctrl+F` |
| New page | `Cmd/Ctrl+N` |
| Page picker | `Cmd/Ctrl+P` |
| Undo the last pin/unpin/delete (while the toast is visible) | `Cmd/Ctrl+Z` |
| Close an overlay, or hide the window | `Esc` |
| Summon the window from another app | `Cmd/Ctrl+Shift+J` |

- Select text and press `Cmd/Ctrl+Enter`: a bar appears with the target project
  preselected. `Enter` pins, typing filters projects, `Esc` cancels.
- Pinning **cuts** the text out of the page. It appears at the top of the board
  with a timestamp. `Cmd/Ctrl+Z`, or Undo in the toast, restores it exactly.
- The page autosaves. There is no save button and no unsaved-state dialog.
- Tick a snippet to move it to the collapsed **Done** shelf. Unpin it to remove it
  from the board without deleting it; it remains in the archive.
- Drag a card by its handle, or focus it and use `Cmd/Ctrl+Up/Down`.
- Projects are flat labels. A snippet can have one, or none — that is Inbox.
  Deleting a project keeps its snippets and makes them unlabelled.
- `Cmd/Ctrl+F` opens the archive: case-insensitive search over snippet text,
  project filter, include-done toggle, and project management.
- Pages are rolling and disposable. `Cmd/Ctrl+N` archives the current page if it
  has content. `Cmd/Ctrl+P` opens an archived page and archives the current one
  in exchange.

## Data

One SQLite database in the platform application data directory:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/dev.jsb.snippets/snippets.db` |
| Windows | `%APPDATA%\dev.jsb.snippets\snippets.db` |
| Linux | `~/.local/share/dev.jsb.snippets/snippets.db` |

Timestamps are stored as RFC 3339 UTC and rendered in local time. Snippets are
plain text (Markdown-friendly, not rendered). Because the database runs in WAL
mode, back up the whole directory rather than only `snippets.db`.

Deletes are soft: the row is retained with a `deleted_at` timestamp, and Undo
restores it. There is no Trash view yet.

## Design notes

- **Tauri 2 + vanilla TypeScript + SQLite.** No frontend framework, no runtime
  npm dependencies, no HTTP server.
- **One window, two surfaces.** The page and the board share one window; the
  archive is a full-window overlay, not a second window.
- **The page is a single autosaved text blob.** Snippets are separate records.
  Keeping them as different primitives means the page stays a native textarea
  while the board can be a list of cards.
- **Commit is atomic.** Rust receives the cut page and the snippet and writes
  both in one transaction, so text cannot be lost between two calls.
- **The Rust side owns timestamps and persistence.** The frontend sends content
  and a project id, nothing else.
- **Undo is explicit.** Replacing the textarea value clears the webview's native
  undo stack, so a commit is undone through the app-level toast action.

## License

Private.
