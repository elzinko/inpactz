#!/usr/bin/env bash
# Compile le moteur Rust en WebAssembly et le place dans app/pkg.
# Prérequis : rustup target add wasm32-unknown-unknown ; cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release -p tournee-wasm --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir app/pkg target/wasm32-unknown-unknown/release/tournee_wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz app/pkg/tournee_wasm_bg.wasm -o app/pkg/tournee_wasm_bg.wasm
fi
ls -la app/pkg
