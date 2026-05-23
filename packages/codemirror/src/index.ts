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
export {
  applyDiagnostics,
  diagnosticsSubscription,
  modificationTracker,
  disposeModificationTracker,
} from './diagnostics.js';
export type { DiagnosticsFilterOptions } from './diagnostics.js';
export { forwardEdits, pushEditToCore, pendingEdit, primeFile } from './edits.js';
export { dollarExtension } from './math.js';
export { defaultTypstHighlightStyle, typstTags, nameToTag } from './tags.js';
export { spellcheckExtension, wireCoreSpellcheck } from './spellcheck.js';
export type { SpellChecker, SpellcheckExtensionOptions } from './spellcheck.js';
export { awarenessCursorExtension } from './awareness.js';
export type {
  AwarenessTransport,
  CursorCodec,
  AwarenessCursorOptions,
} from './awareness.js';

import type { Core } from '@mudomi/onykia-engine';
import type { Extension } from '@codemirror/state';

import { autocompleteExtension } from './autocomplete.js';
import { definitionExtension, type DefinitionHandlers } from './definition.js';
import { forwardEdits } from './edits.js';
import { highlightExtension, type HighlightExtensionOptions } from './highlighting.js';
import { dollarExtension } from './math.js';
import { tooltipExtension } from './tooltip.js';

export interface TypstExtensionsOptions {
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
 * Diagnostics are not wired here: subscribe directly with
 * `diagnosticsSubscription(core, view, path)` (or call `applyDiagnostics`
 * yourself) so the editor owns that side effect explicitly.
 */
export async function typstExtensions(
  core: Core,
  path: string,
  options: TypstExtensionsOptions = {},
): Promise<{ extensions: Extension[] }> {
  const extensions: Extension[] = [];
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

  return { extensions };
}
