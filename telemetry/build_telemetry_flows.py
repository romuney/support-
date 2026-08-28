#!/usr/bin/env python3
"""Сборщик флоу телеметрии канала ~hr-report-ask.

Собирает воркфлоу:

    Telemetry Ingest.json     единственная точка записи события
    Telemetry Collector.json  push-события канала → Ingest
    Telemetry Backfill.json   засев истории через API → Ingest
    Telemetry Collector Tracker.json  статусы задач трекера → Ingest
    Feedback Webhook.json     кнопки под ответом бота → Ingest
    Telemetry Report.json     пересчёт лога в разбивку по темам
    Telemetry Flush.json      батч из Data Tables → INSERT в DLH Trino (Iceberg)

Всё, что пишет в телеметрию (коллектор, вебхук кнопок, ядро бота), вызывает
`Ingest` и не знает, где лежит хранилище. Сменить его = правка одного узла.

Хранилище — **n8n Data Tables**, таблица `support_event`: append-only лог.
Это буфер и первое хранилище одновременно. `Telemetry Flush` раз в час
переливает новые строки в `dl.usr_cross_data.support_telemetry` (Iceberg,
партиционирование `day(event_ts)`, создана руками; DDL — `--print-ddl`).
Построчно в Iceberg писать нельзя из-за мелких файлов, и деградирует от них
ЧТЕНИЕ, то есть будущий дашборд, — поэтому Flush собирает батч и заливает
его пачками: `MERGE INTO … ON t.event_id = s.event_id`, чанками по
`FLUSH_MAX_ROWS` строк.

Три решения там держат конструкцию, и каждое закрывает тихую ошибку:

* **MERGE, а не INSERT.** `Ingest` пишет upsert'ом и всегда обновляет
  `ingested_at`, поэтому повторный backfill протаскивает ту же строку через
  watermark второй раз — при INSERT это дубль в DLH и завышенные счётчики.
  Запасной путь `DLH_WRITE_MODE=insert` есть, но тогда дедуп обязан делать
  пересчёт витрины.
* **Чанки.** Один запрос со всеми строками упирается в `query.max-length`
  Trino (1 000 000 символов), и отказ накрывает весь батч: после засева
  истории не залилось бы ничего. Чанки идут по возрастанию `ingested_at`,
  так что падение на середине оставляет консистентный префикс.
* **Watermark — запросом к самой таблице**, а не отдельным курсором, и его
  разбор роняет прогон на неожиданной форме ответа. Подставленный 0 значил бы
  перезалив всей истории, пустое значение — тихо не доезжающую телеметрию.

**Имена параметров узла `CUSTOM.trino` (`query`/`timeout`/`timeZone`) НЕ
подтверждены живым узлом.** Три попытки скопировать заполненную ноду
(Cmd+C, экспорт воркфлоу, JSON-дамп UI) дали пустой `parameters: {}` —
похоже, эта кастомная нода не сериализует свои поля через обычный
механизм копирования n8n. Названия взяты по аналогии с подписями на
скриншоте («Query», «Timeout (Seconds)», «Time Zone») и требуют проверки
после импорта: если поля в UI останутся пустыми — это подтверждает, что
угаданы неверно, и правится здесь, в `build_flush()`.

Запись — `upsert` по `event_id`, а не `insert`. Крон-сверка и повторный
прогон backfill перечитают те же посты; без upsert в витрине появятся дубли
обращений, и «обращений за неделю» вырастет без причины.

Запускать ИЗ ЭТОЙ ПАПКИ (`cd telemetry`): пути относительны рабочего
каталога, и общие файлы берутся через `../` (выгрузка канала в тестах).

Порядок установки:
    1. Создать таблицу: python3 build_telemetry_flows.py --print-schema
       (колонки завести руками в UI n8n — тип менять потом нельзя)
    2. python3 build_telemetry_flows.py
    3. Импортировать Telemetry Ingest.json, скопировать id
    4. INGEST_WORKFLOW_ID=<id> python3 build_telemetry_flows.py
    5. Импортировать Collector, Backfill, Tracker и Report
    6. Импортировать Feedback Webhook И ВКЛЮЧИТЬ ЕГО. После импорта воркфлоу
       выключен, а выключенный вебхук отдаёт 404 на production-адресе —
       кнопки под ответом бота при этом видны и молча не работают.
       Проверка: curl -sS https://n8n.t-tech.team/webhook/bot-feedback-ping

Проверяется: node test_telemetry.mjs
"""

import ast
import copy
import json
import os
import pathlib
import re
import sys

DST_INGEST = "Telemetry Ingest.json"
DST_COLLECTOR = "Telemetry Collector.json"
DST_BACKFILL = "Telemetry Backfill.json"
DST_TRACKER = "Telemetry Collector Tracker.json"
DST_FEEDBACK = "Feedback Webhook.json"
DST_REPORT = "Telemetry Report.json"
DST_FLUSH = "Telemetry Flush.json"

# id воркфлоу Ingest в n8n. Подтверждён импортом 2026-08-10:
# https://n8n.t-tech.team/workflow/28ExyYBVz53J1bMu
#
# Значение по умолчанию — реальный id, а не плейсхолдер: иначе прогон сборщика
# без переменной окружения молча вернул бы флоу к «workflow not found».
# Переопределяется через INGEST_WORKFLOW_ID, если воркфлоу пересоздадут.
INGEST_ID = os.environ.get("INGEST_WORKFLOW_ID", "28ExyYBVz53J1bMu")

# Вебхук кнопок обратной связи. Значение по умолчанию — РЕАЛЬНЫЙ адрес,
# а не плейсхолдер, по той же причине, что и у id ядра и Ingest: прогон
# сборщика без переменной окружения молча вернул бы кнопки в никуда.
#
# Подтверждён импортом 2026-08-13: воркфлоу «Support Bot · Feedback Webhook»
# (n8n.t-tech.team/workflow/Fd9L9vxNduBHP7fP). Путь `bot-feedback` задан
# в самой ноде вебхука, поэтому адрес собирается из хоста n8n однозначно —
# копировать его из UI не требуется, но проверить в ноде стоит: при своём
# N8N_WEBHOOK_URL база может отличаться от адреса интерфейса.
FEEDBACK_WEBHOOK_URL = os.environ.get("FEEDBACK_WEBHOOK_URL", "https://n8n.t-tech.team/webhook/bot-feedback")

# Канал обращений.
CHANNEL_LISTEN = "hr-report-ask"

# ID канала ~hr-report-ask, подтверждён пользователем 2026-08-10.
#
# Нужен именно ID, а не имя, потому что сравнение делает Code-нода `Guard
# channel`: в событии Mattermost есть только `channel_id`, имени там нет.
# Резолвить имя через GET /channels/{id} значило бы лишний запрос к API
# на КАЖДОЕ событие канала.
#
# А сам Guard нужен потому, что `postedFilters` в mattermostTrigger относится
# ТОЛЬКО к событию posted: на reaction_added он не действует, и реакции
# приходят из всех каналов, где состоит бот, включая канал черновиков и личку.
# (Триггер при этом задаёт канал по ИМЕНИ, как в адаптерах бота — там нода
# резолвит его сама.)
CHANNEL_ID = os.environ.get("CHANNEL_ID", "piyu3cs9xpdwie7nwxje5cwm8r")

# Credential бота Bully — тот же, что в адаптерах бота. Бот уже состоит
# в канале, отдельный доступ не нужен.
MM_CRED = {"mattermostApi": {"id": "7SgPbuQnw6w2wzMl", "name": "Time Bully"}}

# Таблица лога в n8n Data Tables.
TABLE = "support_event"

# ---------------------------------------------------------------- DLH Trino
#
# Credential и тип ноды подтверждены живым экспортом ноды `DWH (DLH - Trino)`
# из воркфлоу `DLH Examples` (id GMKFVejvauDT3k9h): тип `CUSTOM.trino`,
# credential `trinoApi`. Имена ПОЛЕЙ внутри `parameters` НЕ подтверждены —
# см. предупреждение в шапке модуля и в build_flush().
DLH_TRINO_CRED = {"trinoApi": {"id": "82c1YyhkiBGT25Ag",
                                "name": "DWH (Trino DLH) account 128"}}

# Таблица создана руками (Iceberg, каталог dl, партиционирование
# day(event_ts)). DDL всё равно живёт здесь — `--print-ddl`, генерится из
# SCHEMA: состав колонок в MERGE обязан совпадать с таблицей, а разъезжаются
# они молча. Сборщик её НЕ создаёт (незачем, статических id там нет), но
# единственное описание её формы должно быть одно, рядом со схемой лога.
DLH_TABLE = "dl.usr_cross_data.support_telemetry"

# Режим записи. `merge` — основной путь: прогон становится идемпотентным
# по `event_id`, и это не украшение.
#
# `Ingest` пишет в Data Tables upsert'ом и ВСЕГДА ставит `ingested_at:
# Date.now()`. Значит повторный backfill или крон-сверка обновляют
# существующую строку, у неё появляется новый `ingested_at`, она снова
# проходит фильтр watermark — и при обычном INSERT уезжает в Iceberg ВТОРОЙ
# строкой. В Data Tables запись была идемпотентной, в DLH перестала бы быть:
# «обращений за неделю» выросло бы без причины, и увидеть это можно только
# сравнив две витрины.
#
# `insert` оставлен запасным путём: если у аккаунта нет прав на MERGE/DELETE
# в схеме, флоу собирается через INSERT, а дубли снимает пересчёт витрины
# (ROW_NUMBER по event_id, последний ingested_at). Тогда это правило
# ОБЯЗАТЕЛЬНО в SQL витрины — без него счётчики завышены.
DLH_WRITE_MODE = os.environ.get("DLH_WRITE_MODE", "merge")

# Тип колонок времени в уже созданной таблице. Таблица заведена руками,
# и сборщик её фактических типов не знает: `timestamp(6)` — то, что
# предполагается, `bigint` — вариант «храним мс как есть».
#
# Ошибка здесь громкая (Trino не приведёт timestamp к bigint), поэтому
# проверять её заранее незачем — но менять надо в ОДНОМ месте, а не
# в тексте двух запросов.
DLH_TS_TYPE = os.environ.get("DLH_TS_TYPE", "timestamp(6)")

# Колонки времени: в Data Tables это мс-эпоха (`Date.now()`), в Trino —
# timestamp. Список явный, а не «всё, что number в SCHEMA»: новая числовая
# колонка (счётчик, длина) не должна начать конвертироваться во время.
DLH_TIME_COLS = ("event_ts", "ingested_at")

# Границы одного запроса. Батч режется на чанки, потому что `returnAll` плюс
# один запрос со всеми строками упирается в `query.max-length` Trino
# (по умолчанию 1 000 000 символов): засев истории — это ~1000 событий
# с payload по 0.5–2 КБ, то есть SQL в единицы МБ. Отказ при этом накрывает
# ВЕСЬ батч, а не хвост: после backfill первый же прогон не залил бы ничего.
#
# 200 строк — запас к лимиту в разы даже на самых длинных payload; 500 000
# символов — вторая граница, на случай аномально длинного текста.
FLUSH_MAX_ROWS = 200
FLUSH_MAX_CHARS = 500_000

# Схема таблицы. Типы Data Tables: string | number | boolean | date.
# `payload` — string с JSON внутри: у Data Tables нет jsonb, а дробить payload
# на колонки нельзя — у разных типов событий разные поля, и таблица поехала бы
# на каждом новом типе.
SCHEMA = [
    ("event_id", "string", "ключ идемпотентности: upsert по нему"),
    ("thread_id", "string", "root_id треда — ключ склейки всего обращения"),
    ("event_type", "string", "request_created | taken | closed | …"),
    ("event_ts", "number", "время события в мс (из Time), НЕ время записи"),
    ("ingested_at", "number", "время записи в мс — расхождение с event_ts"
                              " показывает лаг и работу backfill"),
    ("actor", "string", "user_id, кто совершил действие"),
    ("source", "string", "channel | reaction | core | dm | webhook | tracker"),
    ("kind", "string", "тип обращения из префикса темы (kind_source=intake)"),
    ("domains", "string", "домены роутера бота через запятую — кластеризация"),
    ("payload", "string", "JSON: всё остальное, специфичное для типа события"),
]

# ---------------------------------------------------------------- реакции
#
# Словарь дежурного. Значения — не «статус», а событие: статус обращения
# считается пересчётом всего лога, поэтому снятие реакции разбирается само.
#
# Правила снятия у эмодзи РАЗНЫЕ, и это не деталь реализации:
#   :loading:         taken_at = ПЕРВОЕ добавление за историю треда, снятие
#                     его не сбрасывает. Дежурный снимает :loading:, когда
#                     ставит закрывающую реакцию, — при наивном пересчёте
#                     reaction time обнулился бы у всех закрытых обращений.
#   закрывающие       снятие ПЕРЕОТКРЫВАЕТ: здесь это исправление ошибки.
#
# Правила живут в пересчёте витрины, здесь только классификация.
EMOJI = {
    "loading": {"kind": "taken", "resets_on_remove": False},
    "done_checkmark": {"kind": "closed", "resolved": True, "resets_on_remove": True},
    "im_red_cross": {"kind": "closed", "resolved": False, "resets_on_remove": True},
}

# ----------------------------------------------------------------- темы
#
# Темы формы intake-воркфлоу: обращение приходит в канал как
# `<Тема>` первой строкой. Тема проставлена ЧЕЛОВЕКОМ в форме — это
# самый надёжный источник разреза из трёх возможных (форма / реакция / LLM),
# и он уже есть, поэтому ни отдельной реакции-метки, ни классификатора
# не нужно.
#
# Список будет сокращаться. Порядок проверки — от длинных к коротким,
# иначе «Вопрос команде DWH HR» съест свою же уточнённую версию с ` | `.
# ФОРМА СОКРАЩЕНА 2026-08-12: тем Cross Data осталось четыре вместо восьми,
# а чужая команда переименована — «DWH HR» стала «HC Data (ex. DWH HR)».
#
# Снятые темы НЕ удалены, а переехали в ARCHIVE_TOPICS. По ним есть история
# в логе, и повторный прогон backfill должен продолжать их узнавать: удалить
# их значит получить `unknown` на половине прошлых обращений — и это выглядело
# бы как поломка разбора, а не как правку формы.
#
# Переименование команды тему НЕ раздваивает: у старого и нового заголовка
# один и тот же `kind`. Команда та же, изменилась подпись в форме, а kind —
# аналитический ключ, по которому группируется витрина, а не отображаемое имя.
CURRENT_TOPICS = [
    # Cross Data — наши обращения.
    ("Cross Data | Выгрузка данных", "export", True),
    ("Cross Data | Вопрос по отчетам", "report_question", True),
    ("Cross Data | Нет доступа к отчету", "report_access", True),
    # В форме заголовок длиннее: «Другое ( Если не нашлось подходящей
    # категории )». Сверяем по короткому префиксу: пояснение в скобках
    # переписывают, не меняя смысла темы, и точное совпадение сломалось бы
    # молча — на «Другое» приходит всё, что не разложилось по трём остальным.
    ("Cross Data | Другое", "other", True),
    # HC Data (ex. DWH HR) — чужая команда. Считаем отдельно и в свои метрики
    # времени решения не берём: обращение адресовано не нам.
    ("Вопрос команде HC Data (ex. DWH HR) |", "dwh_hr_replica", False),
    ("Вопрос команде HC Data (ex. DWH HR)", "dwh_hr", False),
]

