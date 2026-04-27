mod ask;
mod dispatch;
mod protocol;
mod state;
mod vfs;
mod world;

use wasm_bindgen::prelude::*;

pub use state::State;

#[wasm_bindgen]
pub fn main(_id: u32, _num_threads: u32) {
    #[cfg(feature = "panic-hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn handle(state: &mut State, id: u32, name: &str, args: JsValue) {
    dispatch::dispatch(state, id, name, args);
}

#[wasm_bindgen]
pub fn accept(id: u32, data: &[u8]) {
    ask::resolve(id, Ok(data.to_vec()));
}

#[wasm_bindgen]
pub fn accept_error(id: u32, error: &str) {
    ask::resolve(id, Err(error.to_string()));
}
