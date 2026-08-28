-- ===========================================================================
-- support_request — витрина обращений: одна строка = одно обращение (тред).
--
-- Считается ЦЕЛИКОМ из append-only лога `support_telemetry`. Ничего не
-- апдейтит и не хранит состояния: четыре источника (коллектор канала, вебхук
-- кнопок, коллектор трекера, ядро бота) пишут про одно обращение в разное
-- время, и апдейт одной строки из четырёх мест — это гонки и молча потерянные
-- данные. Пересчёт из лога вместо этого разбирает снятие реакции сам собой,
-- а неверную логику метрики позволяет починить ретроспективно, не переписывая
-- историю.
--
-- Ключ склейки — `thread_id` (root_id треда).
--
-- Запуск: это ОДИН оператор CREATE OR REPLACE VIEW. Если прав на создание
-- вью в схеме нет — брать SELECT начиная с `WITH dedup AS` и выполнять как
-- обычный запрос; ниже в файле лежат ещё два запроса (диагностика и метрики),
-- они самостоятельные.
--
-- ЧТО ЗДЕСЬ ЛЕГКО СДЕЛАТЬ НЕПРАВИЛЬНО (каждый пункт — тихая ошибка):
--
--  1. Считать обращением каждый тред. Триггер `posted` пишет и реплики,
--     и посты чужих тредов; обращение — это только тред с `request_created`.
--     Остальные отбрасываются, но их число НАЗЫВАЕТ запрос-диагностика ниже:
--     молча резать нельзя, рост этого числа означает поломку разбора темы.
--  2. Складывать `ours = false`. Обращения к соседней команде (HC Data,
--     ex. DWH HR) лежат в логе намеренно — задним числом их добрать нельзя, —
--     но в НАШИ метрики не входят. Фильтр `ours` обязателен у потребителя.
--  3. Считать `event_ts = 0` временем. Нормализатор пишет 0, когда времени
--     в событии не было (`skipped`, часть служебных), и в DLH это 1970 год —
--     причём НЕ ровно полночь: from_unixtime отдаёт время в тайм-зоне сессии,
--     а ноды Flush ставят Europe/Moscow, так что ноль приезжает как
--     1970-01-01 03:00:00. Поэтому здесь порог, а не точное равенство;
--     иначе арифметика уводит reaction time в минус 56 лет.
--  4. Ровнять снятие `:loading:` и снятие закрывающей реакции. Правила
--     РАЗНЫЕ: дежурный снимает `:loading:`, когда ставит закрывающую, поэтому
--     `taken_at` = ПЕРВОЕ добавление за историю треда и снятие его не
--     сбрасывает; закрывающую реакцию снимают, чтобы исправить ошибку,
--     поэтому снятие ПЕРЕОТКРЫВАЕТ обращение. При едином правиле «снятие
--     сбрасывает» reaction time обнулился бы у ВСЕХ закрытых обращений.
--  5. Верить `confidence` бота на слово. Полей два: `confidence_claimed` —
--     что сказала модель, `confidence_key` — что осталось после понижения
--     кодом. Калибровка считается по ПАРЕ; по одному полю не видно ни
--     систематического завышения, ни частоты правок.
--
-- СОБЫТИЯ, КОТОРЫЕ ВИТРИНА НЕ ИСПОЛЬЗУЕТ — намеренно, а не по забывчивости.
-- Список тут потому, что тихо проигнорированный тип события неотличим
-- от несуществующего, а тест 36 в `test_telemetry.mjs` сверяет его с тем,
-- что реально пишет сборщик, и ломается на новом типе.
--
--   `taken_removed`            снятие `:loading:` НЕ сбрасывает `taken_at`:
--                              дежурный снимает его, ставя закрывающую
--                              реакцию. Учитывать = обнулить reaction time
--                              у всех закрытых обращений.
--   `feedback_detail_opened`   открытие формы текстового отзыва. Оценки
--                              считаются по `bot_feedback`; нажатие без
--                              отправки текста обратной связью не является,
--                              но в логе оно живёт отдельным типом, чтобы
--                              «кнопки не работают» и «кнопки работают,
--                              а текст не дописывают» не выглядели одинаково.
-- ===========================================================================

CREATE OR REPLACE VIEW dl.usr_cross_data.support_request AS
WITH dedup AS (
    -- Дедуп по event_id. При `DLH_WRITE_MODE=merge` (текущий режим) он
    -- избыточен: MERGE держит ключ уникальным. Оставлен намеренно —
    -- в режиме `insert` повторный backfill даёт вторую строку на то же
    -- событие, и без этого шага счётчики выросли бы без причины. Стоит он
    -- одну оконную функцию на тысячи строк.
    SELECT e.*,
           ROW_NUMBER() OVER (PARTITION BY event_id
                              ORDER BY ingested_at DESC) AS rn
    FROM dl.usr_cross_data.support_telemetry e
    -- Три строки-примера из CSV, которым n8n определял типы колонок.
    WHERE e.event_type <> 'schema_sample'
),
ev AS (
    SELECT thread_id,
           event_type,
           -- 0 = «времени в событии не было», а не 1970 год.
           --
           -- Сравнение с ПОРОГОМ, а не с точной полночью: в DLH эпоха
           -- конвертируется через from_unixtime, а он отдаёт время в тайм-зоне
           -- сессии — ноды Flush ставят Europe/Moscow, и ноль приезжает как
           -- 1970-01-01 03:00:00. Точное равенство мимо него промахивалось,
           -- и «времени не было» превращалось в настоящую дату 1970 года:
           -- reaction time уезжал в минус 56 лет и тянул за собой медиану,
           -- то есть ровно то, что этот NULLIF и заведён предотвращать.
           -- Порог берём заведомо ниже любого настоящего события и выше
           -- любого смещения от эпохи — офсеты не бывают в годы.
           CASE WHEN event_ts < TIMESTAMP '2000-01-01 00:00:00' THEN NULL
                ELSE event_ts END AS event_ts,
           actor,
           source,
           kind,
           domains,
           payload
    FROM dedup
    WHERE rn = 1
      AND thread_id <> ''
),