# Снято с формы. Живёт здесь ради истории: backfill и повторные прогоны
# перечитывают старые посты, и тема у них прежняя.
ARCHIVE_TOPICS = [
    ("Cross Data | Вопрос по пользовательским данным в хранилище",
     "user_data_question", True),
    ("Cross Data | Мне только спросить", "just_ask", True),
    ("Cross Data | Нет доступа к пользовательским данным в хранилище",
     "user_data_access", True),
    ("Cross Data | Запрос на подключение к Warden (RLS для HR данных)",
     "warden_access", True),
    ("Cross Data | Получить сведения о трудоустройстве ФЛ",
     "employment_info", True),
    ("Вопрос команде DWH HR |", "dwh_hr_replica", False),
    ("Вопрос команде DWH HR", "dwh_hr", False),
]

TOPICS = CURRENT_TOPICS + ARCHIVE_TOPICS

# user_id ботов, чьи реакции и сообщения не считаются действием человека.
# Пусто — значит реакции бота попадут в лог как действие дежурного и
# испортят reaction time. Сборщик предупреждает на каждом прогоне.
BOT_USER_IDS = []


# ============================================================== Normalize
#
# Единственное место разбора событий Time. Ошибки здесь тихие по своей
# природе: неверный thread_id не падает, а размазывает одно обращение на
# несколько записей, и в витрине это выглядит как «обращений стало больше».
NORMALIZE_JS = r"""
// Вход: { event, data, post } — сырое событие mattermostTrigger плюс, для
// реакций, догоняющий GET /posts/{id} (в событии реакции треда нет).
// Выход: канонические события лога, 0..2 штуки на вход.

const TOPICS = __TOPICS__;
const EMOJI = __EMOJI__;
const BOT_USER_IDS = __BOT_USER_IDS__;

const src = $json || {};

// Тело реакции в WebSocket Mattermost приходит JSON-СТРОКОЙ, а не объектом.
// Без разбора emoji_name был бы undefined, и все реакции молча стали бы
// неизвестными — то есть дежурный размечает, а метрики пустые.
const asObj = (v) => {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } }
  return v;
};

const data = asObj(src.data);
const post = asObj(src.post ?? data.post);
const reaction0 = asObj(data.reaction ?? src.reaction);

// ИМЯ СОБЫТИЯ ВЫВОДИТСЯ ПО ФОРМЕ, а не берётся из поля `event`.
//
// Первый живой прогон 2026-08-11 дал сплошные unsupported_event с пустым
// `event`: поле было взято из документации Mattermost WebSocket, а нода
// mattermostTrigger его не отдаёт. Показательно, что рядом лежал рабочий
// пример — guard бота читает только `$json.post.*` и на `event` не смотрит
// вовсе. Схему события надо было брать оттуда, а не из документации.
//
// Имя, если оно всё-таки есть, имеет приоритет: только оно различает
// добавление и снятие реакции.
function resolveEvent() {
  const named = String(
    src.event ?? data.event ?? src.type ?? data.type ?? ''
  ).trim();
  // Guard коллектора уже вывел тип по форме и честно помечает это флагом.
  // Без учёта флага домысленное имя выглядело бы здесь как пришедшее
  // от Mattermost, и признак приблизительности терялся бы на границе узлов.
  if (named) return { event: named, inferred: src.event_inferred === true };
  // Реакция узнаётся по emoji_name, сообщение — по id поста. Порядок важен:
  // у события реакции догоняющий пост тоже присутствует.
  if (reaction0.emoji_name) return { event: 'reaction_added', inferred: true };
  if (post.id) return { event: 'posted', inferred: true };
  return { event: '', inferred: false };
}
const resolved = resolveEvent();
const event = resolved.event;
// Снятие реакции без имени события от добавления НЕ отличить: объект
// reaction у них одинаковый. Пока имя не появилось, снятия будут приходить
// как добавления — поэтому факт домысливания пишется в payload, а не
// замалчивается: по нему видно, каким метрикам доверять.
const eventInferred = resolved.inferred;

// Тема обращения из первой строки. Первое совпадение по префиксу: список
// отсортирован от длинных к коротким, иначе короткая тема съест свою же
// уточнённую версию.
function classify(message) {
  // Markdown с краёв снимается ДО сравнения с темами. Intake-воркфлоу
  // выделяет тему жирным, и тогда первая строка начинается со звёздочек:
  // `**Cross Data | Выгрузка данных от пользователя @A**`. Без снятия
  // ни одна тема не совпадёт — kind уедет `unknown`, а `ours` станет false,
  // то есть наше обращение посчитается обращением к чужой команде.
  // Guard бота снимает ту же обвязку и по той же причине; правило одно,
  // но живёт в двух сборщиках — здесь оно про лог, там про то, отвечать или нет.
  const head = String(message || '').split('\n')[0]
    .replace(/^[\s>*_#`~]+/, '').replace(/[\s*_`~]+$/, '').trim();
  for (const t of TOPICS) {
    if (head === t.title || head.startsWith(t.title)) {
      return { kind: t.kind, ours: t.ours, topic: t.title };
    }
  }
  // Тему не узнали — это не ошибка и не повод промолчать: форму расширят
  // новой темой, и телеметрия должна это показать, а не проглотить.
  const guess = head.includes('|') ? head.split('|').slice(0, 2).join('|').trim() : head;
  return { kind: 'unknown', ours: head.startsWith('Cross Data'), topic: guess.slice(0, 120) };
}

// Ключ задачи трекера из текста: BIGLETTERS-NUMBER. Ссылку тоже забираем —
// по ней потом открывать задачу руками.
// Ключ задачи ищется в ССЫЛКЕ, а не по всему тексту. Сообщение дежурного
// или заказчика может содержать что угодно похожее на ключ — «HR-2», «Q1-25»,
// имя таблицы вида `MDM-1` — и связать тред с несуществующей задачей значит
// потерять cycle time там, где он есть.
//
// Формы ссылок, которые считаем: T-Tracker (`tracker.t-tech.team/tasks/KEY`
// и `/task/KEY`) и jira3 (`/browse/KEY`) — вторая нужна для истории, задачи
// за июль-август лежат в jira3.
function taskFromText(message) {
  const text = String(message || '');
  const m = text.match(
    /https?:\/\/[^\s)\]]*?\/(?:browse|tasks?)\/([A-Z][A-Z0-9]{1,15}-\d+)/);
  if (m) {
    return { key: m[1], url: m[0], tracker: /tracker\./.test(m[0]) ? 'tracker' : 'jira' };
  }
  // Ссылки нет — берём голый ключ, но ТОЛЬКО из сообщения бота: intake-бот
  // пишет ключ по шаблону, человек — как получится. У вызывающего это
  // проверяется через from_bot.
  const bare = (text.match(/\b([A-Z][A-Z0-9]{1,15}-\d+)\b/) || [])[1] || '';
  return bare ? { key: bare, url: '', tracker: 'unknown' } : null;
}

const out = [];
const push = (o) => out.push({ json: o });

if (event === 'posted') {
  const threadId = post.root_id || post.id || '';
  const isRoot = !post.root_id;
  const actor = post.user_id || '';
  const fromBot = BOT_USER_IDS.includes(actor) || String(post.props?.from_bot ?? '') === 'true';

  if (isRoot) {
    // Корневое сообщение = обращение. Даже чужое (DWH HR) и даже с
    // неузнанной темой: считать их отдельно можно, а вот задним числом
    // добрать пропущенное — нельзя.
    const c = classify(post.message);
    push({
      event_id: 'posted:' + post.id,
      thread_id: threadId,
      event_type: 'request_created',
      event_ts: post.create_at || null,
      actor,
      source: 'channel',
      payload: {
        kind: c.kind,
        kind_source: 'intake',
        topic: c.topic,
        ours: c.ours,
        from_bot: fromBot,
        channel_id: post.channel_id || '',
        text_len: String(post.message || '').length,
        permalink: post.id ? 'https://time.tbank.ru/tinkoff/pl/' + post.id : '',
      },
    });
  } else {
    // Ответ в треде. Тему здесь не разбираем: она есть в request_created,
    // а треды без него отбрасывает пересчёт витрины. Так реплики из чужих
    // тредов самоочищаются без лишнего запроса к API на каждый ответ.
    push({
      event_id: 'posted:' + post.id,
      thread_id: threadId,
      event_type: fromBot ? 'bot_replied' : 'human_replied',
      event_ts: post.create_at || null,
      actor,
      source: 'channel',
      payload: {
        from_bot: fromBot,
        text_len: String(post.message || '').length,
        channel_id: post.channel_id || '',
      },
    });

    // Связка треда с трекером. Дежурный нажимает «завести задачу», бот
    // отвечает в тред сообщением со ссылкой — связь ставит МАШИНА, а не
    // человек, поэтому регулярка по забытому ключу не нужна.
    const task = taskFromText(post.message);
    // Голый ключ без ссылки принимаем только от бота: он пишет по шаблону,
    // а в сообщении человека «HR-2» или имя таблицы `MDM-1` дали бы связь
    // с несуществующей задачей — и cycle time потерялся бы там, где он есть.
    if (task && (task.url || fromBot)) {
      push({
        event_id: 'task:' + post.id + ':' + task.key,
        thread_id: threadId,
        event_type: 'task_linked',
        event_ts: post.create_at || null,
        actor,
        source: 'channel',
        payload: {
          task_key: task.key,
          task_url: task.url,
          // По tracker/jira видно, куда идти за статусом: коллектор трекера
          // умеет только T-Tracker, задачи в jira3 остаются историей.
          tracker: task.tracker,
          from_bot: fromBot,
        },
      });
    }
  }
} else if (event === 'reaction_added' || event === 'reaction_removed') {
  const reaction = asObj(data.reaction ?? src.reaction ?? data);
  const emoji = reaction.emoji_name || '';
  const actor = reaction.user_id || '';
  const removed = event === 'reaction_removed';

  // Реакция не знает про тред: в событии есть post_id и нет root_id.
  // Ставят её на любое сообщение внутри треда, поэтому thread_id берётся
  // с догоняющего GET /posts/{id}. Без этого одно обращение размажется
  // на несколько.
  const postId = reaction.post_id || post.id || '';
  const threadId = post.root_id || post.id || postId;

  const known = EMOJI[emoji] || null;
  const fromBot = BOT_USER_IDS.includes(actor);

  // Реакции бота — не действие дежурного. Считать их за «взято в работу»
  // значит получить reaction time в секунды и не заметить проблему.
  if (!fromBot) {
    push({
      event_id: 'react:' + (removed ? 'del' : 'add') + ':' + postId + ':' + actor +
                ':' + emoji + ':' + (reaction.create_at || reaction.remove_at || 0),
      thread_id: threadId,
      event_type: known
        ? (known.kind + (removed ? '_removed' : ''))
        : (removed ? 'reaction_removed' : 'reaction_added'),
      event_ts: reaction.create_at || reaction.remove_at || null,
      actor,
      source: 'reaction',
      payload: {
        emoji,
        known: Boolean(known),
        removed,
        resolved: known && 'resolved' in known ? known.resolved : null,
        resets_on_remove: known ? known.resets_on_remove : null,
        post_id: postId,
        on_root: !post.root_id,
        // true — тип события домыслен по форме, и СНЯТИЕ реакции пришло бы
        // сюда как добавление. Пересчёт витрины должен это видеть, иначе
        // снятое «взято в работу» останется в метриках навсегда.
        event_inferred: eventInferred,
      },
    });
  }
} else if (event === 'bot_answered' || event === 'bot_feedback' ||
           event === 'feedback_text' || event === 'feedback_detail_opened' ||
           event === 'task_status_changed') {
  // События не из канала: ядро бота, вебхук кнопок, коллектор трекера.
  //
  // Список закрытый, и это не формальность: имя события, которого здесь нет,
  // уедет в `unsupported_event` при зелёном флоу у вызывающего. Добавляя
  // событие в вебхуке или в ядре, добавлять его И сюда.
  // Ключ идемпотентности задаёт вызывающий — он знает естественный ключ
  // своего события лучше, чем нормализатор.
  push({
    event_id: src.event_id || (event + ':' + (src.thread_id || '') + ':' + (src.event_ts || '')),
    thread_id: src.thread_id || '',
    event_type: event,
    event_ts: src.event_ts || null,
    actor: src.actor || '',
    source: src.source || event,
    payload: src.payload || {},
  });
} else {
  // Сюда попадает только то, у чего не нашлось ни имени события, ни узнаваемой
  // формы. Раньше запись говорила «проверить настройки триггера» и не давала
  // ничего для проверки — при первом прогоне это дало таблицу пустых строк,
  // по которым нельзя было понять форму события.
  //
  // Поэтому теперь пишутся КЛЮЧИ payload: одной такой строки достаточно,
  // чтобы увидеть, как устроено событие, и не гадать по документации.
  const keys = (o) => { try { return Object.keys(o || {}).join(','); } catch (e) { return ''; } };
  push({
    event_id: 'unknown:' + (post.id || keys(src) || 'empty') + ':' + event,
    thread_id: post.root_id || post.id || '',
    event_type: 'unsupported_event',
    event_ts: post.create_at || null,
    actor: '',
    source: 'normalize',
    payload: {
      event,
      note: 'не удалось определить тип события ни по имени, ни по форме',
      // Диагностика формы события: по ней правится resolveEvent().
      top_keys: keys(src),
      data_keys: keys(data),
      post_keys: keys(post),
      reaction_keys: keys(reaction0),
    },
  });
}

// Пустой выход означал бы «событий не было». Здесь это всегда следствие
// фильтра (реакция бота), и молчать о нём нельзя.
if (!out.length) {
  push({
    event_id: 'skipped:' + (post.id || '') + ':' + event,
    thread_id: post.root_id || post.id || '',
    event_type: 'skipped',
    event_ts: null,
    actor: '',
    source: 'normalize',
    payload: { event, reason: 'отфильтровано как действие бота' },
  });
}

// Приведение к КОЛОНКАМ таблицы. Data Tables принимает string/number/boolean/
// date, вложенных объектов не бывает — payload уезжает строкой JSON.
//
// Дробить payload на колонки нельзя: у разных типов событий разные поля,
// и таблица ехала бы на каждом новом типе. Наверх вынесено только то, по чему
// группируют витрину: kind и domains.
return out.map((e) => {
  const p = e.json.payload || {};
  return { json: {
    event_id: e.json.event_id,
    thread_id: e.json.thread_id || '',
    event_type: e.json.event_type,
    event_ts: Number(e.json.event_ts) || 0,
    ingested_at: Date.now(),
    actor: e.json.actor || '',
    source: e.json.source || '',
    // kind живёт только на request_created: у реакции темы нет, а выдумывать
    // её из треда значило бы запрос к API на каждое событие. Пересчёт витрины
    // берёт kind с корневого события треда.
    kind: p.kind || '',
    // Домены роутера бота приходят с bot_answered — это готовая
    // кластеризация, отдельная LLM не нужна.
    domains: Array.isArray(p.domains) ? p.domains.join(',') : (p.domains || ''),
    payload: JSON.stringify(p),
  } };
});
"""


