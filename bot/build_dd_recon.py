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

  ФАЗА B. Сам мост, оптом. Идём НЕ поиском по названиям, а со стороны витрин:
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

BASE = "https://dd.t-tech.team/api/v3"


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
const OWNER_RE = /владел|owner|steward|ответствен|responsible|автор|author|куратор/i;

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
const FEEDBACK = __FEEDBACK__;
const NO_KEY = __NO_KEY__;

// Ключ ссылки Proteus — тот же разбор, что в «Plan» ядра (reportSlug):
// /dashboard/23466/, /dashboard/p/el8AZBZX5Zv/, /dashboard/employee_ambassadorship/.
// Служебные сегменты пропускаем, иначе ключом стало бы слово «p».
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
    for (const m of v.match(/https?:\/\/\S+/g) || []) out.push(m.replace(/[),.;"']+$/, ''));
    return out;
  }
  if (typeof v === 'object') for (const x of Object.values(v)) urlsOf(x, out);
  return out;
};

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
  out.push('ПО ЛИМИТУ НЕ ПРОВЕРЯЛИСЬ: ' + meta._dropped + ' объектов — ' +
    'поднять MAX_NOTES в «Collect notes» и прогнать ещё раз');
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
        BRIDGE_JS
        .replace("__FEEDBACK__", json.dumps(FEEDBACK_KEYS, ensure_ascii=False))
        .replace("__NO_KEY__", json.dumps(FEEDBACK_NO_KEY, ensure_ascii=False)),
    )
)

# ------------------------------------------------------------------- связи
#
# Строго ЦЕПОЧКА, без веера. В n8n нет неявного слияния: узел за развилкой
# выполняется по разу на каждую дошедшую ветвь, и разведённые фазы дали бы
# два прогона моста на один запуск.
CHAIN = (
    ["Run recon"]
    + [n for n, _ in PHASE_A]
    + ["Shape recon", "Search probe", "Tables", "Notes of table",
       "Collect notes", "Note link", "Build bridge"]
)
conn = {
    a: {"main": [[{"node": b, "type": "main", "index": 0}]]}
    for a, b in zip(CHAIN, CHAIN[1:])
}

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
print("Импортировать НОВЫМ воркфлоу (он ничего не вызывает по id), запустить")
print("вручную и прочитать вывод трёх нод: «Shape recon» — где владелец,")
print("«Build bridge» — готовые строки моста, «Search probe» — форма поиска.")
