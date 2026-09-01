-- =====================================================================
-- ШАБЛОН v2.1: стаж в атрибуте X в рамках последнего найма
-- Описание, параметры и правила проверки — в attribute-tenure.md
--
-- Витрина: ровно 1 строка на (rk, business_dt), календарь непрерывный
-- Опционально: ограничение когорты по периоду последнего найма
--
-- Ниже два варианта:
--   ЧАСТЬ 1 — Jinja (Superset / Proteus)
--   ЧАСТЬ 2 — plain-SQL (интерпретатор GP)
-- =====================================================================


-- =====================================================================
-- ЧАСТЬ 1. Jinja-версия для Superset / Proteus
-- =====================================================================
{% set attr_column     = attr_column     | default('emp_specialization_desc') %}
{% set attr_value      = attr_value      | default('Бизнес-аналитик BI') %}
{% set mart_table      = mart_table      | default('prod_v_emart.mdm_employee_structure_d') %}
{% set mart_min_date   = mart_min_date   | default('2021-01-01') %}
{% set only_current    = only_current    | default(true) %}
-- когортный фильтр по периоду последнего найма (а не «когда-либо нанимался в окне»)
{% set last_hire_from  = last_hire_from  | default(none) %}
{% set last_hire_to    = last_hire_to    | default(none) %}

with
-- 0. Последний период найма у сотрудника
last_hire as (
    select
        mdm_employee_rk
      , max(company_hire_dt) as last_company_hire_dt
    from {{ mart_table }}
    group by mdm_employee_rk
)

-- 0a. Когорта: оставляем только тех, у кого ПОСЛЕДНИЙ найм попадает в окно
,   target_cohort as (
    select mdm_employee_rk, last_company_hire_dt
    from last_hire
    where 1=1
      {% if last_hire_from %}and last_company_hire_dt >= date '{{ last_hire_from }}'{% endif %}
      {% if last_hire_to   %}and last_company_hire_dt <= date '{{ last_hire_to   }}'{% endif %}
)

-- 1. Подневная история в целевом значении атрибута в рамках последнего найма
--    Витрина уникальна по (rk, business_dt) — join обязан сохранить эту уникальность.
--    КЛЮЧЕВОЕ: join по ДВУМ полям, иначе размножим строки при ре-наймах.
,   emp_daily as (
    select
        s.mdm_employee_rk
      , s.business_dt
      , s.company_hire_dt
      , s.company_fire_dt
      , s.active_employee_flg
      , s.company_fire_flg
    from {{ mart_table }} s
    join target_cohort tc
      on tc.mdm_employee_rk       = s.mdm_employee_rk
     and tc.last_company_hire_dt  = s.company_hire_dt   -- ОБЯЗАТЕЛЬНО оба поля
    where s.{{ attr_column }} = '{{ attr_value }}'
      and s.business_dt     >= date '{{ mart_min_date }}'
)

-- 2. Маркируем разрывы (gaps & islands)
,   islands_marked as (
    select e.*,
        case when lag(business_dt) over (
                partition by mdm_employee_rk order by business_dt
             ) = business_dt - interval '1 day'
             then 0 else 1
        end as is_new_island
    from emp_daily e
)

-- 3. Нумеруем острова
,   islands_numbered as (
    select im.*,
        sum(is_new_island) over (
            partition by mdm_employee_rk
            order by business_dt
            rows between unbounded preceding and current row
        ) as island_id
    from islands_marked im
)

-- 4. Сворачиваем острова
,   islands_raw as (
    select
        mdm_employee_rk
      , max(company_hire_dt)     as company_hire_dt
      , max(company_fire_dt)     as company_fire_dt
      , max(active_employee_flg) as active_employee_flg
      , max(company_fire_flg)    as company_fire_flg
      , island_id
      , min(business_dt)         as island_start_raw
      , max(business_dt)         as island_end_raw
      , count(*)                 as days_in_island
    from islands_numbered
    group by mdm_employee_rk, island_id
)

-- 5. Глобальные границы витрины
,   bounds as (
    select min(business_dt) as mart_min_dt, max(business_dt) as mart_max_dt
    from {{ mart_table }}
)

