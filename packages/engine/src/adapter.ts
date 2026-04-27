/**
 * Editor-agnostic adapter layer.
 *
 * The CodeMirror package (and any future Monaco / Ace / tiptap bindings)
 * target {@link EditorAdapter} rather than a specific editor's API. This
 * keeps Core's IDE surface decoupled from the editor and makes it possible
 * to drive the engine from a custom textarea, headless tests, or a different
 * editor altogether.
 *
 * `@mudomi/onykia-codemirror` ships a `cmAdapter(view, path)` factory that returns
 * one of these. A Monaco port would implement the same shape on top of
 * `monaco.editor.IStandaloneCodeEditor` - no changes to Core required.
 */

import type { Completion, Diagnostic, Range } from './types.js';

/**
 * Minimal contract an editor must satisfy for the Typst integrations to work.
 *
 * The adapter is always bound to a single file path in the VFS (see
 * `bindFile`). Adapters do not talk to {@link Core} - the bindings glue the
 * two together. This split means a host could, for instance, reuse the
 * diagnostic-rendering code while swapping out highlight/autocomplete.
 */
export interface EditorAdapter {
  /** Path in the Typst VFS (e.g. `/main.typ`). */
  readonly path: string;

  /** Current document content as a single string. */
  getText(): string;

  /** Cursor byte offset. */
  getCursor(): number;

  /**
   * Register a change listener. The callback receives one or more
   * `{ range, replacement }` edits in the same shape that Core expects.
   * Returns an unsubscribe function.
   */
  onChange(
    fn: (edits: { range: Range; replacement: string }[]) => void,
  ): () => void;

  /** Render highlight spans. `spans` is aligned to the current text. */
  applyHighlight(spans: HighlightSpan[]): void;

  /** Render diagnostics. Old diagnostics are replaced, not merged. */
  applyDiagnostics(diagnostics: Diagnostic[]): void;

  /** Show a completion popup anchored at `from`. Returns a dismissal function. */
  showCompletions(from: number, completions: Completion[]): () => void;

  /** Show a hover tooltip at the given position, displaying pre-rendered HTML. */
  showTooltip(at: number, html: string): () => void;

  /** Jump the cursor/scroll to a position. */
  scrollToPosition(pos: number): void;
}

export interface HighlightSpan {
  from: number;
  to: number;
  /** CSS class or token-type identifier. */
  tag: string;
}

/**
 * Diff two text snapshots into the `{ range, replacement }[]` shape Core
 * expects. The implementation is simple - it finds the longest matching
 * prefix and suffix - and suffices for editor backends that don't already
 * emit deltas (e.g. a plain `<textarea>` onInput handler).
 *
 * Note: editors that already emit deltas (CodeMirror, Monaco, Yjs) should
 * forward those directly and skip this helper.
 */
export function diffEdits(oldText: string, newText: string): { range: Range; replacement: string }[] {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  const start = prefix;
  const end = oldText.length - suffix;
  const replacement = newText.slice(prefix, newText.length - suffix);
  if (start === end && replacement.length === 0) return [];
  return [{ range: { start, end }, replacement }];
}
