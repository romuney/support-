#!/usr/bin/env python3
"""Нарезка листа стикеров на отдельные PNG 128x128 с прозрачным фоном.

    python3 slice_grid.py sheet-a.png --names names-a.txt --out out/

Без --names файлы получают имена по позиции (cell-1 … cell-9): это не отказ,
а честный промежуточный результат — посмотреть, что нарезалось, и потом
переименовать. Молча подставлять имена не той пачки нельзя: имя эмодзи
в Mattermost меняется только пересозданием.
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
    ap.add_argument("--names", help="файл с именами по строке, либо имена через запятую")
    ap.add_argument("--out", default="out")
    ap.add_argument("--size", type=int, default=128)
    ap.add_argument("--thresh", type=int, default=sheet.FLOOD_THRESH,
                    help="допуск по яркости вокруг цвета фона; от персонажа "
                         "маску защищает не он, а насыщенность")
    a = ap.parse_args()

    cells = sheet.split_grid(Image.open(a.image), a.cols, a.rows)

    names = []
    if a.names:
        # Поштучная генерация даёт один файл на стикер, и заводить ради имени
        # файл со списком — лишний шаг. Путь и список различаются по наличию
        # файла на диске, а не по запятой: имя может её содержать.
        src = Path(a.names)
        raw = src.read_text() if src.is_file() else a.names.replace(",", "\n")
        names = [n.strip() for n in raw.split("\n") if n.strip()]
        if len(names) != len(cells):
            sys.exit(f"имён {len(names)}, ячеек {len(cells)} — не совпало")

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    empty = []
    for i, cell in enumerate(cells):
        name = names[i] if names else f"cell-{i + 1}"
        keyed = sheet.key_background(cell, a.thresh)
        box = sheet.content_box(keyed)
        if box is None:
            # Пустая ячейка почти всегда значит, что маска фона накрыла
            # персонажа целиком: он вышел таким же нейтрально-серым, как фон.
            # Молчать нельзя — в паке просто не окажется одной реакции,
            # и заметится это уже в Mattermost.
            empty.append(name)
            continue
        img = sheet.fit_square(keyed, box, a.size)
        img.save(out / f"{name}.png")
        print(f"{name}.png  {a.size}x{a.size}  {(out / f'{name}.png').stat().st_size} b")

    if empty:
        sys.exit(f"\nпусто после вырезания фона: {', '.join(empty)}\n"
                 "персонаж в этих ячейках не отличается от фона по цвету — "
                 "сузить --thresh, а если не помогло, перегенерировать лист")


if __name__ == "__main__":
    main()
