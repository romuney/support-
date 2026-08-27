---
id: t-crm-user
type: table
title: Пользователи TWork
owner: Владелец витрины
status: active
updated: 2026-08-25
aliases: [crm_user, пользователи TWork, TWork, twork id, twork_id]
---

# dds.crm_user

## Что описывает

Витрина содержит пользователей CRM из TWork — систему, в которой у сотрудника
есть отдельный идентификатор (`crm_user_id`, он же «twork id»), не совпадающий
с `mdm_employee_rk`. Используется, когда нужно получить twork id сотрудника
или наоборот — определить сотрудника по twork id.

## Гранулярность строки

Одна строка = одна версия пользователя TWork на период действия
(`valid_from_dttm` – `valid_to_dttm`). SCD2: смена атрибутов пользователя
TWork закрывает старую строку и открывает новую.

## Первичный ключ

Логический ключ: `mdm_employee_rk` + `valid_from_dttm`.

## Ключи для связывания

| С чем | По каким полям |
|---|---|
| `t-emp-structure` | `mdm_employee_rk` + `business_dt BETWEEN valid_from_dttm AND valid_to_dttm` |

## Поля

| Поле | Тип | Описание |
|---|---|---|
| `mdm_employee_rk` | key | Суррогатный ключ сотрудника, для джойна с `t-emp-structure` |
| `crm_user_id` | key | Идентификатор пользователя в TWork — это и есть «twork id» |
| `valid_from_dttm` | timestamp | Начало периода действия записи |
| `valid_to_dttm` | timestamp | Окончание периода действия записи |
| `active_flg` | flag | Признак активной записи |
| `deleted_flg` | flag | Признак удалённой записи |

## Как фильтровать

Обязательный джойн с `t-emp-structure`:

```sql
ON crm.mdm_employee_rk = es.mdm_employee_rk
AND es.business_dt BETWEEN crm.valid_from_dttm AND crm.valid_to_dttm  -- срез на дату
AND crm.active_flg = 1   -- только активные записи
AND crm.deleted_flg = 0  -- не удалённые
```

### Категорически нельзя

1. **Джойнить только по `mdm_employee_rk`** без условия на период — при SCD2
   это задвоение строк `t-emp-structure` на количество версий пользователя TWork.
2. **Опускать `active_flg = 1` или `deleted_flg = 0`** — в выборку попадут
   неактивные или удалённые записи пользователя TWork.

## Период и глубина истории

Границы уточняются запросом `select min(valid_from_dttm), max(valid_to_dttm)`.

## Как обновляется

Не подтверждено живым запросом. Уточнить у владельца витрины при следующем обращении.

## Персональные данные

`crm_user_id` — идентификатор в CRM-системе TWork, связан с конкретным
сотрудником через `mdm_employee_rk`. Обращаться как с прочими связками
сотрудник-внешняя система, см. `kb/process/routing.md`.

## Связанные сущности

`t-emp-structure`
