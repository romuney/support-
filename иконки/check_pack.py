#!/usr/bin/env python3
"""Проверка пака эмодзи до заливки в Mattermost.

    python3 check_pack.py out-badge
    python3 check_pack.py out-badge --sheets review/

Заливка стоит дорого не деньгами, а руками: картинку у существующего эмодзи
Mattermost заменить не даёт, и чтобы перезалить пак под теми же именами,
каждое имя удаляют и заводят заново по одному. Поэтому пак смотрят целиком
и один раз — до заливки, а не после.

Скрипт проверяет то, что меряется числом, и рисует то, что решается глазом.
Он НЕ судит про характер: похож ли бульдожка на себя, стоят ли уши, крупная
ли морда — на это отвечают контактные листы (`--sheets`), а не проверки.

Что ловится числом:

* **состав и формат** — шестнадцать имён из `names-c.txt`, PNG 128x128
  с альфой, до 1 МБ, имя из разрешённых Mattermost символов;
* **смешанный дизайн** — тринадцать иконок пака идут с круглой плашкой,
  три обратной связи — лапой без плашки. Иконка не в своём виде значит,
  что в папку затесался файл из другого прогона: пак разъезжается ровно так;
* **геометрия плашки** — диаметр и центровка. Плашка мельче соседних
  на плашке реакции читается как иконка «поменьше остальных»;
* **срез по краю кадра** — непрозрачный пиксель в первом или последнем
  ряду: у персонажа отрезано ухо или лапа;
* **остатки фона** — нейтрально-серые непрозрачные пятна: `key_background`
  снял фон не весь;
* **неразличимые пары** — на плашке реакции эмодзи рисуется примерно
  в 21 px, и морда там бурое пятно. Две иконки, которые на этом размере
  дают одну картинку, значат одно и то же, что бы ни было нарисовано
  вблизи. Ошибка — только когда обе стоят в одном месте интерфейса
  (`SLOTS`): светофор в шапке ответа человек читает как один значок
  из четырёх, а `bully_hi` из лички с ним рядом не встречается никогда.

Выход: 0 — пак можно заливать, 1 — есть ошибки, 2 — только предупреждения.
"""

import argparse
import itertools
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Размер, в котором эмодзи живёт в плашке реакции Mattermost. Всё, что
# проверяется «на глаз», проверяется здесь, а не на 128 px: 128 видно только
# в списке эмодзи и при наведении.
REACTION_PX = 21

# Порог различимости по ЦВЕТУ ПЛАШКИ: сумма модулей разницы по каналам между
# средними цветами кольца двух иконок, сведённых к REACTION_PX.
#
# Сначала здесь стояла попиксельная разница всего кадра 21x21, и она оказалась
# ровно неверной меркой: у пака с одинаковым персонажем центр кадра у всех
# совпадает, разница падает — и проверка ругается тем сильнее, чем лучше пак
# сведён. Прогон 06.09 (собаки разные) давал 7 «неразличимых» пар,
# исправленный (собака одна) — 29, хотя цвета в нём разошлись, а не сошлись.
# Мерка наказывала за то, ради чего пак и переделывали.
#
# Меряем поэтому то, что на 21 px и несёт смысл, — цвет плашки: медиану
# узкого кольца у самого ободка. Медиану, а не среднее: в кольцо попадают
# уши, и кремовая шерсть тянет среднее к себе.
#
# Кольцо узкое и прижато к краю не сразу. Сначала брали 0.62–0.97, и мерка
# опять наказала за то, ради чего пак делали: морда стала крупнее, шерсти
# в широком кольце прибавилось, и все расстояния просели — зелёный
# со сине-серым сошлись с 44 до 39, хотя цвета разошлись. У самого ободка
# шерсти нет: там плашка, потому что ободок и обрезает морду.
#
# Порог откалиброван по полной матрице пака 07.09, а не подобран: пары,
# которым цвет положен ОДИН (обе синие, обе красные), доходят до 36;
# пары РАЗНЫХ цветов начинаются с 38. 37 ложится в этот зазор.
CONFUSE_MIN = 37.0

# Кольцо, по которому берётся цвет плашки: у самого ободка, где морды нет.
RING_INNER, RING_OUTER = 0.80, 0.99

# Доля вписанного эллипса, заполненная непрозрачным, выше которой силуэт
# считается плашкой. Замер по трём прогонам — в докстроке roundness().
BADGE_ROUNDNESS = 0.95

