---
id: m-fte-product
type: metric
title: FTE по продукту
owner: HR-методология
status: active
updated: 2026-08-05
aliases: [FTE, аллокация, full-time equivalent, ставки, загрузка на продукт, allocation]
---

# FTE по продукту

## Определение одной фразой

Сумма долей аллокации сотрудников на продукт — сколько «полных ставок»
работает на продукте.

## Формула

```sql
sum(allocation_prt)
```

**Не** `count(*)` и **не** `count(distinct mdm_employee_rk)`: сотрудник может
быть распределён на несколько продуктов частями.

## Что в числителе и знаменателе

Метрика абсолютная. Рядом с FTE обычно нужна и численность — это разные цифры:

```sql
select
    fr.lvl3_functional_unit_nm as product_nm  -- продукт, ур. 3
    , count(distinct fr.mdm_employee_rk) as hc_headcount  -- уникальные сотрудники
    , sum(fr.allocation_prt) as fte_total  -- FTE всего
from prod_v_emart.functional_role_d fr
where fr.last_day_flg = 1
  and fr.lvl3_functional_unit_nm is not null
group by 1
order by fte_total desc;
```

## Гранулярность и период

`prod_v_emart.functional_role_d` — одна строка на роль сотрудника, у одного
сотрудника **N строк**. Продуктовая структура: `lvl{N}_functional_unit_nm/_rk`,
N = 1..12.

## Где считается

`prod_v_emart.functional_role_d`. Джойн с `t-emp-structure` —
по `mdm_employee_rk` + `business_dt`.

Отдельной статьи по этой витрине пока нет — при работе с ней обязателен
`get_table_info`.

## Руководители в продуктовой структуре

`business_head_flg`, `technical_head_flg`, `service_head_flg`, общий `head_flg = 1`.
Если заказчик сказал «руководитель» без уточнения — задать один уточняющий вопрос,
какой именно: в оргструктуре это `management_head_flg` / `legal_head_flg`,
в продукте — три разных флага.

## Чем НЕ является

Не численность на продукте. FTE 3.5 может означать семь человек по половине
ставки. При запросе «сколько людей на продукте» нужна не эта метрика.

## Частые расхождения

**FTE не сходится с численностью.** Так и должно быть — если сходится,
скорее всего посчитали `count(*)` вместо `sum(allocation_prt)`.

**Сумма по сотруднику больше 1.** Возможная ошибка данных аллокации —
это вопрос к владельцу витрины.

## Связанные сущности

`t-emp-structure`, `m-active-headcount`
