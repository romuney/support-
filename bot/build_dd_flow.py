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

# Атрибут карточки колонки, в котором лежит признак чувствительности.
#
# ИМЯ ПОДТВЕРЖДЕНО ВЛАДЕЛЬЦЕМ ЗАДАЧИ 2026-08-27: это `sensitivity`. Правило,
# которое из него следует, простое и не требует разбора значения:
#
#   поле заполнено  → данные чувствительные, нужен доступ и согласование;
#   поле пустое     → признака нет;
#   атрибута нет    → НЕ «поле открыто», а «признак не пришёл».
#
# Конкретное значение называет AD-группу, и групп разных много, но решение
# для бота от группы не зависит: любое непустое значение означает, что поле
# просто так не выгружается. Поэтому шейпер печатает значение как есть,
# а вывод делает по факту заполненности — разбирать список групп ему незачем
# и не по чему.
#
# Остальные ключи — прежние кандидаты, оставлены запасом: имя атрибута может
# отличаться у других систем каталога, а промах здесь дорогой. При промахе
# всех явных ключей шейпер ищет по смыслу и ПЕЧАТАЕТ найденное имя, чтобы
# угадывание было видно, а не выдавало себя за факт.
ACCESS_KEYS = [
    "sensitivity",
    "access_groups",
    "access_group",
    "ad_groups",
    "ad_group",
    "security_groups",
    "access",
]


# ------------------------------------------------------- Trino для значений
#
# Нода и credential берутся из собранного «Telemetry Flush», а не заводятся
# здесь константой: аккаунт и имена полей `CUSTOM.trino` подтверждены живым
# прогоном 2026-08-17, и вторая копия разъехалась бы с ними молча.
TRINO_SRC = "../telemetry/Telemetry Flush.json"
_TRINO = None
if os.path.exists(TRINO_SRC):
    _flush = json.load(open(TRINO_SRC, encoding="utf-8"))
    _tn = next(
        (n for n in _flush["nodes"] if n.get("type", "").lower().endswith("trino")), None
    )
    if _tn is not None:
        _TRINO = {
            "type": _tn["type"],
            "typeVersion": _tn["typeVersion"],
            "credentials": copy.deepcopy(_tn["credentials"]),
            "options": {k: v for k, v in _tn["parameters"].items() if k != "query"},
        }
if _TRINO is None:
    raise SystemExit(
        f"нет ноды Trino в {TRINO_SRC} — сначала cd telemetry && "
        f"python3 build_telemetry_flows.py: ветка значений полей собирается оттуда"
    )


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
                # Слова, ЗНАЧЕНИЕ которых надо найти в данных, через запятую.
                # Не то же самое, что search: тот ищет ПОЛЕ по имени и описанию,
                # а это ищет, какое значение в поле соответствует слову
                # заказчика. Живой прогон 2026-08-27: поле бот назвал верно
                # (emp_specialization_desc), а значение — нет, потому что
                # перечня значений в каталоге нет вовсе, он только в данных.
                {"name": "values"},
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
    // Хвост режется, но НИКОГДА короче четырёх букв. Правило «минус два
    // символа» превращало пятибуквенное слово в ТРЁХбуквенное: «грейд» → «гре»,
    // «стрим» → «стр», «оклад» → «окл». Совпадение идёт подстрокой, поэтому
    // «стр» ловит и структуру, и стратегию, и страну — и в фильтре описаний,
    // и в ilike по данным, где это ещё и скан витрины ради мусора. Ровно тот
    // класс, из-за которого из ключевых слов маршрутов выброшен «рид»
    // (внутри «гибрида»). Четыре буквы — минимум, на котором слово ещё
    // остаётся собой: «юниты» → «юнит», «почты» → «почт», «грейд» → «грей».
    .map((s) => (/^[а-яё]+$/.test(s) && s.length >= 5
      ? s.slice(0, Math.max(4, s.length - 2))
      : s));
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
// Поля, по которым каталог не отдал карточку. Печатается в конце ответа
// отдельной строкой: раньше этот список вычислялся и НЕ ЧИТАЛСЯ НИГДЕ,
// то есть отказ HTTP по карточке колонки не попадал ни в «ОШИБКИ DD»
// (там только три табличных запроса), ни в блок поиска. Поле, чьё описание
// не пришло, выглядело в точности как поле без описания — а это разные
// вещи: во втором случае описания нет, в первом мы про него не знаем.
const cardsFailed = details.filter((d) => d.failed);