# Иконки обратной связи — лапа во весь кадр, без плашки. Остальные тринадцать
# идут с круглой плашкой. Разделение смысловое, а не оформительское: лапа —
# кнопка под ответом, плашка — вердикт в реакции.
PAW_ICONS = {"bully_helpful", "bully_not_helpful", "bully_detail"}

# Места в интерфейсе, где иконки встречаются друг с другом. Две иконки,
# неразличимые на 21 px, — беда только если они стоят в одном месте: светофор
# в шапке ответа человек читает как один значок из четырёх, и там янтарная
# лампочка обязана отличаться от красной. `bully_hi` из лички и `bully_unknown`
# из шапки тоже неразличимы, но рядом не встречаются никогда.
# Слоты — по употреблению в bot/build_time_flows.py.
SLOTS = {
    "светофор в шапке ответа":
        ["bully_high", "bully_mid", "bully_none", "bully_unknown"],
    "маркеры в списке джуну":
        ["bully_flag", "bully_warn", "bully_lock", "bully_expert"],
    "реакции на сообщении":
        ["bully_ready", "bully_done", "bully_fail"],
    "кнопки под ответом":
        ["bully_helpful", "bully_not_helpful", "bully_detail"],
}

# Слоты, где цвет — единственный сигнал, потому что предмета в иконке нет
# вовсе. Совпадение цвета здесь ошибка: различать нечем. В остальных слотах
# один цвет допустим по замыслу — `bully_lock` и `bully_expert` оба синие
# и разводятся белым замком и белой стрелкой, — и совпадение цвета там лишь
# повод посмотреть на контактный лист.
COLOUR_ONLY_SLOTS = {"светофор в шапке ответа"}

MATTERMOST_MAX_BYTES = 1024 * 1024
ICON_PX = 128

# Насыщенность, ниже которой пиксель считается нейтрально-серым. То же
# значение, по которому key_background снимает фон (sheet.SAT_MAX): если
# после нарезки такие пиксели остались непрозрачными, фон снят не весь.
GREY_SAT_MAX = 12


def plural(n, one, few, many):
    """Русское согласование: 1 ошибка, 2 ошибки, 5 ошибок."""
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def load_names(path):
    return [n.strip() for n in Path(path).read_text().split("\n") if n.strip()]


def roundness(im, box):
    """Насколько непрозрачное заполняет вписанный в рамку эллипс.

    Мерить кольцом на фиксированном радиусе нельзя: плашка бывает на
    несколько пикселей мельче или смещена, и кольцо выходит за её край —
    так `bully_fail` из прогона 06.09 получал «плашки нет» при живой плашке.
    Заполнение эллипса от смещения и размера не зависит вовсе.

    Замер по трём прогонам: у плашки 0.96–1.00, у лапы 0.64–0.76,
    у морды без плашки (v1) 0.73–0.90. Порог 0.95 разделяет их с запасом
    и, что важнее, ловит иконку старого дизайна, попавшую в пак нового.
    """
    w, h = im.size
    px = im.load()
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2
    inside = opaque = 0
    for y in range(h):
        for x in range(w):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                inside += 1
                if px[x, y][3] > 128:
                    opaque += 1
    return opaque / inside if inside else 0.0


def geometry(im):
    """Габариты непрозрачного: рамка, заполнение кадра, касания краёв."""
    w, h = im.size
    px = im.load()
    xs, ys, opaque = [], [], 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 128:
                opaque += 1
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    touch = []
    if any(px[x, 0][3] > 128 for x in range(w)):
        touch.append("верх")
    if any(px[x, h - 1][3] > 128 for x in range(w)):
        touch.append("низ")
    if any(px[0, y][3] > 128 for y in range(h)):
        touch.append("лево")
    if any(px[w - 1, y][3] > 128 for y in range(h)):
        touch.append("право")
    return {
        "box": (min(xs), min(ys), max(xs), max(ys)),
        "width": max(xs) - min(xs) + 1,
        "height": max(ys) - min(ys) + 1,
        "fill": opaque / (w * h),
        "touch": touch,
    }


