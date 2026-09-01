---
id: t-calendar-event-x-ktalk-room
type: table
title: Связь события и комнаты ktalk
owner: Владелец витрины
status: active
updated: 2026-09-01
aliases: [calendar_event_x_ktalk_room, связь события и ktalk, ktalk комната события]
---

# prod_v_sse_crossdata.calendar_event_x_ktalk_room

## Что описывает
Мост между событием Outlook и комнатой ktalk (видеоконференция).

## Гранулярность строки
Одна строка = пара «событие × комната ktalk».

## Первичный ключ
`calendar_event_rk` + `ktalk_room_id`.

## Ключи для связывания
| С чем | По каким полям |
|---|---|
| `t-calendar-event` | `calendar_event_rk` |

## Основные поля
| поле | смысл | тип среза |
|---|---|---|
| `calendar_event_rk` | ключ события Outlook | идентификатор |
| `ktalk_room_id` | ключ комнаты ktalk | идентификатор |

## Срез атрибутов
Факт связи события и комнаты ktalk.

## Период и глубина истории
По глубине события Outlook.

## Как обновляется
Ежедневно процессом SSETL.

## Категорически нельзя
—

## Персональные данные
—

## Связанные сущности
`t-calendar-event`