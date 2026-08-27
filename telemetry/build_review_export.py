#!/usr/bin/env python3
"""Сборщик разового флоу для ручного разбора обращений с фидбеком.

Собирает:

    Telemetry Review Export.json

Отдельный воркфлоу, а не правка `build_telemetry_flows.py`. Аналитик пишет
комментарии в `feedback_text` (кнопка «Написать подробнее» под ответом бота),
но исходного текста вопроса в витрине `support_request` нет и не будет —
`Telemetry Ingest` пишет только `text_len`/`permalink`, само сообщение никуда
не попадает (см. `NORMALIZE_JS` в `build_telemetry_flows.py`). Хотели решить
это правкой продового `Ingest` — но это лог, который пишется на каждое
сообщение канала, и трогать его ради разового анализа не нужно: текст вопроса
и так восстанавливается по `request_id` (= id корневого поста Time) через
`GET /api/v4/posts/{id}`.

Флоу читает из DLH ТОЛЬКО строки, где `feedback_text` уже заполнен —
остальные аналитику для разбора не нужны. `Manual Trigger`, никакого
расписания и никакой связи с production-цепочкой Ingest/Collector/Flush.

Запускать ИЗ ЭТОЙ ПАПКИ (`cd telemetry`).

Порядок установки:
    1. python3 build_review_export.py
    2. Импортировать Telemetry Review Export.json, запускать вручную

Ничего пересобирать после импорта не нужно: флоу не вызывает подворкфлоу
и не открывает вебхук, статических id внутри нет.
"""

import copy
import json

DST = "Telemetry Review Export.json"

# Те же credential, что в build_telemetry_flows.py — тот же бот, тот же
# Trino-аккаунт, отдельного доступа заводить не нужно. Продублированы здесь,
# а не импортированы: сборщики в этом репозитории самостоятельны (см.
# build_dd_flow.py / build_time_flows.py), и это разовый инструмент аналитика,
# а не часть production-цепочки телеметрии.
MM_CRED = {"mattermostApi": {"id": "7SgPbuQnw6w2wzMl", "name": "Time Bully"}}
DLH_TRINO_CRED = {"trinoApi": {"id": "82c1YyhkiBGT25Ag",
                                "name": "DWH (Trino DLH) account 128"}}

# Витрина обращений в DLH (telemetry/support_request.sql, полный список
# колонок — SELECT там же). `request_id` — это `thread_id` из лога, то есть
# id корневого поста Time (build_telemetry_flows.py: thread_id = post.root_id
# || post.id, для корневого поста это post.id). Отбор по feedback_text:
# остальные строки не участвуют в разборе.
#
# ТОЛЬКО поля, полезные для разбора качества базы/промпта — НЕ весь набор
# колонок витрины. Осознанно выброшены: время реакции/цикла, кто взял/закрыл,
# статусы задачи трекера, счётчики реплик — это про процесс поддержки,
# а не про то, почему бот ответил неверно или неполно. Если понадобится
# процессная аналитика — это `support_request.sql` напрямую, не этот флоу.
#
# `confidence_claimed/confidence_key/confidence_downgraded/domains/
# articles_read/dd_count/router_error/parse_error/prompt_version` будут NULL
# до тех пор, пока в ядро бота не врезан узел `Ingest` (`bot_answered` пока
# никто не пишет, см. комментарий у CTE `bot` в support_request.sql) —
# это не повод убирать поля отсюда, а сигнал того, что врезка ещё не дошла
# до прода.
REVIEW_SQL = (
    "SELECT\n"
    "    request_id,\n"
    "    created_date,\n"
    "    permalink,\n"
    "    kind,\n"
    "    topic,\n"
    "    domains,\n"
    "    confidence_claimed,\n"
    "    confidence_key,\n"
    "    confidence_downgraded,\n"
    "    articles_read,\n"
    "    dd_count,\n"
    "    router_error,\n"
    "    parse_error,\n"
    "    prompt_version,\n"
    "    draft_useful,\n"
    "    feedback_text\n"
    "FROM dl.usr_cross_data.support_request\n"
    "WHERE feedback_text IS NOT NULL\n"
    "ORDER BY created_at DESC"
)

