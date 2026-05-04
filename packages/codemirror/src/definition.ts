import { EditorView } from '@codemirror/view';
import type { Core, DefinitionResult } from '@mudomi/onykia-engine';
import { fromByteOffset, toByteOffset } from './offsets.js';

export interface DefinitionHandlers {
  /** Called when the target is another source file. Default: move cursor if same path. */
  onSource?(result: { path: string; pos: number }): void;
}

export function definitionExtension(core: Core, path: string, handlers: DefinitionHandlers = {}) {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      void runDefinition(core, path, pos, view, handlers);
      return true;
    },
  });
}

async function runDefinition(
  core: Core,
  path: string,
  pos: number,
  view: EditorView,
  handlers: DefinitionHandlers,
) {
  const docText = view.state.doc.toString();
  let result: DefinitionResult | null = null;
  try {
    result = await core.definition(path, toByteOffset(docText, pos), 1);
  } catch {
    return;
  }
  if (!result) return;

  if (handlers.onSource) {
    handlers.onSource(result);
    return;
  }
  if (result.path === path) {
    view.dispatch({
      selection: { anchor: fromByteOffset(docText, result.pos) },
      scrollIntoView: true,
    });
  }
}
