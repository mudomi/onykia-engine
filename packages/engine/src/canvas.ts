import { syncChildren } from './dom.js';
import type { Core, PageInfo, RenderResult } from './index.js';

const RGBA_BYTES_PER_PIXEL = 4;

/**
 * Either a fixed logical zoom in CSS pixels per typst point, or a fit
 * strategy that derives zoom from the container's current size.
 */
export type CanvasZoom =
  | { zoom: number }
  | { fit: 'width' };

export interface RenderToCanvasOptions {
  container: HTMLElement;
  pages: PageInfo[];
  /** Multiplier on top of the logical zoom for hi-DPI sharpness. Defaults to `devicePixelRatio`. */
  dpr?: number;
}

/**
 * Render every page of the current document into `container` as one
 * `<canvas>` per page. Canvases already in `container` whose page hash and
 * zoom are unchanged are kept as they are, so an edit on one page only
 * re-renders that page.
 */
export async function renderToCanvas(
  core: Core,
  options: RenderToCanvasOptions & CanvasZoom,
): Promise<void> {
  const { container, pages } = options;
  const dpr = options.dpr ?? defaultDpr();
  const containerWidth = contentWidth(container);
  const existing = Array.from(container.children);

  const canvases = await Promise.all(
    pages.map(async (page, index) => {
      const zoom = logicalZoomFor(options, page, containerWidth) * dpr;
      const prior = existing[index];
      if (prior instanceof HTMLCanvasElement && prior.dataset.hash === page.hash && Number(prior.dataset.zoom) === zoom) {
        return prior;
      }

      const canvas = document.createElement('canvas');
      const result = await core.render(index, zoom);
      paint(canvas, result);
      canvas.dataset.hash = page.hash;
      canvas.dataset.zoom = String(zoom);

      // The pixmap is `dpr`x the CSS size; shrink the element so it renders
      // at logical zoom while keeping the extra pixels for sharpness.
      canvas.style.width = `${result.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
      return canvas;
    }),
  );

  syncChildren(container, canvases);
}

/** Paint a single {@link RenderResult} onto an existing canvas, sizing it to match. */
export function paint(canvas: HTMLCanvasElement, result: RenderResult): void {
  // ImageData rejects SharedArrayBuffer-backed views, so copy into a fresh
  // ArrayBuffer-backed Uint8ClampedArray before constructing it.
  const pixels = new Uint8ClampedArray(result.data);
  const height = pixels.length / RGBA_BYTES_PER_PIXEL / result.width;

  canvas.width = result.width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  ctx.putImageData(new ImageData(pixels, result.width, height), 0, 0);
}

function logicalZoomFor(zoom: CanvasZoom, page: PageInfo, containerWidth: number): number {
  if ('zoom' in zoom) return zoom.zoom;
  // page.width is in typst points; zoom is CSS pixels per point.
  return containerWidth / page.width;
}

function defaultDpr(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/** `clientWidth` minus horizontal padding - the actual room a child laid out at 100% width gets. */
function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return Math.max(el.clientWidth - padding, 0);
}
