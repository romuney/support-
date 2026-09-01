---
id: t-meeting-room
type: table
title: Переговорки Outlook
owner: Владелец витрины
status: active
updated: 2026-09-01
aliases: [meeting_room, переговорки, переговорка, адрес переговорки, почта переговорки, название переговорки]
---

# prod_v_sse_crossdata.meeting_room

## Что описывает
Адреса почт переговорок Outlook. По email переговорки находится её название
(`meeting_room_nm`).

## Гранулярность строки
Одна строка = одна переговорка.

## Первичный ключ
Явного rk-ключа нет — переговорка идентифицируется по email
(`primary_email_address_txt` / `secondary_email_address_txt`).

## Ключи для связывания
| С чем | По каким полям |
|---|---|
| `t-calendar-event` | через `t-calendar-event-x-meeting-room` по email |

Джойн с событием идёт по email переговорки (`meeting_room_email_address_txt`
в мосте = `primary_email_address_txt` или `secondary_email_address_txt`),
а не напрямую и не по названию.

## Основные поля
| поле | смысл | тип среза |
|---|---|---|
| `meeting_room_nm` | название переговорки | атрибут |
| `primary_email_address_txt` | основная почта переговорки | идентификатор |
| `secondary_email_address_txt` | вспомогательная почта переговорки | атрибут |

## Срез атрибутов
Актуальный каталог переговорок, не версионный.

## Период и глубина истории
Текущее состояние переговорок.

## Как обновляется
Ежедневно процессом SSETL.

## Категорически нельзя
- Джойнить по названию `meeting_room_nm` — переговорка связывается по email.
- Искать переговорку только по `primary_email_address_txt`: почта может быть
  во `secondary_email_address_txt`.

## Персональные данные
Переговорки — не персональные данные. Их связь с событиями сотрудников — через
`t-calendar-event-x-mdm-employee`.

## Связанные сущности
`t-calendar-event`, `t-calendar-event-x-meeting-room`