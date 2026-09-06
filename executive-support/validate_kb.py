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
import glob
import os
import re
import sys
from collections import defaultdict

KB = "kb"
CASES = "cases"
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
URN_RE = re.compile(r"^urn:dd:[a-z_]+:[a-z_]+:[a-z_]+:[A-Za-z0-9_.-]+$")

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
    report_links = None
    for header, rows in tables:
        if header and header[0] == "домен":
            domains = (header, rows)
        elif header and header[0] == "id":
            entities = (header, rows)
        elif header and header[0] == "id отчёта":
            self_service = (header, rows)
        elif header and header[0] == "маршрут":
            routes = (header, rows)
        elif header and header[0] == "ключ ссылки":
            report_links = (header, rows)

    # ЗАГОЛОВОК СЕКЦИИ МОСТА — ДОСЛОВНЫЙ, и валидатор обязан это стеречь.
    # Валидатор находит таблицу по шапке колонок, а узел «Plan» — по строке
    # «## Ссылки отчётов» (функция rows). Признаки разные: переименуй
    # секцию — валидатор останется зелёным, а бот перестанет резолвить
    # ссылки заказчиков вовсе, и по виду прогона это неотличимо от «ключа
    # нет в мосте».
    if report_links is not None and \
            not any(l.strip() == "## Ссылки отчётов" for l in lines):
        err("index.md: таблица моста лежит не под заголовком "
            "«## Ссылки отчётов» — «Plan» ищет секцию по нему дословно "
            "и при промахе молча перестаёт резолвить ссылки")

    if domains is None:
        err("index.md: не найдена таблица доменов (первая колонка «домен»)")
    if entities is None:
        err("index.md: не найдена таблица сущностей (первая колонка «id»)")
    return domains, entities, self_service, routes, report_links


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
            # МАСТЕР БЕЗ СТАТЬИ ЧИТАЕТСЯ КАК НИЧЕГО.
            #
            # «Мастер» по определению этой же таблицы — сущность, которая
            # в домене читается ПЕРВОЙ И ВСЕГДА. Путь «—» означает «статьи
            # нет», то есть обещание не выполняется ни разу: домен выбран,
            # код пошёл за мастером и не принёс ничего.
            #
            # Разбор 02.09: выгрузка руководителей продуктов и команд КП.
            # Вопрос про функциональную структуру, домен allocation — а его
            # мастер `t-functional-role` статьи не имеет вовсе. Даже попав
            # в домен верно, читать было бы нечего. Сущность с описанием
            # каталога продуктов (`t-functional-unit`) при этом мастером
            # не объявлена, и роутеру приходится называть её поимённо —
            # то есть попадать в одну строку из 51.
            #
            # Предупреждение, а не ошибка: чинится это написанием статьи
            # или сменой мастера, и решает владелец базы, а не скрипт.
            if str(ent.get("путь", "")).strip() in ("—", "-", ""):
                warn(f"index.md:{r['_line']}: мастер «{m}» домена «{d}» "
                     f"не имеет статьи (путь «{ent.get('путь', '')}»), "
                     f"а мастер читается первым и всегда — по этому домену "
                     f"код не принесёт ничего. Написать статью или сменить мастера")
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
    # Мастера домена исключаются из счёта буквально: их не выбирают — их
    # добирает код по таблице «Домены», и на сложность выбора они не влияют.
    # Порог меряет, из скольких строк агенту предстоит выбирать самому.
    # Раньше здесь считались все строки подряд, и порог срабатывал на доменах,
    # где выбирать было не из чего: домен из десяти сущностей, три из которых
    # мастера, объявлялся требующим дробления — а дробить было нечего.
    domain_masters = defaultdict(set)
    for r in dom_rows:
        for m in (x.strip() for x in r.get("мастер", "").split(",")):
            if m:
                domain_masters[r["домен"]].add(m)

    # ДОМЕН, У КОТОРОГО ЕДИНСТВЕННЫЙ МАСТЕР — ВИТРИНА ПО УМОЛЧАНИЮ.
    #
    # С 01.09 витрина по умолчанию читается на КАЖДОМ вопросе. Значит домен,
    # у которого других мастеров нет, не добавляет к чтению ничего: роутер
    # определил тему, а код по ней не добрал ни одной статьи. Домен в таком
    # виде — обещание без покрытия: тема в «о чём вопросы» названа, а данные
    # по ней лежат в сущности, которую никто не читает.
    #
    # Разбор 02.09, живой прогон: «где мне взять инвалидов, у которых есть
    # дети». Слово «дети» ведёт в personal-attributes, но единственный мастер
    # там — витрина сотрудников, где полей про детей нет. Витрина с детьми
    # лежит отдельной сущностью и мастером не объявлена, поэтому кодом
    # не добирается никогда — и бот честно ответил, что данных о детях
    # в материалах нет. У остальных предметных доменов мастер свой:
    # attendance → t-attendance, education → t-education.
    #
    # Витрина по умолчанию выводится ТАК ЖЕ, как в сборщике флоу: сущность,
    # назначенная мастером в наибольшем числе доменов. Своя константа здесь
    # разъехалась бы с той молча — это уже четвёртое место, где живёт
    # одно знание.
    #
    # Предупреждение, а не ошибка: чинится это дроблением домена или
    # назначением мастеров, и решение принимает владелец базы, а не скрипт.
    tally = defaultdict(int)
    for ms in domain_masters.values():
        for m in ms:
            tally[m] += 1
    default_mart, best = "", 0
    for r in ent_rows:
        if tally.get(r["id"], 0) > best:
            default_mart, best = r["id"], tally[r["id"]]
    if default_mart:
        for r in dom_rows:
            d = r["домен"]
            if domain_masters[d] == {default_mart}:
                warn(f"index.md:{r['_line']}: у домена «{d}» единственный мастер — "
                     f"«{default_mart}», а он читается на каждом вопросе и так. "
                     f"Значит по этому домену код не добирает НИЧЕГО: роутер "
                     f"тему определил, а статьи по ней не приехали. "
                     f"Дробить домен или назначить мастеров по темам")

    counts = defaultdict(int)
    for r in ent_rows:
        for d in (x.strip() for x in r["домен"].split(",")):
            if d != CROSS_DOMAIN and r["id"] not in domain_masters[d]:
                counts[d] += 1
    for d, n in sorted(counts.items()):
        if n > 10:
            warn(f"в домене «{d}» {n} сущностей без мастеров — "
                 f"пора дробить (порог 10)")


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