def js_const(value):
    return json.dumps(value, ensure_ascii=False)


def topics_js():
    """Список тем для JS: от длинных заголовков к коротким.

    Порядок гарантируем сортировкой, а не дисциплиной при правке списка:
    «Вопрос команде HC Data (ex. DWH HR)» — префикс своей же уточнённой
    версии с ` | `, и наивный обход отдал бы обеим один kind.

    Один список на двоих: нормализатор разбирает тему из первой строки
    обращения, вебхук кнопок — из контекста кнопки. Разъехавшись, они дали бы
    в колонке `kind` два разных словаря на одну и ту же тему.
    """
    topics = [{"title": t, "kind": k, "ours": o} for t, k, o in TOPICS]
    topics.sort(key=lambda x: len(x["title"]), reverse=True)
    return topics


def normalize_js():
    return (
        NORMALIZE_JS
        .replace("__TOPICS__", js_const(topics_js()))
        .replace("__EMOJI__", js_const(EMOJI))
        .replace("__BOT_USER_IDS__", js_const(BOT_USER_IDS))
    )


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


def call_ingest(pos, name="To Ingest"):
    """Вызов Ingest подворкфлоу. Как и dd_lookup, по статическому id.

    `workflowInputs` здесь НЕ задаётся намеренно. Триггер Ingest объявлен
    `passthrough`, то есть принимает элемент целиком: события Time — вложенные
    объекты (`data.reaction`, `post.props`), а типизированные поля
    `workflowInputs` рассчитаны на скаляры, как `urn`/`search` в DD Lookup.

    Пустой `{"mappingMode": "defineBelow", "value": {}}` был бы хуже
    отсутствия: он объявляет «маппинг задан, полей ноль» — в Ingest ушёл бы
    пустой элемент, нормализатор получил бы `event: ''` и записал
    `unsupported_event`. Флоу при этом зелёный, а в таблице мусор.
    """
    return node(name, "n8n-nodes-base.executeWorkflow", 1.2, pos, {
        "workflowId": {
            "__rl": True,
            "value": INGEST_ID,
            "mode": "id",
            "cachedResultName": "Telemetry · Ingest",
        },
        "options": {"waitForSubWorkflow": True},
    })


# ==================================================== 1. Telemetry Ingest
def build_ingest():
    # Upsert, а не insert: крон-сверка и повторный backfill перечитают те же
    # посты, и без совпадения по event_id в витрине появятся дубли обращений.
    write = node("Write event", "n8n-nodes-base.dataTable", 1, [460, 300], {
        "operation": "upsert",
        "dataTableId": {"__rl": True, "value": TABLE, "mode": "name"},
        "filters": {
            "conditions": [{
                "keyName": "event_id",
                "condition": "eq",
                "keyValue": "={{ $json.event_id }}",
            }],
        },
        "columns": {
            "mappingMode": "autoMapInputData",
            "matchingColumns": ["event_id"],
            "value": {},
        },
        "options": {},
    })
    nodes = [
        node("When called", "n8n-nodes-base.executeWorkflowTrigger", 1.1, [-40, 300], {
            "inputSource": "passthrough",
        }),
        node("Normalize", "n8n-nodes-base.code", 2, [200, 300], {
            "jsCode": normalize_js(),
        }),
        write,
    ]
    return wf("Telemetry · Ingest", nodes,
              chain("When called", "Normalize", "Write event"))


# ================================================= 2. Telemetry Collector
#
# Один флоу на три события: у них общий нормализатор, и разводить их по разным
# воркфлоу значило бы копию Guard в каждом — она разъезжается молча.
GUARD_JS = r"""
// Отсев чужих каналов и приведение события к общей форме.
//
// `postedFilters` в mattermostTrigger относится ТОЛЬКО к событию posted:
// на reaction_added он не действует, и реакции приходят из ВСЕХ каналов, где
// состоит бот, включая канал черновиков. Поэтому фильтр по channel_id здесь,
// а не в настройках триггера.
const CHANNEL_ID = __CHANNEL_ID__;

const src = $json || {};
const asObj = (v) => {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } }
  return v;
};

// Форма события зависит от типа: у posted пост лежит в data.post (строкой),
// у реакции — только data.reaction с post_id, самого поста нет.
const data = asObj(src.data ?? src);
const post = asObj(src.post ?? data.post);
const reaction = asObj(data.reaction ?? src.reaction);

// Тип события выводится ПО ФОРМЕ, а не берётся из поля `event`: живой прогон
// 2026-08-11 показал, что mattermostTrigger его не отдаёт (поле было взято
// из документации Mattermost WebSocket). Имя, если оно есть, приоритетнее —
// только оно различает добавление и снятие реакции.
const named = String(src.event ?? data.event ?? src.type ?? data.type ?? '').trim();
const event = named ||
  (reaction.emoji_name ? 'reaction_added' : (post.id ? 'posted' : ''));

const channelId = post.channel_id || reaction.channel_id ||
                  src.broadcast?.channel_id || data.channel_id || '';

// Пустой CHANNEL_ID — не «пропускать всё молча»: в лог поедут реакции из
// канала черновиков и разборы из лички. Помечаем, чтобы это было видно
// в самих данных, а не только в предупреждении сборщика.
const filtered = CHANNEL_ID ? channelId === CHANNEL_ID : true;

return [{ json: {
  event,
  data,
  post,
  reaction,
  channel_id: channelId,
  pass: filtered,
  channel_unfiltered: !CHANNEL_ID,
  // Признак домысливания едет дальше: иначе нормализатор увидит готовое имя
  // события и решит, что оно пришло от Mattermost. А от домысленного имени
  // зависит доверие к снятиям реакций — их от добавлений не отличить.
  event_inferred: !named,
  // Реакция не знает про тред: в событии есть post_id и нет root_id.
  // Догоняющий GET /posts/{id} нужен ТОЛЬКО для реакций — на posted это был бы
  // лишний запрос к API на каждое сообщение канала.
  needs_post: event.startsWith('reaction') && !post.id,
  post_id: reaction.post_id || post.id || '',
} }];
"""


def build_collector():
    guard_js = GUARD_JS.replace("__CHANNEL_ID__", js_const(CHANNEL_ID))

    trigger = node("Time Trigger", "n8n-nodes-base.mattermostTrigger", 2, [-260, 300], {
        # Три события. reaction_removed обязателен: без него снятая закрывающая
        # реакция оставит обращение закрытым навсегда, а исправление ошибки
        # дежурного не доедет до витрины.
        "events": ["posted", "reaction_added", "reaction_removed"],
        "postedFilters": {
            "channels": [{"nameAuto": {"__rl": True, "mode": "name",
                                       "value": CHANNEL_LISTEN}}],
        },
    }, credentials=copy.deepcopy(MM_CRED))

    normalize_guard = node("Guard channel", "n8n-nodes-base.code", 2, [-20, 300],
                           {"jsCode": guard_js})

    is_ours = node("Our channel", "n8n-nodes-base.if", 2.2, [220, 300], {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": "pass",
                "leftValue": "={{ $json.pass }}",
                "rightValue": True,
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    })

    needs_post = node("Reaction needs post", "n8n-nodes-base.if", 2.2, [460, 240], {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": "needs",
                "leftValue": "={{ $json.needs_post }}",
                "rightValue": True,
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    })

    # Догоняющий пост для реакции. neverError: пост могли удалить, и падать
    # из-за этого нельзя — событие всё равно надо записать, пусть с thread_id
    # равным post_id.
    get_post = node("Get post", "n8n-nodes-base.mattermost", 1, [700, 160], {
        "resource": "message",
        "operation": "get",
        "postId": "={{ $json.post_id }}",
    }, credentials=copy.deepcopy(MM_CRED),
        onError="continueRegularOutput")

    # Свёртка: после Get post в $json лежит ОТВЕТ API, а не событие. Без этого
    # узла нормализатор получил бы пост вместо события и не увидел реакции —
    # тихий отказ, ровно как с Collect articles в ядре бота.
    merge = node("Merge reaction", "n8n-nodes-base.code", 2, [940, 160], {"jsCode": r"""
// Событие берём из Guard, догоняющий пост — из Get post. Порядок важен:
// в $json сейчас ответ API, а не событие.
const ev = $('Guard channel').first().json;
let post = {};
try {
  const got = $('Get post').first().json;
  // Пост могли удалить: тогда в ответе будет ошибка, а не пост. thread_id
  // тогда останется равным post_id — обращение не потеряется, просто
  // не склеится с тредом, и это видно по on_root.
  if (got && got.id) post = got;
} catch (e) { /* ветка не выполнялась */ }

// event_inferred ЕДЕТ ДАЛЬШЕ. Guard его вычислил, Normalize его читает
// (`src.event_inferred`), а этот узел стоит между ними — и, теряя признак,
// делал его ложным ВСЕГДА: реакции идут только этим путём, а больше он
// нигде и не нужен. Тогда снятие реакции, приехавшее как добавление,
// в логе неотличимо от настоящего добавления, и снятое «взято в работу»
// осталось бы в метриках навсегда.
return [{ json: {
  event: ev.event,
  data: ev.data,
  event_inferred: ev.event_inferred === true,
  post: Object.keys(post).length ? post : ev.post,
} }];
"""})

    nodes = [
        trigger, normalize_guard, is_ours, needs_post, get_post, merge,
        call_ingest([1180, 300]),
    ]

    conn = {}
    conn.update(chain("Time Trigger", "Guard channel", "Our channel"))
    # Ложная ветка Our channel никуда не ведёт: чужой канал просто не пишется.
    conn["Our channel"] = {"main": [
        [{"node": "Reaction needs post", "type": "main", "index": 0}],
        [],
    ]}
    # Обе ветки сходятся в Merge reaction. Сходящиеся ветви IF — норма, в
    # отличие от веера НА ВЫХОДЕ: узел за развилкой выполнился бы по разу
    # на каждую дошедшую ветвь.
    conn["Reaction needs post"] = {"main": [
        [{"node": "Get post", "type": "main", "index": 0}],
        [{"node": "Merge reaction", "type": "main", "index": 0}],
    ]}
    conn.update(chain("Get post", "Merge reaction", "To Ingest"))
    return wf("Telemetry · Collector Channel", nodes, conn)


# ================================================== 3. Telemetry Backfill
#
# Засев истории. Выгрузка hr-report-ask-3-4-aug-2026.md для этого НЕ годится:
# это обработанная таблица «вопрос → решение», без таймстемпов, реакций и
# структуры тредов. Метрики времени из неё не собрать, поэтому история тянется
# из API — там реакции дежурного уже проставлены.
BACKFILL_JS = r"""
// Разворачивание ответа GET /channels/{id}/posts в события.
//
// Ответ несёт и посты, и metadata.reactions на каждом — один запрос закрывает
// и сообщения, и разметку. Реакции здесь идут С постом, поэтому догоняющий
// GET /posts не нужен: тред уже известен.
const res = $json || {};
const posts = res.posts ? Object.values(res.posts) : (Array.isArray(res) ? res : []);

const out = [];
for (const post of posts) {
  if (!post || !post.id) continue;
  out.push({ json: { event: 'posted', post } });

  for (const r of post.metadata?.reactions || []) {
    // Снятия реакций в истории не видны: API отдаёт только текущее состояние.
    // Для метрик этого достаточно — важно, что реакция ЕСТЬ и когда поставлена.
    out.push({ json: {
      event: 'reaction_added',
      data: { reaction: r },
      post,
    } });
  }
}

// Пустой выход = «постов за период нет». Отличить это от сбоя запроса нельзя,
// поэтому говорим прямо.
if (!out.length) {
  out.push({ json: { event: 'backfill_empty', post: {},
    data: { note: 'ответ API не содержит постов — проверить channel_id и период' } } });
}

// СТРАНИЦА ЗАКОНЧИЛАСЬ, А ИСТОРИЯ — НЕТ. Запрос один, без пагинации:
// GET /channels/{id}/posts отдаёт per_page постов и ссылки на соседние
// страницы, а мы берём первую. Молча это читается как «в канале было
// 200 постов», то есть засев обрывается на новейших, а метрики за первые
// месяцы просто не появляются — и по виду прогона он успешный.
//
// Признаков исчерпания два, и берём оба: пришло ровно per_page постов
// (ответ упёрся в лимит) либо API назвал следующую страницу. Событие
// пишется в лог, а не только в вывод ноды: прогон ручной и разовый,
// и через месяц вспомнить, докручивали ли страницы, будет неоткуда.
// Лимит подставляется сборщиком из той же константы, что уезжает в ноду
// «Period»: две копии числа разъехались бы молча, и признак исчерпания
// перестал бы срабатывать ровно тогда, когда лимит подняли.
const perPage = __PER_PAGE__;
const gotAll = perPage > 0 && posts.length >= perPage;
const moreLink = Boolean(res.next_post_id || res.has_next);
if (gotAll || moreLink) {
  out.push({ json: { event: 'backfill_truncated', post: {}, data: {
    note: `получено ${posts.length} постов при лимите ${perPage} — это ПЕРВАЯ `
      + 'страница, история засеяна НЕ целиком. Продолжить: выставить в ноде '
      + '«Period» поле before на id самого старого поста этой страницы '
      + 'и запустить ещё раз, пока это событие не перестанет появляться.',
    oldest_post_id: res.order && res.order.length
      ? res.order[res.order.length - 1]
      : (posts.length ? posts[posts.length - 1].id : ''),
    next_post_id: res.next_post_id || '',
  } } });
}
return out;
"""


