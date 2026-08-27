"""Собирает два файла из Support Bot.json:

  Support Bot DD.json — основной флоу: чат, агент, три инструмента.
  DD Lookup.json     — отдельный воркфлоу-инструмент: метаданные из DD.

Ветка DD вынесена в самостоятельный воркфлоу намеренно. Self-call через
={{ $workflow.id }} в toolWorkflow приводил к «Missing node to start execution»:
инструмент завершался за 42 мс, ни один запрос в DD не уходил, и агент отвечал
по текстам статей, думая, что видел инвентарь полей.

ПОРЯДОК ИМПОРТА
1. Импортировать DD Lookup.json, скопировать его id из адресной строки n8n.
2. DD_SUBFLOW_ID=<id> python3 build_dd_flow.py && python3 patch_prompt.py
3. Импортировать Support Bot DD.json.
Без шага 2 в инструменте останется плейсхолдер, и вызов упадёт на «workflow
not found» — это осознанно громкая ошибка вместо тихой неверной работы.

Исходный Support Bot.json не меняется.
"""
import json
import copy
import os

SRC = "Support Bot.json"
DST = "Support Bot DD.json"
DST_SUB = "DD Lookup.json"

# id воркфлоу DD Lookup в n8n — ПОДТВЕРЖДЁН, воркфлоу импортирован.
#
# Значение по умолчанию, а не плейсхолдер: id выдаёт n8n при импорте, угадать
# его нельзя, и пока он жил только в переменной окружения, каждая пересборка
# без DD_SUBFLOW_ID молча возвращала плейсхолдер — вызов метаданных падал
# на «workflow not found». Так же записаны INGEST_ID и CHANNEL_ID в сборщике
# телеметрии.
#
# Переопределяется переменной окружения: воркфлоу пересоздали (другой инстанс
# n8n, импорт копией) — id меняется, и тогда DD_SUBFLOW_ID=<новый>.
DD_SUBFLOW_ID = os.environ.get("DD_SUBFLOW_ID", "7tgrNcbmZGuW2AON")

# Credential для DD. Тот же, которым ходят GitLab-ноды ядра, — один Service
# Account на оба источника, меньше поводов разъехаться.
#
# До 2026-08-27 здесь стоял «Spirit (Devplatform) Service Account account 2»
# (id RBgLA1Lw8UGBMCU3), а в живом «DD Lookup» credential был уже другой:
# его поменяли руками в n8n. Расхождение тихое и с отложенным взрывом —
# сборщик пересобирает ноды целиком, поэтому первая же пересборка DD Lookup
# вернула бы старый Service Account, и запросы в каталог начали бы отдавать
# 401 без единой правки кода. Ровно тот же класс, что выключенная руками
# нода «Collect articles»: правка в интерфейсе живёт до следующего импорта.
DP_CRED = {"devplatformApi": {"id": "mR1hhfmm8mKuMeX0",
                             "name": "Spirit (Devplatform) Service Account Support"}}

wf = json.load(open(SRC, encoding="utf-8"))

# ---------------------------------------------------------------- 1. чистка
# Неподключённая разведочная нода: свою роль выполнила, ключ columns известен.
wf["nodes"] = [n for n in wf["nodes"] if n["name"] != "HTTP Request"]

# Один Service Account на весь конвейер, включая ноды, унаследованные
# из исходника.
#
# Исходник «Support Bot.json» — снимок первой конструкции, и credential в нём
# заморожен на момент снятия. Через него он доезжает и до ядра: build_time_flows
# берёт GITLAB_CRED прямо из ноды «Get a file» собранного «Support Bot DD».
# То есть один устаревший id в файле, который давно не трогали, разъезжается
# сразу по трём воркфлоу.
#
# 2026-08-27 так и было: в живых «DD Lookup» и «Support Bot Core» стоял
# «…Service Account Support», а сборщик выдавал «…account 2». Правку сделали
# руками в интерфейсе, и она пережила бы ровно до следующего импорта —
# после чего каталог и чтение статей из GitLab отвалились бы по 401,
# без единой правки кода и без видимой причины.
for _n in wf["nodes"]:
    if "devplatformApi" in (_n.get("credentials") or {}):
        _n["credentials"] = copy.deepcopy(DP_CRED)

# ------------------------------------------------- 2. общие опции HTTP к DD
# Follow Redirects выключен: иначе редирект уводит на страницу логина.
# neverError + fullResponse: 404 по URN должен стать текстом для агента,
# а не падением инструмента.
DD_OPTS = {
    "redirect": {"redirect": {"followRedirects": False}},
    "response": {"response": {"fullResponse": True, "neverError": True}},
}

EF = ["displayName", "summary", "attributes"]

# Атрибут карточки колонки, в котором лежат группы доступа. Живым запросом
# имя НЕ подтверждено: 2026-08-06 на business_dt пришли column_type, keys,
# comment, versioning_type, ordinal_position — поле открытое, и признака
# доступа у него могло не быть по этой же причине.
#
# Поэтому список — кандидаты, а шейпер при промахе ищет ключ по смыслу
# и ПЕЧАТАЕТ найденное имя в блоке метаданных. Первый живой прогон на закрытом
# поле (ФИО, зарплата) покажет настоящее имя — вписать его сюда первым
# элементом, и эвристика больше не понадобится.
ACCESS_KEYS = [
    "access_groups",
    "access_group",
    "ad_groups",
    "ad_group",
    "security_groups",
    "access",
]


def qp(pairs):
    return {"parameters": [{"name": k, "value": v} for k, v in pairs]}


def http(name, url, query, pos):
    return {
        "parameters": {
            "url": url,
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendQuery": True,
            "queryParameters": qp(query),
            "options": copy.deepcopy(DD_OPTS),
        },
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.4,
        "position": pos,
        "id": f"dd-http-{name}",
        "name": name,
        "credentials": copy.deepcopy(DP_CRED),
        "onError": "continueRegularOutput",
    }


ENC = "{{ encodeURIComponent($('When called by agent').first().json.urn) }}"
BASE = "https://dd.t-tech.team/api/v3/entity/"

