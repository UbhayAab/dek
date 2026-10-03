"""Generate the Android and iOS icon, splash and notification assets for Dek.

Source of truth: apps/web/public/icons/maskable-512.png (full bleed, artwork in the
safe zone) and icon-512.png (rounded square). Deterministic: same inputs, same
outputs. Run from apps/mobile: python scripts/make_assets.py

The 512 px sources are the largest that exist. The 1024 px App Store icon is an
upscale; replace it when a 1024 px or vector master of the Dek mark exists.
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parent
ICONS = MOBILE.parent / "web" / "public" / "icons"
RES = MOBILE / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = MOBILE / "ios" / "App" / "App" / "Assets.xcassets"

NAVY = (26, 16, 48)          # #1a1030, the maskable icon background
ORANGE = (240, 90, 60)       # the dots and the big bubble
CREAM = (255, 242, 232)      # the small bubble
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def dist(a, b):
    return sum(abs(a[i] - b[i]) for i in range(3))


def ringed_by_cream(px, comp, w, h):
    """True when rays from the component's centre reach cream in all four
    directions: the dots sit inside the cream bubble; gradient fragments do not."""
    cx = sum(c[0] for c in comp) // len(comp)
    cy = sum(c[1] for c in comp) // len(comp)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        x, y, hit = cx, cy, False
        for _ in range(40):
            x, y = x + dx, y + dy
            if not (0 <= x < w and 0 <= y < h):
                break
            if dist(px[x, y], CREAM) < 40:
                hit = True
                break
        if not hit:
            return False
    return True


def resized(img, size):
    return img.resize((size, size), Image.LANCZOS)


def silhouette(src):
    """White artwork on transparent: alpha from the distance to the navy
    background; the two dots in the small bubble become holes."""
    w, h = src.size
    px = src.load()
    # Every artwork colour (the darkest end of the orange gradient included) is at
    # least ~250 away from navy; only anti-aliased edge pixels fall below 200.
    full = 200
    alpha = Image.new("L", (w, h), 0)
    ap = alpha.load()
    for y in range(h):
        for x in range(w):
            ap[x, y] = max(0, min(255, int(255 * dist(px[x, y], NAVY) / full)))

    # Small orange components are the dots (the big bubble is one large one).
    seen = set()
    holes = []
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or dist(px[x, y], ORANGE) > 40:
                continue
            comp, queue = [], deque([(x, y)])
            seen.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                comp.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and dist(px[nx, ny], ORANGE) <= 40:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            xs = [c[0] for c in comp]
            ys = [c[1] for c in comp]
            # A dot is small AND compact; the gradient of the big bubble crosses the
            # same colour along a long thin diagonal, which must stay solid.
            if len(comp) < 2000 and max(xs) - min(xs) < 40 and max(ys) - min(ys) < 40 and ringed_by_cream(px, comp, w, h):
                holes.append(comp)
    span = dist(CREAM, ORANGE)
    for comp in holes:
        region = set()
        for cx, cy in comp:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    region.add((cx + dx, cy + dy))
        for cx, cy in region:
            if 0 <= cx < w and 0 <= cy < h:
                ap[cx, cy] = min(ap[cx, cy], max(0, min(255, int(255 * dist(px[cx, cy], ORANGE) / span))))

    white = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    white.putalpha(alpha)
    return white


def artwork_box(src):
    w, h = src.size
    px = src.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if dist(px[x, y], NAVY) > 40:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def square_crop(img, box, pad_ratio):
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    side = int(side * (1 + 2 * pad_ratio))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    canvas = Image.new(img.mode, (side, side), (0, 0, 0, 0) if img.mode == "RGBA" else NAVY)
    canvas.paste(img.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)), (0, 0))
    return canvas


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def android(maskable, rounded, mono):
    for name, scale in DENSITIES.items():
        legacy = int(48 * scale)
        fg = int(108 * scale)
        save(resized(rounded, legacy), RES / f"mipmap-{name}" / "ic_launcher.png")
        circle = resized(maskable.convert("RGBA"), legacy)
        mask = Image.new("L", (legacy * 4, legacy * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, legacy * 4 - 1, legacy * 4 - 1), fill=255)
        circle.putalpha(mask.resize((legacy, legacy), Image.LANCZOS))
        save(circle, RES / f"mipmap-{name}" / "ic_launcher_round.png")
        save(resized(maskable, fg), RES / f"mipmap-{name}" / "ic_launcher_foreground.png")
        save(resized(mono, fg), RES / f"mipmap-{name}" / "ic_launcher_monochrome.png")


def notification_icon(mono, box):
    small = square_crop(mono, box, 0.08)
    for name, scale in DENSITIES.items():
        save(resized(small, int(24 * scale)), RES / f"drawable-{name}" / "ic_stat_dek.png")


def splash_mark(maskable, box):
    mark = square_crop(maskable, box, 0.12)
    # 120 dp at xxhdpi; Android scales it for other densities.
    save(resized(mark, 360), RES / "drawable-xxhdpi" / "splash_mark.png")
    return mark


def ios(maskable, mark):
    icon = maskable.resize((1024, 1024), Image.LANCZOS).convert("RGB")
    save(icon, IOS_ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png")
    splash = Image.new("RGB", (2732, 2732), NAVY)
    m = mark.resize((620, 620), Image.LANCZOS).convert("RGB")
    splash.paste(m, ((2732 - 620) // 2, (2732 - 620) // 2))
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        save(splash, IOS_ASSETS / "Splash.imageset" / name)


def main():
    maskable = Image.open(ICONS / "maskable-512.png").convert("RGB")
    rounded = Image.open(ICONS / "icon-512.png").convert("RGBA")
    mono = silhouette(maskable)
    box = artwork_box(maskable)
    android(maskable, rounded, mono)
    notification_icon(mono, box)
    mark = splash_mark(maskable, box)
    ios(maskable, mark)
    for old in RES.glob("drawable*/splash.png"):
        old.unlink()
    for empty in RES.glob("drawable-*"):
        if empty.is_dir() and not any(empty.iterdir()):
            empty.rmdir()
    stale = RES / "drawable-v24" / "ic_launcher_foreground.xml"
    if stale.exists():
        stale.unlink()
    print("assets written", box)


if __name__ == "__main__":
    main()