# Service Account для T-Tracker — ЧИТАЕТСЯ ИЗ СБОРЩИКА БОТА, а не дублируется.
#
# 2026-08-27 один устаревший id в забытом файле разъезжался сразу по трём
# воркфлоу и уронил бы разом каталог и чтение статей из GitLab по 401.
# Бот тогда перевели на «…Service Account Support», а телеметрия осталась
# на «…account 2» — то есть ровно та же копия, только в другом репозитории
# каталога. Копия разъезжается молча, поэтому здесь её больше нет.
def _dp_cred():
    src = pathlib.Path(__file__).resolve().parent.parent / "bot" / "build_dd_flow.py"
    text = src.read_text(encoding="utf-8")
    m = re.search(r'^DP_CRED = (\{.*?\}\})\n\n', text, re.S | re.M)
    if not m:
        raise SystemExit(
            f"не нашёл DP_CRED в {src}: credential нельзя вписать сюда копией — "
            "разъедется молча, как это уже было 2026-08-27")
    return ast.literal_eval(m.group(1))


DP_CRED = _dp_cred()


# Постов на страницу в GET /channels/{id}/posts. Одно число на два места:
# и в ноду «Period», и в признак исчерпания страницы внутри «Explode posts».
PER_PAGE = 200


def build_backfill():
    nodes = [
        node("Run manually", "n8n-nodes-base.manualTrigger", 1, [-260, 300], {}),
        node("Period", "n8n-nodes-base.set", 3.4, [-20, 300], {
            "assignments": {"assignments": [
                {"id": "ch", "name": "channel_id", "type": "string",
                 "value": CHANNEL_ID or "ЗАПОЛНИТЬ"},
                # since в мс. 0 = с начала канала: для засева это и нужно,
                # а ограничить период можно, вписав таймстемп.
                {"id": "since", "name": "since", "type": "number", "value": 0},
                {"id": "per", "name": "per_page", "type": "number", "value": PER_PAGE},
                # Пагинация вручную: запрос один, и когда придёт ровно
                # per_page постов, «Explode posts» пишет в лог событие
                # backfill_truncated с id самого старого поста страницы.
                # Вписать его сюда и запустить снова — до тех пор, пока
                # событие не перестанет появляться. Автоцикл в HTTP-ноде
                # тут был бы рукописным, а разовый ручной прогон и так
                # смотрят глазами.
                {"id": "before", "name": "before", "type": "string", "value": ""},
            ]},
            "options": {},
        }),
        # Токен Time берётся из того же credential, что у нод Mattermost:
        # предопределённый тип mattermostApi подставляет и базовый URL,
        # и заголовок авторизации. Без него запрос уходит анонимным и
        # возвращает 401 — а событий в ответе не будет, что нормализатор
        # прочитает как «постов за период нет».
        node("Get posts", "n8n-nodes-base.httpRequest", 4.2, [220, 300], {
            "url": "=https://time.tbank.ru/api/v4/channels/{{ $json.channel_id }}/posts",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "mattermostApi",
            "sendQuery": True,
            "queryParameters": {"parameters": [
                {"name": "since", "value": "={{ $json.since }}"},
                {"name": "per_page", "value": "={{ $json.per_page }}"},
                {"name": "before", "value": "={{ $json.before }}"},
            ]},
            # followRedirects: false — то же решение, что на нодах DD:
            # редирект на страницу логина иначе приходит как 200 с HTML,
            # и «постов нет» становится неотличимо от «нет доступа».
            "options": {"redirect": {"redirect": {"followRedirects": False}}},
        }, credentials=copy.deepcopy(MM_CRED)),
        node("Explode posts", "n8n-nodes-base.code", 2, [460, 300],
             {"jsCode": BACKFILL_JS.replace("__PER_PAGE__", str(PER_PAGE))}),
        call_ingest([700, 300]),
    ]
    return wf("Telemetry · Backfill", nodes,
              chain("Run manually", "Period", "Get posts", "Explode posts", "To Ingest"))


# =========================================== 4. Telemetry Collector Tracker
#
# Статусы задач на выгрузку. Спейс НЕ нужен: ключи задач приходят из треда
# (дежурный нажимает «завести задачу», бот отвечает ссылкой), и коллектор
# опрашивает ровно их.
#
# ПОЧЕМУ ПО СНИМКАМ, А НЕ ПО ИСТОРИИ ПЕРЕХОДОВ. В T-Tracker истории нет:
# `/tasks/{key}/history` и `/changelog` отвечают 404 (проверено 2026-08-10),
# Jira-совместимый слой её тоже не отдаёт. Доступны только `create_at`,
# `finish_at` и `status_update_at` — время ПОСЛЕДНЕГО перехода, одно значение.
#
# Следствия, которые важно не потерять:
#   — `create_at` и `finish_at` точны всегда, поэтому время от заведения
#     задачи до готовности выгрузки считается надёжно, независимо от крона;
#   — промежуточные статусы видны только те, что коллектор ЗАСТАЛ. Переход,
#     случившийся и смененный между опросами, теряется. При интервале 15 мин
#     и задачах на дни это шум, но знать об этом надо;
#   — `event_ts` берётся из `status_update_at`, а НЕ из момента опроса: иначе
#     все времена поехали бы на величину интервала.
#
# Точечный GET /tasks/key/{key} даёт 403 на чужой спейс — поэтому опрос идёт
# поиском TQL `taskKey IN (...)`: он возвращает только доступное и не падает
# целиком из-за одной недоступной задачи.
TRACKER_KEYS_JS = r"""
// Собирает список задач для опроса из лога: task_linked минус те, что уже
// закрыты. Закрытые не опрашиваем — их статус больше не изменится, а список
// иначе растёт бесконечно и запрос упирается в лимит.
const rows = $input.all().map((x) => x.json);

const linked = new Map();     // task_key → thread_id
const closed = new Set();     // task_key, по которым уже видели finish
const lastStatus = new Map(); // task_key → последний записанный статус

for (const r of rows) {
  let p = {};
  try { p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {}); }
  catch (e) { p = {}; }

  if (r.event_type === 'task_linked' && p.task_key) {
    // Задачи из jira3 пропускаем: коллектор умеет только T-Tracker, и
    // запрос по чужому ключу вернул бы пустоту, которую легко прочитать
    // как «задача исчезла».
    if (p.tracker === 'jira') continue;
    linked.set(p.task_key, r.thread_id);
  }
  if (r.event_type === 'task_status_changed' && p.task_key) {
    lastStatus.set(p.task_key, p.status || '');
    if (p.is_final) closed.add(p.task_key);
  }
}

const keys = [...linked.keys()].filter((k) => !closed.has(k));

// Пустой список — не повод отправлять запрос с пустым IN (): TQL на нём
// вернёт ошибку либо ВСЕ задачи трекера, а это 68 тысяч строк в лог.
if (!keys.length) {
  return [{ json: { keys: [], tql: '', nothing_to_poll: true,
                    note: 'нет открытых задач для опроса' } }];
}

// Предохранитель на объём запроса. Резать молча нельзя: обрезанные задачи
// перестали бы опрашиваться, и их cycle time замер бы навсегда.
const MAX = 200;
const poll = keys.slice(0, MAX);
const dropped = keys.slice(MAX);

return [{ json: {
  keys: poll,
  dropped,
  tql: 'taskKey IN (' + poll.map((k) => '"' + k + '"').join(', ') + ')',
  threads: Object.fromEntries(poll.map((k) => [k, linked.get(k)])),
  known: Object.fromEntries(poll.map((k) => [k, lastStatus.get(k) || ''])),
  nothing_to_poll: false,
} }];
"""

TRACKER_DIFF_JS = r"""
// Сравнение снимка с последним известным статусом. Событие пишется ТОЛЬКО
// на изменение: иначе каждый прогон крона добавлял бы строку на задачу, и
// лог рос бы на сотни записей в день без новой информации.
const plan = $('Collect task keys').first().json;
const res = $json || {};
const items = Array.isArray(res.items) ? res.items : [];

// Статусы, означающие «работа закончена». Список НЕ захардкожен полностью:
// в T-Tracker 76 статусов на инстанс, и какие из них будет использовать
// воркфлоу выгрузок — заранее не известно. Поэтому финальность определяется
// в первую очередь по finish_at, который трекер заполняет сам.
const FINAL_HINTS = ['done', 'closed', 'completed', 'resolved', 'released',
                     'cancel', 'trashed', 'выполнено', 'закрыт'];

const out = [];
for (const it of items) {
  const f = it.fields || {};
  const key = it.key || '';
  if (!key) continue;

  const status = String(f.status || '');
  const known = plan.known?.[key] ?? '';
  const threadId = plan.threads?.[key] || '';

  // finish_at заполняется трекером по статусу с aux.type = finish —
  // это надёжнее, чем угадывать по названию.
  const isFinal = Boolean(f.finish_at) ||
    FINAL_HINTS.some((h) => status.toLowerCase().includes(h));

  if (status === known) continue;   // ничего не изменилось

  out.push({ json: {
    event: 'task_status_changed',
    // Ключ идемпотентности — по времени перехода, а не по времени опроса:
    // повторный прогон крона на том же состоянии не создаст новой строки.
    event_id: 'task_status:' + key + ':' + (f.status_update_at || '') + ':' + status,
    thread_id: threadId,
    // ВРЕМЯ ПЕРЕХОДА, а не момент опроса — иначе метрики поехали бы
    // на величину интервала крона.
    event_ts: f.status_update_at ? Date.parse(f.status_update_at) : Date.now(),
    actor: 'tracker',
    source: 'tracker',
    payload: {
      task_key: key,
      status,
      status_from: known,     // пустой на первом снимке — это не ошибка
      is_final: isFinal,
      task_created_at: f.create_at ? Date.parse(f.create_at) : null,
      task_finished_at: f.finish_at ? Date.parse(f.finish_at) : null,
      // Времена промежуточных переходов приблизительны: в T-Tracker нет
      // истории, видны только те смены статуса, что застал крон.
      snapshot: true,
    },
  } });
}

// Задачи, которые опрашивали, но трекер не вернул: нет доступа к спейсу
// (403 на чужой спейс) или задачу удалили. Молчать нельзя — иначе выглядит
// как «статус не менялся», и cycle time тихо замрёт.
const got = new Set(items.map((i) => i.key));
for (const key of plan.keys || []) {
  if (got.has(key)) continue;
  out.push({ json: {
    event: 'task_status_changed',
    event_id: 'task_missing:' + key,
    thread_id: plan.threads?.[key] || '',
    event_ts: Date.now(),
    actor: 'tracker',
    source: 'tracker',
    payload: { task_key: key, status: '', is_final: false,
               error: 'трекер не вернул задачу: нет доступа к спейсу или удалена' },
  } });
}

// Обрезка списка по лимиту называется: обрезанные задачи перестают
// опрашиваться, и это должно быть видно в логе, а не только в коде.
for (const key of plan.dropped || []) {
  out.push({ json: {
    event: 'task_status_changed',
    event_id: 'task_skipped:' + key,
    thread_id: plan.threads?.[key] || '',
    event_ts: Date.now(),
    actor: 'tracker',
    source: 'tracker',
    payload: { task_key: key, status: '', is_final: false,
               error: 'задача не опрошена: список открытых задач превысил лимит 200' },
  } });
}

if (!out.length) {
  // Пустой выход законен: статусы не менялись. Но n8n на пустом массиве
  // не выполнит следующий узел, а нам это и нужно — писать нечего.
  return [];
}
return out;
"""


def build_collector_tracker():
    nodes = [
        # Раз в 15 минут: задачи на выгрузку живут днями, чаще опрашивать
        # нечего. Точность промежуточных статусов ограничена этим интервалом,
        # но create_at и finish_at приходят точными в любом случае.
        node("Every 15 min", "n8n-nodes-base.scheduleTrigger", 1.2, [-260, 300], {
            "rule": {"interval": [{"field": "minutes", "minutesInterval": 15}]},
        }),
        # Лог читается ЦЕЛИКОМ, без фильтра по source, и это не небрежность.
        #
        # Раньше здесь стояло `source eq "channel"`. Задачи (`task_linked`)
        # приходят из канала и фильтр проходили, а статусы
        # (`task_status_changed`) пишутся с `source: 'tracker'` — и не
        # проходили НИКОГДА. Следствий два, оба тихие и оба хуже, чем
        # «одна ветка не выполняется»:
        #   — `closed` всегда пуст, поэтому закрытые задачи опрашиваются
        #     вечно, список растёт и упирается в потолок 200;
        #   — `known` всегда пуст, поэтому «Diff statuses» видит КАЖДЫЙ
        #     статус как изменившийся и пишет событие на задачу каждые
        #     15 минут. Ровно то, что комментарий в самой ноде обещает
        #     не допускать: «событие только на ИЗМЕНЕНИЕ статуса, иначе
        #     каждый прогон крона добавлял бы строку на задачу».
        # Отбор по типу события делает «Collect task keys» — он и так
        # переключается по `event_type`, и там ошибиться нечем.
        #
        # returnAll обязателен: без него Data Tables молча вернёт первые N
        # строк, а «первые N» лога — это самые старые события, где ни одной
        # актуальной задачи может не быть вовсе. У двух других читателей
        # той же таблицы (Telemetry Report, Telemetry Flush) он задан явно
        # и по той же причине.
        node("Read log", "n8n-nodes-base.dataTable", 1, [-20, 300], {
            "operation": "get",
            "dataTableId": {"__rl": True, "value": TABLE, "mode": "name"},
            "returnAll": True,
            "options": {},
        }),
        node("Collect task keys", "n8n-nodes-base.code", 2, [220, 300],
             {"jsCode": TRACKER_KEYS_JS}),
        node("Any tasks", "n8n-nodes-base.if", 2.2, [460, 300], {
            "conditions": {
                "options": {"caseSensitive": True, "typeValidation": "loose",
                            "version": 2},
                "conditions": [{
                    "id": "has-keys",
                    "leftValue": "={{ $json.nothing_to_poll }}",
                    "rightValue": False,
                    "operator": {"type": "boolean", "operation": "false",
                                 "singleValue": True},
                }],
                "combinator": "and",
            },
            "looseTypeValidation": True,
            "options": {},
        }),
        # Поиск, а не точечный GET по ключу: GET /tasks/key/{key} отдаёт 403
        # на задачу из недоступного спейса и роняет прогон, а поиск просто
        # не вернёт её — и это видно по расхождению списков в Diff.
        node("Search tasks", "n8n-nodes-base.httpRequest", 4.2, [700, 240], {
            "method": "POST",
            "url": "https://tracker.t-tech.team/api/public/v1/tasks/search",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ tql: $json.tql, limit: 200,"
                        " fields: ['task_key','status','create_at','finish_at',"
                        "'status_update_at','type','space_key'] }) }}",
            "options": {"redirect": {"redirect": {"followRedirects": False}},
                        "response": {"response": {"neverError": True}}},
        }, credentials=copy.deepcopy(DP_CRED)),
        node("Diff statuses", "n8n-nodes-base.code", 2, [940, 240],
             {"jsCode": TRACKER_DIFF_JS}),
        call_ingest([1180, 240]),
    ]
    conn = {}
    conn.update(chain("Every 15 min", "Read log", "Collect task keys", "Any tasks"))
    # Ложная ветка никуда не ведёт: опрашивать нечего — писать нечего.
    conn["Any tasks"] = {"main": [
        [{"node": "Search tasks", "type": "main", "index": 0}],
        [],
    ]}
    conn.update(chain("Search tasks", "Diff statuses", "To Ingest"))
    return wf("Telemetry · Collector Tracker", nodes, conn)


