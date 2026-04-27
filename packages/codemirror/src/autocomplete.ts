import {
  autocompletion,
  type Completion as CMCompletion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
  startCompletion,
} from '@codemirror/autocomplete';
import type { Completion, CompletionKind, Core } from '@mudomi/onykia-engine';
import { fromByteOffset, toByteOffset } from './offsets.js';

export function autocompleteExtension(core: Core, path: string) {
  return autocompletion({
    maxRenderedOptions: 350,
    override: [
      async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const docText = ctx.state.doc.toString();
        let result;
        try {
          result = await core.autocomplete(path, toByteOffset(docText, ctx.pos), ctx.explicit);
        } catch {
          return null;
        }
        if (!result || result.completions.length === 0) return null;

        let syntaxIdx = 0;
        const options: CMCompletion[] = [];
        for (const c of result.completions) {
          options.push(toCMCompletion(c, syntaxIdx));
          if (c.kind === 'syntax') syntaxIdx++;
        }
        return { from: fromByteOffset(docText, result.from), options, validFor: /[\w:-]*/ };
      },
    ],
  });
}

function toCMCompletion(c: Completion, syntaxIdx: number): CMCompletion {
  const base = {
    label: c.label,
    detail: c.detail,
    type: kindToType(c.kind),
    boost: c.boost ?? defaultBoost(c.kind, syntaxIdx),
  };

  if (c.apply && c.apply.includes('${')) {
    const reTriggerAfter =
      /\${\w*}/.exec(c.apply)?.[0] === '${}' &&
      !(c.kind === 'syntax' && c.label === 'linebreak');
    const snip = snippetCompletion(c.apply, base);
    if (!reTriggerAfter) return snip;
    const originalApply = snip.apply!;
    return {
      ...snip,
      apply: (view, completion, from, to) => {
        (originalApply as (v: unknown, c: CMCompletion, f: number, t: number) => void)(
          view,
          completion,
          from,
          to,
        );
        startCompletion(view);
      },
    };
  }

  return { ...base, apply: c.apply ?? c.label };
}

function kindToType(kind: CompletionKind): string {
  const map: Record<CompletionKind, string> = {
    func: 'function',
    param: 'variable',
    type: 'type',
    constant: 'constant',
    syntax: 'keyword',
    label: 'text',
    font: 'text',
    package: 'namespace',
    path: 'text',
    symbol: 'text',
  };
  return map[kind] ?? 'text';
}

function defaultBoost(kind: CompletionKind, syntaxIdx: number): number {
  const table: Record<CompletionKind, number> = {
    symbol: 0,
    constant: 1,
    type: 2,
    func: 3,
    param: 4,
    syntax: 95 - syntaxIdx,
    label: 96,
    font: 97,
    package: 98,
    path: 99,
  };
  return table[kind] ?? 0;
}