def check_report_links(rl_rows, ent_rows):
    """Проверка таблицы «Ссылки отчётов»: ключ ведёт к одному живому отчёту.

    Три отказа, и все три тихие. Ключ, назначенный двум отчётам, — бот
    уверенно назовёт не тот, а по виду прогона это неотличимо от нормы.
    Ключ на сущность без типа `report` — резолв найдёт строку, а карточки
    отчёта в DD не будет. Пермалинк в таблице — строка, которая совпадёт
    ровно один раз и будет выглядеть правилом.
    """
    by_id = {r["id"]: r for r in ent_rows}
    seen = {}
    for r in rl_rows:
        line, key, rid = r["_line"], r["ключ ссылки"], r["id отчёта"]

        if not key or key == DASH:
            err(f"index.md:{line}: пустой ключ ссылки — строка не совпадёт никогда")
            continue

        # Ключ хранится ГОЛЫМ: без хоста, схемы, слэшей, query и якоря.
        # Резолв в «Plan» сравнивает именно голый ключ, и строка со ссылкой
        # целиком не совпала бы ни с чем — молча, как отсутствующая.
        if re.search(r"[/?#]|^https?:", key):
            err(f"index.md:{line}: ключ «{key}» содержит путь, хост или query — "
                f"нужен только хвост после /superset/dashboard/")
            continue

        # Пермалинк — ссылка на СОСТОЯНИЕ дашборда, а не на дашборд: её
        # создаёт кнопка «поделиться» на каждый шаринг. Строка на пермалинк
        # покрывает одно обращение и притворяется правилом.
        #
        # Признак измерен, а не выдуман: 25 пермалинков из выгрузки канала
        # и из FEEDBACK_KEYS — ВСЕ ровно 11 символов, буквы и цифры без
        # разделителей. Ни один из тридцати с лишним настоящих слагов той же
        # выгрузки под это не подходит: у слагов есть дефисы или подчёркивания
        # (`hr-executive-report`, `Office_traffic_daily_detail`) либо длина
        # другая (`lna`, `growth`). Появится слаг ровно из 11 букв и цифр —
        # проверка забракует его ложно, но ГРОМКО: строку увидит человек,
        # а не бот молча зарезолвит не тот отчёт.
        if re.fullmatch(r"[A-Za-z0-9]{11}", key) and not key.isdigit():
            err(f"index.md:{line}: «{key}» похож на пермалинк Proteus "
                f"(/dashboard/p/…). Пермалинки в мост не заводятся — "
                f"нужен ключ из адресной строки дашборда")
            continue

        # Дубли ищутся БЕЗ УЧЁТА РЕГИСТРА — так же, как резолвит бот.
        # Слаги в Proteus бывают и `Office_traffic_daily_detail`,
        # и `hr-executive-report`, заказчик копирует ссылку как придётся,
        # поэтому «Plan» сравнивает в нижнем регистре. Проверка, различающая
        # регистр, пропустила бы пару `LNA` / `lna`: валидатор зелёный,
        # а в карте бота остаётся ОДНА из двух строк — которая, зависит
        # от порядка в файле. Ровно тот тихий отказ, ради которого
        # эта таблица и проверяется.
        low = key.lower()
        if low in seen:
            err(f"index.md:{line}: ключ «{key}» уже встречался в строке "
                f"{seen[low][0]} — один ключ не может вести к двум отчётам "
                f"(регистр не различается: так же резолвит бот)")
        # Хранится ПАРА, а не номер строки: ниже сверяется не «заведён ли
        # ключ», а «ведёт ли он к ЭТОМУ отчёту». Разница не косметическая —
        # см. комментарий у самой сверки.
        seen[low] = (line, rid)

        ent = by_id.get(rid)
        if ent is None:
            err(f"index.md:{line}: «{rid}» в «Ссылки отчётов» отсутствует "
                f"в таблице «Сущности»")
        elif ent["тип"] != "report":
            err(f"index.md:{line}: «{rid}» в «Ссылки отчётов» имеет тип "
                f"«{ent['тип']}», ожидается «report»")

        checked = r.get("проверено", "")
        if checked and checked != DASH and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", checked):
            err(f"index.md:{line}: «проверено» у «{key}» — «{checked}», "
                f"ожидается дата ГГГГ-ММ-ДД или прочерк")

    # СВЕРКА С `links:` СТАТЬИ — ПО ПАРЕ, А НЕ ПО ВХОЖДЕНИЮ КЛЮЧА.
    #
    # Два разных пропуска, и второй дороже. Ключа нет в мосте — ссылка
    # в статье есть, человек считает отчёт закрытым, а бот по ней не резолвит
    # ничего. Ключ есть, но ведёт к ДРУГОМУ отчёту — перепутанные местами
    # строки моста, — и тогда бот уверенно называет чужой отчёт, а автору
    # велено не сомневаться: «совпадение ключа однозначно». Проверка
    # на вхождение вторую ошибку не видит вовсе: она зелёная, и все пять
    # наборов тестов зелёные тоже, потому что закрепляют четыре ключа из
    # тринадцати. Истина при этом лежит рядом, в `links:` самой статьи.
    for e in ent_rows:
        if e["тип"] != "report" or e["путь"] in ("", DASH):
            continue
        if not os.path.isfile(e["путь"]):
            continue          # отсутствие файла ловит check_articles
        fm, _ = parse_frontmatter(e["путь"])
        links = (fm or {}).get("links")
        # Блочный YAML-список parse_frontmatter не понимает и отдаёт пустую
        # строку. Молча пропустить такую статью значит выключить сверку
        # с мостом ровно на ней — и по виду прогона это неотличимо от нормы.
        if links == "":
            err(f"{e['путь']}: `links:` записан блочным списком — разбор "
                f"фронтматтера понимает только inline `[a, b]`, ключ ссылки "
                f"не проверен")
            continue
        links = links or []
        for url in links if isinstance(links, list) else [links]:
            # Дословно форма из REPORT_LINK_RE (bot/build_time_flows.py):
            # `/superset` необязателен, «dashboard/» отделено слева границей,
            # регистр не важен. Копия, требовавшая `/superset/`, молча
            # пропускала короткую форму ссылки — то есть сверка не работала
            # ровно там, где мост дырявый.
            m = re.search(r"(?:^|[^A-Za-z0-9_.-])dashboard/(p/[A-Za-z0-9_-]+|[A-Za-z0-9_-]+)",
                          url, re.I)
            if not m:
                continue
            raw = m.group(1)
            if raw.startswith("p/"):
                continue          # пермалинк — в мост не идёт намеренно
            hit = seen.get(raw.lower())
            if hit is None:
                err(f"{e['путь']}: ключ ссылки «{raw}» из `links:` не заведён "
                    f"в таблицу «Ссылки отчётов» — бот по этой ссылке "
                    f"отчёт не найдёт")
            elif hit[1] != e["id"]:
                err(f"{e['путь']}: ключ «{raw}» из `links:` заведён "
                    f"(index.md:{hit[0]}) на «{hit[1]}», а статья — «{e['id']}»: "
                    f"бот уверенно назовёт не тот отчёт")


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

        # И ОБРАТНО. Проверка была односторонней: реестр обязан быть
        # подмножеством фронтматтера, а лишний алиас во фронтматтере
        # не замечался вовсе. Роутер при этом видит ТОЛЬКО проекцию реестра —
        # значит алиас, живущий лишь в статье, не работает ни разу, и понять
        # это по статье нельзя: там он на месте и выглядит рабочим. Ровно тот
        # же класс, что kb/process/*.md без reached_by: файл есть, до бота
        # не доезжает.
        missing = {norm_alias(a) for a in fm_aliases} - {norm_alias(a) for a in idx_aliases}
        if missing:
            err(f"{r['путь']}: алиасы есть во фронтматтере, но не в реестре: "
                f"{sorted(missing)} — роутер видит только реестр, "
                f"и такой алиас не сработает ни разу")

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


