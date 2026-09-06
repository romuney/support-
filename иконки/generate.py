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
  уходили с листа. Перекатить одну — удалить файл и позвать с `--only`.

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
ANCHOR_NOTE = (
    "The last attached image is an approved image of this character. Match its "
    "STYLE exactly and only its style: the same 3D render, the same fine fur "
    "with individual hairs, the same soft studio lighting and shading, the same "
    "freckles and whiskers on the muzzle, the same worn fabric texture on the "
    "cap, the same huge glossy eyes with the same highlights. Ignore its pose, "
    "its crop and its background — those come from the instructions above, not "
    "from it. Do not copy its background."
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

    refs = [] if a.no_ref else list(a.ref or DEFAULT_REFS)
    key = None if a.dry_run else load_key(a.env)

    if not a.each:
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
        rows = [(n, c) for n, c in rows if n in want]

    prompt_tail = ""
    if a.anchor:
        anchor = Path(a.anchor)
        if not anchor.is_file():
            sys.exit(f"--anchor {anchor}: файла нет. Сначала прогнать одну "
                     f"иконку без --anchor и убедиться, что стиль устоял")
        refs = refs + [str(anchor)]
        prompt_tail = "\n\n" + ANCHOR_NOTE

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
