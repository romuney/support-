---
id: rc-find-unit-level
type: recipe
title: Поиск уровня и ключа подразделения
owner: Владелец витрины
status: active
updated: 2026-08-05
aliases: [найти подразделение, уровень подразделения, двухшаговый поиск, mapped_management_unit_rk, какой lvl]
---

# Поиск уровня и ключа подразделения — двухшаговый алгоритм

## Какую задачу решает

Заказчик называет подразделение словами. Чтобы выгрузить его сотрудников, нужны
две вещи: на каком уровне иерархии оно находится и какой у него ключ. Угадывать
уровень нельзя — поля разные для каждого N.

## Какие таблицы участвуют

`t-emp-structure` — здесь ищется уровень. Поля `management_unit_lvl_num`
и `legal_unit_lvl_num` есть **только в ней**.

`t-legal-position` — сюда идём на шаге 2, если структура юридическая.

## Порядок связывания

### Управленческая структура

**Шаг 1. Найти уровень и ключ:**

```sql
select distinct
    mapped_management_unit_nm           -- mapped название подразделения
    , mapped_management_unit_rk         -- ключ для шага 2
    , management_unit_lvl_num           -- уровень N (3..13)
    , count(*) as emp_cnt               -- численность для проверки
from prod_v_emart.mdm_employee_structure_d
where last_day_flg = 1
  and active_employee_flg = 1
  and company_fire_flg = 0
  and mapped_management_unit_nm ilike '%<название>%'  -- поиск по названию
group by mapped_management_unit_nm, mapped_management_unit_rk, management_unit_lvl_num
order by management_unit_lvl_num;
```

**Шаг 2. Выгрузить сотрудников по ключу нужного уровня.** Если на шаге 1
`management_unit_lvl_num = 5`, берётся поле `lvl5_mapped_management_unit_rk`:

```sql
select
    e.mdm_employee_rk                   -- ключ сотрудника
    , e.emp_specialization_desc         -- специализация
    , e.management_position_nm          -- должность
    , e.lvl5_mapped_management_unit_nm  -- подразделение уровень 5
from prod_v_emart.mdm_employee_structure_d e
where last_day_flg = 1                  -- актуальная дата
  and active_employee_flg = 1           -- активный
  and company_fire_flg = 0              -- не уволен
  and lvl5_mapped_management_unit_rk = '<ключ из шага 1>';  -- "<название подразделения>"
```

Название подразделения из шага 1 указывается в комментарии к фильтру — иначе
через месяц по хешу ключа никто не поймёт, что выгружалось.

### Юридическая структура

Шаг 1 — тот же принцип, но по полям `legal_unit_nm`, `legal_unit_rk`,
`legal_unit_lvl_num`, уровни 1..10. Шаг 2 выполняется в `t-legal-position`
по `lvl{N}_legal_unit_rk`, обычно с `main_legal_position_flg = 1`.

## Чего избегать

1. **Угадывать уровень.** Одинаковое по смыслу подразделение у разных команд
   может лежать на разных уровнях.
2. **Фильтровать по `*_nm` вместо `*_rk`** на шаге 2. Названия дублируются
   и меняются.
3. **Пропускать `count(*)` на шаге 1.** Численность сразу показывает, то ли
   подразделение найдено: если по «Executive» вернулось 3 человека вместо 300,
   найден не тот уровень.
4. **Брать `lvl1`/`lvl2`** управленческой структуры — они игнорируются.

## Как проверить результат

Численность из шага 2 должна совпасть с `emp_cnt` из шага 1 для выбранного
уровня. Расходится — взят не тот `lvl{N}` или потерян фильтр активности.

## Связанные метрики

`rc-structure-choice`, `m-active-headcount`, `m-legal-headcount`
