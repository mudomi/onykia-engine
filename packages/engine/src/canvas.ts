import type { Core, RenderResult } from './index.js';

const RGBA_BYTES_PER_PIXEL = 4;

export interface RenderToCanvasOptions {
  index: number;
  zoom: number;
  canvas: HTMLCanvasElement;
}

export async function renderToCanvas(core: Core, options: RenderToCanvasOptions): Promise<void> {
  const result = await core.render(options.index, options.zoom);
  paint(options.canvas, result);
}

export function paint(canvas: HTMLCanvasElement, result: RenderResult): void {
  const height = result.data.length / RGBA_BYTES_PER_PIXEL / result.width;

  canvas.width = result.width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  // Copy into a fresh ArrayBuffer-backed view: ImageData rejects
  // SharedArrayBuffer-backed pixmap data that the worker may return.
  const pixels = new Uint8ClampedArray(result.data);
  ctx.putImageData(new ImageData(pixels, result.width, height), 0, 0);
}
