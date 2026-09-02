---
title: Support — инструкция по работе (бот, телеметрия, git)
audience: технический специалист, дорабатывающий флоу
updated: 2026-08-18
---

# RUNBOOK: бот поддержки, телеметрия, база знаний

Практическая инструкция «как собрать / импортировать / проверить / куда смотреть
за деталями». Все архитектурные решения и их причины — в [`AGENTS.md`](context/AGENTS.md)
(≈1300 строк, читать целиком при первой доработке любого из трёх узлов). Этот файл —
навигация и порядок действий, не дубликат.

Инстанс n8n: **`n8n.t-tech.team`**. Ссылка на воркфлоу — `https://n8n.t-tech.team/workflow/<id>`.
Id присваивается n8n **только при импорте** — у файлов на диске (кроме архивных
экспортов) его нет, поэтому часть ссылок ниже — «как найти», а не готовый URL.

## Три независимые системы

| Система | Папка | Git | Что делает |
|---|---|---|---|
| Бот поддержки | [`bot/`](bot/) | нет | Отвечает черновиком на обращения в `~hr-report-ask` |
| Телеметрия | [`telemetry/`](telemetry/) | нет | Считает обращения, время реакции, метрики бота |
| База знаний | [`executive-support/`](executive-support/) | да, GitLab | Источник смысла для бота: метрики, таблицы, рецепты, регламенты |

Общее у первых двух — только канал `~hr-report-ask` и корневые файлы; кода друг
у друга не берут. `executive-support/` — вообще отдельный git-репозиторий внутри
этой папки, со своим `CLAUDE.md`.

Полная карта решений: [`AGENTS.md` — «Флоу бота: git + DD в один контекст»](context/AGENTS.md),
[«Подключение к Time: ядро и три адаптера»](context/AGENTS.md), [«Телеметрия канала»](context/AGENTS.md).

---

## 1. Живые флоу в n8n

Все флоу собираются локально Python-сборщиками и импортируются в n8n через
**Import from File** (или copy-paste JSON). Id воркфлоу n8n присваивает сам —
он либо уже зафиксирован как переменная окружения по умолчанию в сборщике
(тогда есть прямая ссылка), либо ещё не зафиксирован (тогда открывать в n8n
по имени и смотреть в адресную строку).

### Бот (`bot/`)

