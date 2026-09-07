#!/usr/bin/env python3
"""Прогон задания через Nano Banana (Gemini Image API) без ручной возни.

    python3 generate.py prompt-pack.md --out sheet-d.png
    python3 generate.py prompt-each.md --each --out raw/

Промпты уже лежат в репозитории (`prompt-pack.md`, `prompt-stickers.md`,
`prompt-typing-gif.md`), референсы — рядом, нарезка делается `slice_grid.py`.
Не хватало только середины: до сих пор лист получали руками через веб-интерфейс
и приносили файл в репозиторий. Скрипт закрывает этот шаг, чтобы прогон
воспроизводился так же, как нарезка: одной командой из README.

Что важно и во что упирались раньше:

* **Задание берётся из markdown, а не копируется в код.** Иначе появится вторая
  копия промпта, и она разъедется с файлом — ровно та беда, из-за которой
  в репозитории одна база знаний, а не две (см. корневой CLAUDE.md). Берём
  ПЕРВЫЙ огороженный блок ``` файла: во всех трёх заданиях первый блок — это
  промпт, а команды нарезки идут ниже. Первая строка промпта печатается перед
  отправкой: взятый не тот блок видно сразу, а не по странной картинке.
* **Просим PNG в максимальном разрешении.** README требует не JPEG: JPEG мылит
  границу силуэта, и вырезание фона в `sheet.py` даёт кайму. Отсюда
  `imageSize=2K` по умолчанию.
* **Готовый файл не перезаписывается.** Лист стоит денег и минут ожидания,
  а имена вроде `sheet-c.jpg` уже разобраны в `prompt-pack.md`. Перезапись —
  только явным `--force`.

* **`--each` не перегенерирует готовое.** Пачка — это шестнадцать оплаченных
  прогонов, и повтор всей пачки ради одной неудачной иконки ровно то, от чего
  уходили с листа. Перекатить одну — `--only <имя> --force`; файл при этом
  не удаляют руками, иначе оборвавшийся прогон оставит пустое место.

Ключ — в `.env` (он в `.gitignore`) или в переменной окружения `GEMINI_API_KEY`.
Где его взять — в README, раздел «Ключ к API».
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_HOST = "https://generativelanguage.googleapis.com"
# v1beta — то, что SDK `@google/genai` подставляет для Gemini API по умолчанию
# (константа GOOGLE_AI_API_DEFAULT_VERSION). Вертексовский v1beta1 — другой
# путь и другая авторизация, сюда не годится.
API_VERSION = "v1beta"

# Nano Banana Pro. Пак держится на том, что надпись CROSS остаётся читаемой
# на всех шестнадцати кепках, а текст внутри картинки — как раз то, что
# у флешевых моделей ломается первым. Флешевые оставлены для черновых прогонов:
# --model gemini-3.1-flash-image, --model gemini-2.5-flash-image.
DEFAULT_MODEL = "gemini-3-pro-image"

DEFAULT_REFS = ["bulli-ref.png", "bully-style-ref.png"]

# Фраза из `prompt-stickers.md`: она и есть приём, которым держится стиль
# поштучных прогонов — второй образец подтверждает, что первый не случайность.
# Якорь — принятая иконка, и она в этом паке главнее описания словами.
#
# Раньше здесь стояло «Ignore its pose, its crop and its background»: якорь
# подавался как образец одной фактуры, а кадр, плашку и позу задание описывало
# заново словами. Это и оказалось причиной, по которой пак раз за разом
# приходил не тем: описание словами проигрывает картинке, и каждая новая
# клауза про плашку сдвигала кадр. Прогоны 06–07.09 — три захода на палитру
# и два на кадр, и всё это время принятая иконка лежала рядом неиспользованной.
#
# Теперь наоборот: с якоря копируется ВСЁ, кроме того, что подстановка меняет
# явно, — поза, кадр, плашка, её рамка и переход тонов, свет. Подстановка
# меняет цвет, выражение и предмет, и только их.
ANCHOR_NOTE = (
    "The last attached image is the APPROVED icon of this set. It is the "
    "master: copy it as closely as you can. Reproduce EXACTLY, without "
    "redesigning any of it — the same 3D render, the same fine fur with "
    "individual hairs, the same soft studio lighting and shading, the same "
    "freckles and whiskers, the same worn fabric texture on the cap, the same "
    "huge glossy eyes with the same highlights; the same round badge at the "
    "same size in the frame, with the same thick vivid rim and the same fade "
    "from the bright ring inwards to the paler centre behind his head; the "
    "same camera distance, the same crop, the same chubby proportions and the "
    "same amount of him showing. Think of it as the same photograph retouched, "
    "not as a new picture of the same character. Change ONLY the three things "
    "the instructions above name for this one image: the dye colour, the "
    "expression and the object. Everything else must match the approved icon "
    "pixel for pixel as far as you can manage."
)

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp"}


def read_prompt(path):
    """Первый огороженный блок ``` из markdown-задания."""
    text = Path(path).read_text(encoding="utf-8")
    blocks = re.findall(r"^```[^\n]*\n(.*?)^```", text, re.S | re.M)
    if not blocks:
        sys.exit(f"{path}: не нашёл блока ``` с промптом")
    return blocks[0].strip()