-- Обращение. Ровно одно `request_created` на тред, но агрегация всё равно
-- по минимуму времени: два корневых события на один thread_id означали бы
-- поломку склейки, и тогда лучше взять первое, чем упасть на дубле ключа.
root AS (
    SELECT thread_id,
           min(event_ts) AS created_at,
           min_by(kind, event_ts) AS kind,
           min_by(json_extract_scalar(payload, '$.topic'), event_ts) AS topic,
           min_by(CAST(json_extract_scalar(payload, '$.ours') AS boolean),
                  event_ts) AS ours,
           min_by(json_extract_scalar(payload, '$.permalink'),
                  event_ts) AS permalink,
           -- posted_by, а НЕ author: корневой пост публикует intake-воркфлоу,
           -- поэтому здесь его user_id, а не человек с вопросом. Настоящий
           -- автор есть только в шапке формы («от пользователя @X»), и лог
           -- её не разбирает — это named пробел, а не поле, которое можно
           -- вывести из имеющегося.
           min_by(actor, event_ts) AS posted_by,
           min_by(CAST(json_extract_scalar(payload, '$.text_len') AS integer),
                  event_ts) AS text_len
    FROM ev
    WHERE event_type = 'request_created'
    GROUP BY thread_id
),

-- Взято в работу: ПЕРВОЕ добавление `:loading:` за историю треда.
-- `taken_removed` не смотрим вовсе — снятие здесь не сбрасывает.
taken AS (
    SELECT thread_id,
           min(event_ts) AS taken_at,
           min_by(actor, event_ts) AS taken_by
    FROM ev
    WHERE event_type = 'taken'
    GROUP BY thread_id
),

-- Закрытие: состояние по ПОСЛЕДНЕМУ событию из пары «поставили / сняли».
-- Снятие переоткрывает, поэтому важен не факт закрытия, а порядок.
close_events AS (
    SELECT thread_id,
           event_ts,
           event_type,
           actor,
           CAST(json_extract_scalar(payload, '$.resolved') AS boolean) AS resolved,
           -- Тай-брейк при совпадении миллисекунды: 'closed_removed' > 'closed'
           -- в лексикографическом порядке, поэтому DESC ставит снятие первым
           -- и обращение считается ОТКРЫТЫМ. Из двух ошибок это дешёвая:
           -- незакрытое обращение видно дежурному, ложно закрытое — нет.
           ROW_NUMBER() OVER (PARTITION BY thread_id
                              ORDER BY event_ts DESC, event_type DESC) AS rn
    FROM ev
    WHERE event_type IN ('closed', 'closed_removed')
),
closed AS (
    SELECT thread_id,
           CASE WHEN event_type = 'closed' THEN event_ts END AS closed_at,
           CASE WHEN event_type = 'closed' THEN resolved END AS resolved,
           CASE WHEN event_type = 'closed' THEN actor END AS closed_by,
           event_type = 'closed_removed' AS reopened
    FROM close_events
    WHERE rn = 1
),

-- Реакции вне словаря и домысленные типы событий. Оба — про доверие
-- к метрикам, а не про сами метрики.
reaction_health AS (
    SELECT thread_id,
           count_if(event_type IN ('reaction_added', 'reaction_removed')) AS unknown_reactions,
           -- true означает, что тип события домыслен по форме: снятие реакции
           -- пришло как добавление. Снятое «взято в работу» останется
           -- в метриках навсегда, и знать об этом обязательно.
           bool_or(CAST(json_extract_scalar(payload, '$.event_inferred') AS boolean))
               AS reaction_types_inferred
    FROM ev
    WHERE source = 'reaction'
    GROUP BY thread_id
),

-- Задача трекера: связь ставит машина (бот постит в тред ссылку).
task AS (
    SELECT thread_id,
           min(event_ts) AS task_linked_at,
           min_by(json_extract_scalar(payload, '$.task_key'), event_ts) AS task_key,
           min_by(json_extract_scalar(payload, '$.task_url'), event_ts) AS task_url,
           min_by(json_extract_scalar(payload, '$.tracker'), event_ts) AS tracker
    FROM ev
    WHERE event_type = 'task_linked'
    GROUP BY thread_id
),
task_state AS (
    SELECT thread_id,
           max_by(json_extract_scalar(payload, '$.status'), event_ts) AS task_status,
           max_by(CAST(json_extract_scalar(payload, '$.is_final') AS boolean),
                  event_ts) AS task_is_final,
           -- Ошибка опроса называется: «нет доступа к спейсу» и «статус
           -- не менялся» иначе выглядят одинаково, и cycle time тихо замирает.
           max_by(json_extract_scalar(payload, '$.error'), event_ts) AS task_error,
           -- create_at/finish_at трекер отдаёт точными всегда, в отличие
           -- от промежуточных статусов: истории переходов в T-Tracker нет,
           -- видно только то, что застал крон (`snapshot: true` в payload).
           max(from_unixtime(
                 CAST(json_extract_scalar(payload, '$.task_created_at') AS bigint) / 1000.0
               )) AS task_created_at,
           max(from_unixtime(
                 CAST(json_extract_scalar(payload, '$.task_finished_at') AS bigint) / 1000.0
               )) AS task_finished_at,
           count(*) AS task_status_events
    FROM ev
    WHERE event_type = 'task_status_changed'
    GROUP BY thread_id
),