# ------------------------------------------------------ 3. ноды субворкфлоу
trigger = {
    "parameters": {
        "inputSource": "workflowInputs",
        "workflowInputs": {
            "values": [
                {"name": "urn"},
                {"name": "search"},
            ]
        },
    },
    "type": "n8n-nodes-base.executeWorkflowTrigger",
    "typeVersion": 1.1,
    "position": [-200, 300],
    "id": "dd-subflow-trigger",
    "name": "When called by agent",
}

router = {
    "parameters": {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [
                {
                    "id": "is-table",
                    "leftValue": "={{ $json.urn }}",
                    "rightValue": ":table:",
                    "operator": {"type": "string", "operation": "contains"},
                }
            ],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    },
    "type": "n8n-nodes-base.if",
    "typeVersion": 2.2,
    "position": [20, 300],
    "id": "dd-router",
    "name": "Route by object type",
}

# entityFields на /entity/{urn} игнорируется ПОВСЕМЕСТНО, не только у REPORT.
# Подтверждено живым запросом 2026-08-13 на report:1728 (пришли только
# id/urn/system/type/fqn), и живым прогоном 2026-08-24 на table/column
# emart.mdm_employee_structure_d — та же карточка, что 2026-08-06 отдавала
# summary/attributes с entityFields, 24-го числа отдала их же БЕЗ этих полей
# (те же id/urn/system/type/fqn, content-length 222 против прежних сотен байт
# с описанием). Поведение DD изменилось между двумя датами, а не наш запрос
# сломался — те же query-параметры, тот же узел. Поэтому описание таблицы
# тоже идёт отдельным запросом к суб-ресурсу, а не entityFields на карточке.
card = http("dd_entity_card", f"={BASE}{ENC}/summary", [], [260, 200])

# У колонки comment (атрибут) важнее summary — там развёрнутое пояснение,
# а не короткая подпись (см. «Форма карточки колонки» в AGENTS.md). У таблицы
# то же самое: summary — короткая подпись витрины, а comment на карточке
# таблицы в DD-интерфейсе подписан «Комментарий» и часто содержит то, из-за
# чего данные считают неверно — ровно как у колонки. Отдельный запрос,
# та же причина, что у dd_column_attrs: entityFields на /entity/{urn} их
# не отдаёт.
entity_attrs = http("dd_entity_attrs", f"={BASE}{ENC}/attribute", [], [260, 260])

# limit 500: у mdm_employee_structure_d totalCount = 289 (было 267 на
# 2026-08-06 — таблица растёт), при 300 запас был всего 33 колонки.
# entityFields передаётся, хотя живой запрос показал, что этот эндпоинт его
# игнорирует и summary с attributes не отдаёт — оставлен на случай, если
# поведение починят на стороне DD.
columns = http(
    "dd_columns",
    f"={BASE}{ENC}/related/columns",
    [("entityFields", v) for v in EF] + [("limit", "500")],
    [480, 200],
)

# Второй шаг: описания и типы. /related/columns их не отдаёт (тот же
# entityFields-баг), а карточка колонки /entity/{urn} с entityFields ПЕРЕСТАЛА
# отдавать (см. выше) — 2026-08-06 отдавала, 2026-08-24 на том же business_dt
# уже нет. Поэтому вместо одного комбинированного запроса — два отдельных,
# к суб-ресурсам /summary и /attribute, по образцу уже работающего запроса
# для REPORT. Раньше по отобранным фильтром полям шёл ОДИН запрос на колонку;
# теперь их два — цена поиска по смыслу удваивается, но остаётся разовой,
# по запросу пользователя, а не на каждое сообщение в канале.
column_summary = http(
    "dd_column_summary",
    "={{ 'https://dd.t-tech.team/api/v3/entity/' + encodeURIComponent($json.column_urn) + '/summary' }}",
    [],
    [1140, 60],
)
column_attrs = http(
    "dd_column_attrs",
    "={{ 'https://dd.t-tech.team/api/v3/entity/' + encodeURIComponent($('Pick columns').item.json.column_urn) + '/attribute' }}",
    [],
    [1140, 220],
)

# entityFields на самой карточке /entity/{urn} для REPORT игнорируются —
# подтверждено живым запросом 2026-08-13 (пришли только id/urn/system/type/fqn,
# без displayName/summary/attributes, хотя все были в entityFields). Ровно тот
# же эффект, что раньше был на /related/columns, только теперь на карточке
# сущности. Поэтому вместо одного запроса с entityFields — три отдельных
# запроса к суб-ресурсам, каждый подтверждён живым ответом на report:1728.
report_markdown = http("dd_report_markdown", f"={BASE}{ENC}/markdown", [], [260, 380])
report_attrs = http("dd_report_attrs", f"={BASE}{ENC}/attribute", [], [260, 440])
report_links = http("dd_report_links", f"={BASE}{ENC}/link", [], [260, 500])
# Витрины, на которых построен отчёт. Ключ связи `source_tables` подтверждён
# живым прогоном 2026-08-27: на report:1728 вернул три витрины
# (usr_cross_data.functional_role_d_br, emart.mdm_employee_structure_d,
# hrmart.summary_evaluation).
#
# Это половина того, ради чего затевался реестр отчётов: «на какой витрине
# построен» приезжает ОНЛАЙН и в git не дублируется — то же правило, что
# для состава полей и владельца. Обратный путь, от витрины к отчёту, при этом
# закрыт: ни одна из двенадцати связей таблицы не отдаёт REPORT, проверено
# тем же прогоном.
report_sources = http(
    "dd_report_sources", f"={BASE}{ENC}/related/source_tables", [], [260, 560]
)

