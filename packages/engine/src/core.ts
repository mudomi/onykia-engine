import { Handler } from './handler.js';
import type {
  AskArgs,
  AskHandler,
  AutocompleteResult,
  DefinitionResult,
  ExportResult,
  ExportTarget,
  HandlerOptions,
  HighlightResult,
  JumpResult,
  NotifyName,
  NotifyPayloads,
  RenderResult,
  TagsResult,
  TooltipResult,
  WasmFactory,
} from './types.js';

export interface CoreOptions {
  wasm: WasmFactory;
  font?: (file: string) => Promise<Uint8Array | ArrayBuffer>;
  package?: (
    namespace: string,
    name: string,
    version: string,
  ) => Promise<Uint8Array | ArrayBuffer>;
  spellcheck?: (
    word: string,
    lang: string,
    region: string,
  ) => Promise<boolean>;
  handlerOptions?: HandlerOptions;
}

/**
 * Every call that mutates compiler state also triggers an implicit
 * recompilation inside the worker. Consumers receive results through
 * `onStatus` / `onDiagnostics` / `onPages` / `onOutline` subscriptions.
 */
export class Core {
  private handler: Handler;
  private listeners = new Map<NotifyName, Set<(payload: unknown) => void>>();
  private subscribedChannels = new Set<NotifyName>();

  constructor(options: CoreOptions) {
    const ask: AskHandler = async (name, args) => {
      switch (name) {
        case 'font': {
          if (!options.font) throw new Error('no font loader configured');
          const a = args as AskArgs['font'];
          const bytes = await options.font(a.file);
          return toU8(bytes);
        }
        case 'package': {
          if (!options.package) throw new Error('no package loader configured');
          const a = args as AskArgs['package'];
          const bytes = await options.package(a.namespace, a.name, a.version);
          return toU8(bytes);
        }
        case 'spellcheck': {
          if (!options.spellcheck) return new Uint8Array([1]);
          const a = args as AskArgs['spellcheck'];
          const ok = await options.spellcheck(a.word, a.lang, a.region);
          return new Uint8Array([ok ? 1 : 0]);
        }
      }
    };

    const notify = <K extends NotifyName>(name: K, payload: NotifyPayloads[K]) => {
      const set = this.listeners.get(name);
      if (!set) return;
      for (const fn of set) fn(payload as unknown);
    };

    this.handler = new Handler(options.wasm, ask, notify, options.handlerOptions);
  }

  // ─── subscriptions ─────────────────────────────────────────────────────

