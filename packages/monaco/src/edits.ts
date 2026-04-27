import type * as monaco from 'monaco-editor';
import type { Core } from '@mudomi/onykia-engine';
import { toByteOffset } from './offsets.js';

// Monaco's content-change events carry UTF-16 offsets against the *pre-edit*
// text, but the model only exposes the post-edit value. We cache the previous
// text ourselves so we can compute byte offsets against the right snapshot.
export function forwardEdits(
  core: Core,
  model: monaco.editor.ITextModel,
  path: string,
): monaco.IDisposable {
  let priorText = model.getValue();

  return model.onDidChangeContent((event) => {
    if (event.changes.length === 0) return;

    const oldText = priorText;
    priorText = model.getValue();

    const edits = event.changes
      .map((c) => ({
        range: {
          start: toByteOffset(oldText, c.rangeOffset),
          end: toByteOffset(oldText, c.rangeOffset + c.rangeLength),
        },
        replacement: c.text,
      }))
      .sort((a, b) => a.range.start - b.range.start);

    void core.edit(path, edits).catch((err) => {
      console.warn('[onykia] edit failed:', err);
    });
  });
}

export async function primeFile(
  core: Core,
  model: monaco.editor.ITextModel,
  path: string,
  mime = 'text/x-typst',
): Promise<void> {
  await core.create(path, mime, model.getValue());
}