-- ПОЛЯ ОТВЕТА БОТА, КОТОРЫЕ ВИТРИНА НЕ ИСПОЛЬЗУЕТ — и почему.
--
-- Список обязателен: тест 37 требует, чтобы каждое поле из `Parse answer`
-- было либо прочитано витриной, либо названо здесь с причиной. Иначе новое
-- поле ядра тихо не доезжает до дашборда — то же самое, что было с
-- `dd_received` и `router_empty`: код их считал, а посмотреть было негде.
--
--   draft                  — сам текст черновика. Он и так уходит в канал
--                            джуна постом; вторая копия в логе это объём
--                            и персональные данные без новой информации.
--   question, raw          — полный текст обращения и сырой ответ модели.
--                            Объём и персональные данные; сам пост и так
--                            лежит в логе событием `request_created`.
--   mode                   — дубль `is_export`, одно и то же значение.
--   confidence_basis       — строка для джуна, собранная из полей, которые
--                            в витрине уже есть по отдельности.
--   ib_stated              — отрицание `ib_missing` при `ib_required`.
--                            Две колонки на один факт складывать нечем.
--   report_url             — ссылка на отчёт из формы. Группировать по ней
--                            нечего, пока нет моста «ключ ссылки → dd_urn».
--   routes_dropped         — маршруты, срезанные потолком. Отладочное:
--                            потолок два, срабатывает почти никогда.
--   topic_kind             — та же тема, что `kind` у корневого события
--                            (`kind_source = 'intake'`). Вторая колонка
--                            приглашала бы сложить два разных счёта.
--
-- Ответ бота. Событие `bot_answered` ПИШЕТСЯ — узлом «To Ingest» в адаптере
-- канала, а не в ядре: сабворкфлоу возвращает вызывающему данные последнего
-- выполненного узла, и вызов Ingest внутри ядра сломал бы его выход.
--
-- Отсюда граница, которую важно держать при чтении этих колонок: считаются
-- только ответы В КАНАЛЕ. У «Adapter DM» узла Ingest нет вовсе, поэтому
-- ответы из лички в лог не попадают, и калибровка по ним не считается.
-- Дописывать его туда без решения нельзя: у обращения из лички нет
-- `request_created`, и такие треды уедут в `threads_without_root`
-- диагностики — то есть счётчик отсева начнёт расти по причине,
-- к отсеву отношения не имеющей.
bot AS (
    SELECT thread_id,
           max(event_ts) AS bot_answered_at,
           max_by(json_extract_scalar(payload, '$.confidence_claimed'),
                  event_ts) AS confidence_claimed,
           max_by(json_extract_scalar(payload, '$.confidence_key'),
                  event_ts) AS confidence_key,
           max_by(domains, event_ts) AS domains,
           max_by(CAST(json_extract_scalar(payload, '$.dd_count') AS integer),
                  event_ts) AS dd_count,
           -- ПЛАН и ФАКТ каталога — разные колонки, и это не педантизм.
           -- Две недели в логе стояло dd_count: 4 при нуле полученных полей:
           -- ветка каталога не выполнялась вовсе, а по логу это выглядело
           -- нормальной работой. Расхождение этих двух чисел — единственный
           -- способ увидеть такой отказ в дашборде, а не в живом прогоне.
           max_by(CAST(json_extract_scalar(payload, '$.dd_received') AS integer),
                  event_ts) AS dd_received,
           max_by(CAST(json_extract_scalar(payload, '$.dd_never_ran') AS boolean),
                  event_ts) AS dd_never_ran,
           -- Роутер не назвал НИ домена, НИ статьи, и витрину добрал код.
           -- Доля таких планов — метрика качества роутера: задним числом
           -- «роутер промахнулся» и «в базе нет ответа» по логу неразличимы.
           max_by(CAST(json_extract_scalar(payload, '$.router_empty') AS boolean),
                  event_ts) AS router_empty,
           -- Пути, которых нет в реестре: роутер их придумал. Метрика его
           -- качества, и путать её с пробелом базы нельзя — чинятся в разных
           -- местах, а по логу без этой колонки они неразличимы.
           max_by(CAST(json_extract_scalar(payload, '$.articles_invented') AS integer),
                  event_ts) AS articles_invented,
           -- Согласование ИБ: возникло требование и попало ли оно в черновик.
           -- Цена ошибки здесь не «черновик хуже», а файл с персональными
           -- данными, ушедший наружу без согласования, — поэтому обе части
           -- считаются, а не одна.
           max_by(CAST(json_extract_scalar(payload, '$.ib_required') AS boolean),
                  event_ts) AS ib_required,
           max_by(CAST(json_extract_scalar(payload, '$.ib_missing') AS boolean),
                  event_ts) AS ib_missing,
           -- Просьба помочь с запросом: по ней видно, что режим выгрузки
           -- погашен намеренно, а не просто не включился.
           max_by(CAST(json_extract_scalar(payload, '$.is_query_help') AS boolean),
                  event_ts) AS is_query_help,
           max_by(CAST(json_extract_scalar(payload, '$.is_export') AS boolean),
                  event_ts) AS bot_saw_export,
           -- Витрины, чью статью автор прочитал, а инвентарь полей не получил.
           max_by(json_array_length(json_extract(payload, '$.tables_no_meta')),
                  event_ts) AS tables_no_meta,
           -- По каким темам звали эксперта. id, а не имена: человек в реестре
           -- меняется, разрез должен пережить смену.
           max_by(json_extract_scalar(payload, '$.routes'),
                  event_ts) AS routes,
           -- Черновик не отправить как есть: служебное внутри или перелив
           -- через лимит поста. На уверенность эти проверки не влияют
           -- намеренно — основание под ответом от них не меняется.
           max_by(CAST(json_extract_scalar(payload, '$.draft_leaks') AS boolean),
                  event_ts) AS draft_leaks,
           -- Модель назвала эксперта, которого код под этот вопрос
           -- не подбирал, или инструмент аналитика, которого у коллеги нет.
           -- Обе цифры — про то, что черновик нельзя отправить как есть,
           -- и обе видит ЗАКАЗЧИК, если джун не заметит.
           max_by(CAST(json_extract_scalar(payload, '$.experts_invented') AS integer),
                  event_ts) AS experts_invented,
           max_by(CAST(json_extract_scalar(payload, '$.draft_own_tools') AS integer),
                  event_ts) AS draft_own_tools,
           -- Запрос по витрине сотрудников без фильтра активной численности.
           -- Ошибка, которую заказчик не замечает: запрос не падает, просто
           -- людей больше, чем есть. Доля показывает, держится ли умолчание.
           max_by(CAST(json_extract_scalar(payload, '$.draft_no_active_filter') AS boolean),
                  event_ts) AS draft_no_active_filter,
           -- Проверка значений в данных: она стоит ПОСЛЕ автора, и по этим
           -- четырём полям видно, дошла ли она до данных и что вернула.
           -- Разводить их обязательно: «автор не просил проверять» (0 пар),
           -- «просил, но запрос отказал» и «проверили, строк нет» чинятся
           -- в разных местах, а слитые в одну колонку неразличимы.
           max_by(CAST(json_extract_scalar(payload, '$.check_asked') AS integer),
                  event_ts) AS check_asked,
           max_by(CAST(json_extract_scalar(payload, '$.check_skipped') AS integer),
                  event_ts) AS check_skipped,
           max_by(CAST(json_extract_scalar(payload, '$.check_rows') AS integer),
                  event_ts) AS check_rows,
           max_by(json_extract_scalar(payload, '$.check_failed'),
                  event_ts) AS check_failed,
           -- Дословно ли подтвердилось значение. Отдельно от check_rows:
           -- «данные ответили» и «ответ был тот самый» — разные вещи,
           -- и доля дословных подтверждений показывает, насколько автор
           -- угадывает написание с первого раза.
           max_by(CAST(json_extract_scalar(payload, '$.check_exact') AS integer),
                  event_ts) AS check_exact,
           -- Черновик просит проверить то, что уже проверено. Метрика того,
           -- держится ли запрет в промпте автора: доля не падает — значит
           -- правило надо усиливать не формулировкой.
           max_by(CAST(json_extract_scalar(payload, '$.draft_stale_caveat') AS boolean),
                  event_ts) AS draft_stale_caveat,
           -- Переписал ли автор черновик по реальным значениям. Доля правок
           -- от числа проверок — метрика того, стоит ли второй проход своих
           -- токенов: правок нет вовсе значит, что данные ничего не меняли.
           max_by(CAST(json_extract_scalar(payload, '$.revised') AS boolean),
                  event_ts) AS revised,
           max_by(CAST(json_extract_scalar(payload, '$.draft_too_long') AS boolean),
                  event_ts) AS draft_too_long,
           max_by(CAST(json_extract_scalar(payload, '$.draft_len') AS integer),
                  event_ts) AS draft_len,
           -- Заявленную моделью уверенность понизил код, и почему именно.
           -- Причина текстом: частота каждой — это список того, что чинить.
           max_by(CAST(json_extract_scalar(payload, '$.confidence_capped') AS boolean),
                  event_ts) AS confidence_capped,
           max_by(json_extract_scalar(payload, '$.confidence_capped_reason'),
                  event_ts) AS confidence_capped_reason,
           -- Ответ человека в форме про передачу вне контура: yes / no / ''.
           -- Пустое значение при теме выгрузки — промах разбора формы, и это
           -- своя метрика: форму переформулируют, разбор промахнётся, а
           -- молчание неотличимо от «согласование не нужно».
           max_by(json_extract_scalar(payload, '$.external_transfer'),
                  event_ts) AS external_transfer,
           -- Домен, который выбрал человек в форме. Пустая колонка при
           -- заполненной форме — сигнал, что разбор формы сломался.
           max_by(json_extract_scalar(payload, '$.form_domain'),
                  event_ts) AS form_domain,
           -- Сколько пробелов базы код нашёл на этом обращении. Приоритет
           -- наполнения копится сам, и его надо уметь считать, а не читать
           -- глазами в канале джуна.
           max_by(json_array_length(json_extract(payload, '$.kb_tasks')),
                  event_ts) AS kb_tasks,
           max_by(json_array_length(json_extract(payload, '$.articles_read')),
                  event_ts) AS articles_read,
           max_by(json_extract_scalar(payload, '$.parse_error'),
                  event_ts) AS parse_error,
           max_by(json_extract_scalar(payload, '$.router_error'),
                  event_ts) AS router_error,
           max_by(json_extract_scalar(payload, '$.prompt_version'),
                  event_ts) AS prompt_version
    FROM ev
    WHERE event_type = 'bot_answered'
    GROUP BY thread_id
),

