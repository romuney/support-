// Прогон Code-нод ядра и адаптеров на подставных ответах агента.
// Проверяет: разбор четырёх блоков, отсутствующие и необязательные блоки,
// сломанный формат, слово-ярлык внутри черновика, сборку сообщений
// для канала джуна, чата и лички.
//
// Запуск: node test_adapters.mjs
import fs from 'fs';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const js = (wf, n) => {
  const node = wf.nodes.find((x) => x.name === n);
  if (!node) throw new Error(`нет ноды ${n} в ${wf.name}`);
  return node.parameters.jsCode;
};

const core = load('Support Bot Core.json');
const channel = load('Adapter Channel.json');
const chat = load('Adapter Chat.json');
const dm = load('Adapter DM.json');

// Настоящий реестр: проверка «домен формы не покрыт» должна ломаться, когда
// таблица «Домены» в kb/index.md изменится, а не только когда изменится код.
// База знаний лежит уровнем выше и в двух возможных местах — см. тот же
// резолв в test_pipeline.mjs.
const REGISTRY_PATHS = ['../executive-support/kb/index.md', '../kb/index.md'];
const REGISTRY_AT = REGISTRY_PATHS.find((p) => fs.existsSync(p));
if (!REGISTRY_AT) {
  console.error('не найден реестр базы знаний, искали: ' + REGISTRY_PATHS.join(', '));
  process.exit(1);
}
const REGISTRY = fs.readFileSync(REGISTRY_AT, 'utf8');

// --- Parse answer: на входе выход агента, на выходе структура.
// plan — выход ноды Plan: оттуда берётся доменная разбивка для телеметрии.
// mat  — выход Build materials: факты, по которым код ПОНИЖАЕТ заявленную
//        моделью уверенность. По умолчанию материалы есть и всё сошлось —
//        иначе каждая старая проверка разбора блоков ловила бы понижение.
// registry — текст kb/index.md: по нему проверяется, покрыт ли домен формы.
const MAT_OK = {
  has_materials: true,
  masters_only: false,
  asks_report: false,
  report_seen: false,
  articles_read: ['kb/metrics/turnover.md'],
  articles_failed: [],
  dd_objects: [],
  dd_failed: [],
  router_picked: ['kb/metrics/turnover.md'],
};

function runParse(
  output,
  inputs = { question: 'вопрос', mode: 'channel' },
  plan = {},
  mat = MAT_OK,
  registry = REGISTRY,
) {
  const $ = (name) => {
    if (name === 'When called by adapter') return { first: () => ({ json: inputs }) };
    if (name === 'Plan') return { first: () => ({ json: plan }) };
    if (name === 'Build materials') return { first: () => ({ json: mat }) };
    if (name === 'Decode registry') return { first: () => ({ json: { full: registry } }) };
    throw new Error('node not executed: ' + name);
  };
  // AI Agent отдаёт { output: '...' } — парсер читает именно это поле.
  const fn = new Function('$', '$json', js(core, 'Parse answer'));
  return fn($, { output })[0].json;
}

// --- Канал джуна: шапка в канал + ответы в тред к ней.
//
// Сборщиков теперь два, и проверяются они по отдельности: «Build header» даёт
// ровно один короткий пост (строка обращения в канале), «Build thread» — посты
// в тред к нему. Ради этого разделения всё и делалось: канал должен читаться
// списком обращений, а не полотном из трёх постов на каждое.
//
// Сборщики возвращают НЕСКОЛЬКО элементов, если текст не влезает в лимит поста
// Mattermost (4000 символов): нода отправляет по посту на элемент. Хелперы
// с суффиксом Parts отдают элементы, обычные — склеенный текст, чтобы проверки
// содержания не зависели от разбивки.
const channelCtx = (post, channelName, guard) => (name) => {
  if (name === 'Guard channel')
    return { first: () => ({ json: { post, channel_name: channelName, ...guard } }) };
  throw new Error('node not executed: ' + name);
};

function runChannelHead(parsed, post = {}, channelName = 'hr-report-ask', guard = {}) {
  const items = new Function('$', '$json', js(channel, 'Build header'))(
    channelCtx(post, channelName, guard), parsed);
  if (items.length !== 1) throw new Error('шапка должна быть одним постом');
  return items[0].json.text;
}

// Вход «Build thread» — ответ Mattermost на публикацию шапки, поэтому разбор
// он берёт у ядра по имени ноды, а не из $json.
function runChannelParts(parsed, post = {}, channelName = 'hr-report-ask', guard = {}) {
  const $ = (name) => {
    if (name === 'Call core') return { first: () => ({ json: parsed }) };
    return channelCtx(post, channelName, guard)(name);
  };
  return new Function('$', '$json', js(channel, 'Build thread'))($, { id: 'root1' })
    .map((i) => i.json.text);
}
// Весь ответ по обращению: шапка плюс тред. Проверки содержания смотрят сюда,
// чтобы не зависеть от того, в каком именно посте оказалась строка.
const runChannelMsg = (...a) => [runChannelHead(...a), ...runChannelParts(...a)].join('\n');

function runChatMsg(parsed) {
  return new Function('$json', js(chat, 'Build reply'))(parsed)[0].json.output;
}

const runDmParts = (parsed) =>
  new Function('$json', js(dm, 'Build DM reply'))(parsed).map((i) => i.json.text);
const runDmMsg = (parsed) => runDmParts(parsed).join('\n');

function runDmLogParts(parsed) {
  const $ = (name) => {
    if (name === 'Call core') return { first: () => ({ json: parsed }) };
    throw new Error('node not executed: ' + name);
  };
  return new Function('$', js(dm, 'Build DM log'))($).map((i) => i.json.text);
}
const runDmLog = (parsed) => runDmLogParts(parsed).join('\n');

// --- Guard: прогон Code-ноды отсева на событии Time.
// Проверяется поведением, а не поиском подстроки в параметрах: прежний
// IF-фильтр содержал и префикс, и root_id, и всё равно пропускал в живом
// канале каждую реплику — при `post` в виде JSON-строки условия читали
// undefined и проходили. Такой отказ виден только прогоном.
function runGuard(wf, name, event) {
  return new Function('$json', js(wf, name))(event)[0].json;
}
const guardChannel = (event) => runGuard(channel, 'Guard channel', event);
const guardDm = (event) => runGuard(dm, 'Guard DM', event);

let fails = 0;
function check(label, cond) {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}
const line = (t) => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

// ====================================================================== 1
line('1. Полный ответ из четырёх блоков');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Численность считается по legal_employee_flg = 1
на дату business_dt.
ИСТОЧНИКИ: kb/metrics/legal-headcount.md
Data Detective: mdm_employee_structure_d
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи в kb/metrics/ с определением ССЧ`);
  check('черновик без ярлыка', p.draft.startsWith('Численность считается'));
  check('черновик многострочный', p.draft.includes('на дату business_dt'));
  check('черновик не съел ИСТОЧНИКИ', !p.draft.includes('kb/metrics'));
  check('источники двумя строками', p.sources.includes('legal-headcount') && p.sources.includes('Data Detective'));
  check('уверенность medium', p.confidence_key === 'medium');
  check('пробел записан', p.gaps.includes('ССЧ'));
  check('нет ошибки разбора', p.parse_error === '');
}

// ====================================================================== 2
line('2. Высокая уверенность, необязательные блоки опущены');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Чеклист согласования выгрузки: цель, гранулярность, период.
ИСТОЧНИКИ: kb/process/export-playbook.md
УВЕРЕННОСТЬ: высокая`);
  check('уверенность high', p.confidence_key === 'high');
  check('пробелов нет', p.gaps === '');
  check('нет ошибки разбора', p.parse_error === '');
}

// ====================================================================== 3
line('3. Нет ответа: прочерк в ИСТОЧНИКАХ не тащим дальше');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Вопрос не задан
ИСТОЧНИКИ: —
УВЕРЕННОСТЬ: нет ответа
ЧЕГО НЕ ХВАТИЛО: вопрос не сформулирован`);
  check('уверенность none', p.confidence_key === 'none');
  check('прочерк вычищен', p.sources === '');
  check('пробел сохранён', p.gaps.includes('не сформулирован'));
}

// ====================================================================== 4
line('4. Слово-ярлык внутри черновика не разрезает блок');
{
  // Модель вполне может написать «источники» в тексте ответа. Разрез должен
  // происходить только по ярлыку с начала строки.
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Уточни у заказчика источники данных: нужна
юридическая или управленческая численность.
ИСТОЧНИКИ: kb/recipes/structure-choice.md
УВЕРЕННОСТЬ: высокая`);
  check('черновик целиком', p.draft.includes('юридическая или управленческая'));
  check('источники только настоящие', p.sources === 'kb/recipes/structure-choice.md');
}

// ====================================================================== 5
line('5. Формат сломан целиком — отдаём сырой текст, а не пустоту');
{
  const p = runParse('Привет! Численность считается по флагу legal_employee_flg.');
  check('текст не потерян', p.draft.includes('legal_employee_flg'));
  check('ошибка разбора названа', /не найдено ни одного блока/.test(p.parse_error));
  check('уверенность unknown', p.confidence_key === 'unknown');
}

// ====================================================================== 6
line('6. Пустой ответ агента');
{
  const p = runParse('');
  check('черновик пуст', p.draft === '');
  check('ошибка разбора названа', p.parse_error !== '');
}

// ====================================================================== 7
line('7. Блоки в другом порядке и с лишними пробелами');
{
  const p = runParse(`  УВЕРЕННОСТЬ :  средняя
ЧЕРНОВИК ОТВЕТА:  Стаж в атрибуте считается через gaps & islands.
ИСТОЧНИКИ:  kb/recipes/attribute-tenure.md`);
  check('черновик найден', p.draft.startsWith('Стаж в атрибуте'));
  check('уверенность medium', p.confidence_key === 'medium');
  check('источники найдены', p.sources.includes('attribute-tenure'));
}

// ====================================================================== 8
line('8. Канал джуна: шапка обращения и разбор в треде');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Возьми legal_position_d, там несколько оформлений на человека.
ИСТОЧНИКИ: kb/tables/legal-position-d.md
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи про management_position_d`, {
    question: 'сколько людей оформлено в юните?',
    mode: 'channel',
  });
  const args = [
    p,
    { id: '18hwrdmk6bstf8n8pp8pswxbd1', message: 'сколько людей оформлено в юните?' },
    'hr-report-ask',
    { topic_kind: 'Вопрос по отчетам', form_author: 'Anna Sokolova',
      question_text: 'сколько людей оформлено в юните?' },
  ];
  const head = runChannelHead(...args);
  const msg = runChannelMsg(...args);
  console.log(head + '\n---\n' + runChannelParts(...args).join('\n---\n'));

  // Шапка — то, что видно в канале не разворачивая тред. В ней ровно четыре
  // вещи: светофор, чьё обращение, о чём и куда идти. Всё остальное — в тред.
  check('светофор у средней — жёлтый', head.startsWith('🟡'));
  check('тема из формы в шапке', head.includes('Вопрос по отчетам'));
  check('автор из формы в шапке', head.includes('@Anna Sokolova'));
  check('ссылка на обращение', head.includes('time.tbank.ru/tinkoff/pl/18hwrdmk6bstf8n8pp8pswxbd1'));
  check('уверенность по-русски', head.includes('Уверенность: **средняя**'));
  check('краткая тема в шапке', head.includes('сколько людей оформлено'));
  check('шапка короткая', head.length < 400);
  // Ради чего разделение: в канале не должно быть ни черновика, ни разбора.
  check('в шапке нет черновика', !head.includes('legal_position_d'));
  check('в шапке нет источников', !head.includes('kb/tables/'));

  check('черновик есть', msg.includes('legal_position_d'));
  check('источники есть', msg.includes('kb/tables/legal-position-d.md'));
  check('пробел есть', msg.includes('management_position_d'));
  // Обращение НЕ цитируется целиком: цитата всего поста формы была чистым
  // дублированием — именно она разгоняла посты к лимиту 4000 символов.
  check('вопрос НЕ процитирован целиком', !msg.includes('> сколько людей оформлено'));
  // Уверенность не понижена — значит и строки «← бот заявил» быть не должно:
  // в обычном случае это шум.
  check('нет пометки о понижении', !msg.includes('бот заявил'));
  check('основание напечатано', msg.includes('Основание:'));
}

// ====================================================================== 9
line('9. Канал джуна: пост без id — ссылки нет, но сообщение собирается');
{
  const p = runParse('ЧЕРНОВИК ОТВЕТА: Ответ\nУВЕРЕННОСТЬ: высокая');
  const msg = runChannelMsg(p, {});
  check('нет битой ссылки', !msg.includes('открыть обращение'));
  check('черновик на месте', msg.includes('Ответ'));
  check('светофор у высокой — зелёный', runChannelHead(p, {}).startsWith('🟢'));
  const none = runParse('ЧЕРНОВИК ОТВЕТА: Ответа нет\nУВЕРЕННОСТЬ: нет ответа');
  check('светофор у «нет ответа» — красный', runChannelHead(none, {}).startsWith('🔴'));
  // Модель отклонилась от формата — это не «посередине», а «непонятно»,
  // и цвет должен отличаться от жёлтого, иначе сигнал теряется.
  const broken = runParse('Просто текст без блоков');
  check('светофор у сломанного формата — белый', runChannelHead(broken, {}).startsWith('⚪'));
}

// ====================================================================== 10
line('10. Личка: без путей kb/, без DD, со строкой уверенности');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Численность в этом разрезе считается по управленческой структуре.
ИСТОЧНИКИ: kb/metrics/active-headcount.md
Data Detective: mdm_employee_structure_d
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи про ССЧ`);
  const msg = runDmMsg(p);
  console.log(msg);
  check('черновик есть', msg.includes('управленческой структуре'));
  check('нет путей kb/', !msg.includes('kb/'));
  check('нет Data Detective', !/Data Detective|DD\b/.test(msg));
  check('нет блока «чего не хватило»', !msg.includes('ССЧ'));
  check('предупреждение об уверенности', msg.includes('Уверенность средняя'));
}

// ====================================================================== 11
line('11. Личка: высокая уверенность — без предупреждения');
{
  const p = runParse('ЧЕРНОВИК ОТВЕТА: Готовый чеклист выгрузки.\nУВЕРЕННОСТЬ: высокая');
  const msg = runDmMsg(p);
  check('предупреждения нет', !msg.includes('⚠️'));
  check('черновик есть', msg.includes('чеклист'));
}

// ====================================================================== 12
line('12. Личка: нет ответа — честно отправляем к людям');
{
  const p = runParse('ЧЕРНОВИК ОТВЕТА: В базе знаний ответа нет.\nУВЕРЕННОСТЬ: нет ответа\nЧЕГО НЕ ХВАТИЛО: нет статьи');
  const msg = runDmMsg(p);
  check('направляет к команде', msg.includes('уточнить у команды HR-аналитики'));
}

// ====================================================================== 13
line('13. Лог лички в канал джуна: вопрос и пробел, без черновика');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Длинный ответ про численность, который в лог не нужен.
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи про management_position_d`, {
    question: 'а декрет где смотреть?',
    mode: 'dm',
  });
  const log = runDmLog(p);
  console.log(log);
  check('помечено как личка', log.includes('**Личка**'));
  check('вопрос есть', log.includes('декрет'));
  check('пробел есть', log.includes('management_position_d'));
  check('черновика нет', !log.includes('Длинный ответ'));
}

// ====================================================================== 14
line('14. Ошибка разбора доходит до джуна, а не тонет');
{
  const p = runParse('Просто текст без блоков');
  const msg = runChannelMsg(p, { id: 'abc' });
  check('предупреждение в канале', msg.includes('Разбор ответа'));
  const log = runDmLog(p);
  check('предупреждение в логе лички', log.includes('Разбор ответа'));
}

// ====================================================================== 15
line('15. Чат: полный вывод для того, кто правит промпт');
{
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Ответ
ИСТОЧНИКИ: kb/metrics/turnover.md
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи`);
  const msg = runChatMsg(p);
  check('источники видны', msg.includes('kb/metrics/turnover.md'));
  check('пробел виден', msg.includes('ЧЕГО НЕ ХВАТИЛО'));
}

