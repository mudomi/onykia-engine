import { EditorState } from '@codemirror/state';

/**
 * Typst-specific math-delimiter niceties. Converts `$$` + space into
 * `$ | $` so math environments get a workable empty body.
 */
export function dollarExtension() {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;

    let changeCount = 0;
    let replacement: { from: number; to: number; insert: string } | undefined;

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (changeCount > 1) return;
      changeCount++;

      const start = tr.startState.doc;

      // Typing a space between $$ --> expand to "$  $"
      if (
        fromA === toA &&
        inserted.length === 1 &&
        inserted.toString() === ' ' &&
        fromA >= 1 &&
        toA + 1 <= start.length &&
        start.sliceString(fromA - 1, toA + 1) === '$$'
      ) {
        replacement = { from: fromA, to: toA, insert: '  ' };
      }

      // Backspacing the space in "$ $" --> collapse back to "$$"
      if (
        inserted.length === 0 &&
        fromA + 1 === toA &&
        fromA >= 1 &&
        toA + 2 <= start.length &&
        start.sliceString(fromA - 1, toA + 2) === '$  $'
      ) {
        replacement = { from: fromA, to: toA + 1, insert: '' };
      }
    });

    return changeCount === 1 && replacement
      ? { ...tr, changes: [replacement] }
      : tr;
  });
}
