import { Core, createWasmFactory } from '@mudomi/onykia-engine';

export async function createEngine(): Promise<Core> {
  const wasm = createWasmFactory({
    wasmUrl: '/assets/onykia_engine.wasm',
    workerUrl: '/assets/onykia_worker.js',
  });
  return new Core({
    wasm,
    package: async (namespace, name, version) => {
      const url = `https://packages.typst.org/${namespace}/${name}-${version}.tar.gz`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`package fetch failed: ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    spellcheck: async () => true,
  });
}
