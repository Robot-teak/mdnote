#!/bin/bash
# Package Chrome Extension for release.
# Reads version from manifest.json, builds, and creates a versioned .zip.
# Usage: bash scripts/package-extension.sh

set -e

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="output/mdnote-extension-v${VERSION}.zip"

echo "=== Building extension ==="
npm run build:ext

echo ""
echo "=== Packaging extension v${VERSION} ==="
mkdir -p output
cd dist-extension
zip -r "../${OUTPUT}" . -x "*.DS_Store"
cd ..

SIZE=$(du -sh "${OUTPUT}" | cut -f1)
echo ""
echo "Done: ${OUTPUT} (${SIZE})"