-- Оценка кнопкой. Ключ идемпотентности у события без времени, поэтому
-- повторное нажатие переписывает оценку того же человека, а не добавляет
-- вторую: один передумавший джун не весит как десять разных.
--
-- ВНИМАНИЕ: сейчас это оценка ЧЕРНОВИКА джуном (кнопки стоят под черновиком
-- в канале черновиков). `answer_helpful` — оценка ответа автором вопроса —
-- это ДРУГАЯ метрика, и складывать их нельзя. Развести их по одному
-- `bot_feedback` сейчас нечем: `channel_id` в payload вебхука не пишется.
-- Когда кнопки появятся в канале обращений, добавить его в payload — иначе
-- две разные метрики склеятся молча.
feedback AS (
    SELECT thread_id,
           max(event_ts) AS feedback_at,
           max_by(CAST(json_extract_scalar(payload, '$.helpful') AS boolean),
                  event_ts) AS draft_useful,
           count(DISTINCT actor) AS feedback_voters
    FROM ev
    WHERE event_type = 'bot_feedback'
    GROUP BY thread_id
),
feedback_text AS (
    SELECT thread_id,
           max_by(json_extract_scalar(payload, '$.text'), event_ts) AS feedback_text,
           count(*) AS feedback_texts
    FROM ev
    WHERE event_type = 'feedback_text'
    GROUP BY thread_id
),

