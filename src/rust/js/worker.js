// Driver worker. Loads the WASM module against the main thread's shared
// memory, bootstraps the rayon thread pool via wasm-bindgen-rayon, then
// services dispatch + supply messages.
import init, * as wasm from './onykia_engine.js';

let state = null;

self.onmessage = onBoot;

async function onBoot(event) {
  const msg = event.data;
  if (msg?.tag !== 'boot') return;

  try {
    await init({ module: msg.module, memory: msg.memory });

    // Resolved by the wasm-bindgen `module = "/js/bridge.js"` imports.
    self.__onykia = {
      postResult:  (id, response)        => self.postMessage({ tag: 'result',  id, response }),
      postFailure: (id, error)           => self.postMessage({ tag: 'result',  id, error }),
      postSignal:  (channel, payload)    => self.postMessage({ tag: 'signal',  channel, payload }),
      postFetch:   (id, resource, args)  => self.postMessage({ tag: 'fetch',   id, resource, args }),
    };

    wasm.bootstrap();

    await wasm.initThreadPool(msg.threads);
    state = new wasm.State();
  } catch (err) {
    self.postMessage({ tag: 'online', error: String(err) });
    return;
  }

  self.onmessage = onRunning;
  self.postMessage({ tag: 'online' });
}

function onRunning(event) {
  const m = event.data;
  switch (m.tag) {
    case 'call':
      try { wasm.dispatch_call(state, m.id, m.name, m.args); }
      catch (err) { crash(err); }
      return;
    case 'supply':
      if (m.failure !== undefined) wasm.supply_failure(m.id, m.failure);
      else wasm.supply_bytes(m.id, m.bytes);
      return;
  }
}

function crash(err) {
  console.error('[onykia/driver]', err);
  self.onmessage = null;
  self.postMessage({
    tag: 'signal',
    channel: 'status',
    payload: { status: 'crashed', message: err instanceof Error ? err.message : String(err) },
  });
}