# Строка таблицы подстановок: | `имя` | `текст` |. Имя и текст в обратных
# кавычках — так они уже записаны в `prompt-each.md` и `prompt-stickers.md`,
# и по кавычкам строки таблицы отличаются от её шапки и разделителя.
ROW = re.compile(r"^\|\s*`([^`|]+)`\s*\|\s*`([^`]+)`\s*\|\s*$", re.M)

# Место подстановки в шаблоне: `Change ONLY this: <ЯЧЕЙКА>`. Плейсхолдер
# заменяется целиком, а строка вокруг него не пересобирается — иначе съедается
# пустая строка перед следующим абзацем, и два абзаца промпта слипаются в один.
# Имя внутри скобок разное (`<ЯЧЕЙКА>`, `<ПОЗА>`), поэтому оно не фиксируется.
SLOT = re.compile(r"(Change ONLY this:[ \t]*)<[^<>\n]+>")


# Позиции ячеек словами: «cell 3» модель считает хуже, чем «top left».
CELL_WHERE = {
    (2, 2): ["top left", "top right", "bottom left", "bottom right"],
    (1, 3): ["top", "middle", "bottom"],
    (3, 1): ["left", "middle", "right"],
    (2, 1): ["left", "right"],
    (1, 2): ["top", "bottom"],
}


def cell_places(cols, rows):
    """Как назвать каждую ячейку. Для мелких сеток — словами, дальше номерами
    строки и столбца: «row 2, column 3» модель держит, а «cell 7» теряет."""
    named = CELL_WHERE.get((cols, rows))
    if named:
        return named
    return [f"row {i // cols + 1}, column {i % cols + 1}"
            for i in range(cols * rows)]


