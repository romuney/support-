---
id: m-hiring
type: metric
title: Найм
owner: HR-методология
status: active
updated: 2026-08-05
aliases: [найм, hiring, hiring rate, приёмы, сколько наняли, набор]
---

# Найм

## Определение одной фразой

Количество событий входа сотрудника в периметр численности за период.

## Формула

Зависит от типа численности — это не одна метрика, а две.

| Тип | Что включает | Формула |
|---|---|---|
| Юридическая | найм в компанию | `sum(company_hire_flg)` |
| **Активная (по умолчанию)** | найм + переводы в боевую группу + переводы стажёров в штат | `sum(company_hire_flg)` + `sum(candidate_transfer_flg)` + `sum(internal_transfer_flg)` |

Если заказчик не назвал тип численности — считается **активная**.

## Как складывать флаги

Каждый флаг суммируется **со своим `FILTER`**. Иначе сотрудник, у которого
в один день стоят два флага, посчитается дважды.

```sql
-- ✅ ПРАВИЛЬНО: каждый флаг со своим FILTER
sum(m.company_hire_flg) filter (where m.active_employee_flg = 1) as hire_count  -- найм
sum(m.candidate_transfer_flg) filter (where m.company_hire_flg = 0) as battle_transfer_count  -- в БГ
sum(m.internal_transfer_flg) filter (where m.company_hire_flg = 0) as intern_staff_count  -- в штат

-- ❌ НЕПРАВИЛЬНО: двойной счёт
sum(m.company_hire_flg + m.candidate_transfer_flg + m.internal_transfer_flg)
```

## Гранулярность и период

Событие × день. Фильтр периода — **только по `business_dt`**, не по
`company_hire_dt`.

```sql
where business_dt >= date '2026-01-01'
```

`last_day_flg` при расчёте за период не применяется.

## Где считается

`t-emp-structure`. Помесячно, активная численность:

```sql
select
    date_trunc('month', m.business_dt)::date as business_dt  -- месяц
    , sum(m.company_hire_flg) filter (where m.active_employee_flg = 1) as hire_count  -- найм
    , sum(m.candidate_transfer_flg) filter (where m.company_hire_flg = 0) as battle_transfer_count  -- в БГ
    , sum(m.internal_transfer_flg) filter (where m.company_hire_flg = 0) as intern_staff_count  -- в штат
    , sum(m.company_hire_flg) filter (where m.active_employee_flg = 1)
        + sum(m.candidate_transfer_flg) filter (where m.company_hire_flg = 0)
        + sum(m.internal_transfer_flg) filter (where m.company_hire_flg = 0) as active_hire_cnt  -- итого
from prod_v_emart.mdm_employee_structure_d m
where m.active_employee_flg = 1  -- активная
group by 1
order by 1;
```

## Разрезы

`lvl{N}_mapped_management_unit_nm` (упр. структура), `lvl{N}_legal_unit_nm`
(юр. структура), `emp_specialization_oper_code` (HQ/Oper),
`emp_specialization_it_code` (IT/Digital), `emp_stream_desc` (стрим),
`emp_specialization_desc` (специализация).

## Чем НЕ является

Не «количество нанятых людей за период»: переводы стажёра в штат — событие
входа в активную численность, но не новый человек в компании. При вопросе
про людей нужно уточнить, что считать.

## Частые расхождения

**Найм по активной численности больше, чем по юридической.** Так и должно быть:
в активную входят переводы, в юридическую — нет.

**Найм за январь занижен.** Проверить, не стоит ли фильтр по `company_hire_dt`
вместо `business_dt`, и не добавлен ли `last_day_flg = 1`.

**Сумма компонент не равна итогу.** Значит флаги сложены без `FILTER`.

## Связанные сущности

`t-emp-structure`, `m-active-headcount`, `m-legal-headcount`, `m-turnover`
