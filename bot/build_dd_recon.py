#!/usr/bin/env python3
"""Сборщик «DD Recon.json» — одноразовая разведка каталога под реестр отчётов.

Запуск: cd bot && python3 build_dd_recon.py

ЗАЧЕМ ЭТОТ ВОРКФЛОУ СУЩЕСТВУЕТ

Половина канала (11 обращений из 49 по фидбеку аналитика 2026-08-26) решается
одной строкой «отчёт называется так-то, владелец такой-то». Решение принято:
владельцы тянутся из DD, а в git остаётся только мост «ключ ссылки Proteus →
dd_urn» — он не протухает, меняется то, что лежит по URN.

Мост построить нечем: связи между ключом ссылки Proteus (/dashboard/23466/,
/dashboard/p/el8AZBZX5Zv/, /dashboard/employee_ambassadorship/) и ключом
объекта в DD у нас нет ни одной пары. Руками её не добыть — а без неё код
матчинга в «Plan» будет работать по пустой таблице, то есть не работать вовсе.

Этот воркфлоу добывает пары машинно и отвечает на два вопроса разом:

  ФАЗА A. Где у отчёта лежит владелец. Пять запросов по одному отчёту.
          entityFields НЕ используется: с 2026-08-24 он не отдаёт ни summary,
          ни attributes — ни у отчётов, ни у колонок (см. AGENTS.md).

  ФАЗА B и ФАЗА F — УДАЛЕНЫ, обе были несостоятельны. Записано, чтобы
          никто не собрал их заново:

          B шла ОТ ВИТРИН через связь `notes`. Прогон 2026-08-27: 0 пар
          из 1782, все проверенные — ноутбуки Helicopter. Причина
          конструктивная: `notes` по построению отдаёт тип NOTE, а дашборды
          Proteus это REPORT, и ни одна из двенадцати связей таблицы REPORT
          не отдаёт. Пути от витрины к дашборду в каталоге нет.

          F перечисляла отчёты пагинацией по /search/query с фильтром
          `systemType: reports`. Технически работала — 100 дашбордов
          из 100, offset отдавал новые страницы. Бесполезна по существу:
          в каталоге лежат отчёты ВСЕХ команд компании, это десятки тысяч,
          разреза по домену у нас нет, и первая тысяча — произвольный срез,
          в котором наших ключей почти наверняка нет. Мост вышел бы
          одновременно огромным и пустым.

          ЧТО ВМЕСТО НИХ. Пары «ключ ссылки → dd_urn» выписывает человек,
          который знает, какие отчёты нужны: их порядка тридцати, и это
          работа на час. Машинно то же делается поиском ПО НАЗВАНИЮ —
          по запросу на отчёт, а не перечислением каталога: прогон
          подтвердил, что {text: "Активность в GitLab"} первым же
          результатом отдаёт нужный URN. Хвост, которого нет в реестре,
          закрывается тем же поиском уже в момент ответа, со сверкой
          найденного по /link.

  ФАЗА B (удалена). Сам мост, оптом. Идём НЕ поиском по названиям, а со стороны витрин:
          у таблицы есть подтверждённый ключ связи `notes` — «ноутбуки и
          отчёты, читающие таблицу». Это /related/{key}, форма ответа известна
          и проверена живым запросом, в отличие от POST /search/query, тело
          которого (SearchRequest) не подтверждено ничем. По каждому найденному
          отчёту берём /link → ссылка Proteus → ключ ссылки. На выходе готовые
          строки таблицы «Отчёты Proteus» для kb/index.md.

  ФАЗА C. Один пробный POST /search/query — чтобы узнать форму тела и ответа.
          Мост от него не зависит: если он ответит 400, это не сломает прогон,
          а ответ сервера обычно и называет ожидаемые поля. Именно ради этого
          ответа проба и стоит в цепочке.

ПОЧЕМУ ОДНОРАЗОВЫЙ И ОТДЕЛЬНЫЙ ВОРКФЛОУ

Он ничего не решает в проде и ничего не вызывает: ручной триггер, только GET
плюс одна проба POST. Держать разведку внутри рабочего конвейера значило бы
платить за неё на каждом обращении. Сделает своё дело — удаляется, как удалена
неподключённая нода «HTTP Request» из «Support Bot DD» (см. build_dd_flow.py).

ЧТО СДЕЛАТЬ ПОСЛЕ ПРОГОНА

1. Открыть ноду «Shape recon» — там сказано, где у отчёта лежит владелец
   и в каком поле искать. Сверить с эталоном: фидбек даёт готовые пары
   «отчёт → кого тегает аналитик», они напечатаны в том же выводе.
2. Открыть ноду «Build bridge» — там готовые строки `| ключ | dd_urn |`
   и число, сколько ключей из фидбека нашлось. Вставить в kb/index.md.
3. Открыть ноду «Search probe» — форма тела и ответа /search/query.
"""

import copy
import json
import os
import re

OUT = "DD Recon.json"
REGISTRY_PATHS = ("../executive-support/kb/index.md", "../kb/index.md")

# Credential и опции HTTP берём из собранного «DD Lookup»: один Service Account
# на все воркфлоу — то самое свойство, которое 2026-08-27 разъехалось молча
# и уронило бы разом и каталог, и чтение статей. Отдельная константа здесь
# завела бы четвёртое место, где он живёт.
SRC = "DD Lookup.json"
if not os.path.exists(SRC):
    raise SystemExit(
        f"нет {SRC} — сначала python3 build_dd_flow.py: credential и опции "
        f"HTTP берутся оттуда, а не дублируются здесь"
    )
_src = json.load(open(SRC, encoding="utf-8"))
_probe = next(
    (n for n in _src["nodes"] if n.get("type") == "n8n-nodes-base.httpRequest"), None
)
if _probe is None:
    raise SystemExit(f"в {SRC} не нашлось ни одной HTTP-ноды — сборка невозможна")
DP_CRED = copy.deepcopy(_probe["credentials"])
DD_OPTS = copy.deepcopy(_probe["parameters"]["options"])

# Общий пролог обеих фаз моста: эталон из фидбека плюс разбор ссылки.
# Один на две фазы намеренно — копия разъехалась бы молча, а разбор ключа
# обязан совпадать с reportSlug() в «Plan» ядра до символа.
COMMON_RECON_JS = """
const FEEDBACK = __FEEDBACK__;
const NO_KEY = __NO_KEY__;

const reportSlug = (url) => {
  const path = String(url ?? '').split('?')[0].split('#')[0];
  const segs = path.split('/').filter(Boolean).filter((s) => !/^https?:$/.test(s));
  const skip = new Set(['superset', 'dashboard', 'dashboards', 'p', 'list', 'view']);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!skip.has(segs[i].toLowerCase()) && !segs[i].includes('.')) return segs[i];
  }
  return '';
};

const urlsOf = (v, out) => {
  if (v === null || v === undefined) return out;
  if (typeof v === 'string') {
    for (const m of v.match(/https?:\\/\\/\\S+/g) || []) out.push(m.replace(/[),.;"']+$/, ''));
    return out;
  }
  if (typeof v === 'object') for (const x of Object.values(v)) urlsOf(x, out);
  return out;
};
"""


def with_common(js):
    """Подставляет общий пролог и эталон. Один вызов на обе фазы моста."""
    return (js.replace("__COMMON__", COMMON_RECON_JS)
              .replace("__FEEDBACK__", json.dumps(FEEDBACK_KEYS, ensure_ascii=False))
              .replace("__NO_KEY__", json.dumps(FEEDBACK_NO_KEY, ensure_ascii=False)))

BASE = "https://dd.t-tech.team/api/v3"

# ------------------------------------------------------- Trino для ФАЗЫ D
#
# Нода и credential берутся из собранного «Telemetry Flush», а не заводятся
# здесь константой: аккаунт и имена полей `CUSTOM.trino` уже подтверждены
# живым прогоном 2026-08-17, и вторая копия разъехалась бы с ними молча —
# ровно то, из-за чего 2026-08-27 один устаревший credential в забытом файле
# уронил бы разом каталог и чтение статей.
TRINO_SRC = "../telemetry/Telemetry Flush.json"
if not os.path.exists(TRINO_SRC):
    raise SystemExit(
        f"нет {TRINO_SRC} — сначала cd telemetry && python3 build_telemetry_flows.py: "
        f"нода Trino и её credential берутся оттуда, а не дублируются здесь"
    )
_flush = json.load(open(TRINO_SRC, encoding="utf-8"))
_tn = next(
    (n for n in _flush["nodes"] if n.get("type", "").lower().endswith("trino")), None
)
if _tn is None:
    raise SystemExit(f"в {TRINO_SRC} не нашлось ноды Trino — фазу D собрать не из чего")
TRINO_TYPE = _tn["type"]
TRINO_TV = _tn["typeVersion"]
TRINO_CRED = copy.deepcopy(_tn["credentials"])
TRINO_OPTS = {k: v for k, v in _tn["parameters"].items() if k != "query"}


# ------------------------------------------------------------------ реестр
def read_registry():
    """URN витрин и отчётов из kb/index.md.

    Список URN не дублируется в сборщике намеренно: он живёт в реестре, и
    скопированная сюда копия разъехалась бы с ним молча — ровно то правило,
    по которому состав полей не копируется из DD в статью.
    """
    at = next((p for p in REGISTRY_PATHS if os.path.exists(p)), None)
    if at is None:
        raise SystemExit("не найден реестр, искали: " + ", ".join(REGISTRY_PATHS))
    tables, reports = [], []
    for line in open(at, encoding="utf-8"):
        if not line.strip().startswith("|"):
            continue
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) < 6 or c[0] in ("id", "домен") or set(c[0]) <= {"-"}:
            continue
        urn = c[5]
        if not urn.startswith("urn:"):
            continue
        (tables if c[1] == "table" else reports if c[1] == "report" else []).append(urn)
    if not tables:
        raise SystemExit("в реестре не нашлось ни одной таблицы с dd_urn")
    if not reports:
        raise SystemExit(
            "в реестре нет ни одного отчёта с dd_urn — фазе A нечего разведывать"
        )
    return tables, reports


TABLE_URNS, REPORT_URNS = read_registry()
RECON_URN = REPORT_URNS[0]

# Ключи ссылок Proteus из фидбека аналитика 2026-08-26. Нужны РОВНО для одного:
# посчитать покрытие моста — сколько из них нашлось машинно. Сам мост строится
# из ответа каталога, а не из этого списка: список это эталон, а не источник.
FEEDBACK_KEYS = {
    "23466": "[CrossData] Центр развития Аватар",
    "28227": "[C&B] Выгрузка заявлений на компенсацию",
    "23003": "[CrossData] Лидерский снепшот",
    "14586": "[CROSS SD] Поддержка программы Приведи друга",
    "35005": "Активность в GitLab",
    "employee_ambassadorship": "Амбассадорство сотрудников",
    "YApDgAlG5gQ": "[CrossData] Центр развития «Крепкие лиды»",
    "DKpqdNQa51J": "Путь лида",
    "jQpM212k30X": "Календарь присутствия сотрудников",
    "mb5bg1qzp1l": "Мониторинг аллокаций",
}

# Отчёты из фидбека, у которых ключа ссылки нет вовсе: аналитик называл их
# по имени. Печатаются в отчёте прогона, чтобы было видно, что мост их
# не закроет и их придётся искать отдельно.
FEEDBACK_NO_KEY = [
    "Квоты и вакансии",
    "Юридические позиции сотрудника за период",
    "Справки и заявления (статистика)",
    "HR Executive Report",
]

# Эталон для сверки владельца: кого аналитик тегает по этим отчётам. Три пары
# достаточно — совпало, значит владельца берём из DD и в git не дублируем;
# не совпало, значит в DD технический владелец ноутбука, и владелец остаётся
# в git как исключение.
OWNER_REFERENCE = [
    ("[CrossData] Лидерский снепшот", "[Login79]"),
    ("Активность в GitLab", "Aliya Kolomeets"),
    ("Амбассадорство сотрудников", "s.kopytov"),
]


# -------------------------------------------------------------------- ноды
def node(name, type_, tv, pos, params, creds=None):
    n = {
        "parameters": params,
        "type": type_,
        "typeVersion": tv,
        "position": pos,
        "id": "recon-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
        "name": name,
    }
    if creds:
        n["credentials"] = copy.deepcopy(creds)
    return n


