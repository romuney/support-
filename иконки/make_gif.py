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

from PIL import Image, ImageChops, ImageDraw, ImageFilter

import sheet


def align(keyed, box, limit):
    """Совместить кадры по верхней части силуэта — голове и кепке.

    Лечит РОВНО снос камеры между кадрами, и только его. Разную форму ушей
    или другой масштаб головы сдвигом не исправить: это перерисовка, а не
    смещение. Поэтому остаточное расхождение печатается числом — по нему
    видно, что осталось, и стоит ли переснимать лист.

    Опорная область — верх силуэта: лапы туда не поднимаются, и кепка
    с надписью там же, а именно её дрожание заметнее всего.
    """
    ref = keyed[0].crop(box).convert("RGB")
    w, h = ref.size
    win = (int(w * 0.22), int(h * 0.02), int(w * 0.78), int(h * 0.45))

    def dist(img, dx, dy):
        d = ImageChops.difference(
            ref.crop(win), ImageChops.offset(img, dx, dy).crop(win)).convert("L")
        px = list(d.get_flattened_data())
        return sum(px) / len(px)

    out, before, after = [keyed[0]], [], []
    for k in keyed[1:]:
        rgb = k.crop(box).convert("RGB")
        before.append(dist(rgb, 0, 0))
        best = min((dist(rgb, dx, dy), dx, dy)
                   for dx in range(-limit, limit + 1, 2)
                   for dy in range(-limit, limit + 1, 2))
        after.append(best[0])
        # Сдвигаем ЦЕЛЫЙ кадр листа, а не обрезку: обрезка общая на все кадры
        # и делается позже, иначе сдвиг вылезет за её границы.
        out.append(ImageChops.offset(k, best[1], best[2]))
    print(f"совмещение: расхождение по голове {sum(before)/len(before):.1f} -> "
          f"{sum(after)/len(after):.1f} из 255")
    return out


def freeze_top(keyed, box, frac):
    """Взять верх силуэта — кепку с надписью — из первого кадра во все.

    Модель перерисовывает каждый кадр заново, и совмещением это не лечится:
    сдвиг снимает меньше половины расхождения, остальное — другая форма ушей
    и другой масштаб головы. Надпись CROSS при этом дрожит заметнее всего,
    потому что глаз цепляется за текст.

    Окно берётся УЖЕ окна совмещения: туда не должны дотягиваться поднятые
    лапы, иначе замороженная кепка затрёт движение. Соотношение проверяется
    прогоном по доле непрозрачного, а не на глаз.

    Край окна размывается: жёсткая граница дала бы видимый шов на шерсти.
    """
    ref = keyed[0]
    w, h = ref.size
    x0, x1 = box[0], box[2]
    win = (x0 + int((x1 - x0) * 0.20), box[1],
           x0 + int((x1 - x0) * 0.80), box[1] + int((box[3] - box[1]) * frac))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rectangle(win, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, (x1 - x0) // 50)))
    return [ref] + [Image.composite(ref, k, mask) for k in keyed[1:]]


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
    ap.add_argument("--freeze-top", type=float, default=0.0, metavar="ДОЛЯ",
                    help="взять верх кадра (кепку) из первого кадра во все, "
                         "0.30 — разумное значение")
    ap.add_argument("--align", action="store_true",
                    help="совместить кадры по неподвижной верхней части")
    ap.add_argument("--align-shift", type=int, default=10, help="предел сдвига, px")
    a = ap.parse_args()

    cells = sheet.split_grid(Image.open(a.image), a.cols, a.rows)
    if a.frames:
        idx = [int(n) - 1 for n in a.frames.split(",")]
        cells = [cells[i] for i in idx]

    keyed = [sheet.key_background(c, a.thresh) for c in cells]
    box = sheet.union_box([sheet.content_box(k) for k in keyed])
    if box is None:
        sys.exit("после вырезания фона не осталось ничего — перегенерировать лист")
    if a.align:
        keyed = align(keyed, box, a.align_shift)
    if a.freeze_top > 0:
        keyed = freeze_top(keyed, box, a.freeze_top)
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
