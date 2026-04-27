import { EditorView, lineNumbers, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { lintGutter } from '@codemirror/lint';
import { applyDiagnostics, typstExtensions } from '@mudomi/onykia-codemirror';
import { createEngine } from './engine.js';

const PATH = '/main.typ';
const INITIAL = `= Hello, Onykia x CodeMirror
$ integral_0^1 x^2 dif x = 1/3 $
`;

const editorEl = document.getElementById('editor')!;
const previewEl = document.getElementById('preview')!;

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

core.onDiagnostics(({ diagnostics }) => applyDiagnostics(view, diagnostics, PATH));
core.onPages(async ({ pages }) => {
  if (pages.length === 0) return;
  const res = await core.export({ format: 'svg' });
  previewEl.innerHTML = new TextDecoder().decode(res.data);
});

await core.setMain(PATH);
await core.setTarget('svg');
