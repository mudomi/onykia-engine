//! Asynchronous resource lookups: Rust suspends a continuation under a
//! fresh id, JS replies later via `supply_bytes` / `supply_failure` and
//! `deliver` runs the continuation. There is no future-runtime here, so
//! a callback table is the whole story.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;

use crate::protocol::{post_fetch, to_js};

type Continuation = Box<dyn FnOnce(Result<Vec<u8>, String>)>;

thread_local! {
    static NEXT_ID: RefCell<u32> = const { RefCell::new(0) };
    static OUTSTANDING: RefCell<HashMap<u32, Continuation>> = RefCell::new(HashMap::new());
}

pub fn request<A: Serialize>(resource: &str, args: &A, on_done: Continuation) {
    let id = next_id();
    OUTSTANDING.with(|t| t.borrow_mut().insert(id, on_done));

    match to_js(args) {
        Ok(js_args) => post_fetch(id, resource, js_args),
        // Resolve in-line so the continuation is never orphaned.
        Err(err) => deliver(id, Err(format!("encode fetch args: {err}"))),
    }
}

pub fn deliver(id: u32, outcome: Result<Vec<u8>, String>) {
    if let Some(cont) = OUTSTANDING.with(|t| t.borrow_mut().remove(&id)) {
        cont(outcome);
    }
}

fn next_id() -> u32 {
    NEXT_ID.with(|cell| {
        let mut v = cell.borrow_mut();
        *v = v.wrapping_add(1);
        *v
    })
}