def get(name, url, pos, query=()):
    """GET к каталогу. onError = continueRegularOutput плюс neverError:
    404 по одному объекту не должен ронять прогон, где остальные ответили."""
    params = {
        "url": url,
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "devplatformApi",
        "options": copy.deepcopy(DD_OPTS),
    }
    if query:
        params["sendQuery"] = True
        params["queryParameters"] = {
            "parameters": [{"name": k, "value": v} for k, v in query]
        }
    n = node(name, "n8n-nodes-base.httpRequest", 4.4, pos, params, DP_CRED)
    n["onError"] = "continueRegularOutput"
    return n


def code(name, pos, js, run_once_for_all=True):
    params = {"jsCode": js}
    if run_once_for_all:
        params["mode"] = "runOnceForAllItems"
    return node(name, "n8n-nodes-base.code", 2, pos, params)


nodes = [node("Run recon", "n8n-nodes-base.manualTrigger", 1, [-280, 300], {})]

# ------------------------------------------------------------- ФАЗА A: отчёт
#
# Пять суб-ресурсов карточки отчёта. Именно суб-ресурсы, а не entityFields:
# 2026-08-24 живой прогон показал, что /entity/{urn}?entityFields=… перестал
# отдавать summary и attributes у ЛЮБОГО типа сущности — не только у отчётов,
# как думали 2026-08-13. Повторять тот запрос незачем, он уже проверен.
ENC_RECON = f"encodeURIComponent('{RECON_URN}')"
PHASE_A = [
    ("Recon related", "/related"),
    ("Recon summary", "/summary"),
    ("Recon attribute", "/attribute"),
    ("Recon markdown", "/markdown"),
    ("Recon link", "/link"),
]
x = -60
for i, (name, suffix) in enumerate(PHASE_A):
    nodes.append(
        get(name, f"={{{{ '{BASE}/entity/' + {ENC_RECON} + '{suffix}' }}}}",
            [x + i * 200, 120])
    )

SHAPE_RECON_JS = r"""
// Что вернули пять суб-ресурсов карточки отчёта и ГДЕ ЛЕЖИТ ВЛАДЕЛЕЦ.
//
// Это и есть вопрос, ради которого фаза A существует: если владелец приходит
// из каталога, в git его дублировать не нужно — он там протухнет молча, как
// протух бы список полей. Ответ читается глазами один раз, поэтому вывод
// сделан текстом, а не структурой.
const NAMES = __NAMES__;
// Прогон 2026-08-27: owner_hits оказался ПУСТ, хотя ответ владельца содержал.
// В /attribute у отчёта лежат report_developer, data_team, developers_team
// и support_channel — ни одно из них под прежний регексп не подходило,
// и разведка отрапортовала «владельца не видно», имея его на руках.
// Тихий отказ ровно того класса, от которого защищено всё остальное:
// искали по угаданному списку слов и приняли промах списка за факт.
const OWNER_RE = /владел|owner|steward|ответствен|responsible|автор|author|куратор|developer|разработ|team|команд|support|поддержк|maintain|contact|контакт/i;

const lines = [];
const owners = [];

// Значение атрибута DD — обёртка { type, data }. Без распаковки тип поля
// однажды уехал агенту строкой «[object Object]»: та же ошибка здесь сделала
// бы владельца нечитаемым.
const attrData = (v) => (v && typeof v === 'object' && 'data' in v ? v.data : v);
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '(undefined)' : s.length > 300 ? s.slice(0, 300) + '…' : s;
};

for (const name of NAMES) {
  let res;
  try {
    res = $(name).first().json;
  } catch (e) {
    lines.push(`${name}: узел не выполнялся`);
    continue;
  }
  const status = res?.statusCode ?? '(нет statusCode)';
  const body = res?.body ?? res;
  lines.push('');
  lines.push(`=== ${name} — HTTP ${status} ===`);
  if (status === 401) {
    // Отдельной строкой, а не общим «не то пришло»: 401 это истёкший Service
    // Account, и лечится он не правкой запроса.
    lines.push('истёк Service Account — обновить credential, запрос ни при чём');
    continue;
  }
  if (body === undefined || body === null || body === '') {
    lines.push('пустое тело');
    continue;
  }
  if (typeof body === 'string') {
    // HTML вместо JSON — это страница логина: followRedirects выключен
    // именно от этого, но если пришло, надо назвать причину, а не «странный
    // ответ».
    lines.push(/^\s*</.test(body)
      ? 'пришёл HTML, а не JSON — похоже на страницу логина'
      : short(body));
    continue;
  }
  const keys = Object.keys(body);
  lines.push('ключи верхнего уровня: ' + (keys.length ? keys.join(', ') : '(пусто)'));
  lines.push(short(body));

  // Ищем владельца ВЕЗДЕ, а не в угаданном заранее поле: имя ключа неизвестно,
  // и подобрать его перебором дороже, чем прочитать один раз глазами.
  const walk = (v, path) => {
    if (v === null || typeof v !== 'object') return;
    for (const [k, raw] of Object.entries(v)) {
      const here = path ? path + '.' + k : k;
      if (OWNER_RE.test(k)) owners.push(`${name}: ${here} = ${short(attrData(raw))}`);
      walk(raw, here);
    }
  };
  walk(body, '');
}

const head = [];
head.push('РАЗВЕДКА ОТЧЁТА ' + __RECON_URN__);
head.push('');
head.push(owners.length
  ? 'ВЛАДЕЛЕЦ НАЙДЕН ЗДЕСЬ:\n— ' + owners.join('\n— ')
  : 'ВЛАДЕЛЬЦА НЕ ВИДНО НИ В ОДНОМ ИЗ ПЯТИ ОТВЕТОВ. Это не значит, что его нет: '
    + 'ключ может называться иначе — прочитать тела ниже глазами. Если его там '
    + 'правда нет, владелец остаётся в git как исключение, и это ответ на '
    + 'вопрос, ради которого разведка делалась.');
head.push('');
head.push('СВЕРИТЬ С ЭТАЛОНОМ (кого аналитик тегает по этим отчётам):');
for (const [r, who] of __OWNER_REFERENCE__) head.push(`— ${r} → ${who}`);

return [{ json: { report: head.concat(lines).join('\n'), owner_hits: owners } }];
"""
nodes.append(
    code(
        "Shape recon",
        [x + len(PHASE_A) * 200, 120],
        SHAPE_RECON_JS
        .replace("__NAMES__", json.dumps([n for n, _ in PHASE_A], ensure_ascii=False))
        .replace("__RECON_URN__", json.dumps(RECON_URN, ensure_ascii=False))
        .replace("__OWNER_REFERENCE__", json.dumps(OWNER_REFERENCE, ensure_ascii=False)),
    )
)

# ------------------------------------------------------------- ФАЗА C: проба
#
# Стоит в цепочке ПОСЛЕ разведки и ДО моста: мост от неё не зависит, а ответ
# нужен для следующего шага работы — искать отчёты по названию мы всё равно
# будем, и знать форму тела дешевле один раз, чем гадать при каждой правке.
#
# Тело угадано: SearchRequest не подтверждён ничем. Это осознанно — 400 здесь
# полезнее молчания, потому что ответ сервера обычно называет ожидаемые поля,
# а neverError не даст ему уронить прогон, в котором мост уже собран.
SEARCH_BODY = {"query": OWNER_REFERENCE[1][0], "limit": 20}
nodes.append(
    node(
        "Search probe",
        "n8n-nodes-base.httpRequest",
        4.4,
        [x + (len(PHASE_A) + 1) * 200, 120],
        {
            "method": "POST",
            "url": f"{BASE}/search/query",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": json.dumps(SEARCH_BODY, ensure_ascii=False),
            "options": copy.deepcopy(DD_OPTS),
        },
        DP_CRED,
    )
)
nodes[-1]["onError"] = "continueRegularOutput"

# --------------------------------------------------------------- ФАЗА B: мост
#
# Ключ связи `notes` у таблицы — «ноутбуки и отчёты, читающие таблицу»
# (USES, dest_src). Он документирован и проверен, в отличие от поиска.
TABLES_JS = r"""
// По одному элементу на витрину реестра: следующая нода выполнится по разу
// на каждый. Split Out не нужен — Code и так отдаёт массив элементов.
return __TABLES__.map((urn) => ({ json: { table_urn: urn } }));
"""
nodes.append(
    code("Tables", [-60, 460],
         TABLES_JS.replace("__TABLES__", json.dumps(TABLE_URNS, ensure_ascii=False)))
)

nodes.append(
    get(
        "Notes of table",
        f"={{{{ '{BASE}/entity/' + encodeURIComponent($json.table_urn) + '/related/notes' }}}}",
        [140, 460],
        query=(("limit", "300"),),
    )
)

COLLECT_NOTES_JS = r"""
// Распаковка ответа /related/{key}.
//
// Элемент массива — это СВЯЗЬ, сама сущность вложена в entity. Первая версия
// шейпера колонок искала fqn на верхнем уровне и получала пустой инвентарь,
// который агент читал как «полей нет». Та же форма и здесь.
const MAX_NOTES = 60;

const nodesOf = (body) => {
  const arr = Array.isArray(body?.data) ? body.data
    : Array.isArray(body) ? body
    : Array.isArray(body?.content) ? body.content
    : [];
  return arr.map((it) => (it && it.entity ? it.entity : it)).filter(Boolean);
};

const seen = new Map();     // urn → { urn, fqn, tables: [] }
const problems = [];
let totalCount = 0;

const results = $input.all();
const tables = $('Tables').all().map((i) => i.json.table_urn);

results.forEach((item, idx) => {
  const table = tables[idx] ?? '(витрина ' + (idx + 1) + ')';
  const res = item.json ?? {};
  const status = res.statusCode ?? 0;
  const body = res.body ?? res;
  if (status && status !== 200) {
    // Названо витриной, а не «одна из витрин»: 404 значит, что ключа связи
    // notes у неё нет, а 403 — что нет доступа, и это разные починки.
    problems.push(`${table}: HTTP ${status}`);
    return;
  }
  if (typeof body?.totalCount === 'number') totalCount += body.totalCount;
  const got = nodesOf(body);
  if (!got.length) { problems.push(`${table}: связей notes не вернулось`); return; }
  for (const e of got) {
    const urn = String(e.urn ?? '');
    if (!urn) continue;
    if (!seen.has(urn)) seen.set(urn, { urn, fqn: String(e.fqn ?? ''), tables: [] });
    seen.get(urn).tables.push(table);
  }
});

const all = [...seen.values()];
// Потолок — на стоимость прогона: дальше по запросу /link на каждый отчёт.
// Обрезка НАЗЫВАЕТСЯ числом: молча урезанный мост выглядит как полный,
// и недостающие отчёты потом ищут руками, не зная, что они были.
const kept = all.slice(0, MAX_NOTES);
const dropped = all.length - kept.length;

return kept.map((n) => ({
  json: { ...n, _total_found: all.length, _dropped: dropped,
          _problems: problems, _total_count: totalCount },
}));
"""
nodes.append(code("Collect notes", [340, 460], COLLECT_NOTES_JS))

nodes.append(
    get(
        "Note link",
        f"={{{{ '{BASE}/entity/' + encodeURIComponent($json.urn) + '/link' }}}}",
        [540, 460],
    )
)

