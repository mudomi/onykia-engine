//! Asynchronous resource lookups: Rust suspends a continuation under a
//! fresh id, JS replies later via `supply_bytes` / `supply_failure` and
//! `deliver` runs the continuation against the live `State`.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;

use crate::protocol::{post_fetch, to_js};
use crate::state::State;

pub type Continuation = Box<dyn FnOnce(&mut State, Result<Vec<u8>, String>)>;

thread_local! {
    static NEXT_ID: RefCell<u32> = const { RefCell::new(0) };
    static OUTSTANDING: RefCell<HashMap<u32, Continuation>> = RefCell::new(HashMap::new());
}

/// Schedule `on_done` to run when the named resource arrives. Errors out
/// synchronously when `args` can't be encoded for JS — caller must clean up
/// any in-flight bookkeeping it staged before this call.
pub fn request<A: Serialize>(
    resource: &str,
    args: &A,
    on_done: Continuation,
) -> Result<(), String> {
    let js_args = to_js(args).map_err(|e| format!("encode fetch args: {e}"))?;
    let id = next_id();
    OUTSTANDING.with(|t| t.borrow_mut().insert(id, on_done));
    post_fetch(id, resource, js_args);
    Ok(())
}

pub fn deliver(state: &mut State, id: u32, outcome: Result<Vec<u8>, String>) {
    if let Some(cont) = OUTSTANDING.with(|t| t.borrow_mut().remove(&id)) {
        cont(state, outcome);
    }
}

fn next_id() -> u32 {
    NEXT_ID.with(|cell| {
        let mut v = cell.borrow_mut();
        *v = v.wrapping_add(1);
        *v
    })
}
