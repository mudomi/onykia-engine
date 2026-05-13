#!/usr/bin/env bash
# Build the threaded Onykia WASM into packages/engine/dist/wasm/ (npm tarball)
# and mirror to example/public/assets/.
#

set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=release
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=debug ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

OUT=packages/engine/dist/wasm
EXAMPLE=example/public/assets
WORKER_SHIM=src/rust/js/worker.js

mkdir -p "$OUT"
mkdir -p "$EXAMPLE"
find "$OUT" -mindepth 1 -exec rm -rf {} +
find "$EXAMPLE" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +

cargo_flags=()
[[ $PROFILE == release ]] && cargo_flags+=(--release)

rustup toolchain install nightly --profile minimal --component rust-src --target wasm32-unknown-unknown >/dev/null

# Atomics + shared memory + TLS exports required by wasm-bindgen-rayon 1.3.
# +mutable-globals was dropped upstream in 1.3.0 and is no longer needed.
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory \
  -C link-arg=--shared-memory -C link-arg=--max-memory=1073741824 -C link-arg=--import-memory \
  -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
  -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"

target_dir="target/wasm32-unknown-unknown/$PROFILE"

RUSTUP_TOOLCHAIN=nightly RUSTFLAGS="$RUSTFLAGS" \
  cargo build --target wasm32-unknown-unknown -p onykia_core "${cargo_flags[@]}" \
    -Z build-std=panic_abort,std

wasm-bindgen --target web --out-dir "$OUT" --out-name onykia_engine \
  "$target_dir/onykia_core.wasm"

# wasm-bindgen suffixes the binary with `_bg`; drop it and patch the loader.
mv "$OUT"/onykia_engine_bg.wasm      "$OUT"/onykia_engine.wasm
mv "$OUT"/onykia_engine_bg.wasm.d.ts "$OUT"/onykia_engine.wasm.d.ts
sed -i "s|onykia_engine_bg\.wasm|onykia_engine.wasm|g" "$OUT"/onykia_engine.js

# wasm-bindgen-rayon's workerHelpers.js dynamically imports the parent entry
# as `'../../..'` - bundler-style directory resolution. Native browser ESM
# (and Vite's static asset path) won't resolve that, so the rayon worker pool
# fails to boot. Rewrite to the actual entry file.
find "$OUT/snippets" -name workerHelpers.js -exec \
  sed -i "s|import('../../..')|import('../../../onykia_engine.js')|g" {} +

cp "$WORKER_SHIM" "$OUT"/onykia_worker.js
cp -r "$OUT"/. "$EXAMPLE"/

echo "Built $OUT/onykia_engine.wasm"
