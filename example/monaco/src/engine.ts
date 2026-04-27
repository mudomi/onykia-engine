import { Core } from '@mudomi/onykia-engine';

// WASM + worker are produced by scripts/build-wasm.sh into example/public/assets.
const WASM_URL = '/assets/onykia_engine.wasm';
const WORKER_URL = '/assets/onykia_worker.js';

export function createEngine(): Core {
  return new Core({
    wasm: {
      wasmUrl: WASM_URL,
      worker: () => new Worker(WORKER_URL, { type: 'module' }),
    },
    package: async (namespace, name, version) => {
      const url = `https://packages.typst.org/${namespace}/${name}-${version}.tar.gz`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`package fetch failed: ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    spellcheck: async () => true,
  });
}
