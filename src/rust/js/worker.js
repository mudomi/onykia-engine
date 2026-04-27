// Worker shim: imports the wasm-bindgen loader, initialises with shared
// memory, then forwards messages between the main thread and the Rust
// state machine. Copied verbatim into example/public/assets/onykia_worker.js
// by scripts/build-wasm.sh.

import init, { State, main, handle, accept, accept_error } from './onykia_engine.js';

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.tag !== 'init') return;

  try {
    await init({ module: msg.module, memory: msg.memory });
  } catch (err) {
    self.postMessage({ tag: 'ready', id: msg.id, error: String(err) });
    return;
  }

  self.onykiaBridge = {
    postResponse:     (id, response)       => self.postMessage({ tag: 'response',     id, response }),
    postError:        (id, error)          => self.postMessage({ tag: 'response',     id, error }),
    postNotification: (name, notification) => self.postMessage({ tag: 'notification', name, notification }),
    postAsk:          (id, name, args)     => self.postMessage({ tag: 'ask',          id, name, args }),
  };

  self.__state = new State();
  main(msg.id, msg.numThreads);

  self.onmessage = (e) => {
    const m = e.data;
    if (m.tag === 'request') {
      handle(self.__state, m.id, m.name, m.args);
    } else if (m.tag === 'accept') {
      if (m.error) accept_error(m.id, m.error);
      else accept(m.id, m.output);
    }
  };
  self.postMessage({ tag: 'ready', id: msg.id });
};