# Склейка результата Trino с ответом Time по индексу. Без явной проверки
# длин расхождение (например, из-за онError на HTTP-ноде, отбросившего
# элемент) склеило бы вопрос НЕ с той строкой фидбека — тихая порча данных,
# которую в результате выполнения не отличить от верной.
MERGE_JS = r"""
const rows = $('Read reviewed requests').all().map((x) => x.json || {});
const posts = $input.all().map((x) => x.json || {});

if (!rows.length) {
  return [{ json: {
    ok: true,
    note: 'нет строк с заполненным feedback_text — обогащать нечего',
    rows: 0,
  } }];
}

if (rows.length !== posts.length) {
  throw new Error(
    'Число строк с фидбеком (' + rows.length + ') не совпадает с числом '
    + 'ответов Time (' + posts.length + ') — соответствие по индексу '
    + 'нарушено, склеивать нельзя'
  );
}

// Явный список полей на выходе, а не {...r}: порядок и состав фиксированы
// здесь же, рядом с REVIEW_SQL, а не выводятся из того, что случайно
// приехало из Trino.
return rows.map((r, i) => {
  const post = posts[i] || {};
  const ok = typeof post.id === 'string' && typeof post.message === 'string';
  return { json: {
    question_text: ok ? post.message : null,
    // Пост могли удалить, либо истёк Service Account — молчать об этом
    // нельзя: пустой question_text должен читаться как «не получилось»,
    // а не как «вопроса не было».
    question_fetch_error: ok ? ''
      : 'не удалось получить исходный пост: ' + JSON.stringify(post).slice(0, 200),
    feedback_text: r.feedback_text,
    kind: r.kind,
    topic: r.topic,
    domains: r.domains,
    confidence_claimed: r.confidence_claimed,
    confidence_key: r.confidence_key,
    confidence_downgraded: r.confidence_downgraded,
    articles_read: r.articles_read,
    dd_count: r.dd_count,
    router_error: r.router_error,
    parse_error: r.parse_error,
    prompt_version: r.prompt_version,
    draft_useful: r.draft_useful,
    created_date: r.created_date,
    request_id: r.request_id,
    permalink: r.permalink,
  } };
});
"""


def node(name, type_, tv, pos, params, **extra):
    n = {
        "parameters": params,
        "type": type_,
        "typeVersion": tv,
        "position": pos,
        "id": name.lower().replace(" ", "-").replace("(", "").replace(")", ""),
        "name": name,
    }
    n.update(extra)
    return n


def chain(*names):
    conn = {}
    for a, b in zip(names, names[1:]):
        conn[a] = {"main": [[{"node": b, "type": "main", "index": 0}]]}
    return conn


def wf(name, nodes, connections):
    return {
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }


def build_review_export():
    # Имена параметров CUSTOM.trino (query/timeout/timeZone) НЕ подтверждены
    # живым узлом — то же предупреждение, что у Telemetry Flush. Проверить
    # после импорта: пустые Query/Timeout/Time Zone в UI значат, что угаданы
    # неверно.
    read = node("Read reviewed requests", "CUSTOM.trino", 3, [-260, 300], {
        "query": REVIEW_SQL,
        "timeout": 900,
        "timeZone": "Europe/Moscow",
    }, credentials=copy.deepcopy(DLH_TRINO_CRED))

    # followRedirects: false — то же решение, что на нодах DD и в Backfill:
    # редирект на страницу логина иначе приходит как 200 с HTML, и «поста
    # нет» становится неотличимо от «истёк токен». onError=continue: пост
    # могли удалить, и одна пропавшая строка не должна ронять весь разбор.
    get_post = node("Get original post", "n8n-nodes-base.httpRequest", 4.2,
                     [-20, 300], {
        "method": "GET",
        "url": "=https://time.tbank.ru/api/v4/posts/{{ $json.request_id }}",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "mattermostApi",
        "options": {"redirect": {"redirect": {"followRedirects": False}}},
    }, credentials=copy.deepcopy(MM_CRED), onError="continueRegularOutput")

    merge = node("Merge with question", "n8n-nodes-base.code", 2, [220, 300], {
        "jsCode": MERGE_JS,
    })

    nodes = [
        node("Run manually", "n8n-nodes-base.manualTrigger", 1, [-500, 300], {}),
        read, get_post, merge,
    ]
    conn = {}
    conn.update(chain("Run manually", "Read reviewed requests",
                      "Get original post", "Merge with question"))
    return wf("Telemetry · Review Export", nodes, conn)


def main():
    data = build_review_export()
    with open(DST, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"OK {DST} — {len(data['nodes'])} нод")
    for n in data["nodes"]:
        print(f"  - {n['name']}")
    print("\nИмпортировать и запускать вручную — ничего пересобирать не нужно.")
    print("После импорта проверить у Read reviewed requests: если поля")
    print("Query/Timeout/Time Zone пустые — имена параметров CUSTOM.trino")
    print("угаданы неверно, править REVIEW_SQL/build_review_export здесь.")


if __name__ == "__main__":
    main()
