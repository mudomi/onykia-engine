import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import { applyDiagnostics, typstExtensions } from '@mudomi/onykia-codemirror';
import {
  renderToCanvas,
  type OutlineEntry,
  type PageInfo,
  type PdfStandard,
} from '@mudomi/onykia-engine';
import { createEngine } from './engine.js';

const PATH = '/main.typ';
// A title is set so PDF/A and PDF/UA exports (which require one) succeed.
const INITIAL = `#set document(title: "Onykia x CodeMirror", author: "Onykia")

= Hello, Onykia x CodeMirror
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
const previewSelect = byId<HTMLSelectElement>('preview-format');
const followCursor = byId<HTMLInputElement>('follow-cursor');
const exportFormatSelect = byId<HTMLSelectElement>('export-format');
const exportPageSelect = byId<HTMLSelectElement>('export-page');
const exportPageLabel = byId('export-page-label');
const exportStandards = byId('export-standards');
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
      // Sync the preview to the caret when "Follow cursor" is on.
      EditorView.updateListener.of((update) => {
        if (followCursor.checked && (update.selectionSet || update.docChanged)) {
          scheduleFollow();
        }
      }),
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

previewSelect.addEventListener('change', () => {
  if (pages.length > 0) void refreshPreview();
});
followCursor.addEventListener('change', () => {
  if (followCursor.checked) void followCursorToPreview();
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
  scrollToPosition(page, 0, 'smooth');
}

// Margin above the target so the line isn't glued to the pane's top edge.
const SCROLL_MARGIN_PX = 40;

// `y` is the vertical offset within the page in typst points, mapped onto the
// rendered page height. SVG and canvas previews render one element per page; the
// HTML preview is a single iframe with no per-page element, so this no-ops there.
function scrollToPosition(page: number, y: number, behavior: ScrollBehavior): void {
  const pageEls = previewEl.querySelectorAll<HTMLElement>(':scope > svg, :scope > canvas');
  const el = pageEls[page];
  if (!el) return;

  const info = pages[page];
  const fraction = info && info.height > 0 ? y / info.height : 0;
  const pageTop =
    el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop;
  const target = pageTop + fraction * el.clientHeight - SCROLL_MARGIN_PX;

  previewEl.scrollTo({ top: Math.max(target, 0), behavior });
}

// Debounced so rapid typing / caret moves coalesce into a single jump lookup.
let followTimer = 0;
function scheduleFollow(): void {
  clearTimeout(followTimer);
  followTimer = window.setTimeout(() => void followCursorToPreview(), 150);
}

async function followCursorToPreview(): Promise<void> {
  const cursor = view.state.selection.main.head;
  const jumps = await core.jumpFromCursor(PATH, cursor);
  const pos = jumps.find((jump) => jump.kind === 'position');
  // Instant (not smooth) so it keeps up while typing instead of lagging behind.
  if (pos?.kind === 'position') scrollToPosition(pos.page, pos.y, 'auto');
}

//  export

function syncExportControls(): void {
  const format = exportFormatSelect.value as ExportFormat;
  const isPdf = format === 'pdf';

  exportPageSelect.hidden = isPdf;
  exportPageLabel.hidden = isPdf;
  exportStandards.hidden = !isPdf;
  exportButton.disabled = pages.length === 0;

  rebuildPageOptions();
}

function selectedStandards(): PdfStandard[] {
  const boxes = exportStandards.querySelectorAll<HTMLInputElement>('input:checked');
  return Array.from(boxes, (box) => box.value as PdfStandard);
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
    ? { format: 'pdf' as const, standards: selectedStandards() }
    : { format, index: Number(exportPageSelect.value) - 1 };

  // Incompatible standards (e.g. two PDF/A profiles) are rejected by the engine.
  let res;
  try {
    res = await core.export(args);
  } catch (err) {
    alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

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
