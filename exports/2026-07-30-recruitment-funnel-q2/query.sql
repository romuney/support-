-- Воронка подбора за период, гранулярность: кандидат x вакансия
-- Выгрузка: exports/2026-07-30-recruitment-funnel-q2/
-- Состав полей согласован письменно 2026-07-31, см. fields.md
-- СУБД: PostgreSQL 14 (витрина dwh_hr)
--
-- Параметры:
--   :period_from - начало периода, включительно (для Q2 2026: '2026-04-01')
--   :period_to   - конец периода, включительно  (для Q2 2026: '2026-06-30')
--
-- ВНИМАНИЕ: период фильтрует ДАТУ ПЕРЕХОДА СТАДИИ, а не дату отклика.
-- Пара кандидат x вакансия попадает в выгрузку, если хотя бы один переход
-- случился внутри периода. Отклик при этом мог быть раньше - это осознанно,
-- см. п.2 в README.md.

WITH params AS (
    SELECT
        CAST(:period_from AS date) AS period_from,
        CAST(:period_to   AS date) AS period_to
),

-- Порядок стадий воронки. Держим здесь, а не в CASE по коду,
-- чтобы при добавлении стадии правилось одно место.
stage_order AS (
    SELECT * FROM (VALUES
        ('applied',   1),
        ('screening', 2),
        ('interview', 3),
        ('offer',     4),
        ('hired',     5)
    ) AS t(stage_code, stage_rank)
),

-- Пары кандидат x вакансия, у которых был хотя бы один переход в периоде.
pairs_in_period AS (
    SELECT DISTINCT
        s.candidate_sk,
        s.vacancy_id
    FROM dwh_hr.fct_candidate_stage s
    CROSS JOIN params p
    WHERE s.stage_date BETWEEN p.period_from AND p.period_to
),

-- Вся история стадий по отобранным парам (включая переходы вне периода:
-- отклик мог быть в марте, он нужен как application_date).
stages AS (
    SELECT
        s.candidate_sk,
        s.vacancy_id,
        s.stage_code,
        s.stage_date,
        s.source,
        s.source_utm,
        s.is_rejected,
        s.rejection_reason,
        so.stage_rank
    FROM dwh_hr.fct_candidate_stage s
    JOIN pairs_in_period pp
      ON pp.candidate_sk = s.candidate_sk
     AND pp.vacancy_id   = s.vacancy_id
    JOIN stage_order so
      ON so.stage_code = s.stage_code
),

-- Максимально достигнутая стадия по паре.
max_stage AS (
    SELECT DISTINCT ON (candidate_sk, vacancy_id)
        candidate_sk,
        vacancy_id,
        stage_code       AS max_stage,
        stage_date       AS max_stage_date,
        stage_rank       AS max_stage_rank,
        is_rejected,
        rejection_reason
    FROM stages
    ORDER BY candidate_sk, vacancy_id, stage_rank DESC, stage_date DESC
),

-- Дата отклика и источник берутся со стадии applied - источник рекрутер
-- проставляет при обработке отклика и дальше не меняет.
application AS (
    SELECT DISTINCT ON (candidate_sk, vacancy_id)
        candidate_sk,
        vacancy_id,
        stage_date AS application_date,
        source,
        source_utm
    FROM stages
    WHERE stage_code = 'applied'
    ORDER BY candidate_sk, vacancy_id, stage_date
),

-- Дата принятия оффера кандидатом (не дата выставления оффера).
offer AS (
    SELECT
        candidate_sk,
        vacancy_id,
        MIN(stage_date) AS offer_date
    FROM stages
    WHERE stage_code = 'offer'
    GROUP BY candidate_sk, vacancy_id
),

-- Признак первого отклика кандидата в периоде: даёт срез "по людям"
-- без схлопывания строк (компромисс по п.1 README).
primary_flag AS (
    SELECT
        a.candidate_sk,
        a.vacancy_id,
        ROW_NUMBER() OVER (
            PARTITION BY a.candidate_sk
            ORDER BY a.application_date, a.vacancy_id
        ) = 1 AS is_primary_application
    FROM application a
),

-- Подразделение вакансии НА ДАТУ ПУБЛИКАЦИИ: dim_org_unit - SCD2,
-- после реорганизации 01.05.2026 текущее имя ломает сравнение кварталов.
org_at_publish AS (
    SELECT
        v.vacancy_id,
        ou.org_unit_name AS org_unit_at_publish
    FROM dwh_hr.dim_vacancy v
    JOIN dwh_hr.dim_org_unit ou
      ON ou.org_unit_id = v.org_unit_id
     AND v.published_at >= ou.valid_from
     AND v.published_at <  ou.valid_to
),

