// Resolved by wasm-bindgen at WASM-instantiation time, even though the
// implementations are only attached to `self.__onykia` once the worker
// shim has booted. This level of indirection is what lets us defer the
// wiring without making the imports themselves async.

export const postResult  = (id, response)        => self.__onykia.postResult(id, response);
export const postFailure = (id, error)           => self.__onykia.postFailure(id, error);
export const postSignal  = (channel, payload)    => self.__onykia.postSignal(channel, payload);
export const postFetch   = (id, resource, args)  => self.__onykia.postFetch(id, resource, args);