def grid_block(cells, cols, rows):
    """Текст, который встаёт вместо строки одной ячейки, когда гоним листом.

    Лист — это одна оплаченная картинка вместо четырёх, и стиль внутри него
    держится сам собой: все ячейки рисуются в одном проходе. Поэтому листом
    гонят то, что обязано быть похожим между собой, — светофор целиком,
    маркеры целиком.

    Промежутки между ячейками требуем того же серого, что и фон. Прогон 02.09
    показал, зачем это повторять: модель нарисовала между ячейками БЕЛЫЕ
    полосы, ячейки разъехались по ширине, и вырезание фона оставило по краю
    белую кайму. `sheet.split_grid` теперь ищет разделители, но лучше, чтобы
    их не было вовсе.
    """
    where = cell_places(cols, rows)
    lines = [f"Cell {i + 1} ({where[i]}): {cell}"
             for i, (_, cell) in enumerate(cells)]
    return (
        f"This image is a GRID of {len(cells)} cells: {cols} columns by "
        f"{rows} rows, equal cells, read left to right and top to bottom.\n\n"
        "Wherever the rules above say \"the image\" or \"the frame\", they mean "
        "one CELL of this grid, not the whole picture.\n\n"
        "EVERY rule above applies inside EACH cell separately: each cell holds "
        "one complete finished icon, framed exactly as described above, as if "
        "it had been drawn on its own. The cells show the SAME character at "
        "the SAME size, the SAME distance and the SAME crop, lit the same way "
        "— they differ ONLY in what is listed for each cell below.\n\n"
        "The gaps between the cells and the margin around the whole grid are "
        "the SAME flat medium grey as the background inside the cells. Do NOT "
        "draw white lines between the cells, and no borders, no frames, no "
        "grid lines, no numbers, no captions and no labels anywhere.\n\n"
        + ("The cells are one single strip. Do NOT draw a box or a frame "
           "around the strip and do NOT draw lines down its sides: the plain "
           "grey background runs unbroken to all four edges of the picture.\n\n"
           if cols == 1 or rows == 1 else "")
        + "\n\n".join(lines)
        + "\n\nCHECK EVERY CELL BEFORE YOU FINISH. On a sheet of many cells "
          "these three are the first to go, and without them the icons are "
          "unusable:\n"
          "1. The white embroidered word \"CROSS\" on the front of the cap, "
          "big and clearly legible, in EVERY cell that shows the cap. A cap "
          "without the word is wrong.\n"
          "2. The THICK vivid rim around each badge. Look at the approved "
          "icon attached to this request and match the WIDTH of its rim: the "
          "rim is a wide band, not a line. If yours is thinner than the one "
          "in the approved icon, it is wrong. Its colour is the saturated one "
          "named for that cell, with the lighter field inside it.\n"
          "3. His head big enough that his ears and the crown of his cap reach "
          "the rim and are cut off by it. A small head with a ring of empty "
          "colour above the cap is wrong.\n"
          "4. The soft pale glow behind his head in every badge. A badge of "
          "one flat even colour is wrong.\n"
          "5. The same portrait in every cell: head and the very top of the "
          "chest, cut off there by the badge. No body, no hind legs, nobody "
          "sitting and nobody standing.\n"
          "6. Every object the same size as every other object across the "
          "cells — as tall as his muzzle is wide."
    )


def read_rows(path):
    """Таблица `| имя | подстановка |` из markdown-задания."""
    rows = ROW.findall(Path(path).read_text(encoding="utf-8"))
    if not rows:
        sys.exit(f"{path}: не нашёл таблицы вида | `имя` | `подстановка` |")
    names = [n for n, _ in rows]
    doubled = {n for n in names if names.count(n) > 1}
    if doubled:
        # Имя эмодзи в Mattermost меняется только пересозданием, и молча
        # затирать одну картинку другой того же имени нельзя.
        sys.exit(f"{path}: имена повторяются: {', '.join(sorted(doubled))}")
    return rows


def fill(template, cell):
    """Подстановка строки ячейки в шаблон, ровно в одно место."""
    filled, n = SLOT.subn(lambda m: m.group(1) + cell.replace("\\", "\\\\"),
                          template, count=1)
    if n != 1:
        sys.exit("в шаблоне нет места «Change ONLY this: <…>» — "
                 "подставлять некуда")
    return filled


def load_key(env_file):
    """Ключ из окружения, иначе из .env. В репозитории секретов нет."""
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key.strip()
    env = Path(env_file)
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "GEMINI_API_KEY":
                return value.strip().strip("'\"")
    sys.exit(
        f"нет GEMINI_API_KEY: ни в окружении, ни в {env_file}.\n"
        "Ключ берётся в Google AI Studio (https://aistudio.google.com/apikey), "
        "как получить — в README, раздел «Ключ к API»."
    )


def part_from_image(path):
    p = Path(path)
    if not p.is_file():
        sys.exit(f"референс не найден: {p}")
    mime = MIME.get(p.suffix.lower())
    if not mime:
        sys.exit(f"{p}: не знаю mime для {p.suffix}, нужен png/jpg/webp")
    return {"inline_data": {"mime_type": mime,
                            "data": base64.b64encode(p.read_bytes()).decode()}}


