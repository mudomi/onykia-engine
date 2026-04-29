# onykia-engine

Typst compiled to WebAssembly for the web with nice bindings for IDEs and more.

## Packages

| npm | what |
|-----|------|
| [`@mudomi/onykia-engine`](https://www.npmjs.com/package/@mudomi/onykia-engine)         | TS client: worker pool, message bus, IDE-feature API. |
| [`@mudomi/onykia-codemirror`](https://www.npmjs.com/package/@mudomi/onykia-codemirror) | CodeMirror 6 bindings: highlight, autocomplete, hover, definition, diagnostics. |
| [`@mudomi/onykia-monaco`](https://www.npmjs.com/package/@mudomi/onykia-monaco)         | Monaco binding: edit forwarding + diagnostics. |

## Prerequisites

- **Rust stable**
- **wasm-bindgen-cli** - version-matched to the `wasm-bindgen` crate in
  `src/rust/Cargo.toml`.
- **Node.js 20+** and **npm 10+**.

## Try it

```bash
npm install
npm run build:wasm
npm run example:codemirror   # or example:monaco
```

## Known gaps

- **Outline** notifications are stubbed.
- **HTML export** and **archive()** are stubbed.
- **Font index** decoder only accepts JSON.
- **Spellcheck** is delegated to JS; no built-in hunspell.
- **Monaco binding** supports only edits + diagnostics - no syntax highlight,
  autocomplete, hover, or definition.

## More

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) - branch flow, PRs, releases.
