---
date: 2026-08-04
type: report
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hwqw6733z778brojcbb15fge
source: channel-import
needs_review: true
tags: [management, structure, headcount]
---

# Отчет по управленческим уровням и нормам управляемости

## Вопрос дословно

> Нужен отчет по количеству управленческих уровней и нормам управляемости (сколько человек на 1 лида)

## Ответ

Отчет «[Здоровье структуры команд](https://proteus.tcsbank.ru/superset/dashboard/p/Xb3e0nbkpdm/)» содержит метрики:
- норма управляемости IT
- количество вложенных юнитов

Для детализации использовать витрину `usr_cross_data.head_experience_and_scope_of_control`:
- `direct_reporters_cnt` — количество прямых подчинённых
- `subordinate_heads_cnt` — количество подчинённых руководителей
- `team_size_all` — общий размер команды

## Чего не хватило

Не восстановить из выгрузки.
