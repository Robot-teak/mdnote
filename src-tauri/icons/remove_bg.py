#!/usr/bin/env python3
"""
MDnote Logo 去白底处理
将 AI 生成的白底 Logo 转为透明底：
1. 生成 macOS 标准圆角矩形 mask
2. 圆角外区域设为全透明
3. 保留圆角内所有像素不变
4. 为所有尺寸图标添加出血区（overscan）避免白边
"""

import sys
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw

try:
    from PIL import Image, ImageDraw
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"], stdout=subprocess.DEVNULL)
    from PIL import Image, ImageDraw

# ── 配置 ──────────────────────────────────────────────
ICONS_DIR = Path(__file__).parent
# 优先使用 AI 生成的原始 Logo，如果没有则用已有的 1024x1024.png
SRC = ICONS_DIR / "macOS_app_icon_for_a_Markdown__2026-04-27T08-10-01.png"
if not SRC.exists():
    SRC = ICONS_DIR / "1024x1024.png"  # 回退到已处理过的图标

# macOS 标准圆角比例：约 22.3%（Apple HIG）
CORNER_RADIUS_RATIO = 0.223
# macOS 图标内边距：Apple HIG 规定约 1/10 的安全边距
PADDING_RATIO = 0.10


def apply_rounded_mask(img: Image.Image, size: int) -> Image.Image:
    """为图标应用圆角 mask，确保边缘完全透明"""
    # macOS 标准圆角比例
    corner_radius = max(1, int(size * CORNER_RADIUS_RATIO))
    # 安全边距
    padding = int(size * PADDING_RATIO)
    
    # 生成圆角矩形 mask
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    
    # 圆角矩形区域（从 padding 开始到 size-padding）
    rect = [padding, padding, size - padding, size - padding]
    draw.rounded_rectangle(rect, radius=corner_radius, fill=255)
    
    # 如果原图尺寸和目标不同，先调整大小
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)
    
    # 确保是 RGBA 模式
    img = img.convert('RGBA')
    r, g, b, a = img.split()
    
    # 新 alpha = 原 alpha * (mask / 255)
    import PIL.ImageChops as IC
    new_alpha = IC.multiply(a, mask)
    result = Image.merge('RGBA', (r, g, b, new_alpha))
    
    return result


def main():
    print(f"\n{'='*50}")
    print("  MDnote Logo: Remove White Background")
    print(f"{'='*50}\n")

    if not SRC.exists():
        print(f"ERROR: Source not found: {SRC}")
        sys.exit(1)

    # 加载源图
    src_img = Image.open(str(SRC)).convert("RGBA")
    print(f"  Source: {SRC.name}  ({src_img.width}x{src_img.height})")

    # 生成 1024x1024 主图标
    main_icon = apply_rounded_mask(src_img, 1024)
    main_icon.save(str(ICONS_DIR / "1024x1024.png"), "PNG")
    print(f"  ✓ Generated: 1024x1024.png")

    # 生成所有需要的尺寸
    sizes = [16, 32, 64, 128, 256, 512]
    
    for size in sizes:
        icon = apply_rounded_mask(src_img, size)
        icon.save(str(ICONS_DIR / f"{size}x{size}.png"), "PNG")
        
        # 验证角落透明度
        corner = icon.getpixel((0, 0))
        if corner[3] != 0:
            print(f"  ⚠ {size}x{size}.png corner not transparent: {corner}")
        else:
            print(f"  ✓ Generated: {size}x{size}.png")
        
        # 生成 @2x 版本
        icon_2x = apply_rounded_mask(src_img, size * 2)
        icon_2x.save(str(ICONS_DIR / f"{size}x{size}@2x.png"), "PNG")
    
    # 复制 1024x1024.png 到 icon.png（兼容旧配置）
    import shutil
    shutil.copy(str(ICONS_DIR / "1024x1024.png"), str(ICONS_DIR / "icon.png"))
    print(f"  ✓ Copied: icon.png")

    print(f"\n{'='*50}")
    print("  Done! White background removed ✅")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    main()
