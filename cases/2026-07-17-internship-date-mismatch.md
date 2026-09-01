---
date: 2026-07-17
type: report
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hpzd51cssk5asrfwzbph6gq1
source: channel-import
needs_review: true
tags: [hr-executive, internship-date, data-quality]
---

# Некорректные даты прохождения стажировки в HR Executive

## Вопрос дословно

> **Отчет:** HR Executive Detail Employee (dashboard/hr-executive-detail-employee/)
> **Проблема:** В отчёт льются данные с некорректными датами прохождения/окончания стажировки (данные из 1С). Пример: у сотрудника дата окончания стажировки в отчёте — 27.08.26, фактическая — 07.08.26. Риски: 1) автоматическая конвертация СТД в бессрочный; 2) увольнение сотрудников, которых планировали оставить.

## Ответ

**Источник данных:** `prod_v_dds.employee_main`.

**Решение:**
1. Заведена задача [DWCOO-165](https://tracker.t-tech.team/task/DWCOO-165/)
2. Обновить отчет с корректными датами из emart.mdm_employee_structure_d напрямую

**Важно:** часть стажеров может пропадать из-за фильтров в выгрузке.

## Чего не хватило

Не восстановить из выгрузки.
