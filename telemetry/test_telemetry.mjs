// Прогон Code-ноды Normalize из Telemetry Ingest на подставных событиях Time.
//
// Проверяет то, что ломается тихо: разбор темы обращения, склейку треда для
// реакций (в событии реакции треда нет), правила снятия реакций, отсев
// действий бота, идемпотентность.
//
// Ошибки в этом узле не падают, а искажают витрину: неверный thread_id
// размажет одно обращение на несколько, потерянный emoji_name оставит
// метрики пустыми при размечающем дежурном.
//
// Запуск: node test_telemetry.mjs
import fs from 'fs';

const wf = JSON.parse(fs.readFileSync('Telemetry Ingest.json', 'utf8'));
const js = (n) => {
  const node = wf.nodes.find((x) => x.name === n);
  if (!node) throw new Error(`нет ноды ${n}`);
  return node.parameters.jsCode;
};

// Темы берём из СБОРЩИКА, а не дублируем в тесте: список тем формы будет
// сокращаться, и тест должен ломаться на расхождении, а не переживать его.
const BUILDER = fs.readFileSync('build_telemetry_flows.py', 'utf8');

let fails = 0;
const line = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fails++;
};

// Нормализатор отдаёт ГОТОВУЮ СТРОКУ таблицы: payload сериализован в JSON,
// потому что у Data Tables нет jsonb. Тесты разбирают его обратно — проверять
// смысл события, а не факт сериализации.
const run = (input) =>
  new Function('$json', js('Normalize'))(input).map((x) => ({
    ...x.json,
    payload: typeof x.json.payload === 'string' ? JSON.parse(x.json.payload) : x.json.payload,
  }));
const one = (input) => {
  const r = run(input);
  if (r.length !== 1) throw new Error(`ожидалось 1 событие, получено ${r.length}`);
  return r[0];
};

const TS = 1754640000000;
const post = (over = {}) => ({
  id: 'p1', root_id: '', channel_id: 'c1', user_id: 'u1',
  message: 'Cross Data | Выгрузка данных\nНужна выгрузка по Forge за июль',
  create_at: TS, type: '', props: {}, ...over,
});

// ====================================================================== 1
line('1. Тема обращения разбирается из префикса — источник разреза по типам');
{
  const e = one({ event: 'posted', post: post() });
  check('event_type = request_created', e.event_type === 'request_created');
  check('kind = export', e.payload.kind === 'export');
  check('kind_source = intake (человек в форме, не LLM)',
    e.payload.kind_source === 'intake');
  check('ours = true', e.payload.ours === true);
  check('thread_id = id корневого поста', e.thread_id === 'p1');
  check('permalink собран', e.payload.permalink.endsWith('/pl/p1'));
}

// ====================================================================== 2
line('2. Все темы формы узнаются — иначе разрез молча съедет в unknown');
{
  // Список из сборщика: ("<Тема>", "<kind>", ours)
  const topics = [...BUILDER.matchAll(/\("((?:Cross Data|Вопрос команде)[^"]*)",\s*\n?\s*"([a-z_]+)",\s*(True|False)\)/g)]
    .map((m) => ({ title: m[1], kind: m[2], ours: m[3] === 'True' }));
  check(`тем в сборщике найдено (${topics.length}) — не ноль`, topics.length >= 10);
  for (const t of topics) {
    const e = one({ event: 'posted', post: post({ message: t.title + '\nтело' }) });
    check(`«${t.title.slice(0, 45)}» → ${t.kind}`,
      e.payload.kind === t.kind && e.payload.ours === t.ours);
  }
}

// ====================================================================== 3
line('3. Длинная тема не съедается короткой — порядок проверки префиксов');
{
  // «Вопрос команде DWH HR» — префикс своей же уточнённой версии с ` | `.
  // Наивный обход списка отдал бы обеим один kind, и разрез потерялся бы.
  const e = one({ event: 'posted', post: post({
    message: 'Вопрос команде DWH HR | реплика (prod_v_ods) не актуальна\nтело',
  }) });
  check('уточнённая тема → dwh_hr_replica', e.payload.kind === 'dwh_hr_replica');

  const bare = one({ event: 'posted', post: post({ message: 'Вопрос команде DWH HR\nтело' }) });
  check('короткая тема → dwh_hr', bare.payload.kind === 'dwh_hr');
}

// ====================================================================== 4
line('4. Неизвестная тема НАЗЫВАЕТСЯ, а не проглатывается');
{
  const e = one({ event: 'posted', post: post({
    message: 'Cross Data | Новая тема из формы\nтело',
  }) });
  check('kind = unknown', e.payload.kind === 'unknown');
  check('сырой префикс сохранён для разбора',
    e.payload.topic.includes('Новая тема'));
  check('ours = true (префикс Cross Data виден)', e.payload.ours === true);
}

// ====================================================================== 5
line('5. Чужие обращения (DWH HR) пишутся, но помечены ours=false');
{
  // Не отбрасываем: считать отдельно можно, задним числом добрать нельзя.
  const e = one({ event: 'posted', post: post({ message: 'Вопрос команде DWH HR\nтело' }) });
  check('событие записано', e.event_type === 'request_created');
  check('ours = false', e.payload.ours === false);
}

// ====================================================================== 6
line('6. Реакция БЕЗ треда в событии склеивается по догоняющему GET /posts');
{
  // Главная тихая ошибка: в событии реакции есть post_id и нет root_id.
  // Реакцию ставят на любое сообщение внутри треда.
  const e = one({
    event: 'reaction_added',
    data: { reaction: { post_id: 'p9', user_id: 'u2', emoji_name: 'loading', create_at: TS } },
    post: post({ id: 'p9', root_id: 'p1' }),
  });
  check('thread_id взят из root_id догоняющего поста', e.thread_id === 'p1');
  check('event_type = taken', e.event_type === 'taken');
  check('on_root = false (реакция внутри треда)', e.payload.on_root === false);
}

// ====================================================================== 7
line('7. Тело реакции JSON-СТРОКОЙ разбирается — иначе emoji_name пропадёт');
{
  // В WebSocket Mattermost data.reaction приходит строкой. Без разбора все
  // реакции стали бы неизвестными при размечающем дежурном.
  const e = one({
    event: 'reaction_added',
    data: { reaction: JSON.stringify({ post_id: 'p1', user_id: 'u2', emoji_name: 'done_checkmark', create_at: TS }) },
    post: post(),
  });
  check('emoji распознан из строки', e.payload.emoji === 'done_checkmark');
  check('event_type = closed', e.event_type === 'closed');
  check('resolved = true', e.payload.resolved === true);
}

// ====================================================================== 8
line('8. Словарь реакций: три эмодзи дежурного');
{
  const cases = [
    ['loading', 'taken', null],
    ['done_checkmark', 'closed', true],
    ['im_red_cross', 'closed', false],
  ];
  for (const [emoji, type, resolved] of cases) {
    const e = one({
      event: 'reaction_added',
      data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: emoji, create_at: TS } },
      post: post(),
    });
    check(`:${emoji}: → ${type}${resolved === null ? '' : ' resolved=' + resolved}`,
      e.event_type === type && e.payload.resolved === resolved && e.payload.known === true);
  }
}

// ====================================================================== 9
line('9. Правила снятия РАЗНЫЕ у разных эмодзи — инвариант метрик');
{
  // :loading: снимают, когда ставят закрывающую реакцию. Сбрасывай его
  // снятие — и reaction time обнулится у ВСЕХ закрытых обращений.
  const taken = one({
    event: 'reaction_removed',
    data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'loading', remove_at: TS } },
    post: post(),
  });
  check(':loading: снятие НЕ сбрасывает taken_at',
    taken.payload.resets_on_remove === false);
  check('тип помечен как снятие', taken.event_type === 'taken_removed');

  const closed = one({
    event: 'reaction_removed',
    data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'done_checkmark', remove_at: TS } },
    post: post(),
  });
  check('закрывающая реакция снятием ПЕРЕОТКРЫВАЕТ',
    closed.payload.resets_on_remove === true);
  check('тип помечен как снятие', closed.event_type === 'closed_removed');
}

// ===================================================================== 10
line('10. Ссылка на задачу из ответа intake-бота = связка с трекером');
{
  // Связь ставит машина, а не человек: регулярка по забытому ключу не нужна.
  const r = run({
    event: 'posted',
    post: post({
      id: 'p2', root_id: 'p1', user_id: 'bot1', props: { from_bot: 'true' },
      message: 'Задача заведена: DPIAM-1234\nhttps://jira3.tcsbank.ru/browse/DPIAM-1234',
    }),
  });
  const linked = r.find((x) => x.event_type === 'task_linked');
  check('событие task_linked есть', Boolean(linked));
  check('ключ задачи разобран', linked?.payload.task_key === 'DPIAM-1234');
  check('ссылка сохранена', String(linked?.payload.task_url).includes('DPIAM-1234'));
  check('thread_id = корень треда, а не id ответа', linked?.thread_id === 'p1');
  check('ответ бота тоже записан как bot_replied',
    r.some((x) => x.event_type === 'bot_replied'));
}

// ===================================================================== 11
line('11. Ответ человека в треде ≠ обращение');
{
  // Триггер posted срабатывает на каждую реплику. Считать их обращениями —
  // значит завысить счёт в разы.
  const e = one({ event: 'posted', post: post({ id: 'p3', root_id: 'p1', message: 'а можно ещё поле?' }) });
  check('event_type = human_replied', e.event_type === 'human_replied');
  check('thread_id = корень', e.thread_id === 'p1');
  check('kind не выдумывается', e.payload.kind === undefined);
}

// ===================================================================== 12
line('12. Реакции бота отсеиваются — иначе reaction time занижен');
{
  // Бот ставит реакции уверенности в этот же канал. Считать их за
  // «дежурный отреагировал» = получить медиану в секунды и не заметить.
  const src = BUILDER.replace('BOT_USER_IDS = []', 'BOT_USER_IDS = ["botX"]');
  const patched = new Function('$json',
    js('Normalize').replace(/const BOT_USER_IDS = \[\];/, 'const BOT_USER_IDS = ["botX"];'));
  const r = patched({
    event: 'reaction_added',
    data: { reaction: { post_id: 'p1', user_id: 'botX', emoji_name: 'loading', create_at: TS } },
    post: post(),
  }).map((x) => ({ ...x.json, payload: JSON.parse(x.json.payload) }));
  check('реакция бота не стала событием taken',
    !r.some((x) => x.event_type === 'taken'));
  check('пропуск НАЗВАН, а не молчаливый', r.some((x) => x.event_type === 'skipped'));
  check('в сборщике есть точка настройки BOT_USER_IDS',
    src.includes('BOT_USER_IDS = ["botX"]'));
}

// ===================================================================== 13
line('13. event_id идемпотентен — повторный проход снапшота бесплатен');
{
  // Крон-сверка перечитает те же посты. Без стабильного ключа получим
  // дубли обращений в витрине.
  const a = one({ event: 'posted', post: post() });
  const b = one({ event: 'posted', post: post() });
  check('одно событие → один и тот же event_id', a.event_id === b.event_id);

  const other = one({ event: 'posted', post: post({ id: 'p7' }) });
  check('разные посты → разные event_id', other.event_id !== a.event_id);

  // Добавление и снятие одной реакции — разные события, не дубли.
  const add = one({ event: 'reaction_added',
    data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'loading', create_at: TS } },
    post: post() });
  const del = one({ event: 'reaction_removed',
    data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'loading', remove_at: TS } },
    post: post() });
  check('add и remove одной реакции не склеиваются', add.event_id !== del.event_id);
}

// ===================================================================== 14
line('14. Неизвестный тип события не теряется молча');
{
  const e = one({ event: 'user_added', post: post() });
  check('event_type = unsupported_event', e.event_type === 'unsupported_event');
  check('тип события сохранён для разбора', e.payload.event === 'user_added');
}

// ===================================================================== 15
line('15. События не из канала проходят со своим ключом идемпотентности');
{
  // Ядро бота и вебхук кнопок знают естественный ключ своего события лучше,
  // чем нормализатор.
  const e = one({
    event: 'bot_answered', thread_id: 'p1', event_ts: TS, event_id: 'bot:p1:v3',
    actor: 'core', source: 'core', payload: { confidence_key: 'high', prompt_version: 'v3' },
  });
  check('event_id вызывающего сохранён', e.event_id === 'bot:p1:v3');
  check('confidence_key доехал до лога',
    e.payload.confidence_key === 'high');

  const auto = one({ event: 'bot_feedback', thread_id: 'p1', event_ts: TS, payload: { helpful: false } });
  check('без event_id ключ собирается сам', auto.event_id.startsWith('bot_feedback:p1:'));
}

