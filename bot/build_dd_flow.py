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

# Credential для КАТАЛОГА DD. До 2026-09-03 им же ходили и GitLab-ноды —
# один Service Account на оба источника; теперь у GitLab своя учётка,
# GITLAB_CRED ниже.
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

# Credential для GITLAB — отдельный с 2026-09-03: в живом ядре «Get a file»
# переведён руками на «Spirit (Devplatform) MAIN», а каталог остался на Service
# Account Support (в тот же день DD отдавал инвентарь по двум витринам, то есть
# работает). Правка в интерфейсе живёт до следующего импорта — поэтому она
# здесь, а не только в n8n.
#
# id: None — НАМЕРЕННО, а не пробел. Учётка снята со скриншота, где виден
# только её заголовок; id живёт в URL карточки учётки и в экспорте живого
# воркфлоу, ни того ни другого в репозитории нет. n8n при импорте разрешает
# учётку так (useNodeHelpers.ts, matchCredentials, вызывается из addNode ←
# addImportedNodesToWorkflow; прочитано в n8n@1.100.0): сначала по id, и
# найденный id ПЕРЕБИВАЕТ имя; без id или с неизвестным id — единственная
# учётка этого типа с таким же именем. Оставь здесь старый id — импорт молча
# вернёт Service Account Support под новым именем. Имя обязано совпадать
# буква в букву; двух учёток с таким именем быть не должно, иначе нода
# приедет без учётки — это видно в n8n красным на ноде.
# Узнал id (карточка учётки в n8n или экспорт ядра) — впиши сюда вместо None.
GITLAB_CRED = {"devplatformApi": {"id": None,
                                 "name": "Spirit (Devplatform) MAIN"}}

# Модель LLM-прокси. ОДНО МЕСТО НА ВЕСЬ ПРОЕКТ, по той же причине, что
# и DP_CRED выше.
#
# До 2026-08-31 модель нигде не была записана: узел «T-Bank LLM proxy»
# копировался из «Support Bot.json» — снимка первой конструкции, — и через
# него алиас доезжал до всех четырёх узлов ядра. То есть значение жило
# в файле, который никто не правит, и поменять его можно было только руками
# в интерфейсе n8n, где правка живёт ровно до следующего импорта. Ровно тот
# же класс, что разъехавшийся Service Account и выключенная руками нода
# «Collect articles».
#
# Credential для прокси при этом отдельный: DP_CRED — это Devplatform
# (каталог и GitLab), а прокси ходит под openAiApi. Оба нормализуются здесь.
LLM_MODEL = "tgpt/text.instant.sota"
#
# С 2026-09-03 — «Tbank LLM Proxy bully» вместо «…account 70»: переведён руками
# в живом ядре. id неизвестен, None — по тем же правилам, что у GITLAB_CRED.
LLM_CRED = {"openAiApi": {"id": None,
                          "name": "Tbank LLM Proxy bully"}}

wf = json.load(open(SRC, encoding="utf-8"))

# ---------------------------------------------------------------- 1. чистка
# Неподключённая разведочная нода: свою роль выполнила, ключ columns известен.
wf["nodes"] = [n for n in wf["nodes"] if n["name"] != "HTTP Request"]

# Одна учётка на ИСТОЧНИК, включая ноды, унаследованные из исходника:
# GitLab-ноды (CUSTOM.gitlab, CUSTOM.gitlabTool) — GITLAB_CRED, каталог — DP_CRED.
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
        _is_gitlab = "gitlab" in str(_n.get("type", "")).lower()
        _n["credentials"] = copy.deepcopy(GITLAB_CRED if _is_gitlab else DP_CRED)

# Одна модель и один credential на все узлы прокси — включая унаследованные
# из исходника. Отсюда же их берёт build_time_flows: узел «T-Bank LLM proxy»
# собранного «Support Bot DD» служит образцом для четырёх узлов ядра,
# поэтому нормализовать надо здесь, а не в каждом сборщике по копии.
for _n in wf["nodes"]:
    if _n.get("type", "").lower().endswith("llmproxy"):
        _n["parameters"]["model"] = {
            "__rl": True,
            "value": LLM_MODEL,
            "mode": "list",
            "cachedResultName": LLM_MODEL,
        }
        _n["credentials"] = copy.deepcopy(LLM_CRED)

# ------------------------------------------------- 2. общие опции HTTP к DD
# Follow Redirects выключен: иначе редирект уводит на страницу логина.
# neverError + fullResponse: 404 по URN должен стать текстом для агента,
# а не падением инструмента.
DD_OPTS = {
    "redirect": {"redirect": {"followRedirects": False}},
    "response": {"response": {"fullResponse": True, "neverError": True}},
}

EF = ["displayName", "summary", "attributes"]



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

# ОПТОВАЯ РУЧКА ВМЕСТО 3N ЗАПРОСОВ — ИЗМЕРЕНО, А НЕ ВЫВЕДЕНО.
#
# Было: /related/columns за именами (1 запрос), потом /summary, /attribute
# и /related/full_column_sensitivity ПО КАЖДОЙ колонке — то есть 3 × 289 ≈ 870
# запросов на один вопрос пользователя в режиме поиска по смыслу.
#
# Фаза J разведки, прогон 2026-09-01 на mdm_employee_structure_d:
#
#   POST /entity/batch/related
#   {"urns":[<table urn>],"key":"columns",
#    "entityFields":["displayName","summary","attributes"],"limit":500}
#
#   → totalCount 289, пришло 289;
#     с непустым описанием  289 из 289;
#     с непустыми атрибутами 289 из 289;
#     ключи атрибутов: can_be_accessed, column_type, comment, jira, keys,
#                      ordinal_position, source, to_delete, versioning_type
#
# То есть `entityFields` на ОПТОВОЙ ручке работает, хотя на одиночной
# /related/columns игнорируется (это измерено 2026-08-06 и подтверждено
# снова). Описание эталонной колонки при этом СОВПАЛО с тем, что отдаёт
# одиночная /entity/{col}/summary, — и только это совпадение доказывает,
# что поле не проигнорировано молча: сервер отвечает 200 в обоих случаях,
# и по коду ответа «сработало» и «проигнорировано» неразличимы.
#
# Тело запроса — не догадка: схема `BatchRelatedEntitiesByKey` из
# спецификации OpenAPI (файл `openapi` в корне репозитория).
#
# limit 500, а не 100 по умолчанию: у витрины 289 колонок, а потолок,
# срабатывающий на выдаче, тихо превратил бы «столько полей у витрины»
# в «столько поместилось». Шейпер вдобавок сверяет totalCount с числом
# пришедших и называет расхождение.
BATCH_URL = "https://dd.t-tech.team/api/v3/entity/batch/related"


