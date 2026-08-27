#!/usr/bin/env python3
"""Проверяет целостность базы знаний: реестр, домены, мастера, алиасы, ссылки.

Запускается из корня репозитория перед коммитом любой правки в kb/:

    python3 validate_kb.py

Смысл проверок — детерминированно ловить то, что при масштабировании базы
разъезжается молча: домен, придуманный в строке сущности вместо таблицы доменов;
алиас, уводящий на две разные сущности; мастер, не входящий в свой домен;
фронтматтер, разошедшийся с реестром. Прогон агента по индексу такую сверку
делать не должен: он недетерминирован и перезаписывает то, что человек
подтвердил, — а подтверждённое определение здесь и есть главная ценность.

Никаких зависимостей: PyYAML в среде нет, фронтматтер разбирается вручную —
в статьях он плоский, скаляры и inline-списки.

Код возврата 0 — чисто, 1 — есть ошибки.
"""
import os
import re
import sys
from collections import defaultdict

KB = "kb"
INDEX = os.path.join(KB, "index.md")

# Префикс id по типу и папка, в которой этот тип живёт.
TYPES = {
    "metric": ("m-", "kb/metrics"),
    "report": ("r-", "kb/reports"),
    "table": ("t-", "kb/tables"),
    "recipe": ("rc-", "kb/recipes"),
}
STATUSES = {"draft", "active"}
DASH = "—"
CROSS_DOMAIN = "*"
URN_RE = re.compile(r"^urn:dd:[a-z_]+:[a-z_]+:[a-z_]+:[A-Za-z0-9_.]+$")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


