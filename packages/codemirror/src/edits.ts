import type { EditorView, ViewUpdate } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';
import type { Core } from '@mudomi/onykia-engine';
import { toByteOffset } from './offsets.js';

const editTail = new Map<string, Promise<void>>();

export function pendingEdit(path: string): Promise<void> {
  return editTail.get(path) ?? Promise.resolve();
}

export function forwardEdits(core: Core, path: string) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
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
        const prior = editTail.get(path) ?? Promise.resolve();
        const next = prior.then(() => core.edit(path, edits)).catch((err) => {

          console.warn('[onykia] edit failed:', err);
        });
        editTail.set(path, next);
        void next.finally(() => {
          if (editTail.get(path) === next) editTail.delete(path);
        });
      }
    },
  );
}

export async function primeFile(
  core: Core,
  path: string,
  view: EditorView,
  mime = 'text/x-typst',
) {
  await core.create(path, mime, view.state.doc.toString());
}
