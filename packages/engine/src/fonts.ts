import type { FontStub } from './types.js';

/** Written by `tools/export-fonts` next to the font files during the wasm build. */
const MANIFEST = 'fonts.json';

interface ManifestEntry extends Omit<FontStub, 'key' | 'bundled'> {
  file: string;
}

export interface BundledFonts {
  /** Pass to `Core.addFontStubs` so the faces are listed immediately and fetched on first use. */
  stubs: FontStub[];
  /** Loader for `CoreOptions.font`; the stub key is the file name under `baseUrl`. */
  load: (key: string) => Promise<Uint8Array>;
}

/**
 * typst's default font set (Libertinus Serif, New Computer Modern, DejaVu Sans
 * Mono), shipped as separate files rather than inside the wasm so only the
 * faces a document uses are downloaded. `baseUrl` is the directory holding
 * `fonts.json` and the font files. A host that serves its own fonts too should
 * dispatch on the key before falling back to `load`.
 */
export async function bundledFonts(
  baseUrl: string = new URL('./wasm/fonts/', import.meta.url).href,
): Promise<BundledFonts> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const entries = (await fetchOk(`${base}${MANIFEST}`).then(res => res.json())) as ManifestEntry[];

  return {
    stubs: entries.map(({ file, ...variant }) => ({ ...variant, key: file, bundled: true })),
    load: async key => {
      const res = await fetchOk(`${base}${key}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`onykia-engine: fetch failed: ${url} (${res.status})`);
  return res;
}
