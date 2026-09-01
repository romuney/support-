---
date: 2026-07-31
type: question
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hujsz4djreo48yatia7sc4rn
source: channel-import
needs_review: true
tags: [office, attendance, dwh]
---

# Где найти данные по посещаемости офисов в DWH

## Вопрос дословно

> Есть ли в DWH таблицы со статистикой кол-ва сотрудников, посетивших конкретный офис (агрегат на дату)?

## Ответ

Отдельной таблицы со статистикой посещаемости офисов в DWH нет.

**Где смотреть:**
1. Отчет «[Подневная детализация трафика](https://proteus.tcsbank.ru/superset/dashboard/Office_traffic_daily_detail/)»
2. Отчет «[Посещаемость и бронирование](https://proteus.tcsbank.ru/superset/dashboard/Office_attendance_and_booking/)»
3. Витрина `prod_v_hrmart.mdm_employee_office_utilization`

## Чего не хватило

Не восстановить из выгрузки.