// ====================================================================== 16
line('16. Проводка адаптеров: связи и фильтры');
{
  const t = channel.nodes.find((n) => n.name === 'Time Trigger');
  check('канал слушаем hr-report-ask',
    JSON.stringify(t.parameters.postedFilters).includes('hr-report-ask'));
  const post = channel.nodes.find((n) => n.name === 'Post header');
  check('пишем в stonis_hakcs_2', JSON.stringify(post.parameters.channelId).includes('stonis_hakcs_2'));
  check('слушаем и пишем разные каналы',
    JSON.stringify(t.parameters).includes('hr-report-ask') &&
    !JSON.stringify(post.parameters.channelId).includes('hr-report-ask'));

  // Тред: ответы уходят к ИМЕННО ЭТОЙ шапке. Без root_id всё вернулось бы
  // к полотну из трёх постов подряд, и по виду флоу это неотличимо —
  // посты бы отправлялись, просто мимо треда.
  const inThread = channel.nodes.find((n) => n.name === 'Post in thread');
  check('канал: шапка постится одна', post.parameters.otherOptions.root_id === undefined);
  check('канал: остальное — ответом в тред к шапке',
    inThread.parameters.otherOptions.root_id === "={{ $('Post header').first().json.id }}");
  check('канал: тред в том же канале',
    JSON.stringify(inThread.parameters.channelId).includes('stonis_hakcs_2'));
  check('канал: порядок шапка → тред',
    channel.connections['Post header'].main[0][0].node === 'Build thread' &&
    channel.connections['Build thread'].main[0][0].node === 'Post in thread');

  // Guard — Code-нода, поэтому проверяется ПРОГОНОМ, а не поиском подстроки.
  // Прежние проверки includes('root_id') были зелёными и на той версии,
  // которая в живом канале пропускала все реплики: условие присутствовало,
  // но при `post` в виде JSON-строки читало undefined и проходило всегда.
  check('канал: guard — Code-нода', channel.nodes.find(
    (n) => n.name === 'Guard channel').type === 'n8n-nodes-base.code');
  check('канал: ворота по pass есть',
    JSON.stringify(channel.nodes.find((n) => n.name === 'Our request').parameters)
      .includes('pass'));
  // Ложная ветка ворот никуда не ведёт — отсеянное сообщение не идёт дальше.
  check('канал: ложная ветка ворот пустая',
    channel.connections['Our request'].main[1].length === 0);
  check('канал: вопрос в ядро из нормализованного поля',
    JSON.stringify(channel.nodes.find((n) => n.name === 'Call core').parameters)
      .includes('$json.question'));

  const dmT = dm.nodes.find((n) => n.name === 'Time Trigger DM');
  check('DM-триггер без фильтра каналов',
    !JSON.stringify(dmT.parameters.postedFilters).includes('nameAuto'));
  check('DM: guard — Code-нода', dm.nodes.find(
    (n) => n.name === 'Guard DM').type === 'n8n-nodes-base.code');
  check('DM: ложная ветка ворот пустая',
    dm.connections['DM allowed'].main[1].length === 0);

  const reply = dm.nodes.find((n) => n.name === 'Reply in DM');
  check('DM: ответ в тот же канал', JSON.stringify(reply.parameters.channelId).includes('channel_id'));

  // Ядро: конвейер вместо tool-loop
  const router = core.nodes.find((n) => n.name === 'Router');
  const author = core.nodes.find((n) => n.name === 'Author');
  check('роутер берёт вопрос со входа ядра',
    router.parameters.text.includes('When called by adapter'));
  check('автор берёт вопрос со входа ядра',
    author.parameters.text.includes('When called by adapter'));
  check('в ядре нет chatTrigger', !core.nodes.some((n) => n.type.includes('chatTrigger')));
  check('ядро отдаёт разбор', core.connections['Author'].main[0][0].node === 'Parse answer');

  // Главное свойство конвейера: у агентов НЕТ инструментов. Инструменты и есть
  // tool-loop, из-за которого один вопрос стоил 242k токенов.
  check('в ядре нет ai_tool-связей',
    !Object.values(core.connections).some((c) => c.ai_tool));
  check('в ядре нет toolWorkflow/gitlabTool узлов',
    !core.nodes.some((n) => /Tool$|toolWorkflow/.test(n.type)));
  for (const a of [router, author]) {
    check(`${a.name}: maxIterations = 1`, a.parameters.maxIterations === 1);
  }

  // Ни один ВЫХОД не ветвится на два узла.
  //
  // В n8n нет неявного слияния: если один выход ведёт в два узла, обе ветви
  // выполняются, и всё, где они снова сходятся, выполняется ДВАЖДЫ. Для
  // «Author» это два разных ответа на один вопрос и двойной расход токенов.
  //
  // Сходящиеся ветви IF (у «Need DD» два входа, у «Build materials» тоже) —
  // наоборот, нормальный случай: они взаимоисключающие, управление приходит
  // ровно по одной. Поэтому проверяется веер на выходе, а не число входов.
  const fanout = [];
  for (const [from, c] of Object.entries(core.connections)) {
    (c.main ?? []).forEach((branch, i) => {
      if ((branch ?? []).length > 1) {
        fanout.push([`${from}[${i}]`, branch.map((t) => t.node)]);
      }
    });
  }
  check(`ни один выход не ветвится${fanout.length ? ': ' + JSON.stringify(fanout) : ''}`,
    fanout.length === 0);

  // ВХОДЫ ЯДРА И ТО, ЧТО ПЕРЕДАЮТ АДАПТЕРЫ, — один список.
  //
  // Расхождение здесь тихое: n8n не падает на поле, которого нет в объявленных
  // входах, — оно просто не доедет. Поля формы приедут пустыми, правило
  // про непокрытые отчёты не сработает, уверенность не понизится, и по виду
  // флоу это неотличимо от «всё в порядке». Ровно та ошибка, из-за которой
  // адаптер после правки ядра нужно переимпортировать.
  const coreInputs = core.nodes.find((n) => n.name === 'When called by adapter')
    .parameters.workflowInputs.values.map((v) => v.name);
  check('ядро объявляет поля формы',
    ['topic_kind', 'form_domain', 'report_url', 'form_context']
      .every((k) => coreInputs.includes(k)));
  for (const [wf, name] of [[channel, 'канал'], [dm, 'личка'], [chat, 'чат']]) {
    const call = wf.nodes.find((n) => n.name === 'Call core').parameters.workflowInputs;
    check(`${name}: передаёт ровно объявленные ядром поля`,
      JSON.stringify(Object.keys(call.value).sort()) ===
        JSON.stringify([...coreInputs].sort()));
    check(`${name}: схема входов совпадает с ядром`,
      JSON.stringify(call.schema.map((s) => s.id)) === JSON.stringify(coreInputs));
  }
  // В канале и личке поля формы берутся из guard'а по имени ноды: опечатка
  // в имени даст пустое поле, а не ошибку.
  for (const [wf, guardName] of [[channel, 'Guard channel'], [dm, 'Guard DM']]) {
    const v = wf.nodes.find((n) => n.name === 'Call core').parameters.workflowInputs.value;
    check(`${guardName}: поля формы берутся из этой ноды`,
      v.form_domain.includes(`$('${guardName}')`) &&
      wf.nodes.some((n) => n.name === guardName));
    // Массив ссылок склеивается в строку: типизированные входы — только скаляры.
    check(`${guardName}: report_url уезжает строкой`, v.report_url.includes('.join('));
  }

  // Промпты вклеены текстом, а не литеральными «\n» из json.dumps.
  for (const a of [router, author]) {
    check(`${a.name}: промпт с настоящими переводами строк`,
      !a.parameters.text.includes('\\n') && a.parameters.text.split('\n').length > 20);
    check(`${a.name}: комментарии разработчика срезаны`,
      !a.parameters.text.includes('<!--'));
    check(`${a.name}: плейсхолдеры заполнены`,
      !/\{\{[A-Z_]+\}\}/.test(a.parameters.text));
  }

  // У каждого агента свой узел модели: один нельзя развести на двух.
  const models = Object.entries(core.connections)
    .filter(([, c]) => c.ai_languageModel)
    .map(([name, c]) => [name, c.ai_languageModel[0][0].node]);
  // Агентов теперь три: роутер, автор и правка черновика после проверки
  // значений в данных. Узел модели у каждого свой — один нельзя развести
  // ai_languageModel-входом на двух агентов.
  check(`у каждого агента свой узел модели (${models.length})`,
    models.length === 3
    && new Set(models.map((m) => m[0])).size === models.length
    && new Set(models.map((m) => m[1])).size === models.length);

  // Реестр попадает только роутеру: автор платил бы за него зря.
  check('реестр только в промпте роутера',
    router.parameters.text.includes('Decode registry')
    && !author.parameters.text.includes('Decode registry'));

  // Все три адаптера зовут одно ядро
  for (const [name, w] of [['channel', channel], ['chat', chat], ['dm', dm]]) {
    const c = w.nodes.find((n) => n.name === 'Call core');
    check(`${name}: зовёт ядро`, c && c.type === 'n8n-nodes-base.executeWorkflow');
    check(`${name}: ждёт результат`, c.parameters.options.waitForSubWorkflow === true);
  }
}

// ====================================================================== 17
// Формат из живого прогона 2026-08-07. Агент НЕ печатает ярлык ЧЕРНОВИК ОТВЕТА,
// а ИСТОЧНИКИ и УВЕРЕННОСТЬ приходят одной строкой. Первая версия парсера
// на этом теряла весь текст ответа и отправляла в канал пустое сообщение —
// через чат этого не видно, потому что чат показывает сырой вывод агента.
line('17. ЖИВОЙ ФОРМАТ: без ярлыка черновика, ИСТОЧНИКИ и УВЕРЕННОСТЬ в строку');
{
  const p = runParse(`Юридическая численность считается по формуле:

legal_employee_flg = 1 AND company_fire_flg = 0

Считать нужно через count(distinct mdm_employee_rk), так как у одного сотрудника
может быть несколько оформлений (например, совместительство).

Если нужно уточнить по конкретному подразделению — дайте знать.

ИСТОЧНИКИ: kb/metrics/legal-headcount.md, kb/tables/mdm-employee-structure-d.md, kb/recipes/structure-choice.md УВЕРЕННОСТЬ: высокая`);
  check('черновик не потерян', p.draft.includes('legal_employee_flg = 1 AND company_fire_flg = 0'));
  check('черновик целиком, включая хвост', p.draft.includes('дайте знать'));
  check('черновик без служебного', !p.draft.includes('ИСТОЧНИКИ'));
  check('источники отделены', p.sources.includes('structure-choice.md'));
  check('УВЕРЕННОСТЬ не утекла в источники', !p.sources.includes('УВЕРЕННОСТЬ'));
  check('уверенность high', p.confidence_key === 'high');
  check('это не считается ошибкой разбора', p.parse_error === '');

  // Главное следствие: в канал джуна уходит непустое осмысленное сообщение.
  const msg = runChannelMsg(p, { id: 'abc123', message: 'как считается юридическая численность' });
  check('в канал ушёл черновик', msg.includes('count(distinct mdm_employee_rk)'));
  check('нет пометки о пустом черновике', !msg.includes('_черновик пустой_'));
}

// ====================================================================== 18
line('18. ЖИВОЙ ФОРМАТ: ответ по полям из DD');
{
  const p = runParse(`В ультраширокой витрине сотрудников (mdm_employee_structure_d) 267 полей.

Идентификация и ПДн — business_dt, mdm_employee_rk, full_nm, ad_login и др.

Важно: витрина содержит персональные данные, поэтому при выгрузке нужно
фильтровать состав полей.

ИСТОЧНИКИ: kb/tables/mdm-employee-structure-d.md, Data Detective: emart.mdm_employee_structure_d УВЕРЕННОСТЬ: высокая`);
  check('черновик не потерян', p.draft.includes('267 полей'));
  check('предупреждение о ПДн сохранилось', p.draft.includes('персональные данные'));
  check('DD в источниках', p.sources.includes('Data Detective'));
  check('уверенность high', p.confidence_key === 'high');
  check('без ошибки разбора', p.parse_error === '');

  // В личку служебное не уходит даже при таком формате.
  const dmMsg = runDmMsg(p);
  check('личка: нет путей kb/', !dmMsg.includes('kb/'));
  check('личка: нет Data Detective', !dmMsg.includes('Data Detective'));
  check('личка: черновик есть', dmMsg.includes('267 полей'));
}

// ====================================================================== 19
line('19. Слово «источники» строчными внутри черновика блок не разрезает');
{
  // Регистр ярлыка несёт смысл: служебный ярлык только в верхнем регистре.
  const p = runParse(`Уточни у заказчика источники данных: нужна юридическая
или управленческая численность.

ИСТОЧНИКИ: kb/recipes/structure-choice.md УВЕРЕННОСТЬ: высокая`);
  check('черновик целиком', p.draft.includes('источники данных'));
  check('источники только настоящие', p.sources === 'kb/recipes/structure-choice.md');
}

// ===================================================================== 20
line('20. Ядро отдаёт доменную разбивку — стык с телеметрией');
{
  // Роутер уже определил домен по таблице «Домены» реестра, а Plan добрал
  // мастеров. Телеметрии этого достаточно для кластеризации обращений, и
  // вторая LLM не нужна — но домены должны ДОЕХАТЬ до выхода ядра.
  const p = runParse(
    'Текст ответа\n\nИСТОЧНИКИ: kb/metrics/hiring.md\nУВЕРЕННОСТЬ: высокая',
    { question: 'сколько наняли в июле', mode: 'channel' },
    { domains: ['movement'], files: ['kb/metrics/hiring.md'], dd_count: 1, router_error: '' },
  );
  check('домены на выходе ядра', JSON.stringify(p.domains) === '["movement"]');
  check('прочитанные статьи на выходе',
    p.articles_read.includes('kb/metrics/hiring.md'));
  check('число объектов DD на выходе', p.dd_count === 1);
  check('confidence_key для калибровки', p.confidence_key === 'high');
  // Калибровка считается по ПАРЕ «заявлено / действует»: без заявленного
  // значения не увидеть, что модель систематически завышает, а без
  // действующего — что её понижал код.
  check('confidence_claimed для калибровки', p.confidence_claimed === 'high');

  // Пустой список значит «роутер домен не определил» — сигнал о пробеле
  // в реестре. Подставлять сюда заглушку нельзя: пробел перестанет быть виден.
  const empty = runParse('Текст\n\nУВЕРЕННОСТЬ: нет ответа', undefined, {});
  check('без доменов — пустой массив, а не выдумка',
    Array.isArray(empty.domains) && empty.domains.length === 0);
  check('router_error пробрасывается', empty.router_error === '');
}