# --------------------------------------------------------- 4. код-шейперы
COMMON_JS = r"""
// Общие помощники. Форма ответа DD по вложенным коллекциям на момент сборки
// не подтверждена живым запуском, поэтому массив ищется по нескольким
// известным вариантам обёртки.
function unwrap(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of ['items', 'data', 'content', 'entities', 'result', 'results']) {
    if (Array.isArray(body[k])) return body[k];
  }
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

// Реальная форма ответа /related/{key}, подтверждена живым запросом 2026-08-06:
//   { totalCount: 267, data: [ { relationId, entity: { id, urn, system, type, fqn } } ] }
// Сущность вложена в entity, на верхнем уровне лежит связь. Без этой распаковки
// shortName() не находит fqn и инвентарь получается пустым — ровно так шейпер
// и молчал на первой версии.
function nodesOf(body) {
  return unwrap(body).map((x) =>
    x && typeof x === 'object' && x.entity && typeof x.entity === 'object' ? x.entity : x,
  );
}

// Фильтр — СПИСОК игл, а не одна.
//
// Живой прогон 2026-08-26. Вопрос: «какое поле хранит логин и есть ли рабочая
// почта». Роутер отдаёт один hint на объект, ушёл «логин» — и поиска по слову
// «почта» не было вовсе. Бот увидел в блоке «проверены 289 из 289 полей»,
// прочитал это как «я видел все поля» и уверенно ответил, что рабочей почты
// в витрине нет. Поле `wrk_email_address_txt` с описанием «Рабочая почта»
// в ней есть — проверено вручную. Утверждение об ОТСУТСТВИИ поля опаснее
// всего, что бот говорит: в режиме выгрузки на нём строится раздел «Чего
// не будет», и заказчик узнаёт о пропаже атрибута после сдачи файла.
//
// В режиме by_meaning карточки всех колонок и так прочитаны, поэтому вторая
// игла не стоит ни одного лишнего запроса — только ещё одного сравнения.
//
// Обрезка до основы: сравнение идёт подстрокой, а русские слова склоняются.
// `'рабочей почты'.includes('почта')` — ложь. Режем хвост в два символа, но
// не короче пяти букв, чтобы «дата» не превратилась в «дат» и не совпала
// с половиной таблицы. Тот же приём уже стоит в проверке покрытия домена.
function needlesOf(search) {
  return String(search || '')
    .toLowerCase()
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^[а-яё]+$/.test(s) && s.length >= 5 ? s.slice(0, s.length - 2) : s));
}

// Совпала хотя бы одна игла. Пустой список игл не совпадает ни с чем:
// «фильтра не задавали» и «фильтр не совпал» — разные вещи, и вызывающий
// обязан различать их сам, до вызова.
function matchesAny(text, needles) {
  const t = String(text || '').toLowerCase();
  return needles.some((n) => n && t.includes(n));
}

function shortName(o) {
  const fqn = o.fqn || o.name || '';
  const parts = String(fqn).split('.');
  return parts[parts.length - 1] || '';
}

function descOf(o) {
  const s = o.summary;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') return s.data || s.value || s.text || '';
  return o.description || '';
}

// Подтверждённая форма attributes на карточке колонки (2026-08-06):
//   attributes: { column_type: { type: 'text', data: 'date' },
//                 comment:     { type: 'text', data: '…длинное описание…' },
//                 keys:        { type: 'text-list', data: ['PK'] }, … }
// Значение лежит в .data, а не в самом атрибуте. Без этой распаковки typeOf()
// возвращал строку «[object Object]» и она попадала в ответ агенту как тип поля.
function attrData(attrs, key) {
  if (!attrs || typeof attrs !== 'object') return '';
  const a = attrs[key];
  if (a === undefined || a === null) return '';
  const d = a && typeof a === 'object' && 'data' in a ? a.data : a;
  if (d === null || d === undefined) return '';
  if (Array.isArray(d)) return d.join(', ');
  if (typeof d === 'object') return '';
  return String(d);
}

function typeOf(o) {
  const a = o.attributes;
  if (!a) return '';
  if (Array.isArray(a)) {
    const hit = a.find((x) => /type/i.test(x.key || x.name || ''));
    return hit ? String(hit.value ?? hit.data ?? '') : '';
  }
  if (typeof a === 'object') {
    // Только явные ключи. Свободный поиск по /type/i цеплял versioning_type
    // и выдавал «BSN» за тип данных — пустой тип честнее неверного.
    return (
      attrData(a, 'column_type') || attrData(a, 'data_type') || attrData(a, 'dataType')
    );
  }
  return '';
}

function oneLine(s) {
  return String(s || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

// ---------------------------------------------------------- группы доступа
//
// Часть полей закрыта группами доступа: выгрузить их можно, но сначала нужно
// согласование. Для запроса на выгрузку это то, что обязано попасть
// в сообщение заказчику отдельным разделом — иначе согласование состоится,
// а потом окажется, что половину состава дать нельзя.
//
// Различаются ТРИ состояния, и путать их нельзя:
//   признак есть, группы перечислены  → поле закрыто;
//   признак есть, групп нет           → поле не закрыто;
//   признака нет вовсе                → НЕИЗВЕСТНО.
// Третье молча приравнять к «не закрыто» — самая дорогая ошибка из трёх:
// бот уверенно скажет, что согласование не нужно, и ошибётся именно на ПДн.
//
// Точное имя атрибута в DD живым запросом не подтверждено, поэтому сначала
// проверяются явные ключи ACCESS_KEYS, а потом — любой ключ, похожий на
// признак доступа. Найденное имя ПЕЧАТАЕТСЯ в блоке метаданных: первый же
// живой прогон покажет настоящее имя, и его надо будет вписать в ACCESS_KEYS
// в build_dd_flow.py. Угадывание с печатью имени лучше молчания: промах
// виден, а не выдаёт себя за факт.
const ACCESS_KEYS = __ACCESS_KEYS__;
const ACCESS_RE = /(access|permission|_group|group_|rls|warden|sensitiv|pii|confiden|secur|дост|груп|конфиденц|чувствит)/i;

function accessOf(attrs) {
  const none = { known: false, key: '', groups: '' };
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return none;
  for (const k of ACCESS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      return { known: true, key: k, groups: attrData(attrs, k) };
    }
  }
  // Эвристика жёстко ограничена, и вот почему. На настоящей карточке колонки
  // (business_dt, 2026-08-06) есть атрибут can_be_accessed: {boolean, true} —
  // свободный поиск по /access/ находил ИМЕННО ЕГО и печатал «закрыто
  // группами true» у открытого поля. Ровно та же ошибка, из-за которой
  // versioning_type когда-то выдавался за тип данных: пустой признак честнее
  // неверного. Поэтому флаги вида can_/is_/has_ и булевы значения отброшены —
  // группы доступа это список имён, а не «да».
  for (const k of Object.keys(attrs)) {
    if (!ACCESS_RE.test(k) || /^(can|is|has)_/i.test(k)) continue;
    const a = attrs[k];
    const declared = a && typeof a === 'object' ? String(a.type || '') : '';
    if (/bool/i.test(declared)) continue;
    const v = attrData(attrs, k);
    if (/^(true|false)$/i.test(v)) continue;
    return { known: true, key: k, groups: v };
  }
  return none;
}

function httpFail(res, label) {
  const code = res && res.statusCode;
  if (code === undefined) return null;
  if (code < 400) return null;
  if (code === 401) return `${label}: HTTP 401 — истёк Service Account, метаданные недоступны`;
  if (code === 404) return `${label}: HTTP 404 — URN неверный или у объекта нет такой связи`;
  return `${label}: HTTP ${code}`;
}
"""

