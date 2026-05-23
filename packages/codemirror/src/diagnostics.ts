import type { EditorView, ViewUpdate } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';
import { type Diagnostic as CMDiagnostic, setDiagnostics } from '@codemirror/lint';
import type { Core, Diagnostic } from '@mudomi/onykia-engine';
import { fromByteOffset } from './offsets.js';

export interface DiagnosticsFilterOptions {
  /** Suppress diagnostics whose range was edited within the last N ms. Default: 250. */
  suppressEditedWithinMs?: number;
}

const DEFAULT_SUPPRESS_MS = 250;

/**
 * Remembers recently edited positions so diagnostics painted while the engine
 * is still one compile behind don't flicker across the just-edited region.
 *
 * Adapted from typst.app's tracker (which feeds off a Yjs delta); here it is
 * fed by a CodeMirror updateListener via {@link modificationTracker}.
 */
class ModificationTracker {
  private recents = new Map<number, number>();

  /** Record an edit ending at char offset `pos`. */
  touch(pos: number): void {
    const now = Date.now();
    for (const [at, when] of this.recents) {
      // Coalesce nearby positions and drop anything we'll never query again.
      if (Math.abs(at - pos) <= 10 || now - when > 30_000) this.recents.delete(at);
    }
    this.recents.set(pos, now);
  }

  /** True if any position within [from, to] was edited within `withinMs`. */
  editedWithin(from: number, to: number, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    for (const [at, when] of this.recents) {
      if (when < cutoff) continue;
      // Treat the edit position as a small region so a one-char insert still
      // covers the diagnostic that the engine reports a tick later.
      if (at >= from - 1 && at <= to + 1) return true;
    }
    return false;
  }
}

const trackers = new Map<string, ModificationTracker>();

function trackerFor(path: string): ModificationTracker {
  let t = trackers.get(path);
  if (!t) {
    t = new ModificationTracker();
    trackers.set(path, t);
  }
  return t;
}

/**
 * ViewPlugin that feeds the per-path modification tracker from CodeMirror
 * document changes. Add it alongside {@link diagnosticsSubscription} (or
 * `applyDiagnostics`) so the filter has edit positions to consult.
 *
 * Uses the same `update.docChanged` phase as `forwardEdits` so it can't race
 * the highlight refresh.
 */
export function modificationTracker(path: string) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        const tracker = trackerFor(path);
        update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          // Record both ends of the changed region in the new document.
          tracker.touch(fromB);
          if (toB !== fromB) tracker.touch(toB);
        });
      }
    },
  );
}

/** Drop the tracker for a path (call when a file's editor is torn down). */
export function disposeModificationTracker(path: string): void {
  trackers.delete(path);
}

export function applyDiagnostics(
  view: EditorView,
  diagnostics: Diagnostic[],
  currentPath: string,
  options: DiagnosticsFilterOptions = {},
): void {
  const docText = view.state.doc.toString();
  const docLen = view.state.doc.length;
  const suppressMs = options.suppressEditedWithinMs ?? DEFAULT_SUPPRESS_MS;
  const tracker = trackers.get(currentPath);
  const cm: CMDiagnostic[] = [];

  for (const d of diagnostics) {
    if (d.package) continue; // skip errors inside package deps
    if (!d.range) continue;
    if (d.path && d.path !== currentPath) continue;

    const from = Math.min(fromByteOffset(docText, d.range.start), docLen);
    const to = Math.min(fromByteOffset(docText, d.range.end), docLen);

    // Skip diagnostics over a region the user just touched; the next compile
    // cycle re-emits them once the edit has settled.
    if (tracker && tracker.editedWithin(from, to, suppressMs)) continue;

    cm.push({
      from,
      to,
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

export function diagnosticsSubscription(
  core: Core,
  view: EditorView,
  currentPath: string,
  options: DiagnosticsFilterOptions = {},
): () => void {
  return core.onDiagnostics(({ diagnostics }) => {
    applyDiagnostics(view, diagnostics, currentPath, options);
  });
}
