import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import { applyDiagnostics, typstExtensions } from '@mudomi/onykia-codemirror';
import { paint } from '@mudomi/onykia-engine';
import { createEngine } from './engine.js';

const PATH = '/main.typ';
const INITIAL = `= Hello, Onykia x CodeMirror
$ integral_0^1 x^2 dif x = 1/3 $
`;

type PreviewFormat = 'svg' | 'canvas' | 'html';

const editorEl = document.getElementById('editor')!;
const previewEl = document.getElementById('preview')!;
const formatSelect = document.getElementById('format') as HTMLSelectElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;

const core = createEngine();
await core.create(PATH, 'text/x-typst', INITIAL);

const { extensions } = await typstExtensions(core, PATH, null);
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

let pageCount = 0;

core.onDiagnostics(({ diagnostics }) => applyDiagnostics(view, diagnostics, PATH));
core.onPages(({ pages }) => {
  pageCount = pages.length;
  if (pageCount > 0) void refreshPreview();
});

formatSelect.addEventListener('change', () => {
  if (pageCount > 0) void refreshPreview();
});

exportButton.addEventListener('click', () => void downloadPdf());

await core.setMain(PATH);
await core.setTarget('svg');

async function refreshPreview(): Promise<void> {
  const format = formatSelect.value as PreviewFormat;
  if (format === 'canvas') {
    await renderCanvas();
  } else if (format === 'html') {
    await renderHtml();
  } else {
    await renderSvg();
  }
}

async function renderSvg(): Promise<void> {
  const res = await core.export({ format: 'svg' });
  previewEl.innerHTML = new TextDecoder().decode(res.data);
}

async function renderCanvas(): Promise<void> {
  const canvas = document.createElement('canvas');
  previewEl.replaceChildren(canvas);
  const result = await core.render(0, 2);
  paint(canvas, result);
}

async function renderHtml(): Promise<void> {
  const res = await core.export({ format: 'html' });
  const iframe = document.createElement('iframe');
  iframe.srcdoc = new TextDecoder().decode(res.data);
  previewEl.replaceChildren(iframe);
}

async function downloadPdf(): Promise<void> {
  const res = await core.export({ format: 'pdf' });
  // Copy off any SharedArrayBuffer-backed view: Blob expects ArrayBuffer-backed.
  const bytes = new Uint8Array(res.data);
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));

  const link = document.createElement('a');
  link.href = url;
  link.download = 'onykia.pdf';
  link.click();

  URL.revokeObjectURL(url);
}
