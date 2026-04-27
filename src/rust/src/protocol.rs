//! JS ↔ Rust message shapes.
//!
//! Every message crosses the WASM boundary as a `JsValue`, which
//! `serde-wasm-bindgen` converts to/from these structs. Handler argument
//! structs live next to their handlers in [`crate::dispatch`]; this module
//! only holds the envelope shapes that are produced by the wasm-bindgen
//! glue ("worker.js") itself.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/js/bridge.js")]
extern "C" {
    /// Post a `{ tag: "response", id, response }` back to the main thread.
    #[wasm_bindgen(js_name = postResponse)]
    pub fn post_response(id: u32, response: JsValue);

    /// Post `{ tag: "response", id, error }`.
    #[wasm_bindgen(js_name = postError)]
    pub fn post_error(id: u32, error: &str);

    /// Emit a subscription notification - `{ tag: "notification", name, notification }`.
    #[wasm_bindgen(js_name = postNotification)]
    pub fn post_notification(name: &str, notification: JsValue);

    /// Raise an `ask` callback towards JS. JS must eventually call back into
    /// WASM via `accept` or `accept_error` with the matching id.
    #[wasm_bindgen(js_name = postAsk)]
    pub fn post_ask(id: u32, name: &str, args: JsValue);
}

/// Serialize a struct into a JS-visible `JsValue`. Uses `serde_wasm_bindgen`
/// with an object-serializer so objects become plain JS objects (not Maps).
pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue, String> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&serializer).map_err(|e| e.to_string())
}

pub fn from_js<T: for<'de> Deserialize<'de>>(value: JsValue) -> Result<T, String> {
    serde_wasm_bindgen::from_value(value).map_err(|e| e.to_string())
}