BRIDGE_JS = r"""
// Готовые строки таблицы «Отчёты Proteus» для kb/index.md.
//
// Мост — это ДВЕ колонки и только они: ключ ссылки и dd_urn. Ни названия,
// ни владельца: они приезжают из карточки DD в момент ответа и в git
// протухли бы молча — то же правило, по которому в статье не дублируется
// состав полей.
__COMMON__
// Ключ ссылки Proteus — тот же разбор, что в «Plan» ядра (reportSlug):
// /dashboard/23466/, /dashboard/p/el8AZBZX5Zv/, /dashboard/employee_ambassadorship/.
// Служебные сегменты пропускаем, иначе ключом стало бы слово «p».
const notes = $('Collect notes').all().map((i) => i.json);
const links = $input.all().map((i) => i.json);

const rows = [];      // { key, urn, url }
const noLink = [];
const notProteus = [];

// Пара «отчёт ↔ его ссылки» держится ИНДЕКСОМ: оба списка идут по одному
// и тому же порядку элементов, порядок n8n сохраняет. Ровно так же имя
// колонки берётся из «Pick columns» в DD Lookup — ни один из ответов
// каталога имени объекта не несёт.
notes.forEach((n, idx) => {
  const res = links[idx] ?? {};
  const status = res.statusCode ?? 0;
  const body = res.body ?? res;
  if (status && status !== 200) { noLink.push(`${n.urn}: HTTP ${status}`); return; }
  const urls = urlsOf(body, []);
  const proteus = urls.filter((u) => /proteus|superset/i.test(u));
  if (!urls.length) { noLink.push(`${n.urn}: ссылок нет`); return; }
  if (!proteus.length) { notProteus.push(`${n.urn}: ${urls[0]}`); return; }
  const key = reportSlug(proteus[0]);
  if (!key) { notProteus.push(`${n.urn}: ключ из ссылки не выделился — ${proteus[0]}`); return; }
  rows.push({ key, urn: n.urn, url: proteus[0], fqn: n.fqn });
});

// Один ключ у двух отчётов — это не мост, а развилка: матчинг в «Plan» взял бы
// первый попавшийся. Называем, а не схлопываем молча.
const byKey = new Map();
for (const r of rows) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}
const collisions = [...byKey].filter(([, v]) => v.length > 1)
  .map(([k, v]) => `${k} → ${v.map((r) => r.urn).join(' и ')}`);

const meta = notes[0] ?? {};
const covered = Object.keys(FEEDBACK).filter((k) => byKey.has(k));
const missing = Object.keys(FEEDBACK).filter((k) => !byKey.has(k));

const out = [];
out.push('МОСТ «ключ ссылки → dd_urn»: ' + byKey.size + ' пар из ' +
  (meta._total_found ?? 0) + ' отчётов и ноутбуков, читающих витрины реестра');
if (meta._dropped) {
  out.push('ПО ЛИМИТУ НЕ ПРОВЕРЯЛИСЬ: ' + meta._dropped + ' объектов.');
}
// Прогон 2026-08-27: 0 пар из 1782, и все 60 проверенных оказались ноутбуками
// Helicopter. Поднимать лимит бессмысленно — связь `notes` по построению
// возвращает сущности типа NOTE, а дашборды Proteus это тип REPORT.
// Мост через неё не собрать ни при каком лимите; см. фазу E.
if (!byKey.size) {
  out.push('');
  out.push('НИ ОДНОЙ ПАРЫ. Если среди проверенных только ноутбуки Helicopter —');
  out.push('дело НЕ в лимите: связь «notes» отдаёт сущности типа NOTE, а');
  out.push('дашборды Proteus это тип REPORT. Нужна другая связь либо поиск —');
  out.push('см. вывод ноды «Shape probes» (фаза E).');
}
if ((meta._problems ?? []).length) out.push('ВИТРИНЫ С ОШИБКОЙ: ' + meta._problems.join('; '));
out.push('');
out.push('ВСТАВИТЬ В kb/index.md, таблица «Отчёты Proteus»:');
out.push('');
out.push('| ключ ссылки | dd_urn |');
out.push('|---|---|');
for (const [key, v] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`| ${key} | ${v[0].urn} |`);
}
out.push('');
out.push('ПОКРЫТИЕ ЭТАЛОНА (ключи из фидбека аналитика): ' +
  covered.length + ' из ' + Object.keys(FEEDBACK).length);
for (const k of missing) out.push(`— НЕ НАЙДЕН: ${k} (${FEEDBACK[k]})`);
out.push('');
out.push('ОТЧЁТЫ ФИДБЕКА БЕЗ КЛЮЧА ССЫЛКИ — мост их не закроет, искать по имени:');
for (const n of NO_KEY) out.push(`— ${n}`);
if (collisions.length) {
  out.push('');
  out.push('ОДИН КЛЮЧ У НЕСКОЛЬКИХ ОБЪЕКТОВ — разобрать руками, матчинг возьмёт первый:');
  for (const c of collisions) out.push('— ' + c);
}
if (noLink.length) {
  out.push('');
  out.push('БЕЗ ССЫЛОК (' + noLink.length + '):');
  for (const s of noLink.slice(0, 30)) out.push('— ' + s);
}
if (notProteus.length) {
  out.push('');
  out.push('ССЫЛКИ ЕСТЬ, НО НЕ НА PROTEUS (' + notProteus.length + ') — это ноутбуки:');
  for (const s of notProteus.slice(0, 30)) out.push('— ' + s);
}

return [{ json: {
  report: out.join('\n'),
  rows: [...byKey].map(([key, v]) => ({ key, urn: v[0].urn, url: v[0].url })),
  covered, missing, collisions,
} }];
"""
nodes.append(
    code(
        "Build bridge",
        [740, 460],
        with_common(BRIDGE_JS),
    )
)

# ------------------------------------------------------------------- связи
#
# Строго ЦЕПОЧКА, без веера. В n8n нет неявного слияния: узел за развилкой
# выполняется по разу на каждую дошедшую ветвь, и разведённые фазы дали бы
# два прогона моста на один запуск.
# ------------------------------------- ФАЗА E: чего не хватило после прогона 1
#
# Прогон 2026-08-27 дал три результата, каждый меняет план:
#
#  1. ВЛАДЕЛЕЦ В КАТАЛОГЕ ЕСТЬ. В /attribute отчёта лежат report_developer,
#     data_team, developers_team, support_channel — просто прежний регексп
#     их не ловил. Починено выше, отдельной пробы не требует.
#
#  2. МОСТ ЧЕРЕЗ `notes` НЕ СОБРАТЬ. 0 пар из 1782, и все проверенные —
#     ноутбуки Helicopter. Связь `notes` по построению отдаёт тип NOTE,
#     а дашборды Proteus это тип REPORT: дело не в лимите. Значит надо
#     узнать, какая связь у ТАБЛИЦЫ отдаёт REPORT — и узнать, а не угадать.
#     Список ключей связей таблицы мы ни разу не запрашивали: он взят
#     из документации, и `notes` оттуда же.
#
#  3. ПОИСК ОТВЕЧАЕТ 200 И ИГНОРИРУЕТ ПОЛЕ `query`. Вернулись колонки чужих
#     схем — то есть выдача по умолчанию, без фильтра. Тело угадано неверно,
#     а 400 сервер не отдаёт, значит имя поля из ошибки не узнать. Поэтому
#     проб три: базовая без текста и две с разными именами поля. Если выдача
#     варианта отличается от базовой — имя поля найдено.
#
# Плюс `source_tables` у отчёта: этот ключ виден в ответе /related прогона 1
# и отвечает на вторую половину вопроса — на какой витрине построен отчёт.
ENC_TABLE0 = f"encodeURIComponent('{TABLE_URNS[0]}')"
PHASE_E_GET = [
    # Ключи связей У ТАБЛИЦЫ. До сих пор брались из документации.
    ("Table related", f"={{{{ '{BASE}/entity/' + {ENC_TABLE0} + '/related' }}}}"),
    # Отчёт → витрина, на которой он построен.
    ("Report sources",
     f"={{{{ '{BASE}/entity/' + {ENC_RECON} + '/related/source_tables' }}}}"),
]
for i, (nm, url) in enumerate(PHASE_E_GET):
    nodes.append(get(nm, url, [720 + i * 200, 800]))

# Три пробы поиска. Тело JSON, поле текста — вот что выясняем.
SEARCH_NAME = OWNER_REFERENCE[1][0]
# Прогон 2026-08-27 (второй): поле найдено — `text`. Осталось ОДНО:
# ищется ли отчёт по КЛЮЧУ ССЫЛКИ Proteus. Это решает, нужен ли мост вообще.
#
# Вывести URN из ссылки нельзя: у «Активности в GitLab» URN
# report:aktivnost-v-gitlab, а ключ ссылки 35005; у отчёта 1728 наоборот —
# URN числовой, ключ ссылки hr-executive-detail-employee. Связи между ними
# нет никакой, и подобрать её нечем.
#
# Поэтому две пробы по ключам двух РАЗНЫХ форм. Совпало — моста не нужно
# вовсе, бот ищет отчёт по ссылке из формы прямо в момент ответа. Не совпало —
# мост нужен, и собирается он перечислением отчётов через поиск.
PHASE_E_POST = [
    ("Search base", {"limit": 5}),
    ("Search text", {"text": SEARCH_NAME, "limit": 5}),
    ("Search searchText", {"searchText": SEARCH_NAME, "limit": 5}),
    # Ключ-слаг: так выглядит ссылка отчёта 1728.
    ("Search by slug", {"text": "hr-executive-detail-employee", "limit": 5}),
    # Ключ-число: так выглядит ссылка «Активности в GitLab».
    ("Search by id", {"text": "35005", "limit": 5}),
    # Перечисление отчётов. Форма фильтра — из спецификации OpenAPI, а не
    # угадана: SearchFilters это словарь «ключ → МАССИВ строк», и ключи
    # называются type / systemType / systemName. Первая версия этой пробы
    # посылала {"system": "reports", "type": "REPORT"} — неверно и по имени
    # ключа, и по форме значения, а сервер на такое отвечает 200 и молчит.
    #
    # Значения выводятся из URN: urn:dd:<systemType>:<systemName>:<type>:<id>.
    # У дашборда Proteus это reports / reports / report, у ноутбука —
    # reports / helicopter / note, у витрины — tables / greenplum / table.
    ("Search reports", {"text": "", "limit": 100,
                        "filters": {"systemType": ["reports"],
                                    "systemName": ["reports"],
                                    "type": ["REPORT"]}}),
    # Вторая страница: в SearchRequest есть offset, значит мост собирается
    # пагинацией за один прогон, а не руками. Проверяем, что offset работает
    # и вторая страница не повторяет первую.
    ("Search reports p2", {"text": "", "limit": 100, "offset": 100,
                           "filters": {"systemType": ["reports"],
                                       "systemName": ["reports"],
                                       "type": ["REPORT"]}}),
]
for i, (nm, body) in enumerate(PHASE_E_POST):
    n = node(
        nm, "n8n-nodes-base.httpRequest", 4.4, [720 + i * 200, 940],
        {
            "method": "POST",
            "url": f"{BASE}/search/query",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": json.dumps(body, ensure_ascii=False),
            "options": copy.deepcopy(DD_OPTS),
        },
        DP_CRED,
    )
    n["onError"] = "continueRegularOutput"
    n["executeOnce"] = True
    nodes.append(n)

