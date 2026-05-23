import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { HighlightStyle, highlightingFor, syntaxHighlighting } from '@codemirror/language';
import type { Tag } from '@lezer/highlight';
import type { Core } from '@mudomi/onykia-engine';

import { defaultTypstHighlightStyle, nameToTag } from './tags.js';
import { buildByteToCharMap } from './offsets.js';
import { pendingEdit } from './edits.js';

const setHighlightEffect = StateEffect.define<DecorationSet>();

// Anti-flicker: maps existing decorations through changes while async highlight data loads.
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    if (tr.docChanged) {
      decos = decos.map(tr.changes);
    }
    for (const effect of tr.effects) {
      if (effect.is(setHighlightEffect)) decos = effect.value;
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface HighlightExtensionOptions {
  /** Optional override of the default HighlightStyle. */
  style?: HighlightStyle;
}

// Must be applied per-path; Core.highlight() is keyed by VFS path.
export async function highlightExtension(
  core: Core,
  path: string,
  options: HighlightExtensionOptions = {},
) {
  const { names } = await core.tags();
  const tagByIndex: (Tag | undefined)[] = names.map((n) => nameToTag[n]);
  const style = options.style ?? defaultTypstHighlightStyle;

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
            // Wait for the edit triggered by the same CM transaction to be
            // applied on the worker — otherwise highlight() tokenizes the
            // pre-edit document and we render decorations one keystroke stale.
            await pendingEdit(path);
            const { data } = await core.highlight(path);
            // If the doc changed during the fetch, retry with fresh state.
            if (this.view.state.doc !== snapshot) {
              this.dirty = true;
              continue;
            }
            const decos = buildDecorations(this.view, data, tagByIndex);
            this.view.dispatch({ effects: setHighlightEffect.of(decos) });
          }
        } finally {
          this.inflight = false;
        }
      }
    },
  );

  return [syntaxHighlighting(style), highlightField, plugin];
}

function buildDecorations(
  view: EditorView,
  data: Uint32Array,
  tagByIndex: (Tag | undefined)[],
): DecorationSet {
  const docText = view.state.doc.toString();
  const docLen = view.state.doc.length;
  const byteToChar = buildByteToCharMap(docText);
  const mapLen = byteToChar.length;
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 0; i < data.length; i += 3) {
    const startByte = data[i];
    const endByte = data[i + 1];
    const start = startByte < mapLen ? byteToChar[startByte] : docLen;
    const end = endByte < mapLen ? byteToChar[endByte] : docLen;
    if (start >= end) continue;
    const tag = tagByIndex[data[i + 2]];
    if (!tag) continue;
    const cssClass = highlightingFor(view.state, [tag]);
    if (!cssClass) continue;
    builder.add(start, end, Decoration.mark({ class: cssClass }));
  }
  return builder.finish();
}
