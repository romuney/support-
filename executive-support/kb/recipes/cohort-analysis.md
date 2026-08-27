---
id: rc-cohort-analysis
type: recipe
title: Когортный анализ и срез атрибутов на дату события
owner: Владелец витрины
status: active
updated: 2026-08-05
aliases: [когорта, когортный анализ, нанятые в 2025, стажёры за период, атрибуты на дату события, потеряли уволенных]
---

# Когортный анализ: атрибуты на дату события

## Какую задачу решает

Считает выборки вида «нанятые в 2025», «стажёры за квартал», «уволенные
в январе» так, чтобы не потерять уволенных сотрудников.

## Главное правило

**При когортном анализе атрибуты берутся на дату события, а не на `last_day_flg = 1`.**

У уволенного сотрудника строки с `last_day_flg = 1` не существует. Джойн
по этому флагу молча выбросит его из выборки или соберёт всех потерянных
в одну строку с `NULL`.

| Тип запроса | Формулировка | Источник атрибутов |
|---|---|---|
| Актуальное состояние | «на сейчас», «текущая численность», «кто работает» | `last_day_flg = 1` |
| Когорта, период | «нанятые в 2025», «стажёры за период», «уволенные в январе» | на дату события |
| Срез на дату | «численность на 31.12.2025» | `business_dt = 'ГГГГ-ММ-ДД'` |
| Динамика | «как менялась численность», «найм по месяцам» | группировка по `business_dt` |

Дата события по типу когорты: найм — `business_dt = company_hire_dt`,
перевод — `business_dt = change_dt`, увольнение — `business_dt = company_fire_dt`.

## Какие таблицы участвуют

`t-emp-structure`.

## Порядок связывания

```sql
with cohort as (
    -- 1. Определяем когорту по событию
    select
        mdm_employee_rk
      , max(company_hire_dt) as last_company_hire_dt
    from prod_v_emart.mdm_employee_structure_d
    group by mdm_employee_rk
    having max(company_hire_dt) between date '2025-01-01' and date '2025-12-31'
)
, employee_attrs as (
    -- 2. Атрибуты НА ДАТУ СОБЫТИЯ, не last_day_flg
    select
        c.mdm_employee_rk
      , c.last_company_hire_dt as company_hire_dt  -- из когорты
      , e.emp_specialization_desc  -- специализация на дату найма
      , e.lvl3_mapped_management_unit_nm  -- подразделение на дату найма
    from cohort c
    join prod_v_emart.mdm_employee_structure_d e
        on e.mdm_employee_rk = c.mdm_employee_rk
       and e.business_dt = c.last_company_hire_dt  -- ключевое условие
)
select * from employee_attrs;
```

Когорта определяется через `max(company_hire_dt)` — «последний найм попал
в окно», а не «когда-либо нанимался в окне».

## Валидация численности на всех этапах

Если анализ идёт в несколько этапов — выгрузка, обогащение, агрегация — численность
сверяется **после каждого**.

1. **Зафиксировать базу.** `count(*)` сразу после определения когорты — это
   контрольное число.
2. **После каждого преобразования** проверить, что `count(distinct mdm_employee_rk)`
   не изменился.
3. **Перед выдачей** сравнить базу с финальным агрегатом.

```sql
select
    count(*) as total_rows
    , count(*) filter (where mdm_employee_rk is null) as null_group_rows
    , count(distinct mdm_employee_rk) as unique_employees
from <результат>;
```

Красные флаги:

| Признак | Что значит |
|---|---|
| `null_group_rows > 0` | потеряны уволенные, атрибуты взяты на `last_day_flg` |
| `total_rows > unique_employees` | дубликаты от джойна |
| финальный агрегат меньше базы | `INNER JOIN` отсёк часть когорты |

## Если сотрудники потерялись

Найти пропавших и объяснить каждую потерю:

```sql
select cb.mdm_employee_rk, cb.emp_specialization_desc
from cohort_base cb
left join final_result fr on fr.mdm_employee_rk = cb.mdm_employee_rk
where fr.mdm_employee_rk is null;
```

Типовые причины: `INNER JOIN` вместо `LEFT JOIN`, фильтр по атрибуту, которого
у части когорты нет, `NULL` в ключевом поле джойна.

В ответе заказчику указывается: сколько потеряно, на каком этапе, почему
и что исправлено. Потеря, о которой не сказано, читается как достоверная цифра.

## Чего избегать

1. **`last_day_flg = 1` для когорты** — теряются уволенные.
2. **`where company_hire_dt between X and Y`** в исходной таблице вместо фильтра
   поверх `max(company_hire_dt)`.
3. **`INNER JOIN` при обогащении.** Сотрудник без наставника, без оценки, без
   записи в справочнике должен остаться в выборке — с `NULL` в этой колонке.
4. **Отдавать результат без сверки численности.**

## Как проверить результат

Численность на входе и в финальном агрегате совпадает. Если нет — расхождение
объяснено в ответе, а не оставлено на усмотрение читателя.

## Связанные метрики

`m-attribute-tenure`, `rc-attribute-tenure`, `m-hiring`, `m-turnover`