# Два режима вместо одного. Без search отдаётся ПОЛНЫЙ список имён полей без
# обрезки: ~300 имён через запятую весят единицы килобайт, а описания — нет.
# Иначе агент вынужден угадывать имя поля, чтобы узнать имена полей: ровно это
# и происходило — пять вызовов подряд со выдуманными search и ноль результатов.
SHAPE_TABLE = COMMON_JS + r"""
const inp = $('When called by agent').first().json;
const urn = String(inp.urn || '');
const needle = String(inp.search || '').trim().toLowerCase();
const needles = needlesOf(inp.search);

const cardRes = $('dd_entity_card').first().json;
const entityAttrsRes = $('dd_entity_attrs').first().json;
const colRes = $('dd_columns').first().json;

const out = [];
const problems = [];

const f1 = httpFail(cardRes, 'описание таблицы');
const f0 = httpFail(entityAttrsRes, 'атрибуты таблицы');
const f2 = httpFail(colRes, 'колонки');
if (f1) problems.push(f1);
if (f0) problems.push(f0);
if (f2) problems.push(f2);

// dd_entity_card теперь бьёт в /summary напрямую (см. build_dd_flow.py):
// entityFields на карточке /entity/{urn} перестал отдавать displayName/summary,
// поэтому здесь нет ни того, ни другого — только { data: '...' }. Ярлык
// объекта строим из urn, а не card.displayName/card.fqn, которых в этом
// ответе больше нет.
const card = (cardRes && cardRes.body) || cardRes || {};
out.push(`ОБЪЕКТ DD: ${urn}`);
out.push(`URN: ${urn}`);
const cardDesc = oneLine(card.data || '');
if (cardDesc) out.push(`ОПИСАНИЕ ИЗ DD: ${cardDesc}`);

// Комментарий важнее summary — так же, как у колонки (см. AGENTS.md):
// summary таблицы это короткая подпись, а comment на карточке таблицы
// в интерфейсе DD подписан «Комментарий» и часто несёт то, из-за чего
// данные считают неверно. Печатаем, только если он отличается от summary —
// иначе одна и та же фраза дублируется под двумя заголовками.
const entityAttrs = (entityAttrsRes && entityAttrsRes.body) || entityAttrsRes || {};
const entityComment = oneLine(attrData(entityAttrs, 'comment'));
if (entityComment && entityComment !== cardDesc) out.push(`КОММЕНТАРИЙ ИЗ DD: ${entityComment}`);

const colBody = (colRes && colRes.body) || colRes;
const rows = nodesOf(colBody)
  .map((c) => ({
    field: shortName(c),
    type: typeOf(c),
    desc: oneLine(descOf(c)),
  }))
  .filter((r) => r.field);

const total = rows.length;

// Описания и атрибуты отобранных колонок. Раньше — одна карточка на колонку
// (dd_column_cards), но entityFields на /entity/{urn} перестал их отдавать
// (см. build_dd_flow.py), поэтому теперь два отдельных запроса на колонку:
// dd_column_summary (/summary) и dd_column_attrs (/attribute). Поле-имя
// оба ответа не несут вовсе — берём его из Pick columns, по тому же индексу:
// оба запроса идут по ОДНОМУ и тому же списку targets, порядок не расходится.
// Ноды может не быть в этом прогоне (пустой search или ни одного совпадения) —
// тогда $() бросает, и это нормальный путь.
let targets = [];
try {
  targets = $('Pick columns').all().map((i) => i.json);
} catch (e) {
  targets = [];
}
let summaries = [];
try {
  summaries = $('dd_column_summary').all().map((i) => i.json);
} catch (e) {
  summaries = [];
}
let attrsResList = [];
try {
  attrsResList = $('dd_column_attrs').all().map((i) => i.json);
} catch (e) {
  attrsResList = [];
}

const details = targets
  .map((t, i) => {
    const sumRes = summaries[i];
    const attrRes = attrsResList[i];
    const sumBody = (sumRes && sumRes.body) || sumRes || {};
    const attrs = (attrRes && attrRes.body) || attrRes || {};
    const failed = httpFail(sumRes, 'описание колонки') || httpFail(attrRes, 'атрибуты колонки');
    return {
      field: t.field || '',
      type: typeOf({ attributes: attrs }),
      desc: oneLine(sumBody.data || ''),
      // comment у колонки — развёрнутое пояснение, часто важнее краткого summary:
      // именно там описаны границы генерации business_dt и подобные ловушки.
      comment: oneLine(attrData(attrs, 'comment')),
      keys: attrData(attrs, 'keys'),
      access: accessOf(attrs),
      failed,
    };
  })
  .filter((d) => d.field || d.failed);

// Сколько колонок у объекта по мнению DD. Расходится с числом полученных —
// значит, ответ обрезан лимитом и нужна пагинация по afterUrn.
const declared =
  colBody && typeof colBody === 'object' && Number.isFinite(colBody.totalCount)
    ? colBody.totalCount
    : null;

// /related/columns отдаёт только идентификаторы колонок: ни summary,
// ни attributes, хотя entityFields передан. Описания и типы — отдельными
// запросами к суб-ресурсам колонки, dd_column_summary и dd_column_attrs.
const cardsFailed = details.filter((d) => d.failed);

// Полный инвентарь имён: печатается и как самостоятельный ответ на пустой
// search, и как подсказка, когда фильтр ничего не нашёл.
function inventory(reason) {
  out.push('');
  out.push(reason);
  out.push('');
  out.push(rows.map((r) => r.field).join(', '));
  out.push('');
  out.push(
    'Типы и описания полей здесь не показаны, чтобы список пришёл целиком. ' +
      'Нужны тип и описание — вызови dd_lookup ещё раз со словом-фильтром ' +
      'search, выбрав его ИЗ ЭТОГО списка.',
  );
  // Признак групп доступа живёт на карточке колонки, а карточки в этом режиме
  // не запрашивались. Сказать об этом обязательно: иначе «в метаданных про
  // закрытость ничего нет» прочитается как «поля открыты», и в согласование
  // с заказчиком уедет состав, половину которого выдать нельзя.
  out.push('');
  out.push(
    'ГРУППЫ ДОСТУПА: не запрашивались — они лежат на карточках полей, ' +
      'а карточки в этом режиме не запрашивались. Считать поля открытыми ' +
      'по этому ответу НЕЛЬЗЯ.',
  );
}

// Подробности по отобранным полям: тип, описание, развёрнутый комментарий.
// Список передаётся явно: при поиске по смыслу показываем не все прочитанные
// карточки, а только те, что реально совпали с hint по описанию.
function detailBlock(list) {
  out.push('');
  out.push(`ПОДРОБНО ПО ПОЛЯМ (${list.length}):`);
  for (const d of list) {
    if (d.failed) {
      out.push('');
      out.push(`— ${d.field || 'поле'}: ${d.failed}`);
      continue;
    }
    out.push('');
    out.push(`— ${d.field}${d.type ? ` (${d.type})` : ''}${d.keys ? ` [${d.keys}]` : ''}`);
    out.push(`  описание: ${d.desc || '— в DD не заполнено'}`);
    if (d.comment && d.comment !== d.desc) {
      out.push(`  комментарий из DD: ${d.comment}`);
    }
    if (d.access && d.access.known && d.access.groups) {
      out.push(`  доступ: ЗАКРЫТО группами ${d.access.groups} — по умолчанию не выгружается`);
    }
  }
  accessBlock(list);
}

// Сводка по группам доступа. Отдельным блоком, а не только строками у полей:
// для запроса на выгрузку это готовый раздел сообщения заказчику, и собирать
// его перечитыванием инвентаря автор не обязан.
function accessBlock(list) {
  const answered = list.filter((d) => !d.failed && d.access && d.access.known);
  const closed = answered.filter((d) => d.access.groups);
  out.push('');
  if (!answered.length) {
    out.push(
      `ГРУППЫ ДОСТУПА: признака нет в метаданных ни у одного из ${list.length} ` +
        'полей. Считать эти поля открытыми НЕЛЬЗЯ — каталог признак не вернул. ' +
        'Перед выгрузкой доступ надо проверить отдельно.',
    );
    return;
  }
  const key = answered[0].access.key;
  if (closed.length) {
    out.push(
      `ГРУППЫ ДОСТУПА: закрыто полей ${closed.length} из ${answered.length} — ` +
        closed.map((d) => `${d.field} (${d.access.groups})`).join(', ') + '.',
    );
  } else {
    out.push(`ГРУППЫ ДОСТУПА: среди ${answered.length} полей закрытых нет.`);
  }
  out.push(
    `  Признак взят из атрибута «${key}». Поля, не названные здесь, по данным ` +
      'каталога группами доступа не закрыты — но запрет на персональные данные ' +
      'действует независимо от каталога.',
  );
  if (answered.length < list.length) {
    out.push(
      `  По ${list.length - answered.length} полям признак не пришёл: ` +
        'их закрытость неизвестна.',
    );
  }
}

if (problems.length) {
  out.push('');
  out.push(`ОШИБКИ DD: ${problems.join('; ')}`);
  out.push('Состав полей считать неизвестным, не выдумывать и не угадывать.');
} else if (!total) {
  out.push('');
  out.push('ПОЛЯ ИЗ DD: 0');
  out.push('DD не вернул ни одного поля. Считать состав полей неизвестным,');
  out.push('а не пустым: возможно, у объекта другой ключ связи.');
} else if (!needle) {
  out.push('');
  if (declared !== null && declared > total) {
    out.push(
      `ПОЛЯ: получено ${total} из ${declared}. Список НЕПОЛНЫЙ — ответ обрезан ` +
        'лимитом. Не выдавай его за полный состав таблицы.',
    );
  } else {
    out.push(`ПОЛНЫЙ ИНВЕНТАРЬ ПОЛЕЙ: ${total}. Список полный, ничего не скрыто.`);
  }
  inventory('ВСЕ ПОЛЯ ТАБЛИЦЫ:');
} else {
  // Режим решает Pick columns: имя колонки латиницей — редко то же самое
  // слово, которым спрашивает человек по-русски, и by_meaning — обычный,
  // а не аварийный путь.
  let pick = {};
  try {
    pick = $('Pick columns').first().json || {};
  } catch (e) {
    pick = {};
  }
  const mode = pick.mode || 'by_name';
  const totalCols = Number.isFinite(pick.total_cols) ? pick.total_cols : total;

  if (mode === 'by_meaning') {
    // Имя поля не совпало с hint — ожидаемо, если hint дан по смыслу
    // по-русски. Карточки прочитаны по ВСЕМ полям таблицы (без потолка —
    // см. Pick columns), сравниваем hint с их описанием и комментарием,
    // а не с именем.
    const checked = details.length;
    // checked < totalCols здесь — не потолок (его больше нет), а часть
    // запросов карточек не вернула ответ. Молчать об этом нельзя: иначе
    // «не встретилось» читается как «такого поля нет», хотя часть полей
    // попросту не проверена.
    const incomplete = checked < totalCols;
    const matched = details.filter(
      (d) =>
        !d.failed &&
        (matchesAny(d.field, needles) ||
          matchesAny(d.desc, needles) ||
          matchesAny(d.comment, needles)),
    );
    out.push('');
    out.push(
      `ПОИСК ПО СМЫСЛУ «${inp.search}»: имя поля латиницей не совпало, искали ` +
        `по описаниям — проверены ${checked} из ${totalCols} полей` +
        (incomplete ? `, по остальным ${totalCols - checked} карточка не пришла` : '') +
        '.',
    );
    if (matched.length) {
      out.push('');
      out.push(`НАЙДЕНО ПО СМЫСЛУ: ${matched.length}`);
      detailBlock(matched);
      // Обязательная оговорка о границах этого блока.
      //
      // Раньше её не было, и строка «проверены 289 из 289 полей» читалась
      // моделью как «я видел все 289 полей». На вопрос про логин И почту бот
      // получил карточки только полей про логин — а про почту уверенно
      // ответил, что её в витрине нет. Поле там было. Проверено 289 полей
      // относится к ФИЛЬТРУ, а не к тому, что показано ниже: несовпавшие
      // поля в блок не попадают вовсе, и судить по нему об отсутствии
      // другого понятия нельзя.
      out.push('');
      out.push(
        `Показаны ТОЛЬКО поля, совпавшие с «${inp.search}» — остальные ` +
          `${checked - matched.length} проверенных полей в этот блок не попали, ` +
          'ни именами, ни описаниями. Судить по нему об отсутствии в таблице ' +
          'ДРУГОГО поля или понятия нельзя: его просто не искали.',
      );
    } else {
      out.push('');
      out.push(
        `«${inp.search}» не встретилось ни в одном из ${checked} проверенных описаний.` +
          (incomplete
            ? ` По ${totalCols - checked} полям карточка не пришла — среди них искомое ` +
              'может быть.'
            : ' Похоже, такого поля или значения в таблице нет.'),
      );
      inventory('ВСЕ ПОЛЯ ТАБЛИЦЫ (имена, без описаний — проверь среди них похожее):');
    }
  } else {
    const hit = rows.filter((r) => matchesAny(r.field, needles));
    out.push('');
    out.push(`ПОЛЯ ПО ИМЕНИ «${inp.search}»: ${hit.length} из ${total}`);

    if (!hit.length) {
      inventory(
        `Ни одно из ${total} полей не подошло под фильтр «${inp.search}». ` +
          'Значит, поля с таким названием в таблице нет — не подбирай похожее ' +
          'наугад, а выбери нужное из полного списка ниже.',
      );
    } else {
      out.push('');
      out.push('ПОДОШЛИ ПОЛЯ:');
      out.push(hit.map((r) => r.field).join(', '));

      if (details.length) {
        detailBlock(details);
        const noCard = hit.length - details.length;
        if (noCard > 0) {
          out.push('');
          out.push(
            `ВНИМАНИЕ: под фильтр попало ${hit.length} полей, описания получены ` +
              `по ${details.length}. По остальным ${noCard} описание не запрашивалось — ` +
              'сузь search, если нужны именно они.',
          );
        }
      } else {
        out.push('');
        out.push(
          'Описания по этим полям получить не удалось. Имена полей верны — ' +
            'они из каталога, а смысл возьми из статьи kb/.',
        );
      }
    }
  }
}

out.push('');
out.push(
  'НАПОМИНАНИЕ: это инвентарь из DD — состав полей и, если каталог их отдал, ' +
    'типы и описания. Гранулярность, правила джойна, тип среза и запреты — ' +
    'в статье kb/tables/.',
);

return [{ json: { dd_meta: out.join('\n') } }];
"""

