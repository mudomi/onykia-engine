import type { WasmFactory } from './types.js';

/**
 * Default `WasmFactory` that resolves the bundled wasm + worker
 * relative to this package. Works under any bundler that supports the
 * `new URL(..., import.meta.url)` pattern (Vite, webpack 5, Rollup,
 * esbuild, Parcel).
 *
 * Consumers who serve the assets from a custom location should
 * construct their own `WasmFactory` instead — see `WasmFactory` in
 * `./types.js`.
 */
export function defaultWasmFactory(): WasmFactory {
  return {
    wasmUrl: new URL('./wasm/onykia_engine.wasm', import.meta.url).href,
    worker: () =>
      new Worker(new URL('./wasm/onykia_worker.js', import.meta.url), {
        type: 'module',
      }),
  };
}