// ===================================================================== 21
line('21. Guard канала: что проходит и что отсеивается');
{
  // Форма события: пост объектом на верхнем уровне.
  const req = (message, extra = {}) => ({
    event: 'posted',
    channel_name: 'hr-report-ask',
    post: { id: 'p1', type: '', root_id: '', message, ...extra },
  });

  const ok = guardChannel(req('Cross Data | Выгрузка данных\nНужны командировки за год'));
  check('обращение проходит', ok.pass === true);
  check('тема распознана', ok.topic === 'Cross Data |');
  check('вопрос нормализован', ok.question.includes('командировки'));
  check('причины отсева нет', ok.reason === '');

  // ГЛАВНЫЙ КЕЙС: реплика в треде. Из-за неё бот писал черновик на каждое
  // сообщение обсуждения — по одному обращению выходил веер черновиков.
  const reply = guardChannel(req('а можно ещё город отправления?',
    { id: 'p2', root_id: 'p1' }));
  check('реплика в треде отсеяна', reply.pass === false);
  check('причина названа', reply.reason === 'реплика в треде');

  // Реплика в треде, начинающаяся с префикса (кто-то скопировал шапку):
  // всё равно не обращение — решает root_id, а не текст.
  const quoted = guardChannel(req('Cross Data | Выгрузка данных — дубль',
    { id: 'p3', root_id: 'p1' }));
  check('реплика с префиксом тоже отсеяна', quoted.pass === false);

  // Mattermost у КОРНЕВОГО поста иногда проставляет root_id равным его же id.
  const selfRoot = guardChannel(req('Cross Data | Вопрос по отчетам\nгде декрет?',
    { id: 'p1', root_id: 'p1' }));
  check('root_id == id — это всё ещё корень', selfRoot.pass === true);

  // Чужая команда: тема формы есть, но обращение адресовано DWH HR.
  const dwh = guardChannel(req('Вопрос команде HC Data (ex. DWH HR) | реплика (prod_v_ods) не актуальна'));
  check('чужая команда отсеяна', dwh.pass === false);
  // Старое имя команды в истории канала — отсев по префиксу от переименования
  // не зависит, и это его главное свойство.
  const dwhOld = guardChannel(req('Вопрос команде DWH HR | реплика prod_v_ods не актуальна'));
  check('старое имя чужой команды тоже отсеяно', dwhOld.pass === false);
  // Текущие темы формы проходят все четыре, включая «Другое».
  for (const topic of ['Выгрузка данных', 'Вопрос по отчетам', 'Нет доступа к отчету',
                       'Другое ( Если не нашлось подходящей категории )']) {
    check('тема «' + topic.slice(0, 20) + '…» проходит',
      guardChannel(req('Cross Data | ' + topic + ' от пользователя @A\nвопрос')).pass === true);
  }
  check('причина — не наша тема', dwh.reason.startsWith('не наша тема'));

  // Обычная болтовня в канале без темы формы.
  const chatter = guardChannel(req('всем привет, а кто дежурит сегодня?'));
  check('сообщение без темы отсеяно', chatter.pass === false);

  // Тема выделена жирным: intake-воркфлоу может обрамлять её markdown.
  const bold = guardChannel(req('**Cross Data | Вопрос по отчетам**\nсломался дашборд'));
  check('тема в markdown распознана', bold.pass === true);

  // Системное сообщение о входе в канал.
  const sys = guardChannel(req('user joined the channel', { type: 'system_join_channel' }));
  check('системное отсеяно', sys.pass === false);

  // from_bot в КАНАЛЕ не фильтруется: intake-воркфлоу может постить обращение
  // от имени бота, и тогда фильтр отбрасывал бы именно реальные обращения,
  // оставляя переписку вокруг них. Эхо здесь невозможно по конструкции —
  // слушаем hr-report-ask, пишем stonis_hakcs_2.
  const fromBot = guardChannel(req('Cross Data | Выгрузка данных\nвопрос',
    { props: { from_bot: 'true' } }));
  check('обращение от имени бота НЕ отброшено', fromBot.pass === true);
}

// ===================================================================== 22
line('22. Guard: пост приходит JSON-строкой в data.post');
{
  // Ровно та форма, на которой прежний IF-фильтр молча пропускал всё:
  // `$json.post.root_id` читался как undefined, `?? ''` давал пустую строку,
  // и условие «только корневые» проходило для КАЖДОЙ реплики.
  const packed = (post) => ({ event: 'posted', data: { post: JSON.stringify(post) } });

  const ok = guardChannel(packed({
    id: 'p1', type: '', root_id: '', message: 'Cross Data | Выгрузка данных\nнужна выгрузка',
  }));
  check('строковый пост распакован', ok.pass === true);
  check('вопрос виден', ok.question.includes('нужна выгрузка'));

  const reply = guardChannel(packed({
    id: 'p2', type: '', root_id: 'p1', message: 'спасибо!',
  }));
  check('реплика из строкового поста отсеяна', reply.pass === false);
  check('причина — реплика в треде', reply.reason === 'реплика в треде');

  // Сломанный JSON не должен ронять ноду: пустой пост — это отсев с причиной,
  // а не исключение и не пропуск дальше.
  const broken = guardChannel({ event: 'posted', data: { post: '{не json' } });
  check('сломанный JSON не роняет guard', broken.pass === false);
  check('причина — пустое сообщение', broken.reason === 'пустое сообщение');
}

// ===================================================================== 23
line('23. Guard лички: эхо и тип канала');
{
  const dmEvent = (message, extra = {}, top = {}) => ({
    event: 'posted',
    channel_type: 'D',
    sender_name: '@r.kazantsev',
    post: { id: 'd1', type: '', root_id: '', message, ...extra },
    ...top,
  });

  const ok = guardDm(dmEvent('где смотреть декрет?'));
  check('вопрос в личке проходит', ok.pass === true);
  check('префикс темы в личке НЕ требуется', ok.reason === '');
  check('собака у отправителя снята', ok.sender_name === 'r.kazantsev');

  // В личке бот слушает и пишет ОДИН канал — без этого фильтра он заговорит
  // сам с собой.
  const echo = guardDm(dmEvent('Черновик ответа: ...', { props: { from_bot: 'true' } }));
  check('эхо бота в личке отсеяно', echo.pass === false);
  check('причина — сообщение бота', echo.reason === 'сообщение бота');

  // Триггер лички идёт без фильтра каналов, поэтому канальные сообщения
  // до него доходят и должны отсеиваться по типу канала.
  const inChannel = guardDm(dmEvent('Cross Data | Выгрузка данных', {}, { channel_type: 'O' }));
  check('сообщение из открытого канала отсеяно', inChannel.pass === false);
  check('причина — не личный диалог', inChannel.reason === 'не личный диалог');
}

// ===================================================================== 24
line('24. Лимит поста Mattermost: 4000 символов');
{
  // Живой прогон 2026-08-10: пост черновика упал с «Bad request», в ответе
  // сервера — «Ваше сообщение слишком длинное». Падает ПОСЛЕДНИЙ узел: ядро
  // отработало, токены уплачены, ответ собран — и не доехал никуда. В канале
  // это выглядит как «бот промолчал».
  const LIMIT = 4000;

  // В треде минимум два поста: разбор и сообщение заказчику. Один пост
  // здесь был бы регрессом — именно из-за него джуну нечего было копировать.
  const short = runChannelParts(runParse('Короткий ответ\n\nУВЕРЕННОСТЬ: высокая'), { id: 'p1' });
  check('короткий ответ — разбор и сообщение заказчику', short.length === 2);
  check('короткий ответ без нумерации', !/\(1\/\d+\)/.test(short[0]));
  // Шапка в лимит влезает всегда: она короткая по конструкции, а вопрос
  // из формы обрезается по длине.
  const longQuestionHead = runChannelHead(
    runParse('Ответ\nУВЕРЕННОСТЬ: высокая'), { id: 'p1' }, 'hr-report-ask',
    { question_text: 'нужна выгрузка. ' + 'подробности задачи. '.repeat(400) });
  check('шапка в лимите', longQuestionHead.length <= LIMIT);
  check('шапка обрезает вопрос', longQuestionHead.includes('…'));

  // Длинный черновик: 9000 символов — столько бот выдаёт на вопрос про
  // выгрузку с перечнем полей.
  const long = runParse(
    'ЧЕРНОВИК ОТВЕТА: ' + 'Поле business_dt — дата среза. '.repeat(300) +
    '\nИСТОЧНИКИ: kb/process/export-playbook.md\nУВЕРЕННОСТЬ: высокая');
  const parts = runChannelParts(long, { id: 'p1' });
  check('длинный ответ разбит на несколько постов', parts.length > 1);
  check('каждый пост влезает в лимит', parts.every((p) => p.length <= LIMIT));
  // Нумерация теперь идёт внутри секции и вместе с её заголовком: без него
  // «(2/3)» посреди треда не говорит, продолжением ЧЕГО он является.
  check('посты пронумерованы',
    parts.some((p) => /^\*\*Сообщение заказчику[^*]*\(1\/\d+\)\*\*/.test(p)));

  // Главное свойство: разбивка НЕ должна терять содержание. Обрезка молча —
  // это тот же тихий отказ, только вместо пустого сообщения приходит огрызок.
  const joined = parts.join('\n');
  check('черновик не потерян', joined.includes('business_dt'));
  check('источники доехали', joined.includes('export-playbook.md'));
  // Уверенность живёт в шапке, а не в треде: её читают, не разворачивая тред.
  check('уверенность доехала', runChannelHead(long, { id: 'p1' }).includes('высокая'));

  // Аварийный хвост: если и после разбивки не влезает, обрезка НАЗЫВАЕТ,
  // сколько символов потеряно.
  const huge = runParse('ЧЕРНОВИК ОТВЕТА: ' + 'абвгдеёжзий '.repeat(4000) +
    '\nУВЕРЕННОСТЬ: высокая');
  const hugeParts = runChannelParts(huge, { id: 'p1' });
  // Предел общий на обращение: секций теперь до трёх, и посекционного лимита
  // мало — три секции по четыре части это двенадцать сообщений подряд.
  check('число постов ограничено', hugeParts.length <= 6);
  check('все посты в лимите', hugeParts.every((p) => p.length <= LIMIT));
  // Обрезка называет потерю. Ищем по всем постам, а не в последнем: последний
  // теперь служебный, а обрезается хвост сообщения заказчику.
  check('обрезка называет потерю',
    hugeParts.some((p) => /обрезано \d+ символов/.test(p)));

  // Личка и лог лички — тот же лимит и та же цена отказа.
  const dmParts = runDmParts(long);
  check('личка: разбита на посты', dmParts.length > 1);
  check('личка: посты в лимите', dmParts.every((p) => p.length <= LIMIT));
  check('личка: без служебного даже в длинном ответе',
    !dmParts.join('\n').includes('kb/'));

  const logParts = runDmLogParts(runParse(
    'Ответ\n\nУВЕРЕННОСТЬ: средняя\nЧЕГО НЕ ХВАТИЛО: ' + 'нет статьи про ССЧ. '.repeat(300),
    { question: 'вопрос', mode: 'dm' }));
  check('лог лички: посты в лимите', logParts.every((p) => p.length <= LIMIT));

  // Цитата вопроса в логе лички остаётся (ссылки на сообщение там нет), но
  // обрезается — и обрезка называет потерю. Молчаливый огрызок читался бы
  // как весь вопрос.
  const longQ = runDmLog(runParse('Ответ\nУВЕРЕННОСТЬ: средняя',
    { question: 'нужна выгрузка. ' + 'подробности задачи. '.repeat(80), mode: 'dm' }));
  check('лог лички: цитата обрезана', /обрезано \d+ символов/.test(longQ));
  check('лог лички: начало вопроса сохранено', longQ.includes('нужна выгрузка'));
}

// ===================================================================== 25
line('25. Guard разбирает intake-форму: тема, автор, домен, ссылка, вопрос');
{
  // Ровно тот пост, на котором бот 2026-08-11 ответил «высокая уверенность»
  // про витрину сотрудников на вопрос о бюджетах.
  const FORM = [
    'Cross Data | Вопрос по отчетам от пользователя @Anna Sokolova',
    '',
    'Выбери домен:',
    'Стоимость и расходы на персонал',
    'Укажи ссылку на отчет:',
    'https://proteus.tcsbank.ru/superset/dashboard/budget-corporate-events/?native_filters_key=abc',
    'Напиши свой вопрос:',
    'привет! подскажите, долились ли бюджеты на сотрудников летом, тк суммы',
    'в остатке не бьются с исходным бюджетом и фактическими расходами',
  ].join('\n');

  const g = guardChannel({
    event: 'posted',
    channel_name: 'hr-report-ask',
    sender_name: '@intake-bot',
    post: { id: 'p1', type: '', root_id: '', message: FORM },
  });

  check('обращение проходит', g.pass === true);
  check('тема из формы', g.topic_kind === 'Вопрос по отчетам');
  // Автор берётся из ШАПКИ, а не из sender_name: постит intake-воркфлоу.
  check('автор из шапки, а не sender_name', g.form_author === 'Anna Sokolova');
  check('домен формы', g.form_domain === 'Стоимость и расходы на персонал');
  check('ссылка на отчёт', g.report_url.length === 1 &&
    g.report_url[0].includes('budget-corporate-events'));
  check('текст вопроса без служебных полей',
    g.question_text.startsWith('привет! подскажите') &&
    !g.question_text.includes('Выбери домен'));
  check('вопрос в ядро — весь пост', g.question === FORM);
  check('форма распознана', g.form_parsed === true);
  check('form_context собран',
    g.form_context.includes('Вопрос по отчетам') &&
    g.form_context.includes('Стоимость и расходы') &&
    g.form_context.includes('budget-corporate-events'));

  // ТА ЖЕ ФОРМА, но пост приходит JSON-СТРОКОЙ в data.post — вид события,
  // на котором прежний IF-фильтр был зелёным и пропускал всё (группа 22).
  // Разбор формы обязан работать одинаково в обеих формах payload, иначе
  // поля молча приедут пустыми, и правило про непокрытые отчёты не сработает.
  const packed = guardChannel({
    event: 'posted',
    data: { post: JSON.stringify({ id: 'p1', type: '', root_id: '', message: FORM }) },
  });
  check('строковый пост: тема разобрана', packed.topic_kind === 'Вопрос по отчетам');
  check('строковый пост: домен разобран',
    packed.form_domain === 'Стоимость и расходы на персонал');
  check('строковый пост: ссылка разобрана', packed.report_url.length === 1);

  // Тема жирным: intake-воркфлоу может обрамлять шапку markdown.
  const bold = guardChannel({
    event: 'posted',
    post: { id: 'p1', type: '', root_id: '',
            message: '**Cross Data | Выгрузка данных от пользователя @ivan**\n' +
                     'Бизнес-задача:\nаналитика Forge за июль' },
  });
  check('тема из жирной шапки', bold.topic_kind === 'Выгрузка данных');
  check('неизвестное поле формы не потеряно',
    bold.question_text.includes('аналитика Forge'));

  // Форма не распознана вовсе: полей нет, только текст. Вопрос терять нельзя —
  // пустой вопрос читается как «бот не знает».
  const plain = guardChannel({
    event: 'posted',
    post: { id: 'p1', type: '', root_id: '',
            message: 'Cross Data | Нет доступа к отчету\nне пускает в дашборд' },
  });
  check('без полей формы вопрос сохранён',
    plain.question_text.includes('не пускает в дашборд'));
  check('домена нет — пусто, а не выдумка', plain.form_domain === '');
  check('ссылок нет — пустой массив', plain.report_url.length === 0);
}