-- Переписка в треде. `first_reply_at` — прокси-сигнал на случай, когда
-- дежурный ответил, но реакцию не поставил: без него такое обращение
-- выглядит как «никто не отреагировал».
replies AS (
    SELECT e.thread_id,
           count_if(e.event_type = 'human_replied') AS human_replies,
           count_if(e.event_type = 'bot_replied') AS bot_replies,
           min(CASE WHEN e.event_type = 'human_replied'
                     AND e.actor <> r.posted_by
                    THEN e.event_ts END) AS first_reply_at
    FROM ev e
    JOIN root r ON r.thread_id = e.thread_id
    GROUP BY e.thread_id
)

SELECT
    r.thread_id                                   AS request_id,
    r.created_at,
    CAST(r.created_at AS date)                    AS created_date,
    r.kind,
    r.topic,
    COALESCE(r.ours, false)                       AS ours,
    r.posted_by,
    r.permalink,
    r.text_len,

    -- Состояние. Переоткрытое обращение — снова в работе, а не закрытое.
    CASE
        WHEN c.closed_at IS NOT NULL THEN 'closed'
        WHEN t.taken_at  IS NOT NULL THEN 'in_progress'
        ELSE 'new'
    END                                           AS state,
    COALESCE(c.reopened, false)                   AS reopened,

    t.taken_at,
    t.taken_by,
    c.closed_at,
    c.closed_by,
    -- Разделение `:done_checkmark:` / `:im_red_cross:` даёт бесплатную метрику
    -- доли закрытых НЕрешёнными — честнее, чем «закрыто N обращений».
    c.resolved,

    -- Reaction time: самая понятная людям метрика и самая быстрая на реакцию
    -- к изменениям в процессе.
    date_diff('second', r.created_at, t.taken_at)          AS reaction_time_sec,
    -- Lead time: что чувствует заказчик. ВКЛЮЧАЕТ ожидание в очереди.
    date_diff('second', r.created_at, c.closed_at)         AS lead_time_sec,
    -- Cycle time: чем управляет команда. Очередь НЕ включает. Расхождение
    -- с lead time — это и есть длина очереди, и обычно она и есть предмет
    -- разговора: мерить только одно значит её потерять.
    date_diff('second', ts.task_created_at, ts.task_finished_at) AS cycle_time_sec,
    date_diff('second', r.created_at, rp.first_reply_at)    AS first_reply_sec,

    tk.task_key,
    tk.task_url,
    tk.tracker,
    tk.task_linked_at,
    ts.task_status,
    ts.task_is_final,
    ts.task_created_at,
    ts.task_finished_at,
    ts.task_error,

    b.bot_answered_at,
    b.confidence_claimed,
    b.confidence_key,
    -- Понижал ли код заявленную моделью уверенность. Частота понижений —
    -- сама по себе метрика качества промпта автора.
    (b.confidence_claimed IS NOT NULL
     AND b.confidence_key <> b.confidence_claimed)          AS confidence_downgraded,
    b.domains,
    b.articles_read,
    b.dd_count,
    b.dd_received,
    -- Каталог был запланирован, а узел не выполнился: отказ конвейера,
    -- не пробел базы. Слитые в один диагноз, они отправляют чинить не то.
    COALESCE(b.dd_never_ran, false)                         AS dd_never_ran,
    (b.dd_count > 0 AND COALESCE(b.dd_received, 0) = 0)     AS dd_planned_not_received,
    COALESCE(b.router_empty, false)                         AS router_empty,
    COALESCE(b.check_asked, 0)                              AS check_asked,
    COALESCE(b.check_skipped, 0)                            AS check_skipped,
    COALESCE(b.check_rows, 0)                               AS check_rows,
    COALESCE(b.check_exact, 0)                              AS check_exact,
    COALESCE(b.draft_stale_caveat, false)                   AS draft_stale_caveat,
    b.check_failed                                          AS check_failed,
    COALESCE(b.revised, false)                              AS revised,
    COALESCE(b.articles_invented, 0)                        AS articles_invented,
    COALESCE(b.ib_required, false)                          AS ib_required,
    COALESCE(b.ib_missing, false)                           AS ib_missing,
    COALESCE(b.is_query_help, false)                        AS is_query_help,
    COALESCE(b.bot_saw_export, false)                       AS bot_saw_export,
    COALESCE(b.tables_no_meta, 0)                           AS tables_no_meta,
    b.routes,
    COALESCE(b.draft_leaks, false)                          AS draft_leaks,
    COALESCE(b.experts_invented, 0)                         AS experts_invented,
    COALESCE(b.draft_own_tools, 0)                          AS draft_own_tools,
    COALESCE(b.draft_too_long, false)                        AS draft_too_long,
    b.draft_len,
    COALESCE(b.confidence_capped, false)                    AS confidence_capped,
    NULLIF(b.confidence_capped_reason, '')                  AS confidence_capped_reason,
    NULLIF(b.external_transfer, '')                         AS external_transfer,
    NULLIF(b.form_domain, '')                               AS form_domain,
    COALESCE(b.kb_tasks, 0)                                 AS kb_tasks,
    NULLIF(b.parse_error, '')                               AS parse_error,
    NULLIF(b.router_error, '')                              AS router_error,
    b.prompt_version,

    f.draft_useful,
    f.feedback_at,
    COALESCE(f.feedback_voters, 0)                          AS feedback_voters,
    ft.feedback_text,

    COALESCE(rp.human_replies, 0)                           AS human_replies,
    COALESCE(rp.bot_replies, 0)                             AS bot_replies,
    rp.first_reply_at,

    COALESCE(rh.unknown_reactions, 0)                       AS unknown_reactions,
    COALESCE(rh.reaction_types_inferred, false)             AS reaction_types_inferred