-- 6. Корректировка границ
,   islands_adjusted as (
    select i.*,
        case
            when i.island_start_raw = b.mart_min_dt
                 and i.company_hire_dt < b.mart_min_dt
            then i.company_hire_dt
            else i.island_start_raw
        end as period_start_dt,
        case
            when i.island_end_raw = b.mart_max_dt
                 and i.active_employee_flg = 1
                 and i.company_fire_flg = 0
            then b.mart_max_dt
            when i.company_fire_flg = 1
                 and i.company_fire_dt between i.island_start_raw and b.mart_max_dt
                 and i.island_end_raw = b.mart_max_dt
            then i.company_fire_dt
            else i.island_end_raw
        end as period_end_dt,
        b.mart_min_dt, b.mart_max_dt
    from islands_raw i cross join bounds b
)

-- 7. Длительность периода + sanity check
,   periods as (
    select ia.*, (period_end_dt - period_start_dt) + 1 as period_days
    from islands_adjusted ia
)

-- 8. SANITY-CHECK: витрина непрерывна, поэтому days_in_island ОБЯЗАН равняться
--    (island_end_raw - island_start_raw + 1). Если нет — где-то размножили строки.
,   sanity as (
    select
        count(*) filter (
            where days_in_island <> (island_end_raw - island_start_raw + 1)
        ) as broken_islands_cnt
      , count(*)                                              as total_islands_cnt
      , max(days_in_island - (island_end_raw - island_start_raw + 1)) as max_overcount
    from islands_raw
)

-- 9. Атрибуты сотрудника для финальной выгрузки
--    ВАЖНО: берём атрибуты НА ДАТУ НАЙМА (business_dt = company_hire_dt),
--    а НЕ last_day_flg=1, чтобы не потерять уволенных сотрудников
,   employee_info as (
    select
        p.mdm_employee_rk
      , max(e.ad_login) as ad_login
      , max(e.full_nm)  as full_nm
    from periods p
    join {{ mart_table }} e
        on e.mdm_employee_rk = p.mdm_employee_rk
       and e.business_dt = p.company_hire_dt  -- На дату найма, не last_day_flg
    group by p.mdm_employee_rk
)

-- 10. Итог
select
    p.mdm_employee_rk
  , ei.ad_login
  , ei.full_nm
  , p.company_hire_dt                       as last_company_hire_dt
  , min(p.period_start_dt)                  as first_attr_start_dt
  , max(p.period_end_dt)                    as last_attr_end_dt
  , count(*)                                as attr_periods_cnt
  , sum(p.period_days)                      as attr_tenure_days
  , round(sum(p.period_days) / 365.25, 2)   as attr_tenure_years
  , round(sum(p.period_days) / 30.44, 2)    as attr_tenure_months
  , (select broken_islands_cnt from sanity) as _qa_broken_islands  -- ДОЛЖНО быть 0
  , (select max_overcount     from sanity)  as _qa_max_overcount   -- ДОЛЖНО быть 0
from periods p
join employee_info ei on ei.mdm_employee_rk = p.mdm_employee_rk
{% if only_current %}
where exists (
    select 1 from {{ mart_table }} cur
    where cur.mdm_employee_rk     = p.mdm_employee_rk
      and cur.last_day_flg        = 1
      and cur.active_employee_flg = 1
      and cur.company_fire_flg    = 0
      and cur.{{ attr_column }}   = '{{ attr_value }}'
)
{% endif %}
group by 1, 2, 3, 4
order by attr_tenure_days desc;


-- =====================================================================
-- ЧАСТЬ 2. Plain-SQL для интерпретатора GP
--
-- Jinja-синтаксис в GP не работает. Ниже готовый пример:
--   attr_column = emp_specialization_desc
--   attr_value  = 'Бизнес-аналитик BI'
--   only_current = true
-- Для другого атрибута заменить имя поля и значение в CTE emp_daily
-- и в блоке where exists.
-- =====================================================================

with
-- 0. Последний период найма у сотрудника
last_hire as (
    select
        mdm_employee_rk
      , max(company_hire_dt) as last_company_hire_dt
    from prod_v_emart.mdm_employee_structure_d
    group by mdm_employee_rk
)

-- 1. Подневная история в целевом значении атрибута в рамках последнего найма
,   emp_daily as (
    select
        s.mdm_employee_rk
      , s.business_dt
      , s.company_hire_dt
      , s.company_fire_dt
      , s.active_employee_flg
      , s.company_fire_flg
    from prod_v_emart.mdm_employee_structure_d s
    join last_hire lh
      on lh.mdm_employee_rk       = s.mdm_employee_rk
     and lh.last_company_hire_dt  = s.company_hire_dt
    where s.emp_specialization_desc = 'Бизнес-аналитик BI'
      and s.business_dt     >= date '2021-01-01'
)

