---
id: r-gitlab-activity
type: report
title: Активность в GitLab
owner: Владелец отчёта
status: active
updated: 2026-09-01
aliases: [активность в gitlab, gitlab активность, активность в git, метрики gitlab, активность разработчиков в gitlab]
links: [https://proteus.tcsbank.ru/superset/dashboard/p/grp7GLNyp7V/]
---

# Активность в GitLab

## Назначение
Отчёт содержит метрики активности в GitLab по сотрудникам.

## Где открыть
Proteus → https://proteus.tcsbank.ru/superset/dashboard/p/grp7GLNyp7V/
(Data Detective → Каталог → Активность в GitLab, отчёт `aktivnost-v-gitlab`).

## Какие метрики внутри
—

## На каких данных построен
`sse_crossdata.mdm_employee_gitlab_metric_d` — витрина метрик активности
сотрудников в GitLab (мастер-система GitLab).

## Срез и период обновления
Обновление ежедневно. Статус отчёта в DD — «Активен».

## Ограничения
Метрики активности в инструменте разработки; отражают активность в GitLab,
а не общую продуктивность сотрудника.

## Кому доступен
RLS для сокрытия чувствительных данных. Владелец отчёта — онлайн из Data Detective
(объект `aktivnost-v-gitlab`); канал поддержки — `~hr-report-ask`.