# ================================================= 5. Feedback Webhook
#
# Кнопки под ответом бота в канале черновиков. Ради одного числа, которого
# нет больше нигде: помог ответ или нет. Всё остальное в логе — косвенное.
#
# ПОЧЕМУ ВЕБХУК, А НЕ РЕАКЦИЯ. Реакция под ответом бота попала бы в тот же
# коллектор канала и была бы дешевле. Но реакции в канале черновиков уже
# заняты словарём дежурного (:loading:, :done_checkmark:), и одно и то же
# действие значило бы разное в зависимости от того, под чьим постом оно
# стоит. Кнопка называет себя сама и несёт контекст: версию промптов и
# уверенность, с которой бот отвечал.
#
# ТРИ КНОПКИ, А НЕ ДВЕ. «Помогло / не помогло» — цифра, «написать подробнее» —
# причина. Без второго не понять, ЧТО чинить: промпт, базу знаний или
# конструкцию ответа.
#
# ТЕКСТ — ДИАЛОГОМ, а не «ответьте в тред». Ответ в треде пришлось бы
# вылавливать отдельным триггером и отличать от рабочей переписки; диалог
# приходит на этот же вебхук готовой формой. Плата — `trigger_id` живёт
# считаные секунды, поэтому диалог открывается ПЕРВЫМ действием, до записи
# в лог: сначала форма человеку, потом бухгалтерия.
FEEDBACK_PATH = "bot-feedback"

# Проверка живости вебхука. Отдельный путь и метод GET, тот же воркфлоу.
#
# ЗАЧЕМ. У «нажал кнопку — ничего не произошло» ровно три причины, и по виду
# канала они неразличимы: воркфлоу не активирован (production-адрес отдаёт 404
# «webhook not registered»), Time не достучался до n8n, или упал наш код.
# Mattermost про первые две молчит: он делает запрос сам, ответ показывает
# только при валидном JSON, а 404 и сетевую ошибку кладёт себе в лог, куда
# у нас доступа нет. Одна команда curl отделяет первые две причины от третьей:
#
#     curl -sS https://n8n.t-tech.team/webhook/bot-feedback-ping
#
# Ответ `{"ok":true,...}` = воркфлоу активен и снаружи доступен, значит дело
# в разборе; 404 = воркфлоу не активирован (после импорта он ВЫКЛЮЧЕН, и это
# самая частая причина мёртвых кнопок); таймаут = сеть.
FEEDBACK_PING_PATH = "bot-feedback-ping"

# Базовый адрес Time. Нужен для POST /actions/dialogs/open: у credential есть
# baseUrl, но HTTP-нода требует полный URL в параметре.
MM_BASE = os.environ.get("MM_BASE_URL", "https://time.tbank.ru")

FEEDBACK_PARSE_JS = r"""
// Разбор нажатия кнопки и присланной формы.
//
// На этот вебхук приходят ДВА разных тела, и различать их обязательно:
//
//   кнопка   { user_id, post_id, channel_id, trigger_id,
//              context: { action, thread_id, topic, confidence, prompt_version } }
//   форма    { type: 'dialog_submission', submission: { text }, state,
//              user_id, channel_id, callback_id }
//
// Контекст кнопки Mattermost возвращает КАК ОТПРАВИЛИ — это единственное
// место, где известно, к какому обращению и к какой версии промптов
// относится оценка. Через месяц по логу иначе не разобрать, на что ругались.

// Темы — тот же список, что у нормализатора: он подставляется сборщиком
// из одного места (CURRENT_TOPICS + ARCHIVE_TOPICS).
//
// ЗАЧЕМ КЛАССИФИКАЦИЯ ЗДЕСЬ. Бот про список тем не знает вовсе и не должен:
// он проверяет префикс `Cross Data |`, поэтому правка формы его не касается.
// В контексте кнопки едет ЗАГОЛОВОК темы («Cross Data | Выгрузка данных»),
// а в колонку `kind` таблицы обязан лечь аналитический ключ (`export`) —
// тот же, что пишет `request_created`. Иначе в одной колонке оказались бы
// два словаря сразу, и разбивка по темам разъехалась бы на «обращения»
// и «оценки» как на разные темы. Ровно это и было до 2026-08-13.
const TOPICS = __TOPICS__;
const KINDS = __KINDS__;

// Заголовок темы → аналитический ключ. Принимает три формы, потому что
// нажать могут на кнопку под СТАРЫМ постом, собранным прежней версией бота:
//   1) готовый ключ (`export`) — новые кнопки, ничего делать не надо;
//   2) полный заголовок («Cross Data | Выгрузка данных»);
//   3) хвост без префикса («Выгрузка данных») — так тему отдавали кнопки
//      до 2026-08-13; посты с ними живут в канале и нажимаются до сих пор.
// Неузнанное не выдумывается: kind='unknown', а сырой заголовок остаётся
// в payload — по нему видно, что именно приехало.
function tail(title) {
  const parts = String(title).split('|');
  const rest = parts.slice(1).join('|').trim();
  return rest || String(title).trim();
}
function classifyTopic(topicRaw, kindRaw) {
  const clean = (v) => String(v ?? '')
    .replace(/^[\s>*_#`~]+/, '').replace(/[\s*_`~]+$/, '').trim();
  const topic = clean(topicRaw);
  const asKind = clean(kindRaw);

  if (KINDS.indexOf(asKind) !== -1) return { kind: asKind, topic: topic || asKind };

  for (const candidate of [topic, asKind]) {
    if (!candidate) continue;
    for (const t of TOPICS) {
      if (candidate === t.title || candidate.startsWith(t.title)) {
        return { kind: t.kind, topic: candidate };
      }
    }
    for (const t of TOPICS) {
      const suffix = tail(t.title);
      if (suffix && (candidate === suffix || candidate.startsWith(suffix))) {
        return { kind: t.kind, topic: candidate };
      }
    }
  }
  return { kind: 'unknown', topic: topic || asKind };
}

const body = $json.body ?? $json ?? {};
const ctx = body.context ?? {};

const isDialog = String(body.type ?? '') === 'dialog_submission';

// state диалога — сериализованный контекст кнопки: диалог не наследует
// context, и без него оценка приехала бы без обращения и без версии.
let state = {};
if (isDialog) {
  try { state = JSON.parse(String(body.state ?? '{}')); } catch (e) { state = {}; }
}
const from = (name) => (isDialog ? state[name] : ctx[name]);

const action = isDialog ? 'detail_submitted' : String(ctx.action ?? '');
const threadId = String(from('thread_id') ?? '');
const actor = String(body.user_id ?? '');
const ts = Date.now();

const topic = classifyTopic(from('topic'), from('kind'));

const meta = {
  confidence: String(from('confidence') ?? ''),
  // kind — аналитический ключ для колонки таблицы, topic — то, что реально
  // приехало кнопкой. Второе не выбрасываем: по нему чинится классификация,
  // если форму расширят темой, которой нет в списке.
  kind: topic.kind,
  topic: topic.topic,
  prompt_version: String(from('prompt_version') ?? ''),
  answer_post_id: String((isDialog ? state.answer_post_id : body.post_id) ?? ''),
};

// helpful — булево, а не строка: по строке «false» витрина посчитает
// половину оценок положительными, и заметить это будет нечем.
const HELPFUL = { helpful: true, not_helpful: false };

const out = {
  action,
  is_dialog: isDialog,
  thread_id: threadId,
  actor,
  channel_id: String(body.channel_id ?? ''),
  trigger_id: String(body.trigger_id ?? ''),
  // post_id поста С КНОПКАМИ — по нему добирается исходный текст шапки
  // перед тем, как заменить кнопки отметкой (см. Get post).
  post_id: String(body.post_id ?? ''),
  needs_dialog: action === 'detail',
  // Пост правим только у оценки: у формы и у незнакомой кнопки править
  // нечего, а лишний GET по пустому post_id — это красная нода на каждом
  // отзыве, к которой быстро привыкают и перестают смотреть.
  needs_post: !isDialog && (action in HELPFUL),
  // Неизвестное действие не молчит: кнопку могли переименовать в шапке,
  // и тогда оценки перестали бы писаться, а флоу остался бы зелёным.
  unknown: !isDialog && !(action in HELPFUL) && action !== 'detail',
};

if (isDialog) {
  const text = String(body.submission?.text ?? '').trim();
  out.event = {
    event: 'feedback_text',
    event_id: 'feedback_text:' + threadId + ':' + actor + ':' + ts,
    thread_id: threadId,
    event_ts: ts,
    actor,
    source: 'webhook',
    payload: { ...meta, text, text_len: text.length },
  };
  // Mattermost закрывает форму сам; ephemeral_text — подтверждение человеку,
  // что текст не улетел в никуда.
  out.response = { ephemeral_text: 'Спасибо, записал. Это попадёт в разбор качества ответов.' };
} else if (action === 'detail') {
  out.dialog = {
    trigger_id: String(body.trigger_id ?? ''),
    url: __CALLBACK_URL__,
    dialog: {
      callback_id: 'bot-feedback:' + threadId,
      title: 'Обратная связь по ответу бота',
      introduction_text: 'Что было не так или чего не хватило? Пишите как есть — ' +
        'это читает тот, кто правит промпты и базу знаний.',
      submit_label: 'Отправить',
      // state — единственный способ донести контекст до отправки формы.
      state: JSON.stringify({ thread_id: threadId, ...meta }),
      elements: [{
        display_name: 'Что не так с ответом',
        name: 'text',
        type: 'textarea',
        optional: false,
        max_length: 3000,
      }],
    },
  };
  // САМО НАЖАТИЕ ТОЖЕ ПИШЕТСЯ, отдельным типом события.
  //
  // Раньше не писалось — по правилу «нажатие без отправки не обратная связь».
  // Правило верное для метрики качества и вредное для отладки: пока в логе
  // не было ни строки, «кнопки не работают» и «кнопки работают, но никто
  // не дописывает текст» выглядели одинаково. Разные типы событий разводят
  // эти два случая, а витрина считает оценки по bot_feedback и на открытие
  // формы не смотрит. Ключ без времени: повторное открытие той же формы
  // тем же человеком — та же строка, а не вторая.
  out.event = {
    event: 'feedback_detail_opened',
    event_id: 'feedback_detail_opened:' + threadId + ':' + actor,
    thread_id: threadId,
    event_ts: ts,
    actor,
    source: 'webhook',
    payload: { ...meta },
  };
  // Тело ответа собирается после попытки открыть форму: см. Dialog reply.
  out.response = {};
} else if (action in HELPFUL) {
  const helpful = HELPFUL[action];
  out.event = {
    event: 'bot_feedback',
    // Ключ идемпотентности БЕЗ времени: повторное нажатие переписывает
    // оценку того же человека по тому же обращению, а не добавляет вторую.
    // Иначе один передумавший джун весит столько же, сколько десять разных.
    event_id: 'bot_feedback:' + threadId + ':' + actor,
    thread_id: threadId,
    event_ts: ts,
    actor,
    source: 'webhook',
    payload: { ...meta, helpful },
  };
  // Отметка вместо кнопок. Собирается в Build reply — там есть исходный пост,
  // без которого его нельзя обновлять (см. комментарий там же).
  out.verdict = {
    helpful,
    text: (helpful ? '👍 Помогло' : '👎 Не помогло') + ' — записано, спасибо.',
    color: helpful ? '#3db887' : '#d24b4e',
  };
  out.response = { ephemeral_text: 'Записал: ' + (helpful ? 'помогло' : 'не помогло') + '.' };
} else {
  // Неизвестное действие: человеку — честный ответ, в лог — событие,
  // по которому видно, что кнопка и вебхук разъехались.
  out.event = {
    event: 'bot_feedback',
    event_id: 'bot_feedback:unknown:' + threadId + ':' + actor + ':' + ts,
    thread_id: threadId,
    event_ts: ts,
    actor,
    source: 'webhook',
    payload: { ...meta, helpful: null, unknown_action: action },
  };
  out.response = { ephemeral_text: 'Не понял, какая это кнопка. Записал как есть.' };
}

return [{ json: out }];
"""

