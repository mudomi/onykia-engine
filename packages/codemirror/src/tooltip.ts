import { hoverTooltip } from '@codemirror/view';
import type { Core } from '@mudomi/onykia-engine';
import { toByteOffset } from './offsets.js';

export function tooltipExtension(core: Core, path: string) {
  return hoverTooltip(async (view, pos, side) => {
    let result;
    try {
      result = await core.tooltip(path, toByteOffset(view.state.doc.toString(), pos), side as -1 | 1);
    } catch {
      return null;
    }
    if (!result?.html) return null;
    return {
      pos,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-typst-tooltip';
        dom.innerHTML = result.html;
        return { dom };
      },
    };
  });
}