-- 2. Маркируем разрывы (gaps & islands)
,   islands_marked as (
    select e.*,
        case when lag(business_dt) over (
                partition by mdm_employee_rk order by business_dt
             ) = business_dt - interval '1 day'
             then 0 else 1
        end as is_new_island
    from emp_daily e
)

-- 3. Нумеруем острова
,   islands_numbered as (
    select im.*,
        sum(is_new_island) over (
            partition by mdm_employee_rk
            order by business_dt
            rows between unbounded preceding and current row
        ) as island_id
    from islands_marked im
)

-- 4. Сворачиваем острова
,   islands_raw as (
    select
        mdm_employee_rk
      , max(company_hire_dt)     as company_hire_dt
      , max(company_fire_dt)     as company_fire_dt
      , max(active_employee_flg) as active_employee_flg
      , max(company_fire_flg)    as company_fire_flg
      , island_id
      , min(business_dt)         as island_start_raw
      , max(business_dt)         as island_end_raw
      , count(*)                 as days_in_island
    from islands_numbered
    group by mdm_employee_rk, island_id
)

-- 5. Глобальные границы витрины
,   bounds as (
    select min(business_dt) as mart_min_dt, max(business_dt) as mart_max_dt
    from prod_v_emart.mdm_employee_structure_d
)

-- 6. Корректировка границ
,   islands_adjusted as (
    select i.*,
        case
            when i.island_start_raw = b.mart_min_dt
                 and i.company_hire_dt < b.mart_min_dt
            then i.company_hire_dt
            else i.island_start_raw
        end as period_start_dt,
        case
            when i.island_end_raw = b.mart_max_dt
                 and i.active_employee_flg = 1
                 and i.company_fire_flg = 0
            then b.mart_max_dt
            when i.company_fire_flg = 1
                 and i.company_fire_dt between i.island_start_raw and b.mart_max_dt
                 and i.island_end_raw = b.mart_max_dt
            then i.company_fire_dt
            else i.island_end_raw
        end as period_end_dt,
        b.mart_min_dt, b.mart_max_dt
    from islands_raw i cross join bounds b
)

-- 7. Длительность периода + sanity check
,   periods as (
    select ia.*, (period_end_dt - period_start_dt) + 1 as period_days
    from islands_adjusted ia
)

-- 8. SANITY-CHECK
,   sanity as (
    select
        count(*) filter (
            where days_in_island <> (island_end_raw - island_start_raw + 1)
        ) as broken_islands_cnt
      , count(*)                                              as total_islands_cnt
      , max(days_in_island - (island_end_raw - island_start_raw + 1)) as max_overcount
    from islands_raw
)

-- 9. Атрибуты сотрудника на дату найма
,   employee_info as (
    select
        p.mdm_employee_rk
      , max(e.ad_login) as ad_login
      , max(e.full_nm)  as full_nm
    from periods p
    join prod_v_emart.mdm_employee_structure_d e
        on e.mdm_employee_rk = p.mdm_employee_rk
       and e.business_dt = p.company_hire_dt
    group by p.mdm_employee_rk
)

-- 10. Итог (only_current = true)
select
    p.mdm_employee_rk
  , ei.ad_login
  , ei.full_nm
  , p.company_hire_dt                       as last_company_hire_dt
  , min(p.period_start_dt)                  as first_attr_start_dt
  , max(p.period_end_dt)                    as last_attr_end_dt
  , count(*)                                as attr_periods_cnt
  , sum(p.period_days)                      as attr_tenure_days
  , round(sum(p.period_days) / 365.25, 2)   as attr_tenure_years
  , round(sum(p.period_days) / 30.44, 2)    as attr_tenure_months
  , (select broken_islands_cnt from sanity) as _qa_broken_islands  -- ДОЛЖНО быть 0
  , (select max_overcount     from sanity)  as _qa_max_overcount   -- ДОЛЖНО быть 0
from periods p
join employee_info ei on ei.mdm_employee_rk = p.mdm_employee_rk
where exists (
    select 1 from prod_v_emart.mdm_employee_structure_d cur
    where cur.mdm_employee_rk     = p.mdm_employee_rk
      and cur.last_day_flg        = 1
      and cur.active_employee_flg = 1
      and cur.company_fire_flg    = 0
      and cur.emp_specialization_desc = 'Бизнес-аналитик BI'
)
group by 1, 2, 3, 4
order by attr_tenure_days desc;