FROM root r
LEFT JOIN taken           t  ON t.thread_id  = r.thread_id
LEFT JOIN closed          c  ON c.thread_id  = r.thread_id
LEFT JOIN task            tk ON tk.thread_id = r.thread_id
LEFT JOIN task_state      ts ON ts.thread_id = r.thread_id
LEFT JOIN bot             b  ON b.thread_id  = r.thread_id
LEFT JOIN feedback        f  ON f.thread_id  = r.thread_id
LEFT JOIN feedback_text   ft ON ft.thread_id = r.thread_id
LEFT JOIN replies         rp ON rp.thread_id = r.thread_id
LEFT JOIN reaction_health rh ON rh.thread_id = r.thread_id
;


-- ===========================================================================
-- Диагностика: что витрина ОТБРОСИЛА. Запускать вместе с пересчётом.
--
-- Треды без `request_created` — это реплики чужих тредов и посты, у которых
-- корневое событие не поймано коллектором (перезапуск n8n). Их отсев
-- правильный, но НЕназванный отсев неотличим от «обращений стало меньше»:
-- то же число покажет и поломка разбора темы, и остановившийся коллектор.
--
-- `unsupported_event` и `skipped` тоже здесь: первый означает событие,
-- которого нормализатор не знает (в payload лежат его ключи — по одной
-- строке видно форму), второй — отфильтрованное действие бота.
-- ===========================================================================
WITH dedup AS (
    SELECT e.*,
           ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingested_at DESC) AS rn
    FROM dl.usr_cross_data.support_telemetry e
    WHERE e.event_type <> 'schema_sample'
),
ev AS (
    SELECT * FROM dedup WHERE rn = 1
),
roots AS (
    SELECT DISTINCT thread_id FROM ev WHERE event_type = 'request_created'
),
-- Треды из ЛИЧКИ. У обращения в личке нет `request_created`: формы там нет,
-- intake-воркфлоу его не публикует, и корневого события просто не бывает.
-- Без этого исключения каждый ответ бота в личку увеличивал бы
-- `threads_without_root` — счётчик, который заведён ловить остановившийся
-- коллектор и поломанный разбор темы. Нормальная работа лички выглядела бы
-- в нём как поломка канала, и смысл счётчика пропал бы целиком.
dm_threads AS (
    SELECT DISTINCT thread_id FROM ev WHERE source = 'dm'
)
SELECT
    count(DISTINCT ev.thread_id)                                    AS threads_total,
    count(DISTINCT roots.thread_id)                                 AS requests,
    count(DISTINCT dm.thread_id)                                    AS dm_answers,
    count(DISTINCT ev.thread_id) - count(DISTINCT roots.thread_id)
                                 - count(DISTINCT dm.thread_id)     AS threads_without_root,
    count_if(ev.event_type = 'unsupported_event')                   AS unsupported_events,
    -- Прогон backfill, который не нашёл ни одного поста: неверный channel_id
    -- или период. В лог это уезжает как `unsupported_event` (нормализатор
    -- такого имени не знает), и без отдельного счётчика сбой засева
    -- смешивался бы с «пришло событие неизвестной формы» — поломки разные,
    -- лечатся в разных местах.
    count_if(ev.event_type = 'unsupported_event'
             AND json_extract_scalar(ev.payload, '$.event') = 'backfill_empty')
                                                                    AS backfill_empty_runs,
    -- Засев оборвался на первой странице: GET /channels/{id}/posts отдаёт
    -- per_page постов и ссылку на следующую страницу, а Backfill берёт одну.
    -- Ненулевое значение здесь значит, что метрик за ранний период просто
    -- НЕТ — и это неотличимо от «тогда обращений не было», если не считать
    -- отдельно. Лечится повторными прогонами с полем `before`.
    count_if(ev.event_type = 'unsupported_event'
             AND json_extract_scalar(ev.payload, '$.event') = 'backfill_truncated')
                                                                    AS backfill_truncated_runs,
    count_if(ev.event_type = 'skipped')                             AS skipped_events,
    count_if(ev.event_type = 'request_created' AND ev.kind = 'unknown') AS topic_unrecognized,
    count_if(ev.event_type = 'request_created'
             AND CAST(json_extract_scalar(ev.payload, '$.ours') AS boolean) = false)
                                                                    AS foreign_team_requests,
    count_if(ev.event_type IN ('reaction_added', 'reaction_removed')) AS unknown_reactions,
    count_if(ev.thread_id = '')                                     AS events_without_thread,
    -- Расхождение event_ts и ingested_at показывает лаг записи и работу
    -- backfill: у засеянной истории оно в недели.
    max(date_diff('second', ev.event_ts, ev.ingested_at))            AS max_ingest_lag_sec
FROM ev
LEFT JOIN roots ON roots.thread_id = ev.thread_id
LEFT JOIN dm_threads dm ON dm.thread_id = ev.thread_id
;