def post(name, body_expr, pos):
    """POST к каталогу с телом-выражением. onError/neverError — как у GET:
    отказ по одному объекту не должен ронять прогон целиком."""
    return {
        "parameters": {
            "method": "POST",
            "url": BATCH_URL,
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "devplatformApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": body_expr,
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


columns = post(
    "dd_columns_bulk",
    "={{ JSON.stringify({ urns: [$('When called by agent').first().json.urn], "
    "key: 'columns', entityFields: ['displayName', 'summary', 'attributes'], "
    "limit: 500 }) }}",
    [480, 200],
)

# ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ — ЭТО СВЯЗЬ, А НЕ АТРИБУТ. Измерено фазой I
# разведки 2026-09-01, а не выведено:
#
#   GET /entity/{column_urn}/related → ключи связей колонки:
#     jira_issues, master_column, physical_colums, foreign_key_columns,
#     full_column_sensitivity
#
# А /attribute у той же колонки отдаёт can_be_accessed, column_type,
# comment, keys, ordinal_position и прочее — и ничего про чувствительность.
# Полтора месяца шейпер искал признак ровно там и писал «признака нет
# ни у одного из N полей. Считать эти поля открытыми НЕЛЬЗЯ» — то есть
# выдавал промах ключа за факт про данные, и оговорка уезжала в КАЖДЫЙ
# черновик.
#
# Оптом это тоже работает — измерено фазой J 2026-09-01:
#   отправлено 120 URN → 120 ключей в ответе, у 40 колонок признак есть.
#   Ярлыков пять видов: EMP, EMP_INDIR, EMP_INFO, EMP_SENS, EMP_DOC.
#
# СВЕРКА ТУТ ДВОЙНАЯ, и вторая половина важнее первой: ключей в ответе
# обязано быть столько же, сколько URN отправлено. Меньше — значит по части
# колонок ответа нет вовсе, а молчание по колонке неотличимо от «поле
# открыто». На такую ручку отсев по чувствительности переводить нельзя,
# и шейпер говорит это прямым текстом вместо «признака нет».
#
# ЧАНК 120 — ЭТО ИЗМЕРЕННЫЙ РАЗМЕР, А НЕ КРУГЛОЕ ЧИСЛО. Прогон подтвердил
# ровно 120 URN в одном теле; что 289 тоже пройдут — неизвестно, и
# экстраполировать измерение на втрое больший объём значило бы получить
# отказ, по виду неотличимый от «признака нет». Три запроса вместо одного
# здесь ничего не стоят.
column_sens = post(
    "dd_columns_sens",
    "={{ $json.sens_body }}",
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

// СЛОВА ФРАЗЫ ИЩУТСЯ ОТДЕЛЬНО ОТ САМОЙ ФРАЗЫ.
//
// needlesOf режет только по запятым, поэтому «BI-аналитик» уезжал в запрос
// целиком: `LIKE '%bi-аналитик%'`. В витрине значение записано иначе —
// «Бизнес-аналитик BI», — и совпадений ноль при том, что данные есть.
// Искать надо по «аналит»: тогда видно и как специализация называется
// на самом деле, и какие ещё есть рядом.
//
// Фраза при этом остаётся: точное совпадение ценнее приблизительного,
// а список альтернатив в OR ничего не теряет — он только добавляет.
function valueNeedles(raw) {
  const out = [];
  const add = (w) => { if (w && !out.includes(w)) out.push(w); };
  // Режем СЫРУЮ фразу, а основу считаем ОДИН раз. Иначе «аналитик»
  // превращался в «аналит», потом ещё раз в «анал» — четыре буквы, которые
  // совпадут с чем угодно и утопят полезное. Стемминг не идемпотентен,
  // и применять его дважды нельзя.
  for (const phrase of String(raw || '').toLowerCase().split(/[,;\n]+/)) {
    const p = phrase.trim();
    if (!p) continue;
    add(needlesOf(p)[0] || p);
    for (const part of p.split(/[\s\-–—_/]+/)) {
      // Короче трёх символов не берём — «bi» совпадёт с половиной справочника.
      if (part.length < 3) continue;
      add(needlesOf(part)[0] || part);
    }
  }
  return out;
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
// ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ РАЗБИРАЕТСЯ В `sensOf()` НИЖЕ, А НЕ ЗДЕСЬ.
//
// Полтора месяца он искался среди АТРИБУТОВ колонки — по списку явных
// ключей плюс эвристике по имени. Фаза I разведки 2026-09-01 показала, что
// в `/attribute` его нет вовсе: там can_be_accessed, column_type,
// data_contract_*, ordinal_position, systems, to_delete. Признак приходит
// СВЯЗЬЮ `full_column_sensitivity` (RESTRICTS, dest_src).
//
// Перебор ключей и эвристика удалены целиком, а не оставлены «запасом»:
// второй источник признака — это второй ответ на один вопрос, и разъехаться
// им нечем только так. Правило проекта про копии знания действует и здесь.


// СТАТУС ИЗМЕРЕН — И ОН ОБЯЗАН ДОЖИТЬ ДО ЯДРА, А НЕ ТОЛЬКО ДО ТЕКСТА.
//
// `httpFail` был ЕДИНСТВЕННЫМ носителем кода ответа: он превращал 401/404/500
// в русскую фразу, а число выбрасывал. Дальше ядро вылавливало из этой фразы
// регуляркой `/ОШИБКИ DD/` один бит — «что-то не так» — и на нём строило
// диагноз джуну. На любом новом виде отказа (5xx, таймаут, пустой ключ связи)
// диагноз оказывался неверен и отправлял чинить не то: 404 это строка
// реестра, 401 — Service Account, 500 — каталог лежит и надо ретраить,
// и это три разных действия.
//
// Теперь фраза остаётся в тексте для автора, а ЧИСЛО уезжает структурой.
const HTTP_LOG = [];
function httpFail(res, label) {
  const code = res && res.statusCode;
  if (code !== undefined) HTTP_LOG.push({ req: label, status: code });
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
const colRes = $('dd_columns_bulk').first().json;

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

// ОПТОВЫЙ ОТВЕТ — СЛОВАРЬ «urn → {totalCount, data}», а не список.
//
// Форма подтверждена спецификацией (`BatchRelatedEntitiesResponse`)
// и прогоном фазы J 2026-09-01: ключей столько, сколько URN отправлено.
// Берём свой ключ ПО URN, а не первый попавшийся: сегодня объект один,
// но «первый» — это заложенная тихая ошибка на день, когда их станет два.
const batchBody = (colRes && colRes.body) || colRes || {};
const colBody = (batchBody && typeof batchBody === 'object' && !Array.isArray(batchBody))
  ? (batchBody[urn] || batchBody[Object.keys(batchBody)[0]] || {})
  : {};

// Теперь ОДИН ответ несёт и имена, и описания, и атрибуты: entityFields
// на оптовой ручке работает (измерено фазой J 2026-09-01 — 289 из 289
// с описаниями и атрибутами). Раньше имена приходили из /related/columns,
// а описания — двумя запросами НА КАЖДУЮ колонку, и пары держались
// индексом.
const colNodes = nodesOf(colBody);
const rows = colNodes
  .map((c) => ({
    field: shortName(c),
    type: typeOf(c),
    desc: oneLine(descOf(c)),
  }))
  .filter((r) => r.field);

const total = rows.length;

// Описания и атрибуты отобранных колонок — ИЗ ТОГО ЖЕ ОДНОГО ОТВЕТА.
//
// Было: два запроса на колонку (/summary и /attribute), и ни один из них
// не нёс имени поля — пары держались ИНДЕКСОМ по списку `Pick columns`.
// Стало: имя, описание и атрибуты лежат в одном элементе. Индексного
// сопоставления не осталось нигде, и это не оптимизация, а снятие целого
// класса тихих ошибок: сдвиг на единицу приписывал бы описание соседнему
// полю, и по виду ответа это неотличимо от нормы.
let pick = {};
try { pick = $('Pick columns').first().json || {}; } catch (e) { pick = {}; }

// Какие колонки печатать ПОДРОБНО. Решает `Pick columns` по режиму,
// и решение это теперь чисто про ТОКЕНЫ: фетч от него не зависит вовсе,
// описания приходят по всем колонкам одним запросом в любом режиме.
// Пустой список значит «все» — так ведёт себя by_meaning.
const wanted = Array.isArray(pick.targets) ? pick.targets.map(String) : [];
const wantedSet = new Set(wanted);

// Чувствительность приходит СВЯЗЬЮ `full_column_sensitivity`, а не атрибутом
// (измерено фазой I разведки 2026-09-01), и ОПТОМ — чанками по 120 URN
// (измерено фазой J: 120 отправлено, 120 ключей в ответе, у 40 признак
// есть). Ответ каждого чанка — словарь «urn колонки → связи», поэтому
// сопоставление идёт ПО КЛЮЧУ, а не по порядку.
const sensByUrn = new Map();
let sensAnswered = 0;
let sensFailed = '';
try {
  for (const it of $('dd_columns_sens').all().map((i) => i.json)) {
    const bad = httpFail(it, 'чувствительность колонок');
    if (bad) { sensFailed = sensFailed || bad; continue; }
    const b = (it && it.body) || it || {};
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    for (const k of Object.keys(b)) {
      if (!sensByUrn.has(k)) sensAnswered += 1;
      sensByUrn.set(k, b[k]);
    }
  }
} catch (e) { /* ветки чувствительности в прогоне не было */ }
const sensAsked = Number(pick.sens_asked) || 0;

// СВЕРКА, БЕЗ КОТОРОЙ МОЛЧАНИЕ ПО КОЛОНКЕ НЕОТЛИЧИМО ОТ «ПОЛЕ ОТКРЫТО».
// Спросили 289 URN, ответ пришёл по 120 — про остальные мы не знаем ничего,
// и печатать их как незакрытые нельзя. Это ФАКТ про ответ, а не причина:
// почему ручка ответила не по всем, отсюда не видно, и выдумывать нельзя.
const sensPartial = sensAsked > 0 && sensAnswered < sensAsked;

const details = colNodes
  .map((c) => {
    const cUrn = String((c && c.urn) || '');
    // `attrData` ждёт САМ словарь атрибутов, `typeOf` — объект с полем
    // `attributes`. Перепутать их легко и тихо: обёртка вместо словаря
    // даёт пустой комментарий и пустые ключи, а по виду ответа это ровно
    // то же, что незаполненная карточка.
    const attrs = (c && c.attributes) || {};
    return {
      field: shortName(c),
      urn: cUrn,
      type: typeOf(c),
      desc: oneLine(descOf(c)),
      // comment у колонки — развёрнутое пояснение, часто важнее краткого
      // summary: именно там описаны границы генерации business_dt и подобные
      // ловушки. Ключ подтверждён прогоном фазы J — в атрибутах колонки
      // приходят can_be_accessed, column_type, comment, jira, keys,
      // ordinal_position, source, to_delete, versioning_type.
      comment: oneLine(attrData(attrs, 'comment')),
      keys: attrData(attrs, 'keys'),
      // Ярлык берём тем, что есть: displayName, иначе хвост fqn, иначе
      // хвост urn. Угадывать структуру нельзя — печатаем то, что пришло.
      access: sensByUrn.has(cUrn) ? sensOf({ body: sensByUrn.get(cUrn) }) : null,
      // Спросили и не получили ответа по этой колонке — это НЕ «поле
      // открыто». Признак отдельный, потому что слитые вместе они дают
      // самый дорогой из возможных ответов: уверенное «согласование
      // не нужно» на чувствительном поле.
      sens_unknown: sensAsked > 0 && !sensByUrn.has(cUrn),
      // Отказа ПО ОТДЕЛЬНОЙ КОЛОНКЕ больше не бывает: описания приходят
      // одним запросом на всю витрину, и он либо ответил, либо нет —
      // и тогда это ошибка уровня таблицы, она уже в problems.
      failed: '',
    };
  })
  .filter((d) => d.field && (!wantedSet.size || wantedSet.has(d.field)));

// Сколько колонок у объекта по мнению DD. Расходится с числом полученных —
// значит, ответ обрезан лимитом и нужна пагинация по afterUrn.
const declared =
  colBody && typeof colBody === 'object' && Number.isFinite(colBody.totalCount)
    ? colBody.totalCount
    : null;

// ПОЛЯ БЕЗ ОПИСАНИЯ — ТЕПЕРЬ ЭТО ОДНА ВЕЩЬ, А НЕ ДВЕ.
//
// Раньше «описание не пришло» и «описание не заполнено» были разными
// случаями: описания тянулись запросом НА КАЖДУЮ колонку, и отдельный
// запрос мог отказать. Теперь описания приходят одним запросом на всю
// витрину — он либо ответил по всем колонкам, либо не ответил вовсе,
// и второе это ошибка уровня таблицы, она уже в `problems`.
//
// Значит пустое описание у поля означает ровно одно: владелец его
// не заполнил. Это не пробел базы и не повод для тревоги — описывать
// чужую витрину некому.
const cardsFailed = details.filter((d) => !d.desc && !d.comment);

// Полный инвентарь имён: печатается и как самостоятельный ответ на пустой
// search, и как подсказка, когда фильтр ничего не нашёл.
// `hadCards` — СПРАШИВАЛИ ЛИ ЧУВСТВИТЕЛЬНОСТЬ, а не «читались ли карточки».
// Описания теперь приходят всегда и по всем колонкам, а вот связь
// full_column_sensitivity — отдельный запрос, и его в прогоне могло
// не быть. Строка про группы доступа обязана различать «спросили,
// признака нет» и «не спрашивали»: слитые вместе, они дают самый дорогой
// из возможных ответов — уверенное «согласование не нужно» на закрытом поле.
const hadCards = sensAnswered > 0;

// ПОЛНЫЙ СПИСОК ИМЁН ПЕЧАТАЕТСЯ ВСЕГДА, А НЕ ТОЛЬКО КОГДА НИЧЕГО НЕ СОВПАЛО.
//
// Раньше inventory() вызывался из двух мест, и оба — ветки промаха фильтра.
// То есть стоило фильтру хоть что-то найти, и полный состав таблицы автор
// не видел вовсе. Живой прогон 2026-08-31, выгрузка: по смыслу совпало
// 53 поля, и в ТЗ бот написал «поле «должность» не вошло в список из 53
// найденных по смыслу полей. Либо его нет в витрине, либо оно скрыто
// лимитом. Состав полей неполный — нужно получить полный инвентарь».
// Никакого лимита на 53 не было — 53 это число СОВПАВШИХ, — а инвентарь
// у шейпера всё это время лежал на руках: `rows` строится из dd_columns
// в любом режиме. Автору просто нечем было проверить, есть ли поле.
//
// Цена печати — ноль HTTP-запросов и ~3 КБ на 289 имён. Цена молчания —
// «поля нет в витрине» там, где оно есть, и в режиме выгрузки на этом
// отрицании строится раздел про то, чего не будет в файле.
// `withAccess` — печатать ли сводку по чувствительности. Она уже печатается
// в конце detailBlock(), и когда инвентарь идёт СЛЕДОМ за блоком подробностей,
// вторая копия читалась бы как второй, другой ответ про те же поля.
function inventory(reason, withAccess = true) {
  out.push('');
  out.push(reason);
  out.push('');
  // ИМЯ И ОПИСАНИЕ, А НЕ ГОЛЫЙ СПИСОК ИМЁН.
  //
  // Описания приходят тем же ответом и раньше ВЫБРАСЫВАЛИСЬ — «чтобы список
  // пришёл целиком». Довод был про токены, а он в этом проекте снят отдельно
  // и измеренно: запас по контексту тридцатикратный, потолки ограничивают
  // число запросов и внимание автора, а не контекст.
  //
  // Цена выбрасывания видна на живом прогоне 01.09: в запросе стояло
  // `, disability_flg` без комментария — подписать поле было НЕЧЕМ, кроме
  // догадки, а догадка в комментарии к полю это ровно то, от чего здесь
  // защищаются везде. `full_nm` бот подписал «ФИО» только потому, что имя
  // говорит само за себя; на `disability_flg` такого везения не было.
  //
  // Потолок на объём: список из 289 полей с описаниями — это уже не 3 КБ,
  // и обрезка обязана быть НАЗВАННОЙ. Молча укоротить список значит вернуть
  // ровно тот отказ, из-за которого инвентарь и печатается целиком:
  // «поля нет в витрине» там, где оно есть.
  const INV_MAX = 24000;
  const withDesc = rows.map((r) => r.desc ? `${r.field} — ${r.desc}` : r.field);
  const joined = withDesc.join('\n');
  if (joined.length <= INV_MAX) {
    out.push(joined);
  } else {
    out.push(rows.map((r) => r.field).join(', '));
    out.push('');
    out.push(
      `ОПИСАНИЯ НЕ ПОКАЗАНЫ: с ними список занял бы ${joined.length} символов ` +
        `при потолке ${INV_MAX}. Имена полные, ни одно не пропало. ` +
        'Подписывать поля комментарием по догадке НЕЛЬЗЯ — пиши ' +
        '«описания в каталоге не смотрели».',
    );
  }
  out.push('');
  // СОВЕТ СХОДИТЬ В КАТАЛОГ ПОВТОРНО — МЁРТВЫЙ, И ОН ВРЕДЕН.
  //
  // Он остался от tool-loop, где у агента были инструменты и вторая
  // итерация. В конвейере вызов ОДИН, у автора инструментов нет, и второго
  // круга не будет никогда. Шейпер вдобавок не знает, кто его читает.
  // Совет, который нельзя выполнить, автор либо игнорирует, либо
  // пересказывает заказчику как «нужен ещё один запрос» — то есть выдаёт
  // ограничение бота за пробел данных.
  out.push(
    'Это ПОЛНЫЙ состав витрины: по нему видно и то, есть ли поле, и что ' +
      'в нём лежит. Описание — из каталога; поля без описания владелец ' +
      'не заполнил, и придумывать его за него нельзя.',
  );
  // Признак закрытости приходит ОТДЕЛЬНЫМ запросом — связью
  // full_column_sensitivity, — и его в прогоне могло не быть. Сказать
  // об этом обязательно: иначе «в метаданных про закрытость ничего нет»
  // прочитается как «поля открыты», и в согласование с заказчиком уедет
  // состав, половину которого выдать нельзя.
  if (!withAccess) return;
  out.push('');
  if (hadCards) {
    // Признак пришёл — значит сводка по нему честнее, чем «не спрашивали».
    accessBlock(details);
  } else {
    out.push(
      'ГРУППЫ ДОСТУПА: не запрашивались. Признак закрытости приходит ' +
        'отдельным запросом, и в этом прогоне его не было. Считать поля ' +
        'открытыми по этому ответу НЕЛЬЗЯ.',
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
        `  ЧУВСТВИТЕЛЬНОЕ ПОЛЕ (${d.access.groups}) — просто так ` +
          'не выгружается, нужен доступ и согласование',
      );
    }
  }
  accessBlock(list);
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
// СЛУЖЕБНЫЕ КОЛОНКИ — НЕ ДАННЫЕ, И ТРЕВОГИ ИЗ-ЗА НИХ НЕ ПОДНИМАЮТСЯ.
//
// У витрин из внешних систем половина состава — техника шины и ETL:
// `__contract__`, `__offset__`, `__partition__`, `__timestamp__`, `__topic__`,
// `__instance_id__`, `processed_dttm`. Владелец их не описывает и не будет:
// это не поля предметной области, заказчику они не нужны никогда.
//
// Живой прогон 2026-08-31: по витрине детей девять таких колонок остались
// без описаний, шейпер объявил «9 полей НЕПРОВЕРЕНЫ, среди них искомое
// вполне может быть», автор поставил среднюю уверенность и попросил
// «подтвердить состав полей» — при том что ВСЕ поля про детей описаны
// и ответа хватало полностью. Тревога, которая горит на исправном ответе,
// обесценивает и себя, и соседние.
function isTech(name) {
  const f = String(name || '');
  return /^__.*__$/.test(f) ||
    /^(processed_dttm|__src_processed_dttm__|etl_|dl_|kafka_)/.test(f);
}

// Разбор ответа `/related/full_column_sensitivity`.
//
// Пусто — значит признака у поля нет, и это ФАКТ, а не «не спросили»:
// запрос сделан, ответ получен. Отказ ручки — третье состояние, и его
// нельзя выдавать за «поле открыто».
function sensOf(res) {
  if (res === undefined || res === null) return { known: false, groups: '' };
  const code = res && res.statusCode;
  if (code !== undefined && code >= 400) {
    return { known: false, groups: '', failed: `HTTP ${code}` };
  }
  const body = (res && res.body) || res || {};
  const items = nodesOf(body);
  const labels = items
    .map((e) => {
      const dn = String((e && e.displayName) || '').trim();
      if (dn) return dn;
      const fqn = String((e && e.fqn) || '').trim();
      if (fqn) return fqn.split('.').pop();
      const urn = String((e && e.urn) || '').trim();
      return urn ? urn.split(':').pop() : '';
    })
    .filter(Boolean);
  return { known: true, groups: labels.join(', '), key: 'full_column_sensitivity' };
}

function accessBlock(list) {
  const answered = list.filter((d) => d.access && d.access.known);
  const closed = answered.filter((d) => d.access.groups);
  out.push('');
  if (!answered.length) {
    // Запрос признака НЕ ПРОШЁЛ ни по одной колонке: ручка отказала либо
    // узел не выполнялся. Это НЕ «поля открыты» и НЕ «признака нет» —
    // мы про них просто ничего не узнали.
    //
    // Формулировка без тревоги: строка, которая горит на каждом ответе,
    // перестаёт читаться. Запрет на персональные данные держится сам
    // по себе — по смыслу поля, а не по признаку каталога.
    const why = list.map((d) => d.access && d.access.failed).filter(Boolean)[0];
    out.push(
      'ЧУВСТВИТЕЛЬНОСТЬ: спросить не удалось' + (why ? ` (${why})` : '') +
        '. Это не значит «поля открыты»: если поле по смыслу персональное — ' +
        'ФИО, телефон, почта, документы, дата рождения, — помечай его ' +
        'как требующее согласования доступа по имени и смыслу.',
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
    `  Признак взят из связи «${key}» (RESTRICTS). Поля, не названные здесь, по данным ` +
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
  // ОТВЕТ ПРИШЁЛ НЕ ПО ВСЕМ СПРОШЕННЫМ URN. Это факт про ответ ручки,
  // и он важнее предыдущей строки: там «не спрашивали», здесь «спросили
  // и не ответили». Молчание по колонке неотличимо от «поле открыто»,
  // поэтому оно НАЗЫВАЕТСЯ, а причина не выдумывается — почему ручка
  // ответила не по всем, из ответа не видно.
  if (sensPartial) {
    out.push(
      `  ВНИМАНИЕ: признак спрошен по ${sensAsked} полям, ответ пришёл ` +
        `по ${sensAnswered}. По остальным каталог промолчал, и молчание ` +
        'тут НЕ значит «поле открыто».',
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
    // ОПИСАНИЯ ТЕПЕРЬ ПРИХОДЯТ ПО ВСЕМ ПОЛЯМ ОДНИМ ЗАПРОСОМ.
    //
    // Раньше здесь считались два разных остатка — по каким полям карточка
    // ОТКАЗАЛА и по каким её не запрашивали, — потому что запрос шёл
    // на каждую колонку и мог отказать поштучно. Оптовая ручка отвечает
    // либо по всей витрине, либо никак: поштучных отказов не бывает,
    // и «не запрашивали» тоже — потолков в фетче не осталось.
    //
    // Остаётся ровно одна честная величина: у скольких полей описание
    // реально ЕСТЬ. Пустое описание — это незаполненность у владельца,
    // а не наш промах, и тревоги она не стоит (см. блок ниже).
    const answered = details;
    const withDesc = details.filter((d) => d.desc || d.comment).length;
    const matched = details.filter(
      (d) =>
        matchesAny(d.field, needles) ||
        matchesAny(d.desc, needles) ||
        matchesAny(d.comment, needles),
    );
    out.push('');
    // Формулировка факта, а не действия: «искали по описаниям» осталось
    // от того времени, когда код фильтровал описания под hint. Он больше
    // не фильтрует и не ищет — он приносит.
    out.push(
      `ЗАПРОШЕНЫ ОПИСАНИЯ ВСЕХ ПОЛЕЙ (в вопросе было «${inp.search}»): ` +
        `каталог ответил по ${details.length} из ${totalCols}, ` +
        `описание заполнено у ${withDesc}. Ниже они ВСЕ.`,
    );
    // Блока «не проверены описания у N полей» здесь больше НЕТ, и это
    // не потеря сигнала, а исчезновение самого случая: оптовая ручка
    // отвечает по всей витрине сразу, потолков в фетче не осталось,
    // и полей, до которых «не долистали», не бывает. Расхождение
    // `details.length` с `totalCols` печатается строкой выше — если оно
    // когда-нибудь появится, оно будет названо числом, а не молчанием.
    // КАРТОЧКИ ПРОЧИТАНЫ — ЗНАЧИТ ПОКАЗЫВАЕМ ИХ ВСЕ, А НЕ ОТФИЛЬТРОВАННЫЕ.
    //
    // Это главная правка 2026-09-01, и она закрывает КЛАСС отказов,
    // а не случай.
    //
    // Было: код читал карточки ВСЕХ колонок (то есть уже заплатил за них
    // запросами), а потом ВЫБРАСЫВАЛ описания, не совпавшие с hint
    // подстрокой, и печатал «не встретилось ни в одном из N проверенных
    // описаний». То есть КОД выносил суждение о СМЫСЛЕ — сопоставлял
    // русское слово заказчика с латинским именем поля и свободным текстом
    // владельца — и объявлял отсутствие того, чего установить не может.
    //
    // Оно и не могло работать. Живой прогон: hint «дети, возраст детей»,
    // в витрине поле `birthdate` с описанием «Дата рождения ребёнка».
    // Подстрокой «возраст» с «Дата рождения» не совпадает никогда,
    // стемминг тут не помогает — это разные слова одного понятия.
    // Тот же промах ждёт «уволенные»→`company_fire_flg`,
    // «руководитель»→`head_*`, «стаж»→`hire_dt`, «декрет»→`active_type_nm`:
    // сопоставление по буквам между языком заказчика и языком витрины
    // обречено по построению.
    //
    // Разделение ответственности в проекте звучит так: КОД решает то, что
    // является ФАКТОМ (срез, лимиты, запрет ПДн, число полей), а МОДЕЛЬ —
    // то, что является суждением о смысле. Здесь код взялся за смысл.
    //
    // Цена показа всех карточек — нулевая: запросы уже сделаны, а текст
    // 25 описаний это ~2 КБ, 289 описаний — десятки килобайт при окне
    // ~1 000 000 токенов. Платить нечем, а терять — есть чем.
    out.push('');
    out.push(
      `ОПИСАНИЯ ПОЛЕЙ ПРОЧИТАНЫ: ${details.length} из ${totalCols}. Ниже они ВСЕ — ` +
        'выбирай подходящее по смыслу сам. Совпадение по буквам код ' +
        'не проверяет и отсутствие поля не объявляет: «возраст ребёнка» ' +
        'и «Дата рождения ребёнка» — одно понятие, а подстрокой они ' +
        'не совпадают.',
    );
    detailBlock(answered);
    if (matched.length) {
      // Совпадение по буквам оставлено ПОДСКАЗКОЙ, а не фильтром: иногда
      // оно попадает точно, и тогда автору стоит посмотреть туда первым.
      out.push('');
      out.push(
        `Подсказка: по буквам с «${inp.search}» совпали ` +
          matched.map((d) => d.field).join(', ') +
          '. Это НЕ значит, что нужное поле среди них, и НЕ значит, ' +
          'что его нет среди остальных — смотри описания выше целиком.',
      );
    }
    inventory(
      'ВСЕ ПОЛЯ ТАБЛИЦЫ (имена) — по этому списку и только по нему можно ' +
        'говорить, есть в витрине поле или нет:',
      false,
    );
  } else {
    const hit = rows.filter((r) => matchesAny(r.field, needles));
    out.push('');
    out.push(`ПОЛЯ ПО ИМЕНИ «${inp.search}»: ${hit.length} из ${total}`);

    if (pick.wide_filter) {
      // Фильтр совпал больше чем с половиной таблицы — он ничего не сужает,
      // и читать по карточке на каждое поле бессмысленно. Инвентарь честнее.
      // Совет «сходи в каталог ещё раз с фильтром» тут был мёртвым по той
      // же причине, что и выше: в конвейере вызов ОДИН, инструментов
      // у автора нет.
      // Остаётся ФАКТ — описания не запрашивались, и почему.
      inventory(
        `Фильтр «${inp.search}» совпал с ${hit.length} полями из ${total}, ` +
          'то есть больше чем с половиной таблицы — по такому фильтру ' +
          'описания не запрашивались. Ниже полный перечень имён; ' +
          'об отсутствии поля судить можно только по нему.',
      );
    } else if (!hit.length) {
      inventory(
        `Ни одно из ${total} имён полей не совпало с «${inp.search}» ` +
          'по буквам. Про СМЫСЛ это не говорит ничего: имена латиницей, ' +
          'а понятие названо по-русски. Смотри полный перечень ниже ' +
          'и выбирай по смыслу сам; похожее наугад не подставляй.',
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
      inventory(
        'ВСЕ ПОЛЯ ТАБЛИЦЫ (имена, без описаний) — по этому списку и только ' +
          'по нему можно говорить, есть в витрине поле или нет:',
        false,
      );
    }
  }
}

// Отказы по карточкам колонок — в конце, но обязательно. Формулировка
// осторожная намеренно: «описание получить не удалось», а не «владелец
// не заполнил» — второе это утверждение о владельце, которого мы
// не проверяли (отдельное правило промпта).
// ОТСУТСТВИЕ ОПИСАНИЯ — НЕ ПРОБЕЛ И НЕ ПОВОД ДЛЯ ТРЕВОГИ.
//
// Мы не владельцы витрины: описывать её поля не наша работа и не работа
// джуна, который читает черновики. Значит «описание не получено» — это
// просто факт про инвентарь, а не задача, не пробел базы и не основание
// снижать уверенность. Отвечаем по тем полям, что описаны; если для задачи
// их хватило — ответ полный.
if (cardsFailed.length) {
  const tech = cardsFailed.filter((d) => isTech(d.field));
  const real = cardsFailed.filter((d) => !isTech(d.field));
  out.push('');
  if (real.length) {
    out.push(
      `БЕЗ ОПИСАНИЯ ${real.length} полей: ` +
        real.map((d) => d.field || '?').slice(0, 20).join(', ') +
        (real.length > 20 ? ' и другие' : '') +
        '. Это нормально: описания заполняет владелец витрины, и не все ' +
        'поля у него описаны. Отвечай по описанным. Уверенность из-за ' +
        'этого НЕ снижай и в «ЧЕГО НЕ ХВАТИЛО» не пиши — заводить описания ' +
        'чужой витрины некому.',
    );
  }
  if (tech.length) {
    out.push(
      `Служебных колонок без описания: ${tech.length} (${tech.map((d) => d.field)
        .slice(0, 8).join(', ')}${tech.length > 8 ? ' и другие' : ''}) — ` +
        'техника шины и ETL, к предметной области отношения не имеет, ' +
        'заказчику не нужна и в ответе не упоминается.',
    );
  }
}

out.push('');
out.push(
  'НАПОМИНАНИЕ: это инвентарь из DD — состав полей и, если каталог их отдал, ' +
    'типы и описания. Гранулярность, правила джойна, тип среза и запреты — ' +
    'в статье kb/tables/.',
);

// СОСТАВ ПОЛЕЙ УЕЗЖАЕТ ДАННЫМИ, А НЕ ТОЛЬКО ТЕКСТОМ.
//
// Текст `dd_meta` пишется для МОДЕЛИ, и формат его меняется свободно —
// заголовки, режимы, пояснения. А ядру нужен список полей, и оно до сих
// пор выковыривало его из этого же текста регуляркой. Формат печатает одна
// нода, читает другая, и разъехаться они могут МОЛЧА: 2026-08-31 каталог
// отдал 25 полей витрины детей, а разбор увидел ноль, и двое суток отказ
// выглядел молчанием каталога.
//
// Чинить это правкой регулярки бессмысленно — правка закрывает один случай
// и оставляет класс. Поле `dd_fields` убирает разбор текста как таковой:
// ядро больше не парсит ничего, оно читает список. `dd_total` рядом —
// чтобы «пришло меньше, чем есть» было видно без счёта строк.
// КОНТРАКТ НА ВЫХОДЕ: ДАННЫЕ РЯДОМ С ТЕКСТОМ, А НЕ ВМЕСТО НЕГО.
//
// `dd_meta` — текст ДЛЯ АВТОРА, его формат меняется свободно. Всё, что
// нужно КОДУ, едет структурой `dd`: состав полей с описаниями, статусы
// запросов, режим, сколько карточек заказано и сколько пришло.
//
// Пока факт существовал только как формулировка внутри `dd_meta`, каждый
// потребитель в ядре разгадывал его своей регуляркой, и любая правка текста
// молча ослепляла соседа. `dd_fields`/`dd_total` были половиной этого
// контракта, сделанной под давлением одного кейса.
return [{ json: {
  dd_meta: out.join('\n'),
  // Совместимость: ядро могло не переимпортироваться, а старые поля читают
  // и «Build lookups», и «Build materials».
  dd_fields: rows.map((r) => r.field),
  dd_total: total,
  dd: {
    ok: !problems.length,
    object_type: 'table',
    urn,
    http: HTTP_LOG,
    total,
    declared,
    mode: (() => { try { return $('Pick columns').first().json.mode || 'none'; }
                   catch (e) { return 'none'; } })(),
    // Описания приходят ОДНИМ запросом по всем колонкам, поэтому «сколько
    // заказано» и «сколько пришло» больше не про карточки: заказано —
    // сколько полей у витрины, пришло — у скольких есть описание или
    // комментарий. Имена полей оставлены прежними: их читает витрина
    // телеметрии, и переименование стоило бы молча пустой колонки.
    cards_requested: total,
    cards_received: rows.filter((r) => r.desc).length,
    // Чувствительность: сколько URN спрошено и по скольким пришёл ответ.
    // Расхождение — это не «поля открыты», см. sensPartial.
    sens_asked: sensAsked,
    sens_answered: sensAnswered,
    sens_partial: sensPartial,
    sens_failed: sensFailed,
    // Поля СО ВСЕМ, что каталог о них сказал. Ядру нужны имена, автору —
    // описания, проверке значений — чувствительность; собирать это по трём
    // регуляркам из одного текста значит завести три способа ошибиться.
    fields: rows.map((r) => {
      const d = details.find((x) => x.field === r.field);
      return {
        name: r.field,
        type: (d && d.type) || r.type || '',
        desc: (d && d.desc) || r.desc || '',
        comment: (d && d.comment) || '',
        keys: (d && d.keys) || '',
        sensitive: Boolean(d && d.access && d.access.known && d.access.groups),
        sensitivity: (d && d.access && d.access.groups) || '',
        // «ok» — описание пришло (даже пустое: запрос ответил по этой
        // колонке); «not_asked» — колонка не попала в подробный блок.
        // Отказа по ОТДЕЛЬНОЙ колонке больше не бывает: запрос один.
        card: d ? 'ok' : 'not_asked',
      };
    }),
  },
} }];
"""


PICK_COLUMNS = COMMON_JS + r"""
// ЭТА НОДА БОЛЬШЕ НЕ РЕШАЕТ, ЧТО ЗАПРАШИВАТЬ. ОНА РЕШАЕТ, ЧТО ПЕЧАТАТЬ.
//
// Раньше от неё зависел фетч: она отбирала колонки, и по каждой уходило
// ТРИ запроса (/summary, /attribute, /related/full_column_sensitivity) —
// на витрине в 289 полей это ~870 запросов на один вопрос. Отсюда росли
// все потолки этой ноды: MAX_CARDS = 12, ALL_CARDS_CAP = 60, и каждый
// из них резал МОЛЧА, так что «не встретилось» читалось как «такого поля
// нет». Оба сняты по этой причине, порознь и задним числом.
//
// Фаза J разведки 2026-09-01 измерила оптовую ручку: описания и атрибуты
// ВСЕХ 289 колонок приходят ОДНИМ запросом. Значит вопроса «за что платить
// запросами» больше не существует — описания на руках всегда и по всем
// полям, в любом режиме.
//
// Остался ровно один вопрос, и он про ТОКЕНЫ: печатать подробно все поля
// или только совпавшие. Он не тот же самый, и путать их нельзя: раньше
// непечатание значило, что данных НЕТ, теперь — что они есть и придержаны.
// Поэтому режимы сохранены как есть, а не расширены «раз уж бесплатно»:
// расход на вопрос ≈ 26 000 токенов при окне ~1 000 000, но упирается
// не окно, а TPM аккаунта (~240 000 в минуту), то есть ЧИСЛО ОБРАЩЕНИЙ
// в утренний пик. Менять это надо по измеренному materials_len, а не
// заодно с правкой фетча.
const inp = $('When called by agent').first().json;
const needle = String(inp.search || '').trim().toLowerCase();
const needles = needlesOf(inp.search);

// Оптовый ответ — словарь «urn → {totalCount, data}». Форма из спецификации
// (BatchRelatedEntitiesResponse) и подтверждена прогоном фазы J.
const bulkRes = $('dd_columns_bulk').first().json;
const bulkBody = (bulkRes && bulkRes.body) || bulkRes || {};
const urn = String(inp.urn || '');
const bucket = (bulkBody && typeof bulkBody === 'object' && !Array.isArray(bulkBody))
  ? (bulkBody[urn] || bulkBody[Object.keys(bulkBody)[0]] || {})
  : {};

const cols = nodesOf(bucket.data)
  .map((c) => ({ field: shortName(c), urn: String((c && c.urn) || '') }))
  .filter((c) => c.field && c.urn);

// ЧАНК 120 — ИЗМЕРЕННЫЙ РАЗМЕР, А НЕ КРУГЛОЕ ЧИСЛО. Прогон фазы J
// подтвердил ровно 120 URN в одном теле (120 отправлено → 120 ключей
// в ответе). Что пройдут 289, неизвестно, а отказ по размеру тела был бы
// по виду неотличим от «признака нет» — то есть тихо превратил бы закрытое
// поле в открытое. Три запроса вместо одного здесь не стоят ничего.
const SENS_CHUNK = 120;

// Чувствительность спрашивается ПО ВСЕМ колонкам витрины, а не по отобранным.
// Она нужна не для поиска поля, а для пометки 🔒 в составе выгрузки, и состав
// собирает автор — по любым полям, не только совпавшим с hint.
function sensJobs(all) {
  const jobs = [];
  for (let i = 0; i < all.length; i += SENS_CHUNK) {
    jobs.push(JSON.stringify({
      urns: all.slice(i, i + SENS_CHUNK).map((c) => c.urn),
      key: 'full_column_sensitivity',
      limit: 500,
    }));
  }
  return jobs;
}

// Один элемент на чанк: нода HTTP выполняется по разу на входной элемент.
// Пустой возврат тут недопустим — n8n останавливает ветку на ноде, вернувшей
// ноль элементов, и шейпер не выполнился бы вовсе. Ровно этот отказ уже был
// на проверке значений: «No output data returned», и бот остался без
// инвентаря при полностью отработавшем каталоге.
function emit(pickFields, mode, extra) {
  const jobs = sensJobs(cols);
  const base = Object.assign({
    targets: pickFields,
    picked: pickFields.length,
    mode,
    total_cols: cols.length,
    sens_asked: cols.length,
  }, extra || {});
  if (!jobs.length) return [{ json: Object.assign({ sens_body: '' }, base) }];
  return jobs.map((b) => ({ json: Object.assign({ sens_body: b }, base) }));
}

// Пустой search — подробностей не печатаем, только инвентарь имён.
// Описания при этом ПРИШЛИ (запрос один и тот же), просто в этом режиме
// они не печатаются: см. про токены выше.
if (!needle) return emit([], 'none', { matched: 0 });

// РЕЖИМ ВЫБИРАЕТСЯ ПО КАЖДОЙ ИГЛЕ, А НЕ ПО ФАКТУ «ХОТЬ ОДНА СОВПАЛА».
//
// Роутер даёт hint списком понятий: «логин, почта», «ad_login, рабочая
// почта». Раньше достаточно было ОДНОЙ игле совпасть с именем колонки,
// чтобы весь вызов ушёл в by_name — и подробности печатались только по ней.
// Второе понятие не сравнивалось НИ С ЧЕМ.
//
// Измерено прогоном ноды 2026-09-01 на mdm_employee_structure_d:
//   «логин, почта»            → by_meaning, 10 полей
//   «ad_login, рабочая почта» → by_name,    ОДНО поле (ad_login)
// То есть дословный отказ 2026-08-26 — «в витрине нет рабочей почты»
// при живом `wrk_email_address_txt`, — заново взведённый ФОРМОЙ иглы.
//
// Правило: by_name — это «hint дан техническими именами полей», и оно
// верно, только если ИМЯ НАШЛОСЬ У КАЖДОЙ иглы. Не нашлось хотя бы
// у одной — печатаем описания всех колонок, потому что это понятие
// по имени не найти в принципе.
const perNeedle = needles.map((n) => ({
  needle: n,
  hits: cols.filter((c) => matchesAny(c.field, [n])),
}));
const allNamed = perNeedle.length > 0 && perNeedle.every((x) => x.hits.length);
// Объединение по всем иглам, без дублей: общий фильтр по любой игле
// скрывал, что у части игл совпадений нет вовсе.
const byName = allNamed
  ? cols.filter((c) => perNeedle.some((x) => x.hits.includes(c)))
  : [];

if (!byName.length) {
  // Колонка называется латиницей (dismissal_reason_desc), а спрашивают
  // по-русски («причины увольнения») — по имени это не совпадёт никогда,
  // это не вопрос порога, а разных алфавитов. Печатаем описания всех полей
  // и сравнение по смыслу оставляем АВТОРУ: у кода нет права судить
  // о смысле, и попытка судить стоила проекту пяти диагнозов подряд.
  return emit(cols.map((c) => c.field), 'by_meaning', { matched: 0 });
}

// ВЫРОЖДЕННЫЙ ФИЛЬТР («e», «_») СОВПАДАЕТ С ПОЛОВИНОЙ ТАБЛИЦЫ.
//
// Раньше он возвращал ОДИН инвентарь имён без описаний — потому что читать
// полтаблицы по карточке было дорого. Теперь описания уже на руках, и
// не печатать их значит МОЛЧА придержать данные, за которые уже заплачено:
// в конвейере у автора один заход, и непечатанное потеряно навсегда.
// Поэтому вырожденный фильтр ведёт себя как by_meaning — показываем всё,
// и отдельно говорим, что фильтр ничего не сузил.
const WIDE_FILTER_SHARE = 0.5;
const wide = cols.length > 20 && byName.length > cols.length * WIDE_FILTER_SHARE;
if (wide) {
  return emit(cols.map((c) => c.field), 'by_meaning', {
    matched: byName.length, wide_filter: true,
  });
}

return emit(byName.map((c) => c.field), 'by_name', { matched: byName.length });

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

// Контракт тот же, что у шейпера таблицы: текст — автору, факты — коду.
// Без этого диагноз каталога на ОТЧЁТАХ слепнет: у карточки отчёта состава
// полей нет по построению, и «полей не пришло» там не отказ, а норма.
return [{ json: {
  dd_meta: out.join('\n'),
  dd: {
    ok: !problems.length,
    object_type: 'report',
    urn,
    http: HTTP_LOG,
    // Витрины-источники: половина того, ради чего затевался реестр отчётов,
    // и она приезжает онлайн. Пустой список и отказ ручки — разные вещи.
    sources: srcNodes.map((n) => String(n.fqn || n.urn || '').trim()).filter(Boolean),
    sources_failed: Boolean(srcProblem),
  },
} }];
"""


def code(name, js, pos):
    return {
        "parameters": {
            "jsCode": js,
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

# Пустое тело = спрашивать чувствительность не по чему, идём прямо в шейпер.
#
# Имя ноды сменилось вместе со смыслом: карточек колонок больше не бывает —
# описания приходят оптом вместе с именами, и гейт остался только у одного
# запроса, у связи full_column_sensitivity. Имя, которое врёт про
# содержимое, — это тот же разъезд, только в документации.
need_sens = {
    "parameters": {
        "conditions": {
            "options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
            "conditions": [
                {
                    "id": "has-body",
                    "leftValue": "={{ $json.sens_body }}",
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
    "id": "dd-need-sens",
    "name": "Need sens",
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
        need_sens,
        column_sens,

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
        "dd_entity_attrs": {
            "main": [[{"node": "dd_columns_bulk", "type": "main", "index": 0}]]
        },
        "dd_columns_bulk": {
            "main": [[{"node": "Pick columns", "type": "main", "index": 0}]]
        },
        "Pick columns": {
            "main": [[{"node": "Need sens", "type": "main", "index": 0}]]
        },
        # true — за чувствительностью (по запросу на чанк из 120 колонок);
        # false — сразу в шейпер, минуя HTTP. Ветви IF сходятся в шейпере,
        # и это нормально: они взаимоисключающие. А вот ВЕЕРА тут быть
        # не должно — параллельный вход с двух узлов запустил бы шейпер
        # дважды на одну порцию, n8n не ждёт вторую ветку, как Merge.
        "Need sens": {
            "main": [
                [{"node": "dd_columns_sens", "type": "main", "index": 0}],
                [{"node": "Shape table meta", "type": "main", "index": 0}],
            ]
        },
        "dd_columns_sens": {
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

Для таблицы: состав полей, а также тип данных, описание, развёрнутый
комментарий владельца и признак чувствительности. Каталог отдаёт это
по ВСЕМ колонкам сразу, поэтому фильтр решает только, что показать
подробно, а не что было получено.
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
