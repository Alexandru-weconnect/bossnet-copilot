#!/bin/bash
# Cross-compile Bossnet Copilot .exe pentru Windows (target x86_64-pc-windows-msvc)
# de pe Linux, fara root. Foloseste cargo-xwin + llvm-mingw.
#
# Preconditii (one-time):
#   cargo install cargo-xwin --root ~/.local
#   curl -L -o /tmp/llvm-mingw.tar.xz https://github.com/mstorsjo/llvm-mingw/releases/download/20250910/llvm-mingw-20250910-ucrt-ubuntu-22.04-x86_64.tar.xz
#   mkdir -p ~/.local/toolchains && cd ~/.local/toolchains && python3 -c "import lzma,tarfile; tarfile.open(fileobj=lzma.open('/tmp/llvm-mingw.tar.xz')).extractall('.')"
#   rustup target add x86_64-pc-windows-msvc
#
# Usage: bash scripts/build-windows-local.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$HOME/.local/toolchains/llvm-mingw-20250910-ucrt-ubuntu-22.04-x86_64/bin"
CARGO_TMP="$HOME/.cargo-tmp"
TARGET_DIR="$CARGO_TMP/desktop-target"
LIBSTDCXX="/usr/lib64/c++-plesk-13.2.0/lib64"

if [[ ! -d "$TC" ]]; then
  echo "!! llvm-mingw missing: $TC"
  echo "!! see header of this script for install steps"
  exit 1
fi

export PATH="$TC:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$LIBSTDCXX:${LD_LIBRARY_PATH:-}"
export TMPDIR="$CARGO_TMP"
export CARGO_TARGET_DIR="$TARGET_DIR"

mkdir -p "$CARGO_TMP"

cd "$ROOT/desktop"
[[ -d node_modules ]] || npm install

cargo xwin build --release --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml

EXE_SRC="$TARGET_DIR/x86_64-pc-windows-msvc/release/bossnet-copilot.exe"
[[ -f "$EXE_SRC" ]] || { echo "!! exe missing at $EXE_SRC"; exit 2; }

mkdir -p "$ROOT/dist"
cp "$EXE_SRC" "$ROOT/dist/bossnet-copilot-windows-x64.exe"

echo "ok -> $ROOT/dist/bossnet-copilot-windows-x64.exe ($(du -h "$EXE_SRC" | cut -f1))"
