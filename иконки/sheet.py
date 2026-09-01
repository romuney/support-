"""Общая механика листа: деление на ячейки, вырезание фона, приведение к 128.

Вынесено в модуль, а не скопировано в оба скрипта: нарезка стикеров и сборка
GIF читают один и тот же лист от Nano Banana, и вторая копия разъехалась бы
молча — статика и анимация начали бы отличаться размером персонажа.
"""

from PIL import Image, ImageDraw

# Фон листа — плоский средний серый из промпта. Порог подобран так, чтобы
# заливка съедала и сам фон, и сглаженную кайму на границе с белой die-cut
# обводкой: PIL сравнивает СУММУ модулей разности по каналам, то есть 60 —
# это примерно 20 на канал, а до белого от серого 381.
FLOOD_THRESH = 60
# Магический цвет заливки. Совпадение с реальным пикселем безвредно:
# прозрачным становится только то, что связано с краем.
KEY = (1, 2, 3)


def split_grid(img, cols, rows):
    """Ровное деление листа на ячейки.

    Промпт требует одинаковых полей и промежутков, поэтому ровного деления
    хватает: содержимое ячейки потом всё равно обрезается по своим краям,
    и промежуток между ячейками уходит вместе с фоном.
    """
    w, h = img.size
    out = []
    for r in range(rows):
        for c in range(cols):
            box = (
                round(c * w / cols), round(r * h / rows),
                round((c + 1) * w / cols), round((r + 1) * h / rows),
            )
            out.append(img.crop(box))
    return out


def key_background(cell, thresh=FLOOD_THRESH):
    """Убрать фон заливкой ОТ КРАЁВ, а не поиском цвета по всей картинке.

    Разница принципиальная: клавиатура в анимации тоже серая, и глобальное
    сравнение с цветом фона проело бы её насквозь. Заливка от края снимает
    только то, что с краем связано, — а связь разорвана белой обводкой.
    """
    rgb = cell.convert("RGB")
    w, h = rgb.size
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for xy in seeds:
        ImageDraw.floodfill(rgb, xy, KEY, thresh=thresh)

    out = cell.convert("RGBA")
    px, kp = out.load(), rgb.load()
    for y in range(h):
        for x in range(w):
            if kp[x, y] == KEY:
                px[x, y] = (0, 0, 0, 0)
    return out


def content_box(cell):
    """Границы непрозрачного содержимого. None — ячейка пустая."""
    return cell.getbbox()


def fit_square(cell, box, size=128, pad=0.02):
    """Обрезать по box, дополнить до квадрата и привести к size.

    `box` приходит СНАРУЖИ намеренно: у анимации он обязан быть общим на все
    кадры, иначе каждый кадр обрежется по своему силуэту, персонаж поедет
    от кадра к кадру, и цикл будет дёргаться при неподвижной камере.
    """
    crop = cell.crop(box)
    w, h = crop.size
    side = max(w, h)
    side = int(round(side * (1 + 2 * pad))) or 1
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - w) // 2, (side - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def union_box(boxes):
    """Объединение границ — общая рамка для всех кадров анимации."""
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))
