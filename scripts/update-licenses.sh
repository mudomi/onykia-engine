#!/usr/bin/env bash
# Regenerate THIRD-PARTY-LICENSES.txt from the Rust dependency graph.
#
# Sources:
#   - cargo about (per-crate license metadata + canonical SPDX texts)
#   - cargo metadata (locates the typst-assets NOTICE file)
#   - scripts/license-appendix.txt (Typst-internal upstream texts)
#
# Run with `--check` in CI to fail when the committed file is stale.

set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

# cargo-about releases differ in which file they pick as a crate's license
# text, so the output is only reproducible for one version. CI installs the
# same one (see .github/workflows/ci.yml).
CARGO_ABOUT_VERSION=0.9.0

if ! command -v cargo-about >/dev/null 2>&1; then
  echo "error: cargo-about is not installed. Run: cargo install cargo-about@$CARGO_ABOUT_VERSION --locked" >&2
  exit 2
fi

INSTALLED=$(cargo about --version | awk '{print $2}')
if [[ "$INSTALLED" != "$CARGO_ABOUT_VERSION" ]]; then
  echo "error: cargo-about $INSTALLED found, $CARGO_ABOUT_VERSION required. Run: cargo install cargo-about@$CARGO_ABOUT_VERSION --locked --force" >&2
  exit 2
fi

OUT=THIRD-PARTY-LICENSES.txt
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cargo about generate \
  --config about.toml \
  --manifest-path src/rust/Cargo.toml \
  --format=json \
  | python3 scripts/render_licenses.py \
  > "$TMP"

if [[ $CHECK -eq 1 ]]; then
  if ! diff -q "$OUT" "$TMP" >/dev/null 2>&1; then
    echo "error: $OUT is stale. Run scripts/update-licenses.sh and commit." >&2
    diff -u "$OUT" "$TMP" || true
    exit 1
  fi
  echo "$OUT is up to date."
else
  mv "$TMP" "$OUT"
  trap - EXIT
  echo "$OUT regenerated."
fi
