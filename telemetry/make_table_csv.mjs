// Генерирует support_event.csv для создания таблицы Data Tables импортом CSV.
//
// Строки берутся из НАСТОЯЩЕГО узла Normalize, а не пишутся руками: колонки
// CSV тогда совпадают с тем, что флоу реально записывает, по построению.
// Схему правят в build_telemetry_flows.py → пересобрать → прогнать этот скрипт.
//
// ЗАЧЕМ ВООБЩЕ СТРОКИ. n8n определяет тип колонки, сэмплируя данные, а тип
// потом неизменяем. CSV из одного заголовка дал бы `string` во всех колонках,
// включая event_ts и ingested_at, — и сравнения по времени в витрине пришлось
// бы делать над строками. Поэтому в CSV идут примеры, и в них у числовых
// колонок стоят числа.
//
// ЭТИ СТРОКИ ПОПАДУТ В ТАБЛИЦУ. Импорт CSV создаёт таблицу и заливает данные
// одним действием — примеры станут настоящими строками лога. У всех event_id
// префикс `sample:`, event_type = `schema_sample`, thread_id = `sample-thread`:
// найти и удалить их в UI после импорта. Пересчёт витрины их всё равно
// отбросит (нет request_created с реальным thread_id), но оставлять мусор
// в логе незачем.
//
// Запуск: node make_table_csv.mjs
import fs from 'fs';

const OUT = 'support_event.csv';

const wf = JSON.parse(fs.readFileSync('Telemetry Ingest.json', 'utf8'));
const norm = wf.nodes.find((n) => n.name === 'Normalize');
if (!norm) throw new Error('нет ноды Normalize — сначала python3 build_telemetry_flows.py');
const run = (input) => new Function('$json', norm.parameters.jsCode)(input).map((x) => x.json);

// Схема из сборщика: порядок колонок в CSV повторяет её, а расхождение
// в НАБОРЕ колонок ловится проверкой ниже.
const BUILDER = fs.readFileSync('build_telemetry_flows.py', 'utf8');
const SCHEMA = [...BUILDER.matchAll(/^\s{4}\("([a-z_]+)",\s*"(string|number|boolean|date)"/gm)]
  .map((m) => ({ name: m[1], type: m[2] }));
if (SCHEMA.length < 8) throw new Error('не разобралась схема SCHEMA из сборщика');

const TS = 1754640000000;   // 2026-08-08, фиксированное: диффы должны быть пустыми

// Три события, покрывающие все колонки непустыми значениями. Пустая строка
// в сэмпле — это риск: колонку с пустыми значениями n8n может определить
// не так, как нужно, а тип потом не меняется.
const EVENTS = [
  // Обращение: даёт kind и осмысленный payload.
  { event: 'posted', post: {
    id: 'sample0000000000000000001', root_id: '', channel_id: 'sample-channel',
    user_id: 'sample-user', create_at: TS, type: '', props: {},
    message: 'Cross Data | Выгрузка данных\nпример обращения для определения типов',
  } },
  // Реакция дежурного: даёт actor, source=reaction и вложенный payload.
  { event: 'reaction_added',
    data: { reaction: { post_id: 'sample0000000000000000001', user_id: 'sample-duty',
                        emoji_name: 'loading', create_at: TS + 60000 } },
    post: { id: 'sample0000000000000000001', root_id: '', channel_id: 'sample-channel' } },
  // Ответ бота: единственное событие с непустым domains.
  { event: 'bot_answered', thread_id: 'sample-thread', event_ts: TS + 120000,
    actor: 'core', source: 'core',
    payload: { domains: ['movement', 'headcount'], confidence_key: 'high' } },
];

const rows = EVENTS.flatMap(run).map((r) => ({
  ...r,
  // Пометки, по которым эти строки находят и удаляют после импорта.
  event_id: 'sample:' + r.event_id,
  event_type: 'schema_sample',
  thread_id: 'sample-thread',
  ingested_at: TS,          // Date.now() иначе менял бы файл на каждом прогоне
}));

// Набор колонок в выходе нормализатора обязан совпадать со схемой: иначе
// импорт создаст таблицу, которой флоу не соответствует, а тип потом
// не поменять.
const got = Object.keys(rows[0]).sort().join(',');
const want = SCHEMA.map((c) => c.name).sort().join(',');
if (got !== want) {
  console.error('РАСХОЖДЕНИЕ колонок нормализатора и схемы:');
  console.error('  нормализатор:', got);
  console.error('  схема:       ', want);
  process.exit(1);
}

// Кавычки по RFC 4180: payload — это JSON с запятыми и двойными кавычками
// внутри, без экранирования импорт разложил бы его по лишним колонкам.
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const header = SCHEMA.map((c) => c.name);
const lines = [header.join(',')];
for (const r of rows) lines.push(header.map((h) => esc(r[h])).join(','));

// БЕЗ BOM. С ним первая колонка читается как `﻿event_id`: имя колонки
// в Data Tables обязано совпадать с `^[a-zA-Z][a-zA-Z0-9_]*$`, и невидимый
// префикс либо уронит импорт, либо создаст колонку с другим именем — а upsert
// в Ingest ищет ровно `event_id`. Ключ идемпотентности молча перестал бы
// совпадать, и каждое событие писалось бы новой строкой.
// Удобство Excel этого не стоит; \r\n оставлен, его BOM не требует.
fs.writeFileSync(OUT, lines.join('\r\n') + '\r\n', 'utf8');

console.log(`записан ${OUT} — ${rows.length} строк, ${header.length} колонок\n`);
for (const c of SCHEMA) {
  const v = String(rows[0][c.name] ?? '');
  const looksNum = v !== '' && !Number.isNaN(Number(v));
  const warn = c.type === 'string' && looksNum ? '  ← ВНИМАНИЕ: похоже на число' : '';
  console.log(`  ${c.name.padEnd(13)} ${c.type.padEnd(8)} ${v.slice(0, 40)}${warn}`);
}
console.log('\nПри импорте ПРОВЕРИТЬ типы, которые предложит n8n:');
for (const c of SCHEMA) console.log(`  ${c.name.padEnd(13)} → ${c.type}`);
console.log('\nТип колонки после создания НЕ МЕНЯЕТСЯ — ошибку придётся');
console.log('исправлять пересозданием таблицы.');
console.log('\nПосле импорта удалить строки схемы: event_type = schema_sample');
console.log('(3 строки, префикс event_id — "sample:").');
