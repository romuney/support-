---
date: 2026-07-21
type: question
asker: уточнить
status: closed
link: https://teams.microsoft.com/l/message/...
external_id: 18hrciawdfyqbhc6njqquxx511
source: channel-import
needs_review: true
tags: [black-account, deduplication, mdm]
---

# Почему при совпадении только ФИО появилась связь между счетами Black

## Вопрос дословно

> **Таблица:** EMART.MDM_EMPLOYEE_X_PERSON_PARTY
> **Проблема:** У сотрудника 1040693 два счета Black (6-100XN2ESU — основной, но транзакции на 5-380KPGU3U). Дедупликация не работает — из общего только ФИО. Почему при совпадении только ФИО появилась связь?

## Ответ

**Правило связи:**
- связь проставилась при сопоставлении ФИО + номера телефона
- при нескольких Black связь (main_flg=1) проставляется party_rk с более поздней датой создания
- у 6-100XN2ESU дата создания позже

## Чего не хватило

Не восстановить из выгрузки.
