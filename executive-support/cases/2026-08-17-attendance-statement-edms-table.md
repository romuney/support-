---
date: 2026-08-17
type: export
asker: уточнить
status: closed
link: https://time.tbank.ru/tinkoff/pl/18i1xusj7fy4z36m74sfcr5a7n
external_id: 18i1xusj7fy4z36m74sfcr5a7n
source: channel-import
needs_review: true
tags: [attendance, data-gap, edms]
---

# Данные о заявлении (отпуск/больничный) — в sdp_edms_statement.statement

## Вопрос дословно

> Обращение по теме «Выгрузка данных», домен посещаемости (`attendance`).

## Ответ

> данные о заявление есть в sdp_edms_statement.statement

## Чего не хватило

Реестр `kb/index.md` не знает про таблицу `sdp_edms_statement.statement` —
источник заявлений на отпуск/больничный в системе электронного документооборота
(EDMS). Это отдельная система от `mdm_employee_attendance` (`t-attendance`),
и вопрос про заявление, а не про факт присутствия, в эту таблицу не попадает.

**Статью и строку в реестре не завожу**: `dd_urn` для `sdp_edms_statement`
не подтверждён (в DD не искали), а придумывать URN — то самое «уверенно и
неверно», которое правила репозитория прямо запрещают. Пробел называю
руководителю: нужно найти объект в Data Detective (`POST /search/query`) и
завести строку типа `table` в `kb/index.md`, домен `attendance`, только после
подтверждения URN.

## Время

Потрачено: не восстановить из выгрузки.