# В блоке перечня в обратных кавычках попадаются и имена полей («фильтр по
# `active_type_nm`»), и сами значения. Значения — человеческий текст, имена
# полей — латинские идентификаторы; отличаем по форме, иначе имя поля уедет
# в перечень значений и проверка начнёт ругаться сама на себя.
def enum_values(block):
    return {v for v in re.findall(r"`([^`]+)`", block)
            if not re.fullmatch(r"[a-z][a-z0-9_]*", v)}


def check_case_links():
    """Ссылки из кейсов — ПРЕДУПРЕЖДЕНИЕМ, а не ошибкой.

    Тот же пробел, что был у регламентов: check_articles() обходит строки
    реестра, кейсов в реестре нет, и их ссылки не проверял никто. Нашёлся он
    так же — задним числом: удаление kb/curated, kb/derived, kb/proposals
    и старой выгрузки оборвало три ссылки из кейсов, и валидатор остался
    зелёным.

    ПОЧЕМУ ПРЕДУПРЕЖДЕНИЕ. Кейс append-only: правка задним числом запрещена
    правилом, а не ленью — это архив того, что было. Ссылка в нём может
    протухнуть законно, когда владелец удаляет то, на что кейс ссылался,
    и чинить это переписыванием кейса нельзя. Плюс кейсы в контекст агента
    не подаются: битая ссылка здесь стоит дешевле, чем в статье, — она
    неудобна человеку, читающему историю, но не уводит бота.

    Ошибкой это сделать нельзя ещё и практически: любое законное удаление
    останавливало бы коммит в чужой части репозитория.
    """
    if not os.path.isdir(CASES):
        return
    for path in sorted(glob.glob(os.path.join(CASES, "*.md"))):
        body = open(path, encoding="utf-8").read()
        for link in re.findall(r"\[[^\]]*\]\(([^)#]+)\)", body):
            if link.startswith(("http://", "https://", "mailto:")):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(path), link))
            if not os.path.exists(target):
                warn(f"{path}: ссылка «{link}» никуда не ведёт "
                     f"(кейс append-only — чинится удалением цели или новым кейсом)")


