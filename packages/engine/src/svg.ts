import { syncChildren } from './dom.js';
import type { Core, PageInfo } from './index.js';

export interface RenderToSvgOptions {
  container: HTMLElement;
  pages: PageInfo[];
}

const PAGE_CLASS = 'onykia-page';
const PAGE_STYLE = ':host { display: block; } svg { display: block; width: 100%; height: auto; }';

/**
 * Render every page of the current document into `container` as one block
 * element per page (class `onykia-page`) holding the page's `<svg>` in a shadow
 * root. Pages already in `container` with an unchanged hash are kept, so an
 * edit on one page exports and swaps only that page. Size and decorate the
 * host elements from the outside; the page fills its host's width.
 */
export async function renderToSvg(core: Core, { container, pages }: RenderToSvgOptions): Promise<void> {
  const existing = Array.from(container.children);
  const decoder = new TextDecoder();

  const hosts = await Promise.all(
    pages.map(async (page, index) => {
      const prior = existing[index];
      if (prior instanceof HTMLElement && prior.classList.contains(PAGE_CLASS) && prior.dataset.hash === page.hash) {
        return prior;
      }

      const res = await core.export({ format: 'svg', index });
      return pageHost(decoder.decode(res.data), page.hash);
    }),
  );

  syncChildren(container, hosts);
}

// Each page gets its own shadow root so the glyph ids typst's SVG relies on
// (`<use href="#g...">`) resolve within that page only. In one shared scope
// every page defines the same ids, and replacing a single page makes the
// browser re-resolve every <use> on every page: about a second of style
// recalculation per keystroke on a ten-page document.
function pageHost(markup: string, hash: string): HTMLElement {
  const host = document.createElement('div');
  host.className = PAGE_CLASS;
  host.dataset.hash = hash;

  const style = document.createElement('style');
  style.textContent = PAGE_STYLE;
  host.attachShadow({ mode: 'open' }).append(style, parseSvg(markup));
  return host;
}

function parseSvg(markup: string): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGElement)) throw new Error('onykia-engine: export did not return an <svg>');
  return svg;
}
