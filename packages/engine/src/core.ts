import { Handler } from './handler.js';
import type {
  AskArgs,
  AskHandler,
  AutocompleteResult,
  DefinitionResult,
  ExportResult,
  ExportTarget,
  FontStub,
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
  package?: (
    namespace: string,
    name: string,
    version: string,
  ) => Promise<Uint8Array | ArrayBuffer>;
  /** `key` is the opaque identifier supplied with the stub via `addFontStubs`. */
  font?: (key: string) => Promise<Uint8Array | ArrayBuffer>;
  handlerOptions?: HandlerOptions;
}

export class Core {
  private handler: Handler;
  private listeners = new Map<NotifyName, Set<(payload: unknown) => void>>();
  private subscribedChannels = new Set<NotifyName>();
  private replayOps: { name: string; args: unknown }[] = [];

  constructor(options: CoreOptions) {
    const ask: AskHandler = async (name, args) => {
      switch (name) {
        case 'package': {
          if (!options.package) throw new Error('no package loader configured');
          const { namespace, name, version } = args as AskArgs['package'];
          const bytes = await options.package(namespace, name, version);
          return toU8(bytes);
        }
        case 'font': {
          if (!options.font) throw new Error('no font loader configured');
          const { key } = args as AskArgs['font'];
          const bytes = await options.font(key);
          return toU8(bytes);
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
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(fn as (p: unknown) => void);
    if (set.size > 0) return;

    this.listeners.delete(name);
    if (!this.subscribedChannels.delete(name)) return;
    void this.handler.dispatch('unsubscribe', { name }).catch((err: Error) => {
      if (!err.message.includes('destroyed')) console.error('[onykia] unsubscribe failed:', err);
    });
  }

  onStatus(fn: (p: NotifyPayloads['status']) => void) { return this.on('status', fn); }
  onDiagnostics(fn: (p: NotifyPayloads['diagnostics']) => void) { return this.on('diagnostics', fn); }
  onPages(fn: (p: NotifyPayloads['pages']) => void) { return this.on('pages', fn); }
  onOutline(fn: (p: NotifyPayloads['outline']) => void) { return this.on('outline', fn); }

  create(path: string, mime: string, data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.dispatchStateful('create', { path, mime, data: bytes });
  }

  edit(path: string, edits: { range: { start: number; end: number }; replacement: string }[]): Promise<void> {
    return this.dispatchStateful('edit', { path, edits });
  }

  move(from: string, to: string, mime?: string): Promise<void> {
    return this.dispatchStateful('move', { from, to, mime });
  }

  delete(path: string): Promise<void> {
    return this.dispatchStateful('delete', { path });
  }

  clear(): Promise<void> {
    return this.dispatchStateful('clear', {});
  }

  setTarget(target: ExportTarget): Promise<void> {
    return this.dispatchStateful('setTarget', { target });
  }

  setMain(path: string, silent = false): Promise<void> {
    return this.dispatchStateful('setMain', { path, silent });
  }

  /** Register a font file (TTF/OTF, may contain multiple faces). */
  addFont(data: Uint8Array): Promise<void> {
    return this.dispatchStateful('addFont', { data });
  }

  addFonts(fonts: Uint8Array[]): Promise<void> {
    return this.dispatchStateful('addFonts', { fonts });
  }

  // Stubs visible in autocomplete immediately; binary fetched lazily via CoreOptions.font.
  addFontStubs(stubs: FontStub[]): Promise<void> {
    return this.dispatchStateful('addFontStubs', { stubs });
  }

  setRemotePackages(data: Uint8Array, privateNamespaces: { namespace: string; data: Uint8Array }[] = []): Promise<void> {
    return this.dispatchStateful('setRemotePackages', { data, privateNamespaces });
  }

  configureSpellCheck(enabled: boolean, personalDictionary: string[] = []): Promise<void> {
    return this.dispatchStateful('configureSpellCheck', { enabled, personalDictionary });
  }

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

  export(args: Record<string, unknown> & { format: string }): Promise<ExportResult> {
    return this.handler.dispatch('export', args);
  }

  render(index: number, zoom: number): Promise<RenderResult> {
    return this.handler.dispatch('render', { index, zoom });
  }

  archive(format: 'zip' = 'zip'): Promise<{ data: Uint8Array; mime: string }> {
    return this.handler.dispatch('archive', { format });
  }

  destroy(): void {
    this.handler.destroy();
  }

  revive(): void {
    this.handler.revive();
    this.subscribedChannels.clear();
    void this.replayAfterRevive();
  }

  async eval(expr: string): Promise<unknown> {
    const value = await this.handler.dispatch('eval', { expr });
    if (value === null) {
      throw new Error('eval not implemented');
    }
    return value;
  }

  private async dispatchStateful<T>(name: string, args: unknown): Promise<T> {
    const result = await this.handler.dispatch<T>(name, args);
    this.replayOps.push({ name, args: cloneValue(args) });
    return result;
  }

  private async replayAfterRevive(): Promise<void> {
    for (const op of this.replayOps) {
      try {
        await this.handler.dispatch(op.name, cloneValue(op.args));
      } catch (err) {
        if (err instanceof Error && err.message.includes('destroyed')) return;
        console.error(`[onykia] replay failed for ${op.name}:`, err);
      }
    }

    for (const [name, set] of this.listeners.entries()) {
      if (set.size === 0) continue;
      this.subscribedChannels.add(name);
      try {
        await this.handler.dispatch('subscribe', { name });
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('destroyed')) {
          console.error('[onykia] subscribe failed after revive:', err);
        }
      }
    }
  }
}

function toU8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(v => cloneValue(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneValue(v);
    }
    return out as T;
  }
  return value;
}