// Полный инвентарь имён: печатается и как самостоятельный ответ на пустой
// search, и как подсказка, когда фильтр ничего не нашёл.
// `hadCards` — были ли карточки колонок запрошены вообще. Строка про группы
// доступа в inventory() раньше утверждала «карточки в этом режиме не
// запрашивались» безусловно, а вызывается inventory() из ДВУХ мест: при
// пустом или промахнувшемся фильтре по имени (карточек правда нет) и из
// ветки by_meaning без совпадений — где карточки прочитаны по ВСЕМ колонкам
// таблицы. Во втором случае утверждение просто ложно, и признак
// чувствительности, который у нас на руках, объявлялся отсутствующим.
const hadCards = details.length > 0;

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
  if (hadCards) {
    // Карточки прочитаны — значит, признак чувствительности у нас есть,
    // и сводка по нему честнее, чем «не запрашивались».
    accessBlock(details);
  } else {
    out.push(
      'ГРУППЫ ДОСТУПА: не запрашивались — они лежат на карточках полей, ' +
        'а карточки в этом режиме не запрашивались. Считать поля открытыми ' +
        'по этому ответу НЕЛЬЗЯ.',
    );
  }
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
      // Значение называет AD-группу, но вывод от неё не зависит: заполнено —
      // значит чувствительное, значит нужен доступ и согласование. Разбирать
      // список групп боту незачем и не по чему.
      out.push(
        `  ЧУВСТВИТЕЛЬНОЕ ПОЛЕ (${d.access.key}: ${d.access.groups}) — просто так ` +
          'не выгружается, нужен доступ и согласование',
      );
    }
  }
  accessBlock(list);
}

