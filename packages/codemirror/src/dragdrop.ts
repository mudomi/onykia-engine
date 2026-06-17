// Drop/paste a file into a Typst document and get a sensible insert
// (`#image("...")`, `#read("...")`, `#bibliography("...")`, ...) based on MIME.
//
// Transport-agnostic: resolving a dragged item to a project-relative path
// (and uploading OS files) is the consumer's job, behind {@link DropResolver}.
// This extension only handles the editor side - the drop indicator, the DOM
// events, and turning a resolved file into Typst source at the drop position.

import { StateEffect, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

export interface DroppedFile {
  /** Path used inside Typst source, e.g. `../assets/foo.png`. */
  relativePath: string;
  /** Suggested Typst snippet; overrides the default MIME-based snippet. */
  snippet?: string;
  mime?: string;
}

export interface DropResolver {
  /** A file dragged from inside the project (e.g. the file sidebar). */
  fromInternalDrag(data: string): Promise<DroppedFile | null>;
  /** Files dragged in from the OS. May upload first, then resolve. */
  fromExternalFiles(files: FileList, targetDir: string): Promise<DroppedFile[]>;
}

export interface DropFileOptions {
  resolver: DropResolver;
  /** The path of the file currently being edited (used to derive `targetDir`). */
  currentPath: () => string;
  /** The `dataTransfer` MIME type the consumer's sidebar uses for internal drags. */
  dragDataMime: string;
}

/**
 * MIME -> Typst snippet. `{path}` is replaced with the file's relative path.
 * A {@link DroppedFile.snippet} supplied by the resolver always wins over this.
 */
function defaultSnippet(mime: string | undefined, path: string): string {
  if (mime?.startsWith('image/')) return `#image("${path}")`;
  if (mime === 'application/x-bibtex') return `#bibliography("${path}")`;
  if (mime === 'text/csv') return `#csv("${path}")`;
  if (mime === 'text/yaml' || mime === 'application/yaml') return `#yaml("${path}")`;
  return `#read("${path}")`;
}

export function dropFileExtension(options: DropFileOptions): Extension {
  const { resolver, currentPath, dragDataMime } = options;
  const { plugin: indicator, setMarkPos } = dropIndicator();

  function showIndicatorAt(event: DragEvent, view: EditorView) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
    view.dispatch({ effects: setMarkPos.of(pos) });
  }

  function clearIndicator(view: EditorView) {
    view.dispatch({ effects: setMarkPos.of(null) });
  }

  // Tell the browser we accept the drag and keep the indicator under the cursor.
  function onDragOver(event: DragEvent, view: EditorView) {
    const types = event.dataTransfer?.types;
    if (types?.includes(dragDataMime)) {
      event.dataTransfer!.dropEffect = 'link';
    } else if (types?.includes('Files')) {
      event.dataTransfer!.dropEffect = 'copy';
    } else {
      return;
    }
    showIndicatorAt(event, view);
    event.preventDefault();
  }

  function insert(view: EditorView, files: DroppedFile[], pos: number) {
    const snippets = files.map((f) => f.snippet ?? defaultSnippet(f.mime, f.relativePath));
    insertSnippets(view, snippets, pos);
  }

  // Shared by drop and paste; `pasted` skips OS files when plain text is also
  // present so a normal text paste isn't hijacked.
  async function handleTransfer(
    event: { preventDefault(): void },
    view: EditorView,
    pos: number,
    transfer: DataTransfer | null,
    pasted: boolean,
  ) {
    const types = transfer?.types;
    if (!types) return;

    if (types.includes(dragDataMime)) {
      const resolved = await resolver.fromInternalDrag(transfer!.getData(dragDataMime));
      if (!resolved) return;
      insert(view, [resolved], pos);
      event.preventDefault();
      return;
    }

    if (types.includes('Files') && !(pasted && types.includes('text/plain'))) {
      const resolved = await resolver.fromExternalFiles(transfer!.files, dirOf(currentPath()));
      if (resolved.length === 0) return;
      insert(view, resolved, pos);
      event.preventDefault();
    }
  }

  return [
    indicator,
    EditorView.domEventHandlers({
      dragover: onDragOver,
      dragenter: onDragOver,
      dragleave: (_event, view) => clearIndicator(view),
      paste: (event, view) => {
        void handleTransfer(event, view, view.state.selection.main.head, event.clipboardData, true);
      },
      drop: (event, view) => {
        clearIndicator(view);
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
        void handleTransfer(event, view, pos, event.dataTransfer, false);
      },
    }),
  ];
}

// --- Drop indicator (a thin caret showing where the insert will land) ---

class DropCaretWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-drop-caret';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

function dropIndicator() {
  const caret = Decoration.widget({ widget: new DropCaretWidget(), side: -1 });

  // null clears the indicator; a number positions it. Remap the position
  // through concurrent edits so it stays put if the doc changes mid-drag.
  const setMarkPos = StateEffect.define<number | null>({
    map: (pos, changes) => (pos === null ? null : changes.mapPos(pos)),
  });

  const plugin: Extension = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;

      update(update: ViewUpdate) {
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (!effect.is(setMarkPos)) continue;
            this.decorations =
              effect.value === null
                ? Decoration.none
                : Decoration.set([caret.range(effect.value)]);
          }
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  return { plugin, setMarkPos };
}

// --- Insertion ---

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function isBreakOrSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n';
}

/**
 * Insert the snippets at `pos`, padding with newlines so the insert lands on
 * its own line when dropped against adjacent non-whitespace text.
 */
function insertSnippets(view: EditorView, snippets: string[], pos: number): void {
  if (snippets.length === 0) return;

  let text = snippets.join('\n');

  const neighbors = view.state.sliceDoc(
    Math.max(0, pos - 1),
    Math.min(view.state.doc.length, pos + 1),
  );

  if (neighbors.length === 2) {
    if (!isBreakOrSpace(neighbors[0])) text = '\n' + text;
    if (!isBreakOrSpace(neighbors[1])) text = text + '\n';
  } else if (neighbors.length === 1 && !isBreakOrSpace(neighbors[0])) {
    text = pos === 0 ? text + '\n' : '\n' + text;
  }

  view.dispatch(
    view.state.update({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
    }),
  );
}
