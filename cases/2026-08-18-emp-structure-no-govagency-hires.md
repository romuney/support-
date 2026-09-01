---
date: 2026-08-18
type: question
asker: уточнить
status: closed
link: https://time.tbank.ru/tinkoff/pl/18i3adde6szgzggw7juqd1z5ai
external_id: 18i3adde6szgzggw7juqd1z5ai
source: channel-import
needs_review: true
tags: [movement, t-emp-structure, data-gap]
---

# Нет признака приёма из гос. органов в mdm_employee_structure_d

## Вопрос дословно

> Обращение по теме «Другое», домен движения (`movement`).

## Что сделал

Разобрал фидбек к черновику ответа бота по витрине `mdm_employee_structure_d`.

## Ответ

Черновик не предупредил об отсутствии признака источника приёма.

## Чего не хватило

> В таблице emart.mdm_employee_structure_d нет данных о сотрудниках, которые
> были приняты из гос органов.

Витрина не выделяет переходы из государственных структур: такие приёмы видны
в `company_hire_flg` как обычный найм, без источника. Перенесено в
`kb/tables/mdm-employee-structure-d.md`, раздел «Известные пробелы данных».

## Время

Потрачено: не восстановить из выгрузки.
