---
date: 2026-07-29
type: report
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18ht9o7hobumb34kx9bco1eiua
source: channel-import
needs_review: true
tags: [vacancy, resource-structure, report]
---

# На каком источнике строится график по изменению ресурсной структуры вакансии

## Вопрос дословно

> **Отчет:** dashboard/p/Pa5GOW045LZ/
> На каком источнике строится график по изменению ресурсной структуры вакансии?

## Ответ

Алгоритм сравнивает:
- `management_position_id` из `prod_v_emart.management_position_d`
- `current_management_position_id` из `prod_v_sse_crossdata.vacancy_regular_hiring_d`

**Важно:** расчет может измениться при переработке источников.

## Чего не хватило

Не восстановить из выгрузки.