// ===================================================================== 16
line('16. Выход НИКОГДА не пустой — пустой читался бы как «событий не было»');
{
  const r = run({ event: 'posted', post: post() });
  check('есть хотя бы одно событие', r.length >= 1);
  const weird = run({ event: '', post: {} });
  check('даже на мусоре выход не пустой', weird.length >= 1);
}

// ===================================================================== 17
line('17. Строка таблицы: только колонки схемы, payload сериализован');
{
  // Data Tables принимает string/number/boolean/date, вложенных объектов
  // не бывает. Лишнее поле в выходе = ошибка записи на живом прогоне.
  const cols = [...BUILDER.matchAll(/^\s{4}\("([a-z_]+)",\s*"(string|number|boolean|date)"/gm)]
    .map((m) => ({ name: m[1], type: m[2] }));
  check(`схема в сборщике найдена (${cols.length} колонок)`, cols.length >= 8);

  const rawRow = new Function('$json', js('Normalize'))({ event: 'posted', post: post() })[0].json;
  const names = Object.keys(rawRow);
  check('поля строки совпадают со схемой',
    names.length === cols.length && names.every((n) => cols.some((c) => c.name === n)));
  check('payload — строка, а не объект', typeof rawRow.payload === 'string');
  check('payload разбирается обратно',
    JSON.parse(rawRow.payload).kind === 'export');
  check('event_ts число (Data Tables не примет null)',
    typeof rawRow.event_ts === 'number');
  check('ingested_at проставлен — виден лаг и работа backfill',
    rawRow.ingested_at > 0);
  for (const c of cols) {
    const v = rawRow[c.name];
    const okType = c.type === 'number' ? typeof v === 'number' : typeof v === 'string';
    check(`${c.name}: ${c.type}`, okType);
  }
}

// ===================================================================== 18
line('18. kind поднят в колонку — по нему группируется витрина');
{
  const created = run({ event: 'posted', post: post() })[0];
  check('request_created несёт kind в колонке', created.kind === 'export');
  // У реакции темы нет: выдумывать её из треда значило бы запрос к API на
  // каждое событие. Пересчёт витрины берёт kind с корневого события.
  const react = run({
    event: 'reaction_added',
    data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'loading', create_at: TS } },
    post: post(),
  })[0];
  check('у реакции kind пустой, а не выдуманный', react.kind === '');
  check('но thread_id есть — по нему склейка', react.thread_id === 'p1');
}

// ===================================================================== 19
line('19. Домены роутера бота едут в колонку — кластеризация без второй LLM');
{
  // Роутер ядра уже определил домен по таблице «Домены» реестра. Отдельная
  // LLM для кластеризации платила бы вторым вызовом модели за готовое.
  const e = run({
    event: 'bot_answered', thread_id: 'p1', event_ts: TS,
    payload: { domains: ['movement', 'headcount-structure'], confidence_key: 'high' },
  })[0];
  check('домены склеены через запятую',
    e.domains === 'movement,headcount-structure');
  check('confidence_key остался в payload', e.payload.confidence_key === 'high');

  const none = run({ event: 'bot_answered', thread_id: 'p1', event_ts: TS, payload: {} })[0];
  check('без доменов колонка пустая, а не "undefined"', none.domains === '');
}

// ===================================================================== 20
line('20. Проводка Ingest: upsert по event_id, а не insert');
{
  const w = wf.nodes.find((n) => n.name === 'Write event');
  check('нода Data Table', w.type === 'n8n-nodes-base.dataTable');
  // Insert дал бы дубли обращений при крон-сверке и повторном backfill:
  // «обращений за неделю» выросло бы без причины.
  check('операция upsert', w.parameters.operation === 'upsert');
  const cond = JSON.stringify(w.parameters.filters);
  check('совпадение по event_id', cond.includes('event_id'));
  check('таблица support_event',
    JSON.stringify(w.parameters.dataTableId).includes('support_event'));
}

