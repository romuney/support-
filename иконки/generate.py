#!/usr/bin/env python3
"""Прогон задания через Nano Banana (Gemini Image API) без ручной возни.

    python3 generate.py prompt-pack.md --out sheet-d.png

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

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp"}


def read_prompt(path):
    """Первый огороженный блок ``` из markdown-задания."""
    text = Path(path).read_text(encoding="utf-8")
    blocks = re.findall(r"^```[^\n]*\n(.*?)^```", text, re.S | re.M)
    if not blocks:
        sys.exit(f"{path}: не нашёл блока ``` с промптом")
    return blocks[0].strip()


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


def main():
    ap = argparse.ArgumentParser(
        description="прогон задания из markdown через Gemini Image API")
    ap.add_argument("task", help="файл задания (prompt-pack.md) либо --text")
    ap.add_argument("--text", action="store_true",
                    help="считать аргумент готовым промптом, а не путём к md")
    ap.add_argument("--out", default="sheet.png", help="куда положить лист")
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
    ap.add_argument("--force", action="store_true", help="перезаписать --out")
    ap.add_argument("--dry-run", action="store_true",
                    help="показать, что отправится, и не отправлять")
    a = ap.parse_args()

    out = Path(a.out)
    if out.exists() and not a.force:
        sys.exit(f"{out} уже есть. Перезаписать — --force, иначе задать --out")

    prompt = a.task if a.text else read_prompt(a.task)
    refs = [] if a.no_ref else (a.ref or DEFAULT_REFS)
    parts = [{"text": prompt}] + [part_from_image(r) for r in refs]

    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": a.aspect, "imageSize": a.size},
        },
    }

    head = prompt.splitlines()[0] if prompt.splitlines() else ""
    print(f"модель {a.model}, {a.size} {a.aspect}", file=sys.stderr)
    print(f"промпт {len(prompt)} символов, первая строка: {head[:70]}", file=sys.stderr)
    print(f"референсы: {', '.join(refs) or 'нет'}", file=sys.stderr)

    if a.dry_run:
        print(f"тело запроса: {len(json.dumps(body))} байт, частей {len(parts)}, "
              f"generationConfig={json.dumps(body['generationConfig'])}",
              file=sys.stderr)
        return

    images, words = images_and_text(call(a.model, body, load_key(a.env), a.timeout))
    for line in words:
        print(f"модель: {line}", file=sys.stderr)
    if not images:
        sys.exit("картинки в ответе нет — смотреть строки «модель:» выше")

    # Больше одной картинки за прогон модель отдаёт редко, но если отдала —
    # молча выбросить лишние нельзя: лист мог прийти вторым.
    for i, blob in enumerate(images):
        path = out if i == 0 else out.with_name(f"{out.stem}-{i + 1}{out.suffix}")
        path.write_bytes(blob)
        print(f"{path} — {len(blob) // 1024} КБ")


if __name__ == "__main__":
    main()
