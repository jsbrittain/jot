# Jot

[![CI](https://github.com/jsbrittain/jot/actions/workflows/ci.yml/badge.svg)](https://github.com/jsbrittain/jot/actions/workflows/ci.yml)

A small desktop scratchpad for short notes attached to projects. Open it, type a
few sentences, hit `Cmd/Ctrl+S`, and get back to work.

Stage 1: quick capture only. Browsing, search, tags and export are Stage 2+.

## Requirements

- Rust (stable) — https://rustup.rs
- Node.js 20+ and pnpm
- **macOS:** Xcode command line tools
- **Linux:** `webkit2gtk-4.1` development packages (see Tauri prerequisites)
- **Windows:** WebView2 (preinstalled on Windows 10/11) and the MSVC build tools

## Develop

```sh
pnpm install
pnpm dev          # compiles TypeScript, then launches the app
pnpm test         # Rust unit tests (in-memory SQLite)
```

If `cargo` is not found, the shell has not picked up a fresh Rust install yet:
`source "$HOME/.cargo/env"` (or open a new terminal).

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- **Lint and test** (Ubuntu): `tsc`, `cargo fmt --check`, `cargo clippy -D warnings`
  and `cargo test`.
- **Build** (macOS, Ubuntu, Windows): `tauri build --no-bundle`. This is mostly to
  compile the platform-specific paths — the tray icon is Windows/Linux-only and the
  window handling differs on macOS — which a single-OS local build never checks.

TypeScript is compiled by `tsc`; there is no bundler and no dev server. `pnpm dev`
compiles once at startup, so run `pnpm watch` in a second terminal while editing
the UI and reload the window (`Cmd/Ctrl+R`) to pick up changes.

## Build

```sh
pnpm build        # platform installer/bundle in src-tauri/target/release/bundle
```

## Using it

| Action | Key |
| --- | --- |
| Summon the capture window (from any app) | `Cmd/Ctrl+Shift+J` |
| Save note and hide window | `Cmd/Ctrl+S` |
| Close the capture window | `Cmd/Ctrl+W` |
| Hide window (when clean) | `Esc` |
| Browse notes | `Cmd/Ctrl+B` |
| Quit | `Cmd/Ctrl+Q`, the Dock icon menu (macOS) or the tray menu (Windows/Linux) |

- Launching Jot starts silently: no window. Summon it with `Cmd/Ctrl+Shift+J`,
  click the Dock icon (macOS), or launch the app again.
- The window close button hides the capture window; it does not quit. Quit is
  deliberately out of the way.
- The project selector remembers the last project you saved a note to.
- `+` next to the selector creates a project inline. `Enter` commits, `Esc` cancels.
- A first run seeds an `Inbox` project, so you can capture something immediately.
- Saving hides the window but keeps the process resident, so the next capture is
  immediate. Relaunching the app focuses the existing window.
- `Cmd/Ctrl+Shift+J` summons the window from any app. It uses the platform hotkey
  API (Carbon on macOS), so it needs no Accessibility permission — but it only
  works while Jot is running, which it is from your first launch until you quit.
- Closing with unsaved text asks before discarding it, and quitting with a draft
  brings the window back rather than prompting somewhere invisible.

## Browsing

`Cmd/Ctrl+B` opens a second window: a newest-first list on the left, the selected
note on the right.

- Filter the list by project; `All projects` is the default.
- Type in the search box to match note content case-insensitively. It combines
  with the project filter. `Cmd/Ctrl+F` focuses it, `Esc` clears it.
- Arrow keys move through the list, `Enter` opens a note for editing.
- `Cmd/Ctrl+S` saves an edit, `Esc` reverts it, `Esc` again closes the window.
- `Cmd/Ctrl+W` also closes the window, asking first if an edit is unsaved.
- `Delete` asks once, then removes the note.
- The project selector above the note reassigns it. Moving doesn't change the
  created or edited time — it isn't a content edit.
- `+` next to the project filter creates a project inline. The filter stays where
  it is, so the note you are reassigning doesn't vanish from view.
- `−` next to the project filter deletes a project. Its notes are moved to
  `Inbox`, never discarded, and `Inbox` itself can't be deleted.
- Created and last-edited times are shown in local time; the stored values are UTC
  and never enter an editable field.

The browse window is created on demand and closed when you are done, so it costs
nothing at startup. Opening it hides the capture window, unless the capture window
holds an unsaved draft — hiding that would discard it on the next summon.

## Startup

Launching Jot shows no window. It starts resident and waits to be summoned, so
there is nothing to dismiss and no focus stolen. Debug builds are the exception:
`pnpm dev` shows the window so the development loop still works.

Measured on macOS 26 (arm64), release build, five warm launches:

| Measurement | Result |
| --- | --- |
| Cold first launch, process → frontend ready | 2.2 s |
| Warm launch, process → frontend ready | 600–700 ms |
| Summoning the window while resident | one native show/focus, no process start |
| Release binary / `.app` bundle | 4.1 MB / 4.4 MiB |

A hidden webview does not paint, so the `ui load -> painted` line only appears in
debug builds.

Debug builds always print these numbers; release builds print them when
`JOT_TIMING=1` is set:

```sh
JOT_TIMING=1 ./src-tauri/target/release/jot
# [jot] frontend ready in 637ms
```

Nearly all of that is macOS starting WebKit, not our code, so there is little left
to optimise. It is paid once per session because the process stays resident.

## Data

One SQLite database in the platform application data directory:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/dev.jsb.jot/jot.db` |
| Windows | `%APPDATA%\dev.jsb.jot\jot.db` |
| Linux | `~/.local/share/dev.jsb.jot/jot.db` |

Timestamps are stored as RFC 3339 UTC and rendered in local time. Note content is
plain text (Markdown-friendly, not rendered yet). Because the database runs in WAL
mode, back up the whole directory rather than only `jot.db`.

## Design notes

- **Tauri 2 + vanilla TypeScript + SQLite.** No frontend framework, no runtime npm
  dependencies, no HTTP server. The webview loads static files over Tauri's custom
  protocol.
- **SQLite is compiled into the binary** (`rusqlite/bundled`), so there is no
  system SQLite dependency and no version skew across platforms.
- **Schema migrations** are numbered SQL strings keyed by `PRAGMA user_version`;
  applying them is a single integer check at startup.
- **The Rust side owns timestamps and persistence.** The frontend sends content and
  a project id, nothing else.
- **Dirty state crosses the IPC boundary only on transitions**, not on every
  keystroke; the close guard is enforced in Rust so it covers `Cmd+Q`, the close
  button and window manager shortcuts alike.
- **Two windows, one process.** The capture window is created at startup and
  hidden rather than destroyed. The browse window is created on demand and closed
  normally, so it adds nothing to launch time.
- **Quit is a deliberate act.** Only `Cmd+Q`, the macOS Dock menu and the
  Windows/Linux tray menu exit; everything else hides. On macOS no tray icon is
  created because the Dock menu already provides Quit.
