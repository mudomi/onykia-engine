/**
 * `@mudomi/onykia-codemirror` - CodeMirror 6 bindings for @mudomi/onykia-engine.
 *
 */

export { highlightExtension } from './highlighting.js';
export type { HighlightExtensionOptions } from './highlighting.js';
export { autocompleteExtension } from './autocomplete.js';
export { tooltipExtension } from './tooltip.js';
export { definitionExtension } from './definition.js';
export type { DefinitionHandlers } from './definition.js';
export { applyDiagnostics, diagnosticsSubscription } from './diagnostics.js';
export { forwardEdits, primeFile } from './edits.js';
export { dollarExtension } from './math.js';
export { defaultTypstHighlightStyle, typstTags, nameToTag } from './tags.js';

import type { Core } from '@mudomi/onykia-engine';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { autocompleteExtension } from './autocomplete.js';
import { definitionExtension, type DefinitionHandlers } from './definition.js';
import { diagnosticsSubscription } from './diagnostics.js';
import { forwardEdits } from './edits.js';
import { highlightExtension, type HighlightExtensionOptions } from './highlighting.js';
import { dollarExtension } from './math.js';
import { tooltipExtension } from './tooltip.js';

export interface TypstExtensionsOptions {
  /** Subscribe to Core.onDiagnostics and push them into the view. Default: true. */
  wireDiagnostics?: boolean;
  /** Forward editor document changes to Core.edit(). Default: true. */
  forwardEdits?: boolean;
  /** Enable hover tooltips. Default: true. */
  tooltip?: boolean;
  /** Enable go-to-definition on Ctrl/Cmd+click. Default: true. */
  definition?: boolean | DefinitionHandlers;
  /** Enable autocomplete. Default: true. */
  autocomplete?: boolean;
  /** Enable `$$` --> `$ $` math auto-pair. Default: true. */
  dollarAutoPair?: boolean;
  /** Highlight styling overrides. */
  highlight?: HighlightExtensionOptions | false;
}

/**
 * Assemble the full set of Typst-aware extensions for a given file path.
 *
 * `view` is only needed when `wireDiagnostics` is true (the subscription
 * needs to know which view to push lint state into). Returns both the
 * extensions (to include in your `EditorState.create({ extensions })`) and
 * a cleanup function that tears down the diagnostics subscription.
 */
export async function typstExtensions(
  core: Core,
  path: string,
  view: EditorView | null = null,
  options: TypstExtensionsOptions = {},
): Promise<{ extensions: Extension[]; dispose: () => void }> {
  const extensions: Extension[] = [];
  const disposers: (() => void)[] = [];
  if (options.forwardEdits !== false) extensions.push(forwardEdits(core, path));

  if (options.highlight !== false) {
    const hl = await highlightExtension(core, path, options.highlight ?? {});
    extensions.push(hl);
  }

  if (options.autocomplete !== false) extensions.push(autocompleteExtension(core, path));
  if (options.tooltip !== false) extensions.push(tooltipExtension(core, path));
  if (options.definition !== false) {
    const handlers = typeof options.definition === 'object' ? options.definition : {};
    extensions.push(definitionExtension(core, path, handlers));
  }
  if (options.dollarAutoPair !== false) extensions.push(dollarExtension());

  if (options.wireDiagnostics !== false && view) {
    disposers.push(diagnosticsSubscription(core, view, path));
  }

  return {
    extensions,
    dispose: () => disposers.forEach((d) => d()),
  };
}
