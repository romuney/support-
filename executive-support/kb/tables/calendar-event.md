---
id: t-calendar-event
type: table
title: События календаря Outlook
owner: Владелец витрины
status: active
updated: 2026-09-01
aliases: [calendar_event, события календаря, события outlook, события в календаре, встречи, собрания]
---

# prod_v_sse_crossdata.calendar_event

## Что описывает
События в календаре Outlook: название, время начала/окончания, email организатора,
флаги регулярности, отмены, приглашённых. Потенциальные адреса переговорок — в
массиве `meeting_room_email_address_txt_list`.

## Гранулярность строки
Одна строка = одно событие Outlook.

## Первичный ключ
`calendar_event_rk`. Ряд регулярных событий объединяет `calendar_regular_event_rk`.

## Ключи для связывания
| С чем | По каким полям |
|---|---|
| `t-calendar-event-x-meeting-room` | `calendar_event_rk` |
| `t-calendar-event-x-mdm-employee` | `calendar_event_rk` |
| `t-calendar-event-x-ktalk-room` | `calendar_event_rk` |
| `t-emp-structure` | через `t-calendar-event-x-mdm-employee` → `mdm_employee_rk` |

**Джойн с переговоркой — НЕ напрямую.** `meeting_room_email_address_txt_list` —
массив (`text[]`), и связь с `t-meeting-room` идёт через мост
`t-calendar-event-x-meeting-room` (там уже сделан `unnest`).

## Основные поля
| поле | смысл | тип среза |
|---|---|---|
| `calendar_event_rk` | ключ события Outlook | идентификатор |
| `calendar_regular_event_rk` | ключ ряда регулярных событий | идентификатор |
| `event_nm` | название события | атрибут |
| `start_dttm` / `end_dttm` | время начала/окончания | на дату |
| `organizer_email_address_txt` | email организатора | атрибут |
| `meeting_room_email_address_txt_list` | массив потенциальных email переговорок | атрибут (массив) |
| `regular_flg` | регулярность события | флаг |
| `cancel_flg` | отмена события | флаг |
| `attendee_flg` | приглашённые участники | флаг |

## Срез атрибутов
События — факты по дате проведения (`start_dttm`–`end_dttm`), не версионные.

## Период и глубина истории
История событий Outlook; глубина определяется загрузкой SSETL.

## Как обновляется
Ежедневно процессом SSETL.

## Категорически нельзя
- Джойнить переговорку через `meeting_room_email_address_txt_list` без `unnest` —
  это массив. Использовать мост `t-calendar-event-x-meeting-room`.
- Путать `calendar_event_rk` (событие) и `calendar_regular_event_rk` (ряд).

## Персональные данные
`organizer_email_address_txt` — адрес организатора. Связь события с сотрудником —
через `t-calendar-event-x-mdm-employee`, требует согласования доступа.

## Связанные сущности
`t-meeting-room`, `t-calendar-event-x-meeting-room`, `t-calendar-event-x-mdm-employee`,
`t-calendar-event-x-ktalk-room`, `t-emp-structure`