// ===================================================================== 21
line('21. Коллектор: фильтр канала кодом, догоняющий пост только у реакций');
{
  const col = JSON.parse(fs.readFileSync('Telemetry Collector.json', 'utf8'));
  const t = col.nodes.find((n) => n.name === 'Time Trigger');
  const events = t.parameters.events;
  check('слушаем posted', events.includes('posted'));
  check('слушаем reaction_added', events.includes('reaction_added'));
  // Без снятия закрытое обращение останется закрытым навсегда, и исправление
  // ошибки дежурного не доедет до витрины.
  check('слушаем reaction_removed', events.includes('reaction_removed'));

  // postedFilters не действует на реакции — фильтр по каналу обязателен кодом.
  const g = col.nodes.find((n) => n.name === 'Guard channel');
  check('Guard фильтрует по channel_id', g.parameters.jsCode.includes('CHANNEL_ID'));
  check('Guard помечает отсутствие фильтра в данных',
    g.parameters.jsCode.includes('channel_unfiltered'));

  // Прогон Guard на живом коде: константы в сборщике недостаточно, важно
  // что реакция из ЧУЖОГО канала действительно не проходит. Иначе в лог
  // поедут реакции из канала черновиков и лички, а reaction time поедет.
  const guard = (i) => new Function('$json', g.parameters.jsCode)(i)[0].json;
  const CH = (BUILDER.match(/CHANNEL_ID = os\.environ\.get\("CHANNEL_ID", "([^"]*)"\)/) || [])[1];
  check('CHANNEL_ID задан в сборщике', Boolean(CH));
  if (CH) {
    const react = (ch) => guard({ event: 'reaction_added',
      data: { reaction: { post_id: 'p1', user_id: 'u2', emoji_name: 'loading', channel_id: ch } } });
    const ours = react(CH);
    check('реакция из своего канала проходит', ours.pass === true);
    check('фильтр активен (channel_unfiltered = false)',
      ours.channel_unfiltered === false);
    check('реакция из ЧУЖОГО канала НЕ проходит',
      react('alien-channel-id').pass === false);
    // GET /posts на каждое сообщение канала был бы лишним запросом к API.
    check('реакции нужен догоняющий пост', ours.needs_post === true);
    const posted = guard({ event: 'posted',
      post: { id: 'p1', root_id: '', channel_id: CH, message: 'Cross Data | Выгрузка данных' } });
    check('posted проходит без догоняющего поста',
      posted.pass === true && posted.needs_post === false);
  }

  // GET /posts на каждое сообщение канала был бы лишним запросом.
  check('догоняющий пост только для реакций',
    g.parameters.jsCode.includes("event.startsWith('reaction')"));

  // Пост могли удалить — падать из-за этого нельзя.
  const gp = col.nodes.find((n) => n.name === 'Get post');
  check('Get post не роняет флоу', gp.onError === 'continueRegularOutput');

  // Свёртка: после Get post в $json ответ API, а не событие. Без неё
  // нормализатор не увидел бы реакцию — тихий отказ.
  const m = col.nodes.find((n) => n.name === 'Merge reaction');
  check('Merge берёт событие из Guard',
    m.parameters.jsCode.includes("$('Guard channel')"));
  check('Merge терпит отсутствие Get post (try/catch)',
    m.parameters.jsCode.includes('catch'));

  // Веер на выходе = двойное выполнение узла за развилкой.
  for (const [name, c] of Object.entries(col.connections)) {
    for (const out of c.main || []) {
      check(`${name}: не больше одной цели на выход`, (out || []).length <= 1);
    }
  }
}

// ===================================================================== 22
line('22. Backfill: реакции идут вместе с постом, пустой ответ назван');
{
  const bf = JSON.parse(fs.readFileSync('Telemetry Backfill.json', 'utf8'));
  const ex = bf.nodes.find((n) => n.name === 'Explode posts');
  const explode = (input) => new Function('$json', ex.parameters.jsCode)(input).map((x) => x.json);

  // В ответе GET /channels/{id}/posts реакции лежат в metadata.reactions —
  // один запрос закрывает и сообщения, и разметку, догоняющий GET не нужен.
  const r = explode({ posts: { p1: {
    ...post(),
    metadata: { reactions: [{ post_id: 'p1', user_id: 'u2', emoji_name: 'loading', create_at: TS }] },
  } } });
  check('пост развёрнут', r.some((x) => x.event === 'posted'));
  check('реакция развёрнута', r.some((x) => x.event === 'reaction_added'));
  check('у реакции есть пост — тред уже известен',
    r.find((x) => x.event === 'reaction_added').post.id === 'p1');

  // Пустой ответ от сбоя запроса не отличить, поэтому говорим прямо.
  const empty = explode({ posts: {} });
  check('пустой ответ НАЗВАН, а не молчит',
    empty[0].event === 'backfill_empty');

  // Backfill проходит через тот же нормализатор: его события должны в нём
  // разбираться, иначе засев запишет мусор.
  const viaNorm = run(r.find((x) => x.event === 'reaction_added'));
  check('событие backfill разбирается нормализатором',
    viaNorm[0].event_type === 'taken' && viaNorm[0].thread_id === 'p1');
}

// ===================================================================== 23
line('23. Выгрузка канала для засева НЕ годится — берём из API');
{
  // hr-report-ask-3-4-aug-2026.md — обработанная таблица «вопрос → решение»:
  // в ней нет таймстемпов, реакций и структуры тредов. Метрики времени из неё
  // не собрать. Проверка держит документацию честной.
  // Выгрузка канала лежит уровнем выше: она общая для бота и телеметрии,
  // и в этот репозиторий не коммитится (переписка канала). Отсутствие файла
  // не должно ронять весь прогон: раньше на нём обрывались ВСЕ проверки ниже,
  // и по выводу это выглядело как «тесты прошли до конца».
  const DUMP_AT = '../hr-report-ask-3-4-aug-2026.md';
  if (fs.existsSync(DUMP_AT)) {
    const dump = fs.readFileSync(DUMP_AT, 'utf8');
    check('в выгрузке нет таймстемпов create_at', !dump.includes('create_at'));
    check('в выгрузке нет реакций', !dump.includes('loading'));
  } else {
    console.log('  скип выгрузка канала не найдена: ' + DUMP_AT);
  }
  const bf = fs.readFileSync('Telemetry Backfill.json', 'utf8');
  check('backfill идёт в API канала, а не в файл',
    bf.includes('/channels/') && bf.includes('/posts'));
}

// ===================================================================== 24
line('24. Вызов Ingest передаёт элемент ЦЕЛИКОМ, а не пустой маппинг');
{
  // Триггер Ingest объявлен passthrough: события Time — вложенные объекты
  // (data.reaction, post.props), а типизированные workflowInputs рассчитаны
  // на скаляры (как urn/search в DD Lookup).
  //
  // Пустой {mappingMode: 'defineBelow', value: {}} ХУЖЕ отсутствия: он
  // объявляет «маппинг задан, полей ноль». В Ingest ушёл бы пустой элемент,
  // нормализатор получил бы event: '' и записал unsupported_event — флоу
  // зелёный, а в таблице мусор.
  const trig = wf.nodes.find((n) => n.type.includes('executeWorkflowTrigger'));
  check('триггер Ingest — passthrough', trig.parameters.inputSource === 'passthrough');

  for (const f of ['Telemetry Collector.json', 'Telemetry Backfill.json']) {
    const w = JSON.parse(fs.readFileSync(f, 'utf8'));
    const call = w.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflow');
    check(`${f}: вызов Ingest есть`, Boolean(call));
    check(`${f}: workflowInputs НЕ задан (иначе пустой элемент)`,
      !('workflowInputs' in call.parameters));
    check(`${f}: waitForSubWorkflow — ошибка записи должна быть видна`,
      call.parameters.options?.waitForSubWorkflow === true);
  }
}

// ===================================================================== 25
line('25. Backfill аутентифицирован — иначе 401 читается как «постов нет»');
{
  const bf = JSON.parse(fs.readFileSync('Telemetry Backfill.json', 'utf8'));
  const get = bf.nodes.find((n) => n.name === 'Get posts');
  // Анонимный запрос вернул бы 401 без постов, а Explode posts прочитал бы
  // это как backfill_empty — «за период ничего не было».
  check('credential Time есть', Boolean(get.credentials?.mattermostApi));
  check('предопределённый тип credential',
    get.parameters.authentication === 'predefinedCredentialType' &&
    get.parameters.nodeCredentialType === 'mattermostApi');
  // Редирект на страницу логина иначе приходит как 200 с HTML, и «нет
  // доступа» становится неотличимо от «нет постов».
  check('followRedirects: false',
    get.parameters.options?.redirect?.redirect?.followRedirects === false);

  // Ноды Time в коллекторе — на том же credential, что адаптеры бота.
  const col = JSON.parse(fs.readFileSync('Telemetry Collector.json', 'utf8'));
  for (const n of col.nodes.filter((x) => x.type.includes('mattermost'))) {
    check(`${n.name}: credential Time`, Boolean(n.credentials?.mattermostApi));
  }
}

// ===================================================================== 26
line('26. CSV для создания таблицы: колонки как в схеме, без BOM');
{
  // Таблица создаётся импортом этого CSV, а тип колонки после создания
  // не меняется. Расхождение с тем, что пишет нормализатор, обнаружится
  // только на живой записи — и лечиться будет пересозданием таблицы.
  if (!fs.existsSync('support_event.csv')) {
    check('support_event.csv есть (node make_table_csv.mjs)', false);
  } else {
    const raw = fs.readFileSync('support_event.csv', 'utf8');

    // BOM приклеился бы к имени первой колонки: `﻿event_id` не совпадает
    // с `event_id`, по которому Ingest делает upsert, — ключ идемпотентности
    // молча перестал бы работать, и каждое событие писалось бы новой строкой.
    check('без BOM — иначе имя первой колонки испорчено',
      !raw.startsWith('﻿'));

    const head = raw.split(/\r?\n/)[0].split(',');
    const want = [...BUILDER.matchAll(/^\s{4}\("([a-z_]+)",\s*"(string|number|boolean|date)"/gm)]
      .map((m) => m[1]);
    check('колонки CSV = схема сборщика, в том же порядке',
      head.join(',') === want.join(','));
    for (const h of head) {
      check(`${h}: имя годится для Data Tables`, /^[a-zA-Z][a-zA-Z0-9_]*$/.test(h));
    }

    // Числовые колонки должны нести ЧИСЛА: n8n определяет тип сэмплированием,
    // и пустая или строковая колонка стала бы string — сравнения по времени
    // в витрине пришлось бы делать над строками.
    const cells = raw.split(/\r?\n/)[1].match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    for (const numCol of ['event_ts', 'ingested_at']) {
      const v = cells[head.indexOf(numCol)];
      check(`${numCol}: число в сэмпле, иначе тип станет string`,
        v !== '' && !Number.isNaN(Number(v)));
    }

    // Строки станут настоящими строками лога: импорт создаёт таблицу и
    // заливает данные одним действием. Их надо уметь найти и удалить.
    check('строки помечены schema_sample для удаления после импорта',
      raw.includes('schema_sample'));
    check('event_id с префиксом sample:', raw.includes('sample:'));
  }
}

// ===================================================================== 27
line('27. Ключ задачи берётся из ССЫЛКИ, а не из любого похожего текста');
{
  // Дежурный нажимает «завести задачу» → бот отвечает в тред ссылкой.
  const link = (msg, fromBot = true) => run({ event: 'posted', post: post({
    id: 'p2', root_id: 'p1', user_id: fromBot ? 'bot1' : 'u-human',
    props: fromBot ? { from_bot: 'true' } : {}, message: msg,
  }) }).find((x) => x.event_type === 'task_linked');

  const tr = link('Задача заведена: https://tracker.t-tech.team/tasks/CROSS-20001');
  check('ссылка T-Tracker: ключ разобран', tr?.payload.task_key === 'CROSS-20001');
  check('ссылка T-Tracker: помечена как tracker', tr?.payload.tracker === 'tracker');
  check('thread_id = корень треда', tr?.thread_id === 'p1');

  // jira3 нужна для истории: задачи за июль-август лежат там.
  const jr = link('https://jira3.tcsbank.ru/browse/CROSS-19309');
  check('ссылка jira3: ключ разобран', jr?.payload.task_key === 'CROSS-19309');
  check('ссылка jira3: помечена как jira', jr?.payload.tracker === 'jira');

  // Голый ключ от человека НЕ связывает: «HR-2» или имя таблицы `MDM-1`
  // дали бы связь с несуществующей задачей, и cycle time потерялся бы там,
  // где он есть.
  check('человек написал похожее на ключ — связи НЕТ',
    !link('вопрос по HR-2 и таблице MDM-1', false));
  check('бот написал голый ключ — связь есть (пишет по шаблону)',
    link('Заведена CROSS-20002', true)?.payload.task_key === 'CROSS-20002');
}

// ===================================================================== 28
line('28. Коллектор трекера: опрашиваются только ОТКРЫТЫЕ задачи');
{
  const tr = JSON.parse(fs.readFileSync('Telemetry Collector Tracker.json', 'utf8'));
  const nodeJs = (n) => tr.nodes.find((x) => x.name === n).parameters.jsCode;

  const collect = (rows) => new Function('$input',
    nodeJs('Collect task keys'))({ all: () => rows.map((json) => ({ json })) })[0].json;

  const ev = (type, payload, thread = 'p1') => ({
    event_type: type, thread_id: thread, payload: JSON.stringify(payload),
  });

  // Спейс НЕ нужен: ключи приходят из треда, опрашиваем ровно их.
  const plan = collect([
    ev('task_linked', { task_key: 'CROSS-1', tracker: 'tracker' }, 't1'),
    ev('task_linked', { task_key: 'CROSS-2', tracker: 'tracker' }, 't2'),
    ev('task_linked', { task_key: 'CROSS-19309', tracker: 'jira' }, 't3'),
    ev('task_status_changed', { task_key: 'CROSS-2', status: 'Done', is_final: true }, 't2'),
  ]);
  check('TQL собран по ключам из треда', plan.tql.includes('CROSS-1'));
  // Закрытые не опрашиваем: статус не изменится, а список иначе растёт вечно.
  check('закрытая задача исключена', !plan.tql.includes('CROSS-2'));
  // Коллектор умеет только T-Tracker; запрос по ключу jira вернул бы пустоту,
  // которую легко прочитать как «задача исчезла».
  check('задача из jira3 не опрашивается', !plan.tql.includes('CROSS-19309'));
  check('thread_id задачи сохранён', plan.threads['CROSS-1'] === 't1');

  // Пустой IN () вернул бы ошибку либо ВСЕ 68 тысяч задач трекера.
  const empty = collect([]);
  check('без задач запрос не отправляется', empty.nothing_to_poll === true);
  check('пустой TQL не собирается', empty.tql === '');
}

// ===================================================================== 29
line('29. Diff: событие только на ИЗМЕНЕНИЕ, время — переход, а не опрос');
{
  const tr = JSON.parse(fs.readFileSync('Telemetry Collector Tracker.json', 'utf8'));
  const diffJs = tr.nodes.find((x) => x.name === 'Diff statuses').parameters.jsCode;
  const diff = (plan, items) => new Function('$', '$json', diffJs)(
    (n) => {
      if (n === 'Collect task keys') return { first: () => ({ json: plan }) };
      throw new Error('node not executed: ' + n);
    }, { items },
  ).map((x) => x.json);

  const PLAN = { keys: ['CROSS-1'], threads: { 'CROSS-1': 't1' },
                 known: { 'CROSS-1': 'In Progress' }, dropped: [] };
  const TRANSITION = '2026-08-10T07:00:00.000000Z';

  // Без сравнения с известным статусом каждый прогон крона добавлял бы
  // строку на задачу — сотни записей в день без новой информации.
  check('статус не менялся — событий нет',
    diff(PLAN, [{ key: 'CROSS-1', fields: { status: 'In Progress',
      status_update_at: TRANSITION } }]).length === 0);

  const moved = diff(PLAN, [{ key: 'CROSS-1', fields: {
    status: 'Done', status_update_at: TRANSITION,
    create_at: '2026-08-08T10:00:00.000000Z',
    finish_at: '2026-08-10T07:00:00.000000Z' } }]);
  check('изменение статуса → одно событие', moved.length === 1);
  check('event_ts = ВРЕМЯ ПЕРЕХОДА, а не момент опроса',
    moved[0].event_ts === Date.parse(TRANSITION));
  check('status_from сохранён', moved[0].payload.status_from === 'In Progress');
  // finish_at трекер заполняет сам по статусу с aux.type = finish — надёжнее,
  // чем угадывать финальность по названию из 76 возможных.
  check('финальность по finish_at', moved[0].payload.is_final === true);
  check('время заведения задачи в payload',
    moved[0].payload.task_created_at === Date.parse('2026-08-08T10:00:00.000000Z'));
  // Повторный прогон крона на том же состоянии не должен плодить строки.
  check('event_id по времени перехода — идемпотентность',
    moved[0].event_id.includes(TRANSITION));

  // Промежуточные статусы приблизительны: истории переходов в T-Tracker нет
  // (404 на /history и /changelog), видно только то, что застал крон.
  check('снимок помечен как snapshot', moved[0].payload.snapshot === true);

  // 403 на чужой спейс: поиск просто не вернёт задачу. Молчать нельзя —
  // выглядело бы как «статус не менялся», и cycle time тихо замер бы.
  const missing = diff(PLAN, []);
  check('невернувшаяся задача НАЗВАНА', missing.length === 1);
  check('причина в payload', String(missing[0].payload.error).includes('нет доступа'));

  // Обрезка по лимиту тоже называется.
  const over = diff({ ...PLAN, keys: [], dropped: ['CROSS-9'] }, []);
  check('обрезанная по лимиту задача названа',
    String(over[0]?.payload.error).includes('лимит'));
}

// ===================================================================== 30
line('30. Проводка коллектора трекера');
{
  const tr = JSON.parse(fs.readFileSync('Telemetry Collector Tracker.json', 'utf8'));
  const search = tr.nodes.find((n) => n.name === 'Search tasks');
  // Точечный GET /tasks/key/{key} даёт 403 на недоступный спейс и роняет
  // прогон целиком; поиск возвращает только доступное.
  check('опрос через POST /tasks/search',
    search.parameters.method === 'POST' && search.parameters.url.includes('/tasks/search'));
  check('credential Service Account',
    Boolean(search.credentials?.devplatformApi));
  check('neverError — 4xx не роняет флоу',
    search.parameters.options?.response?.response?.neverError === true);
  check('followRedirects: false',
    search.parameters.options?.redirect?.redirect?.followRedirects === false);

  const read = tr.nodes.find((n) => n.name === 'Read log');
  check('лог читается из support_event',
    JSON.stringify(read.parameters.dataTableId).includes('support_event'));

  const call = tr.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  check('запись через Ingest, а не напрямую в таблицу', Boolean(call));
  check('workflowInputs не задан (passthrough)',
    !('workflowInputs' in call.parameters));

  for (const [name, c] of Object.entries(tr.connections)) {
    for (const out of c.main || []) {
      check(`${name}: не больше одной цели на выход`, (out || []).length <= 1);
    }
  }
}

// ===================================================================== 31
line('31. Событие БЕЗ поля event — так его отдаёт живая нода');
{
  // Первый живой прогон 2026-08-11 дал сплошные unsupported_event: поле
  // `event` взято из документации Mattermost WebSocket, а mattermostTrigger
  // его не отдаёт. Все тесты до этого подавали `event` руками — и потому
  // ошибку не поймали. Здесь она поймана: события подаются БЕЗ имени.
  const P = { id: 'p1', root_id: '', channel_id: 'c1', user_id: 'u1',
              create_at: TS, type: '', props: {},
              message: 'Cross Data | Выгрузка данных\nтело' };

  const posted = run({ post: P });
  check('пост без event → request_created',
    posted[0].event_type === 'request_created');
  check('тема всё равно разобрана', posted[0].kind === 'export');

  const react = run({ data: { reaction: {
    post_id: 'p1', user_id: 'u2', emoji_name: 'loading', create_at: TS } }, post: P });
  check('реакция без event → taken', react[0].event_type === 'taken');
  // Снятие от добавления без имени события не отличить, и это должно быть
  // видно в данных: иначе снятое «взято в работу» останется в метриках.
  check('домысливание помечено в payload',
    react[0].payload.event_inferred === true);

  // Имя события приоритетнее формы — только оно различает add/remove.
  const named = run({ event: 'reaction_removed', data: { reaction: {
    post_id: 'p1', user_id: 'u2', emoji_name: 'done_checkmark', remove_at: TS } }, post: P });
  check('имя события, если есть, важнее формы',
    named[0].event_type === 'closed_removed');
  check('пришедшее имя не помечается домыслом',
    named[0].payload.event_inferred === false);

  // Guard коллектора должен выводить тип так же — иначе реакции не получат
  // догоняющий пост и размажутся по нескольким thread_id.
  const col = JSON.parse(fs.readFileSync('Telemetry Collector.json', 'utf8'));
  const gjs = col.nodes.find((n) => n.name === 'Guard channel').parameters.jsCode;
  const guard = (i) => new Function('$json', gjs)(i)[0].json;
  const CH = (BUILDER.match(/CHANNEL_ID = os\.environ\.get\("CHANNEL_ID", "([^"]*)"\)/) || [])[1];
  const gr = guard({ data: { reaction: { post_id: 'p1', user_id: 'u2',
    emoji_name: 'loading', channel_id: CH } } });
  check('Guard: реакция без event распознана', gr.event === 'reaction_added');
  check('Guard: догоняющий пост запрошен', gr.needs_post === true);
  check('Guard: признак домысливания протащен', gr.event_inferred === true);
  const gp = guard({ post: { ...P, channel_id: CH } });
  check('Guard: пост без event распознан', gp.event === 'posted');
  check('Guard: посту догоняющий пост не нужен', gp.needs_post === false);

  // Диагностика: одной строки должно хватать, чтобы увидеть форму события.
  const junk = run({ foo: 1, bar: { baz: 2 } });
  check('нераспознанное несёт КЛЮЧИ payload для разбора',
    junk[0].payload.top_keys === 'foo,bar');
  check('нераспознанное не притворяется известным',
    junk[0].event_type === 'unsupported_event');
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 26
line('26. Кнопки обратной связи: нажатие, форма, защита от повторов');
{
  const fb = JSON.parse(fs.readFileSync('Feedback Webhook.json', 'utf8'));
  const fbJs = (n) => {
    const node = fb.nodes.find((x) => x.name === n);
    if (!node) throw new Error(`нет ноды ${n} в Feedback Webhook`);
    return node.parameters.jsCode;
  };
  const parse = (body) => new Function('$json', fbJs('Parse action'))({ body })[0].json;

  const CTX = {
    action: 'helpful', thread_id: 'req1', topic: 'Cross Data | Выгрузка данных',
    confidence: 'medium', prompt_version: 'abc12345',
  };
  const press = (over = {}) => ({
    user_id: 'u7', post_id: 'bot1', channel_id: 'drafts', trigger_id: 'tr1',
    context: { ...CTX, ...over },
  });

  // Оценка «помогло»
  const yes = parse(press());
  check('helpful → событие bot_feedback', yes.event.event === 'bot_feedback');
  check('helpful записан булевым', yes.event.payload.helpful === true);
  check('оценка склеена с обращением, а не с постом бота',
    yes.event.thread_id === 'req1');
  check('версия промптов доехала', yes.event.payload.prompt_version === 'abc12345');
  check('уверенность доехала', yes.event.payload.confidence === 'medium');
  check('источник события — вебхук', yes.event.source === 'webhook');
  // Тема из контекста кнопки кладётся в колонку АНАЛИТИЧЕСКИМ ключом, тем же,
  // что пишет обращение. Иначе разбивка по темам развалится на «обращения»
  // и «оценки» как на разные темы.
  check('тема кнопки приведена к ключу', yes.event.payload.kind === 'export');
  check('исходный заголовок сохранён для разбора',
    yes.event.payload.topic === 'Cross Data | Выгрузка данных');
  // Человек видит ответ ВСЕГДА: без этого нажатие неотличимо от мёртвой кнопки.
  check('на нажатие есть видимый ответ', Boolean(yes.response.ephemeral_text));
  // Отметка вместо кнопок собирается позже — в Build reply, где есть
  // исходный пост. Здесь только её содержимое.
  check('отметка вместо кнопок подготовлена', yes.verdict.text.includes('Помогло'));
  check('пост читается перед правкой', yes.needs_post === true);

  const no = parse(press({ action: 'not_helpful' }));
  check('not_helpful записан булевым', no.event.payload.helpful === false);

  // Повторное нажатие тем же человеком по тому же обращению переписывает
  // оценку, а не добавляет вторую: Ingest делает upsert по event_id.
  check('ключ идемпотентности без времени',
    yes.event.event_id === 'bot_feedback:req1:u7' &&
    no.event.event_id === yes.event.event_id);
  // А другой человек — это другая оценка.
  check('оценка другого человека не затирает первую',
    parse({ ...press(), user_id: 'u9' }).event.event_id === 'bot_feedback:req1:u9');

  // Развёрнутый отзыв: сначала форма, потом запись.
  const detail = parse(press({ action: 'detail' }));
  check('detail открывает форму', detail.needs_dialog === true);
  // Само нажатие пишется отдельным типом события. Пока не писалось ничего,
  // «кнопки не работают» и «кнопки работают, но текст не дописывают»
  // выглядели в логе одинаково — никак.
  check('нажатие «подробнее» пишется отдельным событием',
    detail.event.event === 'feedback_detail_opened');
  check('открытие формы не считается оценкой',
    !('helpful' in detail.event.payload));
  check('повторное открытие не плодит строк',
    detail.event.event_id === 'feedback_detail_opened:req1:u7');
  check('поста этой ветке не нужно', detail.needs_post === false);
  check('форма несёт контекст через state',
    JSON.parse(detail.dialog.dialog.state).thread_id === 'req1' &&
    JSON.parse(detail.dialog.dialog.state).prompt_version === 'abc12345');
  // Адрес ответа формы — тот же вебхук, что у кнопок: он подставляется
  // сборщиком из FEEDBACK_WEBHOOK_URL. Плейсхолдер допустим — сборщик о нём
  // предупреждает, — но он обязан быть заметным, а не пустым: пустой URL
  // это молча неработающая форма.
  check('у формы есть адрес ответа',
    detail.dialog.url === '__FEEDBACK_URL__' || /^https?:\/\//.test(detail.dialog.url));
  check('в форме есть поле текста',
    detail.dialog.dialog.elements[0].type === 'textarea');

  // Отправленная форма
  const sent = parse({
    type: 'dialog_submission',
    user_id: 'u7', channel_id: 'drafts',
    state: detail.dialog.dialog.state,
    submission: { text: 'вопросы дублируют друг друга' },
  });
  check('форма → событие feedback_text', sent.event.event === 'feedback_text');
  check('текст отзыва записан', sent.event.payload.text.includes('дублируют'));
  check('отзыв склеен с обращением', sent.event.thread_id === 'req1');
  check('версия промптов пережила форму',
    sent.event.payload.prompt_version === 'abc12345');
  check('человеку — подтверждение', Boolean(sent.response.ephemeral_text));

  // Оба события нормализатор Ingest должен принять как есть.
  const logged = one(sent.event);
  check('feedback_text доезжает до таблицы', logged.event_type === 'feedback_text');
  check('в таблице виден текст', logged.payload.text.includes('дублируют'));
  const loggedYes = one(yes.event);
  check('bot_feedback доезжает до таблицы', loggedYes.event_type === 'bot_feedback');
  check('в таблице видна оценка', loggedYes.payload.helpful === true);
  // Колонка kind — та же, что у обращения: по ней и группируется разбивка.
  check('оценка ложится в колонку темы', loggedYes.kind === 'export');
  const loggedOpen = one(detail.event);
  check('открытие формы доезжает до таблицы',
    loggedOpen.event_type === 'feedback_detail_opened');

  // Кнопка под СТАРЫМ постом отдаёт тему так, как её отдавал бот до
  // 2026-08-13: куском после префикса и под именем kind. Такие посты живут
  // в канале и нажимаются до сих пор — оценка по ним обязана лечь в ту же
  // тему, а не в отдельную.
  const legacy = parse({
    user_id: 'u7', post_id: 'bot1', channel_id: 'drafts',
    context: { action: 'helpful', thread_id: 'req1', kind: 'Выгрузка данных',
               confidence: 'medium', prompt_version: 'abc12345' },
  });
  check('старый контекст кнопки понят', legacy.event.payload.kind === 'export');
  // Тема, которой нет в списке, не выдумывается.
  const unseen = parse(press({ topic: 'Cross Data | Заявка на новую витрину' }));
  check('незнакомая тема помечена unknown', unseen.event.payload.kind === 'unknown');
  check('но сырой заголовок виден',
    unseen.event.payload.topic.includes('Заявка на новую витрину'));

  // Разъехавшаяся кнопка не молчит: иначе оценки перестали бы писаться,
  // а флоу остался бы зелёным.
  const weird = parse(press({ action: 'lgtm' }));
  check('незнакомая кнопка помечена', weird.unknown === true);
  check('незнакомая кнопка всё равно пишется в лог',
    weird.event.payload.unknown_action === 'lgtm' && weird.event.payload.helpful === null);

  // Проводка: форма открывается ДО записи (trigger_id живёт секунды),
  // а отвечает вебхук телом, которое собрал разбор.
  check('ветка формы идёт в Open dialog',
    fb.connections['Needs dialog'].main[0][0].node === 'Open dialog');
  check('вторая ветка решает, читать ли пост',
    fb.connections['Needs dialog'].main[1][0].node === 'Needs post');
  check('в Ingest уходит событие, а не разбор целиком',
    fbJs('Event for log').includes('$json.event'));

  // ОТВЕТ ИДЁТ ДО ЗАПИСИ В ЛОГ. Иначе отказ хранилища съедает ответ целиком,
  // и нажатие выглядит как «ничего не произошло» — ровно то, с чего начался
  // этот разбор.
  const after = (n) => (fb.connections[n]?.main?.[0] ?? []).map((c) => c.node);
  check('ответ на оценку — до лога', after('Respond feedback').includes('Event for log'));
  check('ответ на форму — до лога', after('Respond dialog').includes('Event for log'));
  check('лог — последним', after('Event for log').includes('To Ingest'));
  const respond = fb.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  check('ответ есть у каждой ветки плюс ping', respond.length === 3);

  // Обновление поста НЕ ЗАТИРАЕТ шапку. `update` в ответе интеграции —
  // это целый пост, а не патч: без message Mattermost сотрёт тему, ссылку
  // на обращение и уверенность, оставив одну строку «записано, спасибо».
  const reply = (input) =>
    new Function('$', '$json', fbJs('Build reply'))(
      () => ({ first: () => ({ json: yes }) }), input)[0].json;
  const withPost = reply({
    id: 'bot1', message: '🟢 **Выгрузка данных** · [открыть обращение](x)',
    props: { from_webhook: 'true' },
  });
  check('текст шапки переносится в обновление',
    withPost.response.update.message.includes('Выгрузка данных'));
  check('чужие props не затираются',
    withPost.response.update.props.from_webhook === 'true');
  check('кнопки заменяются отметкой',
    withPost.response.update.props.attachments[0].text.includes('Помогло'));
  // Пост не прочитан (удалён, права, сеть) — оценка всё равно записана,
  // а человек всё равно видит ответ. Тихого отказа нет ни в одном исходе.
  const noPost = reply(yes);
  check('без поста обновления нет', !noPost.response.update);
  check('без поста ответ всё равно есть', Boolean(noPost.response.ephemeral_text));
  check('событие переживает сборку ответа', noPost.event.event === 'bot_feedback');

  // Форма не открылась — человеку сказали, а не оставили молчать.
  const dialogReply = (input) =>
    new Function('$', '$json', fbJs('Dialog reply'))(
      () => ({ first: () => ({ json: detail }) }), input)[0].json;
  check('успех формы отвечает пустым телом',
    Object.keys(dialogReply({ id: 'ok' }).response).length === 0);
  check('отказ формы назван',
    dialogReply({ error: 'expired trigger_id' }).response.ephemeral_text.includes('не открылась'));

  // Проверка живости. Без неё «кнопка молчит» и «воркфлоу выключен»
  // неразличимы: 404 от выключенного вебхука Mattermost кладёт себе в лог.
  const ping = fb.nodes.find((n) => n.name === 'Ping');
  check('есть GET-проверка живости',
    ping.parameters.httpMethod === 'GET' && ping.parameters.path.endsWith('ping'));
}

// ===================================================================== 27
line('27. Кнопки под шапкой обращения в канале джуна');
{
  // Кнопки живут в адаптере бота, а проверяются здесь: смысл у них
  // телеметрический, и разъезжаются они с вебхуком, а не с черновиком.
  const ch = JSON.parse(fs.readFileSync('../bot/Adapter Channel.json', 'utf8'));
  const head = ch.nodes.find((n) => n.name === 'Post header');
  const att = head.parameters.attachments[0];
  const names = att.actions.item.map((a) => a.name).join(' ');

  check('три кнопки под ответом', att.actions.item.length === 3);
  check('есть «помогло»', names.includes('Помогло'));
  check('есть «не помогло»', names.includes('Не помогло'));
  check('есть развёрнутый отзыв', names.includes('подробнее'));

  const ctx = att.actions.item[0].integration.item.context.property;
  const byName = Object.fromEntries(ctx.map((p) => [p.name, p.value]));
  check('кнопка несёт действие', byName.action === 'helpful');
  // thread_id — id ИСХОДНОГО обращения: иначе оценка повиснет строкой,
  // не привязанной ни к какому обращению.
  check('кнопка несёт обращение', byName.thread_id === '={{ $json.thread_id }}');
  check('кнопка несёт уверенность', byName.confidence === '={{ $json.confidence_key }}');
  check('кнопка несёт версию промптов',
    /^[0-9a-f]{8}$/.test(byName.prompt_version));
  // Тема едет ЗАГОЛОВКОМ, а ключ из него делает вебхук: список тем живёт
  // в сборщике телеметрии, и бот про него по-прежнему не знает.
  check('кнопка несёт заголовок темы', byName.topic === '={{ $json.topic }}');
  check('отображаемое имя больше не выдаёт себя за ключ', !('kind' in byName));

  // Контекст собирается шапкой: без этих полей кнопка уедет с пустым context.
  const headJs = ch.nodes.find((n) => n.name === 'Build header').parameters.jsCode;
  for (const f of ['thread_id', 'topic', 'confidence_key']) {
    check('шапка отдаёт ' + f, new RegExp(f + ':').test(headJs));
  }
  // Заголовок собирается обратно из префикса и человекочитаемой части —
  // ровно тот вид, в котором тема лежит в списке нормализатора.
  check('заголовок темы собирается из префикса и темы',
    /src\.topic\b/.test(headJs) && /src\.topic_kind/.test(headJs));

  // Кнопки — только под шапкой. Под постами в треде они дали бы четыре
  // набора кнопок на одно обращение и четыре оценки вместо одной.
  const inThread = ch.nodes.find((n) => n.name === 'Post in thread');
  check('в треде кнопок нет', (inThread.parameters.attachments || []).length === 0);
}

// ===================================================================== 28
line('28. Колонки kind и domains: кто их заполняет и почему они бывают пусты');
{
  // Живой вопрос по таблице: «пишутся какие-то id, kind и domains пустые».
  // Разбор ниже фиксирует, где это норма, а где было тихой поломкой.

  // 1. Тема жирным. Intake-воркфлоу выделяет первую строку, и без снятия
  //    markdown ни одна тема не совпадала: kind уезжал `unknown`, а `ours`
  //    становился false — наше обращение считалось обращением к чужой команде.
  const bold = one({ event: 'posted', post: post({
    message: '**Cross Data | Выгрузка данных от пользователя @A**\nнужна выгрузка' }) });
  check('тема жирным распознана', bold.kind === 'export');
  check('тема жирным — обращение наше', bold.payload.ours === true);
  check('в topic markdown не протёк',
    bold.payload.topic === 'Cross Data | Выгрузка данных');

  // 2. kind пуст у всего, кроме корневого события, и это НЕ поломка:
  //    у реакции и реплики темы нет, а достраивать её значило бы запрос
  //    к API на каждое событие. Витрина берёт kind с корня треда.
  const reply = one({ event: 'posted', post: post({ id: 'p2', root_id: 'p1',
    message: 'ок, смотрю' }) });
  check('у реплики kind пуст по конструкции', reply.kind === '');
  check('но тред тот же — kind добирается с корня', reply.thread_id === 'p1');

  // 3. domains заполняет ТОЛЬКО ответ бота. Пока адаптер не писал
  //    bot_answered, колонка стояла пустой на всех строках.
  const answered = one({
    event: 'bot_answered', thread_id: 'p1', event_ts: TS, actor: 'core', source: 'core',
    payload: { domains: ['headcount-structure', 'legal'], confidence_key: 'medium',
               confidence_claimed: 'high', prompt_version: 'a04eed84' },
  });
  check('domains попали в колонку',
    answered.domains === 'headcount-structure,legal');
  check('пара «заявлено / действует» доехала',
    answered.payload.confidence_claimed === 'high' &&
    answered.payload.confidence_key === 'medium');
  check('версия промптов доехала', answered.payload.prompt_version === 'a04eed84');
}

// ===================================================================== 29
line('29. Адаптер пишет bot_answered — иначе domains неоткуда взяться');
{
  const ch = JSON.parse(fs.readFileSync('../bot/Adapter Channel.json', 'utf8'));
  const ev = ch.nodes.find((n) => n.name === 'Answer event');
  const ingest = ch.nodes.find((n) => n.name === 'To Ingest');
  check('в адаптере есть сборка события', Boolean(ev));
  check('в адаптере есть вызов Ingest',
    ingest.type === 'n8n-nodes-base.executeWorkflow');
  // Пустой маппинг ХУЖЕ отсутствия: он объявляет «поля заданы, их ноль»,
  // и в лог уехал бы unsupported_event при зелёном флоу.
  check('вызов Ingest без маппинга полей',
    !('workflowInputs' in ingest.parameters));

  // Ветвь лога отдельная: падение Ingest не должно мешать посту с черновиком,
  // и ни один узел не должен выполниться дважды.
  const fromHeader = ch.connections['Build header'].main[0].map((c) => c.node);
  check('лог — вторая ветвь от шапки',
    fromHeader.includes('Post header') && fromHeader.includes('Answer event'));
  check('ветви не сходятся',
    ch.connections['Answer event'].main[0][0].node === 'To Ingest' &&
    !ch.connections['To Ingest']);

  // Прогон сборки события на разборе ядра.
  const parsed = {
    domains: ['allocation'], confidence_claimed: 'high', confidence_key: 'medium',
    confidence_capped: true, confidence_capped_reason: 'статьи под запрос нет',
    is_export: true, articles_read: ['kb/metrics/fte-by-product.md'], dd_count: 1,
    kb_tasks: ['нет статьи об отчёте'], draft_len: 900, draft_leaks: ['business_dt'],
    parse_error: '', form_domain: 'Продуктовая структура',
  };
  const $ = (name) => {
    if (name === 'Call core') return { first: () => ({ json: parsed }) };
    if (name === 'Guard channel') return { first: () => ({ json: { post: { id: 'req9' } } }) };
    throw new Error('node not executed: ' + name);
  };
  const got = new Function('$', ev.parameters.jsCode)($)[0].json;
  check('событие привязано к обращению', got.thread_id === 'req9');
  check('домены роутера в событии',
    JSON.stringify(got.payload.domains) === '["allocation"]');
  check('ключ идемпотентности несёт версию промптов',
    /^bot_answered:req9:[0-9a-f]{8}$/.test(got.event_id));
  check('понижение уверенности видно',
    got.payload.confidence_capped === true &&
    got.payload.capped_reason.includes('статьи под запрос нет'));
  // Счётчики, а не содержимое: в логе нужен размер проблемы, а не её текст.
  check('утечки и задачи базы — числами',
    got.payload.draft_leaks === 1 && got.payload.kb_tasks === 1);
  check('kind в bot_answered не ставится',
    !('kind' in got.payload));

  // И до колонок таблицы оно доезжает целиком.
  const row = one(got);
  check('строка таблицы: domains заполнены', row.domains === 'allocation');
  check('строка таблицы: тип события', row.event_type === 'bot_answered');
}


// ===================================================================== 30
line('30. Темы формы: четыре текущие, снятые узнаются ради истории');
{
  // Форма сокращена 2026-08-12: восемь тем Cross Data стали четырьмя,
  // а чужая команда переименована — DWH HR → HC Data (ex. DWH HR).
  const head = (t) => one({ event: 'posted', post: post({ message: t }) });

  // Четыре темы, по которым сейчас приходят обращения.
  const now = [
    ['Cross Data | Выгрузка данных от пользователя @A', 'export'],
    ['Cross Data | Вопрос по отчетам от пользователя @A', 'report_question'],
    ['Cross Data | Нет доступа к отчету от пользователя @A', 'report_access'],
    // Заголовок в форме длиннее самой темы, и пояснение в скобках
    // переписывают: сверка идёт по короткому префиксу.
    ['Cross Data | Другое ( Если не нашлось подходящей категории ) от пользователя @A', 'other'],
  ];
  for (const [message, kind] of now) {
    const e = head(message);
    check('тема → ' + kind, e.kind === kind);
    check(kind + ' — наше обращение', e.payload.ours === true);
  }

  // Чужая команда: в свои метрики времени решения не берём.
  const hc = head('Вопрос команде HC Data (ex. DWH HR)');
  check('HC Data — чужая команда', hc.payload.ours === false && hc.kind === 'dwh_hr');
  const hcRep = head('Вопрос команде HC Data (ex. DWH HR) | реплика (prod_v_ods) не актуальна / ...');
  check('реплика HC Data — отдельная тема', hcRep.kind === 'dwh_hr_replica');

  // Переименование команды НЕ раздваивает тему: kind — аналитический ключ,
  // а не подпись в форме. Иначе метрики чужих обращений разъехались бы на
  // «до переименования» и «после».
  check('старое имя команды даёт тот же kind',
    head('Вопрос команде DWH HR').kind === 'dwh_hr' &&
    head('Вопрос команде DWH HR | реплика prod_v_ods').kind === 'dwh_hr_replica');

  // Снятые темы узнаются: по ним есть история, и повторный прогон backfill
  // не должен превращать её в `unknown`.
  for (const [message, kind] of [
    ['Cross Data | Мне только спросить', 'just_ask'],
    ['Cross Data | Вопрос по пользовательским данным в хранилище', 'user_data_question'],
    ['Cross Data | Запрос на подключение к Warden (RLS для HR данных)', 'warden_access'],
  ]) {
    check('снятая тема из истории узнана: ' + kind, head(message).kind === kind);
  }

  // Новая тема, которой нет в списке, не проглатывается молча.
  const fresh = head('Cross Data | Заявка на новую витрину');
  check('незнакомая тема помечена unknown', fresh.kind === 'unknown');
  check('но остаётся нашей по префиксу', fresh.payload.ours === true);
  check('в topic видно, что именно пришло',
    fresh.payload.topic.includes('Заявка на новую витрину'));

  // Список тем живёт в ОДНОМ месте. Бот про темы не знает вовсе: он
  // проверяет префикс, поэтому правка формы его не касается.
  const guard = fs.readFileSync('../bot/build_time_flows.py', 'utf8');
  const prefixes = guard.match(/CHANNEL_PREFIXES = (\[[^\]]*\])/)[1];
  check('бот фильтрует по префиксу, а не по списку тем',
    prefixes.includes('Cross Data |') && !prefixes.includes('Выгрузка'));
}

// ===================================================================== 31
line('31. Разбивка по темам: пересчёт лога в отчёт');
{
  // Ради этого разреза `kind` вообще писался отдельной колонкой. Считать
  // напрямую по колонке нельзя: у реакции темы нет, а оценка приходит
  // из другого канала — обращение собирается по треду.
  const rep = JSON.parse(fs.readFileSync('Telemetry Report.json', 'utf8'));
  const rollupJs = rep.nodes.find((n) => n.name === 'Rollup by topic').parameters.jsCode;
  const NOW = Date.now();
  const H = 3600000;

  // Строки лога — в том виде, в каком их отдаёт таблица: payload строкой.
  const row = (o) => ({ json: {
    event_id: o.event_id ?? Math.random().toString(36),
    thread_id: o.thread_id, event_type: o.event_type,
    event_ts: o.event_ts, ingested_at: o.event_ts,
    actor: o.actor ?? 'u1', source: o.source ?? 'channel',
    kind: o.kind ?? '', domains: '', payload: JSON.stringify(o.payload ?? {}),
  } });

  const rollup = (rows, days = 30) => {
    const items = rows.map(row);
    const out = new Function('$input', '$', rollupJs)(
      { all: () => items },
      () => ({ first: () => ({ json: { days } }) }),
    ).map((x) => x.json);
    return {
      byKind: Object.fromEntries(out.filter((r) => r.kind && !r.is_total && !r.ok)
        .map((r) => [r.kind, r])),
      total: out.find((r) => r.is_total),
      meta: out.find((r) => r.ok !== undefined),
    };
  };

  // Обращение целиком: создано, взято через час, закрыто через пять,
  // бот ответил, человек нажал «помогло».
  const full = [
    { thread_id: 't1', event_type: 'request_created', event_ts: NOW - 10 * H,
      payload: { kind: 'export', ours: true } },
    { thread_id: 't1', event_type: 'taken', event_ts: NOW - 9 * H,
      source: 'reaction', payload: { emoji: 'loading' } },
    { thread_id: 't1', event_type: 'bot_answered', event_ts: NOW - 9.5 * H,
      source: 'core', payload: { confidence_key: 'high' } },
    { thread_id: 't1', event_type: 'closed', event_ts: NOW - 5 * H,
      source: 'reaction', payload: { resolved: true } },
    { thread_id: 't1', event_type: 'bot_feedback', event_ts: NOW - 4 * H,
      source: 'webhook', payload: { kind: 'export', helpful: true } },
    // Второе обращение по той же теме — не закрыто, оценено отрицательно.
    { thread_id: 't2', event_type: 'request_created', event_ts: NOW - 3 * H,
      payload: { kind: 'export', ours: true } },
    { thread_id: 't2', event_type: 'bot_feedback', event_ts: NOW - 2 * H,
      source: 'webhook', payload: { kind: 'export', helpful: false } },
    // Другая тема.
    { thread_id: 't3', event_type: 'request_created', event_ts: NOW - 2 * H,
      payload: { kind: 'report_question', ours: true } },
  ];

  const r = rollup(full);
  check('обращения разложены по темам',
    r.byKind.export.requests === 2 && r.byKind.report_question.requests === 1);
  check('закрытые и открытые считаются раздельно',
    r.byKind.export.closed === 1 && r.byKind.export.open === 1);
  check('оценки склеены с темой обращения',
    r.byKind.export.helpful === 1 && r.byKind.export.not_helpful === 1);
  check('доля «помогло» — из нажатых кнопок', r.byKind.export.helpful_pct === 50);
  // Ноль оценок — это «никто не нажимал», а не «бот всех разочаровал».
  check('без оценок доля пустая, а не ноль',
    r.byKind.report_question.helpful_pct === null);
  check('время реакции — от обращения до :loading:',
    r.byKind.export.reaction_h === 1);
  check('цикл — от обращения до закрывающей реакции',
    r.byKind.export.cycle_h === 5);
  check('итог сходится с суммой тем', r.total.requests === 3);
  check('в отчёте видно, сколько строк прочитано', r.meta.rows_read === full.length);

  // Снятая закрывающая реакция ПЕРЕОТКРЫВАЕТ обращение: там это исправление
  // ошибки, а не часть процесса.
  const reopened = rollup([...full,
    { thread_id: 't1', event_type: 'closed_removed', event_ts: NOW - 1 * H,
      source: 'reaction', payload: { removed: true } }]);
  check('снятие закрывающей реакции переоткрывает', reopened.byKind.export.closed === 0);

  // Обращение старше окна отчёта в разбивку не идёт — но и не пропадает молча.
  const withOld = rollup([...full,
    { thread_id: 't9', event_type: 'request_created', event_ts: NOW - 90 * 24 * H,
      payload: { kind: 'other', ours: true } }]);
  check('старое обращение вне окна не считается', !withOld.byKind.other);
  check('но названо числом', withOld.meta.threads_older === 1);

  // Тред без корневого события: бот отвечает в канал черновиков, а обращение
  // живёт в канале обращений — если коллектор не поймал корень, тема берётся
  // из контекста кнопки, а не теряется.
  const orphan = rollup([
    { thread_id: 't5', event_type: 'bot_feedback', event_ts: NOW - H,
      source: 'webhook', payload: { kind: 'report_access', helpful: true } }]);
  check('тема добирается из оценки, если корня нет',
    orphan.byKind.report_access.requests === 1);

  // Пустой вход — это не «обращений не было», а не сработавшее чтение таблицы.
  check('пустой лог назван, а не показан нулями', rollup([]).meta.ok === false);

  // Отчёт читают люди: таблица собирается готовой.
  const md = rollup(full).meta.markdown;
  check('в отчёте есть markdown-таблица', md.includes('| Тема |'));
  check('темы названы по-человечески', md.includes('Выгрузка данных'));
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 32
line('32. В собранных воркфлоу не осталось плейсхолдеров');
{
  // Живой отказ 2026-08-13: в n8n лежала сборка, у которой URL кнопки был
  // строкой `__FEEDBACK_URL__`. Кнопки при этом рисуются как настоящие,
  // нажимаются и не делают ничего — Mattermost стучится по несуществующему
  // адресу и молчит. Ни ошибки во флоу, ни строки в логе: отказ виден только
  // тем, что «ничего не происходит».
  //
  // Сборщик предупреждает о незаданном URL, но предупреждение печатается
  // в консоль и переживается: собрали, закоммитили, импортировали. Проверка
  // ловит это на файлах — там, где placeholder уже нельзя не заметить.
  //
  // `__rl` ноды resource locator не в счёт: он строчными.
  const PLACEHOLDER = /"[^"]*__[A-Z][A-Z0-9_]*__[^"]*"/;
  const files = [
    ...fs.readdirSync('.').filter((f) => f.endsWith('.json')).map((f) => f),
    ...fs.readdirSync('../bot').filter((f) => f.endsWith('.json')).map((f) => '../bot/' + f),
  ];
  check(`собранных воркфлоу найдено (${files.length})`, files.length >= 8);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const hit = text.match(PLACEHOLDER);
    check(`${f.replace('../', '')} без плейсхолдеров`,
      !hit || `плейсхолдер: ${hit[0].slice(0, 60)}` === '');
  }
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 33
line('33. Flush: текст запроса — экранирование, время, состав колонок');
{
  const flush = JSON.parse(fs.readFileSync('Telemetry Flush.json', 'utf8'));
  const fjs = (n) => {
    const node = flush.nodes.find((x) => x.name === n);
    if (!node) throw new Error(`нет ноды ${n} в Telemetry Flush`);
    return node.parameters.jsCode;
  };
  // Батч собирается в НЕСКОЛЬКО элементов — по одному запросу на чанк.
  const build = (rows) =>
    new Function('$input', fjs('Build batch'))({
      all: () => rows.map((json) => ({ json })),
    }).map((x) => x.json);

  const TS_MS = 1754640000123;
  const row = (i, over = {}) => ({
    event_id: 'posted:p' + i, thread_id: 't' + i,
    event_type: 'request_created', event_ts: TS_MS, ingested_at: TS_MS + i,
    actor: 'u1', source: 'channel', kind: 'export', domains: 'legal',
    payload: JSON.stringify({ q: 'выгрузка за июль' }), ...over,
  });

  // Состав колонок берём из СБОРЩИКА, а не дублируем в тесте: колонка,
  // добавленная в SCHEMA и забытая в запросе, — это тихо не залитые данные.
  const schemaCols = (() => {
    const from = BUILDER.slice(BUILDER.indexOf('SCHEMA = ['));
    const body = from.slice(0, from.indexOf('\n]'));
    return [...body.matchAll(/\("([a-z_]+)",\s*"(?:string|number|boolean)"/g)]
      .map((m) => m[1]);
  })();
  check(`колонок в SCHEMA (${schemaCols.length})`, schemaCols.length >= 10);

  const one = build([row(1)])[0];
  const colList = schemaCols.join(', ');
  check('список колонок запроса совпадает со SCHEMA',
    one.sql.includes(colList));
  check('значения идут в том же порядке, что колонки',
    one.sql.includes("('posted:p1', 't1', 'request_created', CAST("));

  // SQL-инъекция в собственную таблицу: payload несёт сырой текст людей.
  const nasty = build([row(2, {
    payload: JSON.stringify({ q: "it's ok'; DROP TABLE support_telemetry --" }),
  })])[0];
  check('одинарная кавычка удвоена', nasty.sql.includes("it''s ok''; DROP"));
  check('кавычек в запросе чётное число (литералы закрыты)',
    (nasty.sql.match(/'/g) || []).length % 2 === 0);
  check('DROP остался ВНУТРИ литерала, а не стал командой',
    !/;\s*DROP TABLE/i.test(nasty.sql.replace(/'[^']*(?:''[^']*)*'/g, "''")));

  // Миллисекунды: деление на 1000.0, а не на 1000 — иначе тихо обнулятся.
  check('миллисекунды события не потеряны', one.sql.includes(`${TS_MS} / 1000.0`));
  check('время приводится к типу колонки явным CAST',
    /CAST\(from_unixtime\([\d]+ \/ 1000\.0\) AS timestamp\(\d\)\)/.test(one.sql));

  // Пустые поля: у события трекера нет ни kind, ни domains.
  const empty = build([row(3, { kind: undefined, domains: null, actor: '' })])[0];
  check('undefined не уехал в запрос строкой', !empty.sql.includes('undefined'));
  check('null не уехал в запрос строкой', !empty.sql.includes('null,'));
  check('пустое поле стало пустым литералом', empty.sql.includes("'', ''"));

  // Режим записи задаёт и форму запроса, и условие фильтра — согласованность
  // между двумя нодами проверяется здесь, потому что в n8n её ничто не держит.
  const mode = fjs('Build batch').match(/const MODE = '(\w+)'/)[1];
  const cond = flush.nodes.find((x) => x.name === 'Read new events')
    .parameters.filters.conditions[0].condition;
  check(`режим ${mode}`, mode === 'merge' || mode === 'insert');
  if (mode === 'merge') {
    check('MERGE по event_id — прогон идемпотентен',
      one.sql.startsWith('MERGE INTO') && one.sql.includes('ON t.event_id = s.event_id'));
    check('MERGE обновляет все колонки кроме ключа',
      schemaCols.filter((c) => c !== 'event_id')
        .every((c) => one.sql.includes(`${c} = s.${c}`)));
    // gte, а не gt: перезалив краевой строки идемпотентен, зато строка с тем
    // же миллисекундным ingested_at из упавшего чанка не потеряется молча.
    check('фильтр Data Table = gte (не теряет краевую строку)', cond === 'gte');
  } else {
    check('INSERT со списком колонок', one.sql.startsWith('INSERT INTO'));
    // При gte краевая строка дублировалась бы КАЖДЫЙ прогон.
    check('фильтр Data Table = gt (иначе дубль каждый час)', cond === 'gt');
  }
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 34
line('34. Flush: чанкование — лимит запроса Trino накрывает ВЕСЬ батч');
{
  const flush = JSON.parse(fs.readFileSync('Telemetry Flush.json', 'utf8'));
  const code = flush.nodes.find((x) => x.name === 'Build batch').parameters.jsCode;
  const build = (rows) =>
    new Function('$input', code)({ all: () => rows.map((json) => ({ json })) })
      .map((x) => x.json);

  // Лимиты читаются из сборщика: правка константы не должна переживать тест.
  const MAX_ROWS = Number(BUILDER.match(/FLUSH_MAX_ROWS = (\d+)/)[1]);
  const MAX_CHARS = Number(BUILDER.match(/FLUSH_MAX_CHARS = ([\d_]+)/)[1].replace(/_/g, ''));
  // Предел Trino по умолчанию. Ради него всё чанкование и существует.
  const TRINO_LIMIT = 1_000_000;

  const row = (i, over = {}) => ({
    event_id: 'e' + i, thread_id: 't' + i, event_type: 'taken',
    event_ts: 1754640000000 + i, ingested_at: 1754640000000 + i,
    actor: 'u1', source: 'reaction', kind: 'export', domains: '',
    payload: JSON.stringify({ emoji: 'loading' }), ...over,
  });

  const many = build(Array.from({ length: MAX_ROWS * 2 + 25 }, (_, i) => row(i)));
  check(`${MAX_ROWS * 2 + 25} строк разбиты на чанки (${many.length})`,
    many.length === 3);
  check('ни одна строка не потеряна',
    many.reduce((s, c) => s + c.batch_size, 0) === MAX_ROWS * 2 + 25);
  check('чанк не длиннее лимита строк',
    many.every((c) => c.batch_size <= MAX_ROWS));
  check('чанки пронумерованы, и общее число названо',
    many.every((c, i) => c.chunk === i + 1 && c.chunks === many.length));
  check('каждый чанк — самостоятельный запрос',
    many.every((c) => /^(MERGE|INSERT) INTO/.test(c.sql) && c.sql.length < TRINO_LIMIT));

  // Порядок по ingested_at: падение на середине оставляет консистентный
  // префикс, и watermark следующего прогона встаёт ровно на границу залитого.
  // При произвольном порядке провал в середине оставил бы дыру, которую
  // watermark перешагнул бы молча.
  const shuffled = build([row(9, { ingested_at: 900 }), row(1, { ingested_at: 100 }),
    row(5, { ingested_at: 500 })]);
  check('строки идут по возрастанию ingested_at',
    shuffled[0].sql.indexOf("'e1'") < shuffled[0].sql.indexOf("'e5'")
    && shuffled[0].sql.indexOf("'e5'") < shuffled[0].sql.indexOf("'e9'"));

  // Второй лимит — по символам: у выгрузки бывает payload с составом данных
  // и списком полей, и 200 таких строк уже упираются в предел Trino.
  const fat = build(Array.from({ length: 12 }, (_, i) =>
    row(i, { payload: 'x'.repeat(60_000) })));
  check(`длинные payload режутся по символам (${fat.length} чанков)`,
    fat.length > 1);
  check('каждый чанк в пределах символьного лимита',
    fat.every((c) => c.sql.length <= MAX_CHARS || c.batch_size === 1));

  // Строка длиннее лимита целиком: резать её нечем. Уезжает своим чанком,
  // и Trino отработает громко — молча выбросить её нельзя, событие пропало бы
  // навсегда, потому что watermark его перешагнёт.
  const huge = build([row(1), row(2, { payload: 'y'.repeat(MAX_CHARS + 5000) }), row(3)]);
  check('аномально длинная строка не выброшена',
    huge.some((c) => c.sql.includes("'e2'")));
  check('она уехала отдельным чанком',
    huge.find((c) => c.sql.includes("'e2'")).batch_size === 1);
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 35
line('35. Flush: дубли, пустой батч и watermark — три способа испортить витрину');
{
  const flush = JSON.parse(fs.readFileSync('Telemetry Flush.json', 'utf8'));
  const fjs = (n) => flush.nodes.find((x) => x.name === n).parameters.jsCode;
  const build = (rows) =>
    new Function('$input', fjs('Build batch'))({ all: () => rows.map((json) => ({ json })) })
      .map((x) => x.json);
  const wm = (items) =>
    new Function('$input', fjs('Read watermark'))({ all: () => items })[0].json;

  const row = (over = {}) => ({
    event_id: 'posted:p1', thread_id: 't1', event_type: 'request_created',
    event_ts: 1754640000000, ingested_at: 1754640000000,
    actor: 'u1', source: 'channel', kind: 'export', domains: '',
    payload: '{}', ...over,
  });

  // Пустой батч — норма (за час ничего не произошло), но он обязан отличаться
  // от «данные есть, а запрос пуст»: ветка IF уводит его в никуда.
  const none = build([]);
  check('пустой батч помечен, а не отдан пустым запросом',
    none.length === 1 && none[0].empty === true && none[0].chunks === 0);
  const ifNode = flush.nodes.find((x) => x.name === 'Any new rows');
  const falseBranch = flush.connections['Any new rows'].main[1];
  check('ложная ветка IF никуда не ведёт', Array.isArray(falseBranch) && falseBranch.length === 0);
  check('IF проверяет именно empty',
    JSON.stringify(ifNode.parameters).includes('$json.empty'));

  // Дубль event_id в Data Tables возможен только если условие upsert
  // в `Write event` не сработало (его имена параметров не подтверждены живым
  // узлом). Для MERGE это ошибка Trino «несколько строк источника на одну
  // строку цели» — падение всего прогона из-за пары строк.
  const dup = build([row({ ingested_at: 100, kind: 'export' }),
    row({ ingested_at: 200, kind: 'report_question' })]);
  check('дубль event_id схлопнут в одну строку', dup[0].batch_size === 1);
  check('оставлена последняя запись', dup[0].sql.includes("'report_question'"));
  check('число схлопнутых НАЗВАНО (сигнал о неработающем upsert)',
    dup[0].duplicates_collapsed === 1);

  // Строка без event_id: ключа для MERGE нет, все такие строки склеились бы
  // в одну. Не заливаем — но называем, иначе пропажа была бы невидимой.
  const noId = build([row(), row({ event_id: '' })]);
  check('строка без event_id не попала в запрос', noId[0].batch_size === 1);
  check('и она названа числом', noId[0].rows_without_id === 1);

  // Watermark. Форма ответа ноды CUSTOM.trino не подтверждена живым прогоном,
  // поэтому разбор терпим к форме — и НЕ терпим к её отсутствию.
  check('плоский ответ', wm([{ json: { wm_ms: 1754640000000 } }]).wm_ms === 1754640000000);
  check('ответ строкой приводится к числу', wm([{ json: { wm_ms: '1754640000000' } }]).wm_ms === 1754640000000);
  check('ответ в data[]', wm([{ json: { data: [{ wm_ms: 42 }] } }]).wm_ms === 42);
  check('ответ массивом строк', wm([{ json: { rows: [[42]] } }]).wm_ms === 42);
  check('пустая таблица даёт 0, а не ошибку', wm([{ json: { wm_ms: 0 } }]).wm_ms === 0);

  // 0 по умолчанию — это перезалив всей истории каждый час (merge) или дубли
  // всей истории (insert). Пустое значение — тихо не доезжающая телеметрия.
  // Единственный честный вариант на нераспознанной форме — падение.
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('нераспознанная форма роняет прогон, а не даёт 0',
    throws(() => wm([{ json: { rowCount: 1, message: 'ok' } }])));
  check('пустой ответ ноды роняет прогон', throws(() => wm([])));

  // Проводка: обе ноды Trino должны нести credential, иначе анонимный запрос
  // вернёт ошибку авторизации — а на watermark это выглядело бы как отказ
  // всего прогона без объяснения.
  const trino = flush.nodes.filter((x) => x.type === 'CUSTOM.trino');
  check(`нод Trino две (${trino.length})`, trino.length === 2);
  check('у обеих задан credential trinoApi',
    trino.every((n) => n.credentials && n.credentials.trinoApi));
  check('watermark читается ДО чтения таблицы',
    JSON.stringify(flush.connections['Watermark']).includes('Read watermark'));
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 36
line('36. Витрина support_request.sql знает про КАЖДЫЙ тип события лога');
{
  // Тихо не учтённый тип события неотличим от несуществующего: метрика
  // просто не считается, а запрос при этом зелёный. Поэтому список типов
  // берётся из СБОРЩИКА, а не из головы, и новый тип ломает тест.
  const SQL = fs.readFileSync('support_request.sql', 'utf8');

  const types = new Set();
  for (const re of [/event_type: '([a-z_]+)'/g, /event: '([a-z_]+)'/g,
                    /event === '([a-z_]+)'/g]) {
    for (const m of BUILDER.matchAll(re)) types.add(m[1]);
  }
  // Реакции дают тип динамически: kind из EMOJI плюс суффикс снятия.
  const emoji = BUILDER.slice(BUILDER.indexOf('EMOJI = {'),
                              BUILDER.indexOf('CURRENT_TOPICS = ['));
  for (const m of emoji.matchAll(/"kind": "([a-z_]+)"/g)) {
    types.add(m[1]);
    types.add(m[1] + '_removed');
  }
  // `posted` — имя события Mattermost, в лог таким не попадает.
  types.delete('posted');

  check(`типов событий в сборщике (${types.size})`, types.size >= 12);
  for (const t of [...types].sort()) {
    // Учтён = упомянут в файле витрины: либо в запросе, либо в блоке
    // «события, которые витрина не использует» с причиной.
    check(`${t} учтён в витрине`, SQL.includes(`'${t}'`) || SQL.includes(`\`${t}\``));
  }

  // Структурные свойства, каждое — уже сломанная однажды метрика.
  check('строки-примеры CSV исключены', SQL.includes("<> 'schema_sample'"));
  check('дедуп по event_id есть (нужен в режиме insert)',
    /ROW_NUMBER\(\) OVER \(PARTITION BY event_id/.test(SQL));
  // Сравнение с ПОРОГОМ, а не с точной полночью: from_unixtime в Trino отдаёт
  // время в тайм-зоне сессии, а ноды Flush ставят Europe/Moscow — ноль
  // приезжает как 1970-01-01 03:00:00, и точное равенство мимо него
  // промахивалось. «Времени не было» становилось настоящей датой 1970 года,
  // и reaction time уезжал в минус 56 лет — ровно то, что этот guard
  // и заведён предотвращать.
  check('event_ts = 0 превращается в NULL, а не в 1970 год',
    /event_ts < TIMESTAMP '2000-01-01 00:00:00' THEN NULL/.test(SQL));
  check('и порог не привязан к полуночи 1970',
    !SQL.includes("NULLIF(event_ts, TIMESTAMP '1970-01-01 00:00:00')"));
  check('обращение = тред с request_created',
    /FROM ev\s+WHERE event_type = 'request_created'/.test(SQL));
  check('отсев тредов без корня НАЗВАН числом',
    SQL.includes('threads_without_root'));
  check('p85 считается, а не только медиана', SQL.includes('0.85'));
  check('чужие обращения (ours=false) исключены из метрик, а не удалены',
    SQL.includes('WHERE ours'));
  check('калибровка считается по паре заявлено/действует',
    SQL.includes('confidence_claimed') && SQL.includes('confidence_key'));
  check('lead и cycle time считаются отдельно (разница = очередь)',
    SQL.includes('lead_time_sec') && SQL.includes('cycle_time_sec'));

  // Имена полей payload, от которых зависит витрина, живут в сборщиках —
  // причём в ДВУХ: события канала и трекера собирает телеметрия, а поля
  // ответа бота (`confidence_claimed`, `confidence_key`) приходят из ядра,
  // то есть из сборщика бота. Переименуют там — здесь останется NULL,
  // и это надо ловить тестом, а не по пустой колонке в дашборде через месяц.
  const BUILDERS = BUILDER + fs.readFileSync('../bot/build_time_flows.py', 'utf8');
  for (const field of ['confidence_claimed', 'confidence_key', 'task_created_at',
                       'task_finished_at', 'is_final', 'resolved', 'event_inferred',
                       'helpful', 'ours', 'topic', 'permalink', 'task_key']) {
    check(`поле payload ${field} есть и в сборщике, и в витрине`,
      BUILDERS.includes(field) && SQL.includes(`'$.${field}'`));
  }
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 37
line('37. Витрина знает про КАЖДОЕ поле ответа бота — или называет, почему нет');
{
  // Обратное направление теста 36. Тот держит «витрина не считает по типу
  // события, которого нет в сборщике»; этот — «ядро посчитало поле, а
  // посмотреть на него негде». Отказ ровно такой же тихий: колонки в
  // дашборде просто не появляется, и по виду и лога, и витрины всё в порядке.
  // Так уже вышло с dd_received, dd_never_ran и router_empty: код считал их
  // неделями, витрина не читала ни одного.
  const SQL = fs.readFileSync('support_request.sql', 'utf8');
  const CORE = JSON.parse(fs.readFileSync('../bot/Support Bot Core.json', 'utf8'));
  const parse = CORE.nodes.find((n) => n.name === 'Parse answer');
  check('нода разбора ответа найдена', Boolean(parse));
  // Отступ в начале строки обязателен в шаблоне: часть присваиваний стоит
  // внутри блоков `{ … }`, и якорь строго по началу строки их не видел —
  // experts_invented и draft_own_tools проскакивали мимо теста, то есть
  // проверка «ни одно поле не потеряно» сама теряла поля.
  const fields = [...new Set(
    [...parse.parameters.jsCode.matchAll(/^\s*out\.([a-z_0-9]+)\s*=/gm)].map((m) => m[1]),
  )].sort();
  check(`полей на выходе ядра (${fields.length})`, fields.length >= 25);
  // Прочитано витриной = есть json_extract по этому ключу. Названо
  // не используемым = упомянуто в блоке «ПОЛЯ ОТВЕТА БОТА, КОТОРЫЕ ВИТРИНА
  // НЕ ИСПОЛЬЗУЕТ» с причиной.
  const skipAt = SQL.indexOf('ПОЛЯ ОТВЕТА БОТА, КОТОРЫЕ ВИТРИНА НЕ ИСПОЛЬЗУЕТ');
  check('блок неиспользуемых полей есть', skipAt !== -1);
  const skipBlock = skipAt === -1 ? '' : SQL.slice(skipAt, SQL.indexOf('-- Ответ бота.', skipAt));
  // Имена в блоке берутся из левой колонки «поле — причина», а не поиском
  // подстроки по всему блоку: имя, упомянутое в ЧУЖОЙ причине, объявлением
  // не является, иначе блок начнёт покрывать поля, про которые в нём
  // ничего не сказано.
  const named = new Set();
  for (const m of skipBlock.matchAll(/^--\s{2,}([a-z_0-9]+(?:,\s*[a-z_0-9]+)*)\s+—/gm)) {
    for (const n of m[1].split(',')) named.add(n.trim());
  }
  check('в блоке перечислены поля', named.size > 0);
  for (const f of fields) {
    // Поле может читаться и из payload, и из колонки лога наверху таблицы —
    // `domains` вынесен колонкой, потому что по нему группируется витрина.
    const used = SQL.includes(`'$.${f}'`) ||
      new RegExp(`max_by\\(${f},`).test(SQL);
    check(`${f}: ${used ? 'в витрине' : named.has(f) ? 'назван неиспользуемым' : 'ПОТЕРЯН'}`,
      used || named.has(f));
  }
}

// ===================================================================== 38
line('38. Витрина сравнивает уверенность с теми значениями, что пишет ядро');
{
  // Ядро приводит уверенность к английским ключам (high / medium / none /
  // unknown), а по-русски она печатается только в сообщении джуну. Витрина
  // сравнивала со словом «высокая» — совпадение невозможно НИКОГДА, то есть
  // калибровка, названная в проекте самой ценной метрикой, считала ноль
  // и выглядела при этом рабочей: колонка есть, запрос зелёный, в ней 0.
  //
  // Отказ того же класса, что ловят тесты 36 и 37, только по ЗНАЧЕНИЯМ,
  // а не по именам полей. Поэтому список берётся из сборщика ядра.
  const SQL = fs.readFileSync('support_request.sql', 'utf8');
  const CORE = fs.readFileSync('../bot/build_time_flows.py', 'utf8');
  const at = CORE.indexOf('out.confidence_claimed =');
  check('присваивание уверенности найдено в сборщике', at !== -1);
  // Берём ВСЕ строковые литералы выражения до точки с запятой, а не только
  // те, что стоят перед двоеточием: последнее значение — фолбэк 'unknown',
  // и он записан без двоеточия. Проверка, которая его теряет, разрешила бы
  // витрине сравнивать с чем угодно и назвать это «ключом ядра».
  const expr = CORE.slice(at, at + CORE.slice(at).indexOf(';'));
  const keys = [...new Set([...expr.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))];
  check(`ключей уверенности (${keys.join(', ')})`, keys.length >= 3);
  // Каждое значение, с которым витрина сравнивает уверенность, обязано быть
  // ключом из сборщика — иначе счётчик тихо считает ноль.
  const compared = [...new Set(
    [...SQL.matchAll(/confidence_(?:claimed|key)\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  )];
  check(`витрина сравнивает со значениями (${compared.join(', ')})`, compared.length > 0);
  for (const v of compared) {
    check(`значение '${v}' есть среди ключей ядра`, keys.includes(v));
  }
}

// ===================================================================== 39
line('39. Засев истории: обрыв на первой странице НАЗЫВАЕТСЯ');
{
  // GET /channels/{id}/posts отдаёт per_page постов и ссылки на соседние
  // страницы, а Backfill делает ОДИН запрос. Молча это читается как
  // «в канале было 200 постов»: засев обрывается на новейших, метрик
  // за ранние месяцы просто нет, а прогон по виду успешный.
  const bfFlow = JSON.parse(fs.readFileSync('Telemetry Backfill.json', 'utf8'));
  const exNode = bfFlow.nodes.find((n) => n.name === 'Explode posts');
  const explode = (input) =>
    new Function('$json', exNode.parameters.jsCode)(input).map((x) => x.json);

  const full = {};
  const order = [];
  for (let i = 0; i < 200; i++) {
    const id = `p${i}`;
    full[id] = { id, message: 'x', create_at: 1000 + i, user_id: 'u' };
    order.push(id);
  }
  const truncated = explode({ posts: full, order });
  const marks = truncated.filter((x) => x.event === 'backfill_truncated');
  check('обрыв страницы назван событием', marks.length === 1);
  check('и назван самый старый пост страницы',
    marks[0] && marks[0].data.oldest_post_id === 'p199');
  check('посты при этом не потеряны',
    truncated.filter((x) => x.event === 'posted').length === 200);

  // Неполная страница — история кончилась, событию взяться неоткуда.
  const short = {};
  for (let i = 0; i < 5; i++) short[`q${i}`] = { id: `q${i}`, message: 'x', create_at: 1 };
  const done = explode({ posts: short, order: Object.keys(short) });
  check('на неполной странице тревоги нет',
    !done.some((x) => x.event === 'backfill_truncated'));

  // Ссылка на следующую страницу — второй признак, независимый от лимита.
  const linked = explode({ posts: short, order: Object.keys(short), next_post_id: 'q9' });
  check('ссылка на следующую страницу тоже считается обрывом',
    linked.some((x) => x.event === 'backfill_truncated'));

  // Лимит в ноде и лимит в коде — одно число: две копии разъехались бы
  // молча, и признак перестал бы срабатывать ровно тогда, когда лимит подняли.
  const period = bfFlow.nodes.find((n) => n.name === 'Period');
  const perPage = period.parameters.assignments.assignments
    .find((a) => a.name === 'per_page').value;
  const code = exNode.parameters.jsCode;
  check(`лимит ноды (${perPage}) вписан в код`,
    new RegExp(`perPage = ${perPage};`).test(code));
  // И поле для докрутки страницы должно реально уходить в запрос.
  const get = bfFlow.nodes.find((n) => n.name === 'Get posts');
  check('поле before уходит в запрос',
    get.parameters.queryParameters.parameters.some((q) => q.name === 'before'));
}

// ===================================================================== 40
line('40. Коллектор трекера читает СВОИ же события, а не только чужие');
{
  // `task_linked` пишется из канала (source: 'channel'), а
  // `task_status_changed` — из самого трекера (source: 'tracker'). Фильтр
  // `source eq "channel"` пропускал первые и отсекал вторые, то есть узел
  // не видел НИ ОДНОГО уже записанного статуса. Следствий два, оба тихие:
  //   — закрытые задачи опрашивались вечно и упирались в потолок 200;
  //   — «Diff statuses» видел каждый статус как изменившийся и писал
  //     событие на задачу каждые 15 минут. Ровно то, что комментарий
  //     в самой ноде обещает не допускать.
  const tr = JSON.parse(fs.readFileSync('Telemetry Collector Tracker.json', 'utf8'));
  const read = tr.nodes.find((n) => n.name === 'Read log');
  const conds = ((read.parameters.filters || {}).conditions) || [];
  check('лог не фильтруется по source',
    !conds.some((c) => c.keyName === 'source'));
  // Без returnAll Data Tables молча вернёт первые N строк — а «первые N»
  // лога это самые старые события, где актуальных задач может не быть вовсе.
  check('лог читается целиком', read.parameters.returnAll === true);

  // Прогон самой ноды: статус из лога должен доехать до плана, иначе
  // «Diff statuses» посчитает его изменившимся.
  const keys = tr.nodes.find((n) => n.name === 'Collect task keys');
  const rows = [
    { event_type: 'task_linked', thread_id: 't1',
      payload: JSON.stringify({ task_key: 'CROSS-1' }), source: 'channel' },
    { event_type: 'task_linked', thread_id: 't2',
      payload: JSON.stringify({ task_key: 'CROSS-2' }), source: 'channel' },
    { event_type: 'task_status_changed', thread_id: 't1',
      payload: JSON.stringify({ task_key: 'CROSS-1', status: 'В работе' }),
      source: 'tracker' },
    { event_type: 'task_status_changed', thread_id: 't2',
      payload: JSON.stringify({ task_key: 'CROSS-2', status: 'Done', is_final: true }),
      source: 'tracker' },
  ];
  const plan = new Function('$input',
    keys.parameters.jsCode)({ all: () => rows.map((json) => ({ json })) })[0].json;
  check('известный статус доехал до плана', plan.known['CROSS-1'] === 'В работе');
  check('закрытая задача больше не опрашивается', !plan.keys.includes('CROSS-2'));
  check('открытая опрашивается', plan.keys.includes('CROSS-1'));
}

// ===================================================================== 41
line('41. Отчёт по темам: посчитанное ДОЕЗЖАЕТ до вывода');
{
  // REPORT_ROLLUP_JS накапливал по треду реплики и заявленную уверенность,
  // и ни одно из этих полей не попадало ни в bucket, ни в вывод, ни
  // в markdown: считалось, а посмотреть было негде. Тот же класс, что поля
  // ядра, которых не читала витрина.
  const rp = JSON.parse(fs.readFileSync('Telemetry Report.json', 'utf8'));
  const roll = rp.nodes.find((n) => n.parameters.jsCode &&
    n.parameters.jsCode.includes('TOPIC_TITLES'));
  check('нода разбивки найдена', Boolean(roll));
  const now = Date.now();
  const mkRow = (o) => ({ json: {
    event_id: o.event_id ?? Math.random().toString(36),
    thread_id: o.thread_id, event_type: o.event_type,
    event_ts: o.event_ts, ingested_at: o.event_ts,
    actor: o.actor ?? 'u1', source: o.source ?? 'channel',
    kind: o.kind ?? '', domains: '', payload: JSON.stringify(o.payload ?? {}),
  } });
  const rows = [
    { event_type: 'request_created', thread_id: 't1', event_ts: now,
      kind: 'export', payload: { ours: true } },
    { event_type: 'bot_answered', thread_id: 't1', event_ts: now + 10,
      source: 'core', payload: { confidence_key: 'high' } },
    { event_type: 'human_replied', thread_id: 't1', event_ts: now + 20, actor: 'u1' },
    { event_type: 'human_replied', thread_id: 't1', event_ts: now + 30, actor: 'u2' },
  ].map(mkRow);
  const out = new Function('$input', '$', roll.parameters.jsCode)(
    { all: () => rows }, () => ({ first: () => ({ json: { days: 30 } }) }),
  ).map((x) => x.json);
  // Тема берётся с корневого события: у него своя колонка kind, и она
  // здесь 'unknown' только потому, что тестовый корень её не несёт.
  // Проверяем ту строку, что собралась, — важны накопленные поля.
  const bucket = out.find((r) => r.kind && r.kind !== 'ИТОГО');
  check('строка темы собрана', Boolean(bucket));
  check('реплики людей доехали до вывода', bucket.replies_human === 2);
  // Уверенность здесь ДЕЙСТВУЮЩАЯ (confidence_key), а не заявленная:
  // пара «заявлено / действует» живёт в витрине, и путать их нельзя.
  check('действующая уверенность доехала', bucket.conf_high === 1);
  const md = out.find((r) => typeof r.markdown === 'string');
  check('и попали в markdown-таблицу',
    md && md.markdown.includes('Реплик') && md.markdown.includes('Высокая'));
  const total = out.find((r) => r.kind === 'ИТОГО');
  check('итог их суммирует', total && total.replies_human === 2 && total.conf_high === 1);
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(fails ? 1 : 0);