// Значения полей из данных. Три исхода, и они обязаны звучать по-разному:
// «значения нашлись», «таких значений нет» и «витрина до Trino не доехала».
// Слитые в один, они отправят чинить не то — ровно как ddFailed и ddMissing
// до 2026-08-27.
//
// Значение ВЫБИРАЕТ АВТОР, а не код. Автоподстановка «наиболее подходящего» —
// это ilike '%аналитик%', который поймает и «Бизнес-аналитик BI», и
// «Системный аналитик»: запрос выполнится и вернёт неверные цифры молча.
function valuesBlock() {
  let plan = null;
  try { plan = $('Build values SQL').first().json; } catch (e) { plan = null; }
  if (!plan) {
    // Узел не выполнялся. Значений не просили — это нормальный путь, молчим.
    //
    // Просили — ветка не запустилась, и причина одна: пустой search. Карточки
    // полей в этом режиме не запрашиваются вовсе, а «Build values SQL» стоит
    // за ними, потому что признак чувствительности живёт именно на карточке.
    // Молчать здесь нельзя: заказчик назвал значение фильтра, проверка
    // не выполнялась, и по виду ответа это неотличимо от «значений не просили».
    if (String(inp.values || '').trim()) {
      out.push('');
      out.push(
        `ЗНАЧЕНИЯ ПОЛЕЙ «${oneLine(inp.values)}» в данных НЕ ПРОВЕРЯЛИСЬ: ` +
          'без слова-фильтра search неизвестно, в каком поле их искать. ' +
          'Нужны реальные значения — вызови dd_lookup ещё раз, выбрав ' +
          'поле из списка выше и передав его в search. Про наличие или ' +
          'отсутствие такого значения в витрине сейчас не утверждай ничего.',
      );
    }
    return;
  }

  // Запрос не отправлялся — сказать почему, если причина содержательная.
  if (!plan.values_sql) {
    if (plan.values_reason && !/слов для поиска/.test(plan.values_reason)) {
      out.push('');
      out.push(`ЗНАЧЕНИЯ ПОЛЕЙ не проверялись: ${plan.values_reason}.`);
      if ((plan.values_skipped || []).length) {
        out.push('  исключены: ' + plan.values_skipped.join(', '));
      }
    }
    return;
  }

  let res;
  try { res = $('dd_values').all().map((i) => i.json); } catch (e) { res = null; }

  out.push('');
  if (res === null) {
    out.push(
      'ЗНАЧЕНИЯ ПОЛЕЙ: запрос к данным не выполнялся, хотя был построен. ' +
        'Это сбой конвейера, а не отсутствие значений — про наличие или ' +
        'отсутствие значения ничего не утверждай.',
    );
    return;
  }

  const first = res[0] || {};
  const err = first.error || first.message;
  if (err) {
    const txt = typeof err === 'string' ? err : JSON.stringify(err);
    // Отказ по недоступной таблице отличим по тексту: подтверждено живым
    // прогоном 2026-08-27 («Table '…' does not exist»).
    const missing = /does not exist|not found|schema.*not/i.test(txt);
    out.push(
      missing
        ? `ЗНАЧЕНИЯ ПОЛЕЙ проверить не удалось: витрины ${plan.values_table} ` +
          'в хранилище запросов нет — она туда ещё не доехала. Поле по описанию ' +
          'из каталога рекомендовать можно, но КОНКРЕТНОГО значения мы не знаем, ' +
          'и в черновике это надо сказать прямо.'
        : `ЗНАЧЕНИЯ ПОЛЕЙ проверить не удалось: ${oneLine(txt).slice(0, 300)}. ` +
          'Это отказ запроса, а не отсутствие значений.',
    );
    return;
  }

  // Форма ответа CUSTOM.trino на SELECT живым прогоном НЕ подтверждена:
  // подтверждён только его write-режим (Telemetry Flush, 2026-08-17), а узел
  // watermark там разбирает ответ переборкой обёрток и роняет прогон на
  // нераспознанной форме. Здесь ронять нельзя — из-за одного блока пропал бы
  // весь инвентарь витрины, — но и молчать нельзя тем более: строки, которые
  // мы не сумели разобрать, дали бы «значений НЕ НАЙДЕНО», то есть ответ
  // про данные, которых никто не смотрел.
  const rows = [];
  let wrappers = 0;
  let unknown = 0;
  for (const it of res) {
    if (!it || typeof it !== 'object') { unknown++; continue; }
    // Пустой элемент — это «строк не вернулось». Именно так выглядит ответ
    // при alwaysOutputData, который стоит на ноде обязательно (иначе ноль
    // строк останавливает весь воркфлоу). Считать его непонятной формой
    // значило бы на каждом промахе фильтра писать «разобрать не удалось»
    // вместо «таких значений нет» — две разные вещи, которые чинятся
    // в разных местах.
    if (Object.keys(it).length === 0) continue;
    if (it.val !== undefined && it.val !== null) { rows.push(it); continue; }
    let unwrapped = false;
    for (const k of ['data', 'rows', 'result', 'results', 'response', 'body']) {
      if (Array.isArray(it[k])) {
        unwrapped = true;
        wrappers++;
        for (const r of it[k]) {
          if (r && typeof r === 'object' && r.val !== undefined && r.val !== null) rows.push(r);
        }
      }
    }
    if (!unwrapped) unknown++;
  }
  const words = (plan.values_words || []).join(', ');

  // Строки пришли, а разобрать не удалось ни одной: это НЕ «значений нет».
  if (!rows.length && unknown) {
    out.push(
      'ЗНАЧЕНИЯ ПОЛЕЙ: ответ хранилища получен, но разобрать его не удалось — ' +
        `${unknown} элементов неизвестной формы: ` +
        oneLine(JSON.stringify(res[0])).slice(0, 200) + '. Это сбой разбора, ' +
        'а не отсутствие значений: про наличие или отсутствие значения ' +
        'ничего не утверждай.',
    );
    return;
  }

  if (!rows.length) {
    out.push(
      `ЗНАЧЕНИЯ ПОЛЕЙ: в полях ${(plan.values_fields || []).join(', ')} ` +
        `значений со словами «${words}» НЕ НАЙДЕНО. Поля такие есть, а значения ` +
        'под эти слова в данных нет — либо заказчик называет его иначе, ' +
        'либо такого среза действительно не существует. Уточни формулировку ' +
        'у заказчика, а не подставляй похожее.',
    );
    return;
  }

  const byField = new Map();
  for (const r of rows) {
    const f = String(r.fld || '');
    if (!byField.has(f)) byField.set(f, []);
    byField.get(f).push(r);
  }
  out.push(`ЗНАЧЕНИЯ ПОЛЕЙ, найденные в данных по словам «${words}»:`);
  for (const [f, list] of byField) {
    out.push('');
    out.push(`— ${f}:`);
    for (const r of list) out.push(`    «${r.val}» — ${r.cnt} строк`);
  }
  out.push('');
  out.push(
    'Это РЕАЛЬНЫЕ значения из витрины' +
      (plan.values_slice ? ' на актуальном срезе' : '') +
      ', а не догадка: такой фильтр действительно даст строки. Выбери ' +
      'подходящее сам или уточни у заказчика, если подходящих несколько — ' +
      'подставлять «похожее» нельзя, запрос выполнится и вернёт не те цифры.',
  );
  if ((plan.values_skipped || []).length) {
    out.push(
      '  Не проверялись: ' + plan.values_skipped.join(', ') +
        ' — по персональным и чувствительным полям значения не тянем.',
    );
  }
  // Список упёрся в потолок запроса — значит, показано не всё. Молча
  // обрезанный перечень читается как полный, и «других значений нет»
  // становится утверждением о факте, которого никто не проверял.
  if (plan.values_limit && rows.length >= plan.values_limit) {
    out.push(
      `  Показаны первые ${plan.values_limit} значений по убыванию числа строк — ` +
        'список ОБРЕЗАН лимитом запроса. Судить по нему об отсутствии другого ' +
        'значения нельзя.',
    );
  }
}

