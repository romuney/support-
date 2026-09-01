# Поддержка HR-аналитики

База знаний и бот поддержки HR-аналитики: канал в Teams, куда приходит больше
десяти обращений в день, отвечает джун, а типовые ответы постепенно забирает
на себя агент в n8n.

## Структура

| Папка | Что внутри |
|---|---|
| [`executive-support/`](executive-support/) | База знаний: реестр `kb/index.md`, статьи по метрикам, отчётам, витринам и рецептам, кейсы, выгрузки, валидатор |
| [`bot/`](bot/) | Воркфлоу n8n и промпты бота: ядро, адаптеры каналов, DD Lookup |
| [`telemetry/`](telemetry/) | Сбор оценок, калибровка уверенности, витрина обращений |
| [`иконки/`](иконки/) | Эмодзи-пак и GIF бота |
| [`context/`](context/) | Разборы прогонов, выгрузки канала, handoff'ы. Сырьё, не источник правды |

С чего начать: [`RUNBOOK.md`](RUNBOOK.md) — как устроены бот, телеметрия и git-флоу,
[`executive-support/CLAUDE.md`](executive-support/CLAUDE.md) — правила базы знаний,
[`executive-support/docs/how-we-work.html`](executive-support/docs/how-we-work.html) —
онбординг для джуна.

## Проверки перед коммитом

```bash
cd executive-support && python3 validate_kb.py
cd bot       && node test_pipeline.mjs && node test_adapters.mjs && node test_shapers.mjs && node test_recon.mjs
cd telemetry && node test_telemetry.mjs
```

Персональные данные в репозиторий не попадают — только суррогатные ключи и роли.
