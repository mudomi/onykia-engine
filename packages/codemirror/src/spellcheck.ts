import {
  autocompletion,
  closeCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  type Diagnostic as CMDiagnostic,
  forEachDiagnostic,
  setDiagnostics,
} from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin } from '@codemirror/view';
import type { Core, Diagnostic } from '@mudomi/onykia-engine';

import { fromByteOffset } from './offsets.js';

/**
 * Spellcheck for `@mudomi/onykia-codemirror`. **Bring your own backend** - the
 * package depends on nothing spellcheck-specific. Implement {@link SpellChecker}
 * with hunspell-asm, nspell, the browser's native API, or a remote service, and
 * compose {@link spellcheckExtension} into your editor. It is opt-in: the Typst
 * extension assembly never installs it for you.
 */
export interface SpellChecker {
  check(word: string, lang: string, region?: string): Promise<boolean>;
  suggest(word: string, lang: string, region?: string): Promise<string[]>;
}

export interface SpellcheckExtensionOptions {
  /** Language passed to the backend, e.g. `"en"`. Default: `"en"`. */
  lang?: string;
  /** Optional region passed to the backend, e.g. `"US"`. */
  region?: string;
  /** Cap on suggestions offered in the completion list. Default: 5. */
  maxSuggestions?: number;
  /** Persist a word the user accepted; storage is the consumer's concern. */
  onAddToDictionary?: (word: string) => void;
  /** Turn spellcheck off; persistence is the consumer's concern. */
  onDisable?: () => void;
}

// The engine flags spelling diagnostics with this severity. It is wider than
// the public `Diagnostic['severity']` union, so we compare against the raw
// string rather than the narrowed type.
const MISSPELLING_SEVERITY = 'misspelling';

// Source tag stamped onto spellcheck lint entries so the completion source can
// recognise its own ranges via `forEachDiagnostic`.
const SPELLCHECK_SOURCE = 'onykia-spellcheck';

// Matches typst.app's suggestion cap.
const DEFAULT_MAX_SUGGESTIONS = 5;

/**
 * Render misspelling diagnostics into the lint gutter and offer suggestions on
 * explicit completion inside a misspelled range.
 *
 * Chain this behind the regular autocomplete: the suggestion source only
 * returns a result when the cursor sits in a misspelled range and the user
 * triggered completion explicitly, so normal completion is unaffected.
 */
export function spellcheckExtension(
  core: Core,
  path: string,
  spellChecker: SpellChecker,
  options: SpellcheckExtensionOptions = {},
): Extension {
  return [
    spellcheckDiagnostics(core, path),
    spellcheckCompletion(path, spellChecker, options),
  ];
}

// A ViewPlugin owns the diagnostics subscription so it has a real teardown hook
// and a stable reference to the view to paint into.
function spellcheckDiagnostics(core: Core, path: string): Extension {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;

      constructor(view: EditorView) {
        this.unsubscribe = core.onDiagnostics(({ diagnostics }) => {
          paintMisspellings(view, diagnostics, path);
        });
      }

      destroy() {
        this.unsubscribe();
      }
    },
  );
}

function spellcheckCompletion(
  path: string,
  spellChecker: SpellChecker,
  options: SpellcheckExtensionOptions,
): Extension {
  const lang = options.lang ?? 'en';
  const region = options.region;
  const maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;

  return autocompletion({
    override: [
      async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        if (!ctx.explicit) return null;

        const range = misspelledRangeAt(ctx, ctx.pos);
        if (!range) return null;

        const word = ctx.state.sliceDoc(range.from, range.to);
        const suggestions = (await spellChecker.suggest(word, lang, region)).slice(
          0,
          maxSuggestions,
        );

        const completions: Completion[] = suggestions.map((label) => ({ label }));
        completions.push(...synthetic(word, suggestions.length, options));

        return { from: range.from, to: range.to, options: completions, filter: false };
      },
    ],
  });
}

function synthetic(
  word: string,
  suggestionCount: number,
  options: SpellcheckExtensionOptions,
): Completion[] {
  const section = { name: 'Options' };

  return [
    {
      label: 'Add to dictionary',
      detail: suggestionCount > 0 ? '' : 'No suggestions found',
      section,
      apply: (view: EditorView) => {
        options.onAddToDictionary?.(word);
        closeCompletion(view);
      },
    },
    {
      label: 'Disable spellcheck',
      section,
      apply: (view: EditorView) => {
        options.onDisable?.();
        closeCompletion(view);
      },
    },
  ];
}

function misspelledRangeAt(
  ctx: CompletionContext,
  pos: number,
): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;

  forEachDiagnostic(ctx.state, (d, from, to) => {
    if (d.source !== SPELLCHECK_SOURCE) return;
    if (from <= pos && pos <= to) hit = { from, to };
  });

  return hit;
}

function paintMisspellings(
  view: EditorView,
  diagnostics: Diagnostic[],
  currentPath: string,
): void {
  const docText = view.state.doc.toString();
  const docLen = view.state.doc.length;
  const cm: CMDiagnostic[] = [];

  for (const d of diagnostics) {
    if ((d.severity as string) !== MISSPELLING_SEVERITY || !d.range) continue;
    if (d.path && d.path !== currentPath) continue;

    cm.push({
      from: Math.min(fromByteOffset(docText, d.range.start), docLen),
      to: Math.min(fromByteOffset(docText, d.range.end), docLen),
      // CM has no "misspelling" severity; "info" + a class lets consumers
      // theme the squiggle distinctly from real errors/warnings.
      severity: 'info',
      markClass: 'cm-typst-misspelling',
      source: SPELLCHECK_SOURCE,
      message: d.message,
    });
  }

  view.dispatch(setDiagnostics(view.state, cm));
}

/**
 * Enable the engine's spellcheck and forward the consumer's personal
 * dictionary. Call once at startup; the returned function disables it again.
 *
 * The engine delegates the actual check to JS (your {@link SpellChecker}), so
 * this only toggles the feature and ships the dictionary.
 */
export function wireCoreSpellcheck(
  core: Core,
  personalDictionary: string[] = [],
): () => void {
  void core.configureSpellCheck(true, personalDictionary);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    void core.configureSpellCheck(false);
  };
}