// ===================================================================== 26
line('26. Уверенность понижает КОД: вопрос по отчёту, которого нет в базе');
{
  const ANSWER = `ЧЕРНОВИК ОТВЕТА: Бюджеты на сотрудников в витрине сотрудников не отражаются — в её составе нет ни одного поля про бюджеты и расходы.
ИСТОЧНИКИ: kb/tables/mdm-employee-structure-d.md, kb/metrics/legal-headcount.md
УВЕРЕННОСТЬ: высокая`;

  const trigger = {
    question: 'долились ли бюджеты на сотрудников летом?',
    mode: 'channel',
    topic_kind: 'Вопрос по отчетам',
    form_domain: 'Стоимость и расходы на персонал',
    report_url: 'https://proteus.tcsbank.ru/superset/dashboard/budget-corporate-events/',
  };

  // Разобранный случай: роутер не подобрал НИ ОДНОЙ статьи, всё прочитанное —
  // мастера домена, добранные кодом. Отчёт не разбирался.
  const mastersOnly = {
    ...MAT_OK,
    masters_only: true,
    router_picked: [],
    asks_report: true,
    report_seen: false,
    articles_read: ['kb/tables/mdm-employee-structure-d.md',
                    'kb/metrics/legal-headcount.md',
                    'kb/recipes/structure-choice.md'],
    dd_objects: ['urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d'],
  };

  const p = runParse(ANSWER, trigger, { domains: ['headcount-structure'] }, mastersOnly);
  check('заявленное сохранено', p.confidence_claimed === 'high');
  check('действует «нет ответа»', p.confidence_key === 'none');
  check('понижение отмечено', p.confidence_capped === true);
  check('причина названа', /отч[её]т/.test(p.confidence_capped_reason));
  check('причина про мастеров тоже названа',
    /мастера домена/.test(p.confidence_capped_reason));
  // Одна и та же фраза дважды в строке «Почему» читается как две разные
  // проблемы, поэтому правило про мастеров не дублирует правило про отчёт.
  check('причина не продублирована',
    p.confidence_capped_reason.split('только мастера домена').length === 2);

  // ОСНОВАНИЕ — ответ на «непонятно, как считается уверенность».
  const basis = p.confidence_basis.join(' · ');
  check('основание: сколько статей', /статей: 3/.test(basis));
  check('основание: это мастера', /только мастера домена/.test(basis));
  check('основание: метаданные названы',
    basis.includes('mdm_employee_structure_d') && !basis.includes('urn:dd:'));
  check('основание: домен формы против домена бота',
    basis.includes('Стоимость и расходы') && basis.includes('headcount-structure'));

  // ЗАДАЧА ДЛЯ БАЗЫ — готовый список правок, собранный из фактов.
  const tasks = p.kb_tasks.join('\n');
  check('задача: статья об отчёте', /kb\/reports\//.test(tasks));
  check('задача: отчёт узнаваем', tasks.includes('budget-corporate-events'));
  check('задача: домен формы не покрыт',
    /домен формы «Стоимость и расходы на персонал»/.test(tasks));
  check('задача: читались только мастера', /только мастера/.test(tasks));

  // Сообщение канала печатает всё это без цитаты обращения.
  const msg = runChannelMsg(p, { id: 'p1' }, 'hr-report-ask', {
    topic_kind: 'Вопрос по отчетам', form_author: 'Anna Sokolova',
  });
  console.log(msg);
  check('в канале: понижение видно', msg.includes('нет ответа') &&
    msg.includes('бот заявил высокую'));
  check('в канале: блок задач', msg.includes('**Задача для базы**'));
  check('в канале: нет цитаты обращения', !msg.includes('> долились ли бюджеты'));

  // ВТОРОЙ УРОВЕНЬ: роутер статью под вопрос подобрал сам. Черновик может быть
  // рабочим, но про сам отчёт бот по-прежнему не знает ничего — «средняя».
  // Понижать такое до «нет ответа» значит отучить джуна читать черновики,
  // то есть тот же тихий отказ, только в другую сторону.
  const picked = runParse(ANSWER, trigger, { domains: ['headcount-structure'] }, {
    ...MAT_OK,
    masters_only: false,
    router_picked: ['kb/metrics/legal-headcount.md'],
    asks_report: true,
    report_seen: false,
  });
  check('роутер подобрал статью → средняя', picked.confidence_key === 'medium');
  check('причина всё равно про отчёт', /отч[её]т/.test(picked.confidence_capped_reason));

  // Отчёт РАЗОБРАН (пришли метаданные объекта отчёта) — не понижаем.
  const seen = runParse(ANSWER, trigger, { domains: ['headcount-structure'] }, {
    ...MAT_OK,
    asks_report: true,
    report_seen: true,
    dd_objects: ['urn:dd:reports:helicopter:note:12345'],
  });
  check('отчёт разобран → высокая остаётся', seen.confidence_key === 'high');
  check('пометки о понижении нет', seen.confidence_capped === false);
}

// ===================================================================== 27
line('27. Остальные понижения кодом и что код НЕ трогает');
{
  const HIGH = 'ЧЕРНОВИК ОТВЕТА: Ответ\nИСТОЧНИКИ: kb/metrics/turnover.md\nУВЕРЕННОСТЬ: высокая';

  // Материалов не было вовсе: ответ по существу взяться неоткуда — общие
  // знания в этом боте запрещены.
  const empty = runParse(HIGH, undefined, {}, {
    ...MAT_OK, has_materials: false, articles_read: [], router_picked: [],
  });
  check('нет материалов → нет ответа', empty.confidence_key === 'none');
  check('причина названа', /материалов не было/.test(empty.confidence_capped_reason));

  // Реестр ссылается на файл, которого нет: основание неполное.
  const failed = runParse(HIGH, undefined, {}, {
    ...MAT_OK, articles_failed: ['kb/reports/headcount-report.md'],
  });
  check('нечитаемая статья → средняя', failed.confidence_key === 'medium');
  check('задача про битую ссылку реестра',
    failed.kb_tasks.join('\n').includes('файл, которого нет'));

  // Метаданные запрашивались и не дошли: состав полей неизвестен, а поля —
  // самое частое, что бот утверждает.
  const ddLost = runParse(HIGH, undefined, {}, {
    ...MAT_OK, dd_failed: ['urn:dd:tables:greenplum:table:emart.legal_position_d'],
  });
  check('метаданные не дошли → средняя', ddLost.confidence_key === 'medium');
  check('задача про метаданные без полного URN',
    ddLost.kb_tasks.join('\n').includes('legal_position_d') &&
    !ddLost.kb_tasks.join('\n').includes('urn:dd:'));

  // Сбой планирования.
  const routerErr = runParse(HIGH, undefined, { router_error: 'в выводе роутера нет JSON' });
  check('сбой планирования → средняя', routerErr.confidence_key === 'medium');

  // unknown НЕ ДВИГАЕТСЯ: это «модель отклонилась от формата», а не «средняя
  // уверенность». Подменить его понижением значит спрятать parse_error
  // за нормально выглядящим словом.
  const broken = runParse('Просто текст без блоков', undefined, {}, {
    ...MAT_OK, has_materials: false,
  });
  check('сломанный формат остаётся unknown', broken.confidence_key === 'unknown');
  check('parse_error на месте', Boolean(broken.parse_error));

  // Всё сошлось — код не трогает заявленное. Повышать он не может вообще:
  // читал ли автор материалы по делу, код не знает.
  const clean = runParse(HIGH);
  check('чистый случай: высокая остаётся', clean.confidence_key === 'high');
  check('чистый случай: причин нет', clean.confidence_capped_reason === '');
  check('чистый случай: задач для базы нет', clean.kb_tasks.length === 0);

  // Домен формы, который В РЕЕСТРЕ ЕСТЬ, задачей не считается.
  const covered = runParse(HIGH, {
    question: 'сколько людей в юните?', mode: 'channel',
    topic_kind: 'Другое', form_domain: 'Численность и структура',
  });
  check('покрытый домен формы задачей не становится',
    !covered.kb_tasks.join('\n').includes('домен формы'));
}

// ====================================================================== 28
line('28. ВЫГРУЗКА: два блока разбираются раздельно');
{
  const MAT_EXPORT = { ...MAT_OK, is_export: true };
  const ANSWER = [
    'ЧЕРНОВИК ОТВЕТА: Уточните, пожалуйста: нужны люди с основным оформлением',
    'или все позиции, включая совместительство?',
    'Периметр: действующие сотрудники на 01.09.',
    'ТЗ ДЛЯ АНАЛИТИКА: таблица emart.mdm_employee_structure_d,',
    'фильтр active_employee_flg = 1',
    'ИСТОЧНИКИ: kb/process/export-playbook.md',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n');

  const a = runParse(ANSWER, { question: 'нужна выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);

  check('черновик заказчику разобран', a.draft.includes('Уточните'));
  check('ТЗ разобрано отдельно', a.tech_spec.includes('mdm_employee_structure_d'));
  // Главное свойство всей правки: техника не течёт в текст заказчика.
  check('техника не попала в черновик', !a.draft.includes('active_employee_flg'));
  check('черновик не попал в ТЗ', !a.tech_spec.includes('Уточните'));
  check('режим виден в разборе', a.is_export === true);
  check('уверенность не пострадала', a.confidence_key === 'high');

  // Блок ТЗ пропущен: это отклонение от формата, и джуну оно должно быть
  // видно. Молча отданная половина ответа выглядит законченной.
  const noSpec = runParse(
    'ЧЕРНОВИК ОТВЕТА: вот состав полей\nУВЕРЕННОСТЬ: высокая',
    { question: 'нужна выгрузка', mode: 'channel', topic_kind: 'Выгрузка данных' },
    {}, MAT_EXPORT);
  check('нет ТЗ — назван parse_error', noSpec.parse_error.includes('ТЗ ДЛЯ АНАЛИТИКА'));
  check('нет ТЗ — уверенность понижена', noSpec.confidence_key === 'medium');

  // Обычный вопрос: ТЗ не бывает, и его отсутствие ошибкой не является.
  const usual = runParse('Ответ по существу\nУВЕРЕННОСТЬ: высокая',
    { question: 'что такое ССЧ', mode: 'channel', topic_kind: 'Другое' });
  check('обычный вопрос: ТЗ пустое', usual.tech_spec === '');
  check('обычный вопрос: parse_error нет', usual.parse_error === '');
  check('обычный вопрос: уверенность высокая', usual.confidence_key === 'high');
}

// ====================================================================== 29
line('29. ВЫГРУЗКА: техническое в сообщении заказчику называется');
{
  const MAT_EXPORT = { ...MAT_OK, is_export: true };
  const leaky = runParse([
    'ЧЕРНОВИК ОТВЕТА: возьмём поле business_dt из emart.mdm_employee_structure_d,',
    'подробности в kb/tables/mdm-employee-structure-d.md',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);

  check('имя поля названо', leaky.draft_leaks.includes('business_dt'));
  check('таблица со схемой названа',
    leaky.draft_leaks.some((s) => s.includes('emart.mdm_employee_structure_d')));
  check('путь kb/ назван', leaky.draft_leaks.some((s) => s.startsWith('kb/')));
  // Проверка — про форму, а не про основание: понижение испортило бы
  // калибровку, ради которой хранится пара «заявлено / действует».
  check('уверенность не тронута', leaky.confidence_key === 'high');
  check('текст модели не правится', leaky.draft.includes('business_dt'));

  // Схема запроса — prod_v_<схема>, и она тоже утечка. Без явного префикса
  // в шаблоне `prod_v_hrmart.` не совпадал бы: перед `hrmart` стоит «_»,
  // то есть границы слова там нет, и имя таблицы уехало бы заказчику молча.
  const prodV = runParse([
    'ЧЕРНОВИК ОТВЕТА: возьмём prod_v_hrmart.mdm_employee_attendance',
    'и prod_v_emart.functional_role_d',
    'ТЗ ДЛЯ АНАЛИТИКА: prod_v_emart.functional_role_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  check('схема prod_v_hrmart названа утечкой',
    prodV.draft_leaks.some((s) => s.includes('prod_v_hrmart.mdm_employee_attendance')));
  check('схема prod_v_emart названа утечкой',
    prodV.draft_leaks.some((s) => s.includes('prod_v_emart.functional_role_d')));

  // Чистый черновик: ложных срабатываний нет. Ссылка на отчёт с подчёркиваниями
  // в параметрах — норма, и утечкой считаться не должна.
  const clean = runParse([
    'ЧЕРНОВИК ОТВЕТА: нужны действующие сотрудники на 01.09, отчёт тут:',
    'https://proteus.tcsbank.ru/superset/dashboard/x/?native_filters_key=abc_def',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  check('чистый черновик — утечек нет', clean.draft_leaks.length === 0);

  // ИМЯ КАНАЛА — НЕ УТЕЧКА, и это не мелочь оформления.
  //
  // Имя канала Mattermost построено ровно как имя поля (`sec_analytics_ask`),
  // и вторая альтернатива LEAK_RE ловила его вместе с полями. Получалось, что
  // в одном сообщении джуну код строкой 🔒 хвалит черновик за названное
  // согласование ИБ, а строкой ⚠️ велит его вычистить — притом что заказчику
  // имя канала как раз нужно, иначе он не знает, куда подавать заявку.
  //
  // Совпадают эти условия ВСЕГДА, когда правило ИБ применимо: и ib_required,
  // и draft_leaks считаются только при is_export. Оба теста при этом были
  // зелёные по отдельности — группа 29 проверяла утечки без имён каналов,
  // группы 34–35 проверяли ИБ без утечек.
  const ib = runParse([
    'ЧЕРНОВИК ОТВЕТА: файл не передаём, пока информационная безопасность',
    'не согласовала передачу — заявка в канал ~sec_analytics_ask.',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка наружу', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {},
    { ...MAT_EXPORT, ib_required: true, external_transfer: 'yes' });
  check('требование ИБ засчитано', ib.ib_stated === true && ib.ib_missing === false);
  check('имя канала утечкой НЕ названо', ib.draft_leaks.length === 0);
  const ibThread = runChannelParts(ib).join('\n');
  check('и джуну не сказано его вычистить',
    !ibThread.includes('Вычистить перед отправкой'));

  // То же и с адресатом маршрута: `~recruitment_reports_ask` в верно
  // названном маршруте тоже уезжал в «вычистить».
  const route = runParse([
    'ЧЕРНОВИК ОТВЕТА: вопрос по подбору задайте в канале ~recruitment_reports_ask.',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка по подбору', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  check('адресат маршрута утечкой не назван', route.draft_leaks.length === 0);

  // А имя поля рядом с именем канала по-прежнему ловится: вырезаем адреса,
  // а не выключаем проверку.
  const both = runParse([
    'ЧЕРНОВИК ОТВЕТА: заявка в ~sec_analytics_ask, поле business_dt.',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  check('поле рядом с каналом всё ещё ловится',
    both.draft_leaks.includes('business_dt') &&
    !both.draft_leaks.some((x) => /sec_analytics/.test(x)));
}

// ====================================================================== 30
line('30. ВЫГРУЗКА: шапка в канале, раздельные посты для копирования — в треде');
{
  const MAT_EXPORT = { ...MAT_OK, is_export: true };
  const a = runParse([
    'ЧЕРНОВИК ОТВЕТА: Уточните: только действующие на 01.09 или за период',
    'с уволенными?',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d, фильтр business_dt',
    'ИСТОЧНИКИ: kb/process/export-playbook.md',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'нужна выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);

  const args = [a, { id: 'p1' }, 'hr-report-ask',
    { topic_kind: 'Выгрузка данных', form_author: 'Anna Sokolova',
      question_text: 'нужна выгрузка владельцев платформ' }];
  const head = runChannelHead(...args);
  const parts = runChannelParts(...args);

  // В канале — одна строка обращения. Три поста подряд на каждое обращение
  // и были той «огромной мешаниной», с которой нельзя работать в чате.
  check('в канале — шапка обращения', head.includes('Выгрузка данных'));
  check('в шапке нет черновика', !head.includes('только действующие'));
  check('в шапке нет ТЗ', !head.includes('mdm_employee_structure_d'));
  check('шапка называет состав треда', head.includes('ТЗ для аналитика'));

  check('три поста в треде: разбор, заказчику, аналитику', parts.length === 3);
  check('первый — разбор', parts[0].includes('**Разбор'));
  check('второй — сообщение заказчику', parts[1].includes('Сообщение заказчику'));
  check('третий — ТЗ', parts[2].includes('ТЗ для аналитика'));
  check('третий помечен «заказчику не отправлять»',
    parts[2].includes('заказчику не отправлять'));

  // Ради чего всё: пост заказчику копируется целиком и в нём нет ни ТЗ,
  // ни служебного. Пока они ехали одним постом, копировать было нечего.
  check('в посте заказчику нет ТЗ', !parts[1].includes('mdm_employee_structure_d'));
  check('в посте заказчику нет служебного', !parts[1].includes('Основание:'));
  check('в посте заказчику нет ссылки на обращение',
    !parts[1].includes('открыть обращение'));
  check('вопрос заказчику на месте', parts[1].includes('только действующие'));

  // Разбор — первым в треде: по нему решают, можно ли брать черновик.
  check('разбор содержит основание', parts[0].includes('Основание:'));
  check('разбор содержит источники', parts[0].includes('export-playbook.md'));

  // Обычный вопрос: в треде два поста, пустого заголовка ТЗ быть не должно —
  // он читался бы как «бот не дописал».
  const usual = runParse('Ответ по существу\nУВЕРЕННОСТЬ: высокая',
    { question: 'что такое ССЧ', mode: 'channel', topic_kind: 'Другое' });
  const usualParts = runChannelParts(usual, { id: 'p2' });
  check('обычный вопрос: два поста в треде', usualParts.length === 2);
  check('обычный вопрос: заголовка ТЗ нет',
    !usualParts.join('\n').includes('ТЗ для аналитика'));
  check('обычный вопрос: шапка не обещает ТЗ',
    !runChannelHead(usual, { id: 'p2' }).includes('ТЗ для аналитика'));

  // Предупреждение об утечке техники печатается джуну в разборе.
  const leaky = runParse([
    'ЧЕРНОВИК ОТВЕТА: возьмём business_dt',
    'ТЗ ДЛЯ АНАЛИТИКА: emart.mdm_employee_structure_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  const leakyParts = runChannelParts(leaky, { id: 'p3' });
  check('утечка названа джуну',
    leakyParts[0].includes('Вычистить перед отправкой') &&
    leakyParts[0].includes('business_dt'));

  // Длина черновика: код МЕРИТ и называет, но текст модели не правит.
  // Живая жалоба заказчика была именно про длину, и промпт её не гарантирует.
  const longDraft = runParse([
    'ЧЕРНОВИК ОТВЕТА: ' + 'Уточните состав выгрузки, пожалуйста. '.repeat(90),
    'ТЗ ДЛЯ АНАЛИТИКА: emart.functional_role_d',
    'УВЕРЕННОСТЬ: высокая',
  ].join('\n'), { question: 'выгрузка', mode: 'channel',
    topic_kind: 'Выгрузка данных' }, {}, MAT_EXPORT);
  check('длинный черновик измерен', longDraft.draft_too_long > 2500);
  check('длина названа джуну',
    runChannelParts(longDraft, { id: 'p4' })[0].includes('Черновик длинный'));
  check('текст черновика не тронут',
    longDraft.draft.includes('Уточните состав выгрузки'));
  // Уверенность это не трогает: длина — про форму, а не про основание.
  check('длина не трогает уверенность', longDraft.confidence_key === 'high');
  check('короткий черновик не помечен', a.draft_too_long === 0);
  // Обычный вопрос длиной не меряется: правило про 1500 знаков — из режима
  // выгрузки, и ответ по существу бывает законно длинным.
  const longUsual = runParse(
    'ЧЕРНОВИК ОТВЕТА: ' + 'Численность считается так. '.repeat(150) +
    '\nУВЕРЕННОСТЬ: высокая', { question: 'как считать', mode: 'channel' });
  check('обычный вопрос длиной не меряется', longUsual.draft_too_long === 0);

  // Личка: ТЗ отдельным постом, чтобы аналитик копировал только первый.
  const dmParts = runDmParts(a);
  check('личка: ТЗ отдельным постом', dmParts.length === 2);
  check('личка: первый пост без ТЗ',
    !dmParts[0].includes('mdm_employee_structure_d'));

  // Чат — отладочный вид: там видно всё, включая ТЗ.
  check('чат показывает ТЗ', runChatMsg(a).includes('ТЗ ДЛЯ АНАЛИТИКА'));
}

console.log('\n' + '='.repeat(70));

// ====================================================================== 31
line('31. ДОСТУП: пробел базы называется конкретно, а не «ответа нет»');
{
  // Ответ по теме «Нет доступа к отчету» в базе должен появиться. Пока его
  // нет, задача для базы обязана называть и что нужно, и где этому лежать —
  // иначе пробел выглядит как «бот не справился».
  const MAT_NO_ACCESS = { ...MAT_OK, masters_only: true,
    articles_read: ['kb/tables/mdm-employee-structure-d.md'],
    router_picked: [] };
  const p = runParse('ЧЕРНОВИК ОТВЕТА: доступы я не выдаю\nУВЕРЕННОСТЬ: нет ответа',
    { question: 'не пускает в дашборд', mode: 'channel',
      topic_kind: 'Нет доступа к отчету' }, {}, MAT_NO_ACCESS);

  const task = p.kb_tasks.find((t) => t.includes('routing.md'));
  check('задача для базы названа', Boolean(task));
  // Задача обязана называть, ЧТО ПРОВЕРИТЬ, а не пересказывать состояние
  // файла: раньше здесь стояло «сейчас там плейсхолдеры ‹…›», а routing.md
  // давно active и без единого ‹. Джуна отправляли чинить то, что уже
  // починено, — и такую задачу перестают читать вместе с остальными.
  check('задача говорит, что проверить',
    task.includes('routing.md') && /добирается кодом|не удалось прочитать/.test(task));
  check('и не пересказывает устаревшее состояние файла',
    !task.includes('плейсхолдер') && !task.includes('‹'));

  // Статья прочитана — задачи нет: пробела больше нет.
  const read = runParse('ЧЕРНОВИК ОТВЕТА: заявка оформляется так\nУВЕРЕННОСТЬ: средняя',
    { question: 'не пускает в дашборд', mode: 'channel',
      topic_kind: 'Нет доступа к отчету' }, {},
    { ...MAT_OK, articles_read: ['kb/process/routing.md'] });
  check('статья прочитана — задачи нет',
    !read.kb_tasks.some((t) => t.includes('routing.md')));

  // Тема не про доступ — задача не выдумывается.
  const other = runParse('ЧЕРНОВИК ОТВЕТА: ответ\nУВЕРЕННОСТЬ: высокая',
    { question: 'что такое ССЧ', mode: 'channel', topic_kind: 'Другое' });
  check('чужая тема задачу не порождает',
    !other.kb_tasks.some((t) => t.includes('routing.md')));
}

// ====================================================================== 33
line('33. ЛИЧКА: причина средней уверенности настоящая, а не одна на всё');
{
  // Живой прогон 2026-08-27: в личке на любой средней уверенности печаталось
  // «определение ещё не подтверждено» — формулировка правила про status:draft,
  // зашитая в код. Ни одна прочитанная статья черновиком не была; средняя
  // стояла из-за неизвестного признака групп доступа. Придуманная причина
  // хуже отсутствующей: её читают и перестают верить всей строке.
  const capped = runDmMsg({
    draft: 'Поле ad_login.', confidence_key: 'medium',
    confidence_claimed: 'high', confidence_capped: true,
    confidence_capped_reason: 'метаданные запрашивались, но не получены',
  });
  check('печатается настоящая причина',
    capped.includes('метаданные запрашивались, но не получены'));
  check('чужая формулировка не подставляется',
    !capped.includes('определение ещё не подтверждено'));

  // Модель сама заявила среднюю, код не понижал: причины у нас нет —
  // и выдумывать её нельзя.
  const claimed = runDmMsg({
    draft: 'Ответ.', confidence_key: 'medium',
    confidence_claimed: 'medium', confidence_capped: false,
    confidence_capped_reason: '',
  });
  check('без понижения причина не выдумывается',
    !claimed.includes('определение ещё не подтверждено') &&
    /перепроверьте/.test(claimed));

  // Пробелы базы адресованы джуну, а не человеку в личке: пути kb/ туда
  // не уезжают ни под каким видом.
  const withGaps = runDmMsg({
    draft: 'Ответ.', confidence_key: 'medium', confidence_capped: false,
    gaps: 'нет статьи в kb/metrics/ с определением ССЧ',
  });
  check('служебное из gaps в личку не уходит', !/kb\//.test(withGaps));
}

// ====================================================================== 32
line('32. ОДИН Service Account во всех воркфлоу');
{
  // 2026-08-27: в живых «DD Lookup» и «Support Bot Core» credential поменяли
  // руками на «…Service Account Support», а сборщик продолжал выдавать
  // «…account 2» — он тянулся из «Support Bot.json», снимка первой
  // конструкции, который давно не трогали. Правка в интерфейсе живёт до
  // следующего импорта, поэтому отказ был бы отложенным и беспричинным
  // на вид: 401 и от каталога, и от чтения статей из GitLab сразу.
  //
  // Проверяется не конкретный id, а СОГЛАСОВАННОСТЬ: id один на все
  // воркфлоу. Смена Service Account — правка одной константы DP_CRED
  // в build_dd_flow.py, а не обход четырёх файлов.
  // ИСХОДНИК ПРОВЕРЯЕТСЯ НАРАВНЕ С СОБРАННЫМ. Прежде тест смотрел только
  // на выход сборщика — а устаревший id лежал во ВХОДЕ, в «Support Bot.json»,
  // и не попадал в проверку вовсе. Держалось всё на одной строке нормализации
  // в build_dd_flow: пропади она, и старый аккаунт снова разъехался бы
  // по трём воркфлоу, а тест остался бы зелёным. Ровно тот же класс, что
  // gs.includes('root_id'): проверялось следствие, а не источник.
  const creds = new Map();      // id → [где встретился]
  for (const [name, wf] of [['DD Lookup', load('DD Lookup.json')],
                            ['Support Bot DD', load('Support Bot DD.json')],
                            ['Support Bot (исходник)', load('Support Bot.json')],
                            ['Support Bot Core', core]]) {
    for (const n of wf.nodes) {
      const c = (n.credentials || {}).devplatformApi;
      if (!c) continue;
      if (!creds.has(c.id)) creds.set(c.id, []);
      creds.get(c.id).push(`${name} / ${n.name}`);
    }
  }
  check('credential вообще проставлен', creds.size > 0);
  check('во всех воркфлоу он ОДИН',
    creds.size === 1,
    creds.size > 1
      ? 'разъехались: ' + [...creds].map(([id, at]) =>
          `${id} → ${at.join(', ')}`).join(' | ')
      : '');
  // Ядро читает GitLab тем же аккаунтом, что DD Lookup ходит в каталог:
  // build_time_flows берёт GITLAB_CRED из собранного «Support Bot DD»,
  // и если нормализация в build_dd_flow пропадёт, разъедется молча именно тут.
  const coreCred = core.nodes.find((n) => n.name === 'Get a file')?.credentials
    ?.devplatformApi?.id;
  check('ядро читает GitLab тем же аккаунтом',
    Boolean(coreCred) && creds.has(coreCred));

  // И тот единственный id обязан быть тем, что объявлен в сборщике: иначе
  // «все четыре согласованы» может значить «все четыре одинаково устарели».
  const builder = fs.readFileSync('build_dd_flow.py', 'utf8');
  const declared = (builder.match(/DP_CRED = \{"devplatformApi": \{"id": "([^"]+)"/) || [])[1];
  check('id объявлен в сборщике', Boolean(declared));
  check('во флоу стоит именно объявленный id', creds.has(declared));
}

// ===================================================================== 34
line('34. ИБ: признак передачи вне контура разбирается из формы');
{
  // Подпись этого поля — 71 символ, то есть в sections она не попадает
  // вовсе: LABEL_RE ограничен 60. Разбор поэтому идёт по строкам, и тест
  // держит именно это — прежний способ дал бы пустое значение молча.
  const form = (answer) => [
    'Cross Data | Выгрузка данных от пользователя @Alisa Pipkina',
    '',
    'Бизнес-задача, решаемая выгрузкой:',
    'нужны логины сотрудников юнита',
    'Выгрузка нужна для использования исключительно внутри группы компаний:',
    answer,
    'Перечисли логины сотрудников, кому необходимо дать доступ к выгрузке:',
    'a.pipkina',
  ].join('\n');

  const post = (message) => ({ id: 'p1', type: '', root_id: '', message });
  const g = (answer) => guardChannel({
    event: 'posted', channel_name: 'hr-report-ask', post: post(form(answer)),
  });

  check('«Нет» при подписи «исключительно внутри» = передача наружу',
    g('Нет, данные будут переданы подрядчику').external_transfer === 'yes');
  check('«Да» при той же подписи = только внутри',
    g('Да').external_transfer === 'no');
  check('короткое «Нет» тоже разбирается', g('Нет').external_transfer === 'yes');
  // \b в JS определён по ASCII и с кириллицей не совпадает НИКОГДА — на этом
  // уже один раз молча потерялся разбор шапки формы.
  check('«Нет.» с точкой разбирается', g('Нет.').external_transfer === 'yes');
  check('невнятный ответ не превращается в догадку',
    g('затрудняюсь ответить').external_transfer === '');
  check('прочитанное видно целиком',
    g('Нет').external_transfer_raw.includes('исключительно внутри'));

  // ОБРАТНАЯ ПОЛЯРНОСТЬ. Переформулируют вопрос — и то же «нет» будет
  // означать ровно противоположное. Полярность читается из подписи.
  const outward = guardChannel({
    event: 'posted', channel_name: 'hr-report-ask',
    post: post([
      'Cross Data | Выгрузка данных от пользователя @ivan',
      'Данные передаются за пределы группы компаний:',
      'Да, партнёру',
    ].join('\n')),
  });
  check('обратная формулировка: «Да» = наружу',
    outward.external_transfer === 'yes');

  // Подпись, из которой полярность не читается: «не разобрано», а не догадка.
  // Перепутанная полярность здесь тише и дороже всего остального во флоу.
  const vague = guardChannel({
    event: 'posted', channel_name: 'hr-report-ask',
    post: post([
      'Cross Data | Выгрузка данных от пользователя @ivan',
      'Как используются данные относительно группы компаний:',
      'Нет',
    ].join('\n')),
  });
  check('непонятная полярность = не разобрано', vague.external_transfer === '');

  // Поля в форме нет вовсе — пусто, а не 'no'.
  const noField = guardChannel({
    event: 'posted', channel_name: 'hr-report-ask',
    post: post('Cross Data | Выгрузка данных от пользователя @ivan\nнужны логины'),
  });
  check('поля нет: пусто, а не «внутри»', noField.external_transfer === '');

  // Проза заказчика с теми же словами подписью не считается: двоеточие
  // обязательно, иначе фраза «работаем внутри группы компаний» в тексте
  // вопроса стала бы ответом на незаданный вопрос.
  const prose = guardChannel({
    event: 'posted', channel_name: 'hr-report-ask',
    post: post([
      'Cross Data | Выгрузка данных от пользователя @ivan',
      'Бизнес-задача, решаемая выгрузкой:',
      'мы работаем внутри группы компаний',
      'Нет',
    ].join('\n')),
  });
  check('проза с теми же словами подписью не считается',
    prose.external_transfer === '');

  // ТА ЖЕ ФОРМА строкой в data.post — вид события, на котором прежний
  // IF-фильтр был зелёным и пропускал всё. Разбор обязан совпадать.
  const packed = guardChannel({
    event: 'posted',
    data: { post: JSON.stringify(post(form('Нет, передаём внешнему аудитору'))) },
  });
  check('строковый пост: признак разобран так же',
    packed.external_transfer === 'yes');
}

// ===================================================================== 35
line('35. ИБ: код МЕРИТ, попало ли требование в черновик, и называет пробел');
{
  const ANSWER = (draft) => `ЧЕРНОВИК ОТВЕТА: ${draft}
ТЗ ДЛЯ АНАЛИТИКА: ТАБЛИЦА: prod_v_emart.mdm_employee_structure_d
ИСТОЧНИКИ: kb/process/export-playbook.md
УВЕРЕННОСТЬ: высокая`;

  const MAT_IB = { ...MAT_OK, is_export: true, ib_required: true,
                   external_transfer: 'yes' };
  const INPUTS = { question: 'выгрузка', mode: 'channel',
                   topic_kind: 'Выгрузка данных' };

  const missed = runParse(
    ANSWER('**Что выгружаем** логины юнита. **Состав файла** логин, ФИО.'),
    INPUTS, {}, MAT_IB);
  check('требование доехало до разбора', missed.ib_required === true);
  check('пропуск замечен', missed.ib_missing === true);
  // Уверенность эта проверка НЕ трогает: основание под ответом от неё
  // не зависит, а понижение испортило бы калибровку — метрику, ради которой
  // пара «заявлено / действует» и хранится. Так же устроены draft_leaks
  // и draft_too_long.
  check('уверенность не тронута', missed.confidence_key === 'high' &&
    missed.confidence_capped === false);

  const stated = runParse(
    ANSWER('**Чего не будет** — файл не передаём, пока информационная ' +
           'безопасность не согласует передачу, заявка в ~sec_analytics_ask.'),
    INPUTS, {}, MAT_IB);
  check('согласование названо — пробела нет', stated.ib_missing === false);
  check('и это видно отдельным полем', stated.ib_stated === true);

  // Формулировок несколько, и требовать одну значит получать ложную тревогу
  // на верном черновике — на неё быстро перестают смотреть.
  const short = runParse(
    ANSWER('**Чего не будет** — до согласования ИБ файл не отдаём.'),
    INPUTS, {}, MAT_IB);
  check('короткая формулировка «согласования ИБ» засчитана',
    short.ib_missing === false);

  // Написано словами, БЕЗ аббревиатуры и БЕЗ имени канала: единственная
  // формулировка, которую не ловит ни одна из двух простых альтернатив.
  // Ровно на ней держалась мёртвая ветка регулярки — «информационн\w*»
  // с ASCII-\w не совпадает с «информационной» никогда, а два соседних
  // случая выше проходили через «~sec_analytics_ask» и через «ИБ»
  // и промах прикрывали. Ложная тревога на верном черновике здесь дороже
  // пропуска: на строку, которая горит всегда, перестают смотреть.
  const spelled = runParse(
    ANSWER('**Чего не будет** — файл не отдаём, пока информационная ' +
           'безопасность не согласовала передачу за пределы группы компаний.'),
    INPUTS, {}, MAT_IB);
  check('согласование словами, без аббревиатуры и канала, засчитано',
    spelled.ib_missing === false);
  const spelledGenitive = runParse(
    ANSWER('**Чего не будет** — нужно согласование информационной ' +
           'безопасности до передачи файла.'),
    INPUTS, {}, MAT_IB);
  check('та же формулировка в родительном падеже засчитана',
    spelledGenitive.ib_missing === false);
  // «ИБ» — не подстрока в любом слове: иначе совпало бы где угодно.
  const falsePositive = runParse(
    ANSWER('**Что выгружаем** сотрудников подразделения Либерти за июль.'),
    INPUTS, {}, MAT_IB);
  check('буквы «иб» внутри слова за согласование не считаются',
    falsePositive.ib_missing === true);

  // Требования не было — поля пустые, лишних строк в тред не уезжает.
  const noReq = runParse(ANSWER('**Что выгружаем** логины юнита.'),
    INPUTS, {}, { ...MAT_OK, is_export: true, ib_required: false,
                  external_transfer: 'no' });
  check('требования нет — пробела нет', noReq.ib_missing === false);
  check('значение из формы всё равно сохранено', noReq.external_transfer === 'no');

  // Джун видит это ПЕРВОЙ строкой разбора: остальное говорит, насколько
  // черновику верить, а эта строка — что его нельзя отправлять как есть.
  const msg = runChannelMsg(missed);
  check('в треде названо', msg.includes('согласования ИБ в черновике нет') ||
    msg.includes('согласования ИБ'));
  check('канал заявки назван', msg.includes('~sec_analytics_ask'));
  const thread = runChannelParts(missed).join('\n');
  const posIb = thread.indexOf('🔒');
  const posBasis = thread.indexOf('**Основание:**');
  check('строка ИБ идёт раньше основания',
    posIb !== -1 && (posBasis === -1 || posIb < posBasis));

  const okMsg = runChannelMsg(stated);
  check('когда согласование названо — строка подтверждает, а не тревожит',
    okMsg.includes('в черновике оно названо'));
  const quiet = runChannelMsg(noReq);
  check('без требования строки ИБ в треде нет', !quiet.includes('🔒'));
}

// ===================================================================== 36
line('36. ЭКСПЕРТ печатается ДЖУНУ вместе с датой подтверждения');
{
  // Эксперт — единственный факт в служебном блоке, который код НЕ проверяет
  // в черновике. Проверить нечем: в реестре «Kirill Seliverstov», а модель
  // напишет «Кирилл Селиверстов», «@k.seliverstov» или «Кириллу» — поиск
  // подстроки дал бы ложную тревогу на верном черновике, ровно то, чем едва
  // не обернулась проверка согласования ИБ. Поэтому маршрут просто печатается,
  // и джун видит его независимо от того, воспользовался им автор или нет.
  const ANSWER = `ЧЕРНОВИК ОТВЕТА: Позову коллегу: квоты ведёт Kirill Seliverstov.
ИСТОЧНИКИ: —
УВЕРЕННОСТЬ: средняя`;
  const ROUTE = { id: 'quotas', who: 'Kirill Seliverstov', where: '',
                  checked: '2026-08-26', matched: ['квот'] };

  const p = runParse(ANSWER, { question: 'кто ведёт квоты', mode: 'channel' }, {},
    { ...MAT_OK, routes: [ROUTE], routes_dropped: [] });
  check('маршрут доехал до разбора', p.routes.length === 1);
  check('дата подтверждения доехала', p.routes[0].checked === '2026-08-26');
  // Понижения за маршрут быть не должно ни в одну сторону: он не пробел базы
  // и не основание под ответом, а дополнительный факт.
  check('уверенность маршрутом не тронута', p.confidence_capped === false);

  const thread = runChannelParts(p).join('\n');
  check('строка эксперта в треде есть', thread.includes('Позвать эксперта по теме'));
  check('эксперт назван', thread.includes('Kirill Seliverstov'));
  // Часть экспертов — сотрудники CrossData: строка про «не наша команда»
  // была бы неверной, и джун переписал бы черновик по ней.
  check('переадресацией это не названо',
    !/не CrossData|не к нам|не наша команда/i.test(thread));
  check('дата подтверждения показана джуну', thread.includes('2026-08-26'));
  check('видно, по какому слову сработало', thread.includes('квот'));

  // Порядок: маршрут после строки ИБ (та говорит, что черновик нельзя
  // отправлять как есть), но раньше основания — это факт про обращение,
  // а не оценка доверия к черновику.
  const iRoute = thread.indexOf('🧭');
  const iBasis = thread.indexOf('**Основание:**');
  check('маршрут раньше основания',
    iRoute !== -1 && (iBasis === -1 || iRoute < iBasis));

  // Дата в ЧЕРНОВИК не идёт: черновик читает коллега, и «напишите Иванову
  // (маршрут проверен 26 августа)» — служебное в черновике, запрещённое
  // отдельным правилом.
  check('даты в черновике нет', !p.draft.includes('2026-08-26'));

  // Строка без даты — не «свежая по умолчанию»: протухший маршрут обязан
  // быть отличим от подтверждённого.
  const stale = runParse(ANSWER, { question: 'кто ведёт квоты', mode: 'channel' }, {},
    { ...MAT_OK, routes: [{ ...ROUTE, checked: '' }], routes_dropped: [] });
  check('без даты это сказано вслух',
    runChannelParts(stale).join('\n').includes('ДАТА ПОДТВЕРЖДЕНИЯ НЕ УКАЗАНА'));

  // Маршрута нет — строки нет. Строка, которая печатается всегда, перестаёт
  // читаться, и вместе с ней перестают читать соседние.
  const quiet = runParse(ANSWER, { question: 'вопрос', mode: 'channel' }, {}, MAT_OK);
  check('без маршрута строки в треде нет',
    !runChannelParts(quiet).join('\n').includes('🧭'));

  // Канал вместо человека — тот же маршрут, а не пустой адресат.
  const chan = runParse(ANSWER, { question: 'воронка найма', mode: 'channel' }, {},
    { ...MAT_OK, routes: [{ id: 'recruitment', who: '', where: '~recruitment_reports_ask',
                            checked: '2026-08-26', matched: ['воронка найма'] }] });
  check('канал напечатан адресом',
    runChannelParts(chan).join('\n').includes('~recruitment_reports_ask'));
}

// ===================================================================== 37
line('37. ВЫГРУЗКА без инвентаря витрины: уверенность понижается и названа');
{
  const ANSWER = `ЧЕРНОВИК ОТВЕТА: Телефона в витрине нет.
ТЗ ДЛЯ АНАЛИТИКА: ТАБЛИЦА: prod_v_emart.mdm_employee_structure_d
ИСТОЧНИКИ: kb/tables/mdm-employee-structure-d.md
УВЕРЕННОСТЬ: высокая`;
  const URN = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d';
  const INPUTS = { question: 'нужны телефоны подрядчиков', mode: 'channel',
                   topic_kind: 'Выгрузка данных' };

  // Живой прогон 2026-08-27: ТЗ утверждало «в метаданных витрины нет поля
  // с мобильным телефоном», имея метаданные ровно одного объекта — отчёта.
  const gap = runParse(ANSWER, INPUTS, {},
    { ...MAT_OK, is_export: true, tables_no_meta: [URN] });
  check('понижено до средней', gap.confidence_key === 'medium');
  check('и понижение зафиксировано', gap.confidence_capped === true);
  check('причина названа витриной',
    /состав полей не получен/i.test(gap.confidence_capped_reason));
  check('заявленное сохранено', gap.confidence_claimed === 'high');
  check('поле доехало до выхода', gap.tables_no_meta.includes(URN));

  // Обычный ВОПРОС статью читает и без инвентаря — понижать там значило бы
  // сделать «среднюю» значением по умолчанию и обесценить сам сигнал.
  const ask = runParse(ANSWER, { question: 'что такое текучесть', mode: 'channel' }, {},
    { ...MAT_OK, is_export: false, tables_no_meta: [URN] });
  check('на обычном вопросе не понижается', ask.confidence_key === 'high');

  // Инвентарь пришёл — понижать не за что.
  const ok = runParse(ANSWER, INPUTS, {},
    { ...MAT_OK, is_export: true, tables_no_meta: [] });
  check('инвентарь пришёл — уверенность не тронута', ok.confidence_key === 'high');

  // Просьба помочь с запросом доезжает до телеметрии отдельным полем:
  // такого типа обращения нет в разрезе по темам формы вовсе.
  const q = runParse(ANSWER, { question: 'как написать select', mode: 'channel' }, {},
    { ...MAT_OK, is_query_help: true });
  check('признак «просят запрос» на выходе ядра', q.is_query_help === true);
}

// ===================================================================== 38
line('38. КАТАЛОГ вызывается ПО РАЗУ НА ОБЪЕКТ, а не пачкой');
{
  // Живой прогон 2026-08-27: запрошено три объекта, пришёл один
  // (dd_received: 1), а задача для базы советовала проверить URN и срок
  // жизни Service Account — то есть чинить не то.
  //
  // Причина в режиме вызова субворкфлоу. У executeWorkflow значение
  // по умолчанию — «Run once with all items», а все три шейпера внутри
  // «DD Lookup» читают вход через .first(): при вызове пачкой разбирается
  // ПЕРВЫЙ объект и молча возвращается один dd_meta на сколько угодно
  // запрошенных. С одним объектом в плане отказ не проявляется вовсе,
  // а Code-ноды тестируются на подставном .all() и до режима не достают —
  // поэтому проверка структурная, по собранному флоу.
  const call = core.nodes.find((n) => n.name === 'Call DD Lookup');
  check('нода каталога есть', Boolean(call));
  check('вызов по разу на объект', call && call.parameters.mode === 'each');
  // Разворачивать список объектов обязательно: без Split DD на входе
  // каталога был бы один элемент-массив, и режим «each» ничего не изменил бы.
  check('список объектов разворачивается перед вызовом',
    core.nodes.some((n) => n.name === 'Split DD'));

  // Внутри DD Lookup вход читается через .first() — то самое, из-за чего
  // пачка теряется. Тест держит связь: пока там .first(), режим обязан
  // быть «each».
  const lookup = JSON.parse(fs.readFileSync('DD Lookup.json', 'utf8'));
  const readsFirst = lookup.nodes.some((n) =>
    typeof n.parameters?.jsCode === 'string' &&
    /\$\('When called by agent'\)\.first\(\)/.test(n.parameters.jsCode));
  check('шейперы каталога читают вход через .first()', readsFirst);
}

// ===================================================================== 39
line('39. «Не доехал до вызова» и «каталог не отдал» — разные диагнозы');
{
  const ANSWER = `ЧЕРНОВИК ОТВЕТА: Ответ.
ИСТОЧНИКИ: kb/metrics/turnover.md
УВЕРЕННОСТЬ: высокая`;
  const A = 'urn:dd:tables:greenplum:table:emart.functional_role_d';

  // Объект не доехал: чинится режим ноды в n8n, а не URN в реестре.
  const missing = runParse(ANSWER, { question: 'вопрос', mode: 'channel' }, {},
    { ...MAT_OK, dd_failed: [A], dd_missing: [A] });
  const tasks = (missing.kb_tasks || []).join(' ');
  check('назван сбой бота, а не пробел базы', /СБОЙ БОТА/.test(tasks));
  check('названа нода и режим', /Call DD Lookup/.test(tasks) && /each item/i.test(tasks));
  check('про URN и Service Account тут не пишем',
    !/срок жизни Service Account/.test(tasks));

  // Каталог ответил, но метаданных не дал — вот тут URN и аккаунт по делу.
  const failed = runParse(ANSWER, { question: 'вопрос', mode: 'channel' }, {},
    { ...MAT_OK, dd_failed: [A], dd_missing: [] });
  const tasks2 = (failed.kb_tasks || []).join(' ');
  check('здесь проверяем URN и аккаунт', /срок жизни Service Account/.test(tasks2));
  check('и это не назвали сбоем бота', !/СБОЙ БОТА/.test(tasks2));
}

// ===================================================================== 40
line('40. ЭКСПЕРТ, КОТОРОГО НЕ ПОДБИРАЛИ, назван в черновике — это видно');
{
  // Живой прогон 2026-08-27: на вопрос «где взять инфу о количестве
  // BI-аналитиков в стриме „Дата“, 15 грейд, юнит Human Capital Origination»
  // бот написал «Подключу в тред @Artur Mermovich». Ни одно ключевое слово
  // маршрута на этом тексте не срабатывает: про деньги там нет ничего,
  // это вопрос про поля ультраширокой витрины. Неверное имя в треде видит
  // ЗАКАЗЧИК, и цена такой ошибки выше, чем у неполного ответа.
  const NAMES = ['Artur Mermovich', 'Kirill Seliverstov', '~recruitment_reports_ask'];
  const ANSWER = (draft) => `ЧЕРНОВИК ОТВЕТА: ${draft}
ИСТОЧНИКИ: —
УВЕРЕННОСТЬ: средняя`;

  const bad = runParse(
    ANSWER('Ответа не нашлось. Подключу в тред @Artur Mermovich.'),
    { question: 'сколько BI-аналитиков 15 грейда', mode: 'channel' }, {},
    { ...MAT_OK, routes: [], route_names: NAMES });
  check('выдуманный эксперт замечен',
    bad.experts_invented.includes('Artur Mermovich'));
  // Уверенность не трогаем — как draft_leaks и ib_missing: основание
  // под ответом от этого не меняется, а понижение испортило бы калибровку.
  check('уверенность не тронута', bad.confidence_capped === false);
  const thread = runChannelParts(bad).join('\n');
  check('джун предупреждён', thread.includes('которого код не подбирал'));
  check('и имя названо', thread.includes('Artur Mermovich'));
  // Раньше маршрута и основания: это не «насколько верить черновику»,
  // а «черновик нельзя отправлять как есть».
  const iFlag = thread.indexOf('🚩');
  const iBasis = thread.indexOf('**Основание:**');
  check('предупреждение раньше основания',
    iFlag !== -1 && (iBasis === -1 || iFlag < iBasis));

  // Маршрут совпал — имя законно, тревоги нет.
  const ok = runParse(
    ANSWER('Квоты ведёт Kirill Seliverstov, позову его в тред.'),
    { question: 'кто ведёт квоты', mode: 'channel' }, {},
    { ...MAT_OK, route_names: NAMES,
      routes: [{ id: 'quotas', who: 'Kirill Seliverstov', where: '',
                 checked: '2026-08-26', matched: ['квот'] }] });
  check('подобранный эксперт тревоги не вызывает',
    ok.experts_invented.length === 0);
  check('и строки в треде нет', !runChannelParts(ok).join('\n').includes('🚩'));

  // Совпал ОДИН маршрут, а назван человек из ДРУГОЙ строки — тоже выдумка.
  const mixed = runParse(
    ANSWER('Квоты ведёт Kirill Seliverstov. Ещё напишите Artur Mermovich.'),
    { question: 'кто ведёт квоты', mode: 'channel' }, {},
    { ...MAT_OK, route_names: NAMES,
      routes: [{ id: 'quotas', who: 'Kirill Seliverstov', where: '',
                 checked: '2026-08-26', matched: ['квот'] }] });
  check('чужая строка таблицы тоже ловится',
    mixed.experts_invented.length === 1 &&
    mixed.experts_invented[0] === 'Artur Mermovich');

  // Имени нет вовсе — тишина. Строка, которая горит всегда, перестаёт
  // читаться, и вместе с ней перестают читать соседние.
  const clean = runParse(ANSWER('Считается по ультраширокой витрине.'),
    { question: 'вопрос', mode: 'channel' }, {},
    { ...MAT_OK, routes: [], route_names: NAMES });
  check('без имён тревоги нет', clean.experts_invented.length === 0);

  // ------------------------------------ инструмент, которого у коллеги нет
  //
  // `get_table_info` — инструмент аналитика в его собственной среде.
  // Упоминаний в базе шесть, и одно из них в `kb/process/sql-conventions.md`,
  // которая доезжает до автора на КАЖДОЙ просьбе помочь с запросом. Правило
  // «коллеге его не предлагать» стоит в промпте, а промпт такие правила
  // роняет первыми — как ронял требование согласования ИБ.
  //
  // draft_leaks эту дыру не закрывает: он считается ТОЛЬКО в режиме
  // выгрузки, а просьба помочь с запросом режим как раз гасит.
  const tool = runParse(
    ANSWER('Состав полей посмотрите через get_table_info по этой витрине.'),
    { question: 'как написать select по сотрудникам', mode: 'channel' }, {},
    { ...MAT_OK, routes: [], route_names: NAMES, is_export: false });
  check('инструмент аналитика замечен вне режима выгрузки',
    tool.draft_own_tools.includes('get_table_info'));
  check('и на уверенность это не влияет', tool.confidence_capped === false);
  const toolThread = runChannelParts(tool).join('\n');
  check('джун предупреждён про инструмент',
    toolThread.includes('инструмент аналитика'));
  const cleanTool = runParse(ANSWER('select mdm_employee_rk from prod_v_emart.t'),
    { question: 'как написать select', mode: 'channel' }, {},
    { ...MAT_OK, routes: [], route_names: NAMES, is_export: false });
  check('обычный запрос тревоги не вызывает', cleanTool.draft_own_tools.length === 0);
}

// ===================================================================== 41
line('41. КАЖДАЯ Code-нода всех флоу парсится как JavaScript');
{
  // Проверка тупая и потому надёжная: скормить new Function КАЖДУЮ Code-ноду
  // каждого собранного флоу. Сборщик пишет JS питоновскими строками, и там
  // легко потерять экранирование — за одну сессию это случилось четырежды:
  // в JS уезжал литерал \\n вместо переноса, а один раз нода вовсе
  // переставала парситься. Ловилось только случайным прогоном именно этой
  // ноды: отдельные тесты есть не у всех, и нода уезжала в n8n сломанной.
  //
  // Синтаксис здесь ловится целиком и независимо от того, покрыта ли нода
  // своим тестом. Поведение — по-прежнему на совести остальных групп.
  const flows = ['Support Bot Core.json', 'DD Lookup.json', 'Adapter Channel.json',
                 'Adapter DM.json', 'Adapter Chat.json'];
  let total = 0;
  for (const f of flows) {
    const wf = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const n of wf.nodes.filter((x) => x.type.endsWith('.code'))) {
      total++;
      let err = '';
      try { new Function('$', '$input', '$json', n.parameters.jsCode); }
      catch (e) { err = e.message; }
      check(`${f.replace('.json', '')} · ${n.name}${err ? ' — ' + err : ''}`, !err);
    }
  }
  check('Code-ноды найдены во всех флоу', total > 10);
}

// ===================================================================== 43
line('43. \\w и \\b рядом с кириллицей — запрещены во ВСЕХ Code-нодах');
{
  // В JS \\w это [A-Za-z0-9_], а \\b считается по нему же. Рядом с кириллицей
  // такая регулярка не совпадает НИКОГДА, при этом читается как верная
  // и выглядит рабочей. Проект наступил на это четыре раза, и все четыре
  // отказа были тихими:
  //   \\bот\\s+пользовател  — в тему уезжала вся шапка формы целиком;
  //   групп\\w*\\s+компан    — подпись поля про передачу вне контура;
  //   информационн\\w*        — ложная тревога «ИБ не упомянут» на верном
  //                            черновике, где всё написано словами;
  //   и первый из них не поймал ни один тест, потому что проверка искала
  //   подстроку в параметрах, а не гоняла код.
  //
  // Правило проекта: кириллический хвост слова пишется классом [а-яё],
  // а \\w и \\b рядом с кириллицей не ставятся вовсе. Тест держит правило
  // по всем собранным флоу разом — включая телеметрию, где тот же JS.
  // Регулярка-детектор написана ЛИТЕРАЛОМ, а не собрана из строки: уровней
  // экранирования тут три (файл → строка → регулярка), и лишний обратный слеш
  // даёт детектор, который не находит ничего и выглядит зелёным.
  const BAD = /[а-яёА-ЯЁ]\\[wb]|\\[wb][*+?]?\s*[а-яёА-ЯЁ]/;
  // Сам детектор проверяется на трёх РЕАЛЬНЫХ регулярках, каждая из которых
  // однажды жила в проде и выглядела рабочей. Без этого зелёный тест ничего
  // не значит: сломанный детектор и чистый код по выводу неразличимы —
  // ровно та ошибка, из-за которой проверка ib_stated была зелёной на
  // мёртвом коде.
  for (const bad of ['/информационн\\w*\\s+безопасност/',
                     '/\\bот\\s+пользовател/',
                     '/групп\\w*\\s+компан/']) {
    check(`детектор ловит ${bad}`, BAD.test(bad));
  }
  for (const good of ['/информационн[а-яё]*\\s+безопасност/',
                      '/\\b(?:select|sql|join)\\b/i',
                      '/[а-яё]+/']) {
    check(`и не ругается на ${good}`, !BAD.test(good));
  }

  let scanned = 0;
  for (const f of ['Support Bot Core.json', 'DD Lookup.json', 'Adapter Channel.json',
                   'Adapter DM.json', 'Adapter Chat.json',
                   '../telemetry/Telemetry Ingest.json',
                   '../telemetry/Telemetry Collector.json',
                   '../telemetry/Telemetry Backfill.json',
                   '../telemetry/Telemetry Collector Tracker.json',
                   '../telemetry/Telemetry Flush.json']) {
    if (!fs.existsSync(f)) continue;
    const flow = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const n of flow.nodes || []) {
      const code = n.parameters && n.parameters.jsCode;
      if (typeof code !== 'string') continue;
      scanned++;
      const hits = [];
      for (const m of code.matchAll(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*/g)) {
        if (BAD.test(m[0])) hits.push(m[0].slice(0, 70));
      }
      check(`${f.split('/').pop().replace('.json', '')} · ${n.name}` +
            (hits.length ? ` — ${hits[0]}` : ''), hits.length === 0);
    }
  }
  check(`Code-ноды просканированы (${scanned})`, scanned > 15);
}

// ===================================================================== 44
line('44. ЛИЧКА: темы нет, потому что нет формы — и режим по ней не включается');
{
  // topic_kind по смыслу — «что человек выбрал в форме», и Plan принимает
  // его как ФАКТ: по нему включается режим выгрузки, и признак «просят
  // помочь с запросом» его намеренно НЕ перебивает.
  //
  // В личке PREFIXES пуст, формы нет вовсе, и туда уезжала ВСЯ первая
  // строка свободного текста. Следствий два, оба тихие: вопрос со словом
  // «выгрузка» включал полный режим (+две статьи, +4500 токенов правил,
  // требование ТЗ), а просьбу написать запрос погасить было нечем —
  // догадкой такой режим не считался. То есть живой отказ 2026-08-27
  // в личке оставался невылеченным.
  const dmFlow = JSON.parse(fs.readFileSync('Adapter DM.json', 'utf8'));
  const gDM = dmFlow.nodes.find((n) => n.name === 'Guard DM').parameters.jsCode;
  const runDM = (msg) => new Function('$json', gDM)({
    event: 'posted',
    data: { post: JSON.stringify({ id: 'p1', root_id: '', message: msg,
                                   channel_type: 'D', user_id: 'u1' }) },
  })[0].json;

  const free = runDM('Подскажи, нужно ли заводить запрос на выгрузку, если разово?');
  check('свободный текст темой не становится', free.topic_kind === '');
  check('обращение при этом проходит', free.pass === true);
  check('и вопрос не потерян', /заводить запрос/.test(free.question));

  // Шапку могут вставить в личку целиком — тогда её восстановит Plan
  // из первой строки самого обращения, и это проверяется ниже прогоном.
  const pasted = runDM('Cross Data | Выгрузка данных от пользователя @Anna\nнужны логины');
  check('автор из вставленной шапки разобран', pasted.form_author === 'Anna');

  // В КАНАЛЕ тема по-прежнему берётся из формы: гейт на префикс, а не отмена.
  const gCH = channel.nodes.find((n) => n.name === 'Guard channel').parameters.jsCode;
  const ch = new Function('$json', gCH)({
    event: 'posted',
    data: { post: JSON.stringify({ id: 'p1', root_id: '',
      message: 'Cross Data | Выгрузка данных от пользователя @Anna\nнужны логины',
      channel_id: 'piyu3cs9xpdwie7nwxje5cwm8r', user_id: 'u1' }) },
  })[0].json;
  check('в канале тема из формы осталась', ch.topic_kind === 'Выгрузка данных');

  // И сквозной прогон: Plan на свободном тексте личку в режим не уводит,
  // а вставленную шапку — уводит, потому что там тема настоящая.
  const REG = fs.readFileSync(REGISTRY_AT, 'utf8');
  const planJs = core.nodes.find((n) => n.name === 'Plan').parameters.jsCode;
  const runPlanWith = (topic_kind, question) => {
    const routed = JSON.stringify({ domains: [], articles: [], dd: [], no_question: false });
    const $ = (n) => ({ first: () => ({ json: {
      'When called by adapter': { question, mode: 'dm', topic_kind },
      'Router': { output: routed },
      'Decode registry': { text: REG, full: REG },
    }[n] }) });
    return new Function('$', '$json', planJs)($, { output: routed })[0].json;
  };
  const q1 = 'Подскажи, нужно ли заводить запрос на выгрузку, если разово?';
  check('вопрос про выгрузку режим не включает',
    runPlanWith(runDM(q1).topic_kind, q1).is_export === false);
  const q2 = 'Cross Data | Выгрузка данных от пользователя @Anna\nнужны логины';
  check('вставленная шапка режим включает',
    runPlanWith(runDM(q2).topic_kind, q2).is_export === true);
}

// ===================================================================== 45
line('45. ВЫДУМАННЫЙ РОУТЕРОМ ПУТЬ — не пробел реестра');
{
  // Путь роутера уезжал в files без сверки с реестром: GitLab отвечал 404,
  // путь попадал в articles_failed, и «Задача для базы» объявляла это
  // расхождением реестра — «реестр ссылается на файл, которого нет».
  // Джуна отправляли чинить строку, которой не существует. Тот же класс,
  // что слитые ddFailed и ddMissing: два диагноза под одним именем,
  // и починка уходит не туда.
  const p = runParse('ЧЕРНОВИК ОТВЕТА: ответа нет\nУВЕРЕННОСТЬ: нет ответа',
    { question: 'сколько зарплат', mode: 'channel' }, {},
    { ...MAT_OK,
      articles_failed: ['kb/tables/mdm-employee-structure-d.md'],
      articles_invented: ['kb/tables/mdm-employee-salary.md'] });
  const reg = p.kb_tasks.find((t) => t.includes('реестр ссылается'));
  const inv = p.kb_tasks.find((t) => t.includes('которого нет в реестре'));
  check('битая строка реестра названа', Boolean(reg));
  check('и в ней только путь ИЗ реестра',
    reg.includes('mdm-employee-structure-d') && !reg.includes('salary'));
  check('промах роутера назван отдельно', Boolean(inv));
  check('и назван промахом роутера, а не пробелом базы',
    inv.includes('промах роутера') && inv.includes('salary'));

  // Ничего не выдумано — второй строки нет: строка, которая горит всегда,
  // перестаёт читаться вместе с соседними.
  const clean = runParse('ЧЕРНОВИК ОТВЕТА: ответ\nУВЕРЕННОСТЬ: высокая',
    { question: 'вопрос', mode: 'channel' }, {},
    { ...MAT_OK, articles_failed: [], articles_invented: [] });
  check('без выдумки строки нет',
    !clean.kb_tasks.some((t) => t.includes('которого нет в реестре')));
}

// ===================================================================== 46
line('46. ЛИЧКА пишет в лог — тем же узлом, что канал, но своим источником');
{
  // До врезки ответы из лички в лог не попадали вовсе: узел Ingest стоял
  // только в адаптере канала. Калибровка считалась по каналу, а в личке
  // спрашивают иначе — без формы, свободным текстом, — и именно там
  // промахи роутера видны лучше всего.
  const ev = dm.nodes.find((n) => n.name === 'Answer event DM');
  const ing = dm.nodes.find((n) => n.name === 'To Ingest DM');
  check('узел события в личке есть', Boolean(ev));
  check('узел записи в лог есть', Boolean(ing));
  // Оба адаптера пишут в ОДИН Ingest: единственная точка записи в лог —
  // это его смысл, и вторая точка означала бы вторую схему таблицы.
  const chIng = channel.nodes.find((n) => n.name === 'To Ingest');
  check('запись идёт в тот же Ingest, что из канала',
    ing.parameters.workflowId.value === chIng.parameters.workflowId.value);
  check('id Ingest не плейсхолдер',
    /^[A-Za-z0-9]{8,}$/.test(String(ing.parameters.workflowId.value)));

  // Ingest объявлен passthrough: пустой маппинг ХУЖЕ отсутствия — он говорит
  // «поля заданы, их ноль», и в лог уехал бы unsupported_event при зелёном
  // флоу. Тот же инвариант, что держит тест 24 для коллектора.
  check('маппинг входов не задан', !('workflowInputs' in ing.parameters));

  // Ветвь отдельная: падение Ingest не должно мешать ответу человеку.
  const fromCore = dm.connections['Call core'].main[0].map((t) => t.node);
  check('запись в лог — отдельная ветвь от ядра',
    fromCore.includes('Answer event DM') &&
    fromCore.includes('Build DM reply'));
  // Ветви не сходятся — иначе узел выполнился бы дважды.
  const targets = Object.values(dm.connections)
    .flatMap((c) => (c.main || []).flatMap((b) => (b || []).map((t) => t.node)));
  const twice = targets.filter((n, i) => targets.indexOf(n) !== i);
  check('ни один узел не получает две ветви', twice.length === 0);

  // ИСТОЧНИК различает канал и личку. У обращения из лички нет ни формы,
  // ни реакций дежурного, ни задачи в трекере: время реакции и решения
  // по нему не считаются, и смешать его с канальным значило бы разбавить
  // каждую метрику процесса строками, у которых этих метрик нет.
  const dmJs = ev.parameters.jsCode;
  const chJs = channel.nodes.find((n) => n.name === 'Answer event').parameters.jsCode;
  check('личка помечена источником dm', /source: "dm"/.test(dmJs));
  check('канал помечен источником core', /source: "core"/.test(chJs));
  check('личка читает свой guard', /\$\("Guard DM"\)/.test(dmJs));
  check('канал читает свой guard', /\$\("Guard channel"\)/.test(chJs));

  // ОДИН ТЕКСТ НА ДВА АДАПТЕРА. Поля payload читает витрина по именам,
  // и вторая копия разъехалась бы с ней молча — ровно так же, как
  // разъезжались credential'ы и списки тем.
  const norm = (t) => t.replace(/"Guard [^"]+"/g, 'G').replace(/"(dm|core)"/g, 'S');
  check('код узлов не разъехался', norm(dmJs) === norm(chJs));

  // Поля payload обязаны совпадать: по ним считается калибровка, и колонка,
  // которую пишет только один адаптер, даёт разрез с дырой.
  const fields = (t) => [...t.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]).sort();
  check('состав payload одинаков',
    JSON.stringify(fields(dmJs)) === JSON.stringify(fields(chJs)));
  check('payload не пуст', fields(dmJs).length > 15);

  // ------------------------------------------------ прогон, а не подстрока
  //
  // Структурных проверок мало: узел может быть на месте и падать. Гоняем
  // его на реальном ответе ядра и реальном событии лички.
  const answer = {
    draft: 'ответ', confidence_key: 'medium', confidence_claimed: 'high',
    confidence_capped: true, confidence_capped_reason: 'метаданные не дошли',
    domains: ['headcount-structure'], articles_read: ['kb/tables/x.md'],
    dd_count: 2, dd_received: 0, dd_never_ran: false, kb_tasks: ['пробел'],
    routes: [], experts_invented: [], draft_own_tools: [], tables_no_meta: [],
    is_query_help: true, router_empty: false,
    articles_invented: 0, draft_leaks: [], draft_len: 5,
  };
  const guardOut = { post: { id: 'dmpost1' }, question: 'вопрос в личке' };
  const $ev = (n) => ({ first: () => ({ json: {
    'Call core': answer, 'Guard DM': guardOut }[n] }) });
  const out = new Function('$', ev.parameters.jsCode)($ev)[0].json;
  check('событие названо bot_answered', out.event === 'bot_answered');
  check('тред — пост из лички', out.thread_id === 'dmpost1');
  check('источник в payload — личка', out.payload.channel_kind === 'dm');
  check('ключ идемпотентности несёт версию промптов',
    out.event_id.startsWith('bot_answered:dmpost1:') &&
    out.event_id.split(':')[2].length > 0);
  // Пара «заявлено / действует» — то, ради чего врезка и делалась.
  check('калибровка доехала',
    out.payload.confidence_claimed === 'high' &&
    out.payload.confidence_key === 'medium' &&
    out.payload.confidence_capped === true);
  check('время проставлено', typeof out.event_ts === 'number' && out.event_ts > 0);
}

// ===================================================================== 47
line('47. В Trino не уезжает синтаксис Postgres');
{
  // Живой прогон 2026-08-28: запрос значений ушёл с ILIKE и не разобрался
  // вовсе — «mismatched input 'ILIKE'». Это оператор Postgres и Greenplum,
  // в Trino его нет. Ошибка была громкой и потому дешёвой, но повторять её
  // незачем: SQL здесь СОБИРАЕТСЯ кодом, а проверить его можно только
  // прогоном — по виду JSON он выглядит как обычная строка.
  //
  // Список узкий намеренно, из подтверждённых различий: широкая проверка
  // «похоже на Postgres» дала бы ложные тревоги на верном запросе, и на неё
  // перестали бы смотреть — как и на всякую строку, которая горит всегда.
  const PG_ONLY = [
    [/\bILIKE\b/i, 'ILIKE — в Trino нет, нужно lower(col) LIKE lower(...)'],
    [/::\s*(?:varchar|text|int|integer|bigint|date|timestamp)\b/i,
     ':: — приведение типа по-постгресовому, в Trino CAST(x AS type)'],
    [/\bnextval\s*\(/i, 'nextval — последовательностей в Trino нет'],
  ];
  // Комментарии выбрасываются перед проверкой: слово ILIKE встречается
  // в объяснениях, почему его нельзя писать, и детектор ловил бы сам текст
  // правила. Ложная тревога на верном коде обесценивает проверку быстрее,
  // чем её отсутствие.
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const sources = [];
  for (const f of ['DD Lookup.json', 'Support Bot Core.json',
                   '../telemetry/Telemetry Flush.json']) {
    if (!fs.existsSync(f)) continue;
    const flow = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const n of flow.nodes || []) {
      const code = n.parameters && n.parameters.jsCode;
      if (typeof code === 'string') {
        sources.push([`${f.split('/').pop()} · ${n.name}`, stripComments(code)]);
      }
      const qy = n.parameters && n.parameters.query;
      if (typeof qy === 'string') sources.push([`${f.split('/').pop()} · ${n.name} (query)`, qy]);
    }
  }
  const sqlFile = '../telemetry/support_request.sql';
  if (fs.existsSync(sqlFile)) {
    // В SQL комментарии свои — двойной дефис.
    sources.push(['support_request.sql', fs.readFileSync(sqlFile, 'utf8')
      .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')]);
  }
  check(`источников SQL просканировано (${sources.length})`, sources.length > 3);
  for (const [where, text] of sources) {
    for (const [re, why] of PG_ONLY) {
      check(`${where}: ${why.split(' —')[0]}`, !re.test(text), re.test(text) ? why : '');
    }
  }

  // Детектор проверен на том, что реально сломалось, — иначе зелёный тест
  // не значит ничего: сломанный детектор и чистый код по выводу неразличимы.
  check('детектор ловит ILIKE',
    PG_ONLY[0][0].test("WHERE CAST(x AS varchar) ILIKE '%а%'"));
  check('и не ругается на LIKE',
    !PG_ONLY[0][0].test("WHERE lower(CAST(x AS varchar)) LIKE '%а%'"));
  check('детектор ловит ::', PG_ONLY[1][0].test('x::varchar'));
  check('и не ругается на CAST', !PG_ONLY[1][0].test('CAST(x AS varchar)'));
}

// ===================================================================== 48
line('48. ЦИКЛ ПОСЛЕ АВТОРА: проводка и общий финал');
{
  const conn = core.connections;
  const out = (n) => (conn[n]?.main || []).map((b) => b.map((e) => e.node));

  // Сабворкфлоу возвращает вызывающему данные ПОСЛЕДНЕГО выполненного узла.
  // Если бы ветви сходились не на общем финале, на ветке «проверять нечего»
  // адаптер получил бы служебный элемент «Need check» вместо разобранного
  // ответа — и в канал уехал бы пустой черновик при зелёном прогоне.
  const terminal = core.nodes
    .filter((n) => !(conn[n.name]?.main || []).some((b) => b.length))
    .map((n) => n.name)
    .filter((n) => !/model$/i.test(n));
  check('терминальный узел ядра ровно один', terminal.length === 1);
  check('и это общий финал', terminal[0] === 'Final answer');

  check('автор ведёт в разбор и дальше в сборку проверки',
    out('Parse answer')[0].includes('Build check SQL'));
  check('гейт разводит на проверку и на финал',
    out('Need check')[0].includes('Check values') &&
    out('Need check')[1].includes('Final answer'));
  check('ветвь проверки заканчивается тем же финалом',
    out('Parse revised')[0].includes('Final answer'));

  // Ветви взаимоисключающие (выходы одного IF), поэтому финал выполняется
  // один раз — это НЕ веер, за которым следит проверка схождения.
  const toFinal = Object.entries(conn)
    .filter(([, c]) => (c.main || []).some((b) => b.some((e) => e.node === 'Final answer')))
    .map(([n]) => n);
  check('в финал ведут ровно две взаимоисключающие ветви',
    toFinal.length === 2 && toFinal.includes('Need check') && toFinal.includes('Parse revised'));

  const cv = core.nodes.find((n) => n.name === 'Check values');
  // Ноль строк — нормальный исход, а n8n на пустом выходе останавливает
  // выполнение. Без флага пустой ответ убил бы конвейер ПОСЛЕ того, как автор
  // отработал и токены уплачены: ровно так ветка значений однажды уже
  // отобрала основной ответ, и по виду прогона это выглядело успехом.
  check('пустой результат не роняет прогон', cv.alwaysOutputData === true);
  check('и отказ запроса тоже', cv.onError === 'continueRegularOutput');
  // У крон-перелива в запасе четверть часа, здесь человек ждёт в чате.
  check('таймаут интерактивный, а не батчевый', cv.parameters.timeout <= 120);

  // Второй проход — правка, а не новый ответ: материалы в него не едут.
  const rev = core.nodes.find((n) => n.name === 'Revise draft').parameters.text;
  check('правка не тянет материалы заново', !/Build materials/.test(rev));
  check('и опирается на свой же черновик', /Parse answer'\)\.first\(\)\.json\.draft/.test(rev));
  check('второго круга проверки нет', /больше не пиши/.test(rev));
  check('в промпте нет висячего слеша', !/\\\s*$/m.test(rev));
}

// ===================================================================== 49
line('49. ОБЩИЙ ФИНАЛ: какой разбор доезжает до адаптера');
{
  const finalJs = core.nodes.find((n) => n.name === 'Final answer').parameters.jsCode;
  const runFinal = (first, revised, plan, res) => {
    const $ = (name) => {
      if (name === 'Parse answer') return { first: () => ({ json: first }) };
      if (name === 'Parse revised') {
        if (!revised) throw new Error('node not executed: Parse revised');
        return { first: () => ({ json: revised }) };
      }
      if (name === 'Build check SQL') {
        if (!plan) throw new Error('node not executed: Build check SQL');
        return { first: () => ({ json: plan }) };
      }
      if (name === 'Check result') {
        if (!res) throw new Error('node not executed: Check result');
        return { first: () => ({ json: res }) };
      }
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', finalJs)($, {})[0].json;
  };

  const FIRST = { draft: 'первый черновик', confidence_key: 'high', sources: 'kb/a.md' };
  const REV = { draft: 'черновик со значениями', confidence_key: 'high', sources: 'kb/a.md' };

  // Цикла не было: ответ первого прохода окончателен, и поля проверки
  // всё равно объявлены — иначе телеметрия не отличит «не спрашивал»
  // от «поле пропало».
  const skip = runFinal(FIRST, null, { check_pairs: [], check_skipped: ['grade (нет)'] }, null);
  check('без цикла доезжает первый разбор', skip.draft === 'первый черновик');
  check('и это видно полем', skip.revised === false);
  check('факт «не спрашивал» отличим от нуля строк',
    skip.check_asked === 0 && skip.check_rows === 0);
  check('отсев посчитан', skip.check_skipped === 1);

  // Цикл был: до адаптера доезжает ПРАВЛЕНЫЙ черновик, а не первый.
  const looped = runFinal(FIRST, REV,
    { check_pairs: [{ field: 'emp_stream_desc' }], check_skipped: [] },
    { check_rows: 12, check_failed: '' });
  check('после цикла доезжает правленый черновик',
    looped.draft === 'черновик со значениями');
  check('и это видно полем', looped.revised === true);
  check('число проверенных пар доехало', looped.check_asked === 1);
  check('и число строк тоже', looped.check_rows === 12);

  // Отказ запроса доезжает текстом: по нему видно, что чинить.
  const failed = runFinal(FIRST, REV,
    { check_pairs: [{ field: 'grade' }], check_skipped: [] },
    { check_rows: 0, check_failed: "mismatched input 'ILIKE'" });
  check('отказ запроса доезжает до телеметрии', /ILIKE/.test(failed.check_failed));

  // Пустой разбор второго прохода не должен подменить нормальный первый.
  const broken = runFinal(FIRST, {}, { check_pairs: [], check_skipped: [] }, null);
  check('пустой второй разбор не затирает первый', broken.draft === 'первый черновик');

  // Поля проверки обязаны быть в витрине или названы неиспользуемыми —
  // тот же инвариант, что тест 37 держит для «Parse answer».
  const view = fs.readFileSync('../telemetry/support_request.sql', 'utf8');
  const fields = [...new Set(
    (finalJs.match(/^\s*out\.([a-z_]+)\s*=/gm) || [])
      .map((m) => m.replace(/^\s*out\./, '').replace(/\s*=$/, '')))];
  check('поля финала найдены детектором', fields.length >= 4);
  const unseen = fields.filter((f) => !view.includes(f));
  check('и каждое читается витриной: ' + (unseen.join(', ') || 'все'), unseen.length === 0);
}

// ===================================================================== 50
line('50. СТРОКА ПРО ЗНАЧЕНИЯ В ТРЕДЕ ДЖУНА');
{
  const run = (extra) => runChannelMsg({
    draft: 'черновик', confidence_key: 'high', sources: 'kb/a.md',
    confidence_basis: ['статей: 2'], ...extra,
  });

  // Не просили — строки нет. Строка, которая горит на каждом обращении,
  // перестаёт читаться: ровно так «ФИО» из шаблона формы обесценила
  // подсказку про самообслуживание.
  check('без проверки строки нет', !/🔢/.test(run({ check_asked: 0 })));

  // Четыре исхода звучат по-разному: подтверждённое данными значение
  // и придуманное иначе выглядят в треде одинаково, а разница между ними —
  // это разница между верной цифрой и молча неверной.
  const ok1 = run({ check_asked: 2, check_rows: 14, revised: true });
  check('сверено и черновик переписан',
    /🔢/.test(ok1) && /переписан/.test(ok1) && /14/.test(ok1));

  const ok2 = run({ check_asked: 1, check_rows: 9, revised: false });
  check('сверено без правок', /правок не потребовалось/.test(ok2));

  const failed = run({ check_asked: 1, check_rows: 0, check_failed: 'Table does not exist' });
  check('отказ назван и значение объявлено неподтверждённым',
    /не удалось/.test(failed) && /НЕ подтверждено/.test(failed));

  const empty = run({ check_asked: 1, check_rows: 0, check_failed: '' });
  check('ноль строк отличим от отказа',
    /строк\s+не вернули/.test(empty) && !/Table does not exist/.test(empty));

  // Порядок: строка про значения раньше основания — она про конкретную
  // цифру в черновике, а основание про доверие к ответу в целом.
  const both = run({ check_asked: 1, check_rows: 5, revised: true });
  check('строка про значения раньше основания',
    both.indexOf('🔢') < both.indexOf('**Основание:**'));
}

// ===================================================================== 51
line('51. НЕПОДТВЕРЖДЁННОЕ ЗНАЧЕНИЕ ПОНИЖАЕТ УВЕРЕННОСТЬ');
{
  const finalJs = core.nodes.find((n) => n.name === 'Final answer').parameters.jsCode;
  const runFinal = (first, plan, res) => {
    const $ = (name) => {
      if (name === 'Parse answer') return { first: () => ({ json: first }) };
      if (name === 'Build check SQL') return { first: () => ({ json: plan }) };
      if (name === 'Check result') {
        if (!res) throw new Error('node not executed: Check result');
        return { first: () => ({ json: res }) };
      }
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', finalJs)($, {})[0].json;
  };
  const HIGH = { draft: 'ответ', confidence_key: 'high', confidence_claimed: 'high',
                 confidence_capped: false, confidence_capped_reason: '' };
  const PLAN = { check_pairs: [{ field: 'emp_specialization_desc' }], check_skipped: [] };

  // Пары код добывает из самого черновика, значит проверка запускается там,
  // где ответ УТВЕРЖДАЕТ что-то о данных. Не подтвердилось — «высокая»
  // относится к значению, которого никто не видел: заказчик скопирует
  // фильтр и получит ноль строк.
  const failed = runFinal(HIGH, PLAN, { check_rows: 0, check_failed: 'Table does not exist' });
  check('отказ проверки понижает до средней', failed.confidence_key === 'medium');
  check('и понижение помечено', failed.confidence_capped === true);
  check('причина названа настоящая, а не выдуманная',
    /Table does not exist/.test(failed.confidence_capped_reason));

  const empty = runFinal(HIGH, PLAN, { check_rows: 0, check_failed: '' });
  check('ноль строк тоже понижает', empty.confidence_key === 'medium');
  check('и звучит иначе, чем отказ',
    /не подтвердилось/.test(empty.confidence_capped_reason));

  // Подтверждённое значение — норма, а не заслуга: повышений в коде нет.
  const okRun = runFinal({ ...HIGH }, PLAN, { check_rows: 12, check_failed: '' });
  check('подтверждённое значение не трогает уверенность',
    okRun.confidence_key === 'high' && okRun.confidence_capped === false);

  // Проверки не было вовсе — понижать не за что.
  const skip = runFinal({ ...HIGH }, { check_pairs: [], check_skipped: [] }, null);
  check('без проверки уверенность не трогается', skip.confidence_key === 'high');

  // Прежняя причина понижения не затирается: их может быть несколько,
  // и джун читает их одной строкой.
  const both = runFinal(
    { ...HIGH, confidence_key: 'medium', confidence_capped: true,
      confidence_capped_reason: 'метаданные не дошли' },
    PLAN, { check_rows: 0, check_failed: 'timeout' });
  check('прежняя причина сохранена',
    /метаданные не дошли/.test(both.confidence_capped_reason) &&
    /timeout/.test(both.confidence_capped_reason));

  // unknown не двигается вообще: это «модель отклонилась от формата»,
  // а не «средняя уверенность» — рядом печатается parse_error.
  const unk = runFinal({ ...HIGH, confidence_key: 'unknown', confidence_claimed: 'unknown' },
    PLAN, { check_rows: 0, check_failed: 'x' });
  check('unknown не подменяется средней', unk.confidence_key === 'unknown');
}

// ===================================================================== 52
line('52. ЗАПРОС БЕЗ ФИЛЬТРА АКТИВНОСТИ — СТРОКА ДЖУНУ');
{
  const run = (extra) => runChannelMsg({
    draft: 'черновик', confidence_key: 'high', sources: 'kb/a.md',
    confidence_basis: ['статей: 2'], ...extra,
  });

  const flagged = run({ draft_no_active_filter: true });
  check('строка есть', /🚩/.test(flagged) && /фильтра активной численности/.test(flagged));
  check('и названо условие целиком',
    /active_employee_flg = 1 and company_fire_flg = 0/.test(flagged));
  check('сказано, почему это не видно по результату',
    /завышенное число/.test(flagged));

  check('на верном черновике строки нет',
    !/фильтра активной численности/.test(run({ draft_no_active_filter: false })));

  // Уверенность проверка НЕ трогает — как draft_leaks и ib_missing:
  // основание под ответом от неё не меняется, а понижение на верном
  // черновике (вопрос про уволенных) испортило бы калибровку.
  const parseSrc = core.nodes.find((n) => n.name === 'Parse answer').parameters.jsCode;
  const capBlock = parseSrc.slice(parseSrc.indexOf('const cap ='));
  check('уверенность не понижается',
    !/draft_no_active_filter/.test(capBlock.split('out.confidence_key =')[0]));

  // Поле обязано читаться витриной — тот же инвариант, что тесты 37 и 49.
  const view = fs.readFileSync('../telemetry/support_request.sql', 'utf8');
  check('поле читается витриной', view.includes('draft_no_active_filter'));
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);