SHAPE_PROBES_JS = r"""
// Фаза E: разбор пяти проб. Ничего не решает — печатает, что выяснилось.
const body = (name) => {
  let it;
  try { it = $(name).first().json; } catch (e) { return { miss: 'узел не выполнялся' }; }
  if (!it) return { miss: 'пусто' };
  if (it.error) return { miss: 'ОТКАЗ — ' + JSON.stringify(it.error).slice(0, 300) };
  const code = it.statusCode;
  const b = it.body !== undefined ? it.body : it;
  if (code !== undefined && code >= 400) return { miss: `HTTP ${code}` };
  return { b, code };
};
const out = [];
const say = (s) => out.push(s);
const short = (v) => JSON.stringify(v).slice(0, 500);

say('=== ФАЗА E: связи таблицы, источники отчёта, форма поиска ===');

// --- 1. какая связь у таблицы отдаёт REPORT
say('');
say('СВЯЗИ ТАБЛИЦЫ (до сих пор брали `notes` из документации):');
const tr = body('Table related');
if (tr.miss) say('  ' + tr.miss);
else {
  const keys = Object.keys(tr.b || {});
  say('  ключи: ' + keys.join(', '));
  const reportish = keys.filter((k) => {
    const t = ((tr.b[k] || {}).entity || {}).type || '';
    return /REPORT|DASHBOARD/i.test(t);
  });
  say(reportish.length
    ? '  ОТДАЮТ REPORT/DASHBOARD: ' + reportish.join(', ') +
      ' ← мост строить через них'
    : '  НИ ОДНА связь таблицы не отдаёт REPORT. Тогда от витрины к дашборду ' +
      'пути нет, и мост собирается только со стороны отчётов — через поиск.');
  for (const k of keys) {
    const e = (tr.b[k] || {}).entity || {};
    say(`  — ${k}: type=${e.type || '?'} system=${e.system || '?'}`);
  }
}

// --- 2. отчёт → витрина
say('');
say('ИСТОЧНИКИ ОТЧЁТА (source_tables):');
const rs = body('Report sources');
if (rs.miss) say('  ' + rs.miss);
else {
  const arr = Array.isArray(rs.b) ? rs.b : (rs.b || {}).data || [];
  say('  найдено: ' + arr.length);
  for (const x of arr.slice(0, 10)) {
    const e = x.entity || x;
    say(`  — ${e.fqn || e.urn || short(x)}`);
  }
  say(arr.length
    ? '  ← это и есть «на какой витрине построен отчёт», без git'
    : '  пусто: связь есть, но не заполнена — тогда витрину придётся ' +
      'держать в реестре рядом с ключом ссылки');
}

// --- 3. форма поиска
say('');
say('ПОИСК: какое поле несёт текст запроса');
const base = body('Search base');
const first = (r) => {
  if (r.miss) return r.miss;
  const arr = Array.isArray(r.b) ? r.b : (r.b || {}).data || [];
  return arr.length ? (arr[0].urn || short(arr[0])) : '(пусто)';
};
const fBase = first(base);
say('  Search base {limit}          → ' + fBase);
for (const nm of ['Search text', 'Search searchText']) {
  const f = first(body(nm));
  const field = nm.replace('Search ', '');
  say(`  {${field}: "<название>"}  → ` + f);
  if (!body(nm).miss) {
    say(f !== fBase
      ? `    ← ВЫДАЧА ОТЛИЧАЕТСЯ: поле «${field}» РАБОТАЕТ, тело поиска найдено`
      : `    ← выдача та же, что без текста: поле «${field}» игнорируется`);
  }
}

// --- 4. ищется ли отчёт по ключу ссылки: от этого зависит, нужен ли мост
say('');
say('ПОИСК ПО КЛЮЧУ ССЫЛКИ (нужен ли мост вообще):');
const urns = (name) => {
  const r = body(name);
  if (r.miss) return null;
  const arr = Array.isArray(r.b) ? r.b : (r.b || {}).data || [];
  return arr.map((x) => String(x.urn || (x.entity || {}).urn || ''));
};
for (const [nm, key, want] of [
  ['Search by slug', 'hr-executive-detail-employee', 'report:1728'],
  ['Search by id', '35005', 'aktivnost-v-gitlab'],
]) {
  const u = urns(nm);
  if (!u) { say(`  {text: "${key}"} → ` + body(nm).miss); continue; }
  const hit = u.find((x) => x.includes(want));
  say(`  {text: "${key}"} → ` + (u[0] || '(пусто)'));
  say(hit
    ? `    ← НАЙДЕН нужный отчёт (${hit}). Мост не нужен: бот ищет отчёт `
      + 'по ссылке из формы прямо в момент ответа'
    : '    ← нужного отчёта в выдаче НЕТ. Значит по ключу ссылки не ищется, '
      + 'и мост нужен: перечислить отчёты поиском, у каждого взять /link');
}

const rep = urns('Search reports');
const rep2 = urns('Search reports p2');
say('');
say('ПЕРЕЧИСЛЕНИЕ ОТЧЁТОВ (собирается ли мост одним прогоном):');
if (!rep) say('  ' + body('Search reports').miss);
else {
  const onlyReports = rep.filter((x) => /:reports:reports:report:/.test(x));
  say(`  страница 1: вернулось ${rep.length}, из них дашбордов Proteus: ${onlyReports.length}`);
  say(onlyReports.length === rep.length && rep.length > 0
    ? '  ← фильтр по systemType/systemName/type РАБОТАЕТ'
    : '  ← фильтр не сработал: в выдаче не только дашборды. Отсекать придётся '
      + 'на нашей стороне, по полям system и type каждой карточки');
  if (rep2) {
    const fresh = rep2.filter((x) => !rep.includes(x));
    say(`  страница 2 (offset 100): вернулось ${rep2.length}, новых ${fresh.length}`);
    say(fresh.length
      ? '  ← offset РАБОТАЕТ: мост собирается пагинацией за один прогон'
      : '  ← вторая страница повторяет первую либо пуста: если отчётов меньше '
        + '100, это норма, иначе offset не работает и перечислять нечем');
  }
}

say('');
say('Тело SearchRequest подтверждено спецификацией OpenAPI:');
say('  text · limit(20) · offset(0) · filters · sessionId · requestId');
say('  filters — словарь «ключ → МАССИВ строк»: type, systemType, systemName.');
say('Поле searchText в /search/query не существует вовсе — оно принадлежит');
say('другой ручке, /search/facets/{facetKey}/filters. Отсюда и молчание:');
say('сервер отвечает 200 на любое тело и о неизвестных полях не сообщает.');

return [{ json: { probes: out.join('\n') } }];
"""

nodes.append(code("Shape probes", [1380, 870], SHAPE_PROBES_JS))

# ------------------------------------------ ФАЗА F: мост со стороны отчётов
#
# Прогон 2026-08-27 (второй) закрыл последний вопрос, и ответ отрицательный:
# по ключу ссылки отчёт НЕ ищется. `{text: "hr-executive-detail-employee"}`
# вернул пусто, `{text: "35005"}` — чужую таблицу. Значит мост нужен.
#
# Зато он теперь СОБИРАЕТСЯ, чего не было в фазе B: фильтр по
# systemType/systemName/type отдал 100 дашбордов из 100, а offset дал вторую
# страницу целиком из новых. То есть отчёты перечисляются пагинацией,
# у каждого берётся /link, и мост получается за один прогон.
#
# Почему это не повтор фазы B: там шли ОТ ВИТРИН через связь `notes`, и это
# было обречено — ни одна из двенадцати связей таблицы не отдаёт REPORT.
# Здесь идём от самих отчётов, минуя витрины вовсе.
MAX_PAGES = 10          # 10 × 100 = 1000 отчётов
PAGE_SIZE = 100
REPORT_FILTERS = {"systemType": ["reports"],
                  "systemName": ["reports"],
                  "type": ["REPORT"]}

PAGES_JS = """
// По элементу на страницу: следующая нода выполнится по разу на каждый.
return Array.from({ length: __MAX_PAGES__ }, (_, i) => ({
  json: { offset: i * __PAGE_SIZE__, limit: __PAGE_SIZE__ },
}));
"""
nodes.append(
    code(
        "Report pages",
        [-60, 1100],
        PAGES_JS.replace("__MAX_PAGES__", str(MAX_PAGES))
                .replace("__PAGE_SIZE__", str(PAGE_SIZE)),
    )
)

_search_page = node(
    "Search page", "n8n-nodes-base.httpRequest", 4.4, [160, 1100],
    {
        "method": "POST",
        "url": f"{BASE}/search/query",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "devplatformApi",
        "sendBody": True,
        "specifyBody": "json",
        # Тело собирается выражением: offset приходит из «Report pages».
        "jsonBody": "={{ JSON.stringify({ text: '', limit: $json.limit, "
                    "offset: $json.offset, filters: "
                    + json.dumps(REPORT_FILTERS, ensure_ascii=False)
                    + " }) }}",
        "options": copy.deepcopy(DD_OPTS),
    },
    DP_CRED,
)
_search_page["onError"] = "continueRegularOutput"
nodes.append(_search_page)

COLLECT_REPORTS_JS = """
// Склейка страниц в один список отчётов.
//
// Дубли между страницами возможны, если выдача не стабильна между запросами,
// — схлопываем по urn и называем числом. Молча схлопнутый дубль означал бы,
// что пагинация врёт, а мы этого не заметили.
const pages = $input.all().map((i) => i.json);
const seen = new Map();
let dropped = 0;
let lastPageSize = 0;
let failed = 0;

for (const p of pages) {
  const status = p.statusCode ?? 0;
  if (status && status !== 200) { failed++; continue; }
  const arr = Array.isArray(p.body) ? p.body : (p.body || {}).data || [];
  lastPageSize = arr.length;
  for (const c of arr) {
    const urn = String(c.urn || '');
    if (!urn) continue;
    if (seen.has(urn)) { dropped++; continue; }
    seen.set(urn, { urn, fqn: c.fqn || '', name: c.displayName || '' });
  }
}

const all = [...seen.values()];
// Последняя страница пришла полной — значит отчётов больше, чем мы забрали.
// Сказать об этом обязательно: иначе неполный мост читается как полный.
const truncated = lastPageSize >= __PAGE_SIZE__;
return all.map((r, i) => ({
  json: { ...r, _total: all.length, _dropped: dropped,
          _failed: failed, _truncated: truncated && i === 0 },
}));
"""
nodes.append(
    code("Collect reports", [360, 1100],
         COLLECT_REPORTS_JS.replace("__PAGE_SIZE__", str(PAGE_SIZE)))
)

nodes.append(
    get("Report link2",
        f"={{{{ '{BASE}/entity/' + encodeURIComponent($json.urn) + '/link' }}}}",
        [560, 1100])
)

BRIDGE2_JS = "__COMMON__\n" + r"""
const reports = $('Collect reports').all().map((i) => i.json);
const links = $input.all().map((i) => i.json);
const meta = reports[0] || {};

const rows = [];
const noLink = [];
const notProteus = [];

// Пара «отчёт ↔ его ссылки» держится ИНДЕКСОМ, как и в фазе B: оба списка
// идут по одному порядку элементов, и порядок n8n сохраняет.
reports.forEach((r, idx) => {
  const res = links[idx] ?? {};
  const status = res.statusCode ?? 0;
  const body = res.body ?? res;
  if (status && status !== 200) { noLink.push(`${r.urn}: HTTP ${status}`); return; }
  const urls = urlsOf(body, []);
  const proteus = urls.filter((u) => /proteus|superset/i.test(u));
  if (!proteus.length) { notProteus.push(`${r.urn}: ${urls[0] || 'ссылок нет'}`); return; }
  const key = reportSlug(proteus[0]);
  if (!key) { notProteus.push(`${r.urn}: ключ не выделился — ${proteus[0]}`); return; }
  rows.push({ key, urn: r.urn, name: r.name, url: proteus[0] });
});

// Один ключ у двух отчётов — развилка, а не мост: матчинг в «Plan» взял бы
// первый попавшийся. Называем, а не схлопываем молча.
const byKey = new Map();
for (const r of rows) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}
const collisions = [...byKey].filter(([, v]) => v.length > 1);

const out = [];
out.push('МОСТ СО СТОРОНЫ ОТЧЁТОВ (фаза F)');
out.push(`отчётов перечислено: ${meta._total ?? 0}` +
  (meta._dropped ? `, дублей между страницами: ${meta._dropped}` : '') +
  (meta._failed ? `, страниц с ошибкой: ${meta._failed}` : ''));
if (meta._truncated) {
  out.push('ПОСЛЕДНЯЯ СТРАНИЦА ПРИШЛА ПОЛНОЙ — отчётов больше, чем забрали.');
  out.push('Поднять MAX_PAGES в build_dd_recon.py и прогнать ещё раз;');
  out.push('иначе мост неполный, а выглядит полным.');
}
out.push(`пар «ключ → urn»: ${byKey.size}`);
if (noLink.length) out.push(`без ссылки: ${noLink.length}`);
if (notProteus.length) out.push(`ссылка не на Proteus: ${notProteus.length}`);
if (collisions.length) {
  out.push('');
  out.push('ОДИН КЛЮЧ У НЕСКОЛЬКИХ ОТЧЁТОВ — разобрать руками:');
  for (const [k, v] of collisions) out.push(`— ${k}: ${v.map((x) => x.urn).join(', ')}`);
}

out.push('');
out.push('ПОКРЫТИЕ ЭТАЛОНА (ключи из фидбека аналитика):');
const covered = [];
const missing = [];
for (const [k, title] of Object.entries(FEEDBACK)) {
  (byKey.has(k) ? covered : missing).push(`${k} (${title})`);
}
out.push(`  нашлось ${covered.length} из ${covered.length + missing.length}`);
for (const c of covered) out.push('  + ' + c);
for (const m of missing) out.push('  — НЕ НАЙДЕН: ' + m);

out.push('');
out.push('ВСТАВИТЬ В kb/index.md, таблица «Отчёты Proteus»:');
out.push('');
out.push('| ключ ссылки | dd_urn |');
out.push('|---|---|');
for (const [key, v] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`| ${key} | ${v[0].urn} |`);
}

return [{ json: {
  report: out.join('\n'),
  rows: [...byKey].map(([key, v]) => ({ key, urn: v[0].urn, name: v[0].name })),
  covered, missing, collisions: collisions.length,
} }];
"""
nodes.append(code("Build bridge2", [760, 1100], with_common(BRIDGE2_JS)))

