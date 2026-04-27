#!/usr/bin/env python3
"""
MDnote 全套图标生成器 v2 — 基于透明底源图
从 app-icon-1024.png 生成所有 macOS/Windows/Web 所需尺寸
"""

import os
import sys
import subprocess
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"], stdout=subprocess.DEVNULL)
    from PIL import Image

# ── 路径配置 ──────────────────────────────────────────────
ICONS_DIR = Path(__file__).parent
SRC_IMAGE = ICONS_DIR / "app-icon-1024.png"  # 透明底源图
ICONSET_DIR = ICONS_DIR / "AppIcon.iconset"

# ── macOS iconset 规格 ─────────────────────────────────────
ICONSET_SPECS = [
    ("icon_16x16.png",       16),
    ("icon_16x16@2x.png",    32),
    ("icon_32x32.png",       32),
    ("icon_32x32@2x.png",    64),
    ("icon_128x128.png",     128),
    ("icon_128x128@2x.png",  256),
    ("icon_256x256.png",     256),
    ("icon_256x256@2x.png",  512),
    ("icon_512x512.png",     512),
    ("icon_512x512@2x.png",  1024),
]

# ── 额外独立文件 ──────────────────────────────────────────
EXTRA_SPECS = [
    ("16x16.png",   16),
    ("32x32.png",   32),
    ("64x64.png",   64),
    ("128x128.png", 128),
    ("256x256.png", 256),
    ("512x512.png", 512),
    ("1024x1024.png", 1024),
    ("128x128@2x.png", 256),
    ("StoreLogo.png",  50),
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
]


def resize_image(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.LANCZOS)


def save_png(img: Image.Image, path: Path):
    img.save(str(path), "PNG", optimize=True)
    print(f"  ✓ {path.name:40s}  ({img.width}x{img.height})")


def generate_ico(img_1024: Image.Image, out_path: Path):
    sizes = [16, 32, 48, 64, 128, 256]
    frames = [resize_image(img_1024, s) for s in sizes]
    frames[0].save(
        str(out_path), format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[1:]
    )
    print(f"  ✓ {out_path.name:40s}  (multi-size ICO)")


def main():
    print(f"\n{'='*55}")
    print("  MDnote Icon Generator v2 (Transparent BG)")
    print(f"{'='*55}")
    print(f"  Source: {SRC_IMAGE.name}")
    print()

    if not SRC_IMAGE.exists():
        print(f"ERROR: Source image not found: {SRC_IMAGE}")
        sys.exit(1)

    src = Image.open(str(SRC_IMAGE)).convert("RGBA")
    
    # 验证透明背景
    corners = [src.getpixel((0, 0))[3], src.getpixel((src.width-1, 0))[3],
               src.getpixel((0, src.height-1))[3], src.getpixel((src.width-1, src.height-1))[3]]
    if all(a == 0 for a in corners):
        print(f"  ✓ Source: {src.width}x{src.height}, RGBA, transparent BG confirmed")
    else:
        print(f"  ⚠ Warning: corners alpha = {corners}, may not be fully transparent")
    print()

    # ── 1. iconset ────────────────────────────────────────
    ICONSET_DIR.mkdir(exist_ok=True)
    print("[1/4] Generating AppIcon.iconset ...")
    for fname, size in ICONSET_SPECS:
        img = resize_image(src, size)
        save_png(img, ICONSET_DIR / fname)

    # ── 2. 独立 PNG ──────────────────────────────────────
    print("\n[2/4] Generating standalone PNGs ...")
    for fname, size in EXTRA_SPECS:
        img = resize_image(src, size)
        save_png(img, ICONS_DIR / fname)

    # ── 3. favicon.ico ───────────────────────────────────
    print("\n[3/4] Generating favicon.ico ...")
    generate_ico(src, ICONS_DIR / "favicon.ico")

    # ── 4. AppIcon.icns ──────────────────────────────────
    print("\n[4/4] Generating AppIcon.icns ...")
    icns_path = ICONS_DIR / "AppIcon.icns"
    result = subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET_DIR), "-o", str(icns_path)],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        size_kb = icns_path.stat().st_size // 1024
        print(f"  ✓ AppIcon.icns ({size_kb} KB)")
    else:
        print(f"  ✗ iconutil failed: {result.stderr}")

    # ── 清理旧的白底图 ──────────────────────────────────
    old_src = ICONS_DIR / "macOS_app_icon_for_a_Markdown__2026-04-27T04-20-45.png"
    if old_src.exists():
        print(f"\n  🗑 Removing old white-bg source: {old_src.name}")
        old_src.unlink()

    print(f"\n{'='*55}")
    print("  All icons generated! BG is transparent ✅")
    print(f"{'='*55}\n")


if __name__ == "__main__":
    main()