def grey_share(im):
    """Доля нейтрально-серого среди непрозрачного — недоснятый фон."""
    w, h = im.size
    px = im.load()
    grey = total = 0
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            if c[3] <= 128:
                continue
            total += 1
            lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
            if max(c[:3]) - min(c[:3]) <= GREY_SAT_MAX and 90 < lum < 180:
                grey += 1
    return grey / total if total else 0.0


def at_reaction(im, plate=(240, 241, 244)):
    """Иконка, сведённая к размеру плашки реакции и положенная на её фон."""
    small = im.resize((REACTION_PX, REACTION_PX), Image.LANCZOS)
    out = Image.new("RGB", (REACTION_PX, REACTION_PX), plate)
    out.paste(small, (0, 0), small)
    return list(out.get_flattened_data())


def badge_colour(im):
    """Цвет плашки на размере реакции — то, что несёт смысл на 21 px.

    Берём кольцо, а не весь кадр: в середине морда, и она у всего пака
    одинаковая. Медиану, а не среднее: уши доходят до ободка и попадают
    в кольцо, а кремовая шерсть среднее уводит — у медианы она остаётся
    меньшинством.
    """
    small = im.resize((REACTION_PX, REACTION_PX), Image.LANCZOS)
    px = small.load()
    c = (REACTION_PX - 1) / 2
    ring = []
    for y in range(REACTION_PX):
        for x in range(REACTION_PX):
            r = math.hypot(x - c, y - c) / c
            if RING_INNER < r < RING_OUTER and px[x, y][3] > 140:
                ring.append(px[x, y][:3])
    if not ring:
        return None
    return tuple(sorted(v[i] for v in ring)[len(ring) // 2] for i in range(3))


def colour_distance(a, b):
    return sum(abs(p - q) for p, q in zip(a, b))


def pixel_distance(a, b):
    """Попиксельная разница — только для лап: плашки у них нет."""
    n = REACTION_PX * REACTION_PX * 3
    return sum(abs(p[0] - q[0]) + abs(p[1] - q[1]) + abs(p[2] - q[2])
               for p, q in zip(a, b)) / n


def font(size, bold=True):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    path = Path("/usr/share/fonts/truetype/dejavu") / name
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def checkerboard(w, h, square=12):
    """Шахматка под прозрачным: белая подложка врала бы про кайму."""
    img = Image.new("RGB", (w, h), (208, 208, 213))
    d = ImageDraw.Draw(img)
    for y in range(0, h, square):
        for x in range(0, w, square):
            if (x // square + y // square) % 2:
                d.rectangle([x, y, x + square - 1, y + square - 1],
                            fill=(178, 178, 185))
    return img


def sheet_full(images, names, path, cell=220):
    """Контактный лист на 128 px: сюда смотрят про персонажа и отделку."""
    cols = 4
    rows = (len(names) + cols - 1) // cols
    pad, label = 12, 20
    w = cols * (cell + pad) + pad
    h = rows * (cell + pad + label) + pad
    img = checkerboard(w, h)
    d = ImageDraw.Draw(img)
    f = font(14)
    for i, name in enumerate(names):
        r, c = divmod(i, cols)
        x = pad + c * (cell + pad)
        y = pad + r * (cell + pad + label)
        img.paste(images[name].resize((cell, cell), Image.LANCZOS), (x, y),
                  images[name].resize((cell, cell), Image.LANCZOS))
        d.rectangle([x, y + cell, x + cell, y + cell + label], fill=(28, 28, 32))
        d.text((x + 4, y + cell + 3), name, font=f, fill=(238, 238, 242))
    img.save(path)


def sheet_reaction(images, names, path, zoom=5):
    """Контактный лист на 21 px, светлая и тёмная тема.

    Тему выбирает сам сотрудник, и обе надо смотреть: на светлой пропадает
    кремовая лапа, на тёмной — тонкий светлый ободок плашки.
    """
    side = REACTION_PX * zoom
    pad, label = 8, 18
    f, fs = font(15), font(11, bold=False)
    # Ширину подписи берём у самой подписи: «плашка реакции · светлая» длиннее
    # круглого числа, и на глазок выставленное поле её срезало.
    left = 20 + max(int(f.getlength(f"плашка реакции · {t}"))
                    for t in ("светлая", "тёмная"))
    w = left + len(names) * (side + pad)
    h = pad + 2 * (side + label + pad)
    img = Image.new("RGB", (w, h), (26, 26, 30))
    d = ImageDraw.Draw(img)
    y = pad
    for theme, plate in (("светлая", (240, 241, 244)), ("тёмная", (31, 33, 38))):
        d.text((10, y + side // 2 - 8), f"плашка реакции · {theme}", font=f,
               fill=(240, 240, 245))
        x = left
        for name in names:
            small = images[name].resize((REACTION_PX, REACTION_PX), Image.LANCZOS)
            cell = Image.new("RGB", (REACTION_PX, REACTION_PX), plate)
            cell.paste(small, (0, 0), small)
            img.paste(cell.resize((side, side), Image.NEAREST), (x, y))
            d.text((x, y + side + 3), name.replace("bully_", "")[:11], font=fs,
                   fill=(186, 186, 196))
            x += side + pad
        y += side + label + pad
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="папка пака, например out-badge")
    ap.add_argument("--names", default="names-c.txt")
    ap.add_argument("--sheets", help="папка для контактных листов; без неё "
                                     "печатается только отчёт")
    a = ap.parse_args()

    folder = Path(a.folder)
    if not folder.is_dir():
        sys.exit(f"{folder}: папки нет")
    names = load_names(Path(__file__).parent / a.names
                       if not Path(a.names).is_file() else a.names)

    errors, warnings = [], []

    # Состав. Лишний файл в папке — не мелочь: нарезка кладёт сюда же, и файл
    # из прошлого прогона молча уедет в Mattermost вместе с паком.
    on_disk = {p.stem for p in folder.glob("*.png")}
    for name in names:
        if name not in on_disk:
            errors.append(f"{name}: файла нет в {folder}")
    for extra in sorted(on_disk - set(names)):
        warnings.append(f"{extra}.png: лишний файл в папке пака")

    images, reaction, colours = {}, {}, {}
    print(f"=== {folder} ===\n")
    print("%-18s %-11s %9s %9s %8s  %s" %
          ("иконка", "вид", "габарит", "круглость", "серого", "замечания"))

    for name in names:
        path = folder / f"{name}.png"
        if not path.exists():
            continue
        if not all(c.islower() or c.isdigit() or c in "-_" for c in name):
            errors.append(f"{name}: в имени эмодзи Mattermost допускает "
                          f"только строчную латиницу, цифры, дефис и _")
        size_bytes = path.stat().st_size
        if size_bytes > MATTERMOST_MAX_BYTES:
            errors.append(f"{name}: {size_bytes // 1024} КБ при пределе "
                          f"Mattermost в 1 МБ")

        im = Image.open(path)
        if im.mode != "RGBA":
            errors.append(f"{name}: {im.mode} вместо RGBA — прозрачности нет, "
                          f"на плашке реакции будет белая коробка")
        im = im.convert("RGBA")
        if im.size != (ICON_PX, ICON_PX):
            errors.append(f"{name}: {im.size[0]}x{im.size[1]} вместо "
                          f"{ICON_PX}x{ICON_PX} — сервер пережмёт сам, "
                          f"и чаще всего испортит прозрачность")
        images[name] = im
        reaction[name] = at_reaction(im)
        if name not in PAW_ICONS:
            colours[name] = badge_colour(im)

        geo = geometry(im)
        if geo is None:
            errors.append(f"{name}: непрозрачных пикселей нет вовсе — "
                          f"маска фона накрыла персонажа целиком")
            continue

        round_ = roundness(im, geo["box"])
        badged = round_ >= BADGE_ROUNDNESS
        kind = "плашка" if badged else "без плашки"
        notes = []

        want_badge = name not in PAW_ICONS
        if want_badge and not badged:
            errors.append(f"{name}: плашки нет (силуэт заполняет круг на "
                          f"{round_:.0%} при {BADGE_ROUNDNESS:.0%} у плашки) "
                          f"— файл из другого прогона либо старый дизайн "
                          f"без плашки")
            notes.append("нет плашки")
        if not want_badge and badged:
            errors.append(f"{name}: плашка есть, а это иконка обратной связи "
                          f"— она делается лапой во весь кадр, без плашки")
            notes.append("лишняя плашка")

        if geo["touch"]:
            warnings.append(f"{name}: касается краёв кадра ({', '.join(geo['touch'])}) "
                            f"— по краю что-то срезано")
            notes.append("срез по краю")

        grey = grey_share(im)
        if grey > 0.04:
            warnings.append(f"{name}: {grey:.0%} непрозрачного — нейтрально-серое; "
                            f"это либо недоснятый фон, либо серый предмет, "
                            f"который вырезалка чуть не съела")
            notes.append("серые пятна")

        print("%-18s %-11s %5dx%-3d %8.0f%% %7.1f%%  %s" %
              (name, kind, geo["width"], geo["height"], 100 * round_,
               100 * grey, ", ".join(notes)))

    # Геометрия плашки. Сравниваем не с абсолютом, а с медианой по паку:
    # важно не «сколько», а «одинаково ли» — выпавшая иконка видна как
    # «эта помельче остальных», и это ровно то, что замечает глаз.
    badged = [n for n in names if n in images and n not in PAW_ICONS]
    widths = sorted(geometry(images[n])["width"] for n in badged)
    if widths:
        median = widths[len(widths) // 2]
        for name in badged:
            w = geometry(images[name])["width"]
            if abs(w - median) > 4:
                warnings.append(f"{name}: габарит {w} px при {median} px "
                                f"у остальных — на плашке реакции читается "
                                f"как иконка не из этого пака")

    # Неразличимые пары. Проверка не про красоту, а про смысл: две иконки
    # одного цвета в одном месте интерфейса значат одно и то же.
    # У иконок с плашкой сравниваем цвет плашки, у лап плашки нет — там
    # сравнивать можно только весь кадр.
    def apart(x, y):
        if x in PAW_ICONS and y in PAW_ICONS:
            # Порог попиксельной мерки другой и к CONFUSE_MIN отношения
            # не имеет: 24 — это bully_not_helpful / bully_detail из прогона
            # 06.09, различимые с запасом.
            return pixel_distance(reaction[x], reaction[y]), 22.0, "кадр"
        if x in PAW_ICONS or y in PAW_ICONS:
            return None  # лапа и морда не путаются по устройству
        return (colour_distance(colours[x], colours[y]), CONFUSE_MIN,
                "цвет плашки")

    for slot, members in SLOTS.items():
        for x, y in itertools.combinations([n for n in members
                                            if n in reaction], 2):
            got = apart(x, y)
            if not got or got[0] >= got[1]:
                continue
            note = (f"{x} и {y}: на {REACTION_PX} px не различаются "
                    f"({got[2]} {got[0]:.0f} при пороге {got[1]:g}), "
                    f"а стоят в одном месте — {slot}")
            if slot in COLOUR_ONLY_SLOTS:
                errors.append(note + ". Предмета в этих иконках нет, "
                                     "различать нечем")
            else:
                warnings.append(note + ". Различает только предмет — "
                                       "посмотреть на контактном листе, "
                                       "читается ли он на 21 px")

    in_slot = {frozenset((x, y)) for m in SLOTS.values()
               for x, y in itertools.combinations(m, 2)}
    pairs = []
    for x, y in itertools.combinations([n for n in names if n in reaction], 2):
        got = apart(x, y)
        if got and got[0] < got[1]:
            pairs.append((got[0], x, y, got[2], frozenset((x, y)) in in_slot))
    pairs.sort()
    if pairs:
        print(f"\nНе различаются на {REACTION_PX} px:")
        for d, x, y, how, same_slot in pairs:
            print("   %-18s %-18s %-14s %5.0f%s" %
                  (x, y, how, d,
                   "  ← в одном месте интерфейса" if same_slot else ""))

    if a.sheets:
        out = Path(a.sheets)
        out.mkdir(parents=True, exist_ok=True)
        have = [n for n in names if n in images]
        sheet_full(images, have, out / "sheet-128.png")
        sheet_reaction(images, have, out / "sheet-reaction.png")
        print(f"\nКонтактные листы: {out}/sheet-128.png, "
              f"{out}/sheet-reaction.png")

    print()
    for e in errors:
        print(f"ОШИБКА  {e}")
    for w in warnings:
        print(f"внимание {w}")

    if errors:
        print(f"\n{len(errors)} {plural(len(errors), 'ошибка', 'ошибки', 'ошибок')}"
              f" — заливать нельзя.")
        return 1
    if warnings:
        print(f"\nОшибок нет, {len(warnings)} "
              f"{plural(len(warnings), 'замечание', 'замечания', 'замечаний')}. "
              f"Смотреть контактные листы и решать.")
        return 2
    print("\nПак чистый.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