# --------------------------------------------------- ФАЗА D: значения полей
#
# ЗАЧЕМ. Инвентарь полей мы берём из каталога, но перечня УНИКАЛЬНЫХ ЗНАЧЕНИЙ
# поля в DD нет — подтверждено владельцем задачи. А без него бот не может
# закрыть типовой случай: заказчик говорит «BI-аналитики», фильтровать надо
# по emp_specialization_desc, и какое там значение — «Бизнес-аналитик BI»,
# «Аналитик BI» или иное — из каталога не видно. Живой прогон 2026-08-27
# на этом и остановился: поле бот назвал верно, значение — нет.
#
# Значения можно достать только запросом к данным. Нода CUSTOM.trino в проекте
# уже есть и работает (телеметрия, прогон 2026-08-17), но три вещи неизвестны,
# и все три — блокеры для стройки:
#
#   1. видит ли аккаунт 128 HR-витрины: он заведён под dl.usr_cross_data,
#      а витрины лежат в prod_v_emart, и каталог Trino для них неизвестен;
#   2. какая у поля кардинальность — 50 значений или 5000: от этого зависит,
#      нужен ли потолок и какой;
#   3. КАК ВЫГЛЯДИТ ОТКАЗ по недоступной таблице. Это главное. Часть витрин
#      до Trino ещё не доехала, и «витрины здесь нет» обязано отличаться
#      от «таких значений нет» — слитые в один диагноз, они отправят чинить
#      не то, ровно как ddFailed и ddMissing до 2026-08-27.
#
# Поэтому проб три, и третья — НАМЕРЕННЫЙ ПРОМАХ по несуществующей таблице:
# без него форму отказа взять неоткуда, а угадывать её в коде значит написать
# разбор, который не сработает ни разу и будет выглядеть рабочим.
#
# Все три с onError, как и запросы к каталогу: фаза D не должна ронять прогон,
# ради которого воркфлоу написан, — мост отчётов собирается раньше неё.
VALUES_TABLE = "prod_v_emart.mdm_employee_structure_d"
VALUES_FIELD = "emp_specialization_desc"
PHASE_D = [
    # Список каталогов: если запрос к витрине упадёт «table not found»,
    # правильный префикс ищется здесь, а не подбором.
    ("Probe catalogs", "SHOW CATALOGS"),
    # Сам вопрос. Срез канонический (last_day_flg = 1): без него это скан
    # витрины «сотрудник × день» по всей истории. count(*) нужен не меньше
    # значений — по нему видно, какие варианты рабочие, а какие единичны.
    (
        "Probe values",
        f"SELECT {VALUES_FIELD}, count(*) AS cnt\n"
        f"FROM {VALUES_TABLE}\n"
        f"WHERE last_day_flg = 1\n"
        f"GROUP BY 1 ORDER BY 2 DESC LIMIT 200",
    ),
    # Промах: таблицы с таким именем нет и не будет.
    (
        "Probe missing",
        f"SELECT 1 FROM {VALUES_TABLE}__zz_recon_probe_no_such_table LIMIT 1",
    ),
]
for i, (nm, sql) in enumerate(PHASE_D):
    n = node(nm, TRINO_TYPE, TRINO_TV, [720 + i * 220, 620],
             {"query": sql, **copy.deepcopy(TRINO_OPTS)}, TRINO_CRED)
    n["onError"] = "continueRegularOutput"
    # ПО РАЗУ НА ПРОГОН, а не на каждый входной элемент. Узлы стоят цепочкой,
    # и «SHOW CATALOGS» вернул 4 строки — без этого следующая проба выполнилась
    # бы четырежды и отдала 800 строк вместо 200. Цифра при этом выглядит
    # правдоподобно и читается как кардинальность поля, хотя ей не является:
    # прогон 2026-08-27 ровно так и прочитали сначала.
    n["executeOnce"] = True
    nodes.append(n)

SHAPE_VALUES_JS = r"""
// Разбор трёх проб Trino. Ничего не решает — печатает, что удалось узнать,
// чтобы решение принял человек.
const look = (name) => {
  try { return $(name).all().map((x) => x.json); } catch (e) { return null; }
};
const out = [];
const say = (s) => out.push(s);

const describe = (name) => {
  const items = look(name);
  if (items === null) return `${name}: узел не выполнялся`;
  if (!items.length) return `${name}: ноль элементов`;
  const first = items[0] || {};
  // n8n при onError кладёт текст отказа в поле error элемента.
  const err = first.error || first.message || (first.json && first.json.error);
  if (err) return `${name}: ОТКАЗ — ${JSON.stringify(err).slice(0, 600)}`;
  return `${name}: ${items.length} строк, ключи первой: ` +
    Object.keys(first).join(', ') + '\n  первая строка: ' +
    JSON.stringify(first).slice(0, 400);
};

say('=== ФАЗА D: значения полей через Trino ===');
say('');
for (const n of ['Probe catalogs', 'Probe values', 'Probe missing']) say(describe(n));

say('');
say('');
say('ВНИМАНИЕ: число строк «Probe values» упирается в LIMIT запроса и НЕ равно');
say('числу разных значений поля. Кардинальность этим прогоном не измеряется —');
say('если строк ровно столько, сколько в LIMIT, значений может быть больше.');
say('');
say('ЧТО С ЭТИМ ДЕЛАТЬ:');
say('— «Probe values» вернул строки → аккаунт видит витрину, и значения');
say('  можно тянуть. Посмотрите число разных значений: от него зависит,');
say('  нужен ли потолок в шейпере и какой.');
say('— «Probe values» отказал, а «Probe catalogs» вернул список → дело');
say('  в префиксе каталога. Возьмите нужный из списка и перепишите');
say('  VALUES_TABLE в build_dd_recon.py, прогон повторить.');
say('— Сравните текст отказа «Probe values» с «Probe missing». Если они');
say('  РАЗНЫЕ — значит недоступную витрину можно отличить от пустого');
say('  результата, и это то, на чём будет стоять диагностика в DD Lookup.');
say('  Если ОДИНАКОВЫЕ — отличить нельзя, и тогда список доступных витрин');
say('  придётся держать явно, со всеми издержками копии.');

return [{ json: { values_recon: out.join('\n') } }];
"""

nodes.append(code("Shape values", [1380, 620], SHAPE_VALUES_JS))


# ---------------------------------------------------------------- ФАЗА G
#
# НАСТОЯЩИЕ URN ВИТРИН — ИЩУТСЯ ПО ИМЕНИ, А НЕ СОБИРАЮТСЯ ПО СХЕМЕ.
#
# В реестре двадцать витрин, и живым запросом подтверждена ОДНА —
# `emart.mdm_employee_structure_d`. Остальные девятнадцать собраны по правилу
# `urn:dd:<systemType>:<systemName>:<type>:<id>`: правило верное, а значения
# в нём угаданы — и системой (`greenplum` против `dlh`), и тем, лежит ли
# витрина в каталоге вообще.
#
# Промах здесь ТИХИЙ, и это выяснилось дорого. Живой прогон 2026-08-31:
# по витрине детей каталог ответил 404, шейпер честно написал «ОШИБКИ DD:
# HTTP 404 — URN неверный», ядро увидело НЕПУСТОЙ текст и записало объект
# в «метаданные получены». В служебной строке джуну стояло
# «метаданные: … individualchildren_public» — то есть по виду прогона всё
# в порядке, — а автор писал «состав полей не получен, имена взяты из статьи»
# и ставил среднюю уверенность. На КАЖДОМ вопросе про эту витрину.
#
# Ищется URN поиском по имени: `POST /search/query` с телом `{text: …}`
# подтверждён живым прогоном 2026-08-27 («Активность в GitLab» первым же
# результатом вернул нужный URN). Один запрос на витрину, двадцать запросов
# на прогон — это работа на минуту, один раз, и каждая строка после неё
# подтверждена, а не угадана.
#
# Три ноды вместо двадцати: список витрин разворачивается Split Out,
# HTTP-нода выполняется по разу на элемент, шейпер собирает готовую колонку
# `dd_urn` для вставки в реестр.
TABLES_TO_RESOLVE_JS = r"""
// Имена витрин берутся ИЗ РЕЕСТРА, а не из списка в сборщике: копия
// разъехалась бы молча — то же правило, по которому состав полей
// не копируется из каталога в статью.
const urns = __TABLE_URNS__;
return urns.map((urn) => {
  // `schema.table` — хвост URN после последнего двоеточия. Ищем по ИМЕНИ
  // таблицы: полное имя со схемой поиск не находит, а имя — находит.
  const fqn = String(urn).split(':').pop();
  const name = fqn.split('.').pop();
  return { json: { urn, fqn, name } };
});
"""

nodes.append(
    node("Tables to resolve", "n8n-nodes-base.code", 2, [-40, 1300],
         {"mode": "runOnceForAllItems",
          "jsCode": TABLES_TO_RESOLVE_JS.replace(
              "__TABLE_URNS__", json.dumps(TABLE_URNS, ensure_ascii=False))})
)

_search_table = node(
    "Search table", "n8n-nodes-base.httpRequest", 4.4, [180, 1300],
    {
        "method": "POST",
        "url": f"{BASE}/search/query",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "devplatformApi",
        "sendBody": True,
        "specifyBody": "json",
        # Фильтр по типу сущности обязателен: без него в выдачу лезут колонки
        # и ноутбуки с тем же словом в имени, и первая строка оказывается
        # не витриной. Форма фильтра — из спецификации OpenAPI: словарь
        # «ключ → МАССИВ строк», а не скаляр.
        "jsonBody": '={{ JSON.stringify({ text: $json.name, limit: 10,'
                    ' filters: { type: ["TABLE"] } }) }}',
        "options": copy.deepcopy(DD_OPTS),
    },
    DP_CRED,
)
_search_table["onError"] = "continueRegularOutput"
nodes.append(_search_table)

