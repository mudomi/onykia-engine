//! WASM entry points exposed to the worker shim (`src/rust/js/worker.js`).

mod ask;
mod dispatch;
mod packages;
mod protocol;
mod state;
mod vfs;
mod world;

use wasm_bindgen::prelude::*;

pub use state::State;
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen]
pub fn bootstrap() {
    #[cfg(feature = "panic-hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn dispatch_call(state: &mut State, id: u32, name: &str, args: JsValue) {
    dispatch::dispatch(state, id, name, args);
}

#[wasm_bindgen]
pub fn supply_bytes(state: &mut State, id: u32, data: &[u8]) {
    ask::deliver(state, id, Ok(data.to_vec()));
}

#[wasm_bindgen]
pub fn supply_failure(state: &mut State, id: u32, error: &str) {
    ask::deliver(state, id, Err(error.to_string()));
}
