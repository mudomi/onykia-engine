#!/usr/bin/env bash
# Build the WASM + wasm-bindgen glue into packages/engine/dist/wasm/
# (shipped in the npm tarball) and mirror to example/public/assets/.
#
# Flags: --debug
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=release
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=debug ;;
  esac
done

OUT_DIR=packages/engine/dist/wasm
EXAMPLE_DIR=example/public/assets

mkdir -p "$OUT_DIR"
find "$OUT_DIR" -mindepth 1 -exec rm -rf {} +
find "$EXAMPLE_DIR" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +

CARGO_FLAGS=()
[[ $PROFILE == release ]] && CARGO_FLAGS+=(--release)

cargo build --target wasm32-unknown-unknown -p onykia_core "${CARGO_FLAGS[@]}"

wasm-bindgen --target web --out-dir "$OUT_DIR" --out-name onykia_engine \
  "target/wasm32-unknown-unknown/$PROFILE/onykia_core.wasm"

# wasm-bindgen always appends `_bg` to the binary's basename. Drop it so
# the artefact ships as plain `onykia_engine.wasm` and patch the loader.
mv "$OUT_DIR"/onykia_engine_bg.wasm      "$OUT_DIR"/onykia_engine.wasm
mv "$OUT_DIR"/onykia_engine_bg.wasm.d.ts "$OUT_DIR"/onykia_engine.wasm.d.ts
sed -i "s|onykia_engine_bg\.wasm|onykia_engine.wasm|g" "$OUT_DIR"/onykia_engine.js

cp src/rust/js/worker.js "$OUT_DIR"/onykia_worker.js

# Mirror the artefacts into the example dev server's public assets so
# `npm run example:*` keeps working without a separate build step.
cp -r "$OUT_DIR"/. "$EXAMPLE_DIR"/

echo "Built $OUT_DIR/onykia_engine.wasm (mirrored to $EXAMPLE_DIR/)"
