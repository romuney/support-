---
id: t-employee-profession
type: table
title: Профессии сотрудников
owner: Владелец витрины
status: active
updated: 2026-08-14
aliases: [employee_profession, профессия, профессии, классификатор профессий]
---

# prod_v_dds_dic.employee_profession

## Что описывает

Справочник профессий: код и человекочитаемое название профессии
(`employee_profession_nm`). Сам по себе не про сотрудника — это классификатор,
на который сотрудник ссылается через специализацию.

## Гранулярность строки

Одна строка = одна версия одной профессии. Справочник версионируется по SCD2:
у одной профессии со временем может быть несколько строк с разными
`valid_from_dttm`/`valid_to_dttm`.

## Первичный ключ

`employee_profession_dk` + `valid_to_dttm`.

## Ключи для связывания

Сотрудник **не** ссылается на профессию напрямую — только через специализацию.
Мост — `dds_dic.employee_specialization`, отдельно в реестре не зарегистрирована
(её собственные атрибуты не нужны: специализация сотрудника уже есть на
`t-emp-structure` полем `emp_specialization_desc`, из моста берётся только ключ
профессии).

```sql
select m.mdm_employee_rk
     , m.emp_specialization_desc
     , pf.employee_profession_nm
from prod_v_emart.mdm_employee_structure_d m
left join prod_v_dds_dic.employee_specialization sp
  on m.emp_specialization_dk = sp.employee_specialization_dk
 and sp.valid_to_dttm = '5999-01-01'
 and sp.deleted_flg = 0
left join prod_v_dds_dic.employee_profession pf
  on pf.employee_profession_dk = sp.employee_profession_dk
 and pf.valid_to_dttm = '5999-01-01'
 and pf.deleted_flg = 0
where m.last_day_flg = 1
```

| С чем | По каким полям |
|---|---|
| `dds_dic.employee_specialization` (мост) | `t-emp-structure.emp_specialization_dk = employee_specialization_dk` |
| `dds_dic.employee_profession` | `employee_specialization.employee_profession_dk = employee_profession_dk` |

## Срез атрибутов

Текущее состояние классификатора, не история на дату события. И у моста,
и у самого справочника обязателен фильтр актуальной версии:
`valid_to_dttm = '5999-01-01' and deleted_flg = 0`.

## Период и глубина истории

Не применимо — это справочник, а не история событий сотрудника. Прошлые
версии профессии (переименование, реорганизация классификатора) хранятся
в тех же таблицах с закрытым `valid_to_dttm`, но для обычных задач не нужны.

## Как обновляется

Не заполнено — уточнить у владельца витрины.

## Категорически нельзя

1. **Джойнить `t-emp-structure` на `employee_profession` напрямую** — прямого
   ключа нет, обязателен мост через `employee_specialization`.
2. **Забыть фильтр актуальной версии** на мосту или на справочнике —
   без `valid_to_dttm = '5999-01-01' and deleted_flg = 0` строка сотрудника
   размножится на все исторические версии профессии/специализации.

## Персональные данные

Нет — это классификатор профессий, не данные о конкретных людях.

## Связанные сущности

`t-emp-structure`
