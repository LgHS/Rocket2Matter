#!/usr/bin/env bash
#
# Builds a standalone binary (Node SEA) of the migration tool.
# The binary embeds Node: no installation is required to run it.
#
#   pnpm build:binary
#
# Variables:
#   NODE_VERSION   Node version to embed (default below)
#   TARGET_OS      darwin | linux   (default: current OS)
#   TARGET_ARCH    arm64  | x64     (default: current arch)
#
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-22.12.0}"
NAME="rocketchat-mattermost"
OUT="dist/$NAME"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

# --- Determine the target ---
host_os() { case "$(uname -s)" in Darwin) echo darwin;; Linux) echo linux;; *) echo unknown;; esac; }
host_arch() { case "$(uname -m)" in arm64|aarch64) echo arm64;; x86_64|amd64) echo x64;; *) echo unknown;; esac; }
OS="${TARGET_OS:-$(host_os)}"
ARCH="${TARGET_ARCH:-$(host_arch)}"

mkdir -p dist

echo "1/6  Bundle de la CLI (esbuild)…"
pnpm bundle

echo "2/6  Récupération d'un Node officiel monolithique (v$NODE_VERSION, $OS-$ARCH)…"
# (Homebrew's node is a thin launcher linked to libnode → unusable for SEA.)
NODE_DIR="dist/.node-v$NODE_VERSION-$OS-$ARCH"
NODE_BIN="$NODE_DIR/bin/node"
if [ ! -f "$NODE_BIN" ]; then
  TARBALL="node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  URL="https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  echo "      Téléchargement : $URL"
  curl -fsSL "$URL" -o "dist/$TARBALL"
  mkdir -p "$NODE_DIR"
  tar -xzf "dist/$TARBALL" -C "$NODE_DIR" --strip-components=1
  rm -f "dist/$TARBALL"
fi

echo "3/6  Génération du blob SEA (avec le node embarqué v$NODE_VERSION)…"
# The blob is specific to the Node version: it MUST be generated with the same
# node that serves as the base of the binary.
cat > dist/sea-config.json <<JSON
{
  "main": "dist/cli.cjs",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON
"$NODE_BIN" --experimental-sea-config dist/sea-config.json

echo "4/6  Copie du binaire Node…"
cp "$NODE_BIN" "$OUT"
chmod u+w "$OUT"

echo "5/6  Injection du blob…"
if [ "$OS" = "darwin" ]; then
  codesign --remove-signature "$OUT" || true
  npx --yes postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse "$FUSE" \
    --macho-segment-name NODE_SEA
  echo "6/6  Re-signature (ad-hoc)…"
  codesign --sign - "$OUT" || true
else
  npx --yes postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse "$FUSE"
  echo "6/6  (pas de signature requise sur cette plateforme)"
fi

chmod +x "$OUT"
echo ""
echo "✅ Binaire autonome : $OUT  ($(du -h "$OUT" | cut -f1), $OS-$ARCH)"
if [ "$OS" = "$(host_os)" ] && [ "$ARCH" = "$(host_arch)" ]; then
  "$OUT" --version >/dev/null && echo "   Test --version : OK"
fi
echo "   Usage : ./$OUT export | package | reset-password"
