# onykia-engine

Typst compiled to WebAssembly for the web with nice bindings for IDEs and more.

Read the docs on [docs.onykia.eu](https://docs.onykia.eu/engine/).

Used in [`onykia-editor`](https://github.com/mudomi/onykia-editor) and [`onykia-app`](https://github.com/mudomi/onykia-app).

## Packages

| npm | what |
|-----|------|
| [`@mudomi/onykia-engine`](https://www.npmjs.com/package/@mudomi/onykia-engine)         | TS client: worker pool, message bus, IDE-feature API. |
| [`@mudomi/onykia-codemirror`](https://www.npmjs.com/package/@mudomi/onykia-codemirror) | CodeMirror 6 bindings: highlight, autocomplete, hover, definition, diagnostics. |
| [`@mudomi/onykia-monaco`](https://www.npmjs.com/package/@mudomi/onykia-monaco)         | Monaco binding: edit forwarding + diagnostics. |

## Prerequisites

- **Rust nightly**
- **wasm-bindgen-cli** - version-matched to the `wasm-bindgen` crate in
  `src/rust/Cargo.toml`.
- **Node.js 20+** and **npm 10+**.

## Try it

```bash
npm install
npm run build:wasm
npm run example:codemirror   # or example:monaco
```

## Cross-origin isolation

Loading onykia-engine requires a cross-origin-isolated host
page, serve it with:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers `createWasmFactory()` throws synchronously with a
message pointing at this section. See [SharedArrayBuffer requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer).

## Fonts

typst's default fonts are shipped as files next to the wasm and fetched on
demand instead of being embedded, so a host has to register them:

```ts
const fonts = await bundledFonts();            // reads dist/wasm/fonts/fonts.json
const core = new Core({ wasm, font: fonts.load });
await core.addFontStubs(fonts.stubs);
```

Pass a URL to `bundledFonts()` when the files are served from elsewhere, and
wrap `fonts.load` with `withCache()` to keep them in IndexedDB.

## More

For contributions & release flow see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

This package bundles [Typst](https://github.com/typst/typst), licensed under the Apache License 2.0. The code in this package is MIT licensed. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
