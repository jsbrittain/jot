# Third-party software

## Frontend (vendored at build time)

| Package | Version | License | Use |
| --- | --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 18.2.1 | MIT | Markdown parsing |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.18 | Apache-2.0 | HTML sanitizing |

`pnpm build:ui` copies `marked/lib/marked.umd.js` and
`dompurify/dist/purify.min.js` into `ui/vendor/`, together with their license
files. `ui/vendor/` is generated and not committed.

Images are stripped from rendered Markdown; no remote resources are loaded.

## Rust

| Crate | Version | License | Use |
| --- | --- | --- | --- |
| [opener](https://crates.io/crates/opener) | 0.9 | MIT OR Apache-2.0 | Open validated links with the OS |
| [url](https://crates.io/crates/url) | 2 | MIT OR Apache-2.0 | Parse and validate link schemes |

The rest of the Rust dependency tree is pinned in `src-tauri/Cargo.lock`.
