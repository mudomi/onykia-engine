# onykia-engine

Typst compiled to WebAssembly with nice bindings.

## Packages

| npm | what |
|-----|------|
| [`@mudomi/onykia-engine`](packages/engine)         | TS client: worker pool, message bus, IDE-feature API. |
| [`@mudomi/onykia-codemirror`](packages/codemirror) | CodeMirror 6 bindings: highlight, autocomplete, hover, definition, diagnostics. |
| [`@mudomi/onykia-monaco`](packages/monaco)         | Monaco binding: edit forwarding + diagnostics. |

## Prerequisites

- **Rust nightly** - pinned in `rust-toolchain.toml`. Install with
  `rustup toolchain install nightly --component rust-src`.
- **wasm-bindgen-cli** - version-matched to the `wasm-bindgen` crate in
  `src/rust/Cargo.toml`. Install with `cargo install wasm-bindgen-cli --version <x>`.
- **Node.js 20+** and **npm 10+**.

## Try it

```bash
npm install
npm run build:wasm
npm run example:codemirror   # or example:monaco
```

## Known gaps

- **Outline** notifications are stubbed. Walking `PagedDocument` for headings
  is straightforward but not yet wired up.
- **HTML export** and **archive()** are stubbed.
- **Font index** decoder only accepts JSON today.
- **Spellcheck** is delegated to JS; no built-in hunspell.
- **Monaco binding** ships only edits + diagnostics - no syntax highlight,
  autocomplete, hover, or definition yet.

## More

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) - branch flow, PRs, releases.
