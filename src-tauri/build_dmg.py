#!/usr/bin/env python3
"""
Build MDnote .app bundles and DMG installers for Apple Silicon and Intel.
Usage: python3 build_dmg.py
"""

import os
import shutil
import subprocess
import sys
import plistlib

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_TAURI = os.path.join(PROJECT_ROOT, "src-tauri")
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
ICONS_DIR = os.path.join(SRC_TAURI, "icons")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output")

APP_NAME = "MDnote"
BUNDLE_ID = "com.mdnote.desktop"
VERSION = "0.2.0"

ARCHS = [
    ("aarch64-apple-darwin", "arm64", "Apple Silicon"),
    ("x86_64-apple-darwin", "x86_64", "Intel"),
]


def create_app_bundle(target: str, arch_label: str, arch_name: str) -> str:
    """Create a complete .app bundle for the given target."""
    # Use arch suffix for intermediate .app to avoid collisions between architectures
    intermediate_app = os.path.join(OUTPUT_DIR, f"{APP_NAME}-{arch_label}.app")
    final_app = os.path.join(OUTPUT_DIR, f"{APP_NAME}.app")

    # Remove old bundles
    if os.path.exists(intermediate_app):
        shutil.rmtree(intermediate_app)
    if os.path.exists(final_app):
        shutil.rmtree(final_app)

    # Directory structure
    macos_dir = os.path.join(intermediate_app, "Contents", "MacOS")
    resources_dir = os.path.join(intermediate_app, "Contents", "Resources")
    os.makedirs(macos_dir, exist_ok=True)
    os.makedirs(resources_dir, exist_ok=True)

    # Copy binary
    binary_src = os.path.join(SRC_TAURI, "target", target, "release", "mdnote")
    binary_dst = os.path.join(macos_dir, "mdnote")
    shutil.copy2(binary_src, binary_dst)
    os.chmod(binary_dst, 0o755)
    print(f"  ✓ Binary copied ({arch_name})")

    # Copy Info.plist
    info_plist = {
        "CFBundleDevelopmentRegion": "zh_CN",
        "CFBundleExecutable": "mdnote",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": "1",
        "CFBundleIconFile": "AppIcon",
        "CFBundleIconName": "AppIcon",
        "LSMinimumSystemVersion": "10.15",
        "CFBundleDocumentTypes": [
            {
                "CFBundleTypeName": "Markdown",
                "CFBundleTypeRole": "Editor",
                "LSItemContentTypes": ["net.daringfireball.markdown"],
                "CFBundleTypeExtensions": ["md", "markdown", "mdown", "mkd"],
            }
        ],
        "NSHighResolutionCapable": True,
        "NSSupportsAutomaticGraphicsSwitching": True,
    }
    plist_path = os.path.join(intermediate_app, "Contents", "Info.plist")
    with open(plist_path, "wb") as f:
        plistlib.dump(info_plist, f)
    print("  ✓ Info.plist created")

    # Copy PkgInfo
    pkginfo_path = os.path.join(intermediate_app, "Contents", "PkgInfo")
    with open(pkginfo_path, "w") as f:
        f.write("APPL????")
    print("  ✓ PkgInfo created")

    # Copy icon
    icon_src = os.path.join(ICONS_DIR, "AppIcon.icns")
    icon_dst = os.path.join(resources_dir, "AppIcon.icns")
    shutil.copy2(icon_src, icon_dst)
    print("  ✓ AppIcon.icns copied")

    # Copy icon.png (for About dialog etc.)
    icon_png_src = os.path.join(ICONS_DIR, "icon.png")
    if os.path.exists(icon_png_src):
        shutil.copy2(icon_png_src, os.path.join(resources_dir, "icon.png"))
        print("  ✓ icon.png copied")

    # NOTE: Frontend dist is already embedded in the binary via custom-protocol feature.
    # No need to copy dist/ into Resources — it would be redundant and bloat the DMG.

    # Copy sample.md
    sample_src = os.path.join(DIST_DIR, "sample.md")
    if os.path.exists(sample_src):
        shutil.copy2(sample_src, os.path.join(resources_dir, "sample.md"))

    # Rename to final name (strip arch suffix from directory name)
    shutil.move(intermediate_app, final_app)
    return final_app


def create_dmg(app_dir: str, arch_label: str, arch_name: str) -> str:
    """Create a DMG installer for the given .app bundle."""
    dmg_name = f"{APP_NAME}-{VERSION}-{arch_label}.dmg"
    dmg_path = os.path.join(OUTPUT_DIR, dmg_name)

    # Remove old DMG
    if os.path.exists(dmg_path):
        os.remove(dmg_path)

    # Create a temporary DMG folder
    dmg_temp = os.path.join(OUTPUT_DIR, f"dmg_temp_{arch_label}")
    if os.path.exists(dmg_temp):
        shutil.rmtree(dmg_temp)
    os.makedirs(dmg_temp)

    # Copy .app into temp folder
    app_name_in_temp = os.path.basename(app_dir)
    shutil.copytree(app_dir, os.path.join(dmg_temp, app_name_in_temp))

    # Create Applications symlink
    applications_link = os.path.join(dmg_temp, "Applications")
    os.symlink("/Applications", applications_link)

    # Create DMG using hdiutil
    print(f"  Creating DMG: {dmg_name} ...")
    result = subprocess.run(
        [
            "hdiutil", "create",
            "-volname", APP_NAME,
            "-srcfolder", dmg_temp,
            "-ov",
            "-format", "UDZO",
            dmg_path,
        ],
        capture_output=True,
        text=True,
    )

    # Clean up temp
    shutil.rmtree(dmg_temp)

    if result.returncode != 0:
        print(f"  ✗ hdiutil failed: {result.stderr}")
        sys.exit(1)

    size_mb = os.path.getsize(dmg_path) / (1024 * 1024)
    print(f"  ✓ DMG created: {dmg_name} ({size_mb:.1f} MB)")
    return dmg_path


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for target, arch_label, arch_name in ARCHS:
        print(f"\n{'='*50}")
        print(f"Building {APP_NAME} for {arch_name} ({arch_label})")
        print(f"{'='*50}")

        # Check binary exists
        binary = os.path.join(SRC_TAURI, "target", target, "release", "mdnote")
        if not os.path.exists(binary):
            print(f"  ✗ Binary not found: {binary}")
            print(f"  Run: cargo build --release --target {target}")
            sys.exit(1)

        app_dir = create_app_bundle(target, arch_label, arch_name)
        dmg_path = create_dmg(app_dir, arch_label, arch_name)

    print(f"\n{'='*50}")
    print("Build complete!")
    print(f"{'='*50}")
    for target, arch_label, arch_name in ARCHS:
        dmg_name = f"{APP_NAME}-{VERSION}-{arch_label}.dmg"
        dmg_path = os.path.join(OUTPUT_DIR, dmg_name)
        size_mb = os.path.getsize(dmg_path) / (1024 * 1024)
        print(f"  {dmg_name} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
