---
id: m-legal-headcount
type: metric
title: Юридическая численность
owner: HR-методология
status: active
updated: 2026-08-05
aliases: [юридическая численность, юрчисленность, оформленные, трудоустроенные, списочная численность]
---

# Юридическая численность

## Определение одной фразой

Количество сотрудников, оформленных в юрлицах компании на дату, —
**основная численность для расчётов**.

## Формула

```sql
legal_employee_flg = 1 and company_fire_flg = 0
```

## Что в числителе и знаменателе

Метрика абсолютная. Считать нужно людей, а не записи:
`count(distinct mdm_employee_rk)`, если источник — `t-legal-position`,
где у сотрудника бывает несколько оформлений.

## Гранулярность и период

На дату. Для динамики по месяцам берётся последний день месяца:

```sql
select
    m.business_dt  -- отчётная дата
    , count(m.mdm_employee_rk) as legal_headcount  -- численность
from prod_v_emart.mdm_employee_structure_d m
where m.legal_employee_flg = 1  -- юридическая
  and m.company_fire_flg = 0  -- не уволен
  and (m.last_day_of_month_flg = 1 or m.last_day_flg = 1)  -- посл. день месяца
group by 1
order by 1;
```

Условие `last_day_of_month_flg = 1 or last_day_flg = 1` даёт закрытые месяцы плюс
текущую незакрытую дату.

## Где считается

Численность по компании — `t-emp-structure` через `legal_employee_flg`.
Численность по юридической структуре подразделений — `t-legal-position`.
Выбор источника: `rc-structure-choice`.

## Чем НЕ является

Не активная численность (`m-active-headcount`) — другой флаг и другой смысл.
Расхождение между ними нормально и объясняется определением, а не ошибкой данных.

## Частые расхождения

**Численность больше, чем людей.** В `t-legal-position` у сотрудника несколько
оформлений: основное плюс совместительство или ГПХ. `count(*)` вернёт договоры.
Нужно `count(distinct mdm_employee_rk)`, а для основных позиций —
фильтр `main_legal_position_flg = 1`.

**Месячная динамика «рваная».** Если взять просто `business_dt` без
`last_day_of_month_flg`, в месяц попадёт много дат.

## Связанные сущности

`t-emp-structure`, `t-legal-position`, `m-active-headcount`, `rc-structure-choice`
