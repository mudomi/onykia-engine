import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { bindTypst, primeFile } from '@mudomi/onykia-monaco';
import { createEngine } from './engine.js';
import { type OutlineEntry } from '@mudomi/onykia-engine';

(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const PATH = '/main.typ';
const INITIAL = `= Hello, Onykia x Monaco
$ integral_0^1 x^2 dif x = 1/3 $
`;

const editorEl = document.getElementById('editor')!;
const previewEl = document.getElementById('preview')!;
const outlineEl = document.getElementById('outline')!;

const model = monaco.editor.createModel(INITIAL, 'plaintext');
monaco.editor.create(editorEl, { model, automaticLayout: true, minimap: { enabled: false } });

const core = await createEngine();
await primeFile(core, model, PATH);
bindTypst(core, model, PATH);

core.onOutline(({ entries }) => renderOutline(entries));

core.onPages(async ({ pages }) => {
  if (pages.length === 0) return;

  const decoder = new TextDecoder();
  const svgs = await Promise.all(
    pages.map(async (_, index) => {
      const res = await core.export({ format: 'svg', index });
      return decoder.decode(res.data);
    }),
  );

  previewEl.innerHTML = svgs.join('\n');
});

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
  const pageEls = previewEl.querySelectorAll(':scope > svg');
  pageEls[page]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

await core.setMain(PATH);
await core.setTarget('svg');