def call(model, body, key, timeout):
    url = f"{API_HOST}/{API_VERSION}/models/{model}:generateContent"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        # Тело ошибки печатаем целиком: в нём и «ключ не тот», и «модель
        # недоступна», и «сработал фильтр» — угадывать по коду 400 нечего.
        sys.exit(f"HTTP {e.code} от {url}\n{e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"сеть недоступна: {e.reason}")


def images_and_text(data):
    """Разбор ответа: картинки и то, что модель сказала словами."""
    images, words = [], []
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            # Ответ приходит в camelCase, но запрос принимает и snake_case;
            # читаем оба, чтобы разбор не зависел от версии API.
            blob = part.get("inlineData") or part.get("inline_data")
            if blob and blob.get("data"):
                images.append(base64.b64decode(blob["data"]))
            elif part.get("text"):
                words.append(part["text"])
        if cand.get("finishReason") not in (None, "STOP"):
            words.append(f"finishReason={cand['finishReason']}")
    if not images:
        fb = data.get("promptFeedback")
        if fb:
            words.append(f"promptFeedback={json.dumps(fb, ensure_ascii=False)}")
    return images, words


def run(prompt, refs, out, a, key):
    """Один прогон: собрать тело, отправить, разложить картинки по файлам."""
    parts = [{"text": prompt}] + [part_from_image(r) for r in refs]
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": a.aspect, "imageSize": a.size},
        },
    }

    head = prompt.splitlines()[0] if prompt.splitlines() else ""
    print(f"→ {out}", file=sys.stderr)
    print(f"  {a.model}, {a.size} {a.aspect}, промпт {len(prompt)} символов, "
          f"референсы: {', '.join(refs) or 'нет'}", file=sys.stderr)
    print(f"  первая строка: {head[:70]}", file=sys.stderr)

    if a.dry_run:
        print(f"  тело {len(json.dumps(body))} байт, частей {len(parts)}, "
              f"generationConfig={json.dumps(body['generationConfig'])}",
              file=sys.stderr)
        return True

    images, words = images_and_text(call(a.model, body, key, a.timeout))
    for line in words:
        print(f"  модель: {line.strip()[:200]}", file=sys.stderr)
    if not images:
        print("  картинки в ответе нет", file=sys.stderr)
        return False

    # Больше одной картинки за прогон модель отдаёт редко, но если отдала —
    # молча выбросить лишние нельзя: нужная могла прийти второй.
    out.parent.mkdir(parents=True, exist_ok=True)
    for i, blob in enumerate(images):
        path = out if i == 0 else out.with_name(f"{out.stem}-{i + 1}{out.suffix}")
        path.write_bytes(blob)
        print(f"{path} — {len(blob) // 1024} КБ")
    return True


