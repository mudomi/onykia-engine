import type { WasmFactory } from './types.js';

/** Initial shared-memory pages (64 KB each). 512 → 32 MB. */
export const DEFAULT_INIT_MEMORY_PAGES = 512;
/** Maximum shared-memory pages. 16384 → 1 GB. Matches `--max-memory` in `scripts/build-wasm.sh`. */
export const DEFAULT_MAX_MEMORY_PAGES = 16_384;

const COI_ERROR =
  'onykia-engine requires a cross-origin-isolated host page. Serve it with:\n' +
  '  Cross-Origin-Opener-Policy:   same-origin\n' +
  '  Cross-Origin-Embedder-Policy: require-corp\n' +
  'See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer';

export interface WasmFactoryOptions {
  wasmUrl?: string;
  workerUrl?: string;
}

/**
 * Build a {@link WasmFactory} pointing at the threaded WASM bundle. Throws
 * synchronously when the host page is not cross-origin isolated — the engine
 * has no single-threaded fallback.
 */
export function createWasmFactory(opts: WasmFactoryOptions = {}): WasmFactory {
  assertCrossOriginIsolated();
  const wasmUrl = opts.wasmUrl ?? new URL('./wasm/onykia_engine.wasm', import.meta.url).href;
  const workerUrl = opts.workerUrl ?? new URL('./wasm/onykia_worker.js', import.meta.url).href;
  return {
    wasmUrl,
    worker: () => new Worker(workerUrl, { type: 'module' }),
  };
}

/** Throws with a header-setup hint when `crossOriginIsolated` or `SharedArrayBuffer` are missing. */
export function assertCrossOriginIsolated(): void {
  const ok =
    typeof self !== 'undefined' &&
    self.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined';
  if (!ok) throw new Error(COI_ERROR);
}
