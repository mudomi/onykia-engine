//! Outbound bridge calls + serde ↔ JsValue helpers.
//!
//! Wire tags (`result`, `signal`, `fetch`, …) are produced inside the JS
//! shim; Rust only supplies the payload fields.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/js/bridge.js")]
extern "C" {
    #[wasm_bindgen(js_name = postResult)]
    pub fn post_result(id: u32, response: JsValue);

    #[wasm_bindgen(js_name = postFailure)]
    pub fn post_failure(id: u32, error: &str);

    #[wasm_bindgen(js_name = postSignal)]
    pub fn post_signal(channel: &str, payload: JsValue);

    #[wasm_bindgen(js_name = postFetch)]
    pub fn post_fetch(id: u32, resource: &str, args: JsValue);
}

/// JS plain object, never Map - the worker shim accesses fields by name.
pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue, String> {
    let s = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&s).map_err(|e| e.to_string())
}

pub fn from_js<T: for<'de> Deserialize<'de>>(value: JsValue) -> Result<T, String> {
    serde_wasm_bindgen::from_value(value).map_err(|e| e.to_string())
}
