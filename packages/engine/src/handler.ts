import type {
  AskHandler,
  HandlerOptions,
  NotifyHandler,
  NotifyName,
  WasmFactory,
} from './types.js';
import { DEFAULT_INIT_MEMORY_PAGES, DEFAULT_MAX_MEMORY_PAGES } from './wasm.js';

const ID_WRAP = 1 << 30;
// Past 16, per-thread TLS allocation dominates the parallelism gain on real
// Typst documents (rayon scales sub-linearly for our workloads).
const THREAD_CAP = 16;

export type WorkerInbox =
  | { tag: 'boot'; memory: WebAssembly.Memory; module: WebAssembly.Module; threads: number }
  | { tag: 'call'; id: number; name: string; args: unknown }
  | { tag: 'supply'; id: number; bytes?: Uint8Array; failure?: string };

export type WorkerOutbox =
  | { tag: 'result'; id: number; response: unknown; error?: string }
  | { tag: 'signal'; channel: NotifyName; payload: unknown }
  | { tag: 'fetch'; id: number; resource: string; args: unknown }
  | { tag: 'online'; error?: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Owns one worker that hosts the Typst `State` and the rayon thread pool
 * (spawned internally by `wasm-bindgen-rayon`'s `initThreadPool`). Replies
 * to `fetch` messages are posted back to the same worker — Rust-side ask
 * delivery is callback-based, so the driver is never parked.
 */
export class Handler {
  private lastId = 0;
  private inflight = new Map<number, Pending>();
  private worker!: Worker;
  private ready!: Promise<void>;
  private signalReady!: () => void;
  private rejectReady!: (err: Error) => void;

  constructor(
    private readonly factory: WasmFactory,
    private readonly askHost: AskHandler,
    private readonly notifyHost: NotifyHandler,
    private readonly options: HandlerOptions = {},
  ) {
    this.bringUp();
  }

  destroy(): void {
    if (this.options.rejectOnDestruction ?? true) {
      const err = new Error('onykia-engine: handler destroyed');
      for (const p of this.inflight.values()) p.reject(err);
    }
    this.inflight.clear();
    this.worker.terminate();
  }

  revive(): void {
    this.destroy();
    this.lastId = 0;
    this.bringUp();
  }

  dispatch<T = unknown>(name: string, args: unknown): Promise<T> {
    this.lastId = (this.lastId + 1) % ID_WRAP;
    const id = this.lastId;
    return new Promise<T>((resolve, reject) => {
      this.inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ready
        .then(() => this.worker.postMessage({ tag: 'call', id, name, args }))
        .catch(err => {
          this.inflight.delete(id);
          reject(err);
        });
    });
  }

  private bringUp(): void {
    const threads = clampThreads(this.options.numThreads);
    const memory = new WebAssembly.Memory({
      initial: this.options.initMemory ?? DEFAULT_INIT_MEMORY_PAGES,
      maximum: this.options.maxMemory ?? DEFAULT_MAX_MEMORY_PAGES,
      shared: true,
    });

    this.worker = this.factory.worker();
    this.ready = new Promise<void>((resolve, reject) => {
      this.signalReady = resolve;
      this.rejectReady = reject;
    });

    this.worker.onmessage = e => this.receive(e);
    this.worker.onerror = e => this.crash(new Error(e.message || 'onykia-engine: worker error'));

    void WebAssembly.compileStreaming(fetch(this.factory.wasmUrl))
      .then(module => this.worker.postMessage({ tag: 'boot', memory, module, threads }))
      .catch(err => this.crash(err instanceof Error ? err : new Error(String(err))));
  }

  private async receive(event: MessageEvent<WorkerOutbox>): Promise<void> {
    const msg = event.data;
    switch (msg.tag) {
      case 'result':
        this.completeCall(msg);
        return;
      case 'signal':
        this.notifyHost(msg.channel, msg.payload as never);
        return;
      case 'online':
        if (msg.error) this.crash(new Error(msg.error));
        else this.signalReady();
        return;
      case 'fetch':
        await this.satisfyFetch(msg);
        return;
    }
  }

  private completeCall(msg: Extract<WorkerOutbox, { tag: 'result' }>): void {
    const pending = this.inflight.get(msg.id);
    if (!pending) return;
    this.inflight.delete(msg.id);
    if (msg.error !== undefined) pending.reject(new Error(msg.error));
    else pending.resolve(msg.response);
  }

  private async satisfyFetch(msg: Extract<WorkerOutbox, { tag: 'fetch' }>): Promise<void> {
    try {
      const bytes = await this.askHost(msg.resource as never, msg.args as never);
      this.worker.postMessage({ tag: 'supply', id: msg.id, bytes });
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      this.worker.postMessage({ tag: 'supply', id: msg.id, failure });
    }
  }

  private crash(err: Error): void {
    this.rejectReady(err);
    for (const p of this.inflight.values()) p.reject(err);
    this.inflight.clear();
    this.notifyHost('status', { status: 'crashed', message: err.message } as never);
  }
}

function clampThreads(requested: number | undefined): number {
  if (requested === undefined) return defaultThreadCount();
  const n = Math.floor(requested);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, THREAD_CAP);
}

function defaultThreadCount(): number {
  if (typeof navigator === 'undefined') return 4;
  return Math.min(navigator.hardwareConcurrency || 4, THREAD_CAP);
}