def check_process_links():
    """Ссылки и упоминания id в регламентах kb/process/.

    `check_articles()` обходит СТРОКИ РЕЕСТРА, а регламентов в реестре нет —
    значит их относительные ссылки и упоминания id не проверял никто. При этом
    три файла из четырёх доезжают до бота (`reached_by: code`), и битая ссылка
    там стоит ровно столько же, сколько в статье: автор получает путь, который
    никуда не ведёт, и пересказывает его коллеге.
    """
    known = set()
    idx = open(INDEX, encoding="utf-8").read()
    for m in re.finditer(r"^\|\s*([a-z]+-[a-z0-9-]+)\s*\|", idx, re.M):
        known.add(m.group(1))

    for path in sorted(glob.glob(os.path.join(KB, "process", "*.md"))):
        rel = os.path.relpath(path, os.path.dirname(KB))
        body = open(path, encoding="utf-8").read()
        for link in re.findall(r"\[[^\]]*\]\(([^)#]+)\)", body):
            if link.startswith(("http://", "https://", "mailto:")):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(path), link))
            if not os.path.exists(target):
                err(f"{rel}: битая ссылка «{link}» → {target}")
        # Упоминание id, которого нет в реестре: тот же смысл, что в статьях —
        # агент увидит имя сущности и решит, что она есть.
        for m in re.finditer(r"`((?:m|r|t|rc)-[a-z0-9-]+)`", body):
            if m.group(1) not in known:
                err(f"{rel}: упомянут id «{m.group(1)}», которого нет в реестре")


