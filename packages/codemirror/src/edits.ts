import type { EditorView, ViewUpdate } from '@codemirror/view';
import { EditorView as EV } from '@codemirror/view';
import type { Core } from '@mudomi/onykia-engine';
import { toByteOffset } from './offsets.js';

export function forwardEdits(core: Core, path: string) {
  return EV.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;
    const oldText = update.startState.doc.toString();
    const edits: { range: { start: number; end: number }; replacement: string }[] = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({
        range: { start: toByteOffset(oldText, fromA), end: toByteOffset(oldText, toA) },
        replacement: inserted.toString(),
      });
    });
    if (edits.length === 0) return;
    void core.edit(path, edits).catch((err) => {
      // Swallow - a doc edit will retry the next keystroke. Surface via console
      // so a dev can see the message without crashing the editor.
      console.warn('[onykia] edit failed:', err);
    });
  });
}

export async function primeFile(
  core: Core,
  path: string,
  view: EditorView,
  mime = 'text/x-typst',
) {
  await core.create(path, mime, view.state.doc.toString());
}
