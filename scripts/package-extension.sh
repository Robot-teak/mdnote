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
echo "=== Stripping desktop-only files ==="
# Replace 1024x1024 desktop icon with 128x128 version (saves ~940KB)
rm -f dist-extension/icon.png
cp public/icons/icon128.png dist-extension/icon.png
echo "  ✓ icon.png replaced (1024→128, ~940KB saved)"

# Remove desktop sample file
rm -f dist-extension/sample.md
echo "  ✓ sample.md removed"

echo ""
echo "=== Packaging extension v${VERSION} ==="
mkdir -p output
cd dist-extension
zip -9 -r "../${OUTPUT}" . -x "*.DS_Store"
cd ..

SIZE=$(du -sh "${OUTPUT}" | cut -f1)
echo ""
echo "Done: ${OUTPUT} (${SIZE})"