org_current AS (
    SELECT
        v.vacancy_id,
        ou.org_unit_name AS org_unit_current
    FROM dwh_hr.dim_vacancy v
    JOIN dwh_hr.dim_org_unit ou
      ON ou.org_unit_id = v.org_unit_id
     AND ou.is_current  = TRUE
)

SELECT
    ms.candidate_sk,                                  -- 1
    ms.vacancy_id,                                    -- 2
    v.vacancy_title,                                  -- 3
    oap.org_unit_at_publish,                          -- 4
    oc.org_unit_current,                              -- 5
    v.hiring_type,                                    -- 6
    a.application_date,                               -- 7
    a.source,                                         -- 8
    a.source_utm,                                     -- 9
    ms.max_stage,                                     -- 10
    ms.max_stage_date,                                -- 11
    COALESCE(ms.is_rejected, FALSE) AS is_rejected,   -- 12
    ms.rejection_reason,                              -- 13
    o.offer_date,                                     -- 14
    h.hire_date,                                      -- 15
    pf.is_primary_application                         -- 16
FROM max_stage ms
JOIN dwh_hr.dim_vacancy   v   ON v.vacancy_id   = ms.vacancy_id
JOIN dwh_hr.dim_candidate c   ON c.candidate_sk = ms.candidate_sk
LEFT JOIN application     a   ON a.candidate_sk = ms.candidate_sk AND a.vacancy_id = ms.vacancy_id
LEFT JOIN offer           o   ON o.candidate_sk = ms.candidate_sk AND o.vacancy_id = ms.vacancy_id
LEFT JOIN primary_flag    pf  ON pf.candidate_sk = ms.candidate_sk AND pf.vacancy_id = ms.vacancy_id
LEFT JOIN org_at_publish  oap ON oap.vacancy_id = ms.vacancy_id
LEFT JOIN org_current     oc  ON oc.vacancy_id  = ms.vacancy_id
-- Стык с 1С:ЗУП. LEFT JOIN осознанно: у вышедших последними днями июня
-- кадровое событие могло ещё не доехать в витрину, такие строки не теряем.
LEFT JOIN dwh_hr.fct_hire h
       ON h.candidate_sk = ms.candidate_sk
      AND h.vacancy_id   = ms.vacancy_id
ORDER BY v.hiring_type, ms.vacancy_id, ms.max_stage_rank DESC, ms.candidate_sk;


-- ---------------------------------------------------------------------------
-- ПРОВЕРКИ ПЕРЕД ОТПРАВКОЙ ФАЙЛА
-- Прогоняются все три, результаты пишутся в result.md.
-- Расхождение больше допуска - файл не отдаём, идём разбираться.
-- ---------------------------------------------------------------------------

-- ПРОВЕРКА 1. Контрольная сумма против дашборда «Воронка подбора»
-- (BI → HR → Подбор → Воронка подбора, фильтр: период Q2 2026, все направления).
-- Сравниваем количество строк по каждой достигнутой стадии.
-- Допуск: 0. Дашборд и выгрузка читают одну витрину, расхождение = ошибка в запросе.
--
-- SELECT max_stage, COUNT(*) AS cnt
-- FROM (<основной запрос>) t
-- GROUP BY max_stage
-- ORDER BY cnt DESC;

-- ПРОВЕРКА 2. Гранулярность: одна строка = одна пара кандидат x вакансия.
-- Должно вернуть 0 строк. Если вернуло больше - где-то размножил JOIN
-- (первый подозреваемый - dim_org_unit: SCD2 без условия по дате даёт дубли).
--
-- SELECT candidate_sk, vacancy_id, COUNT(*)
-- FROM (<основной запрос>) t
-- GROUP BY candidate_sk, vacancy_id
-- HAVING COUNT(*) > 1;

-- ПРОВЕРКА 3. Стык систем E-Staff ↔ 1С:ЗУП.
-- У всех со стадией 'hired' должна быть дата выхода из ЗУП.
-- Допуск: строки с max_stage_date в последние 5 дней периода (кадровое событие
-- ещё не доехало). Всё, что старше, - разбираем поштучно до отправки файла.
--
-- SELECT COUNT(*) AS hired_without_zup_date
-- FROM (<основной запрос>) t
-- WHERE t.max_stage = 'hired'
--   AND t.hire_date IS NULL
--   AND t.max_stage_date < CAST(:period_to AS date) - INTERVAL '5 days';
