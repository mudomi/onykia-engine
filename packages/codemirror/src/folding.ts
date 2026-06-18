import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { foldService } from '@codemirror/language';
import type { Core } from '@mudomi/onykia-engine';

import { pendingEdit } from './edits.js';
import { buildByteToCharMap } from './offsets.js';

// Shape of the CST returned by Core.syntaxTree(). Offsets are UTF-8 bytes.
interface CstNode {
  kind: string;
  start: number;
  end: number;
  text?: string;
  children?: CstNode[];
}

// A foldable region, in CodeMirror (UTF-16) positions.
interface FoldRange {
  from: number;
  to: number;
}

// Nodes delimited by a single-char bracket pair. Folding hides the interior and
// leaves the delimiters visible, so a block reads as `[...]` when collapsed.
const BRACKETED = new Set([
  'ContentBlock',
  'CodeBlock',
  'Array',
  'Dict',
  'Parenthesized',
  'Args',
  'Params',
  'Destructuring',
]);

const setFoldRanges = StateEffect.define<FoldRange[]>();

// Holds the latest fold ranges. Mapped through edits so the gutter stays put
// until the async refresh below replaces them with freshly-parsed ones.
const foldRangesField = StateField.define<FoldRange[]>({
  create: () => [],
  update(ranges, tr) {
    if (tr.docChanged) {
      ranges = ranges.map((r) => ({
        from: tr.changes.mapPos(r.from, 1),
        to: tr.changes.mapPos(r.to, -1),
      }));
    }
    for (const effect of tr.effects) {
      if (effect.is(setFoldRanges)) ranges = effect.value;
    }
    return ranges;
  },
});

// CodeMirror asks per line whether a block starts there; we return the widest
// range opening on the line so the outermost block collapses.
const service = foldService.of((state, lineStart, lineEnd) => {
  const ranges = state.field(foldRangesField, false);
  if (!ranges) return null;

  let widest: FoldRange | null = null;
  for (const r of ranges) {
    const opensOnLine = r.from >= lineStart && r.from <= lineEnd;
    if (opensOnLine && r.to > lineEnd && (!widest || r.to > widest.to)) widest = r;
  }
  return widest;
});

function headingLevel(heading: CstNode): number {
  const marker = heading.children?.find((c) => c.kind === 'HeadingMarker');
  return marker?.text?.trim().length ?? 1;
}

function collectFoldRanges(root: CstNode, doc: string): FoldRange[] {
  const byteToChar = buildByteToCharMap(doc);
  const toChar = (byte: number) => (byte < byteToChar.length ? byteToChar[byte] : doc.length);

  const ranges: FoldRange[] = [];
  const spansLines = (from: number, to: number) =>
    to > from && doc.lastIndexOf('\n', to - 1) >= from;

  const visit = (node: CstNode) => {
    const kids = node.children ?? [];

    // Brackets are ASCII, so one byte past `start` / before `end` is one char.
    if (BRACKETED.has(node.kind)) {
      const from = toChar(node.start) + 1;
      const to = toChar(node.end) - 1;
      if (spansLines(from, to)) ranges.push({ from, to });
    }

    // A heading folds its section: everything up to the next heading of equal or
    // higher rank among its siblings, or the end of the enclosing block.
    const headings = kids.filter((c) => c.kind === 'Heading');
    for (let i = 0; i < headings.length; i++) {
      const level = headingLevel(headings[i]);

      let sectionEnd = toChar(node.end);
      for (let j = i + 1; j < headings.length; j++) {
        if (headingLevel(headings[j]) <= level) {
          sectionEnd = toChar(headings[j].start);
          break;
        }
      }

      const from = toChar(headings[i].end);
      let to = sectionEnd;
      while (to > from && /\s/.test(doc[to - 1])) to--; // keep the blank line before the next heading
      if (spansLines(from, to)) ranges.push({ from, to });
    }

    kids.forEach(visit);
  };

  visit(root);
  return ranges;
}

/**
 * Fold source backed by the engine's syntax tree: bracketed blocks and heading
 * sections. Provides the fold ranges only - pair it with `foldGutter()` (and
 * `foldKeymap`) from `@codemirror/language` for the fold UI.
 *
 * Must be applied per-path; Core.syntaxTree() is keyed by VFS path.
 */
export function foldingExtension(core: Core, path: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      view: EditorView;
      inflight = false;
      dirty = false;
      constructor(view: EditorView) {
        this.view = view;
        this.dirty = true;
        void this.refresh();
      }
      update(u: ViewUpdate) {
        if (u.docChanged) {
          this.dirty = true;
          void this.refresh();
        }
      }
      async refresh() {
        if (this.inflight) return;
        this.inflight = true;
        try {
          while (this.dirty) {
            this.dirty = false;
            const snapshot = this.view.state.doc;
            // Wait for this transaction's edit to reach the worker, else we
            // parse the pre-edit document and fold one keystroke stale.
            await pendingEdit(path);
            const root = (await core.syntaxTree(path)) as CstNode;
            // If the doc changed during the fetch, retry with fresh state.
            if (this.view.state.doc !== snapshot) {
              this.dirty = true;
              continue;
            }
            const ranges = collectFoldRanges(root, snapshot.toString());
            this.view.dispatch({ effects: setFoldRanges.of(ranges) });
          }
        } finally {
          this.inflight = false;
        }
      }
    },
  );

  return [foldRangesField, service, plugin];
}