def main():
    ap = argparse.ArgumentParser(
        description="прогон задания из markdown через Gemini Image API")
    ap.add_argument("task", help="файл задания (prompt-pack.md) либо --text")
    ap.add_argument("--text", action="store_true",
                    help="считать аргумент готовым промптом, а не путём к md")
    ap.add_argument("--each", action="store_true",
                    help="пачкой: шаблон задания плюс таблица подстановок, "
                         "по прогону на строку; --out тогда папка")
    ap.add_argument("--only", help="в пачке — только эти имена, через запятую")
    ap.add_argument("--grid", metavar="СТОЛБЦЫxСТРОКИ",
                    help="гнать выбранные --only одним листом: одна оплаченная "
                         "картинка вместо нескольких, и стиль внутри листа "
                         "держится сам. Порядок имён в --only — порядок ячеек")
    ap.add_argument("--anchor", help="в пачке — принятая картинка из этой же "
                                     "пачки: прикладывается последним "
                                     "референсом и держит стиль остальных")
    ap.add_argument("--out", default="sheet.png",
                    help="файл, а с --each — папка (по умолчанию raw/)")
    ap.add_argument("--ref", action="append",
                    help="референс; можно несколько. По умолчанию "
                         + " и ".join(DEFAULT_REFS))
    ap.add_argument("--no-ref", action="store_true", help="без референсов")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--size", default="2K", choices=["1K", "2K", "4K"],
                    help="разрешение; лист режется на 128px, мельче 2K брать нечего")
    ap.add_argument("--aspect", default="1:1", help="соотношение сторон")
    ap.add_argument("--env", default="../.env", help="файл с GEMINI_API_KEY")
    ap.add_argument("--timeout", type=int, default=300,
                    help="секунд на ответ; лист 4K модель делает минутами")
    ap.add_argument("--force", action="store_true",
                    help="перезаписать готовое (в пачке — всю пачку целиком)")
    ap.add_argument("--dry-run", action="store_true",
                    help="показать, что отправится, и не отправлять")
    a = ap.parse_args()

    if a.each and a.text:
        sys.exit("--each и --text вместе не имеют смысла: пачка берётся из md")
    if a.grid and not a.only:
        sys.exit("--grid без --only не работает: имена задают ячейки и порядок")
    if a.grid and a.each:
        sys.exit("--grid и --each — разные режимы: лист одной картинкой "
                 "против картинки на иконку")

    refs = [] if a.no_ref else list(a.ref or DEFAULT_REFS)
    key = None if a.dry_run else load_key(a.env)

    if not a.each and not a.grid:
        out = Path(a.out)
        if out.exists() and not a.force:
            sys.exit(f"{out} уже есть. Перезаписать — --force, иначе задать --out")
        prompt = a.task if a.text else read_prompt(a.task)
        sys.exit(0 if run(prompt, refs, out, a, key) else 1)

    template = read_prompt(a.task)
    rows = read_rows(a.task)
    if a.only:
        want = [n.strip() for n in a.only.split(",") if n.strip()]
        known = {n for n, _ in rows}
        missing = [n for n in want if n not in known]
        if missing:
            sys.exit(f"{a.task}: нет строк {', '.join(missing)}")
        # Листом порядок ячеек задаёт --only, а не порядок строк в таблице:
        # нарезка потом раскладывает имена в том же порядке.
        by_name = dict(rows)
        rows = [(n, by_name[n]) for n in want] if a.grid else \
               [(n, c) for n, c in rows if n in want]

    prompt_tail = ""
    if a.anchor:
        anchor = Path(a.anchor)
        if not anchor.is_file():
            sys.exit(f"--anchor {anchor}: файла нет. Сначала прогнать одну "
                     f"иконку без --anchor и убедиться, что стиль устоял")
        refs = refs + [str(anchor)]
        prompt_tail = "\n\n" + ANCHOR_NOTE

    if a.grid:
        try:
            cols, grows = (int(v) for v in a.grid.lower().split("x"))
        except ValueError:
            sys.exit(f"--grid {a.grid}: нужно вида 2x2")
        if cols * grows != len(rows):
            sys.exit(f"--grid {cols}x{grows} — это {cols * grows} ячеек, "
                     f"а в --only имён {len(rows)}")
        out = Path(a.out)
        if out.is_dir() or a.out.endswith("/"):
            sys.exit(f"--grid пишет ОДИН файл: --out {a.out} — это папка")
        if out.exists() and not a.force:
            sys.exit(f"{out} уже есть. Перезаписать — --force, иначе задать --out")
        prompt = fill(template, grid_block(rows, cols, grows)) + prompt_tail
        ok = run(prompt, refs, out, a, key)
        if ok and not a.dry_run:
            names = ",".join(n for n, _ in rows)
            print(f"нарезать: python3 slice_grid.py {out} --cols {cols} "
                  f"--rows {grows} --names {names} --out out-badge/",
                  file=sys.stderr)
        sys.exit(0 if ok else 1)

    outdir = Path("raw" if a.out == "sheet.png" else a.out)
    done = failed = skipped = 0
    for i, (name, cell) in enumerate(rows, 1):
        out = outdir / f"{name}.png"
        if out.exists() and not a.force:
            print(f"[{i}/{len(rows)}] {name}: уже есть, пропуск", file=sys.stderr)
            skipped += 1
            continue
        print(f"[{i}/{len(rows)}] {name}", file=sys.stderr)
        if run(fill(template, cell) + prompt_tail, refs, out, a, key):
            done += 1
        else:
            failed += 1

    print(f"готово {done}, пропущено {skipped}, не вышло {failed}", file=sys.stderr)
    # Неудачные не роняют пачку на первой же ошибке — остальные всё равно
    # нужны, а перекатить одну дешевле, чем гнать шестнадцать заново.
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
