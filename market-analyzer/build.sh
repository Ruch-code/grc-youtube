#!/usr/bin/env bash
# Builds the static site into ./public for Cloudflare Pages.
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Copying app files into public/ …"
cp index.html public/index.html
cp manifest.json public/manifest.json
mkdir -p public/assets
cp -f assets/* public/assets/

echo "✓ Build complete — public/ is ready to deploy."
