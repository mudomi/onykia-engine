import type {
  AskHandler,
  HandlerOptions,
  NotifyHandler,
  NotifyName,
  WasmFactory,
} from './types.js';

// IDs wrap at u32 boundary to stay in sync with the Rust side (id: u32).
const MAX_ID = 2 ** 32;

export type MainToWorker =
  | { tag: 'init'; id: number; memory: WebAssembly.Memory; module: WebAssembly.Module; numThreads: number }
  | { tag: 'request'; id: number; name: string; args: unknown }
  | { tag: 'accept'; id: number; output?: Uint8Array; error?: string };

export type WorkerToMain =
  | { tag: 'response'; id: number; response: unknown; error?: string }
  | { tag: 'notification'; name: NotifyName; notification: unknown }
  | { tag: 'ask'; id: number; name: string; args: unknown }
  | { tag: 'ready'; id: number; error?: string };

/**
 * Worker-pool manager and message bus.
 *
 * Spawns one main worker (runs compilation), one dedicated acceptor worker
 * (handles `ask` replies to avoid deadlock), and N shared pool workers that
 * mount the same SharedArrayBuffer-backed memory.
 */
export class Handler {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private main!: Worker;
  private acceptor!: Worker;
  private pool: Worker[] = [];
  private modulePromise: Promise<WebAssembly.Module>;
  private memory!: WebAssembly.Memory;
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    private factory: WasmFactory,
    private ask: AskHandler,
    private notify: NotifyHandler,
    private options: HandlerOptions = {},
  ) {
    this.modulePromise = WebAssembly.compileStreaming(fetch(factory.wasmUrl));
    this.init();
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>(r => { this.resolveReady = r; });
  }

  private init(): void {
    const numThreads =
      this.options.numThreads ??
      Math.min(
        typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
        16,
      );

    this.main = this.factory.worker();
    this.acceptor = this.factory.worker();
    // +1 ensures at least one idle worker for rayon's work-stealing in threaded builds.
    this.pool = Array.from({ length: numThreads + 1 }, () => this.factory.worker());

    this.memory = new WebAssembly.Memory({
      initial: this.options.initMemory ?? 256,
      maximum: this.options.maxMemory ?? 65536,
      shared: true,
    });

    this.resetReady();

    const onMessage = (event: MessageEvent<WorkerToMain>) => this.onMessage(event);
    const onError = (e: ErrorEvent) => console.error('[onykia] worker error:', e.message, e);
    this.main.onmessage = onMessage;
    this.main.onerror = onError;
    this.acceptor.onmessage = onMessage;
    this.acceptor.onerror = onError;
    for (const w of this.pool) { w.onmessage = onMessage; w.onerror = onError; }

    this.modulePromise
      .then((module) => {
        const initWorker = (id: number, worker: Worker) => {
          const msg: MainToWorker = { tag: 'init', id, memory: this.memory, module, numThreads };
          worker.postMessage(msg);
        };
        initWorker(0, this.main);
        initWorker(1, this.acceptor);
        this.pool.forEach((w, i) => initWorker(2 + i, w));
      })
      .catch(err => console.error('[onykia] WASM compile failed:', err));
  }

  destroy(): void {
    if (this.options.rejectOnDestruction ?? true) {
      for (const { reject } of this.pending.values()) {
        reject(new Error('onykia-engine: handler destroyed'));
      }
    }
    this.pending.clear();
    this.main.terminate();
    this.acceptor.terminate();
    for (const w of this.pool) w.terminate();
  }

  revive(): void {
    this.destroy();
    this.nextId = 0;
    this.init();
  }

  dispatch<T = unknown>(name: string, args: unknown): Promise<T> {
    this.nextId = (this.nextId + 1) % MAX_ID;
    const id = this.nextId;
    const msg: MainToWorker = { tag: 'request', id, name, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // Buffer until the main worker (id=0) signals ready; pool/acceptor workers
      // may initialise first but don't handle requests.
      void this.readyPromise.then(() => this.main.postMessage(msg));
    });
  }

  private async onMessage(event: MessageEvent<WorkerToMain>): Promise<void> {
    const data = event.data;
    switch (data.tag) {
      case 'response': {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.error !== undefined) pending.reject(new Error(data.error));
        else pending.resolve(data.response);
        return;
      }
      case 'notification': {
        this.notify(data.name as NotifyName, data.notification as never);
        return;
      }
      case 'ready': {
        if (data.error) console.error('[onykia] worker init failed (id', data.id, '):', data.error);
        if (data.id === 0) this.resolveReady();
        return;
      }
      case 'ask': {
        try {
          const output = await this.ask(data.name as never, data.args as never);
          const reply: MainToWorker = { tag: 'accept', id: data.id, output };
          this.acceptor.postMessage(reply);
        } catch (err) {
          const reply: MainToWorker = {
            tag: 'accept',
            id: data.id,
            error: err instanceof Error ? err.message : String(err),
          };
          this.acceptor.postMessage(reply);
        }
        return;
      }
    }
  }
}
