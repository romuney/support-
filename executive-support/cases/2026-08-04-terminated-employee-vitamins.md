---
date: 2026-08-04
type: question
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hwhugawbwcf97behbasgcos1
source: channel-import
needs_review: true
tags: [terminated, employee, mdm]
---

# Как посмотреть данные уволившихся сотрудников в mdm_employee_rk

## Вопрос дословно

> **Исследование HCBA-749:** как посмотреть mdm_employee_rk / candidate_id уволившихся? Candy не подходит — сотрудники переоткликаются будучи трудоустроенными

## Ответ

Использовать витрину `prod_v_emart.mdm_employee_structure_d` — она содержит данные уволенных сотрудников.

**Важно:** в витрине есть дубли записей.

## Чего не хватило

Не восстановить из выгрузки.