SHAPE_URNS_JS = r"""
// Готовая колонка `dd_urn` для реестра плюс честный отчёт о том, что НЕ
// нашлось. Пустой результат — это ответ: витрины в каталоге нет, и тогда
// состав полей бот добирает из данных (`information_schema`), а описаний
// у неё не будет вовсе. Молча выдать «не нашлось» за «URN верный» нельзя:
// ровно так угаданный URN и прожил в реестре месяц.
const out = [];
const say = (s) => out.push(s);

let asked = [];
try { asked = $('Tables to resolve').all().map((i) => i.json); } catch (e) { asked = []; }
let res = [];
try { res = $('Search table').all().map((i) => i.json); } catch (e) { res = []; }

const rows = [];
const miss = [];
const same = [];
asked.forEach((a, idx) => {
  const r = res[idx];
  const code = r && r.statusCode;
  if (code !== undefined && code >= 400) {
    miss.push(`${a.fqn} — HTTP ${code}`);
    return;
  }
  const body = (r && (r.body ?? r)) || {};
  const cards = Array.isArray(body.data) ? body.data
              : Array.isArray(body) ? body : [];

  // ОДНА ТАБЛИЦА БЫВАЕТ В КАТАЛОГЕ ДВАЖДЫ — под разными системами.
  //
  // Первый прогон фазы 2026-08-31 предложил заменить URN
  // `emart.mdm_employee_structure_d` с `greenplum` на `dlh` — а это ровно
  // тот единственный URN, который подтверждён живым запросом и с которого
  // приезжают 267 колонок. Значит в выдаче лежали ОБА, а `find()` брал
  // первый по релевантности.
  //
  // Цена такой «правки» — заменить работающий URN на неподтверждённый,
  // то есть ровно то, от чего фаза и заведена. Поэтому: если среди
  // кандидатов есть URN ИЗ РЕЕСТРА — он и подтверждён, ранг ничего
  // не решает. Выбирать между несколькими код не имеет права: несколько
  // кандидатов печатаются списком с их системами, и решает человек.
  const cand = cards.filter((c) => {
    const f = String(c.fqn || '').toLowerCase();
    const u = String(c.urn || '').toLowerCase();
    return f === a.fqn.toLowerCase() ||
           u.split(':').pop().toLowerCase() === a.fqn.toLowerCase();
  });
  if (!cand.length) {
    // Точного совпадения по `схема.таблица` нет. Смотрим, есть ли хотя бы
    // по имени таблицы: это другой диагноз — схема в каталоге записана
    // иначе, чем в Trino, и человеку надо это увидеть, а не «не нашлось».
    const byName = cards.filter((c) => {
      const f = String(c.fqn || '').toLowerCase();
      return f.split('.').pop() === a.name;
    });
    miss.push(byName.length
      ? `${a.fqn} — точного совпадения нет, но по имени таблицы есть: ` +
        byName.slice(0, 5).map((c) => `${c.urn}`).join(', ')
      : `${a.fqn} — в каталоге не нашлось (${cards.length} чужих совпадений)`);
    return;
  }
  if (cand.some((c) => String(c.urn || '') === a.urn)) { same.push(a.fqn); return; }
  rows.push({
    fqn: a.fqn,
    was: a.urn,
    now: cand.map((c) => String(c.urn || '')),
  });
});

say('ФАЗА G. НАСТОЯЩИЕ URN ВИТРИН — ПОИСКОМ ПО ИМЕНИ');
say('');
say(`Спрошено витрин: ${asked.length}. Совпало с реестром: ${same.length}. ` +
    `Надо ПРАВИТЬ: ${rows.length}. Не нашлось: ${miss.length}.`);

if (rows.length) {
  say('');
  say('URN ИЗ РЕЕСТРА В ВЫДАЧЕ НЕ НАШЁЛСЯ. Кандидаты — ниже; если их');
  say('несколько, выбирает ЧЕЛОВЕК: код не имеет права заменять URN,');
  say('который может оказаться рабочим, на URN, который никто не проверял.');
  for (const r of rows) {
    say('');
    say(`  ${r.fqn}`);
    say(`    в реестре: ${r.was}`);
    for (const u of r.now) say(`    кандидат:  ${u}`);
    if (r.now.length > 1) {
      say('    ↑ несколько систем на одну таблицу — проверить, какая отдаёт');
      say('      состав полей, и только потом править реестр');
    }
  }
}
if (miss.length) {
  say('');
  say('В КАТАЛОГЕ НЕ НАШЛОСЬ — и это тоже ответ:');
  for (const m of miss) say('  — ' + m);
  say('');
  say('По таким витринам описаний полей не будет вовсе: их нет в каталоге.');
  say('Состав полей бот добирает из данных (information_schema), а смысл');
  say('поля остаётся за статьёй. Строку из реестра НЕ УДАЛЯТЬ: без dd_urn');
  say('код не поймёт, что это витрина, — но и верить ему как URN нельзя.');
}
if (same.length) {
  say('');
  say(`Подтверждены как есть (${same.length}): ${same.join(', ')}`);
}

return [{ json: { report: out.join('\n') } }];
"""

nodes.append(
    node("Shape urns", "n8n-nodes-base.code", 2, [400, 1300],
         {"mode": "runOnceForAllItems", "jsCode": SHAPE_URNS_JS})
)



# ---------------------------------------------------------------- ФАЗА H
#
# ПОЧЕМУ ПО ВЕРНОМУ URN НЕ ПРИХОДИТ СОСТАВ ПОЛЕЙ.
#
# Витрина детей описана в каталоге, URN в реестре подтверждён фазой G,
# колонки и описания у неё быть должны — а `DD Lookup` состава не даёт,
# и автор пишет «имена взяты из статьи, не подтверждены».
#
# Причин может быть несколько, и по ответу бота они неразличимы:
#   — ключ связи `columns` у этой системы называется иначе либо отсутствует;
#   — одна таблица зарегистрирована в каталоге ДВАЖДЫ (фаза G показала
#     кандидатов `greenplum` и `dlh` на одну витрину), и колонки висят
#     на другой регистрации;
#   — запрос отдаёт 200 и пустой список.
#
# Гадать здесь больше нельзя: два предыдущих диагноза («URN угаданный»,
# «колонок не заведено») оказались неверными, и оба выглядели убедительно.
# Фаза спрашивает каталог напрямую, по обеим регистрациям сразу.
PROBE_FQN = os.environ.get("PROBE_FQN",
                           "chrono_peoplehub_masterid.individualchildren_public")
PROBE_URNS = [
    f"urn:dd:tables:greenplum:table:{PROBE_FQN}",
    f"urn:dd:tables:dlh:table:{PROBE_FQN}",
]
PHASE_H = []
for _i, _u in enumerate(PROBE_URNS):
    _sys = _u.split(":")[3]
    _enc = f"encodeURIComponent('{_u}')"
    PHASE_H += [
        # Какие ключи связей есть У ЭТОЙ сущности. Ключ `columns` угадывать
        # нельзя — правило проекта: сначала /related, потом рабочий запрос.
        (f"H {_sys} related", f"={{{{ '{BASE}/entity/' + {_enc} + '/related' }}}}", ()),
        # И сразу рабочий запрос тем ключом, которым ходит DD Lookup.
        (f"H {_sys} columns",
         f"={{{{ '{BASE}/entity/' + {_enc} + '/related/columns' }}}}",
         (("limit", "500"),)),
        # Есть ли сама сущность и что она про себя говорит.
        (f"H {_sys} summary", f"={{{{ '{BASE}/entity/' + {_enc} + '/summary' }}}}", ()),
    ]
for _i, (_nm, _url, _q) in enumerate(PHASE_H):
    nodes.append(get(_nm, _url, [-40 + _i * 190, 1560], _q))

SHAPE_PROBE_TABLE_JS = r"""
// Ответ на один вопрос: КАКАЯ регистрация витрины отдаёт состав полей.
// Печатается по обеим, рядом, — сравнение и есть ответ; по одной выдаче
// отличить «ключа нет» от «колонок нет» невозможно.
const out = [];
const say = (s) => out.push(s);
const FQN = '__PROBE_FQN__';

function res(name) {
  try { return $(name).first().json; } catch (e) { return null; }
}
function code(r) { return r && r.statusCode; }
function body(r) { return (r && (r.body ?? r)) || {}; }

say('ФАЗА H. ПОЧЕМУ ПО ВЕРНОМУ URN НЕТ СОСТАВА ПОЛЕЙ');
say('');
say('Витрина: ' + FQN);

for (const sys of ['greenplum', 'dlh']) {
  say('');
  say('--- ' + sys + ' ---');

  const sum = res('H ' + sys + ' summary');
  const cSum = code(sum);
  say(`  /summary        → HTTP ${cSum === undefined ? '—' : cSum}` +
      (cSum && cSum < 400
        ? '  ' + JSON.stringify(body(sum)).slice(0, 160)
        : ''));

  const rel = res('H ' + sys + ' related');
  const cRel = code(rel);
  if (cRel !== undefined && cRel >= 400) {
    say(`  /related        → HTTP ${cRel} — сущности нет либо нет доступа`);
  } else {
    const b = body(rel);
    // Ответ /related — словарь «ключ связи → описание». Печатаем сами ключи:
    // именно их подбор и был источником ошибок («notes» вместо связи
    // с REPORT), и угадывать их правило проекта запрещает.
    const keys = b && typeof b === 'object' && !Array.isArray(b)
      ? Object.keys(b) : [];
    say(`  /related        → ключи: ${keys.length ? keys.join(', ') : '(пусто)'}`);
    say(`    есть ли «columns»: ${keys.includes('columns') ? 'ДА' : 'НЕТ'}`);
  }

  const col = res('H ' + sys + ' columns');
  const cCol = code(col);
  if (cCol !== undefined && cCol >= 400) {
    say(`  /related/columns → HTTP ${cCol} — этим ключом колонки не берутся`);
  } else {
    const b = body(col);
    const data = Array.isArray(b.data) ? b.data : [];
    say(`  /related/columns → totalCount: ${b.totalCount ?? '—'}, ` +
        `в ответе: ${data.length}`);
    if (data.length) {
      const first = data[0] && (data[0].entity || data[0]);
      say('    первая колонка: ' + String(first && first.fqn || '(без fqn)'));
    }
  }
}

say('');
say('ЧИТАТЬ ТАК:');
say('  колонки пришли по одной системе и не пришли по другой → в реестре');
say('    записана НЕ ТА регистрация, править строку kb/index.md;');
say('  ключа «columns» нет ни у одной, а другие ключи есть → у этой системы');
say('    состав полей берётся другим ключом, править DD Lookup;');
say('  /related пустой, а /summary отвечает → сущность есть, связей нет:');
say('    колонки в каталог не заведены, и это единственный случай, когда');
say('    описаний полей действительно не будет.');

return [{ json: { report: out.join('\n') } }];
"""

nodes.append(
    node("Shape probe table", "n8n-nodes-base.code", 2,
         [-40 + len(PHASE_H) * 190, 1560],
         {"mode": "runOnceForAllItems",
          "jsCode": SHAPE_PROBE_TABLE_JS.replace("__PROBE_FQN__", PROBE_FQN)})
)



# ---------------------------------------------------------------- ФАЗА I
#
# ГДЕ ЛЕЖИТ ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ. Не угадать, а спросить.
#
# В интерфейсе Data Detective у колонок витрины детей стоит «Sensitivity»
# со значением EMP_SENS. А `GET /entity/{col_urn}/attribute` этого признака
# не отдаёт вовсе: живой прогон 2026-08-31 показал ровно такой набор
# атрибутов — can_be_accessed, column_type, data_contract_domain,
# data_contract_id, data_contract_link, data_contract_version,
# data_contract_version_nm, keys, ordinal_position, systems_to_delete.
#
# Шейпер при этом писал «признака нет ни у одного из 25 полей. Считать эти
# поля открытыми НЕЛЬЗЯ» — то есть выдавал промах ключа за факт про данные,
# и оговорка уезжала в КАЖДЫЙ черновик. Класс известный: у кода есть право
# назвать факт и нет права назвать причину, которую он не измерял.
#
# Фаза спрашивает ОДНУ колонку по ВСЕМ ресурсам-расширениям сущности сразу.
# Ответ на вопрос «где лежит EMP_SENS» будет виден глазами, а не выведен.
PROBE_COL = os.environ.get(
    "PROBE_COL",
    f"urn:dd:tables:greenplum:column:{PROBE_FQN}.birthdate",
)
_ENC_COL = f"encodeURIComponent('{PROBE_COL}')"
PHASE_I = [
    (f"I {key}", f"={{{{ '{BASE}/entity/' + {_ENC_COL} + '/{key}' }}}}")
    for key in ("summary", "attribute", "tag", "markdown", "link", "table",
                "code", "related", "history")
]
for _i, (_nm, _url) in enumerate(PHASE_I):
    nodes.append(get(_nm, _url, [-40 + _i * 190, 1820]))

SHAPE_SENS_JS = r"""
// Где в ответах каталога встречается признак чувствительности. Ищем НЕ ключ
// (его имя мы как раз и не знаем), а ЗНАЧЕНИЕ: в интерфейсе оно выглядит
// как EMP_SENS. Плюс печатаем все ключи каждого ресурса — чтобы решение
// принималось по списку, а не по догадке.
const out = [];
const say = (s) => out.push(s);
const KEYS = ['summary', 'attribute', 'tag', 'markdown', 'link', 'table',
              'code', 'related', 'history'];
const MARK = /EMP_SENS|SENS|sensitiv|чувствительн/i;

say('ФАЗА I. ГДЕ ЛЕЖИТ ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ');
say('');
say('Колонка: ' + '__PROBE_COL__');
say('');

const found = [];
for (const k of KEYS) {
  let r = null;
  try { r = $('I ' + k).first().json; } catch (e) { r = null; }
  if (!r) { say(`  /${k.padEnd(10)} → узел не выполнялся`); continue; }
  const code = r.statusCode;
  if (code !== undefined && code >= 400) {
    say(`  /${k.padEnd(10)} → HTTP ${code}`);
    continue;
  }
  const body = (r.body ?? r) || {};
  const text = JSON.stringify(body);
  const keys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body) : (Array.isArray(body) ? [`массив, ${body.length} элементов`] : []);
  const hit = MARK.test(text);
  if (hit) found.push(k);
  say(`  /${k.padEnd(10)} → ${hit ? 'ЕСТЬ ПРИЗНАК' : 'нет'}; ключи: ` +
      (keys.length ? keys.slice(0, 14).join(', ') : '(пусто)'));
  if (hit) {
    // Печатаем кусок вокруг совпадения: имя ключа видно только так.
    const at = text.search(MARK);
    say('      ' + text.slice(Math.max(0, at - 160), at + 120));
  }
}

say('');
if (found.length) {
  say('ПРИЗНАК НАЙДЕН В: ' + found.join(', ') + '.');
  say('Читать его надо оттуда — вписать ресурс и ключ в build_dd_flow.py');
  say('(ACCESS_KEYS и accessOf), и добавить запрос этого ресурса к колонке.');
} else {
  say('ПРИЗНАКА НЕТ НИ В ОДНОМ ИЗ ПРОВЕРЕННЫХ РЕСУРСОВ.');
  say('Значит интерфейс берёт его не из публичного API этой сущности:');
  say('возможно, это классификация на уровне таблицы или отдельная ручка.');
  say('Тогда честный вывод для бота — признак недоступен, и запрет на ПДн');
  say('держится по смыслу поля, а не по каталогу. Так сейчас и написано.');
}

return [{ json: { report: out.join('\n') } }];
"""

