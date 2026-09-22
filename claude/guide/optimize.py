#!/usr/bin/env python3
"""Стиснення макетів перед вбудовуванням у docs/USER_GUIDE.html.

guide-shots.mjs малює shots/<name>.png у подвійному масштабі (deviceScaleFactor 2).
Тут вони зменшуються до 1.5× і зводяться до 48-кольорової палітри: на пласкому
темному інтерфейсі це непомітно на око, а вага падає приблизно втричі — саме
вона й визначає розмір автономного HTML, бо картинки лежать у ньому base64.

Потрібен Pillow:  pip install pillow
"""
import pathlib
from PIL import Image

SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
SCALE = 0.75      # від 2× рендера → 1.5×
COLORS = 48

total = 0
for src in sorted(SHOTS.glob("*.png")):
    if src.name.endswith(".opt.png"):
        continue
    im = Image.open(src).convert("RGB")
    w, h = im.size
    im = im.resize((int(w * SCALE), int(h * SCALE)), Image.LANCZOS)
    im = im.quantize(colors=COLORS, method=Image.FASTOCTREE, dither=Image.Dither.NONE)
    out = SHOTS / (src.stem + ".opt.png")
    im.save(out, optimize=True)
    total += out.stat().st_size
    print("  %-12s %6.1f KB" % (src.stem, out.stat().st_size / 1024))
print("разом %.0f KB" % (total / 1024))