  on<K extends NotifyName>(name: K, fn: (payload: NotifyPayloads[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn as (p: unknown) => void);
    if (!this.subscribedChannels.has(name)) {
      this.subscribedChannels.add(name);
      void this.handler.dispatch('subscribe', { name }).catch((err: Error) => {
        if (!err.message.includes('destroyed')) console.error('[onykia] subscribe failed:', err);
      });
    }
    return () => this.off(name, fn);
  }

  off<K extends NotifyName>(name: K, fn: (payload: NotifyPayloads[K]) => void): void {
    this.listeners.get(name)?.delete(fn as (p: unknown) => void);
  }

  onStatus(fn: (p: NotifyPayloads['status']) => void) { return this.on('status', fn); }
  onDiagnostics(fn: (p: NotifyPayloads['diagnostics']) => void) { return this.on('diagnostics', fn); }
  onPages(fn: (p: NotifyPayloads['pages']) => void) { return this.on('pages', fn); }
  onOutline(fn: (p: NotifyPayloads['outline']) => void) { return this.on('outline', fn); }

  // ─── filesystem ────────────────────────────────────────────────────────

  create(path: string, mime: string, data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.handler.dispatch('create', { path, mime, data: bytes });
  }

  edit(path: string, edits: { range: { start: number; end: number }; replacement: string }[]): Promise<void> {
    return this.handler.dispatch('edit', { path, edits });
  }

  move(from: string, to: string, mime?: string): Promise<void> {
    return this.handler.dispatch('move', { from, to, mime });
  }

  delete(path: string): Promise<void> {
    return this.handler.dispatch('delete', { path });
  }

  clear(): Promise<void> {
    return this.handler.dispatch('clear', {});
  }

  // ─── compiler config ───────────────────────────────────────────────────

  setTarget(target: ExportTarget): Promise<void> {
    return this.handler.dispatch('setTarget', { target });
  }

  setMain(path: string, silent = false): Promise<void> {
    return this.handler.dispatch('setMain', { path, silent });
  }

  setFeatures(features: string[]): Promise<void> {
    return this.handler.dispatch('setFeatures', { features });
  }

  setProjectId(id: string): Promise<void> {
    return this.handler.dispatch('setProjectId', { id });
  }

  /** Register a font file (TTF/OTF, may contain multiple faces). */
  addFont(data: Uint8Array): Promise<void> {
    return this.handler.dispatch('addFont', { data });
  }

  /** Register multiple font files in one round-trip, rebuilding the font book once. */
  addFonts(fonts: Uint8Array[]): Promise<void> {
    return this.handler.dispatch('addFonts', { fonts });
  }

  setRemotePackages(data: Uint8Array, privateNamespaces: { namespace: string; data: Uint8Array }[] = []): Promise<void> {
    return this.handler.dispatch('setRemotePackages', { data, privateNamespaces });
  }

  configureSpellCheck(enabled: boolean, personalDictionary: string[] = []): Promise<void> {
    return this.handler.dispatch('configureSpellCheck', { enabled, personalDictionary });
  }

  // ─── IDE features ──────────────────────────────────────────────────────

  tags(): Promise<TagsResult> {
    return this.handler.dispatch('tags', {});
  }

  syntaxTree(path: string): Promise<unknown> {
    return this.handler.dispatch('syntaxTree', { path });
  }

  async highlight(path: string): Promise<HighlightResult> {
    const res = await this.handler.dispatch<{ data: number[] | Uint32Array }>('highlight', { path });
    const data = res.data instanceof Uint32Array ? res.data : Uint32Array.from(res.data);
    return { data };
  }

  autocomplete(path: string, cursor: number, explicit = false): Promise<AutocompleteResult | null> {
    return this.handler.dispatch('autocomplete', { path, cursor, explicit });
  }

  tooltip(path: string, cursor: number, side: -1 | 1 = 1): Promise<TooltipResult | null> {
    return this.handler.dispatch('tooltip', { path, cursor, side });
  }

  definition(path: string, cursor: number, side: -1 | 1 = 1): Promise<DefinitionResult | null> {
    return this.handler.dispatch('definition', { path, cursor, side });
  }

  async jumpFromCursor(path: string, cursor: number): Promise<JumpResult[]> {
    const out = await this.handler.dispatch<JumpResult[] | null>('jumpFromCursor', {
      path,
      cursor,
    });
    return out ?? [];
  }

  jumpFromClick(args: { index: number; x: number; y: number }): Promise<JumpResult | null> {
    return this.handler.dispatch('jumpFromClick', args);
  }

  // ─── export ────────────────────────────────────────────────────────────

  export(args: Record<string, unknown> & { format: string }): Promise<ExportResult> {
    return this.handler.dispatch('export', args);
  }

  render(index: number, zoom: number): Promise<RenderResult> {
    return this.handler.dispatch('render', { index, zoom });
  }

  archive(format: 'zip' = 'zip'): Promise<{ data: Uint8Array; mime: string }> {
    return this.handler.dispatch('archive', { format });
  }

  eval(expr: string): Promise<unknown> {
    return this.handler.dispatch('eval', { expr });
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  destroy(): void {
    this.handler.destroy();
  }

  revive(): void {
    this.subscribedChannels.clear();
    this.handler.revive();
  }
}

function toU8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