# ------------------------------------------------------------------ фронтматтер
def parse_frontmatter(path):
    """Возвращает dict со значениями фронтматтера. Списки — только inline [a, b]."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---", 4)
    if end == -1:
        return None, text
    body = text[end + 4:]
    data = {}
    for line in text[4:end].split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, raw = line.partition(":")
        key, raw = key.strip(), raw.strip()
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            data[key] = [v.strip() for v in inner.split(",") if v.strip()] if inner else []
        else:
            data[key] = raw.strip("'\"")
    return data, body


# ------------------------------------------------------------- разбор index.md
def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def read_index():
    """Читает kb/index.md: таблицу доменов и таблицу сущностей.

    Таблицы различаются по заголовку первой колонки, а не по порядку в файле:
    порядок разделов может поменяться, смысл колонок — нет.
    """
    with open(INDEX, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    tables = []  # (header, [(номер строки, [ячейки])])
    cur = None
    for no, line in enumerate(lines, 1):
        s = line.strip()
        if s.startswith("|"):
            cells = split_row(s)
            if all(set(c) <= set("-: ") and c for c in cells):
                continue  # разделитель
            if cur is None:
                cur = (cells, [])
                tables.append(cur)
            else:
                cur[1].append((no, cells))
        else:
            cur = None

    domains, entities, self_service, routes = None, None, None, None
    for header, rows in tables:
        if header and header[0] == "домен":
            domains = (header, rows)
        elif header and header[0] == "id":
            entities = (header, rows)
        elif header and header[0] == "id отчёта":
            self_service = (header, rows)
        elif header and header[0] == "маршрут":
            routes = (header, rows)

    if domains is None:
        err("index.md: не найдена таблица доменов (первая колонка «домен»)")
    if entities is None:
        err("index.md: не найдена таблица сущностей (первая колонка «id»)")
    return domains, entities, self_service, routes


def as_dicts(table, name, required):
    if table is None:
        return []
    header, rows = table
    missing = [c for c in required if c not in header]
    if missing:
        err(f"index.md, таблица «{name}»: нет колонок {missing}")
        return []
    out = []
    for no, cells in rows:
        if len(cells) != len(header):
            err(f"index.md:{no}: {len(cells)} ячеек вместо {len(header)}")
            continue
        row = dict(zip(header, cells))
        row["_line"] = no
        out.append(row)
    return out


# ------------------------------------------------------------------- проверки
def norm_alias(a):
    """Нормализует алиас для сравнения: регистр и пунктуация не различают."""
    return re.sub(r"[^\wёа-я]+", "", a.lower(), flags=re.UNICODE)


def check_domains(dom_rows, ent_rows):
    known = set()
    for r in dom_rows:
        d = r["домен"]
        if d in known:
            err(f"index.md:{r['_line']}: домен «{d}» объявлен дважды")
        known.add(d)
        if not r.get("о чём вопросы"):
            err(f"index.md:{r['_line']}: у домена «{d}» пустая колонка «о чём вопросы»")

    by_id = {r["id"]: r for r in ent_rows}
    # Проверка 5+6: мастера существуют, входят в свой домен, не более одного на тип.
    for r in dom_rows:
        d = r["домен"]
        masters = [m.strip() for m in r.get("мастер", "").split(",") if m.strip()]
        if not masters:
            err(f"index.md:{r['_line']}: у домена «{d}» нет ни одного мастера — "
                f"у темы должна быть точка входа")
        per_type = defaultdict(list)
        for m in masters:
            ent = by_id.get(m)
            if ent is None:
                err(f"index.md:{r['_line']}: мастер «{m}» домена «{d}» "
                    f"отсутствует в таблице сущностей")
                continue
            ent_domains = {x.strip() for x in ent["домен"].split(",")}
            if d not in ent_domains and CROSS_DOMAIN not in ent_domains:
                err(f"index.md:{r['_line']}: «{m}» назначен мастером домена «{d}», "
                    f"но в его строке домены {sorted(ent_domains)}")
            per_type[ent["тип"]].append(m)
        for t, ids in per_type.items():
            if len(ids) > 1:
                err(f"index.md:{r['_line']}: в домене «{d}» больше одного мастера "
                    f"типа «{t}»: {ids} — мастер должен быть один")

    # Проверка 3: домен сущности объявлен в таблице доменов.
    for r in ent_rows:
        for d in (x.strip() for x in r["домен"].split(",")):
            if not d:
                err(f"index.md:{r['_line']}: у «{r['id']}» пустой домен")
            elif d != CROSS_DOMAIN and d not in known:
                err(f"index.md:{r['_line']}: у «{r['id']}» домен «{d}» "
                    f"не объявлен в таблице «Домены»")

    # Домен, у которого не осталось сущностей, — мёртвая тема в промпте агента.
    used = {d.strip() for r in ent_rows for d in r["домен"].split(",")}
    for d in sorted(known - used):
        warn(f"домен «{d}» объявлен, но ни одна сущность к нему не отнесена")

    # Порог дробления. Мастера не считаем: они и так читаются всегда.
    counts = defaultdict(int)
    for r in ent_rows:
        for d in (x.strip() for x in r["домен"].split(",")):
            if d != CROSS_DOMAIN:
                counts[d] += 1
    for d, n in sorted(counts.items()):
        if n > 10:
            warn(f"в домене «{d}» {n} сущностей — пора дробить (порог 10)")


def check_entities(ent_rows):
    seen_ids = {}
    prev_id = None
    for r in ent_rows:
        line, eid, typ = r["_line"], r["id"], r["тип"]

        if eid in seen_ids:
            err(f"index.md:{line}: id «{eid}» уже встречался в строке {seen_ids[eid]}")
        seen_ids[eid] = line

        if prev_id is not None and eid < prev_id:
            err(f"index.md:{line}: реестр не отсортирован — «{eid}» после «{prev_id}»")
        prev_id = eid

        if typ not in TYPES:
            err(f"index.md:{line}: неизвестный тип «{typ}», ожидается {sorted(TYPES)}")
        else:
            prefix, folder = TYPES[typ]
            if not eid.startswith(prefix):
                err(f"index.md:{line}: id «{eid}» типа «{typ}» "
                    f"должен начинаться с «{prefix}»")
            if r["путь"] != DASH and not r["путь"].startswith(folder + "/"):
                err(f"index.md:{line}: «{eid}» типа «{typ}» лежит в {r['путь']}, "
                    f"а должен в {folder}/")

        if r["статус"] not in STATUSES:
            err(f"index.md:{line}: статус «{r['статус']}» у «{eid}», "
                f"ожидается {sorted(STATUSES)}")

        urn = r["dd_urn"]
        if urn != DASH and not URN_RE.match(urn):
            err(f"index.md:{line}: dd_urn «{urn}» у «{eid}» не похож на URN")

        if r["путь"] == DASH and urn == DASH:
            err(f"index.md:{line}: у «{eid}» нет ни пути, ни dd_urn — "
                f"строка не даёт агенту ничего")

        if not r.get("описание"):
            err(f"index.md:{line}: у «{eid}» пустое описание")

    # Один URN на две сущности — почти наверняка copy-paste.
    urns = defaultdict(list)
    for r in ent_rows:
        if r["dd_urn"] != DASH:
            urns[r["dd_urn"]].append(r["id"])
    for urn, ids in urns.items():
        if len(ids) > 1:
            err(f"index.md: один dd_urn у нескольких сущностей {ids}: {urn}")

    return seen_ids


def check_aliases(ent_rows):
    """Проверка 4: один алиас — одна сущность."""
    owners = defaultdict(list)
    titles, ids = {}, {}
    for r in ent_rows:
        titles[norm_alias(r["название"])] = r["id"]
        ids[norm_alias(r["id"])] = r["id"]

    for r in ent_rows:
        for a in (x.strip() for x in r["алиасы"].split(",")):
            if not a:
                continue
            n = norm_alias(a)
            owners[n].append((r["id"], a, r["_line"]))
            if n in titles and titles[n] != r["id"]:
                err(f"index.md:{r['_line']}: алиас «{a}» у «{r['id']}» совпадает "
                    f"с названием другой сущности «{titles[n]}»")
            if n in ids and ids[n] != r["id"]:
                err(f"index.md:{r['_line']}: алиас «{a}» у «{r['id']}» совпадает "
                    f"с id другой сущности «{ids[n]}»")

    for n, hits in sorted(owners.items()):
        holders = {h[0] for h in hits}
        if len(holders) > 1:
            listed = ", ".join(f"«{a}» у {i} (строка {ln})" for i, a, ln in hits)
            err(f"index.md: алиас ведёт к разным сущностям: {listed}. "
                f"Развести формулировки или объединить сущности")


def check_self_service(ss_rows, ent_rows):
    """Проверка таблицы «Самостоятельные выгрузки»: id — существующий report."""
    by_id = {r["id"]: r for r in ent_rows}
    seen = {}
    for r in ss_rows:
        line, rid = r["_line"], r["id отчёта"]
        if rid in seen:
            err(f"index.md:{line}: id «{rid}» в «Самостоятельные выгрузки» "
                f"уже встречался в строке {seen[rid]}")
        seen[rid] = line

        ent = by_id.get(rid)
        if ent is None:
            err(f"index.md:{line}: «{rid}» в «Самостоятельные выгрузки» "
                f"отсутствует в таблице «Сущности»")
        elif ent["тип"] != "report":
            err(f"index.md:{line}: «{rid}» в «Самостоятельные выгрузки» "
                f"имеет тип «{ent['тип']}», ожидается «report»")

        if not r.get("ключевые слова"):
            err(f"index.md:{line}: у «{rid}» пустые «ключевые слова» — "
                f"строка никогда не сработает")


def check_routes(rt_rows):
    """Проверка таблицы «Маршруты»: адресат, слова и срок годности.

    Маршрут — утверждение про человека, и протухает оно молча: владельца
    отчёта мы для этого и не дублируем в git, а берём онлайн из DD. Здесь
    взять неоткуда — объекта «кто ведёт квоты» в каталоге нет, — поэтому
    у строки обязана быть ДАТА подтверждения, и валидатор её требует.
    Строка без даты выглядит такой же рабочей, как свежая.
    """
    seen = {}
    for r in rt_rows:
        line, rid = r["_line"], r["маршрут"]
        if rid in seen:
            err(f"index.md:{line}: маршрут «{rid}» уже встречался "
                f"в строке {seen[rid]}")
        seen[rid] = line

        if not r.get("ключевые слова"):
            err(f"index.md:{line}: у маршрута «{rid}» пустые «ключевые слова» — "
                f"строка никогда не сработает")

        # Адресат — или человек, или канал. Пусто в обоих значит строку,
        # которая срабатывает и ничего не называет: джун всё равно идёт
        # выяснять, к кому идти, а бот при этом выглядит ответившим.
        who, where = r.get("кому", DASH), r.get("где", DASH)
        if who in ("", DASH) and where in ("", DASH):
            err(f"index.md:{line}: у маршрута «{rid}» пусты и «кому», и «где» — "
                f"маршрут никуда не ведёт")

        checked = r.get("проверено", "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked):
            err(f"index.md:{line}: у маршрута «{rid}» «проверено» = «{checked}», "
                f"ожидается дата ГГГГ-ММ-ДД: без неё протухший маршрут "
                f"неотличим от свежего")


def check_process():
    """Регламенты kb/process/: как каждый из них доезжает до бота.

    Роутер эти файлы не выбирает НИКОГДА — строк kb/process/ в реестре нет,
    у них ни домена, ни dd_urn. До бота такой файл доезжает, только если его
    путь вписан в код сборщика и добирается по признаку обращения (плейбук
    выгрузки — по теме, маршрутизация — по теме «доступ», конвенции запросов
    — по просьбе помочь с запросом).

    Свойство это невидимое: файл лежит в базе, читается человеком, ссылки
    на него из статей живые — и при этом до агента он не доезжал ни разу.
    Ровно так прожил kb/process/sql-conventions.md: на вопрос «как написать
    select» у бота не было ни одной статьи о том, как этот select положено
    писать. Ни валидатор, ни ссылки, ни чтение файла этого не показывали.

    Поэтому файл обязан САМ сказать, как он доезжает, — поле reached_by:
      code   — путь вписан в сборщик бота, добирается признаком обращения;
      human  — только для людей и для агента, правящего базу; бот не читает.

    Проверить, что «code» не соврал, валидатор не может: сборщик живёт
    в другом репозитории. Но необъявленный файл он поймает — а это ровно
    тот случай, когда ошибку ещё дёшево исправить.
    """
    folder = "kb/process"
    if not os.path.isdir(folder):
        return
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(folder, name)
        fm, _ = parse_frontmatter(path)
        how = (fm or {}).get("reached_by", "")
        if how not in ("code", "human"):
            warn(f"{path}: не указано reached_by (code | human) — непонятно, "
                 f"доезжает ли файл до бота вообще: роутер kb/process/ "
                 f"не выбирает, путь должен быть вписан в сборщик")


def check_articles(ent_rows):
    """Проверки 1 и 2: файл существует, фронтматтер совпадает с реестром, ссылки живы."""
    in_index = {}
    for r in ent_rows:
        if r["путь"] == DASH:
            continue
        in_index[r["путь"]] = r
        if not os.path.isfile(r["путь"]):
            err(f"index.md:{r['_line']}: файла «{r['путь']}» нет — "
                f"реестр ссылается на несуществующую статью")
            continue

        fm, body = parse_frontmatter(r["путь"])
        if fm is None:
            err(f"{r['путь']}: нет YAML-фронтматтера")
            continue

        for field, col in (("id", "id"), ("type", "тип"),
                           ("title", "название"), ("status", "статус")):
            got, want = fm.get(field), r[col]
            if field == "title":
                # Заголовок в статье длиннее, в реестре — короткая форма.
                # Требуем совпадения начала, а не буквального равенства.
                if got and not got.lower().startswith(want.lower()[:20]):
                    err(f"{r['путь']}: title «{got}» не соответствует названию "
                        f"«{want}» в реестре")
                continue
            if got != want:
                err(f"{r['путь']}: {field} «{got}», а в реестре «{want}»")

        if "домен" in fm or "domain" in fm:
            err(f"{r['путь']}: домен во фронтматтере — он живёт только в реестре, "
                f"иначе разъедется")
        if "master" in fm or "мастер" in fm:
            err(f"{r['путь']}: мастерство во фронтматтере — оно свойство пары "
                f"«домен + сущность» и живёт только в таблице «Домены»")

        fm_aliases = fm.get("aliases") or []
        idx_aliases = [a.strip() for a in r["алиасы"].split(",") if a.strip()]
        extra = {norm_alias(a) for a in idx_aliases} - {norm_alias(a) for a in fm_aliases}
        if extra:
            err(f"{r['путь']}: алиасы есть в реестре, но не во фронтматтере: "
                f"{sorted(extra)}")

        for link in re.findall(r"\[[^\]]*\]\(([^)#]+)\)", body):
            if link.startswith(("http://", "https://", "mailto:")):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(r["путь"]), link))
            if not os.path.exists(target):
                err(f"{r['путь']}: битая ссылка «{link}» → {target}")

        # Ссылка на сущность по id в тексте: id должен быть в реестре.
        for ref in set(re.findall(r"`((?:m|r|t|rc)-[a-z0-9-]+)`", body)):
            if ref not in {e["id"] for e in ent_rows}:
                err(f"{r['путь']}: упомянут id «{ref}», которого нет в реестре")

    # Файл в kb/, не внесённый в реестр: для агента его не существует.
    for _, folder in TYPES.values():
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            path = os.path.join(folder, name)
            if not name.endswith(".md") or path in in_index:
                continue
            err(f"{path}: файл есть, а строки в реестре нет — для агента "
                f"этой статьи не существует")


def main():
    if not os.path.isfile(INDEX):
        print(f"не найден {INDEX} — запускать из корня репозитория", file=sys.stderr)
        return 1

    domains, entities, self_service, routes = read_index()
    dom_rows = as_dicts(domains, "Домены", ["домен", "о чём вопросы", "мастер"])
    ent_rows = as_dicts(entities, "Сущности",
                        ["id", "тип", "домен", "название", "путь",
                         "dd_urn", "алиасы", "статус", "описание"])
    ss_rows = as_dicts(self_service, "Самостоятельные выгрузки",
                       ["id отчёта", "ключевые слова"])
    rt_rows = as_dicts(routes, "Маршруты",
                       ["маршрут", "ключевые слова", "кому", "где", "проверено"])

    if ent_rows:
        check_entities(ent_rows)
        check_aliases(ent_rows)
        check_articles(ent_rows)
        if dom_rows:
            check_domains(dom_rows, ent_rows)
        if ss_rows:
            check_self_service(ss_rows, ent_rows)
    if rt_rows:
        check_routes(rt_rows)
    check_process()

    for w in warnings:
        print(f"ПРЕДУПРЕЖДЕНИЕ: {w}")
    for e in errors:
        print(f"ОШИБКА: {e}")

    if errors:
        print(f"\n{len(errors)} ошибок, {len(warnings)} предупреждений")
        return 1
    print(f"OK: {len(ent_rows)} сущностей, {len(dom_rows)} доменов, "
          f"{len(warnings)} предупреждений")
    return 0


if __name__ == "__main__":
    sys.exit(main())