def check_enum_values():
    """Значения полей-перечислений: одно написание на всю базу.

    Статья витрины перечисляет значения поля (`### Значения active_type_nm`),
    и остальные статьи фильтруют по ним. Расхождение здесь тихое В ОБЕ
    СТОРОНЫ, и вторая сторона хуже: неверное ИМЯ поля роняет запрос громко,
    а неверное НАПИСАНИЕ значения даёт ноль строк без ошибки — «в этой
    категории никого нет» читается как факт.

    Так и было: `m-active-headcount` фильтровал по `'Декрет', 'Прогульщик',
    'Мобилизованный'` в единственном числе, а перечень в `t-emp-structure`
    хранит их во множественном. Заметить это можно было только сверив
    две статьи глазами.

    Проверяются только поля, у которых В БАЗЕ ЕСТЬ явный перечень: без него
    сравнивать не с чем, и молчать правильнее, чем угадывать.
    """
    # Перечни: «### Значения `field`» плюс список значений в обратных кавычках
    # до следующего заголовка.
    enums = {}
    for path in sorted(glob.glob(os.path.join(KB, "*", "*.md"))):
        text = open(path, encoding="utf-8").read()
        for m in re.finditer(r"^#{2,4}\s+Значения\s+`([a-z0-9_]+)`\s*$",
                             text, re.M):
            field = m.group(1)
            rest = text[m.end():]
            nxt = re.search(r"^#{2,4}\s", rest, re.M)
            block = rest[: nxt.start()] if nxt else rest
            vals = enum_values(block)
            if not vals:
                continue
            # Перечень одного поля может лежать в двух статьях: в статье
            # витрины и в рецепте синонимов. ИСТОЧНИКОМ считается статья
            # витрины — там живёт сама витрина, — а второй перечень
            # проверяется наравне с остальными усто. Объединять их нельзя:
            # тогда неверное написание в одном месте оправдывало бы
            # неверное написание в другом, и проверка гасила бы ровно ту
            # ошибку, ради которой заведена.
            table = os.sep + "tables" + os.sep in path
            prev = enums.get(field)
            if prev is None or (table and os.sep + "tables" + os.sep not in prev[0]):
                enums[field] = (path, vals)

    if not enums:
        return

    for path in sorted(glob.glob(os.path.join(KB, "*", "*.md"))):
        rel = os.path.relpath(path, os.path.dirname(KB))
        text = open(path, encoding="utf-8").read()
        for field, (src, vals) in enums.items():
            if os.path.abspath(src) == os.path.abspath(path):
                continue
            # Второй перечень того же поля — тоже усто: значения из него
            # сверяются со значениями источника построчно.
            for m in re.finditer(
                    rf"^#{{2,4}}\s+Значения\s+`{field}`\s*$", text, re.M):
                rest = text[m.end():]
                nxt = re.search(r"^#{2,4}\s", rest, re.M)
                for v in enum_values(rest[: nxt.start()] if nxt else rest):
                    if v not in vals:
                        err(f"{rel}: значение «{v}» в перечне {field} расходится "
                            f"со статьёй витрины "
                            f"({os.path.relpath(src, os.path.dirname(KB))})")
            # `field = 'Значение'` и `field in ('А', 'Б')`
            for m in re.finditer(
                    rf"{field}\s*(?:=|in)\s*\(?\s*((?:'[^']*'\s*,?\s*)+)\)?", text):
                for v in re.findall(r"'([^']*)'", m.group(1)):
                    if v and v not in vals:
                        err(f"{rel}: значение «{v}» поля {field} не найдено "
                            f"в перечне ({os.path.relpath(src, os.path.dirname(KB))}). "
                            "Неверное написание даёт ноль строк БЕЗ ошибки — "
                            "сверить с перечнем или дополнить его")


