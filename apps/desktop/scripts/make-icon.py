"""Draws the Agent Together app icon: cards on a canvas, joined by edges, each
with a signal light. Writes build/icon.png (1024 px) and build/icon.ico.
Run: python scripts/make-icon.py (needs Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 4  # supersampling
N = 1024 * S
out = Path(__file__).resolve().parent.parent / "build"


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


# Background: rounded square with a diagonal blue gradient.
# Drawn twice as large, rotated and cropped, so the corners stay filled.
grad = Image.new("RGBA", (2 * N, 2 * N))
top, bottom = (72, 140, 248), (26, 54, 132)
gd = ImageDraw.Draw(grad)
for i in range(2 * N):
    gd.line([(0, i), (2 * N, i)], fill=lerp(top, bottom, min(1, max(0, (i - N / 2) / N))))
grad = grad.rotate(-25, resample=Image.BICUBIC).crop((N // 2, N // 2, N // 2 + N, N // 2 + N))
mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=230 * S, fill=255)
icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(icon)


def s(*v):
    return [x * S for x in v]


W, H = 300, 180
cards = {"a": (130, 422), "b": (594, 190), "c": (594, 654)}  # top-left corners
edge = (235, 242, 255, 230)


def bezier(p0, p1, p2, p3, steps=200):
    pts = []
    for k in range(steps + 1):
        t = k / steps
        u = 1 - t
        pts.append(tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * e for a, b, c, e in zip(p0, p1, p2, p3)))
    return pts


shadow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
for x, y in cards.values():
    sd.rounded_rectangle(s(x + 6, y + 18, x + W + 6, y + H + 18), radius=40 * S, fill=(8, 20, 60, 110))
icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * S)))
d = ImageDraw.Draw(icon)
ax, ay = cards["a"]
start = (ax + W, ay + H / 2)
for key in ("b", "c"):
    bx, by = cards[key]
    end = (bx, by + H / 2)
    mid = (start[0] + end[0]) / 2
    pts = bezier(start, (mid, start[1]), (mid, end[1]), end)
    for x, y in pts:  # stamped dots make a smooth, even-width curve
        d.ellipse(s(x - 13, y - 13, x + 13, y + 13), fill=edge)
    for x, y in (start, end):
        d.ellipse(s(x - 24, y - 24, x + 24, y + 24), fill=(255, 255, 255))

lights = {"a": (46, 184, 110), "b": (46, 184, 110), "c": (245, 180, 40)}
for key, (x, y) in cards.items():
    d.rounded_rectangle(s(x, y, x + W, y + H), radius=40 * S, fill=(255, 255, 255))
    d.rounded_rectangle(s(x + 40, y + 52, x + 190, y + 80), radius=14 * S, fill=(40, 70, 150))  # title bar
    d.rounded_rectangle(s(x + 40, y + 106, x + 240, y + 128), radius=11 * S, fill=(196, 208, 232))  # text line
    cx, cy = x + W - 58, y + 62
    d.ellipse(s(cx - 26, cy - 26, cx + 26, cy + 26), fill=lights[key])

out.mkdir(exist_ok=True)
big = icon.resize((1024, 1024), Image.LANCZOS)
big.save(out / "icon.png")
big.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out / "icon.png", out / "icon.ico")