// Сводка по чувствительности. Отдельным блоком, а не только строками у полей:
// для запроса на выгрузку это готовый раздел сообщения заказчику, и собирать
// его перечитыванием инвентаря автор не обязан.
//
// ПРАВИЛО, ПОДТВЕРЖДЁННОЕ ВЛАДЕЛЬЦЕМ ЗАДАЧИ 2026-08-27: атрибут `sensitivity`
// заполнен — поле чувствительное, нужен доступ и согласование. Значение
// называет AD-группу, и групп много, но решение от группы не зависит.
// До этого бот отвечал «неоткуда узнать, чувствительные это данные или нет»,
// имея признак прямо в карточке колонки.
//
// Три состояния разведены намеренно, и это не педантизм: «поле открыто»,
// «поле закрыто» и «признак не пришёл» ведут к разным ответам заказчику,
// а слитые вместе дают самый дорогой из возможных ответов — уверенное
// «согласование не нужно» на чувствительном поле.
function accessBlock(list) {
  const answered = list.filter((d) => !d.failed && d.access && d.access.known);
  const closed = answered.filter((d) => d.access.groups);
  out.push('');
  if (!answered.length) {
    out.push(
      `ЧУВСТВИТЕЛЬНОСТЬ: признака нет в метаданных ни у одного из ${list.length} ` +
        'полей. Считать эти поля открытыми НЕЛЬЗЯ — каталог признак не вернул, ' +
        'а это не то же самое, что «поле не чувствительное». Перед выгрузкой ' +
        'доступ надо проверить отдельно, и в черновике так и сказать.',
    );
    return;
  }
  const key = answered[0].access.key;
  if (closed.length) {
    out.push(
      `ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ ${closed.length} из ${answered.length}: ` +
        closed.map((d) => `${d.field} (${d.access.groups})`).join(', ') + '.',
    );
    out.push(
      '  Каждое из них просто так не выгружается: нужен доступ и согласование. ' +
        'В скобках — группа из каталога; она называет, КУДА идти за доступом, ' +
        'но на сам вывод не влияет — заполнено значит закрыто.',
    );
  } else {
    out.push(
      `ЧУВСТВИТЕЛЬНОСТЬ: среди ${answered.length} полей признак не проставлен ` +
        'ни у одного — по данным каталога они не чувствительные.',
    );
  }
  out.push(
    `  Признак взят из атрибута «${key}». Поля, не названные здесь, по данным ` +
      'каталога не закрыты — но запрет на персональные данные действует ' +
      'независимо от каталога: ФИО, телефоны и почты не выгружаются, даже ' +
      'если признак у них пуст.',
  );
  if (answered.length < list.length) {
    out.push(
      `  По ${list.length - answered.length} полям признак не пришёл: ` +
        'про них нельзя сказать ни что они открыты, ни что закрыты.',
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
    // ПРОВЕРЕННОЕ ПОЛЕ — ТО, ЧЬЯ КАРТОЧКА ПРИШЛА, а не то, что попало
    // в список целей. Раньше здесь стояло `details.length`, а details
    // строится из targets и фильтруется по `d.field || d.failed` — то есть
    // упавшие карточки считались проверенными наравне с полученными,
    // и `checked < totalCols` не мог стать true никогда. Ветка про
    // непришедшие карточки была мёртвой, и на таблице, где половина
    // запросов отдала 500, шейпер печатал «проверены 3 из 3 полей»:
    // «не встретилось» читалось как «такого поля нет», хотя половину
    // полей никто не смотрел. Ровно тот отказ, который эта строка
    // и задумана предотвращать.
    const answered = details.filter((d) => !d.failed);
    const checked = answered.length;
    // Два разных остатка, и путать их нельзя: по одним полям карточка
    // ОТКАЗАЛА (чинится ретраем или Service Account), по другим её
    // не запрашивали вовсе (чинится потолком или фильтром).
    const cardFailed = details.length - checked;
    const notAsked = totalCols - details.length;
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
        (cardFailed ? `, по ${cardFailed} каталог не отдал карточку` : '') +
        (notAsked > 0 ? `, по ${notAsked} карточка не запрашивалась` : '') +
        '.',
    );
    if (incomplete) {
      out.push(
        `ВНИМАНИЕ: ${totalCols - checked} полей остались НЕПРОВЕРЕННЫМИ. ` +
          'Среди них искомое вполне может быть — не утверждай, что такого ' +
          'поля в таблице нет.',
      );
    }
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
            ? ` По ${totalCols - checked} полям описание получить не удалось — среди них ` +
              'искомое может быть, и «такого поля нет» здесь сказать НЕЛЬЗЯ.'
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

// Блок значений печатается БЕЗУСЛОВНО, а не изнутри detailBlock: он отвечает
// на отдельный вход (`values`) и к тому, попал ли фильтр по имени поля,
// отношения не имеет. Пока вызов стоял внутри detailBlock, промах фильтра
// уводил поток в inventory() — и целый запрос к данным исчезал из ответа
// молча, притом что он уже был выполнен и оплачен сканом витрины.
valuesBlock();

// Отказы по карточкам колонок — в конце, но обязательно. Формулировка
// осторожная намеренно: «описание получить не удалось», а не «владелец
// не заполнил» — второе это утверждение о владельце, которого мы
// не проверяли (отдельное правило промпта).
if (cardsFailed.length) {
  out.push('');
  out.push(
    `ОПИСАНИЯ НЕ ПОЛУЧЕНЫ по ${cardsFailed.length} полям: ` +
      cardsFailed.map((d) => d.field || '?').slice(0, 20).join(', ') +
      (cardsFailed.length > 20 ? ' и другим' : '') +
      '. Каталог на эти запросы не ответил — это НЕ значит, что описания ' +
      'нет: про эти поля мы просто ничего не узнали.',
  );
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
# ---------------------------------------- SQL для проверки значений полей
#
# ЗАЧЕМ. Заказчик говорит «BI-аналитики в стриме Дата», фильтровать надо
# по emp_specialization_desc и emp_stream_desc, а какие там значения —
# «Бизнес-аналитик BI» или «Аналитик BI» — из каталога не видно: перечня
# уникальных значений в DD нет вовсе, подтверждено владельцем задачи.
# Живой прогон 2026-08-27 на этом и остановился: поле названо верно,
# значение — нет.
#
# Узел строит ОДИН запрос на все проверяемые поля через UNION ALL: сколько бы
# полей ни отобралось, HTTP-вызов остаётся один.
#
# Решения, каждое закрывает тихую ошибку:
#
# — ЧУВСТВИТЕЛЬНЫЕ ПОЛЯ ИСКЛЮЧАЮТСЯ. `select distinct` по ФИО или телефону —
#   это персональные данные, уехавшие в контекст модели. Признак берётся
#   из уже полученных карточек (sensitivity), поэтому узел стоит ПОСЛЕ них,
#   а не после «Pick columns»: там признака ещё нет.
# — ИМЕНА ПО СПИСКУ ПДн ТОЖЕ ИСКЛЮЧАЮТСЯ. Признак в каталоге может быть
#   не проставлен, а поле всё равно персональное. Два фильтра, а не один:
#   промах любого из них здесь стоит утечки.
# — КАНОНИЧЕСКИЙ СРЕЗ ДОБАВЛЯЕТСЯ, ТОЛЬКО ЕСЛИ ПОЛЕ ЕСТЬ В ТАБЛИЦЕ.
#   `last_day_flg = 1` обязателен на витрине «сотрудник × день», иначе это
#   скан всей истории. Но не у всякой таблицы он есть, и слепое добавление
#   уронило бы запрос. Полный список колонок у нас уже на руках — проверяем
#   по нему, а не по вере.
# — cast(... as varchar) ПЕРЕД ilike. Тип поля здесь неизвестен, а ilike
#   по числовому столбцу Trino не выполнит.
# — ПУСТОЙ СПИСОК СЛОВ = ЗАПРОСА НЕТ. Тянуть значения «на всякий случай»
#   значит платить сканом витрины на каждой выгрузке.
VALUES_SQL = COMMON_JS + r"""
const MAX_VALUE_FIELDS = 4;
const MAX_ROWS = 60;

const inp = $('When called by agent').first().json;
const words = needlesOf(inp.values);

// Имена, по которым значения не тянем никогда, даже если признак пуст.
// ПЕРСОНАЛЬНОЕ — ЭТО ПОЛЕ ПРО ЧЕЛОВЕКА, А НЕ ЛЮБОЕ ПОЛЕ С `_nm`.
//
// Здесь стояло `nm|name` в общем списке, и под фильтр попадало КАЖДОЕ поле
// с суффиксом `_nm` — то есть ровно те, ради которых ветка значений
// и заведена: в этом проекте `_nm` по соглашению значит «название чего-то»
// (`*_rk` против `*_nm`), а не «имя человека». Живой прогон 2026-08-28:
// на вопросе про юнит Human Capital Origination поле `legal_unit_nm`
// было выброшено как «похоже на ПДн», а запрос ушёл по кодам
// `legal_unit_type_cd` — и, разумеется, ничего не нашёл.
//
// Поэтому `nm`/`name` сами по себе персональными не считаются: только рядом
// со словом, которое называет ЧЕЛОВЕКА (`full_nm`, `employee_name`), либо
// в списке заведомо личных полей — контакты, документы, дата рождения,
// адрес, логин.
const PII_RE = new RegExp([
  '(^|_)(fio|phone|tel|mobile|email|mail|birth|passport|inn|snils|addr|address|login)($|_)',
  '(^|_)(full|first|last|middle|patronymic|short)_(nm|name)($|_)',
  '(^|_)(emp|employee|person|people|user|manager|head|lead|hrbp|client|candidate)_(nm|name)($|_)',
].join('|'), 'i');

const picked = $('Pick columns').all().map((i) => i.json).filter((x) => x.field);
const summaries = $('dd_column_summary').all().map((i) => i.json);
const cards = $('dd_column_attrs').all().map((i) => i.json);

// В режиме by_meaning «Pick columns» отдаёт ВСЕ колонки таблицы, а не
// совпавшие: имя латиницей с русским hint не совпадает никогда, поэтому
// сравнение по описаниям делается уже после фетча карточек. Значит, брать
// «первые отобранные» здесь нельзя — на витрине в 289 полей это скан данных
// по случайному полю и список значений, к вопросу отношения не имеющий.
// Совпадение считаем тем же способом, что и шейпер: имя, описание,
// комментарий. Тогда поля, по которым тянутся значения, — ровно те, что
// автор увидит в блоке «НАЙДЕНО ПО СМЫСЛУ».
const mode = (picked[0] && picked[0].mode) || 'by_name';
const searchNeedles = needlesOf(inp.search);
const cand = picked
  .map((p, idx) => {
    const sumRes = summaries[idx];
    const attrRes = cards[idx];
    const sumBody = (sumRes && sumRes.body) || sumRes || {};
    const attrs = (attrRes && attrRes.body) || attrRes || {};
    return {
      field: String(p.field || ''),
      desc: oneLine(sumBody.data || ''),
      comment: oneLine(attrData(attrs, 'comment')),
      attrs,
    };
  })
  .filter(
    (d) =>
      mode !== 'by_meaning' ||
      matchesAny(d.field, searchNeedles) ||
      matchesAny(d.desc, searchNeedles) ||
      matchesAny(d.comment, searchNeedles),
  );

// Полный список колонок таблицы — из него узнаём, есть ли канонический срез.
const colRes = $('dd_columns').first().json;
const allCols = nodesOf((colRes && colRes.body) || colRes)
  .map((c) => shortName(c)).filter(Boolean);
const hasSlice = allCols.includes('last_day_flg');

// Имя таблицы для запроса: из URN берём схему и таблицу, схема с префиксом.
// urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d
//   → prod_v_emart.mdm_employee_structure_d
const fqn = String(inp.urn || '').split(':').pop();
const dot = fqn.indexOf('.');
const table = dot === -1 ? '' : `prod_v_${fqn.slice(0, dot)}.${fqn.slice(dot + 1)}`;

// СУРРОГАТНЫЕ КЛЮЧИ И ФЛАГИ ЗНАЧЕНИЙ НЕ НЕСУТ.
//
// Живой прогон 2026-08-28: запрос ушёл по `legal_unit_rk`, и это скан витрины
// ради списка чисел. Заказчик называет «Human Capital Origination», а не
// ключ юнита; сопоставить одно с другим по такому списку нельзя, а стоит он
// столько же, сколько полезный. Флаги — то же самое: их значения 0 и 1,
// и фильтр по ним заказчик словами не задаёт.
//
// Соглашение проекта прямое: `*_rk` против `*_nm`, джойн по названиям
// запрещён (см. kb/tables/mdm-employee-structure-d.md). Значит и значения
// смотрим у названий, а не у ключей.
const KEYLIKE_RE = /(^|_)(rk|dk|sk|id|flg|dt|num|no)$/i;

// НАЗВАНИЯ ИДУТ ВПЕРЁД КОДОВ. Потолок в четыре поля выбирает из списка
// совпавших, и порядок здесь решает: живой прогон 2026-08-28 отдал места
// `legal_unit_type_cd` и `emp_specialization_oper_code`, а `emp_stream_desc`
// до запроса не доехал. Заказчик называет «Human Capital Origination»,
// а не код типа юнита, поэтому поля с человекочитаемым суффиксом
// (`_nm`, `_desc`, `_txt`) проверяются первыми. Это порядок, а не отсев:
// коды остаются кандидатами, просто после названий.
const NAMELIKE_RE = /(^|_)(nm|name|desc|descr|txt|title)$/i;
const ranked = cand.slice().sort(
  (a, b) => (NAMELIKE_RE.test(b.field) ? 1 : 0) - (NAMELIKE_RE.test(a.field) ? 1 : 0),
);

const skipped = [];
const fields = [];
ranked.forEach((d) => {
  if (fields.length >= MAX_VALUE_FIELDS) return;
  const f = d.field;
  if (!/^[a-z_][a-z0-9_]*$/i.test(f)) return;      // в SQL идёт только имя-идентификатор
  if (PII_RE.test(f)) { skipped.push(`${f} (имя похоже на ПДн)`); return; }
  if (KEYLIKE_RE.test(f)) { skipped.push(`${f} (ключ или флаг, значений не несёт)`); return; }
  const acc = accessOf(d.attrs);
  if (acc.known && acc.groups) { skipped.push(`${f} (чувствительное)`); return; }
  fields.push(f);
});
// Потолок MAX_VALUE_FIELDS — про стоимость запроса, и отброшенное по нему
// обязано называться: молча урезанный список полей читается как «значений
// в остальных полях нет», хотя их просто не спрашивали.
const overCap = ranked.length - fields.length - skipped.length;
if (overCap > 0) {
  skipped.push(`ещё ${overCap} полей (потолок ${MAX_VALUE_FIELDS} на один запрос)`);
}

const ok = Boolean(words.length && table && fields.length);
if (!ok) {
  return [{ json: { values_sql: '', values_fields: [], values_words: words,
                    values_skipped: skipped, values_table: table,
                    values_reason: !words.length ? 'слов для поиска значений не задано'
                      : !table ? 'из URN не вывелось имя таблицы'
                      // Причина называется по факту, а не одной формулировкой
                      // на все случаи: «исключены как чувствительные» на списке
                      // из ключей и флагов отправило бы запрашивать доступ там,
                      // где дело в другом.
                      : 'ни одно из отобранных полей не годится для поиска '
                        + 'значений: ' + (skipped.join(', ') || 'подходящих полей нет') } }];
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const like = words.map((w) => q('%' + w + '%'));
const slice = hasSlice ? 'last_day_flg = 1 AND ' : '';
// В TRINO НЕТ ILIKE. Это синтаксис Postgres и Greenplum, а здесь Trino, и он
// отвечает на него разбором: «mismatched input 'ILIKE'» — прогон 2026-08-28.
// Регистронезависимость делается через lower(): слова уже приведены к нижнему
// регистру в needlesOf, поэтому lower() нужен только на колонке.
//
// Ошибка была громкой и потому дешёвой: нода стоит с continueRegularOutput,
// шейпер назвал это отказом запроса, а не «значений не найдено», и ответ
// по витрине не пропал. Ровно ради этого пять исходов и разведены.
const parts = fields.map((f) =>
  `SELECT ${q(f)} AS fld, CAST(${f} AS varchar) AS val, count(*) AS cnt\n` +
  `FROM ${table}\nWHERE ${slice}(` +
  like.map((l) => `lower(CAST(${f} AS varchar)) LIKE ${l}`).join(' OR ') +
  `)\nGROUP BY 1, 2`);

// СОРТИРОВКА И ЛИМИТ — НАД ПОДЗАПРОСОМ, а не сразу после UNION ALL.
//
// `... UNION ALL ... ORDER BY 3 DESC LIMIT 60` читается двояко: относится
// ORDER BY ко всему объединению или к последней ветви — и по порядковому
// номеру колонки после набора операций поведение диалектов расходится.
// Проверить это отсюда нечем (Trino доступен только из n8n), а цена ошибки —
// не отказ, а МОЛЧА неверный список: показались бы значения одного поля
// вместо самых частых по всем. Обёртка в подзапрос и сортировка по ИМЕНИ
// колонки не оставляют места для трактовок.
const union = parts.join('\nUNION ALL\n');

return [{ json: {
  values_sql: `SELECT fld, val, cnt FROM (\n${union}\n) v\nORDER BY cnt DESC\nLIMIT ${MAX_ROWS}`,
  values_limit: MAX_ROWS,
  values_fields: fields,
  values_words: words,
  values_skipped: skipped,
  values_table: table,
  values_slice: hasSlice,
  values_reason: '',
} }];
"""

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

// ВЛАДЕЛЕЦ И КАНАЛ ПОДДЕРЖКИ — отдельными строками, а не в общей россыпи.
//
// Оба подтверждены живым прогоном разведки 2026-08-27: в /attribute отчёта
// лежат report_developer, developers_team, data_team и support_channel.
// Раньше шейпер печатал только команду и два УГАДАННЫХ ключа (period,
// status), а владельца и канал отбрасывал молча — при том что по фидбеку
// аналитика «кто владелец отчёта» это 11 обращений из 49, а «к кому идти»
// ещё 13. То есть ответ на два самых частых вопроса канала приезжал
// из каталога и выбрасывался по дороге.
//
// Именно поэтому владельца НЕ дублируют в git: он меняется без нашего
// ведома, и место ему — здесь, онлайн.
const owner = attrData(attrs, 'report_developer');
const supportChannel = attrData(attrs, 'support_channel');
const team = attrData(attrs, 'developers_team') || attrData(attrs, 'data_team');
if (owner || team) {
  out.push('');
  out.push(
    `ВЛАДЕЛЕЦ ОТЧЁТА: ${[owner && oneLine(owner), team && `команда ${oneLine(team)}`]
      .filter(Boolean).join(', ')}. Взято из каталога, поэтому актуально.`,
  );
}
if (supportChannel) {
  out.push('');
  out.push(
    `КУДА ПИСАТЬ ПО ОТЧЁТУ: ${oneLine(supportChannel)} — это канал поддержки ` +
      'из карточки отчёта, а не наш. Назови его коллеге, если вопрос ' +
      'про сам отчёт, а не про данные под ним.',
  );
}

const period = attrData(attrs, 'period');
const status = attrData(attrs, 'status');
const factsLine = [
  period && `обновление: ${period}`,
  status && `статус: ${status}`,
]
  .filter(Boolean)
  .join(' · ');
if (factsLine) {
  out.push('');
  out.push(`АТРИБУТЫ DD: ${factsLine}`);
}

// Остальные атрибуты карточки — списком ИМЁН, без значений. Печатать всё
// подряд значит платить контекстом за служебное, а молча выбрасывать —
// ровно то, из-за чего владелец и канал поддержки полгода были невидимы:
// разведка искала владельца по угаданному списку слов, промахнулась
// и отчиталась, что владельца в каталоге нет.
{
  const shown = new Set(['report_developer', 'support_channel', 'developers_team',
                         'data_team', 'period', 'status']);
  const rest = (attrs && typeof attrs === 'object' ? Object.keys(attrs) : [])
    .filter((k) => !shown.has(k));
  if (rest.length) {
    out.push('');
    out.push(
      `ЕЩЁ АТРИБУТЫ В КАРТОЧКЕ (значения не запрашивались): ${rest.slice(0, 25).join(', ')}` +
        (rest.length > 25 ? ` и ещё ${rest.length - 25}` : '') + '.',
    );
  }
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
values_sql = code("Build values SQL", VALUES_SQL, [700, 200])

# Гейт: пустой SQL — значит слов не задали, или все поля исключены как
# чувствительные, или из URN не вывелось имя таблицы. Во всех трёх случаях
# запрос не отправляется, а причина уезжает в шейпер и печатается автору.
need_values = {
    "parameters": {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [
                {
                    "id": "has-sql",
                    "leftValue": "={{ $json.values_sql }}",
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
    "position": [880, 200],
    "id": "dd-need-values",
    "name": "Need values",
}

# Отказ Trino не должен ронять ответ: метаданные полей уже собраны, и ответ
# без значений лучше, чем отсутствие ответа. Текст отказа при этом доезжает
# до шейпера и печатается — «витрина до Trino не доехала» обязано отличаться
# от «таких значений нет», иначе автор пойдёт чинить не то.
dd_values = {
    # alwaysOutputData ОБЯЗАТЕЛЕН, и это не настройка удобства.
    #
    # n8n останавливает выполнение, если нода вернула НОЛЬ элементов, —
    # а ноль строк здесь нормальный исход: значений под слова заказчика
    # в данных может не быть. Без этого флага такой запрос убивал ВЕСЬ
    # «DD Lookup»: «Shape table meta» не выполнялся вовсе, и бот оставался
    # без инвентаря полей — при том, что каталог отработал полностью.
    # То есть ветка значений, задуманная как дополнение, отбирала основной
    # ответ. Живой прогон 2026-08-28: «No output data returned».
    "alwaysOutputData": True,
    "parameters": {"query": "={{ $json.values_sql }}", **copy.deepcopy(_TRINO["options"])},
    "type": _TRINO["type"],
    "typeVersion": _TRINO["typeVersion"],
    "position": [1060, 200],
    "id": "dd-values",
    "name": "dd_values",
    "credentials": copy.deepcopy(_TRINO["credentials"]),
    "onError": "continueRegularOutput",
}

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
        values_sql,
        need_values,
        dd_values,
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
            "main": [[{"node": "Build values SQL", "type": "main", "index": 0}]]
        },
        "Build values SQL": {
            "main": [[{"node": "Need values", "type": "main", "index": 0}]]
        },
        # Обе ветви IF ведут в шейпер, и это безопасно: они взаимоисключающие,
        # шейпер выполнится один раз. Опасен ПАРАЛЛЕЛЬНЫЙ вход с двух узлов,
        # которые выполняются оба, — из-за этого dd_column_summary и
        # dd_column_attrs и стоят цепочкой, а не рядом.
        "Need values": {
            "main": [
                [{"node": "dd_values", "type": "main", "index": 0}],
                [{"node": "Shape table meta", "type": "main", "index": 0}],
            ]
        },
        "dd_values": {
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