def check_sql_schemas():
    """В примерах запросов схема пишется с префиксом читаемых вью.

    Каталожное имя (`emart.mdm_employee_x_person_party`) и имя для запроса
    (`prod_v_emart.…`) — разные вещи: из каталожной схемы select не пойдёт.
    В ПРОЗЕ каталожное имя уместно — там речь про объект каталога, — а внутри
    блока кода оно означает запрос, который не выполнится.

    Так и было: три FROM в `t-employee-client` ссылались на `emart.`, и любой,
    кто скопировал бы пример, получил бы ошибку доступа. Промах при этом
    громкий, но находится он у КОЛЛЕГИ, а не у нас, и стоит ему круга
    переписки — поэтому проверяется здесь, а не оставляется на потом.
    """
    schemas = r"(?:emart|hrmart|dds|dds_dic|dwh_hr)"
    for path in sorted(glob.glob(os.path.join(KB, "*", "*.md"))):
        rel = os.path.relpath(path, os.path.dirname(KB))
        inside = False
        for num, line in enumerate(open(path, encoding="utf-8"), 1):
            if line.lstrip().startswith("```"):
                inside = not inside
                continue
            if not inside:
                continue
            for m in re.finditer(rf"\b(from|join)\s+({schemas})\.", line, re.I):
                err(f"{rel}:{num}: в примере запроса схема без префикса — "
                    f"«{m.group(1)} {m.group(2)}.…». Из каталожной схемы select "
                    f"не пойдёт, нужно prod_v_{m.group(2)}")


def main():
    if not os.path.isfile(INDEX):
        print(f"не найден {INDEX} — запускать из корня репозитория", file=sys.stderr)
        return 1

    domains, entities, self_service, routes, report_links = read_index()
    dom_rows = as_dicts(domains, "Домены", ["домен", "о чём вопросы", "мастер"])
    ent_rows = as_dicts(entities, "Сущности",
                        ["id", "тип", "домен", "название", "путь",
                         "dd_urn", "алиасы", "статус", "описание"])
    ss_rows = as_dicts(self_service, "Самостоятельные выгрузки",
                       ["id отчёта", "ключевые слова"])
    rt_rows = as_dicts(routes, "Маршруты",
                       ["маршрут", "ключевые слова", "кому", "где", "проверено"])
    rl_rows = as_dicts(report_links, "Ссылки отчётов",
                       ["ключ ссылки", "id отчёта", "проверено"])

    if ent_rows:
        check_entities(ent_rows)
        check_aliases(ent_rows)
        check_articles(ent_rows)
        if dom_rows:
            check_domains(dom_rows, ent_rows)
        if ss_rows:
            check_self_service(ss_rows, ent_rows)
        check_report_links(rl_rows, ent_rows)
    if rt_rows:
        check_routes(rt_rows)
    check_process()
    check_process_links()
    check_case_links()
    check_enum_values()
    check_sql_schemas()

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