# Между списком колонок и шейпером: решаем, по каким полям идти за карточками.
# Без фильтра карточки не запрашиваются вовсе — 267 запросов ради инвентаря имён
# не нужны и медленны.
PICK_COLUMNS = COMMON_JS + r"""
const MAX_CARDS = 12;

const inp = $('When called by agent').first().json;
const needle = String(inp.search || '').trim().toLowerCase();
const needles = needlesOf(inp.search);

const colRes = $('dd_columns').first().json;
const nodes = nodesOf((colRes && colRes.body) || colRes);

const cols = nodes
  .map((c) => ({ field: shortName(c), urn: c.urn || '' }))
  .filter((c) => c.field && c.urn);

// Пустой search — только инвентарь, карточки не нужны.
if (!needle) {
  return [{ json: { column_urn: '', picked: 0, matched: 0, mode: 'none' } }];
}

// Шаг 1: имя колонки латиницей иногда всё же совпадает с hint (business_dt,
// grade и т.п.) — дёшево проверить в первую очередь, и это оставляет старое
// поведение нетронутым для технических запросов.
const byName = cols.filter((c) => matchesAny(c.field, needles));

let targets;
let mode;
if (byName.length) {
  targets = byName.slice(0, MAX_CARDS);
  mode = 'by_name';
} else {
  // Колонка называется латиницей (dismissal_reason_desc), а спрашивают
  // по-русски («причины увольнения») — по имени это никогда не совпадёт,
  // не вопрос порога, а разных алфавитов. /related/columns описаний не
  // отдаёт (подтверждено), значит единственный способ найти поле по смыслу —
  // прочитать карточки ВСЕХ колонок таблицы и сравнить с описанием ПОСЛЕ
  // фетча, в Shape table meta. Раньше здесь стоял потолок в 60 карточек:
  // на таблице шире 60 колонок (живой кейс — 289) он обрывал поиск
  // до того, как дошёл до искомого поля, и «не встретилось» означало не
  // «такого поля нет», а «до него не долистали» — тихий отказ под видом
  // ответа. Цена — один HTTP-запрос на колонку, но она разовая и на
  // запрос пользователя, а не на каждое сообщение в канале.
  targets = cols;
  mode = 'by_meaning';
}

if (!targets.length) {
  return [{ json: { column_urn: '', picked: 0, matched: byName.length, mode } }];
}

const totalCols = cols.length;

return targets.map((t) => ({
  json: {
    column_urn: t.urn,
    field: t.field,
    picked: targets.length,
    matched: byName.length,
    mode,
    total_cols: totalCols,
  },
}));
"""

