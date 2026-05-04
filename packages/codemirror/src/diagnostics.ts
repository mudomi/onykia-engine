import type { EditorView } from '@codemirror/view';
import { type Diagnostic as CMDiagnostic, setDiagnostics } from '@codemirror/lint';
import type { Core, Diagnostic } from '@mudomi/onykia-engine';
import { fromByteOffset } from './offsets.js';

/** Push diagnostics from Core into CodeMirror's lint state. */
export function applyDiagnostics(
  view: EditorView,
  diagnostics: Diagnostic[],
  currentPath: string,
): void {
  const docText = view.state.doc.toString();
  const docLen = view.state.doc.length;
  const cm: CMDiagnostic[] = [];

  for (const d of diagnostics) {
    if (d.package) continue; // skip errors inside package deps
    if (!d.range) continue;
    if (d.path && d.path !== currentPath) continue;

    cm.push({
      from: Math.min(fromByteOffset(docText, d.range.start), docLen),
      to: Math.min(fromByteOffset(docText, d.range.end), docLen),
      severity: d.severity,
      message: d.message,
      renderMessage: d.hints?.length
        ? () => {
            const div = document.createElement('div');
            const p = document.createElement('p');
            p.textContent = d.message;
            div.appendChild(p);
            for (const hint of d.hints!) {
              const h = document.createElement('p');
              h.className = 'cm-typst-hint';
              h.textContent = hint;
              div.appendChild(h);
            }
            return div;
          }
        : undefined,
    });
  }

  view.dispatch(setDiagnostics(view.state, cm));
}

/**
 * Convenience: subscribe to Core's diagnostics channel and push updates into
 * `view` automatically. Returns an unsubscribe function.
 */
export function diagnosticsSubscription(
  core: Core,
  view: EditorView,
  currentPath: string,
): () => void {
  return core.onDiagnostics(({ diagnostics }) => {
    applyDiagnostics(view, diagnostics, currentPath);
  });
}
