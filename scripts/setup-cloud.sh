#!/bin/sh
set -eu

version="v0.9.0"
case "$(uname -m)" in
  x86_64|amd64)
    archive="codebase-memory-mcp-linux-amd64.tar.gz"
    checksum="e2832a8d207c26beaa30efa6222ed4a37cb3f526ca4bee060bfbf336ed6fc679"
    ;;
  aarch64|arm64)
    archive="codebase-memory-mcp-linux-arm64.tar.gz"
    checksum="68a345d9a6842f02a3cb07e187b28bc38c4f3a22967f47fadbcd0757ba93a680"
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
url="https://github.com/DeusData/codebase-memory-mcp/releases/download/$version/$archive"
curl -fsSL "$url" -o "$tmp_dir/$archive"
printf "%s  %s\n" "$checksum" "$tmp_dir/$archive" | sha256sum -c -
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir" codebase-memory-mcp
install -d -m 700 "$HOME/.local/bin"
install -m 755 "$tmp_dir/codebase-memory-mcp" "$HOME/.local/bin/codebase-memory-mcp"
"$HOME/.local/bin/codebase-memory-mcp" --version