SHAPE_REPORT = COMMON_JS + r"""
const inp = $('When called by agent').first().json;
const urn = String(inp.urn || '');

const mdRes = $('dd_report_markdown').first().json;
const mdProblem = httpFail(mdRes, 'markdown-блоки');
const md = (mdRes && mdRes.body) || mdRes || {};

const attrRes = $('dd_report_attrs').first().json;
const attrProblem = httpFail(attrRes, 'атрибуты');
const attrs = (attrRes && attrRes.body) || attrRes || {};

const linkRes = $('dd_report_links').first().json;
const linkProblem = httpFail(linkRes, 'ссылки');
const links = (linkRes && linkRes.body) || linkRes || {};

const out = [];
out.push(`ОБЪЕКТ DD: отчёт ${urn}`);

// Смысл отчёта — ТОЛЬКО в markdown-блоках DD, не в git: владелец правит их
// прямо в DD, и здесь всегда актуальная версия. Имена блоков подтверждены
// живым запросом 2026-08-13 на report:1728: summary, how_to_read,
// additional_info (в additional_info лежит и связь с витриной-источником).
// Печатаем ЛЮБОЙ пришедший блок, а не только эти три по имени — новый блок,
// заведённый в DD позже, не должен требовать правки этого кода.
const MD_LABELS = {
  summary: 'НАЗНАЧЕНИЕ',
  how_to_read: 'КАК ИСПОЛЬЗОВАТЬ',
  additional_info: 'ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ',
};
const mdKeys = md && typeof md === 'object' ? Object.keys(md) : [];
if (mdKeys.length) {
  for (const k of mdKeys) {
    const text = attrData(md, k).trim();
    if (!text) continue;
    out.push('');
    out.push(`${MD_LABELS[k] || k.toUpperCase()}:`);
    out.push(text);
  }
} else {
  out.push('');
  out.push(
    '— в DD не заполнено ни одного markdown-блока (summary/how_to_read/' +
      'additional_info). Это пробел на стороне владельца отчёта, а не ' +
      'отсутствие ответа.',
  );
}

const period = attrData(attrs, 'period');
const status = attrData(attrs, 'status');
const team = attrData(attrs, 'developers_team') || attrData(attrs, 'data_team');
const factsLine = [
  period && `обновление: ${period}`,
  status && `статус: ${status}`,
  team && `команда: ${oneLine(team)}`,
]
  .filter(Boolean)
  .join(' · ');
if (factsLine) {
  out.push('');
  out.push(`АТРИБУТЫ DD: ${factsLine}`);
}

const linkKeys = links && typeof links === 'object' ? Object.keys(links) : [];
const linkLines = linkKeys
  .map((k) => [k, links[k] && links[k].url])
  .filter(([, url]) => url);
if (linkLines.length) {
  out.push('');
  out.push('ГДЕ ОТКРЫТЬ:');
  for (const [k, url] of linkLines) out.push(`— ${oneLine(k)}: ${url}`);
}

// Витрины, на которых построен отчёт. Печатаются ПОСЛЕ ссылок и перед
// проблемами: автор читает материалы сверху вниз, и «где открыть» ему нужнее,
// чем «из чего считается», — но второе он обязан увидеть до того, как начнёт
// предлагать считать то же самое руками.
const srcRes = $('dd_report_sources').first().json;
const srcProblem = httpFail(srcRes, 'витрины отчёта');
const srcBody = (srcRes && srcRes.body) || srcRes || {};
const srcNodes = nodesOf(srcBody);
if (srcNodes.length) {
  out.push('');
  out.push('ПОСТРОЕН НА ВИТРИНАХ:');
  for (const n of srcNodes) {
    const fqn = String(n.fqn || n.urn || '').trim();
    if (fqn) out.push(`— ${fqn}`);
  }
  out.push(
    'Это витрины-источники отчёта из каталога. Если заказчику нужен разрез, ' +
      'которого в отчёте нет, считать его надо из них — но правила среза ' +
      'и запреты бери из статьи витрины, а не отсюда.',
  );
} else if (!srcProblem) {
  out.push('');
  out.push(
    '— витрины-источники у отчёта в каталоге не указаны. Не додумывай, ' +
      'на чём он построен: этого не знает ни блок, ни ты.',
  );
}

const problems = [mdProblem, attrProblem, linkProblem, srcProblem].filter(Boolean);
if (problems.length) {
  out.push('');
  out.push(`ОШИБКИ DD: ${problems.join('; ')}`);
  out.push('Метаданные считать недоступными частично, не выдумывать недостающее.');
}

return [{ json: { dd_meta: out.join('\n') } }];
"""


