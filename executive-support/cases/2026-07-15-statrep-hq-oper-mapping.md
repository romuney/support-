---
date: 2026-07-15
type: report
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hp383fijsfj1o6xh5f6genb1
source: channel-import
needs_review: true
tags: [statrep, hq, oper-employees]
---

# Откуда берется маппинг HQ / Oper Employees в StatRep

## Вопрос дословно

> **Отчет:** StatRep (Привлечение и найм)
> **Вопрос:** Откуда берется маппинг HQ / Oper Employees (покраска численности)?

## Ответ

**Источник:** `emart.mdm_employee_structure_d`

**Правило покраски:**
- HQ: `emp_specialization_oper_code = 'Hq'`
- Oper: `emp_specialization_oper_code != 'Hq'` или `emp_specialization_oper_code is null`

## Чего не хватило

Не восстановить из выгрузки.
