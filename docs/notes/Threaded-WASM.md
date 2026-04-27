# Threaded WASM build

The default build is single-threaded — `wasm32-unknown-unknown` with the upstream rayon and parking_lot from crates.io.

A threaded build adds atomics, bulk-memory, and mutable-globals target features and switches in atomics-aware forks of rayon and parking_lot. It enables Typst's parallel layout / shaping paths in the browser, but requires `SharedArrayBuffer` and cross-origin isolation (`COOP: same-origin`, `COEP: require-corp`) on whatever serves the page. The example Vite configs already set those headers; production hosts must replicate them.

To opt in, run:

```
bash scripts/build-wasm.sh --threads
```

That sets `RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals"` and passes `-Z build-std` so the standard library is rebuilt with atomics enabled.

The script does *not* automatically apply the `[patch.crates-io]` entries that some Typst versions need. If `cargo build --threads` complains about non-atomics-aware rayon or parking_lot, drop the following block into the workspace `Cargo.toml` (then `cargo update -p rayon -p parking_lot`):

```toml
[patch.crates-io]
rayon       = { git = "https://github.com/chriskrycho/rayon",     rev = "ea74db4" }
parking_lot = { git = "https://github.com/RReverser/parking_lot", rev = "3e5ac2a" }
```

Pin the revs you actually validate against; both forks track upstream loosely.
