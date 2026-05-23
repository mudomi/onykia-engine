import type { EditorView, ViewUpdate } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';
import type { Core } from '@mudomi/onykia-engine';
import { toByteOffset } from './offsets.js';

type ByteEdit = { range: { start: number; end: number }; replacement: string };

const editTail = new Map<string, Promise<void>>();

export function pendingEdit(path: string): Promise<void> {
  return editTail.get(path) ?? Promise.resolve();
}

// Chain a byte-offset edit batch onto the per-path tail so highlight/tooltip
// can await `pendingEdit(path)` regardless of which source produced the edit.
function enqueueEdit(core: Core, path: string, edits: ByteEdit[]): Promise<void> {
  const prior = editTail.get(path) ?? Promise.resolve();
  const next = prior.then(() => core.edit(path, edits)).catch((err) => {
    console.warn('[onykia] edit failed:', err);
  });
  editTail.set(path, next);
  void next.finally(() => {
    if (editTail.get(path) === next) editTail.delete(path);
  });
  return next;
}

/**
 * ViewPlugin that forwards CodeMirror document changes to `core.edit`.
 *
 * Use this when CodeMirror is the source of truth. If your edits come from a
 * CRDT or any non-CodeMirror stream, drive {@link pushEditToCore} from that
 * source instead so the engine state is a function of the CRDT, not the editor.
 */
export function forwardEdits(core: Core, path: string) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        const oldText = update.startState.doc.toString();
        const edits: ByteEdit[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          edits.push({
            range: { start: toByteOffset(oldText, fromA), end: toByteOffset(oldText, toA) },
            replacement: inserted.toString(),
          });
        });
        if (edits.length === 0) return;
        enqueueEdit(core, path, edits);
      }
    },
  );
}

/**
 * Push a batch of edits to `core.edit`, chaining onto the same per-path tail as
 * {@link forwardEdits} so `pendingEdit(path)` reflects in-flight edits from any
 * source. Use this when your source of truth is a CRDT or any non-CodeMirror
 * stream of edits.
 *
 * `edits` carry char offsets into `oldText` (the document state before the
 * batch); this helper converts them to the UTF-8 byte offsets the engine wants.
 * Errors are swallowed with the same `console.warn` as `forwardEdits`. The
 * returned promise resolves once the edit has been applied on the worker.
 */
export function pushEditToCore(
  core: Core,
  path: string,
  oldText: string,
  edits: ByteEdit[],
): Promise<void> {
  if (edits.length === 0) return pendingEdit(path);
  const byteEdits = edits.map((e) => ({
    range: {
      start: toByteOffset(oldText, e.range.start),
      end: toByteOffset(oldText, e.range.end),
    },
    replacement: e.replacement,
  }));
  return enqueueEdit(core, path, byteEdits);
}

export async function primeFile(
  core: Core,
  path: string,
  view: EditorView,
  mime = 'text/x-typst',
) {
  await core.create(path, mime, view.state.doc.toString());
}