# Ответ на оценку: отметка вместо кнопок ПЛЮС исходный текст поста.
#
# ПОЧЕМУ ПОСТ СНАЧАЛА ЧИТАЕТСЯ. `update` в ответе интеграции — это не патч,
# а целый пост: Mattermost берёт из него message и props и записывает как
# есть. Ответ `{update:{props:{attachments:[…]}}}` без message стирает текст
# шапки — тему, ссылку на обращение и уверенность, — оставляя одну строку
# «записано, спасибо». То же с props: пришлось бы затереть всё, что положил
# туда intake или сам бот.
#
# Поэтому пост добирается GET-ом и отдаётся обратно целиком, а меняется
# в нём только attachments. Не достучались (пост удалён, права, сеть) —
# ответ вырождается в эфемерное подтверждение: кнопки останутся живыми,
# но оценка ЗАПИСАНА, а человек видит ответ. Тихого отказа нет ни в одном
# из двух исходов.
FEEDBACK_REPLY_JS = r"""
const parsed = $('Parse action').first().json;

// На входе либо ответ Mattermost на GET /posts/{id}, либо разбор целиком —
// когда ветка обошла GET (форма, незнакомая кнопка) или когда GET упал
// с onError=continue. Настоящий пост узнаётся по паре id+message: у разбора
// поля id нет вовсе.
const src = $json ?? {};
const fetched = (src && typeof src.id === 'string' && src.id &&
                 typeof src.message === 'string') ? src : null;

const response = { ...(parsed.response ?? {}) };
const verdict = parsed.verdict;

if (verdict && fetched) {
  const props = { ...(fetched.props ?? {}) };
  props.attachments = [{ text: verdict.text, color: verdict.color }];
  response.update = {
    // Текст шапки переносится как есть: без него Mattermost затрёт пост.
    message: String(fetched.message ?? ''),
    props,
  };
  // Пост изменится у всех, эфемерное подтверждение станет дублем.
  delete response.ephemeral_text;
  response.ephemeral_text = verdict.helpful
    ? 'Спасибо! Если есть что добавить — кнопка «Написать подробнее» под соседними ответами.'
    : 'Записал. Если опишете, что было не так, — починим быстрее: кнопка «Написать подробнее».';
}

return [{ json: { response, event: parsed.event ?? null } }];
"""

# Ответ на нажатие «Написать подробнее».
#
# Форму открывает отдельный вызов API, и он может не успеть: trigger_id живёт
# считаные секунды. Раньше на этот случай возвращалось `{}` — человек нажимал
# кнопку и не получал ни формы, ни объяснения. Теперь неудача называется.
FEEDBACK_DIALOG_REPLY_JS = r"""
const parsed = $('Parse action').first().json;
const src = $json ?? {};

// Нода открытия формы стоит с onError=continue: при отказе в элементе
// лежит error, а не ответ Mattermost.
const failed = Boolean(src && (src.error || src.status_code >= 400));

// Успех: тело ПУСТОЕ. Форма уже открыта отдельным вызовом, и любой текст
// здесь встанет вторым сообщением поверх неё.
const response = failed
  ? { ephemeral_text: 'Форма не открылась — Time не принял запрос (обычно это ' +
      'истёкшая кнопка). Нажмите ещё раз или напишите в тред: прочитаю там.' }
  : {};

return [{ json: { response, event: parsed.event ?? null } }];
"""


def build_feedback():
    parse = node("Parse action", "n8n-nodes-base.code", 2, [200, 300], {
        "jsCode": (FEEDBACK_PARSE_JS
                   .replace("__CALLBACK_URL__", js_const(FEEDBACK_WEBHOOK_URL))
                   .replace("__TOPICS__", js_const(topics_js()))
                   .replace("__KINDS__", js_const(sorted({k for _, k, _ in TOPICS})))),
    })

    hook = node("Webhook", "n8n-nodes-base.webhook", 2, [-40, 300], {
        "httpMethod": "POST",
        "path": FEEDBACK_PATH,
        # responseNode: отвечаем ТЕЛОМ, которое собрал разбор. Ответ вебхука —
        # часть протокола кнопок Mattermost (update / ephemeral_text), а не
        # формальность: без него человек не видит вообще ничего.
        "responseMode": "responseNode",
        "options": {},
    }, webhookId="bot-feedback-hook")

    ping = node("Ping", "n8n-nodes-base.webhook", 2, [-40, 620], {
        "httpMethod": "GET",
        "path": FEEDBACK_PING_PATH,
        "responseMode": "responseNode",
        "options": {},
    }, webhookId="bot-feedback-ping")

    respond_ping = node("Respond ping", "n8n-nodes-base.respondToWebhook", 1.1,
                        [200, 620], {
        "respondWith": "json",
        "responseBody": '={{ JSON.stringify({ ok: true, hook: "' + FEEDBACK_PATH +
                        '", ts: Date.now() }) }}',
        "options": {},
    })

    def gate(name, pos, field):
        return node(name, "n8n-nodes-base.if", 2.2, pos, {
            "conditions": {
                "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": field,
                    "leftValue": "={{ $json." + field + " }}",
                    "rightValue": True,
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "looseTypeValidation": True,
            "options": {},
        })

    # Открытие формы. onError=continue: trigger_id живёт секунды, и просроченный
    # id — это отказ ОДНОГО нажатия, а не повод ронять вебхук, который в этот
    # же момент отвечает Mattermost.
    open_dialog = node("Open dialog", "n8n-nodes-base.httpRequest", 4.4, [680, 160], {
        "method": "POST",
        "url": MM_BASE.rstrip("/") + "/api/v4/actions/dialogs/open",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "mattermostApi",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.dialog) }}",
        "options": {},
    }, credentials=copy.deepcopy(MM_CRED), onError="continueRegularOutput")

    # Исходный пост под замену кнопок. onError=continue: не прочитали — отвечаем
    # эфемерным подтверждением, оценка при этом уже записана.
    get_post = node("Get post", "n8n-nodes-base.httpRequest", 4.4, [920, 380], {
        "method": "GET",
        "url": "={{ '" + MM_BASE.rstrip("/") + "/api/v4/posts/' + $json.post_id }}",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "mattermostApi",
        "options": {},
    }, credentials=copy.deepcopy(MM_CRED), onError="continueRegularOutput")

    def respond(name, pos):
        return node(name, "n8n-nodes-base.respondToWebhook", 1.1, pos, {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify($json.response) }}",
            "options": {},
        })

    nodes = [
        hook,
        ping,
        respond_ping,
        parse,
        gate("Needs dialog", [440, 300], "needs_dialog"),
        open_dialog,
        node("Dialog reply", "n8n-nodes-base.code", 2, [920, 160],
             {"jsCode": FEEDBACK_DIALOG_REPLY_JS}),
        respond("Respond dialog", [1160, 160]),
        gate("Needs post", [680, 440], "needs_post"),
        get_post,
        node("Build reply", "n8n-nodes-base.code", 2, [1160, 440],
             {"jsCode": FEEDBACK_REPLY_JS}),
        respond("Respond feedback", [1400, 440]),
        # Ingest объявлен passthrough и ждёт СОБЫТИЕ верхним уровнем.
        # Отдать ему разбор целиком значило бы записать `unsupported_event`
        # с зелёным флоу — ровно тот тихий отказ, от которого сделан call_ingest.
        node("Event for log", "n8n-nodes-base.code", 2, [1640, 300], {"jsCode":
             "return [{ json: $json.event }];"}),
        # onError=continue: запись в лог идёт ПОСЛЕ ответа Mattermost, и падать
        # ей уже некуда — но красный флоу с отправленным ответом читается как
        # «кнопка не сработала». Пусть отказ записи остаётся отказом записи.
        call_ingest([1880, 300]),
    ]

    conn = {}
    # ЗАПИСЬ ИДЁТ ПОСЛЕ ОТВЕТА, а не до.
    #
    # Нода Respond to Webhook отправляет ответ и НЕ заканчивает исполнение:
    # флоу продолжается за ней. Раньше ответ стоял за записью в Ingest, и любой
    # отказ хранилища — недоступная таблица, ошибка подворкфлоу — съедал ответ
    # целиком: Mattermost не получал ни update, ни ephemeral_text, и нажатие
    # выглядело как «ничего не произошло». Это тот же класс отказа, что чинили
    # в guard'е бота: сбой в бухгалтерии не должен выглядеть как сбой кнопки.
    conn.update(chain("Ping", "Respond ping"))
    conn.update(chain("Webhook", "Parse action"))
    conn["Parse action"] = {"main": [[{"node": "Needs dialog", "type": "main", "index": 0}]]}
    conn["Needs dialog"] = {"main": [
        [{"node": "Open dialog", "type": "main", "index": 0}],
        [{"node": "Needs post", "type": "main", "index": 0}],
    ]}
    conn.update(chain("Open dialog", "Dialog reply", "Respond dialog", "Event for log"))
    conn["Needs post"] = {"main": [
        [{"node": "Get post", "type": "main", "index": 0}],
        [{"node": "Build reply", "type": "main", "index": 0}],
    ]}
    conn.update(chain("Get post", "Build reply", "Respond feedback", "Event for log"))
    conn.update(chain("Event for log", "To Ingest"))
    return wf("Support Bot · Feedback Webhook", nodes, conn)