-- ===========================================================================
-- Метрики процесса: p50 и p85 по типам обращений.
--
-- Именно p50 и p85, а не среднее: среднее по правому хвосту врёт всегда,
-- а p85 — это те самые пара выгрузок в неделю, из-за которых на команду
-- смотрят криво.
--
-- `ours = false` (обращения к HC Data) исключены: их считаем отдельно.
-- «Нет доступа к отчёту» (`report_access`) — регламентная работа, а не вопрос
-- к данным; в общей медиане она размывает картину, поэтому разрез по `kind`
-- обязателен, а не для красоты.
-- ===========================================================================
SELECT
    kind,
    count(*)                                              AS requests,
    count_if(state = 'closed')                            AS closed,
    count_if(state = 'closed' AND resolved = false)       AS closed_unresolved,
    count_if(state = 'new')                               AS never_taken,
    count_if(reopened)                                    AS reopened,

    approx_percentile(reaction_time_sec, 0.5)  / 60.0     AS reaction_p50_min,
    approx_percentile(reaction_time_sec, 0.85) / 60.0     AS reaction_p85_min,
    approx_percentile(lead_time_sec, 0.5)  / 3600.0       AS lead_p50_hours,
    approx_percentile(lead_time_sec, 0.85) / 3600.0       AS lead_p85_hours,
    approx_percentile(cycle_time_sec, 0.5)  / 3600.0      AS cycle_p50_hours,
    approx_percentile(cycle_time_sec, 0.85) / 3600.0      AS cycle_p85_hours,

    -- Калибровка — самая ценная метрика: врущий confidence опаснее низкого
    -- покрытия. Считается по паре «заявлено моделью / осталось после кода».
    -- КЛЮЧИ АНГЛИЙСКИЕ: ядро приводит уверенность к high / medium / none
    -- (`build_time_flows.py`, `out.confidence_claimed`), а по-русски она
    -- печатается только в сообщении джуну. Сравнение со словом «высокая»
    -- не совпадало НИКОГДА — то есть самая ценная метрика проекта считала
    -- ноль и выглядела при этом рабочей: колонка есть, запрос зелёный,
    -- в ней просто всегда 0. Тест 38 держит эти значения по сборщику.
    count_if(confidence_claimed = 'high')                  AS claimed_high,
    count_if(confidence_claimed = 'high'
             AND draft_useful = false)                     AS claimed_high_but_useless,
    count_if(confidence_key = 'none')                      AS no_answer,
    count_if(confidence_claimed = 'unknown')               AS format_broken,
    count_if(confidence_downgraded)                        AS downgraded_by_code,
    count_if(parse_error IS NOT NULL)                      AS parse_errors,

    -- Кнопки нажимают единицы, поэтому ненажатие за «плохо» считать нельзя:
    -- знаменатель здесь — только те обращения, где оценка есть.
    count_if(draft_useful IS NOT NULL)                     AS rated,
    count_if(draft_useful)                                 AS rated_useful,

    -- ---------------------------------------------------------------- бот
    -- Отказы КОНСТРУКЦИИ, а не пробелы базы. Разбор фидбека 2026-08-26/27:
    -- в 24 обращениях из 49 бот отвечал, не видя ни одного имени поля, —
    -- и по логу это было неотличимо от нормальной работы. Каждая строка
    -- ниже — свой класс поломки, который чинится в своём месте, поэтому
    -- они и не сложены в один счётчик «бот сработал плохо».
    count_if(dd_never_ran)                                 AS dd_node_never_ran,
    count_if(dd_planned_not_received)                      AS dd_planned_not_received,
    count_if(router_empty)                                 AS router_empty_plan,
    count_if(articles_invented > 0)                        AS router_invented_paths,
    count_if(tables_no_meta > 0)                           AS tables_without_inventory,
    count_if(parse_error IS NOT NULL OR router_error IS NOT NULL) AS bot_errors,

    -- Согласование ИБ: сколько обращений его требовали и в скольких оно
    -- не доехало до черновика. Вторая цифра — единственная в этом списке,
    -- у которой цена ошибки не «черновик хуже», а файл с персональными
    -- данными, ушедший наружу без согласования.
    count_if(ib_required)                                  AS ib_required,
    count_if(ib_required AND ib_missing)                   AS ib_missing_in_draft,
    -- Форма про передачу вне контура заполнена, а разбор её не понял:
    -- переформулировали подпись поля. Молчание здесь неотличимо от
    -- «согласование не нужно», поэтому считается отдельно.
    count_if(bot_saw_export AND external_transfer IS NULL) AS transfer_unparsed,

    -- Черновик нельзя отправить как есть. На уверенность эти проверки
    -- не влияют намеренно, но джун правит руками именно их.
    count_if(draft_leaks)                                  AS draft_leaks,
    count_if(draft_too_long)                               AS draft_split,
    count_if(experts_invented > 0)                         AS experts_invented,
    count_if(draft_own_tools > 0)                          AS own_tools_offered,

    -- Насколько живёт то, что добавлено последним: проверка значений
    -- в данных и маршруты к экспертам. Ноль здесь значит «ни разу
    -- не сработало», и это надо видеть, а не предполагать.
    --
    -- Три числа, а не одно: «автор не просил проверять», «просил, но запрос
    -- отказал» и «проверили, и черновик переписан» чинятся в разных местах.
    -- Слитые в одну колонку, они отправляют чинить не то.
    count_if(check_asked > 0)                              AS check_requested,
    count_if(check_exact > 0)                              AS check_exact_hit,
    count_if(draft_stale_caveat)                           AS stale_caveat,
    count_if(check_failed IS NOT NULL AND check_failed <> '') AS check_failed,
    count_if(revised)                                      AS draft_revised,
    count_if(routes IS NOT NULL AND routes <> '[]')        AS expert_suggested,
    -- Пробелы базы, найденные кодом. Приоритет наполнения копится сам —
    -- сумма по неделе и есть очередь на статьи.
    sum(kb_tasks)                                          AS kb_gaps_found
FROM dl.usr_cross_data.support_request
WHERE ours
  AND created_at >= current_timestamp - INTERVAL '30' DAY
GROUP BY kind
ORDER BY requests DESC
;


