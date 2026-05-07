import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { bindTypst, primeFile } from '@mudomi/onykia-monaco';
import { createEngine } from './engine.js';

(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const PATH = '/main.typ';
const INITIAL = `= Hello, Onykia x Monaco
$ integral_0^1 x^2 dif x = 1/3 $
`;

const editorEl = document.getElementById('editor')!;
const previewEl = document.getElementById('preview')!;

const model = monaco.editor.createModel(INITIAL, 'plaintext');
monaco.editor.create(editorEl, { model, automaticLayout: true, minimap: { enabled: false } });

const core = await createEngine();
await primeFile(core, model, PATH);
bindTypst(core, model, PATH);

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

await core.setMain(PATH);
await core.setTarget('svg');
