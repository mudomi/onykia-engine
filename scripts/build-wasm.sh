#!/usr/bin/env bash
# Build onykia-engine's WASM binary + wasm-bindgen glue into example/public/assets.
#
# Requires: rustup with the toolchain pinned in rust-toolchain.toml, and
# wasm-bindgen-cli matching the wasm-bindgen crate version in Cargo.toml.
#
# Flags:
#   --debug     Use the debug profile (faster build, slower runtime).
#   --threads   Build with atomics + shared memory. Requires the rayon /
#               parking_lot patches noted in src/rust/Cargo.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=release
THREADED=0
for arg in "$@"; do
  case "$arg" in
    --debug)   PROFILE=debug ;;
    --threads) THREADED=1 ;;
  esac
done

OUT_DIR=example/public/assets
find "$OUT_DIR" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +

CARGO_FLAGS=()
RUSTFLAGS=
[[ $PROFILE == release ]] && CARGO_FLAGS+=(--release)
if [[ $THREADED == 1 ]]; then
  RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals"
  # build-std needed because pre-built libstd lacks atomics-enabled variants.
  CARGO_FLAGS+=(-Z build-std=std,panic_abort -Z build-std-features=panic_immediate_abort)
fi

RUSTFLAGS="$RUSTFLAGS" \
  cargo build --target wasm32-unknown-unknown -p onykia_core "${CARGO_FLAGS[@]}"

wasm-bindgen --target web --out-dir "$OUT_DIR" --out-name onykia_engine \
  "target/wasm32-unknown-unknown/$PROFILE/onykia_core.wasm"

# wasm-bindgen always appends `_bg` to the binary's basename. Drop it so
# the artefact ships as plain `onykia_engine.wasm` and patch the loader.
mv "$OUT_DIR"/onykia_engine_bg.wasm      "$OUT_DIR"/onykia_engine.wasm
mv "$OUT_DIR"/onykia_engine_bg.wasm.d.ts "$OUT_DIR"/onykia_engine.wasm.d.ts
sed -i "s|onykia_engine_bg\.wasm|onykia_engine.wasm|g" "$OUT_DIR"/onykia_engine.js

cp src/rust/js/worker.js "$OUT_DIR"/onykia_worker.js

echo "Built $OUT_DIR/onykia_engine.wasm"
