// Small helpers the Rust side imports through wasm-bindgen's #[wasm_bindgen(module)].
// The runtime (worker.js) defines `self.onykiaBridge` with `postResponse`,
// `postError`, `postNotification`, `postAsk`. We forward through.

export function postResponse(id, response) {
  self.onykiaBridge.postResponse(id, response);
}
export function postError(id, error) {
  self.onykiaBridge.postError(id, error);
}
export function postNotification(name, notification) {
  self.onykiaBridge.postNotification(name, notification);
}
export function postAsk(id, name, args) {
  self.onykiaBridge.postAsk(id, name, args);
}