-- ===========================================================================
-- Качество ответов бота: КАНАЛ и ЛИЧКА рядом, но не в одной куче.
--
-- Отдельный запрос, а не колонки в support_request, и причина конструктивная:
-- витрина обращений построена на `request_created`, а у обращения из лички
-- такого события нет вовсе — формы там нет, intake-воркфлоу его не публикует.
-- Ответы бота в личку в support_request не попадают и попасть не могут.
--
-- Смешивать их с канальными нельзя и по существу: у лички нет ни реакций
-- дежурного, ни задачи в трекере, поэтому время реакции, время решения
-- и доля закрытых по ней не считаются. Строки с NULL в этих полях разбавили
-- бы каждую метрику процесса. А вот КАЛИБРОВКА считается одинаково: что бот
-- заявил, что осталось после понижения кодом, на чём он это построил, —
-- и её надо смотреть по обоим источникам, потому что в личке спрашивают
-- иначе, чем через форму.
--
-- Разрез идёт по `channel_kind` из payload, а не по колонке `source`:
-- колонку ставит нормализатор и может переопределить, а payload пишет
-- сам адаптер и знает, откуда пришло обращение.
-- ===========================================================================
WITH dedup AS (
    SELECT e.*,
           ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingested_at DESC) AS rn
    FROM dl.usr_cross_data.support_telemetry e
    WHERE e.event_type = 'bot_answered'
      AND e.event_type <> 'schema_sample'
),
ans AS (
    SELECT thread_id,
           CASE WHEN event_ts < TIMESTAMP '2000-01-01 00:00:00' THEN NULL
                ELSE event_ts END                                   AS answered_at,
           COALESCE(NULLIF(json_extract_scalar(payload, '$.channel_kind'), ''),
                    source)                                         AS channel_kind,
           json_extract_scalar(payload, '$.confidence_claimed')      AS confidence_claimed,
           json_extract_scalar(payload, '$.confidence_key')          AS confidence_key,
           CAST(json_extract_scalar(payload, '$.confidence_capped') AS boolean)
                                                                     AS confidence_capped,
           json_extract_scalar(payload, '$.capped_reason')           AS capped_reason,
           json_extract_scalar(payload, '$.prompt_version')          AS prompt_version,
           CAST(json_extract_scalar(payload, '$.dd_count') AS integer)    AS dd_count,
           CAST(json_extract_scalar(payload, '$.dd_received') AS integer) AS dd_received,
           CAST(json_extract_scalar(payload, '$.dd_never_ran') AS boolean) AS dd_never_ran,
           CAST(json_extract_scalar(payload, '$.router_empty') AS boolean) AS router_empty,
           CAST(json_extract_scalar(payload, '$.articles_invented') AS integer)
                                                                     AS articles_invented,
           CAST(json_extract_scalar(payload, '$.check_asked') AS integer)  AS check_asked,
           CAST(json_extract_scalar(payload, '$.check_rows') AS integer)   AS check_rows,
           json_extract_scalar(payload, '$.check_failed')                  AS check_failed,
           CAST(json_extract_scalar(payload, '$.revised') AS boolean)      AS revised,
           CAST(json_extract_scalar(payload, '$.ib_required') AS boolean)  AS ib_required,
           CAST(json_extract_scalar(payload, '$.ib_missing') AS boolean)   AS ib_missing,
           CAST(json_extract_scalar(payload, '$.experts_invented') AS integer)
                                                                     AS experts_invented,
           CAST(json_extract_scalar(payload, '$.draft_own_tools') AS integer)
                                                                     AS draft_own_tools,
           CAST(json_extract_scalar(payload, '$.kb_tasks') AS integer)     AS kb_tasks,
           NULLIF(json_extract_scalar(payload, '$.parse_error'), '')  AS parse_error,
           NULLIF(json_extract_scalar(payload, '$.router_error'), '') AS router_error
    FROM dedup
    WHERE rn = 1
)
SELECT
    channel_kind,
    prompt_version,
    count(*)                                               AS answers,

    -- Калибровка. Ключи английские — так их пишет ядро (см. тест 38).
    count_if(confidence_claimed = 'high')                  AS claimed_high,
    count_if(confidence_key = 'high')                      AS effective_high,
    count_if(confidence_capped)                            AS downgraded_by_code,
    count_if(confidence_key = 'none')                      AS no_answer,
    count_if(confidence_claimed = 'unknown')               AS format_broken,

    -- Отказы конструкции. Каждая строка — свой класс поломки, чинится
    -- в своём месте, поэтому они и не сложены в один счётчик.
    count_if(dd_never_ran)                                 AS dd_node_never_ran,
    count_if(dd_count > 0 AND COALESCE(dd_received, 0) = 0) AS dd_planned_not_received,
    count_if(router_empty)                                 AS router_empty_plan,
    count_if(COALESCE(articles_invented, 0) > 0)           AS router_invented_paths,
    count_if(parse_error IS NOT NULL OR router_error IS NOT NULL) AS bot_errors,

    -- Черновик нельзя отправить как есть.
    count_if(ib_required AND ib_missing)                   AS ib_missing_in_draft,
    count_if(COALESCE(experts_invented, 0) > 0)            AS experts_invented,
    count_if(COALESCE(draft_own_tools, 0) > 0)             AS own_tools_offered,
    count_if(draft_no_active_filter)                       AS no_active_filter,

    count_if(COALESCE(check_asked, 0) > 0)                 AS check_requested,
    count_if(check_failed IS NOT NULL AND check_failed <> '') AS check_failed,
    count_if(COALESCE(revised, false))                     AS draft_revised,
    sum(COALESCE(kb_tasks, 0))                             AS kb_gaps_found
FROM ans
WHERE answered_at >= current_timestamp - INTERVAL '30' DAY
GROUP BY channel_kind, prompt_version
ORDER BY channel_kind, prompt_version
;
