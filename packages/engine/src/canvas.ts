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
 * `<canvas>` per page. Replaces any prior children of `container`.
 */
export async function renderToCanvas(
  core: Core,
  options: RenderToCanvasOptions & CanvasZoom,
): Promise<void> {
  const { container, pages } = options;
  const dpr = options.dpr ?? defaultDpr();
  const containerWidth = contentWidth(container);

  const canvases = pages.map(() => document.createElement('canvas'));
  container.replaceChildren(...canvases);

  await Promise.all(
    canvases.map(async (canvas, index) => {
      const page = pages[index];
      const logicalZoom = logicalZoomFor(options, page, containerWidth);

      const result = await core.render(index, logicalZoom * dpr);
      paint(canvas, result);

      // The pixmap is `dpr`x the CSS size; shrink the element so it renders
      // at logical zoom while keeping the extra pixels for sharpness.
      canvas.style.width = `${result.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
    }),
  );
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