| Флоу | Файл | id | Ссылка |
|---|---|---|---|
| Support Bot Core | `Support Bot Core.json` | `quV6Ec1hmobZefBX` (переменная `CORE_WORKFLOW_ID` в `build_time_flows.py:73`) | [открыть](https://n8n.t-tech.team/workflow/quV6Ec1hmobZefBX) |
| DD Lookup | `DD Lookup.json` | `7tgrNcbmZGuW2AON` (`DD_SUBFLOW_ID` в `build_dd_flow.py:38`) | [открыть](https://n8n.t-tech.team/workflow/7tgrNcbmZGuW2AON) |
| Adapter Channel | `Adapter Channel.json` | не зафиксирован — ничего не зовёт его по id, поэтому не записан | найти в n8n по имени «Support Bot · Adapter Channel» |
| Adapter Chat | `Adapter Chat.json` | не зафиксирован | «Support Bot · Adapter Chat» |
| Adapter DM | `Adapter DM.json` | не зафиксирован, **флоу не проверен живым запуском** | «Support Bot · Adapter DM» |
| Support Bot DD (старый tool-loop) | `Support Bot DD.json` | не зафиксирован | «Support Bot DD» — жив только как источник узлов для сборщика ядра |

### Телеметрия (`telemetry/`)

| Флоу | Файл | id | Ссылка |
|---|---|---|---|
| Telemetry Ingest | `Telemetry Ingest.json` | `28ExyYBVz53J1bMu` (`INGEST_WORKFLOW_ID` в `build_telemetry_flows.py:91`) | [открыть](https://n8n.t-tech.team/workflow/28ExyYBVz53J1bMu) |
| Telemetry Collector | `Telemetry Collector.json` | не зафиксирован | «Telemetry · Collector Channel» |
| Telemetry Backfill | `Telemetry Backfill.json` | не зафиксирован, ручной запуск | «Telemetry · Backfill» |
| Telemetry Collector Tracker | `Telemetry Collector Tracker.json` | не зафиксирован, крон 15 мин | «Telemetry · Collector Tracker» |
| Telemetry Flush | `Telemetry Flush.json` | не зафиксирован, крон 1 ч, **работает и стоит на расписании** (проверено 2026-08-17) | «Telemetry · Flush» |
| Telemetry Report | `Telemetry Report.json` | не зафиксирован | «Telemetry · Report» |
| Feedback Webhook | `Feedback Webhook.json` | не зафиксирован, **не собран/не подключён** | «Support Bot · Feedback Webhook» |
| DLH Examples (референс credential Trino) | `DLH Examples.json` | `GMKFVejvauDT3k9h` | [открыть](https://n8n.t-tech.team/workflow/GMKFVejvauDT3k9h) |

Канал `~hr-report-ask`: id `piyu3cs9xpdwie7nwxje5cwm8r` (переменная `CHANNEL_ID`).
Credential Time — «Time Bully» (`7SgPbuQnw6w2wzMl`).

**Как только id воркфлоу узнан — вписывать его как значение по умолчанию в сборщик**
(`os.environ.get("...", "<id>")`), а не хранить только в переменной окружения:
без этого следующая пересборка без переменной тихо возвращает плейсхолдер,
и вызов по id падает на «workflow not found». Это уже случалось и описано
в `AGENTS.md` как решение, которое нельзя терять.

---

## 2. Бот поддержки (`bot/`)

```
Support Bot Core   executeWorkflowTrigger { question, mode }
                   Router (LLM) → Plan (+мастера домена кодом)
                   → статьи (GitLab) → DD Lookup (по нужде) → Author (LLM)
                   → { draft, sources, confidence, confidence_key, gaps }

Adapter Channel    слушает ~hr-report-ask → Guard channel (код) → Core
                   → черновик + служебный блок → ~stonis_hakcs_2
Adapter Chat       chatTrigger → Core → полный вывод (ручное тестирование)
Adapter DM         личка с ботом, не проверена живым запуском
```

Полная схема с ветвлениями — `AGENTS.md`, раздел «Подключение к Time».

### Пересборка (обычный случай — id уже известны)

```bash
cd bot
python3 build_dd_flow.py && python3 build_time_flows.py
```

Импортировать в n8n заново — только те файлы, что изменились. Переимпорт
**поверх** существующего воркфлоу (Import from File в уже открытом флоу)
сохраняет id — адаптеры пересобирать не нужно. Переимпорт **новым** воркфлоу
даёт новый id → его надо вписать в `CORE_WORKFLOW_ID` и пересобрать/переимпортировать
адаптеры.

**Ядро и адаптеры переимпортируются вместе.** Вход ядра — часть контракта:
новое поле на входе, не объявленное в старом ядре, до него не доедет молча.

### Настройки окружения

Ничего из этого в репозитории не лежит: значения инстанса, а не кода.
Сборщик печатает при запуске, что выключено и почему.

| переменная | зачем | без неё |
|---|---|---|
| `BOT_USERNAME` | имена, на которые бот отзывается в канале, через запятую | по умолчанию `bully,Булли` — логин и его алиас в Mattermost. Пустое значение выключает путь по тегу целиком |
| `BOT_USER_ID` | id бота для реакции `:bully_work:` | реакция не встанет, ответ уйдёт |
| `CHANNEL_LISTEN` | какие каналы слушать, через запятую | слушается только `hr-report-ask` |
| `CHANNEL_DRAFTS` | канал черновиков (тоже слушается) | `stonis_hakcs_2` |
| `CORE_WORKFLOW_ID`, `DD_SUBFLOW_ID` | id воркфлоу в n8n | сборка возьмёт прежние |

```bash
BOT_USER_ID=<id> python3 build_time_flows.py
```

**Логин лежит в коде, а не в окружении.** Он не секрет и не персональные
данные: публичное имя учётки, одно на инстанс. Пока он был только
переменной, обычная сборка выдавала флоу с выключенным путём по тегу —
и уехала именно такой. Из репозитория обязана приезжать рабочая сборка;
тест это держит.

Имён два: `bully` — логин, «Булли» — его алиас в Mattermost, и в живом
треде люди писали именно алиас. Лишнее имя в списке не стоит ничего,
пропущенное — это молчание там, где бота позвали.

**Канал, которого нет в списке, бот не видит вовсе** — ни обращения, ни тега.
Пост туда не приходит, и в n8n это выглядит как пустой Executions: неотличимо
от «тег не сработал». Прежде чем разбирать молчание в канале, проверьте,
слушается ли он.

### Установка с нуля (другой инстанс n8n)

```
1. Импортировать DD Lookup.json → скопировать id из адресной строки
2. DD_SUBFLOW_ID=<id> python3 build_dd_flow.py
3. python3 build_time_flows.py → импортировать Support Bot Core.json → скопировать id
4. CORE_WORKFLOW_ID=<id> python3 build_time_flows.py → импортировать Adapter Channel/Chat/DM
```

### Тесты (после правки Code-нод или промптов)

```bash
cd bot
node test_pipeline.mjs   # план, мастера домена, сборка материалов, проекция реестра
node test_adapters.mjs   # разбор ответа, сборка сообщений, guard, домены
node test_shapers.mjs    # шейперы DD на подставных данных
node test_recon.mjs      # разведка DD: формы ответов каталога
```

Каждый набор — своей командой. `node test_pipeline.mjs test_adapters.mjs`
запускает только первый файл, второй молча становится аргументом.

### Промпты

Источник правды — `prompts/router.md` и `prompts/author.md`. Вклеиваются
сборщиком в ядро; **JSON руками не править**. `patch_prompt.py` — правит
промпт старого `Support Bot DD.json`, в ядро не попадает.

### Известные ограничения

- `Adapter DM` — не проверен живым запуском (неизвестно, отдаёт ли `mattermostTrigger`
  DM-события при пустом `postedFilters`).
- `DM_ALLOWLIST` в сборщике пуст — бот ответит в личке кому угодно.
- URN четырёх из пяти таблиц собраны по схеме, не подтверждены `POST /search/query`.

---

## 3. Телеметрия (`telemetry/`)

```
Telemetry Collector   push-события ~hr-report-ask → Guard channel → Ingest
Telemetry Backfill    ручной засев истории из API канала → Ingest
Telemetry Ingest      единственная точка записи → Data Tables support_event (upsert)
Telemetry Flush       крон 1 ч → Data Tables → Trino DLH (MERGE, чанки, watermark)
Collector Tracker     крон 15 мин → статусы задач T-Tracker по ключам из тредов
Feedback Webhook      кнопки под черновиком → Ingest      (не собран)
```

Полная схема — `AGENTS.md`, раздел «Телеметрия канала».

### Пересборка

```bash
cd telemetry
python3 build_telemetry_flows.py
python3 build_telemetry_flows.py --print-schema   # схема Data Tables (колонки — руками в UI)
python3 build_telemetry_flows.py --print-ddl       # DDL для Trino-таблицы (создаётся руками)
```

### Установка с нуля

```
1. node make_table_csv.mjs → импортировать support_event.csv в Data Tables
   (создаёт таблицу И заливает 3 примера — нужны, чтобы n8n определил типы колонок)
2. python3 build_telemetry_flows.py → импортировать Telemetry Ingest.json → скопировать id
3. INGEST_WORKFLOW_ID=<id> python3 build_telemetry_flows.py
4. Импортировать Telemetry Collector.json и Telemetry Backfill.json
5. Для перелива в DLH: свериться с --print-ddl (таблица создаётся руками в Trino),
   импортировать Telemetry Flush.json, ОТКРЫТЬ ноды Watermark и Write batch —
   пустые Query/Timeout/Time Zone значат, что имена полей CUSTOM.trino угаданы
   неверно. Первый прогон — вручную, не по крону.
```

### Тесты

```bash
cd telemetry
node test_telemetry.mjs   # нормализатор, витрина, сверка со сборщиками (418 проверок)
```

### Витрина

`telemetry/support_request.sql` — три самостоятельных запроса: вью
`dl.usr_cross_data.support_request` (одна строка = одно обращение),
диагностика отсева, метрики p50/p85. **Пересчитывается из лога целиком**,
синтаксис живым прогоном не проверен (Trino доступен только из n8n).

### Метрики — определения

| Метрика | Формула |
|---|---|
| Reaction time | `taken_at − created_at` (первая `:loading:`) |
| Lead time | `closed_at − created_at` (что чувствует заказчик, с очередью) |
| Cycle time | из changelog задачи трекера (без очереди) |
| Калибровка | доля случаев, где заявлена «высокая уверенность», а черновик переписали — сравнивать `confidence_claimed` vs `confidence_key` |

### Известные пробелы

- Узел `Ingest` **не врезан** в ядро бота — без него колонки ответа бота
  в витрине `NULL`, калибровку считать нечем.
- `channel_id` не пишется в payload вебхука кнопок — `draft_useful`
  и `answer_helpful` не развести.
- `BOT_USER_IDS` в сборщике не заполнен — реакции бота попадут в лог как
  действия дежурного.
- Дашборд в Proteus поверх `support_request` не собран.

---

## 4. База знаний / git (`executive-support/`)

Отдельный git-репозиторий: **GitLab → [`cross/executive-support`](https://gitlab.tcsbank.ru/cross/executive-support)**,
удалённый доступ — HTTPS (SSH недоступен из песочницы). Свой контекст —
[`executive-support/CLAUDE.md`](executive-support/CLAUDE.md), онбординг для джуна —
[`executive-support/docs/how-we-work.html`](executive-support/docs/how-we-work.html)
(скачать и открыть в браузере).

### Структура

| Папка | Кто пишет | Что |
|---|---|---|
| [`kb/index.md`](executive-support/kb/index.md) | руководитель | Реестр всех сущностей — точка входа для бота |
| [`kb/metrics/`](executive-support/kb/metrics/) `kb/reports/` `kb/tables/` `kb/recipes/` | руководитель / владелец витрины | По файлу на сущность |
| [`kb/process/`](executive-support/kb/process/) | руководитель | Плейбуки: [`export-playbook.md`](executive-support/kb/process/export-playbook.md), [`routing.md`](executive-support/kb/process/routing.md), [`metadata-sources.md`](executive-support/kb/process/metadata-sources.md), [`sql-conventions.md`](executive-support/kb/process/sql-conventions.md) |
| `cases/` | джун | Кейсы, append-only, **в контекст бота не подаётся** |
| `exports/` | джун | Папка на выгрузку: README, поля, SQL |
| `templates/` | — | Болванки для новой статьи |

**Одна сущность — один файл.** `kb/index.md` правится вручную, тем же коммитом,
что и статья — без строки в реестре статья для агента не существует.

### Как завести статью

```bash
cd executive-support
cp templates/metric.md kb/metrics/имя.md   # или report.md / table.md / recipe.md
# заполнить фронтматтер и разделы, добавить строку в kb/index.md
python3 validate_kb.py                     # обязательно перед коммитом
```

`validate_kb.py` ловит: расхождение фронтматтера и реестра, дубли `id`,
неверную сортировку, домен без мастера, коллизии алиасов, битые ссылки —
полный список в `executive-support/CLAUDE.md`, раздел «Как разметка держится».

### Git-флоу: `master` защищён

Бот в n8n читает статьи GitLab-нодами **без указания ветки** → читается
ветка по умолчанию, `master`. Правки в feature-ветке для бота не существуют,
пока не влиты.

1. Работать в feature-ветке (не создавать новую от `master` без нужды — сначала
   проверить `git branch -a`, в репозитории уже несколько параллельных веток).
2. `python3 validate_kb.py` перед коммитом.
3. `git push -u origin <ветка>` — **требует подтверждения на каждый вызов**,
   в песочнице push по SSH недоступен, используется HTTPS remote.
4. MR — **вручную**, по ссылке, которую GitLab печатает после push. Заголовок
   и описание — про «зачем», не про дифф.
5. Мержит в `master` — человек. Агент не создаёт MR сам и не мержит.

Готовый шаблон задания для агента, который проводит такую правку до конца —
[`prompt-git-agent.md`](context/prompt-git-agent.md): содержит текущую ветку, что нельзя
трогать (соседние feature-ветки), запреты (`push --force`, `reset --hard`,
`rebase`, `commit --amend` по запушенному) и формат отчёта.

### Разбор проблемного прогона — узел «Trace»

Ядро собирает трассировку прогона в один текст. Не нужно открывать шесть нод
и складывать их в голове:

1. n8n → «Support Bot Core» → вкладка **Executions** → нужный прогон.
2. Узел **«Trace»** (стоит перед «Final answer») → поле `trace`.
3. Скопировать целиком — это самодостаточный отчёт.

Что в нём: что выбрал роутер сам и что добрал код, какие гейты сработали
(выгрузка / запрос / доступ / подразделение), что РЕАЛЬНО доехало до автора,
какие узлы не запускались вовсе, чем кончилась сверка значений, и отдельным
разделом в конце — список того, что не отработало.

«НЕ ЗАПУСКАЛСЯ» и «отработал пусто» в отчёте различаются намеренно: это
разные поломки, и по логу их иначе не отличить.

### После влития MR — как проверить, что бот увидел правку

Переимпорт `Support Bot Core.json` не нужен для правок `kb/` (статьи читаются
GitLab-нодой на каждый запрос) — нужен **только** если менялись `prompts/*.md`.
Проверка — вопрос в `Adapter Chat`, ожидаемый ответ описан в конце
`prompt-git-agent.md`.

---

## 5. Data Detective — источник инвентаря полей

Bot получает состав полей/типы/описания **онлайн из DD**, а не из `kb/` —
полный справочник API (эндпоинты, `related/{key}`, карточка колонки, поиск,
метрики usage) — `AGENTS.md`, раздел «Data Detective 2.0 Public API». Ключевое:
вложенные объекты (колонки таблицы) — только через `/related/{key}`, описания —
отдельным запросом на карточку каждой колонки, `followRedirects: false` везде.

---

## 6. Punch list — что доделать

- [ ] Врезать узел `Ingest` в ядро бота (телеметрия ответов бота)
- [ ] Собрать `Feedback Webhook` + добавить `channel_id` в payload
- [ ] Заполнить `BOT_USER_IDS` и `DM_ALLOWLIST` в сборщиках
- [ ] Подтвердить живым запуском `Adapter DM` и URN оставшихся 4 таблиц
- [ ] Собрать дашборд в Proteus поверх `support_request`
- [ ] Наполнить `kb/reports/` (сейчас пусто, 28% обращений — про отчёты)
