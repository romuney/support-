---
id: t-calendar-event-x-meeting-room
type: table
title: Связь события и переговорки
owner: Владелец витрины
status: active
updated: 2026-09-01
aliases: [calendar_event_x_meeting_room, связь события и переговорки, переговорка события, переговорка встречи]
---

# prod_v_sse_crossdata.calendar_event_x_meeting_room

## Что описывает
Мост между событием Outlook и переговоркой. Делает `unnest` массива
`meeting_room_email_address_txt_list` из `t-calendar-event`, поэтому джойнить
переговорку напрямую с событием не нужно.

## Гранулярность строки
Одна строка = пара «событие × email переговорки». У события может быть
несколько переговорок (элементы массива).

## Первичный ключ
`calendar_event_rk` + `meeting_room_email_address_txt`.

## Ключи для связывания
| С чем | По каким полям |
|---|---|
| `t-calendar-event` | `calendar_event_rk` |
| `t-meeting-room` | `meeting_room_email_address_txt` = `primary_email_address_txt` (или `secondary_email_address_txt`) |

## Основные поля
| поле | смысл | тип среза |
|---|---|---|
| `calendar_event_rk` | ключ события Outlook | идентификатор |
| `meeting_room_email_address_txt` | email переговорки | идентификатор |

## Срез атрибутов
Факт связи события и переговорки.

## Период и глубина истории
По глубине события Outlook.

## Как обновляется
Ежедневно процессом SSETL.

## Категорически нельзя
- Думать, что `meeting_room_email_address_txt` — это `calendar_event_rk`: это
  email переговорки, а не ключ события.
- Джойнить `t-calendar-event.meeting_room_email_address_txt_list` напрямую
  без этого моста (массив требует `unnest`).

## Персональные данные
—

## Связанные сущности
`t-calendar-event`, `t-meeting-room`