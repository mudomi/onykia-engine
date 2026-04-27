//! `ask` callbacks: async resource requests from Rust to JS.
//!
//! When the compiler needs font bytes or a package tarball it cannot fetch
//! them directly (no network in `wasm32-unknown-unknown`), so it raises an
//! `ask` message towards JS and suspends the current request. JS fetches
//! the resource and replies with `accept(id, bytes)` or `accept_error(id, msg)`.
//!
//! We don't have native async/await threading to the JS event loop here, so
//! the API is callback-based: each `ask()` registers a continuation that is
//! invoked by [`resolve`] when the reply arrives.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;

use crate::protocol::{post_ask, to_js};

type Continuation = Box<dyn FnOnce(Result<Vec<u8>, String>)>;

thread_local! {
    static NEXT_ID: RefCell<u32> = const { RefCell::new(0) };
    static PENDING: RefCell<HashMap<u32, Continuation>> = RefCell::new(HashMap::new());
}

/// Raise an ask and register a continuation. `args` is serialized to JS.
#[allow(dead_code)]
pub fn ask<A: Serialize>(name: &str, args: &A, continuation: Continuation) {
    let id = NEXT_ID.with(|cell| {
        let mut v = cell.borrow_mut();
        *v = v.wrapping_add(1);
        *v
    });

    PENDING.with(|pending| {
        pending.borrow_mut().insert(id, continuation);
    });

    let js_args = match to_js(args) {
        Ok(v) => v,
        Err(err) => {
            // Can't serialise - resolve synchronously with an error.
            complete(id, Err(format!("serialize ask args: {err}")));
            return;
        }
    };

    post_ask(id, name, js_args);
}

/// Invoked from the exported `accept` / `accept_error` wasm-bindgen entries.
pub fn resolve(id: u32, result: Result<Vec<u8>, String>) {
    complete(id, result);
}

fn complete(id: u32, result: Result<Vec<u8>, String>) {
    let cont = PENDING.with(|pending| pending.borrow_mut().remove(&id));
    if let Some(cont) = cont {
        cont(result);
    }
}