# ==================================================== 6. Telemetry Report
#
# Разбивка лога по темам обращений — то, ради чего `kind` вообще писался
# в отдельную колонку.
#
# ПОЧЕМУ ПЕРЕСЧЁТ, А НЕ СЧЁТЧИКИ. Лог append-only и складывается из четырёх
# источников вразнобой: реакция приезжает раньше ответа бота, backfill
# досыпает историю задним числом, снятая реакция отменяет предыдущую. Любой
# инкрементальный счётчик пришлось бы чинить ретроспективно; пересчёт всего
# лога чинится правкой одной формулы и переприменяется к истории сам.
#
# ЧТО СЧИТАЕТСЯ ПО ТРЕДУ, А НЕ ПО СТРОКАМ. Обращение — это тред: тема на
# корневом событии, время реакции на реакции дежурного, оценка на кнопке под
# ответом бота. Считать «оценок по теме export» напрямую по колонке kind
# нельзя даже теперь, когда кнопка отдаёт правильный ключ: у события реакции
# темы нет вовсе, и такие строки просто выпали бы из разбивки.
REPORT_ROLLUP_JS = r"""
// Пересчёт лога в разбивку по темам.
//
// Вход: все строки support_event. Выход: строка на тему + строка «итого»
// плюс готовая markdown-таблица в отдельном элементе.

const TOPIC_TITLES = __TITLES__;

const rows = $input.all().map((x) => x.json ?? {});

// Пустой вход — это не «обращений не было», а почти наверняка не сработавший
// фильтр чтения таблицы. Молчать нельзя: пустой отчёт читается как факт.
if (!rows.length) {
  return [{ json: {
    ok: false,
    reason: 'лог пуст: проверить имя таблицы и то, что нода чтения вернула все строки',
    markdown: '**Разбивка по темам:** лог пуст — проверить чтение таблицы.',
  } }];
}

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const parse = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (e) { return {}; }
};

// Период: обращения, СОЗДАННЫЕ за последние N дней. Фильтр по дате создания
// треда, а не по дате события: иначе обращение прошлого месяца, закрытое
// вчера, попало бы в отчёт половиной своей жизни.
const DAYS = num($('Period').first().json.days) || 30;
const since = Date.now() - DAYS * 86400000;

const threads = new Map();
const th = (id) => {
  if (!threads.has(id)) {
    threads.set(id, {
      id, kind: '', kind_fallback: '', ours: null, created_at: 0,
      taken_at: 0, closed_at: 0, resolved: null, closes: 0,
      answered: false, confidence: '', prompt_version: '',
      helpful: 0, not_helpful: 0, texts: 0, detail_opened: 0,
      replies_human: 0, replies_bot: 0, task_key: '',
    });
  }
  return threads.get(id);
};

// Порядок событий в таблице произвольный (Data Tables не гарантирует
// сортировку, а backfill вообще приезжает задним числом), поэтому время
// берётся минимумом/максимумом, а не «последним увиденным».
const sorted = rows.slice().sort((a, b) => num(a.event_ts) - num(b.event_ts));

for (const r of sorted) {
  const id = String(r.thread_id ?? '');
  if (!id || id === 'sample-thread') continue;   // строки-образцы схемы
  const p = parse(r.payload);
  const t = th(id);
  const ts = num(r.event_ts);
  const type = String(r.event_type ?? '');

  if (type === 'request_created') {
    // Тема — с корневого события: её проставил человек в форме.
    t.kind = p.kind || t.kind;
    t.ours = p.ours === true;
    t.created_at = t.created_at ? Math.min(t.created_at, ts) : ts;
  } else if (type === 'taken') {
    // Первое взятие за историю треда: дежурный снимает :loading:, когда
    // ставит закрывающую реакцию, и «последнее» обнулило бы время реакции
    // у всех закрытых обращений.
    if (!t.taken_at || ts < t.taken_at) t.taken_at = ts;
  } else if (type === 'closed') {
    t.closed_at = Math.max(t.closed_at, ts);
    t.resolved = p.resolved === null ? t.resolved : p.resolved;
    t.closes++;
  } else if (type === 'closed_removed') {
    // Снятие закрывающей реакции ПЕРЕОТКРЫВАЕТ обращение: там это
    // исправление ошибки, а не часть процесса.
    t.closes--;
    if (t.closes <= 0) { t.closed_at = 0; t.resolved = null; t.closes = 0; }
  } else if (type === 'bot_answered') {
    t.answered = true;
    t.confidence = p.confidence_key || t.confidence;
    t.prompt_version = p.prompt_version || t.prompt_version;
  } else if (type === 'bot_feedback') {
    if (p.helpful === true) t.helpful++;
    else if (p.helpful === false) t.not_helpful++;
    // Оценка знает тему из контекста кнопки — это запасной источник для
    // тредов, чьё корневое событие в лог не попало (бот отвечает в канал
    // черновиков, а обращение живёт в канале обращений).
    if (p.kind && p.kind !== 'unknown') t.kind_fallback = p.kind;
    if (!t.created_at) t.created_at = ts;
  } else if (type === 'feedback_text') {
    t.texts++;
    if (p.kind && p.kind !== 'unknown') t.kind_fallback = p.kind;
    if (!t.created_at) t.created_at = ts;
  } else if (type === 'feedback_detail_opened') {
    t.detail_opened++;
    if (p.kind && p.kind !== 'unknown') t.kind_fallback = p.kind;
  } else if (type === 'human_replied') {
    t.replies_human++;
  } else if (type === 'bot_replied') {
    t.replies_bot++;
  } else if (type === 'task_linked') {
    t.task_key = p.task_key || t.task_key;
  }
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const hours = (ms) => (ms === null ? null : Math.round(ms / 3600000 * 10) / 10);

const buckets = new Map();
const bucket = (kind) => {
  if (!buckets.has(kind)) {
    buckets.set(kind, {
      kind,
      topic: TOPIC_TITLES[kind] || kind,
      requests: 0, ours: 0, taken: 0, closed: 0, unresolved: 0,
      answered: 0, helpful: 0, not_helpful: 0, texts: 0, detail_opened: 0,
      tasks: 0, reaction_ms: [], cycle_ms: [],
      // Реплики и заявленная уверенность накапливались по треду и никуда
      // не доезжали: ни в bucket, ни в вывод, ни в markdown. Считалось,
      // и посмотреть было негде — тот же класс, что поля ядра, которых
      // не читала витрина. Реплики людей это прокси-сигнал на 100 %
      // обращений (кнопки нажимают единицы), а доля высокой уверенности —
      // половина калибровки.
      replies_human: 0, replies_bot: 0, conf_high: 0, conf_none: 0,
    });
  }
  return buckets.get(kind);
};

let skippedOld = 0;
for (const t of threads.values()) {
  if (t.created_at && t.created_at < since) { skippedOld++; continue; }
  // Тема с корневого события; если его нет — из контекста кнопки; если нет
  // и его — `unknown`, и это видно в отчёте отдельной строкой, а не молча
  // размазано по остальным.
  const b = bucket(t.kind || t.kind_fallback || 'unknown');
  b.requests++;
  if (t.ours !== false) b.ours++;
  if (t.taken_at) { b.taken++; if (t.created_at) b.reaction_ms.push(t.taken_at - t.created_at); }
  if (t.closed_at) {
    b.closed++;
    if (t.resolved === false) b.unresolved++;
    if (t.created_at) b.cycle_ms.push(t.closed_at - t.created_at);
  }
  if (t.answered) b.answered++;
  b.helpful += t.helpful;
  b.not_helpful += t.not_helpful;
  b.texts += t.texts;
  b.detail_opened += t.detail_opened;
  if (t.task_key) b.tasks++;
  b.replies_human += t.replies_human || 0;
  b.replies_bot += t.replies_bot || 0;
  if (t.confidence === 'high') b.conf_high++;
  if (t.confidence === 'none') b.conf_none++;
}

const out = [...buckets.values()].map((b) => ({
  kind: b.kind,
  topic: b.topic,
  requests: b.requests,
  ours: b.ours,
  taken: b.taken,
  closed: b.closed,
  open: b.requests - b.closed,
  unresolved: b.unresolved,
  bot_answered: b.answered,
  helpful: b.helpful,
  not_helpful: b.not_helpful,
  // Доля «помогло» среди оценивших. Считается только когда оценки есть:
  // 0 % при нуле оценок читается как «бот всех разочаровал», а это «никто
  // не нажимал».
  helpful_pct: (b.helpful + b.not_helpful)
    ? Math.round(b.helpful * 100 / (b.helpful + b.not_helpful)) : null,
  feedback_texts: b.texts,
  detail_opened: b.detail_opened,
  tasks: b.tasks,
  // Реплики людей в треде — прокси-сигнал на 100 % обращений, в отличие
  // от кнопок, которые нажимают единицы: тред, закрывшийся после ответа
  // бота без переписки, вероятно закрылся ответом бота.
  replies_human: b.replies_human,
  replies_bot: b.replies_bot,
  // Уверенность здесь ДЕЙСТВУЮЩАЯ (`confidence_key`) — та, что осталась
  // после понижения кодом. Пара «заявлено / действует», по которой считается
  // калибровка, живёт в витрине support_request: здесь для неё нет второго
  // поля, и выдавать одно за другое нельзя.
  conf_high: b.conf_high,
  conf_none: b.conf_none,
  reaction_h: hours(median(b.reaction_ms)),
  cycle_h: hours(median(b.cycle_ms)),
})).sort((a, b) => b.requests - a.requests);

const total = out.reduce((acc, r) => {
  for (const k of ['requests', 'ours', 'taken', 'closed', 'open', 'unresolved',
                   'bot_answered', 'helpful', 'not_helpful', 'feedback_texts',
                   'detail_opened', 'tasks', 'replies_human', 'replies_bot',
                   'conf_high', 'conf_none']) acc[k] += r[k];
  return acc;
}, { kind: 'ИТОГО', topic: 'ИТОГО', requests: 0, ours: 0, taken: 0, closed: 0,
     open: 0, unresolved: 0, bot_answered: 0, helpful: 0, not_helpful: 0,
     feedback_texts: 0, detail_opened: 0, tasks: 0,
     replies_human: 0, replies_bot: 0, conf_high: 0, conf_none: 0 });
total.helpful_pct = (total.helpful + total.not_helpful)
  ? Math.round(total.helpful * 100 / (total.helpful + total.not_helpful)) : null;
total.reaction_h = hours(median([...buckets.values()].flatMap((b) => b.reaction_ms)));
total.cycle_h = hours(median([...buckets.values()].flatMap((b) => b.cycle_ms)));

// Готовая markdown-таблица: отчёт смотрят люди, а не BI. Копируется в канал
// как есть.
const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
// «Реплик» — реплики ЛЮДЕЙ в треде. Это прокси-сигнал на 100 % обращений,
// в отличие от кнопок, которые нажимают единицы: много реплик после ответа
// бота значит, что ответа не хватило. «Высокая» — уверенность ДЕЙСТВУЮЩАЯ,
// после понижения кодом; пара «заявлено / действует» живёт в витрине.
const head = ['Тема', 'Обращений', 'Взято', 'Закрыто', 'Открыто', 'Бот ответил',
              '👍', '👎', '% помогло', 'Отзывов', 'Реплик', 'Высокая',
              'Реакция, ч', 'Цикл, ч'];
const line = (r) => '| ' + [
  r.topic, r.requests, r.taken, r.closed, r.open, r.bot_answered,
  r.helpful, r.not_helpful, r.helpful_pct === null ? '—' : r.helpful_pct + '%',
  r.feedback_texts, r.replies_human, r.conf_high,
  cell(r.reaction_h), cell(r.cycle_h),
].map(cell).join(' | ') + ' |';

// Обращения к HC Data лежат в том же канале и в той же таблице, но
// адресованы не нам. В отчёте они отдельными строками — а в «итого» попадают
// вместе со всеми, поэтому доля наших называется явно: иначе «обращений
// за месяц» тихо включало бы чужие.
const foreign = total.requests - total.ours;

const markdown = [
  '**Обращения по темам за ' + DAYS + ' дн.**',
  '',
  '| ' + head.join(' | ') + ' |',
  '|' + head.map(() => '---').join('|') + '|',
  ...out.map(line),
  line(total),
  '',
  foreign ? '_Из них адресовано команде HC Data: ' + foreign +
    ' — в наши метрики времени решения они не идут._' : '',
  '_Реакция — медиана от обращения до :loading:. Цикл — до закрывающей ' +
  'реакции. «% помогло» — из нажатых кнопок под ответом бота._',
].filter(Boolean).join('\n');

return [
  ...out.map((json) => ({ json })),
  { json: { ...total, is_total: true } },
  { json: {
    ok: true,
    markdown,
    days: DAYS,
    rows_read: rows.length,
    threads: threads.size,
    threads_in_period: out.reduce((a, r) => a + r.requests, 0),
    threads_older: skippedOld,
  } },
];
"""


def build_report():
    period = node("Period", "n8n-nodes-base.set", 3.4, [200, 300], {
        "assignments": {"assignments": [{
            "id": "days",
            "name": "days",
            "type": "number",
            "value": 30,
        }]},
        "options": {},
    })

    # Читается ВЕСЬ лог, без фильтра по времени: тред живёт дольше окна отчёта
    # (обращение прошлого месяца закрывают на этой неделе), и фильтр по
    # event_ts порезал бы его на половину состояния. Отбор по периоду делает
    # пересчёт — по дате СОЗДАНИЯ обращения.
    #
    # returnAll задан явно: если у операции есть постраничный лимит, молчаливая
    # выдача первых N строк даст правдоподобный, но неверный отчёт. Лишний
    # параметр n8n игнорирует, недостающий — стоил бы половины истории.
    read = node("Read log", "n8n-nodes-base.dataTable", 1, [440, 300], {
        "operation": "get",
        "dataTableId": {"__rl": True, "value": TABLE, "mode": "name"},
        "returnAll": True,
        "filters": {"conditions": []},
        "options": {},
    })

    titles = {}
    for title, kind, _ours in TOPICS:
        # Отображаемое имя — из ТЕКУЩЕЙ формы: у kind их может быть несколько
        # (переименование команды), а в отчёте нужно то, что человек видит
        # в форме сегодня.
        titles.setdefault(kind, title.replace("|", "·").strip(" ·"))
    titles["unknown"] = "Тема не распознана"

    rollup = node("Rollup by topic", "n8n-nodes-base.code", 2, [680, 300], {
        "jsCode": REPORT_ROLLUP_JS.replace("__TITLES__", js_const(titles)),
    })

    nodes = [
        node("Run manually", "n8n-nodes-base.manualTrigger", 1, [-40, 300], {}),
        period,
        read,
        rollup,
    ]
    conn = {}
    conn.update(chain("Run manually", "Period", "Read log", "Rollup by topic"))
    return wf("Telemetry · Report", nodes, conn)



# ===================================================== 7. Telemetry Flush
#
# Батч из Data Tables в DLH Trino. Раз в час, потому что задачи на выгрузку
# живут днями, а не минутами — свежесть витрины в DLH не обязана быть выше
# свежести самих обращений.
#
# WATERMARK — ЗАПРОСОМ К САМОЙ ТАБЛИЦЕ, А НЕ ОТДЕЛЬНЫМ СОСТОЯНИЕМ. Хранить
# курсор ("последний залитый ingested_at") отдельно значило бы городить ещё
# одну табличку ради одного числа и ловить рассинхрон между ней и Trino при
# сбое на полпути. `MAX(ingested_at)` из `DLH_TABLE` — это и есть источник
# истины: если прогон упал на середине, следующий увидит максимум по факту
# залитого и продолжит ровно оттуда.
FLUSH_WATERMARK_SQL = (
    "SELECT COALESCE(CAST(to_unixtime(MAX(ingested_at)) * 1000 AS bigint), 0)"
    " AS wm_ms\nFROM " + DLH_TABLE
)

# Разбор ответа Trino-ноды. Отдельный узел, потому что форма ответа
# `CUSTOM.trino` живым прогоном НЕ подтверждена — как и имена её параметров.
FLUSH_WATERMARK_JS = r"""
// Достаёт wm_ms из ответа ноды Trino, какой бы формы он ни был, и РОНЯЕТ
// прогон на нераспознанной.
//
// Подставлять 0 по умолчанию нельзя ни в какую сторону: в режиме merge это
// перезалив всей истории каждый час, в режиме insert — дубли всей истории.
// Отдать «нечего заливать» нельзя тем более: телеметрия просто перестала бы
// доезжать до DLH, и по виду флоу это неотличимо от «новых событий не было».
// Единственный честный вариант — громкая ошибка с текстом ответа.
const items = $input.all();
if (!items.length) {
  throw new Error('Watermark: нода Trino не вернула ни одного элемента, '
    + 'а SELECT MAX(...) обязан вернуть строку даже по пустой таблице');
}

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

// Порядок поиска: сама величина → колонка wm_ms → известные обёртки
// (data/rows/…) → единственный ключ объекта. Именно в этом порядке, чтобы
// не подобрать первое попавшееся число из служебных полей ответа.
const find = (v, depth) => {
  if (v == null || depth > 4) return null;
  const direct = num(v);
  if (direct !== null) return direct;
  if (Array.isArray(v)) return v.length ? find(v[0], depth + 1) : null;
  if (typeof v !== 'object') return null;
  for (const k of Object.keys(v)) {
    if (/^wm_?ms$/i.test(k)) {
      const n = num(v[k]);
      if (n !== null) return n;
    }
  }
  for (const k of ['data', 'rows', 'result', 'results', 'response', 'body']) {
    if (k in v) {
      const n = find(v[k], depth + 1);
      if (n !== null) return n;
    }
  }
  const keys = Object.keys(v);
  return keys.length === 1 ? find(v[keys[0]], depth + 1) : null;
};

const wm = find(items[0].json, 0);
if (wm === null || wm < 0) {
  throw new Error('Watermark: не нашёл wm_ms в ответе Trino — '
    + 'проверить, что нода вернула колонку wm_ms: '
    + JSON.stringify(items[0].json).slice(0, 300));
}
return [{ json: { wm_ms: wm } }];
"""