nodes.append(
    node("Shape sensitivity", "n8n-nodes-base.code", 2,
         [-40 + len(PHASE_I) * 190, 1820],
         {"mode": "runOnceForAllItems",
          "jsCode": SHAPE_SENS_JS.replace("__PROBE_COL__", PROBE_COL)})
)


# ---------------------------------------------------------------- ФАЗА J
#
# ЕСТЬ ЛИ ОПТОВЫЙ ПУТЬ ЗА ОПИСАНИЯМИ ПОЛЕЙ.
#
# Сегодня поиск по смыслу читает карточки ВСЕХ колонок витрины, по ТРИ
# запроса на колонку: /summary, /attribute и /related/full_column_sensitivity.
# На `mdm_employee_structure_d` это 289 × 3 ≈ 870 запросов на один вопрос
# пользователя. Если оптовая ручка отдаёт то же самое одним вызовом, цена
# поиска по смыслу падает на три порядка.
#
# Тело НЕ УГАДАНО — взято из спецификации OpenAPI (файл `openapi` в корне),
# схема `BatchRelatedEntitiesByKey`: обязательные `urns` и `key`,
# необязательные `search`, `limit` (по умолчанию 100), `entityFields`,
# `relationFields`. Ответ — `BatchRelatedEntitiesResponse`: словарь
# «urn → {totalCount, data}», то есть та же форма, что у одиночной ручки,
# но по каждому запрошенному объекту.
#
# ГЛАВНОЕ ЗДЕСЬ — КРИТЕРИЙ УСПЕХА, И ЭТО НЕ HTTP 200.
#
# Одиночная `/related/columns` параметр `entityFields` ИГНОРИРУЕТ: передан,
# а описания не приходят (измерено 2026-08-06 на 267 колонках). Сервер при
# этом отвечает 200 и о проигнорированном поле молчит — ровно так проба
# с `searchText` вернула выдачу по умолчанию и выглядела успешной. Значит
# «оптовая ручка ответила 200» не значит ничего вовсе.
#
# Отличить «поле сработало» от «поле проигнорировано» можно только
# СРАВНЕНИЕМ с известным ответом, и известный ответ берётся ЖИВЫМ ЗАПРОСОМ
# В ЭТОМ ЖЕ ПРОГОНЕ, а не из записи в AGENTS.md: живой прогон, подтверждённый
# в одну дату, не остаётся верным навсегда — `entityFields` на `/entity/{urn}`
# работал 2026-08-06 и перестал 2026-08-24, без единой правки у нас.
#
# Отсюда три пробы и один эталон:
#
#   J ref summary   GET  /entity/{col}/summary          — ЭТАЛОН: описание
#                                                         одной колонки,
#                                                         полученное путём,
#                                                         который работает
#   J batch columns POST /entity/batch/related          — то же оптом:
#                                                         key=columns,
#                                                         entityFields=summary
#   J batch query   POST /entity/batch/related-by-query — тот же вопрос через
#                                                         условие, на случай
#                                                         если ключ ведёт себя
#                                                         иначе
#   J batch sens    POST /entity/batch/related          — оптовая
#                                                         чувствительность:
#                                                         key=full_column_sensitivity
#                                                         сразу по многим
#                                                         колонкам
#
# Шейпер сверяет три числа и одну строку: сколько объектов в словаре ответа,
# сколько колонок пришло против `totalCount`, у скольких есть непустое
# описание, и совпало ли описание эталонной колонки с эталоном. Ни одно
# из них по отдельности ничего не доказывает — доказывает совпадение.
PROBE_TABLE_URN = os.environ.get(
    "PROBE_TABLE_URN",
    "urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d",
)
# Колонка-эталон. Берётся у той же витрины: описание, полученное одиночной
# ручкой, и есть та правда, с которой сверяется оптовый ответ.
PROBE_REF_COL = os.environ.get(
    "PROBE_REF_COL",
    f"{PROBE_TABLE_URN.replace(':table:', ':column:')}.business_dt",
)
_ENC_REF = f"encodeURIComponent('{PROBE_REF_COL}')"
nodes.append(get("J ref summary",
                 f"={{{{ '{BASE}/entity/' + {_ENC_REF} + '/summary' }}}}",
                 [-40, 2100]))

# Лимит 500, а не 100 по умолчанию: у витрины 289 колонок, и потолок,
# срабатывающий на измерении, измерил бы сам себя — ровно так прогон
# 2026-08-27 «намерил» 800 специализаций, которые были 200 × 4.
_BATCH_FIELDS = ["displayName", "summary", "attributes"]
PHASE_J_POST = [
    ("J batch columns", "/entity/batch/related",
     {"urns": [PROBE_TABLE_URN], "key": "columns",
      "entityFields": _BATCH_FIELDS, "limit": 500}),
    # Тот же вопрос условием, а не ключом. `RelationsConditional` требует
    # `type` и `direction`; значения — те, что отдаёт `/related` у таблицы
    # для ключа `columns`: CONTAINS / src_dest, сущность COLUMN.
    # Прогон 2026-09-01 ответил сюда HTTP 400, и причина нашлась
    # в спецификации: `EntityFilter.type` — это СТРОКА, а не массив.
    # Массив там у `SearchFilters` в /search/query, и я перенёс форму
    # оттуда по аналогии — то есть ровно то, от чего защищает правило
    # «ключи связей не угадываются». Схема правит догадку.
    ("J batch query", "/entity/batch/related-by-query",
     {"urns": [PROBE_TABLE_URN], "type": "CONTAINS", "direction": "src_dest",
      "entity": {"type": "COLUMN"},
      "entityFields": _BATCH_FIELDS, "limit": 500}),
]
for _i, (_nm, _path, _body) in enumerate(PHASE_J_POST):
    _n = node(
        _nm, "n8n-nodes-base.httpRequest", 4.4, [150 + _i * 200, 2100],
        {
            "method": "POST",
            "url": f"{BASE}{_path}",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": json.dumps(_body, ensure_ascii=False),
            "options": copy.deepcopy(DD_OPTS),
        },
        DP_CRED,
    )
    _n["onError"] = "continueRegularOutput"
    # executeOnce обязателен: пробы стоят цепочкой, и без него узел
    # выполнился бы по разу на каждый входной элемент — так фаза D
    # «намерила» 800 строк, которых не было.
    _n["executeOnce"] = True
    nodes.append(_n)

# ЧУВСТВИТЕЛЬНОСТЬ ОПТОМ — ПО ВСЕМ КОЛОНКАМ ВИТРИНЫ, А НЕ ПО ОДНОЙ.
#
# Прогон 2026-09-01 отправил ОДИН URN и получил ноль сущностей. Это
# не измерение: у той колонки признака может не быть вовсе, и ноль
# одинаково согласуется с «ручка работает, поле открыто» и с «ручка
# оптом не отвечает». Отличить можно только спросив разом много колонок
# и увидев НЕНУЛЕВОЙ ответ хоть у одной — а у витрины сотрудников
# закрытые поля точно есть (ФИО, телефон).
#
# Список URN берётся из ответа предыдущей пробы, а не выписывается руками:
# выписанный разъехался бы с витриной молча.
SENS_URNS_JS = r"""
const TABLE = '__PROBE_TABLE_URN__';
let bucket = {};
try {
  const r = $('J batch columns').first().json;
  const body = (r && (r.body ?? r)) || {};
  bucket = body[TABLE] || body[Object.keys(body)[0]] || {};
} catch (e) { bucket = {}; }
const urns = (Array.isArray(bucket.data) ? bucket.data : [])
  .map((x) => (x && x.entity ? x.entity : x))
  .map((e) => String((e && e.urn) || ''))
  .filter(Boolean);
// Потолок запроса, а не потолок ручки: 289 URN в теле — это уже проба
// на размер тела, и провал по нему читался бы как «оптом не работает».
// Меряем сначала то, что меряем: отвечает ли ручка списком.
const SEND = urns.slice(0, 120);
return [{ json: {
  asked: SEND.length,
  total_urns: urns.length,
  body: JSON.stringify({ urns: SEND, key: 'full_column_sensitivity', limit: 500 }),
} }];
"""

nodes.append(
    node("J sens urns", "n8n-nodes-base.code", 2, [150 + 2 * 200, 2260],
         {"mode": "runOnceForAllItems",
          "jsCode": SENS_URNS_JS.replace("__PROBE_TABLE_URN__", PROBE_TABLE_URN)})
)
_sens = node(
    "J batch sens", "n8n-nodes-base.httpRequest", 4.4, [150 + 3 * 200, 2260],
    {
        "method": "POST",
        "url": f"{BASE}/entity/batch/related",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "devplatformApi",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ $json.body }}",
        "options": copy.deepcopy(DD_OPTS),
    },
    DP_CRED,
)
_sens["onError"] = "continueRegularOutput"
_sens["executeOnce"] = True
nodes.append(_sens)

