#!/usr/bin/env python3
"""Сборка анимированного эмодзи из листа кадров.

    python3 make_gif.py typing-sheet.png --out out/bulli_typing.gif --ms 80

Отличие от нарезки стикеров одно и оно важное: рамка обрезки ОБЩАЯ на все
кадры. Обрежь каждый кадр по его силуэту — и поднятая лапа сдвинет персонажа
относительно ячейки, то есть при неподвижной камере в промпте GIF всё равно
задёргается.
"""

import argparse
import sys
from pathlib import Path

from PIL import Image

import sheet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--rows", type=int, default=3)
    ap.add_argument("--out", default="out/bulli_typing.gif")
    ap.add_argument("--size", type=int, default=128)
    ap.add_argument("--ms", type=int, default=80, help="длительность кадра")
    ap.add_argument("--thresh", type=int, default=sheet.FLOOD_THRESH)
    ap.add_argument("--frames", help="номера кадров через запятую, если часть брака")
    a = ap.parse_args()

    cells = sheet.split_grid(Image.open(a.image), a.cols, a.rows)
    if a.frames:
        idx = [int(n) - 1 for n in a.frames.split(",")]
        cells = [cells[i] for i in idx]

    keyed = [sheet.key_background(c, a.thresh) for c in cells]
    box = sheet.union_box([sheet.content_box(k) for k in keyed])
    if box is None:
        sys.exit("после вырезания фона не осталось ничего — перегенерировать лист")
    frames = [sheet.fit_square(k, box, a.size) for k in keyed]

    # Палитра ОДНА на все кадры, снятая с первого. Своя палитра у каждого
    # кадра даёт мерцание цвета шерсти на 8 кадрах из 9 — по одному кадру
    # этого не видно, видно только в собранном цикле.
    base = frames[0].convert("RGB").convert(
        "P", palette=Image.Palette.ADAPTIVE, colors=255)
    pal = base.getpalette()[: 255 * 3] + [0, 0, 0]  # индекс 255 — прозрачный

    out_frames = []
    for f in frames:
        q = f.convert("RGB").quantize(palette=base, dither=Image.Dither.NONE)
        q.putpalette(pal)
        # Полупрозрачное в GIF не бывает: край режется по порогу.
        q.paste(255, (0, 0), f.getchannel("A").point(lambda v: 255 if v < 128 else 0))
        out_frames.append(q)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out_frames[0].save(
        out, save_all=True, append_images=out_frames[1:], duration=a.ms,
        loop=0, transparency=255, disposal=2, optimize=False)

    size = out.stat().st_size
    print(f"{out}  {len(out_frames)} кадров x {a.ms} мс = "
          f"{len(out_frames) * a.ms / 1000:.2f} с  {a.size}x{a.size}  {size} b")
    if size > 1024 * 1024:
        sys.exit("больше 1 МБ — Mattermost не примет: снизить --size или число кадров")


if __name__ == "__main__":
    main()
