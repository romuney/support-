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
--     в событии не было (`skipped`, часть служебных), и в DLH это
--     1970-01-01. Здесь такие значения превращаются в NULL до всякой
--     арифметики — иначе reaction time уехал бы в минус 56 лет.
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
           NULLIF(event_ts, TIMESTAMP '1970-01-01 00:00:00') AS event_ts,
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

-- Ответ бота. Колонки будут NULL до того, как в ядро врежут узел `Ingest`:
-- событие `bot_answered` пока никто не пишет. Это не поломка витрины —
-- по числу NULL как раз видно, дошла ли врезка до прода.
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
)
SELECT
    count(DISTINCT ev.thread_id)                                    AS threads_total,
    count(DISTINCT roots.thread_id)                                 AS requests,
    count(DISTINCT ev.thread_id) - count(DISTINCT roots.thread_id)  AS threads_without_root,
    count_if(ev.event_type = 'unsupported_event')                   AS unsupported_events,
    -- Прогон backfill, который не нашёл ни одного поста: неверный channel_id
    -- или период. В лог это уезжает как `unsupported_event` (нормализатор
    -- такого имени не знает), и без отдельного счётчика сбой засева
    -- смешивался бы с «пришло событие неизвестной формы» — поломки разные,
    -- лечатся в разных местах.
    count_if(ev.event_type = 'unsupported_event'
             AND json_extract_scalar(ev.payload, '$.event') = 'backfill_empty')
                                                                    AS backfill_empty_runs,
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
    count_if(confidence_claimed = 'высокая')               AS claimed_high,
    count_if(confidence_claimed = 'высокая'
             AND draft_useful = false)                     AS claimed_high_but_useless,
    count_if(confidence_downgraded)                        AS downgraded_by_code,
    count_if(parse_error IS NOT NULL)                      AS parse_errors,

    -- Кнопки нажимают единицы, поэтому ненажатие за «плохо» считать нельзя:
    -- знаменатель здесь — только те обращения, где оценка есть.
    count_if(draft_useful IS NOT NULL)                     AS rated,
    count_if(draft_useful)                                 AS rated_useful
FROM dl.usr_cross_data.support_request
WHERE ours
  AND created_at >= current_timestamp - INTERVAL '30' DAY
GROUP BY kind
ORDER BY requests DESC
;