# Сборка батча. Экранирование кавычек ОБЯЗАТЕЛЬНО: payload и question_text
# несут сырой текст людей, и без него это SQL-инъекция в собственную же
# таблицу, а не абстрактный риск.
#
# Узел отдаёт НЕСКОЛЬКО элементов — по одному готовому запросу на чанк. Нода
# Trino выполняется по разу на входной элемент, поэтому чанкование делается
# здесь: другого места, где оно возможно, во флоу нет.
FLUSH_BUILD_SQL_JS = r"""
// Вход: строки support_event с ingested_at за watermark (Read new events).
const TABLE = '__DLH_TABLE__';
const MODE = '__WRITE_MODE__';
const COLS = __COLS__;
const TIME_COLS = __TIME_COLS__;
const TS_EXPR = '__TS_EXPR__';
const MAX_ROWS = __MAX_ROWS__;
const MAX_CHARS = __MAX_CHARS__;

const rows = $input.all().map((x) => x.json || {});

// Trino: в строковом литерале экранируется только одинарная кавычка —
// удвоением, как в стандартном SQL. Обратный слэш экранировать не нужно.
const esc = (v) => "'" + String(v ?? '').replace(/'/g, "''") + "'";
// event_ts/ingested_at в Data Tables — мс-эпоха (Date.now()). Делим на
// 1000.0, а не на 1000: целочисленное деление обнулило бы миллисекунды тихо.
const ts = (ms) => TS_EXPR.split('{ms}').join(String(Number(ms) || 0));

// event_id — ключ идемпотентности, и в Data Tables он уникален по upsert'у.
// НО имена параметров условия upsert в `Write event` выведены из документации,
// а не подтверждены живым узлом: если условие не сработало, в таблице лежат
// дубли. Для MERGE это ошибка Trino («несколько строк источника на одну
// строку цели»), то есть падение всего прогона из-за пары строк.
//
// Схлопываем здесь, оставляя последнюю запись, и НАЗЫВАЕМ число: молча
// схлопывать нельзя — это единственный сигнал о неработающем upsert'е.
const byId = new Map();
let duplicates = 0;
let without_id = 0;
for (const r of rows) {
  const id = String(r.event_id ?? '');
  if (!id) { without_id++; continue; }
  const prev = byId.get(id);
  if (prev) {
    duplicates++;
    if ((Number(r.ingested_at) || 0) < (Number(prev.ingested_at) || 0)) continue;
  }
  byId.set(id, r);
}

// Порядок по ingested_at: чанки заливаются по очереди, и если прогон упадёт
// на середине, в DLH останется КОНСИСТЕНТНЫЙ префикс — watermark следующего
// прогона встанет ровно на границу залитого. При произвольном порядке провал
// в середине оставил бы дыру, которую watermark перешагнул бы молча.
const ordered = [...byId.values()].sort(
  (a, b) => (Number(a.ingested_at) || 0) - (Number(b.ingested_at) || 0));

const stats = { rows_total: ordered.length, duplicates_collapsed: duplicates,
                rows_without_id: without_id };

if (!ordered.length) {
  return [{ json: { empty: true, sql: '', batch_size: 0, chunks: 0,
                    mode: MODE, ...stats } }];
}

const colList = COLS.join(', ');
const tuple = (r) => '  ('
  + COLS.map((c) => (TIME_COLS.includes(c) ? ts(r[c]) : esc(r[c]))).join(', ')
  + ')';

// MERGE по event_id: прогон идемпотентен, и перезалив краевой строки после
// сбоя ничего не портит. INSERT — запасной путь на случай отсутствия прав,
// и тогда дубли обязан снимать пересчёт витрины.
const head = MODE === 'merge'
  ? `MERGE INTO ${TABLE} AS t\nUSING (\n  VALUES\n`
  : `INSERT INTO ${TABLE} (${colList})\nVALUES\n`;
const tail = MODE === 'merge'
  ? `\n) AS s (${colList})\nON t.event_id = s.event_id\n`
    + 'WHEN MATCHED THEN UPDATE SET '
    + COLS.filter((c) => c !== 'event_id').map((c) => `${c} = s.${c}`).join(', ')
    + `\nWHEN NOT MATCHED THEN INSERT (${colList})\n  VALUES (`
    + COLS.map((c) => `s.${c}`).join(', ') + ')'
  : '';

const overhead = head.length + tail.length;
const chunks = [];
let cur = [];
let size = 0;
for (const r of ordered) {
  const t = tuple(r);
  // Строка длиннее лимита целиком резаться нечем — уезжает своим чанком,
  // и лимит Trino отработает громко. Молча её выбросить нельзя: событие
  // пропало бы навсегда, watermark его перешагнёт.
  if (cur.length && (cur.length >= MAX_ROWS
                     || overhead + size + t.length + 2 > MAX_CHARS)) {
    chunks.push(cur);
    cur = [];
    size = 0;
  }
  cur.push(t);
  size += t.length + 2;
}
if (cur.length) chunks.push(cur);

return chunks.map((c, i) => ({ json: {
  empty: false,
  sql: head + c.join(',\n') + tail,
  batch_size: c.length,
  chunk: i + 1,
  chunks: chunks.length,
  mode: MODE,
  ...stats,
} }));
"""


def flush_ts_expr():
    """Выражение для колонки времени из мс-эпохи.

    Одно место на два запроса и на оба типа колонки. `CAST` явный: таблица
    заведена руками, точность её timestamp сборщику неизвестна, а неявное
    расширение точности — предположение, которое дешевле не делать.
    """
    if DLH_TS_TYPE.startswith("timestamp"):
        return "CAST(from_unixtime({ms} / 1000.0) AS " + DLH_TS_TYPE + ")"
    return "{ms}"


def flush_build_sql_js():
    cols = [name for name, _t, _w in SCHEMA]
    missing = [c for c in DLH_TIME_COLS if c not in cols]
    if missing:
        # Колонка времени, которой нет в схеме лога, — это не мелочь:
        # конвертация не применится, и в timestamp уедет строка с числом.
        raise SystemExit(f"DLH_TIME_COLS: нет в SCHEMA: {missing}")
    if DLH_WRITE_MODE not in ("merge", "insert"):
        raise SystemExit(f"DLH_WRITE_MODE: ожидается merge|insert, задано {DLH_WRITE_MODE}")
    return (
        FLUSH_BUILD_SQL_JS
        .replace("__DLH_TABLE__", DLH_TABLE)
        .replace("__WRITE_MODE__", DLH_WRITE_MODE)
        .replace("__COLS__", js_const(cols))
        .replace("__TIME_COLS__", js_const(list(DLH_TIME_COLS)))
        .replace("__TS_EXPR__", flush_ts_expr())
        .replace("__MAX_ROWS__", str(FLUSH_MAX_ROWS))
        .replace("__MAX_CHARS__", str(FLUSH_MAX_CHARS))
    )


def dlh_ddl():
    """CREATE TABLE для DLH из SCHEMA — единственное описание формы таблицы.

    Сборщик таблицу не создаёт, но состав колонок в MERGE обязан ей
    соответствовать, а разъезжаются они молча: лишняя колонка в SCHEMA — это
    ошибка Trino (громко), НЕ хватающая в SCHEMA — тихо не залитые данные.
    """
    types = {"string": "varchar", "number": "double", "boolean": "boolean"}
    lines = []
    for i, (name, type_, why) in enumerate(SCHEMA):
        t = DLH_TS_TYPE if name in DLH_TIME_COLS else types.get(type_, "varchar")
        comma = "," if i < len(SCHEMA) - 1 else ""
        lines.append(f"  {name} {t}{comma}".ljust(32) + f"-- {why}")
    return (
        f"CREATE TABLE IF NOT EXISTS {DLH_TABLE} (\n"
        + "\n".join(lines)
        + "\n)\nWITH (\n"
        "  format = 'PARQUET',\n"
        # Партиционирование по дню СОБЫТИЯ, а не по дню записи: витрина
        # режется по времени обращения, и засев истории не должен складывать
        # июль в партицию сегодняшнего дня.
        "  partitioning = ARRAY['day(event_ts)']\n)"
    )


def build_flush():
    watermark = node("Watermark", "CUSTOM.trino", 3, [-260, 300], {
        "query": FLUSH_WATERMARK_SQL,
        "timeout": 900,
        "timeZone": "Europe/Moscow",
    }, credentials=copy.deepcopy(DLH_TRINO_CRED))

    # Разбор ответа Trino отдельным узлом: см. FLUSH_WATERMARK_JS. Пустой
    # или неожиданный ответ обязан ронять прогон, а не превращаться в 0.
    read_wm = node("Read watermark", "n8n-nodes-base.code", 2, [-40, 300], {
        "jsCode": FLUSH_WATERMARK_JS,
    })

    # Условие зависит от режима записи, и это не стилистика:
    #   merge  — `gte`: перезалив краевой строки идемпотентен, зато строки
    #            с тем же миллисекундным ingested_at, не попавшие в упавший
    #            чанк, не потеряются молча;
    #   insert — `gt`: при `gte` краевая строка дублировалась бы КАЖДЫЙ час.
    #
    # Фильтр по числовой колонке — то же предположение, что и имена параметров
    # CUSTOM.trino: в остальном сборщике Data Table фильтровали только `eq`
    # (Write event, Read log в Collector Tracker), поэтому это первое
    # использование сравнения в проекте и оно требует проверки после импорта.
    read_new = node("Read new events", "n8n-nodes-base.dataTable", 1, [200, 300], {
        "operation": "get",
        "dataTableId": {"__rl": True, "value": TABLE, "mode": "name"},
        "returnAll": True,
        "filters": {"conditions": [{
            "keyName": "ingested_at",
            "condition": "gte" if DLH_WRITE_MODE == "merge" else "gt",
            "keyValue": "={{ $json.wm_ms }}",
        }]},
        "options": {},
    })

    build_sql = node("Build batch", "n8n-nodes-base.code", 2, [420, 300], {
        "jsCode": flush_build_sql_js(),
    })

    has_rows = node("Any new rows", "n8n-nodes-base.if", 2.2, [640, 300], {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": "not-empty",
                "leftValue": "={{ $json.empty }}",
                "rightValue": False,
                "operator": {"type": "boolean", "operation": "false", "singleValue": True},
            }],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    })

    # Нода выполняется по разу на входной элемент, то есть по разу на чанк.
    # Чанки идут по возрастанию ingested_at, поэтому падение на середине
    # оставляет в DLH консистентный префикс, а не дыру.
    write = node("Write batch", "CUSTOM.trino", 3, [880, 220], {
        "query": "={{ $json.sql }}",
        "timeout": 900,
        "timeZone": "Europe/Moscow",
    }, credentials=copy.deepcopy(DLH_TRINO_CRED))

    nodes = [
        node("Every hour", "n8n-nodes-base.scheduleTrigger", 1.2, [-460, 300], {
            "rule": {"interval": [{"field": "hours", "hoursInterval": 1}]},
        }),
        watermark, read_wm, read_new, build_sql, has_rows, write,
    ]
    conn = {}
    conn.update(chain("Every hour", "Watermark", "Read watermark",
                      "Read new events", "Build batch", "Any new rows"))
    # Ложная ветка (батч пуст) никуда не ведёт: заливать нечего.
    conn["Any new rows"] = {"main": [
        [{"node": "Write batch", "type": "main", "index": 0}],
        [],
    ]}
    return wf("Telemetry · Flush", nodes, conn)


def print_schema():
    print(f"Таблица Data Tables: {TABLE}")
    print("Завести колонки в UI n8n (тип колонки потом не меняется):\n")
    for name, type_, why in SCHEMA:
        print(f"  {name:<14} {type_:<8} — {why}")
    print("\nВсего колонок:", len(SCHEMA))
    print("\nЛимит всех Data Tables инстанса — 200 MiB по умолчанию")
    print("(N8N_DATA_TABLES_MAX_SIZE_BYTES). При ~156 обращениях в месяц и")
    print("~6 событиях на обращение это порядка 1 МБ в год — запас большой,")
    print("но перенос в DLH всё равно нужен: Data Tables не для аналитики.")


def print_ddl():
    print("-- Таблица DLH для Telemetry Flush. Создаётся РУКАМИ; сборщик её")
    print("-- не создаёт, но состав колонок держит здесь: MERGE обязан ей")
    print("-- соответствовать, а разъезжаются они молча.")
    print(f"-- Режим записи: {DLH_WRITE_MODE}; тип колонок времени: {DLH_TS_TYPE}")
    print()
    print(dlh_ddl())
    if DLH_WRITE_MODE == "merge":
        print("\n-- MERGE требует прав на запись И обновление строк. Если их нет:")
        print("--   DLH_WRITE_MODE=insert python3 build_telemetry_flows.py")
        print("-- и тогда дубли по event_id ОБЯЗАН снимать пересчёт витрины.")


def main():
    if "--print-schema" in sys.argv:
        print_schema()
        return
    if "--print-ddl" in sys.argv:
        print_ddl()
        return

    for path, builder in (
        (DST_INGEST, build_ingest),
        (DST_COLLECTOR, build_collector),
        (DST_BACKFILL, build_backfill),
        (DST_TRACKER, build_collector_tracker),
        (DST_FEEDBACK, build_feedback),
        (DST_REPORT, build_report),
        (DST_FLUSH, build_flush),
    ):
        data = builder()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"OK {path} — {len(data['nodes'])} нод")
        for n in data["nodes"]:
            print(f"  - {n['name']}")

    print("\nПроверить: node test_telemetry.mjs")

    print("\n" + "=" * 66)
    if INGEST_ID.startswith("__"):
        print("ВНИМАНИЕ: в Collector и Backfill плейсхолдер id Ingest.")
        print("Импортировать Telemetry Ingest.json, взять id и пересобрать:")
        print("  INGEST_WORKFLOW_ID=<id> python3 build_telemetry_flows.py")
    if not CHANNEL_ID:
        print("\nВНИМАНИЕ: CHANNEL_ID пуст.")
        print("postedFilters не действует на реакции — в лог попадут реакции из")
        print("ВСЕХ каналов бота, включая канал черновиков. Узнать id канала:")
        print("  GET /api/v4/teams/name/tinkoff/channels/name/" + CHANNEL_LISTEN)
        print("  затем: CHANNEL_ID=<id> python3 build_telemetry_flows.py")
    if FEEDBACK_WEBHOOK_URL.startswith("__"):
        print("\nВНИМАНИЕ: FEEDBACK_WEBHOOK_URL не задан.")
        print("Кнопки под ответом бота будут вести в никуда и молча не сработают.")
        print("Импортировать Feedback Webhook.json, взять Production URL и пересобрать")
        print("ОБА сборщика — телеметрии и бота:")
        print("  FEEDBACK_WEBHOOK_URL=<url> python3 build_telemetry_flows.py")
        print("  cd ../bot && FEEDBACK_WEBHOOK_URL=<url> python3 build_time_flows.py")
    if not BOT_USER_IDS:
        print("\nВНИМАНИЕ: BOT_USER_IDS пуст.")
        print("Реакции ботов попадут в лог как действия дежурного, и reaction")
        print("time будет занижен. Заполнить в build_telemetry_flows.py.")
    print("\n" + "=" * 66)
    cond = "gte" if DLH_WRITE_MODE == "merge" else "gt"
    print(f"Telemetry Flush: режим {DLH_WRITE_MODE}, колонки времени {DLH_TS_TYPE},")
    print(f"чанк ≤ {FLUSH_MAX_ROWS} строк / {FLUSH_MAX_CHARS} символов SQL.")
    print("\nВНИМАНИЕ: три вещи в нём НЕ подтверждены живым прогоном.")
    print("1. Имена полей ноды CUSTOM.trino (query/timeout/timeZone). После")
    print("   импорта открыть Watermark и Write batch: если Query/Timeout/Time")
    print("   Zone в UI пустые — ключи угаданы неверно, править build_flush().")
    print(f"2. Условие '{cond}' в фильтре Data Table по ingested_at — первое")
    print("   сравнение в проекте (везде был eq). Ошибка ноды = заменить на")
    print("   доступное в UI и подставить в build_flush().")
    if DLH_WRITE_MODE == "merge":
        print("3. Права на MERGE в usr_cross_data. Нет прав — пересобрать:")
        print("     DLH_WRITE_MODE=insert python3 build_telemetry_flows.py")
        print("   и тогда дубли по event_id ОБЯЗАН снимать пересчёт витрины:")
        print("   ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingested_at DESC).")
    else:
        print("3. РЕЖИМ insert: прогон НЕ идемпотентен. Повторный backfill даёт")
        print("   новый ingested_at на той же строке, и она уезжает в DLH второй")
        print("   раз. Пересчёт витрины ОБЯЗАН дедуплицировать по event_id.")
    print("\nСхема лога:    python3 build_telemetry_flows.py --print-schema")
    print("DDL в DLH:     python3 build_telemetry_flows.py --print-ddl")


if __name__ == "__main__":
    main()
