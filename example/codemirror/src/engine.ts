import {
  Core,
  createWasmFactory,
  indexedDbCache,
  withCache,
} from '@mudomi/onykia-engine';

const PACKAGES_BASE = 'https://packages.typst.org';

export async function createEngine(): Promise<Core> {
  const wasm = createWasmFactory({
    wasmUrl: '/assets/onykia_engine.wasm',
    workerUrl: '/assets/onykia_worker.js',
  });

  const cache = indexedDbCache();
  const fetchPackage = withCache(
    fetchTarball,
    cache,
    (namespace, name, version) => `pkg:${namespace}/${name}-${version}`,
  );

  const core = new Core({
    wasm,
    package: fetchPackage,
  });

  // Forward the public preview index so autocomplete and version-resolution
  // see what packages exist. Failure is non-fatal - imports still resolve via
  // the per-tarball ask path; only the IDE catalog goes dark.
  void loadPreviewIndex(core).catch(err =>
    console.warn('[onykia] preview index fetch failed:', err),
  );

  return core;
}

async function fetchTarball(
  namespace: string,
  name: string,
  version: string,
): Promise<Uint8Array> {
  const url = `${PACKAGES_BASE}/${namespace}/${name}-${version}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`package fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadPreviewIndex(core: Core): Promise<void> {
  const res = await fetch(`${PACKAGES_BASE}/preview/index.json`);
  if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await core.setRemotePackages(bytes, []);
}
