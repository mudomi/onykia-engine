import type { Completion, Diagnostic, Range } from './types.js';

export interface EditorAdapter {
  /** Path in the Typst VFS (e.g. `/main.typ`). */
  readonly path: string;

  getText(): string;
  getCursor(): number;
  onChange(
    fn: (edits: { range: Range; replacement: string }[]) => void,
  ): () => void;
  applyHighlight(spans: HighlightSpan[]): void;
  /** Old diagnostics are replaced, not merged. */
  applyDiagnostics(diagnostics: Diagnostic[]): void;
  showCompletions(from: number, completions: Completion[]): () => void;
  showTooltip(at: number, html: string): () => void;
  scrollToPosition(pos: number): void;
}

export interface HighlightSpan {
  from: number;
  to: number;
  /** CSS class or token-type identifier. */
  tag: string;
}

// For editors that don't emit deltas natively (e.g. a plain textarea).
// CM/Monaco/Yjs should forward their own deltas instead.
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