def code(name, js, pos):
    return {
        "parameters": {
            "jsCode": js.replace(
                "__ACCESS_KEYS__", json.dumps(ACCESS_KEYS, ensure_ascii=False)
            )
        },
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": pos,
        "id": f"dd-code-{name}",
        "name": name,
    }


pick_columns = code("Pick columns", PICK_COLUMNS, [700, 200])
shape_table = code("Shape table meta", SHAPE_TABLE, [1380, 200])
shape_report = code("Shape report meta", SHAPE_REPORT, [480, 440])

# Пустой column_urn = карточки не нужны, идём прямо в шейпер.
need_cards = {
    "parameters": {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [
                {
                    "id": "has-urn",
                    "leftValue": "={{ $json.column_urn }}",
                    "rightValue": "",
                    "operator": {"type": "string", "operation": "notEmpty", "singleValue": True},
                }
            ],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    },
    "type": "n8n-nodes-base.if",
    "typeVersion": 2.2,
    "position": [920, 200],
    "id": "dd-need-cards",
    "name": "Need column cards",
}

# ------------------------------------------- 5. субворкфлоу как отдельный файл
sub = {
    "name": "DD Lookup",
    "nodes": [
        trigger,
        router,
        card,
        entity_attrs,
        columns,
        pick_columns,
        need_cards,
        column_summary,
        column_attrs,
        shape_table,
        report_markdown,
        report_attrs,
        report_links,
        report_sources,
        shape_report,
    ],
    "connections": {
        "When called by agent": {
            "main": [[{"node": "Route by object type", "type": "main", "index": 0}]]
        },
        "Route by object type": {
            "main": [
                [{"node": "dd_entity_card", "type": "main", "index": 0}],
                [{"node": "dd_report_markdown", "type": "main", "index": 0}],
            ]
        },
        "dd_entity_card": {"main": [[{"node": "dd_entity_attrs", "type": "main", "index": 0}]]},
        "dd_entity_attrs": {"main": [[{"node": "dd_columns", "type": "main", "index": 0}]]},
        "dd_columns": {"main": [[{"node": "Pick columns", "type": "main", "index": 0}]]},
        "Pick columns": {
            "main": [[{"node": "Need column cards", "type": "main", "index": 0}]]
        },
        # true — за описанием и атрибутами; false — сразу в шейпер, минуя HTTP.
        # Два запроса цепочкой (summary → attrs), а не параллельно в Shape
        # table meta: у неё уже есть входящее соединение с false-ветки, и
        # параллельный вход с обоих узлов запускал бы шейпер дважды на одну
        # и ту же порцию колонок — n8n не ждёт вторую ветку, как Merge.
        "Need column cards": {
            "main": [
                [{"node": "dd_column_summary", "type": "main", "index": 0}],
                [{"node": "Shape table meta", "type": "main", "index": 0}],
            ]
        },
        "dd_column_summary": {
            "main": [[{"node": "dd_column_attrs", "type": "main", "index": 0}]]
        },
        "dd_column_attrs": {
            "main": [[{"node": "Shape table meta", "type": "main", "index": 0}]]
        },
        # Три независимых запроса цепочкой — просто ради порядка выполнения,
        # друг от друга по данным не зависят. Shape report meta берёт каждый
        # по имени ноды через $(), как и остальные шейперы этого флоу.
        "dd_report_markdown": {
            "main": [[{"node": "dd_report_attrs", "type": "main", "index": 0}]]
        },
        "dd_report_attrs": {
            "main": [[{"node": "dd_report_links", "type": "main", "index": 0}]]
        },
        "dd_report_links": {
            "main": [[{"node": "dd_report_sources", "type": "main", "index": 0}]]
        },
        "dd_report_sources": {
            "main": [[{"node": "Shape report meta", "type": "main", "index": 0}]]
        },
    },
    "settings": {"executionOrder": "v1"},
    "active": False,
    "pinData": {},
}