SHAPE_BULK_JS = r"""
// Фаза J: есть ли оптовый путь за описаниями полей.
//
// Критерий успеха — СРАВНЕНИЕ, а не HTTP 200: одиночная /related/columns
// параметр entityFields игнорирует молча, и оптовая может делать то же
// самое. Поэтому эталон берётся живым запросом в этом же прогоне.
const out = [];
const say = (s) => out.push(s);
const REF_COL = '__PROBE_REF_COL__';
const TABLE = '__PROBE_TABLE_URN__';
const REF_NAME = REF_COL.split('.').pop();

const resp = (name) => {
  let it;
  try { it = $(name).first().json; } catch (e) { return { miss: 'узел не выполнялся' }; }
  if (!it) return { miss: 'пусто' };
  const code = it.statusCode;
  if (code !== undefined && code >= 400) {
    return { miss: `HTTP ${code}`, body: it.body };
  }
  return { body: it.body ?? it };
};

// Распаковка: элемент /related — это СВЯЗЬ, сама сущность вложена в entity.
// На этом уже один раз молча получился пустой инвентарь колонок.
const nodesOf = (list) => (Array.isArray(list) ? list : [])
  .map((x) => (x && x.entity ? x.entity : x))
  .filter(Boolean);
const nameOf = (e) => {
  const fqn = String((e && e.fqn) || '');
  if (fqn.includes('.')) return fqn.split('.').pop();
  const urn = String((e && e.urn) || '');
  return urn.includes('.') ? urn.split('.').pop() : urn;
};
// Описание может лежать и строкой, и обёрткой {type, data} — значение
// любого атрибута DD живёт в .data.
const descOf = (e) => {
  const s = e && e.summary;
  if (!s) return '';
  if (typeof s === 'string') return s;
  if (typeof s.data === 'string') return s.data;
  return '';
};

say('ФАЗА J. ОПТОВЫЙ ПУТЬ ЗА ОПИСАНИЯМИ ПОЛЕЙ');
say('');
say('Витрина: ' + TABLE);
say('Эталонная колонка: ' + REF_NAME);
say('');

// ЭТАЛОН. Без него ни одна проба ниже ничего не доказывает.
const ref = resp('J ref summary');
let refDesc = '';
if (ref.miss) {
  say('ЭТАЛОН НЕ ПОЛУЧЕН: ' + ref.miss + '.');
  say('Сравнивать не с чем — прогон бесполезен, чините эталон и повторяйте.');
  say('Записывать «оптовый путь не работает» по этому прогону НЕЛЬЗЯ:');
  say('мы не измерили ни одну из двух сторон сравнения.');
} else {
  const b = ref.body || {};
  refDesc = typeof b === 'string' ? b
    : (typeof b.data === 'string' ? b.data : (typeof b.summary === 'string' ? b.summary : ''));
  say(refDesc
    ? `ЭТАЛОН: одиночная ручка отдаёт описание «${refDesc}».`
    : 'ЭТАЛОН ПУСТ: одиночная ручка описания не дала. Тогда «оптом описаний ' +
      'нет» ничего не значит — у этой колонки его может не быть вовсе. ' +
      'Смените PROBE_REF_COL на колонку с заполненным описанием.');
}
say('');

for (const nm of ['J batch columns', 'J batch query']) {
  const r = resp(nm);
  say(`— ${nm}`);
  if (r.miss) {
    say('    ' + r.miss);
    if (r.body) say('    ' + JSON.stringify(r.body).slice(0, 300));
    say('');
    continue;
  }
  const body = r.body || {};
  // Ответ — словарь «urn → {totalCount, data}». Печатаем ключи: если пришёл
  // не словарь, форма ответа другая, и разбор ниже неверен.
  const keys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body) : [];
  say(`    ключей в ответе: ${keys.length}` +
      (keys.length ? ' — ' + keys.slice(0, 3).join(', ') : ''));
  if (!keys.length) {
    say('    форма ответа не словарь: ' + JSON.stringify(body).slice(0, 300));
    say('');
    continue;
  }
  const bucket = body[TABLE] || body[keys[0]] || {};
  const total = Number(bucket.totalCount);
  const items = nodesOf(bucket.data);
  const withDesc = items.filter((e) => descOf(e));
  const refItem = items.find((e) => nameOf(e) === REF_NAME);
  say(`    totalCount: ${Number.isFinite(total) ? total : '—'}, ` +
      `пришло колонок: ${items.length}`);
  if (Number.isFinite(total) && items.length < total) {
    say(`    СПИСОК НЕПОЛНЫЙ: ${items.length} из ${total}. Поднимайте limit,` +
        ' иначе измеряется потолок, а не ручка.');
  }
  say(`    с непустым описанием: ${withDesc.length} из ${items.length}`);
  // ОПИСАНИЕ — ЭТО НЕ ВСЁ, ЧТО НУЖНО ПОИСКУ ПО СМЫСЛУ.
  //
  // Прогон 2026-09-01 показал, что summary приходит оптом по всем 289
  // колонкам. Но `by_meaning` читает карточку не ради summary: в проекте
  // прямо записано, что `comment` ВАЖНЕЕ — там границы генерации поля,
  // развёртка витрины, поведение по уволенным, то есть то, из-за чего
  // считают неверно. Плюс тип данных и ключи.
  //
  // Мерить надо и это, иначе «оптовый путь работает» окажется правдой
  // про одно поле и догадкой про три остальных — а переводить на него
  // ветку каталога придётся целиком.
  const withAttrs = items.filter(
    (e) => e && e.attributes && typeof e.attributes === 'object' &&
           Object.keys(e.attributes).length);
  say(`    с непустыми атрибутами: ${withAttrs.length} из ${items.length}`);
  const attrKeys = new Set();
  for (const e of withAttrs) for (const k of Object.keys(e.attributes)) attrKeys.add(k);
  say('    ключи атрибутов: ' +
      (attrKeys.size ? [...attrKeys].sort().slice(0, 20).join(', ') : '(ни одного)'));
  for (const need of ['comment', 'column_type', 'keys']) {
    say(`      ${need}: ${attrKeys.has(need) ? 'ЕСТЬ' : 'НЕТ'}`);
  }
  // Один элемент целиком: форма атрибута — обёртка {type, data}, и значение
  // живёт в .data. Печатаем её, чтобы разбор писался по факту, а не по
  // памяти о том, как это выглядело в августе.
  if (refItem) {
    say('    эталонный элемент целиком:');
    say('      ' + JSON.stringify(refItem).slice(0, 500));
  }
  // ВОТ ЭТА СТРОКА И ЕСТЬ ОТВЕТ ФАЗЫ.
  if (!refItem) {
    say(`    эталонной колонки ${REF_NAME} в ответе НЕТ — сравнивать нечего`);
  } else if (!refDesc) {
    say('    эталон пуст, сравнение невозможно (см. выше)');
  } else if (descOf(refItem) === refDesc) {
    say(`    ✔ ОПИСАНИЕ СОВПАЛО С ЭТАЛОНОМ: «${descOf(refItem)}»`);
    say('    ЗНАЧИТ entityFields ЗДЕСЬ РАБОТАЕТ, и оптовый путь настоящий.');
  } else if (descOf(refItem)) {
    say(`    описание пришло, но ДРУГОЕ: «${descOf(refItem)}» против эталона`);
    say('    «' + refDesc + '». Это не отказ, но и не то же самое —');
    say('    разбираться, что именно отдаёт ручка, до того как на неё');
    say('    переводить поиск по смыслу.');
  } else {
    say('    ✘ ОПИСАНИЯ НЕТ, хотя entityFields передан и одиночная ручка');
    say('    его отдаёт. Значит поле ПРОИГНОРИРОВАНО — ровно как у');
    say('    одиночной /related/columns. Оптового пути за описаниями нет,');
    say('    и три запроса на колонку остаются ценой поиска по смыслу.');
  }
  say('');
}

const sens = resp('J batch sens');
say('— J batch sens (чувствительность оптом)');
let asked = 0;
try { asked = Number($('J sens urns').first().json.asked) || 0; } catch (e) { asked = 0; }
if (sens.miss) {
  say('    ' + sens.miss);
  if (sens.body) say('    ' + JSON.stringify(sens.body).slice(0, 300));
} else if (!asked) {
  say('    URN не собрались — спрашивать было нечего. Это НЕ ответ про ручку:');
  say('    смотрите пробу по колонкам выше, она и не дала списка.');
} else {
  const b = sens.body || {};
  const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
  say(`    отправлено URN: ${asked}, ключей в ответе: ${keys.length}`);
  // ПЕРВЫЙ ВОПРОС — ОТВЕЧАЕТ ЛИ РУЧКА ОПТОМ ВООБЩЕ. Ключей столько же,
  // сколько URN, — отвечает; меньше — отвечает не по всем, и это надо
  // знать до того, как на неё переводить отсев ПДн.
  if (keys.length === asked) {
    say('    ✔ ключей столько же, сколько URN: ручка отвечает по каждому');
  } else {
    say(`    ключей МЕНЬШЕ, чем URN (${keys.length} против ${asked}):`);
    say('    по части колонок ответа нет вовсе, и молчание тут неотличимо');
    say('    от «поле открыто». На такую ручку отсев ПДн переводить нельзя.');
  }
  let closed = 0;
  const labels = [];
  for (const k of keys) {
    const items = nodesOf((b[k] || {}).data);
    if (!items.length) continue;
    closed += 1;
    for (const e of items.slice(0, 2)) {
      const l = String((e && (e.displayName || e.fqn || e.urn)) || '');
      if (l && !labels.includes(l)) labels.push(l);
    }
  }
  say(`    колонок с признаком: ${closed} из ${keys.length}`);
  if (closed) {
    say('    ✔ ПРИЗНАК ОПТОМ ПРИХОДИТ. Ярлыки: ' + labels.slice(0, 5).join(', '));
  } else {
    say('    признака нет НИ У ОДНОЙ из спрошенных колонок. Это НЕ значит,');
    say('    что ручка не работает: у витрины могло не оказаться закрытых');
    say('    полей среди спрошенных. Но и «оптовая чувствительность');
    say('    работает» из этого прогона не следует — нужен объект,');
    say('    у которого признак ТОЧНО есть (витрина детей, фаза I).');
  }
}

say('');
say('ЧТО С ЭТИМ ДЕЛАТЬ');
say('  Совпало описание — переводить by_meaning на оптовую ручку: вместо');
say('  трёх запросов на колонку один-два на всю витрину. Тогда снимаются');
say('  и разговоры про время ответа: мерить будет нечего.');
say('  Не совпало — записать ИЗМЕРЕНИЕ, а не догадку: «оптовая ручка');
say('  entityFields игнорирует так же, как одиночная, проверено ' +
    new Date().toISOString().slice(0, 10) + '».');

return [{ json: { report: out.join('\n') } }];
"""

nodes.append(
    node("Shape bulk", "n8n-nodes-base.code", 2,
         [150 + len(PHASE_J_POST) * 200, 2100],
         {"mode": "runOnceForAllItems",
          "jsCode": SHAPE_BULK_JS
          .replace("__PROBE_REF_COL__", PROBE_REF_COL)
          .replace("__PROBE_TABLE_URN__", PROBE_TABLE_URN)})
)


CHAIN = (
    ["Run recon"]
    + [n for n, _ in PHASE_A]
    + ["Shape recon", "Search probe"]
    + [n for n, _ in PHASE_E_GET]
    + [n for n, _ in PHASE_E_POST]
    + ["Shape probes"]
    + [n for n, _ in PHASE_D]
    + ["Shape values"]
    + ["Tables to resolve", "Search table", "Shape urns"]
    + [n for n, _, _ in PHASE_H]
    + ["Shape probe table"]
    + [n for n, _ in PHASE_I]
    + ["Shape sensitivity"]
    + ["J ref summary"]
    + [n for n, _, _ in PHASE_J_POST]
    + ["J sens urns", "J batch sens", "Shape bulk"]
)
conn = {
    a: {"main": [[{"node": b, "type": "main", "index": 0}]]}
    for a, b in zip(CHAIN, CHAIN[1:])
}

# Обе фазы моста удалены как несостоятельные — см. заголовок файла.
# Ноды собираются, но в цепочку не включены и в выгрузку не попадают:
# отсечка одним местом, чтобы не выкусывать код из середины файла и не ловить
# на этом опечатку.
nodes = [n for n in nodes if n["name"] not in ['Build bridge', 'Build bridge2', 'Collect notes', 'Collect reports', 'Note link', 'Notes of table', 'Report link2', 'Report pages', 'Search page', 'Tables']]

flow = {
    "name": "DD Recon",
    "nodes": nodes,
    "connections": conn,
    "settings": {"executionOrder": "v1"},
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(flow, f, ensure_ascii=False, indent=2)

print(f"OK {OUT} — {len(nodes)} нод")
print(f"  разведка отчёта: {RECON_URN}")
print(f"  витрин из реестра: {len(TABLE_URNS)}")
print(f"  ключей эталона:   {len(FEEDBACK_KEYS)}")
print()
print("ОТКРЫТ ОДИН ВОПРОС — ФАЗА J: есть ли оптовый путь за описаниями полей.")
print("Пока он не измерен, поиск по смыслу стоит ТРИ запроса на колонку")
print("(289 колонок × 3 ≈ 870 на один вопрос), и любые слова про то, что это")
print("«наверняка долго», остаются догадкой. Фазы A, C, D, E, G, H, I")
print("отвечены живыми прогонами и повторного прогона не требуют.")
print()
print("Что читать, если всё-таки прогоняете:")
print("  «Shape recon»  — где у отчёта владелец")
print("  «Search probe» — форма тела и ответа POST /search/query")
print("  «Shape probes» — связи таблицы, источники отчёта, форма поиска")
print("  «Shape urns»   — НАСТОЯЩИЕ URN витрин, готовая колонка для реестра")
print("  «Shape probe table» — почему по верному URN нет состава полей")
print("  «Shape sensitivity» — ГДЕ лежит признак чувствительности")
print("  «Shape bulk»   — есть ли ОПТОВЫЙ путь за описаниями полей:")
print("                   сверка оптового ответа с эталоном, взятым")
print("                   одиночной ручкой в этом же прогоне")
print("  «Shape values» — видит ли Trino витрины, кардинальность поля")
print("                   и чем отказ по недоступной таблице отличается")
print("                   от пустого результата")
