#!/usr/bin/env bash
# Build the WebAssembly module and its JS glue into web/pkg.
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${1:-release}"
if [ "$PROFILE" = "release" ]; then
  cargo build -p unflash-wasm --target wasm32-unknown-unknown --release
  WASM=target/wasm32-unknown-unknown/release/unflash_wasm.wasm
else
  cargo build -p unflash-wasm --target wasm32-unknown-unknown
  WASM=target/wasm32-unknown-unknown/debug/unflash_wasm.wasm
fi
mkdir -p web/pkg
wasm-bindgen --target web --out-dir web/pkg --out-name unflash "$WASM"
if command -v wasm-opt >/dev/null 2>&1 && [ "$PROFILE" = "release" ]; then
  wasm-opt -O3 --enable-simd -o web/pkg/unflash_bg.wasm web/pkg/unflash_bg.wasm
fi
ls -la web/pkg
