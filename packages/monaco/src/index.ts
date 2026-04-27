/**
 * `@mudomi/onykia-monaco` - Monaco editor bindings for @mudomi/onykia-engine.
 *
 * **Minimal scope:** edit forwarding + diagnostics + priming. The richer IDE
 * features (highlight, autocomplete, hover, definition) that the CodeMirror
 * package ships still need to be ported - they map onto
 * `monaco.languages.register*Provider` APIs but are non-trivial because
 * Monaco's tokenizer model is line-by-line and stateful.
 */

import type * as monaco from 'monaco-editor';
import type { Core } from '@mudomi/onykia-engine';

import { forwardEdits, primeFile } from './edits.js';
import { diagnosticsSubscription } from './diagnostics.js';

export { forwardEdits, primeFile } from './edits.js';
export { applyDiagnostics, diagnosticsSubscription } from './diagnostics.js';

export interface TypstMonacoOptions {
  wireDiagnostics?: boolean;
  forwardEdits?: boolean;
}

// Wire a Monaco model up to a Core instance. Call `primeFile` first to seed
// Core with the initial document; this only attaches the live listeners.
export function bindTypst(
  core: Core,
  model: monaco.editor.ITextModel,
  path: string,
  options: TypstMonacoOptions = {},
): { dispose: () => void } {
  const disposers: Array<() => void> = [];

  if (options.forwardEdits !== false) {
    const d = forwardEdits(core, model, path);
    disposers.push(() => d.dispose());
  }

  if (options.wireDiagnostics !== false) {
    disposers.push(diagnosticsSubscription(core, model, path));
  }

  return {
    dispose: () => disposers.forEach((d) => d()),
  };
}
