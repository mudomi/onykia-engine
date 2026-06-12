import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import { applyDiagnostics, typstExtensions } from '@mudomi/onykia-codemirror';
import { renderToCanvas, type OutlineEntry, type PageInfo } from '@mudomi/onykia-engine';
import { createEngine } from './engine.js';

const PATH = '/main.typ';
const INITIAL = `= Hello, Onykia x CodeMirror
$ integral_0^1 x^2 dif x = 1/3 $

#pagebreak()

= Page two
A second page so multi-page rendering is visible.
`;

type PreviewFormat = 'svg' | 'canvas' | 'html';
type ExportFormat = 'pdf' | 'svg' | 'png';

const editorEl = byId('editor');
const previewEl = byId('preview');
const outlineEl = byId('outline');
const outlineToggle = byId<HTMLButtonElement>('outline-toggle');
const previewSelect = byId<HTMLSelectElement>('preview-format');
const exportFormatSelect = byId<HTMLSelectElement>('export-format');
const exportPageSelect = byId<HTMLSelectElement>('export-page');
const exportPageLabel = byId('export-page-label');
const exportButton = byId<HTMLButtonElement>('export-button');

const core = await createEngine();
await core.create(PATH, 'text/x-typst', INITIAL);

const { extensions } = await typstExtensions(core, PATH);
const view = new EditorView({
  parent: editorEl,
  state: EditorState.create({
    doc: INITIAL,
    extensions: [
      lineNumbers(),
      history(),
      lintGutter(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      ...extensions,
    ],
  }),
});

let pages: PageInfo[] = [];

core.onDiagnostics(({ diagnostics }) => applyDiagnostics(view, diagnostics, PATH));
core.onPages(({ pages: next }) => {
  pages = next;
  syncExportControls();
  if (pages.length > 0) void refreshPreview();
});
core.onOutline(({ entries }) => renderOutline(entries));

outlineToggle.addEventListener('click', () => {
  outlineEl.hidden = !outlineEl.hidden;
  outlineToggle.setAttribute('aria-expanded', String(!outlineEl.hidden));
});

previewSelect.addEventListener('change', () => {
  if (pages.length > 0) void refreshPreview();
});
exportFormatSelect.addEventListener('change', syncExportControls);
exportButton.addEventListener('click', () => void downloadExport());

// The canvas renderer takes its zoom from the container's current width, so
// re-render whenever the preview pane resizes. Coalesce to one re-render per
// frame; ResizeObserver can fire many times during a window drag.
let resizeRaf = 0;
new ResizeObserver(() => {
  if (resizeRaf !== 0) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (previewSelect.value === 'canvas' && pages.length > 0) void renderCanvasPreview();
  });
}).observe(previewEl);

await core.setMain(PATH);
await core.setTarget('svg');

//  preview 

async function refreshPreview(): Promise<void> {
  const format = previewSelect.value as PreviewFormat;
  switch (format) {
    case 'canvas': return renderCanvasPreview();
    case 'html':   return renderHtmlPreview();
    case 'svg':    return renderSvgPreview();
  }
}

async function renderSvgPreview(): Promise<void> {
  const decoder = new TextDecoder();
  const svgs = await Promise.all(
    pages.map(async (_, index) => {
      const res = await core.export({ format: 'svg', index });
      return decoder.decode(res.data);
    }),
  );
  previewEl.innerHTML = svgs.join('\n');
}

async function renderCanvasPreview(): Promise<void> {
  await renderToCanvas(core, { container: previewEl, pages, fit: 'width' });
}

async function renderHtmlPreview(): Promise<void> {
  const res = await core.export({ format: 'html' });

  const iframe = document.createElement('iframe');
  iframe.srcdoc = new TextDecoder().decode(res.data);
  previewEl.replaceChildren(iframe);
}

//  outline

function renderOutline(entries: OutlineEntry[]): void {
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No headings';
    outlineEl.replaceChildren(empty);
    return;
  }
  outlineEl.replaceChildren(outlineList(entries));
}

function outlineList(entries: OutlineEntry[]): HTMLUListElement {
  const list = document.createElement('ul');
  for (const entry of entries) {
    const item = document.createElement('li');
    const jump = document.createElement('button');
    jump.textContent = entry.title || '(untitled)';
    jump.addEventListener('click', () => scrollToPage(entry.position.page));
    item.append(jump);
    if (entry.children) item.append(outlineList(entry.children));
    list.append(item);
  }
  return list;
}

function scrollToPage(page: number): void {
  // SVG and canvas previews render one element per page; the HTML preview is
  // a single iframe, where there is no per-page element to scroll to.
  const pageEls = previewEl.querySelectorAll(':scope > svg, :scope > canvas');
  pageEls[page]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

//  export

function syncExportControls(): void {
  const format = exportFormatSelect.value as ExportFormat;
  const needsPage = format !== 'pdf';

  exportPageSelect.hidden = !needsPage;
  exportPageLabel.hidden = !needsPage;
  exportButton.disabled = pages.length === 0;

  rebuildPageOptions();
}

function rebuildPageOptions(): void {
  const previous = Number(exportPageSelect.value) || 1;
  const options = pages.map((_, i) => {
    const opt = document.createElement('option');
    opt.value = String(i + 1);
    opt.textContent = `Page ${i + 1}`;
    return opt;
  });
  exportPageSelect.replaceChildren(...options);

  const restored = Math.min(previous, pages.length) || 1;
  exportPageSelect.value = String(restored);
}

async function downloadExport(): Promise<void> {
  if (pages.length === 0) return;

  const format = exportFormatSelect.value as ExportFormat;
  const args = format === 'pdf'
    ? { format: 'pdf' as const }
    : { format, index: Number(exportPageSelect.value) - 1 };

  const res = await core.export(args);
  const suffix = format === 'pdf' ? '' : `-p${Number(exportPageSelect.value)}`;
  triggerDownload(res.data, res.mime, `onykia${suffix}.${format}`);
}

function triggerDownload(data: Uint8Array, mime: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

//  helpers 

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from DOM`);
  return el as T;
}