# ------------------------------------------------------------ 6. инструмент
tool_desc = """Отдаёт МЕТАДАННЫЕ объекта из Data Detective (DD) — живой каталог,
данные всегда актуальные.

Для таблицы: состав полей, а по отобранным фильтром полям — тип данных,
описание и развёрнутый комментарий владельца.
Для отчёта: markdown-блоки из DD (назначение, как использовать, дополнительная
информация — включая витрину-источник), атрибуты (период обновления, статус,
команда), ссылка на дашборд.

КОГДА ВЫЗЫВАТЬ
Всегда, когда вопрос касается полей: «какие поля есть», «что лежит в поле»,
«есть ли поле про грейд», «какого типа поле», а также когда нужно проверить,
существует ли поле, прежде чем упоминать его в ответе или в SQL.
Вызывать и тогда, когда в реестре у строки есть dd_urn, но нет пути к статье:
в этом случае DD — единственный источник по объекту.

ДВА ШАГА, ИМЕННО В ЭТОМ ПОРЯДКЕ
Шаг 1. Вызов с пустым search — придёт список имён всех полей таблицы. Это
инвентарь: из него видно, какие поля существуют и как точно называются.
Шаг 2. Вызов со словом-фильтром search, выбранным ИЗ полученного списка —
по подошедшим полям придут тип данных, описание и комментарий владельца.
Имя поля не угадывается: сначала инвентарь, потом фильтр из него. Фильтр,
придуманный до шага 1, скорее всего не совпадёт ни с одним полем.
Если поля нет в инвентаре — такого поля в таблице нет.
Описания приходят не больше чем по 12 полям за вызов, поэтому фильтр стоит
брать узкий: не «dt», а «business_dt» или «hire».

ЧТО ПЕРЕДАВАТЬ
urn — значение из колонки dd_urn реестра, скопированное дословно, целиком,
включая префикс urn:dd:. Не сокращать, не кодировать, не составлять самому:
URN, которого нет в реестре, не существует.
search — слово-фильтр по имени и описанию поля. На первом вызове передавать
пустую строку. Если фильтр ничего не нашёл, инструмент сам вернёт полный
инвентарь — повторять вызов с другим выдуманным словом не нужно.

ЧТО ЭТО НЕ ДАЁТ
Гранулярность строки, правила джойна, тип среза поля, запреты и формулы метрик
в DD не описаны — они только в статье kb/. Инструмент не заменяет
read_kb_article, а дополняет его."""

dd_tool = {
    "parameters": {
        "descriptionType": "manual",
        "toolDescription": tool_desc,
        "workflowId": {
            "__rl": True,
            "value": DD_SUBFLOW_ID,
            "mode": "id",
            "cachedResultName": "DD Lookup",
        },
        "workflowInputs": {
            "mappingMode": "defineBelow",
            "value": {
                "urn": "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('urn', `Значение колонки dd_urn из реестра, дословно и целиком, например urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d`, 'string') }}",
                "search": "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('search', `Слово-фильтр по имени или описанию поля. На первом вызове по объекту передавать пустую строку: придёт полный список имён полей, из которого потом выбирается фильтр`, 'string', '') }}",
            },
            "matchingColumns": [],
            "schema": [
                {
                    "id": "urn",
                    "displayName": "urn",
                    "required": False,
                    "defaultMatch": False,
                    "display": True,
                    "canBeUsedToMatch": True,
                    "type": "string",
                },
                {
                    "id": "search",
                    "displayName": "search",
                    "required": False,
                    "defaultMatch": False,
                    "display": True,
                    "canBeUsedToMatch": True,
                    "type": "string",
                },
            ],
            "attemptToConvertTypes": False,
            "convertFieldsToString": True,
        },
    },
    "type": "@n8n/n8n-nodes-langchain.toolWorkflow",
    "typeVersion": 2.2,
    "position": [1760, 240],
    "id": "dd-lookup-tool",
    "name": "dd_lookup",
}

wf["nodes"].append(dd_tool)
wf["connections"]["dd_lookup"] = {
    "ai_tool": [[{"node": "AI Agent", "type": "ai_tool", "index": 0}]]
}

wf["name"] = "Support Bot DD"
wf.pop("id", None)
wf.pop("versionId", None)
wf["active"] = False

json.dump(wf, open(DST, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(sub, open(DST_SUB, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

print(f"OK {DST} — {len(wf['nodes'])} нод")
for n in wf["nodes"]:
    print("  -", n["name"])
print(f"OK {DST_SUB} — {len(sub['nodes'])} нод")
for n in sub["nodes"]:
    print("  -", n["name"])

if DD_SUBFLOW_ID.startswith("__"):
    print()
    print("ВНИМАНИЕ: в dd_lookup стоит плейсхолдер id воркфлоу DD Lookup.")
    print("Импортировать DD Lookup.json, взять его id и пересобрать:")
    print("  DD_SUBFLOW_ID=<id> python3 build_dd_flow.py && python3 patch_prompt.py")
