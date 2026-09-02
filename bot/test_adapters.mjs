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
// База знаний лежит уровнем выше, в одной папке executive-support/ — см. тот же
// резолв в test_pipeline.mjs и объяснение, почему путь ровно один.
const REGISTRY_PATHS = ['../executive-support/kb/index.md'];
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
  // Инвентарь полей приехал — это НОРМАЛЬНЫЙ прогон, и фикстура «всё хорошо»
  // обязана его иметь. Пока его тут не было, каждый тест на MAT_OK выглядел
  // прогоном без инвентаря, и правило «сказано „поля нет“ без инвентаря»
  // срабатывало на чужих сценариях — про отчёт, про эксперта, про маршруты.
  // Тесты, которые проверяют ИМЕННО отсутствие инвентаря, задают tables: []
  // явно у себя.
  tables: [{ name: 'emart.mdm_employee_structure_d',
             fields: ['mdm_employee_rk', 'active_employee_flg'], sens: [] }],
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

// Guard подаётся по умолчанию: в живом прогоне он всегда выполнялся раньше,
// и лог читает у него отправителя. Логин суррогатный — настоящих в репозитории
// не заводим даже в фикстурах.
function runDmLogParts(parsed, guard = { sender_name: 'u.testov' }) {
  const $ = (name) => {
    if (name === 'Call core') return { first: () => ({ json: parsed }) };
    if (name === 'Guard DM') {
      if (guard === null) throw new Error('node not executed');
      return { first: () => ({ json: guard }) };
    }
    throw new Error('node not executed: ' + name);
  };
  return new Function('$', js(dm, 'Build DM log'))($).map((i) => i.json.text);
}
const runDmLog = (parsed, guard) => (guard === undefined
  ? runDmLogParts(parsed)
  : runDmLogParts(parsed, guard)).join('\n');

// Тред под шапкой лога лички: то, что человек реально прочитал.
function runDmLogThread(parsed) {
  const $ = (name) => {
    if (name === 'Call core') return { first: () => ({ json: parsed }) };
    throw new Error('node not executed: ' + name);
  };
  return new Function('$', js(dm, 'Build DM log thread'))($)
    .map((i) => i.json.text).join('\n');
}

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
// --- «Каталог ответил» — понижения за отсутствие статьи не происходит.
//
// Средняя уверенность здесь не оттенок мнения, а ЗАДАЧА: джун читает её как
// «в базе чего-то не хватает». Если имя поля подтвердил каталог, править
// нечего — состав полей в базе жить и не должен.
line('0ж. ЗАКРЫТОЕ КАТАЛОГОМ ПОЛЕ БЕЗ ЗАМКА — ловится поимённо, в любом режиме');
{
  // Живой промах 01.09, ЛИЧКА: бот пометил 🔒 поля, персональные ПО СМЫСЛУ
  // (ФИО, логин, почта), а `disability_flg` не пометил — хотя каталог отдал
  // по нему ярлык EMP_SENS. Данные о здоровье ушли заказчику готовым запросом
  // без оговорки.
  //
  // Прежняя проверка не могла это поймать дважды: гейт `is_export` (в личке
  // формы нет) и условие «в черновике нет НИ ОДНОГО 🔒» — а замки были,
  // просто на других полях.
  const mat = {
    ...MAT_OK,
    tables: [{ name: 'emart.mdm_employee_structure_d',
               fields: ['full_nm', 'disability_flg', 'mdm_employee_rk'],
               sens: ['full_nm', 'disability_flg'] }],
  };
  const DRAFT = 'ЧЕРНОВИК ОТВЕТА: Состав файла:\n' +
    '- full_nm 🔒\n- disability_flg — признак инвалидности\n- mdm_employee_rk\n' +
    'УВЕРЕННОСТЬ: высокая';
  // ЗАМОК В ПРОЗЕ, НО НЕ В ЗАПРОСЕ — это промах 01.09, второй заход.
  // Копируют и запускают select, абзац над ним не переносят.
  const PROSE_ONLY = 'ЧЕРНОВИК ОТВЕТА: Поле disability_flg 🔒 — данные о здоровье.\n' +
    'select\n    mdm_employee_rk\n  , full_nm  -- 🔒 нужен доступ\n  , disability_flg\n' +
    'from prod_v_emart.mdm_employee_structure_d\nwhere disability_flg = 1;\n' +
    'УВЕРЕННОСТЬ: высокая';
  const p = runParse(DRAFT, { question: 'инвалидность', mode: 'dm' }, {}, mat);
  check('незамеченное поле названо поимённо',
    (p.sens_unmarked_fields || []).join() === 'disability_flg');
  check('и признак поднят', p.sens_unmarked === true);
  // Поле с замком не считается пропущенным — иначе строка горела бы всегда.
  check('помеченное поле не попадает в список',
    !(p.sens_unmarked_fields || []).includes('full_nm'));

  const prose = runParse(PROSE_ONLY, { question: 'инвалидность', mode: 'dm' }, {}, mat);
  check('замок в прозе не закрывает голое поле в select',
    (prose.sens_unmarked_fields || []).includes('disability_flg'));
  check('поле с замком в самом select не считается пропущенным',
    !(prose.sens_unmarked_fields || []).includes('full_nm'));

  // Все закрытые помечены — тревоги нет.
  const okDraft = 'ЧЕРНОВИК ОТВЕТА: Состав:\n' +
    'select\n    full_nm  -- 🔒 нужен доступ\n  , disability_flg  -- 🔒 нужен доступ\n' +
    'from t\nwhere disability_flg = 1;\nУВЕРЕННОСТЬ: высокая';
  const ok = runParse(okDraft, { question: 'инвалидность', mode: 'dm' }, {}, mat);
  check('когда всё помечено — признака нет', ok.sens_unmarked === false);
}

line('0е. КАТАЛОГ ОТВЕТИЛ — уверенность не режется за пустой реестр');
{
  const MART_PATH = 'kb/tables/mdm-employee-structure-d.md';
  const HC_PATH = 'kb/metrics/active-headcount.md';
  const SYN_PATH = 'kb/recipes/field-synonyms.md';
  // Механика витрины и фильтр активности едут на КАЖДОМ вопросе — названные
  // в них поля это леса. Словарь синонимов тоже едет всегда, но он не леса:
  // он переводит слово заказчика в имя поля, то есть отвечает по существу.
  const mat = {
    ...MAT_OK,
    masters_only: true,
    router_empty: true,
    router_picked: [],
    materials:
      `=== СТАТЬЯ ${MART_PATH} ===\nКлюч mdm_employee_rk, гранулярность по дням.\n` +
      `=== СТАТЬЯ ${HC_PATH} ===\nФильтр active_employee_flg = 1.\n` +
      `=== СТАТЬЯ ${SYN_PATH} ===\nинвалидность → disability_flg\n` +
      '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:x ===\ndisability_flg\n',
    tables: [{ name: 'emart.mdm_employee_structure_d', sens: [],
               fields: ['mdm_employee_rk', 'active_employee_flg', 'disability_flg'] }],
  };
  const plan = { mechanics_paths: [MART_PATH, HC_PATH] };

  const ok = runParse(
    'ЧЕРНОВИК ОТВЕТА: Признак есть — поле disability_flg.\nУВЕРЕННОСТЬ: высокая',
    { question: 'сотрудники с инвалидностью', mode: 'dm' }, plan, mat);
  check('высокая уверенность сохранена', ok.confidence_key === 'high');
  check('поле названо закрытым каталогом',
    (ok.catalog_only_fields || []).includes('disability_flg'));
  // ЗАДАЧА ДЛЯ БАЗЫ — по тому же условию, что и уверенность. Половина правила
  // хуже целого: джун видит высокую уверенность и рядом задачу завести статью,
  // и не понимает, чего от него хотят. Выполнить её к тому же нельзя — статью
  // про состав полей писать запрещено, поля живут в каталоге.
  check('задачи для базы нет — каталог ответил',
    !(ok.kb_tasks || []).some((t) => /в реестре нет строки под этот вопрос/.test(t)));

  // ГЛАВНОЕ: поле, названное В СЛОВАРЕ, засчитывается. Первая версия правила
  // вычитала любое поле из любой прочитанной статьи — и молчала ровно тогда,
  // когда база отработала лучше всего: словарь перевёл слово заказчика.
  // Условие наказывало за то, за что должно хвалить.
  check('поле из словаря синонимов за леса НЕ считается',
    (ok.catalog_only_fields || []).includes('disability_flg'));

  // Обратная сторона: только леса — понижение остаётся. Иначе «каталог
  // ответил» стало бы истиной на каждом прогоне и сигнал умер бы.
  const bare = runParse(
    'ЧЕРНОВИК ОТВЕТА: Считаем по mdm_employee_rk с active_employee_flg = 1.\nУВЕРЕННОСТЬ: высокая',
    { question: 'сколько людей', mode: 'dm' }, plan, mat);
  check('поля механики за каталог не засчитываются',
    (bare.catalog_only_fields || []).length === 0);
  check('и понижение за пустой реестр остаётся', bare.confidence_key === 'medium');
  check('и задача для базы на голых лесах остаётся',
    (bare.kb_tasks || []).some((t) => /в реестре нет строки под этот вопрос/.test(t)));
  check('причина названа', /реестре нет|роутер не подобрал/.test(
    bare.confidence_capped_reason || ''));
}

// --- «Поля нет» без инвентаря: утверждение, которое никто не перепроверит.
//
// Живой прогон 01.09, ЛИЧКА: метаданные не запрашивались вовсе, а в ответе
// стояло «в полном инвентаре оно не обнаружено». Заказчику ушло, что признака
// в витринах нет; признак есть — disability_flg, ярлык EMP_SENS. Вторым
// заходом бот назвал disability_confirmed_flg — поля, которого не существует.
//
// Правило про отсутствие инвентаря в проекте было, но с гейтом по режиму
// выгрузки, а в личке формы нет — гейт молчал.
line('0д. «ПОЛЯ НЕТ» БЕЗ ИНВЕНТАРЯ — уверенность падает до «нет ответа»');
{
  const noInv = { ...MAT_OK, tables: [] };
  const p1 = runParse(
    'ЧЕРНОВИК ОТВЕТА: Признака инвалидности в витринах нет.\nУВЕРЕННОСТЬ: высокая',
    { question: 'все сотрудники с инвалидностью', mode: 'dm' }, {}, noInv);
  check('уверенность сбита в «нет ответа»', p1.confidence_key === 'none');
  check('причина названа своими словами',
    /инвентарь полей не приходил/.test(p1.confidence_capped_reason || ''));

  // ТО ЖЕ САМОЕ, НО ИНВЕНТАРЬ БЫЛ. Тогда «поля нет» — законный ответ:
  // он опирается на данные, а не на прозу статьи.
  const withInv = { ...MAT_OK,
    tables: [{ name: 'emart.mdm_employee_structure_d', fields: ['a', 'b'], sens: [] }] };
  const p2 = runParse(
    'ЧЕРНОВИК ОТВЕТА: Признака инвалидности в витринах нет.\nУВЕРЕННОСТЬ: высокая',
    { question: 'все сотрудники с инвалидностью', mode: 'dm' }, {}, withInv);
  check('с инвентарём отрицание не наказывается', p2.confidence_key === 'high');

  // И НЕ ЛОВИМ ЛИШНЕГО: ответ без утверждения об отсутствии поля.
  const p3 = runParse(
    'ЧЕРНОВИК ОТВЕТА: Численность считается по active_employee_flg.\nУВЕРЕННОСТЬ: высокая',
    { question: 'сколько людей', mode: 'dm' }, {}, noInv);
  check('обычный ответ без инвентаря не трогаем', p3.confidence_key === 'high');
}

line('0з. ПРОДОЛЖЕНИЕ РАЗГОВОРА: личка тредом, канал по тегу');
{
  // Бот задаёт уточняющие вопросы, и до этой правки ответ на них не читался
  // вовсе: реплика в треде отсеивалась как «не обращение», а человек ждал.
  const dmPost = (message, root) => ({
    channel_type: 'D', sender_name: '@r.kazantsev',
    post: JSON.stringify({ id: 'p2', root_id: root || '', message, channel_id: 'c1' }),
  });

  // ЛИЧКА: ответ в треде — продолжение, тег не нужен. Кроме двоих,
  // в диалоге никого нет, и требовать тег значило бы добавить трение
  // на ровном месте.
  const reply = guardDm(dmPost('по дням', 'p1'));
  check('личка: ответ в треде пропущен', reply.pass === true);
  check('и назван продолжением разговора', reply.is_follow_up === true);
  check('корень треда — для дочитывания', reply.thread_root === 'p1');

  // Новое обращение в личке — по-прежнему обращение, но НЕ продолжение:
  // дочитывать нечего, и лишний HTTP-запрос не нужен.
  const fresh = guardDm(dmPost('нужна выгрузка'));
  check('личка: новый вопрос пропущен', fresh.pass === true);
  check('и продолжением не считается', fresh.is_follow_up === false);
  check('корень треда — он сам', fresh.thread_root === 'p2');

  // КАНАЛ: реплика в треде БЕЗ тега молчит. Там тред живёт своей жизнью —
  // дежурный, согласование, обсуждение, — и бот, отвечающий на всё подряд,
  // стал бы шумом.
  const chPost = (message, root) => ({
    sender_name: '@duty',
    post: JSON.stringify({ id: 'q2', root_id: root || '', message, channel_id: 'c2' }),
  });
  const chatter = guardChannel(chPost('согласовал, выгружаем', 'q1'));
  check('канал: реплика без тега отсеяна', chatter.pass === false);
  check('и причина названа', /реплика в треде/.test(chatter.reason));

  // ТЕГ. В сборке BOT_USERNAME пуст (логин бота — значение окружения),
  // поэтому подставляем его в код guard'а и проверяем саму логику.
  // Без этого правило про тег осталось бы непроверенным до продакшена.
  // Имён у бота НЕСКОЛЬКО: логин латиницей и то, как его зовут люди.
  // Подмена РЕГУЛЯРКОЙ, а не по точному тексту: в сборке с настроенным
  // BOT_USERNAME строка выглядит иначе, подмена молча не срабатывала,
  // и проверка «без имён тег не работает» тестировала настоящие имена.
  // Набор обязан быть зелёным в обеих сборках — иначе настроенная выглядит
  // сломанной, а это ровно то состояние, в которое её и приводят.
  const tagged = (event, names = ['bully', 'Булли']) => new Function('$json',
    js(channel, 'Guard channel').replace(/const MENTION\s*=\s*\[[^\]]*\];/,
      `const MENTION = ${JSON.stringify(names)};`))(event)[0].json;
  const call = tagged(chPost('@bully посмотри тред и ответь', 'q1'));
  check('канал: реплика С тегом пропущена', call.pass === true);
  check('и это продолжение — тред будет дочитан', call.is_follow_up === true);
  check('корень треда взят у реплики', call.thread_root === 'q1');
  // Префикс формы с тега не требуется: человек зовёт бота обычным текстом.
  check('шапка intake-формы для тега не нужна', !/не наша тема/.test(call.reason || ''));

  // Чужой логин, начинающийся так же, бота не будит: `\b` после логина
  // совпал бы и с `@bully_bot`, поэтому ограничитель — «дальше не буква».
  const other = tagged(chPost('@bully_bot сделай что-нибудь', 'q1'));
  check('на чужой похожий логин не отзывается', other.pass === false);

  // ЗОВУТ ПО-РУССКИ. Живой прогон 02.09: в канале написали «@Булли»,
  // и бот промолчал. Кириллица в username Mattermost запрещена, поэтому
  // логин латиницей, а зовут его так, как видно в клиенте. Одно имя
  // в настройке означало выбрать, какое написание работает.
  check('канал: зовут отображаемым именем по-русски',
    tagged(chPost('@Булли посмотри тред', 'q1')).pass === true);
  check('и логином латиницей — тоже',
    tagged(chPost('@bully посмотри тред', 'q1')).pass === true);

  // ГРАНИЦА ИМЕНИ ДЕРЖИТ ОБА АЛФАВИТА. Класс `[a-z0-9_.-]` латинский:
  // на имени «Булли» он пропускал `@Буллика` и `@Буллиан`, потому что
  // кириллическая буква в него не входит и запрет не срабатывал. Тот же
  // капкан, что `\b` по кириллице, только вывернутый наизнанку.
  for (const alien of ['@Буллика привет', '@Буллиан привет', '@Буллидог тут']) {
    check(`чужое имя «${alien.split(' ')[0]}» бота не будит`,
      tagged(chPost(alien, 'q1')).pass === false);
  }

  // Пустой список имён — путь по тегу выключен целиком, и это НЕ падение.
  check('без настроенных имён тег не работает вовсе',
    tagged(chPost('@Булли посмотри', 'q1'), []).pass === false);
}

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
line('13. Лог лички в канал джуна: разбор И сам ответ, дословно');
{
  // Черновик в логе БЫЛ ЗАПРЕЩЁН и теперь обязателен — это смена задачи,
  // а не ослабленная проверка. Лог задумывался для приоритизации пробелов
  // базы: вопрос и «чего не хватило» отвечают на «какой статьи не хватает».
  // Личка при этом — единственный канал, где ответ уходит заказчику без
  // джуна между, и по светофору с пробелом нельзя решить, нужно ли лезть
  // в отладку: промах 01.09 (`management_position_nm` вместо
  // `legal_position_nm`) виден только в тексте ТЗ.
  const p = runParse(`ЧЕРНОВИК ОТВЕТА: Длинный ответ про численность, ради которого лог и читают.
УВЕРЕННОСТЬ: средняя
ЧЕГО НЕ ХВАТИЛО: нет статьи про management_position_d
ТЗ ДЛЯ АНАЛИТИКА: select legal_position_nm from prod_v_emart.mdm_employee_structure_d`, {
    question: 'а декрет где смотреть?',
    mode: 'dm',
  });
  const log = runDmLog(p);
  const thread = runDmLogThread(p);
  console.log(log + '\n--- тред ---\n' + thread);
  check('помечено как личка', log.includes('**Личка**'));
  check('вопрос есть', log.includes('декрет'));
  check('пробел есть', log.includes('management_position_d'));
  // ШАПКА — только разбор. Тремя постами подряд лог забивал канал джуна
  // и читался как три разных обращения.
  check('шапка не тащит ответ за собой',
    !log.includes('Длинный ответ про численность'));

  check('ответ человеку есть дословно — в треде',
    thread.includes('Длинный ответ про численность'));
  check('ответ отбит своим заголовком', thread.includes('Ушло человеку'));
  check('ТЗ в треде есть — в нём и живут промахи по полям',
    thread.includes('legal_position_nm'));
  // Предупреждение об уверенности — часть того, что ПРОЧИТАЛ человек:
  // без него не отличить «бот сказал уверенно» от «бот предупредил».
  check('предупреждение об уверенности видно и в треде',
    thread.includes('Уверенность средняя'));
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
  // КАНАЛ, КОТОРОГО НЕТ В ФИЛЬТРЕ, БОТ НЕ ВИДИТ ВОВСЕ — ни обращения, ни тега.
  //
  // Живой прогон 02.09: в треде канала «DWH HR & Cross Data Ask» написали
  // «@Булли», и бот промолчал. Разбирать там было нечего: пост в этот канал
  // не приходил, потому что канала нет в postedFilters. По виду n8n это
  // неотличимо от «тег не сработал» — Executions пуст в обоих случаях.
  //
  // Тест держит СВЯЗЬ фильтра со сборщиком, а не список каналов: список —
  // значение окружения и меняется без правки кода, а вот триггер, слушающий
  // не то, что объявлено, — это молчание в канале, где бота ждут.
  {
    // ПО ТРИГГЕРУ НА КАНАЛ. Единственная форма этого кастомного узла,
    // подтверждённая живым прогоном, — один триггер, один канал (снимок
    // Time examples.json). Два канала в одном фильтре появились 02.09 —
    // и с того дня прогонов не было: последний 12:33, бота звали в 20:58,
    // 20:59, 21:04 при статусе Published. Регистрирует ли узел вебхук
    // на каждый канал списка — посмотреть негде, и строить на этом
    // единственный путь обращения к боту нельзя.
    const triggers = channel.nodes
      .filter((n) => n.type === 'n8n-nodes-base.mattermostTrigger');
    const chansOf = (n) => (n.parameters.postedFilters.channels || [])
      .map((c) => c.nameAuto?.value).filter(Boolean);
    for (const tr of triggers) {
      check(`«${tr.name}» слушает ровно один канал (${chansOf(tr).join(', ')})`,
        chansOf(tr).length === 1);
      check(`«${tr.name}» ведёт в guard`,
        channel.connections[tr.name]?.main[0]?.[0]?.node === 'Guard channel');
    }
    const listened = triggers.flatMap(chansOf);
    check(`триггеры вместе слушают объявленные каналы (${listened.join(', ')})`,
      listened.includes('hr-report-ask') && listened.includes('stonis_hakcs_2') &&
      new Set(listened).size === listened.length);
    // НА ТРИГГЕРЕ ФИЛЬТРУЕТСЯ ТОЛЬКО КАНАЛ.
    //
    // Разбор 02.09: панель узла предлагает «From author» / «User Names»,
    // и выглядит это как способ «слушать только зов бота». На деле фильтр
    // по АВТОРУ поста: указав там логин бота, получаешь триггер, который
    // срабатывает только на посты самого бота, — сообщения людей не доходят.
    //
    // Причина запрета шире: отсев на триггере МОЛЧАЛИВ. Прогона нет,
    // Executions пуст, «бота не звали» неотличимо от «позвали, а он молчит».
    // Отсев в guard'е оставляет прогон с полем reason. Вся диагностика
    // канала держится на этом различии, и фильтр на триггере её ломает.
    check('на триггере канала нет фильтров, кроме каналов',
      Object.keys(t.parameters.postedFilters).join() === 'channels');
    check('и ни один из них не про автора',
      (t.parameters.postedFilters.channels || [])
        .every((c) => !('userNames' in c) && !('fromAuthor' in c)));

    // Канал черновиков обязан быть среди слушаемых: позвать бота прямо
    // под черновиком — самый естественный способ попросить переделать.
    // Имя берётся у ноды публикации, а не вписывается: канал — значение
    // окружения, и вписанный сюда разъехался бы молча.
    const drafts = channel.nodes.find((n) => n.name === 'Post header')
      .parameters.channelId.value;
    check(`канал черновиков (~${drafts}) тоже слушается`, listened.includes(drafts));

    // ПАСПОРТ СБОРКИ НА ХОЛСТЕ. Предупреждения сборщика читают один раз —
    // в момент сборки, — а разбирают отказ через неделю и в другом месте.
    // 02.09 бота позвали тегом, он промолчал, и ни в n8n, ни в Executions
    // не было ничего: guard отсеял реплику до ядра, а ответ «собрано без
    // BOT_USERNAME» лежал в терминале, которого давно нет.
    //
    // Заметка обязана говорить ПРАВДУ о своей сборке, иначе она хуже
    // отсутствия: по ней перестанут проверять. Поэтому сверяется с тем же
    // guard'ом и тем же триггером, а не с текстом самой себя.
    // СБОРКА, ЛЕЖАЩАЯ В РЕПОЗИТОРИИ, ОБЯЗАНА БЫТЬ РАБОЧЕЙ.
    //
    // Импортируют её как есть, а не пересобирают с переменными окружения —
    // и 02.09 приехал файл с `const MENTION = []`: бота звали в слушаемом
    // канале, guard молча отсеивал реплику, в Executions пусто. Логин бота
    // не секрет и не персональные данные, держать его вне репозитория было
    // не от чего — а цена этого решения оказалась в двух днях разбора.
    check('в собранном флоу путь по тегу ВКЛЮЧЁН',
      JSON.parse(js(channel, 'Guard channel')
        .match(/const MENTION\s*=\s*(\[[^\]]*\])/)[1]).length > 0);

    for (const [name, w] of [['канал', channel], ['личка', dm]]) {
      const note = w.nodes.find((n) => n.type === 'n8n-nodes-base.stickyNote');
      check(`${name}: паспорт сборки на холсте`, Boolean(note));
      const text = note.parameters.content;
      const names = JSON.parse(
        js(w, name === 'канал' ? 'Guard channel' : 'Guard DM')
          .match(/const MENTION\s*=\s*(\[[^\]]*\])/)[1]);
      check(`${name}: паспорт не врёт про тег`,
        names.length
          ? names.every((n) => text.includes('@' + n))
          : /ВЫКЛЮЧЕН/.test(text));
      // Список каналов в паспорте — тот же, что слушает триггер.
      for (const c of listened) {
        check(`${name}: паспорт называет канал ~${c}`, text.includes('~' + c));
      }
    }
  }
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
  // Вопрос — из нормализованного поля guard'а И ПО ИМЕНИ УЗЛА. Проверка
  // на `$json.question` была зелёной ровно до того дня, когда между guard'ом
  // и вызовом ядра встал догоняющий тред: подстрока на месте, вопрос пустой.
  // Что выражение и правда вычисляется в вопрос — прогоном ниже, в блоке 16.
  check('канал: вопрос в ядро из нормализованного поля guard\'а',
    channel.nodes.find((n) => n.name === 'Call core')
      .parameters.workflowInputs.value.question
      === "={{ $('Guard channel').first().json.question }}");

  const dmT = dm.nodes.find((n) => n.name === 'Time Trigger DM');
  check('DM-триггер без фильтра по ИМЕНИ канала',
    !JSON.stringify(dmT.parameters.postedFilters).includes('nameAuto'));
  // ФИЛЬТР ЛИЧКИ ОБЯЗАН БЫТЬ НЕПУСТЫМ. Пустой postedFilters нода не принимает:
  // при активации падает с «All filters are empty» (живой запуск 2026-08-07).
  // До 2026-08-31 сборщик отдавал `{}`, и фильтр «Is Direct Message»
  // выставляли руками ПОСЛЕ КАЖДОГО импорта — ручная правка в интерфейсе
  // живёт ровно до следующего, и натыкались на неё каждый раз заново.
  check('DM: фильтр не пустой — иначе адаптер не активируется',
    Object.keys(dmT.parameters.postedFilters || {}).length > 0);
  check('DM: фильтр — именно «личка», а не канал',
    /isDirectMessage|direct/i.test(JSON.stringify(dmT.parameters.postedFilters)));
  // Отсев при этом держится на guard, а не на триггере: промах в имени
  // значения даёт лишние срабатывания, а не неверные ответы.
  check('DM: guard всё равно требует channel_type D',
    /channel_type/.test(js(dm, 'Guard DM')) && /'D'/.test(js(dm, 'Guard DM')));
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
  // Агентов четыре: роутер, автор, правка черновика после проверки значений
  // и доспрос «какие пары проверять» — он включается кодом только там, где
  // разбор пар промахнулся, а автор сам написал, что значение не проверено.
  // Узел модели у каждого свой — один нельзя развести ai_languageModel-входом
  // на двух агентов.
  check(`у каждого агента свой узел модели (${models.length})`,
    models.length === 4
    && new Set(models.map((m) => m[0])).size === models.length
    && new Set(models.map((m) => m[1])).size === models.length);

  // Реестр попадает только роутеру: автор платил бы за него зря.
  check('реестр только в промпте роутера',
    router.parameters.text.includes('Decode registry')
    && !author.parameters.text.includes('Decode registry'));

  // ============================================ ВХОД ЯДРА НЕ ЧИТАЕТ $json
  //
  // ЖИВОЙ ОТКАЗ 2026-09-02, сразу после переимпорта: бот замолчал на каждом
  // обращении. В трассе `вопрос: —`, роутер вернул `no_question: true`,
  // материалы пустые — и по логу это выглядело как «в базе нет ответа».
  //
  // Причина: `question` читался из `$json`. Работало, пока перед «Call core»
  // стоял guard; появился догоняющий тред — и между ними встал «Build thread»,
  // который отдаёт только переписку. Вопрос стал undefined МОЛЧА: n8n
  // необъявленному полю не сопротивляется, оно просто приезжает пустым.
  //
  // `$json` на входе ядра — это невидимый контракт «слева стоит ровно тот
  // узел, о котором я думаю». Любая вставка в цепочку рвёт его, и рвёт тихо.
  // Тот же класс уже стоил разбора 01.09 дважды: на гейтах и на разворотах
  // списков. Поэтому здесь он запрещён целиком, а не чинится по месту.
  for (const [name, wf] of [['канал', channel], ['личка', dm], ['чат', chat]]) {
    const v = wf.nodes.find((n) => n.name === 'Call core')
      .parameters.workflowInputs.value;
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [k, expr] of Object.entries(v)) {
      if (typeof expr !== 'string' || !expr.startsWith('=')) continue;
      check(`${name}: «${k}» не читает $json`, !/\$json\b/.test(expr));
      // И узел, у которого читают, обязан существовать: опечатка в имени
      // даёт пустое поле, а не ошибку, — то же молчание другим путём.
      for (const m of expr.matchAll(/\$\('([^']+)'\)/g)) {
        check(`${name}: «${k}» читает существующий узел «${m[1]}»`,
          names.has(m[1]));
      }
    }
  }

  // ================================== И ВОПРОС РЕАЛЬНО ДОЕЗЖАЕТ ДО ЯДРА
  //
  // Запрет выше — про форму записи. Этот прогон — про смысл: выражение
  // вычисляется в той обстановке, которая будет в n8n, то есть с $json
  // от УЗЛА, СТОЯЩЕГО СЛЕВА. Именно он в живом отказе и подменился.
  for (const [name, wf, guardName, feeder] of [
    ['канал', channel, 'Guard channel', 'Build thread ch'],
    ['личка', dm, 'Guard DM', 'Build thread DM'],
  ]) {
    // Кто ведёт в «Call core» — берётся из связей, а не вписывается:
    // цепочка ещё будет меняться, и тест обязан следовать за ней.
    const into = Object.entries(wf.connections)
      .filter(([, c]) => (c.main || []).some((br) => (br || [])
        .some((t) => t.node === 'Call core')))
      .map(([src]) => src);
    check(`${name}: в «Call core» ведёт один узел (${into.join(', ')})`,
      into.length === 1 && into[0] === feeder);

    const guardOut = runGuard(wf, guardName, {
      channel_type: name === 'личка' ? 'D' : undefined,
      sender_name: '@r.kazantsev',
      post: JSON.stringify({ id: 'p9', root_id: '', channel_id: 'c9',
        message: 'сколько сотрудников в юните data' }),
    });
    // $json — выход «Build thread»: переписки нет, вопроса в нём тоже нет.
    const passing = { thread: '', thread_posts: 0, thread_state: 'empty' };
    const expr = wf.nodes.find((n) => n.name === 'Call core')
      .parameters.workflowInputs.value.question.slice(1);
    const body = expr.replace(/^\s*\{\{/, '').replace(/\}\}\s*$/, '');
    const got = new Function('$', '$json', `return (${body});`)(
      (n) => ({ first: () => ({ json: { [guardName]: guardOut }[n] ?? {} }) }),
      passing);
    check(`${name}: вопрос доезжает до ядра, а не теряется по пути`,
      got === 'сколько сотрудников в юните data');
  }

  // ============================ ЗОВ ТЕГОМ ОТВЕЧАЕТ ТАМ, ГДЕ ПОЗВАЛИ
  //
  // Обращение по форме и зов тегом — разные разговоры. Первое даёт черновик
  // ДЛЯ ДЖУНА: отдельный пост в канале черновиков, заказчик его не видит.
  // Второе — ответ человеку, который стоит в треде и ждёт его ТАМ.
  //
  // Раньше различия не было: «Post header» всегда создавал новый корневой
  // пост в канале черновиков. Позвали в треде — ответ появлялся в стороне,
  // а в треде тишина, неотличимая от «бот не сработал». В hr-report-ask
  // человек может писать ТОЛЬКО в треде, так что это был единственный
  // способ обратиться к боту — и он же не работал.
  {
    const gate = channel.nodes.find((n) => n.name === 'Called by tag');
    check('развилка по тегу есть', Boolean(gate));
    check('и читает признак у guard\'а по имени узла',
      JSON.stringify(gate.parameters).includes("$('Guard channel')") &&
      JSON.stringify(gate.parameters).includes('mentioned'));

    const t = channel.connections['Called by tag'].main;
    check('ветка «позвали тегом» ведёт к ответу в тред',
      t[0][0].node === 'Build tag reply');
    check('ветка «обращение по форме» — к черновику джуну',
      t[1][0].node === 'Post header');

    const reply = channel.nodes.find((n) => n.name === 'Reply where called');
    // Канал ПО ID из guard'а: слушается несколько каналов, и вписанное имя
    // увело бы ответ в другой — тихо, потому что пост всё равно уйдёт.
    check('ответ уходит в тот канал, где позвали',
      reply.parameters.channelId.mode === 'id' &&
      reply.parameters.channelId.value.includes("$('Guard channel')") &&
      reply.parameters.channelId.value.includes('channel_id'));
    check('и в тот тред, где позвали',
      String(reply.parameters.otherOptions.root_id)
        .includes("$('Guard channel')") &&
      String(reply.parameters.otherOptions.root_id).includes('thread_root'));

    // Телеметрия считает ОБА случая: она висит на шапке, до развилки.
    check('телеметрия не зависит от развилки',
      channel.connections['Build header'].main[0]
        .some((c) => c.node === 'Answer event'));

    // Тело ответа читается у ядра ПО ИМЕНИ УЗЛА: между ядром и этим узлом
    // стоит «Build header», и $json здесь — его выход, а не ответ ядра.
    const body = js(channel, 'Build tag reply');
    check('тело ответа берётся у ядра по имени узла',
      /\$\('Call core'\)/.test(body) && !/\$json\.draft/.test(body));

    // И прогон: узел обязан собрать непустой текст из ответа ядра.
    const out = new Function('$', '$json', body)(
      (n) => ({ first: () => ({ json: { 'Call core': {
        draft: 'Численность считается по active_employee_flg.',
        confidence_key: 'high', tech_spec: '', sources: [], gaps: '',
      } }[n] }) }), {});
    check('ответ на тег собирается непустым',
      out.length >= 1 && /active_employee_flg/.test(out[0].json.text));
  }

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

  const p = runParse(ANSWER, trigger, { domains: ['headcount'] }, mastersOnly);
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
    basis.includes('Стоимость и расходы') && basis.includes('headcount'));

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
  const picked = runParse(ANSWER, trigger, { domains: ['headcount'] }, {
    ...MAT_OK,
    masters_only: false,
    router_picked: ['kb/metrics/legal-headcount.md'],
    asks_report: true,
    report_seen: false,
  });
  check('роутер подобрал статью → средняя', picked.confidence_key === 'medium');
  check('причина всё равно про отчёт', /отч[её]т/.test(picked.confidence_capped_reason));

  // Отчёт РАЗОБРАН (пришли метаданные объекта отчёта) — не понижаем.
  const seen = runParse(ANSWER, trigger, { domains: ['headcount'] }, {
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
line('32б. ОДНА МОДЕЛЬ LLM во всех воркфлоу');
{
  // До 2026-08-31 модель нигде не была записана: узел прокси копировался
  // из «Support Bot.json» — снимка первой конструкции, — и через него алиас
  // доезжал до всех четырёх узлов ядра. Поменять её можно было только руками
  // в n8n, где правка живёт ровно до следующего импорта. Тот же класс, что
  // разъехавшийся Service Account, и лечится так же: одна константа
  // LLM_MODEL в build_dd_flow.py плюс нормализация ВСЕХ узлов прокси.
  //
  // Проверяется согласованность, а не конкретный алиас: смена модели —
  // правка одной константы, а не обход четырёх файлов. Исходник проверяется
  // наравне с собранным: устаревшее значение лежало именно во входе.
  const models = new Map();
  const llmCreds = new Map();
  for (const [name, wf] of [['DD Lookup', load('DD Lookup.json')],
                            ['Support Bot DD', load('Support Bot DD.json')],
                            ['Support Bot (исходник)', load('Support Bot.json')],
                            ['Support Bot Core', core]]) {
    for (const n of wf.nodes) {
      if (!/llmproxy$/i.test(n.type || '')) continue;
      const m = ((n.parameters || {}).model || {}).value || '(пусто)';
      if (!models.has(m)) models.set(m, []);
      models.get(m).push(`${name} / ${n.name}`);
      const c = (n.credentials || {}).openAiApi;
      const cid = c ? c.id : '(нет)';
      if (!llmCreds.has(cid)) llmCreds.set(cid, []);
      llmCreds.get(cid).push(`${name} / ${n.name}`);
    }
  }
  check('узлы прокси вообще есть', models.size > 0);
  check('модель во всех воркфлоу ОДНА',
    models.size === 1,
    models.size > 1
      ? 'разъехались: ' + [...models].map(([m, at]) =>
          `${m} → ${at.join(', ')}`).join(' | ')
      : '');
  check('и она не пустая', !models.has('(пусто)'));
  check('credential прокси тоже один',
    llmCreds.size === 1 && !llmCreds.has('(нет)'));

  // Модель уезжает в телеметрию рядом с версией промпта: калибровка
  // помодельная, а prompt_version — хеш ПРОМПТОВ, и смена модели его
  // не двигает вовсе. Без этой пары две модели сложились бы в одну цифру.
  const model = [...models.keys()][0];
  const ev = js(channel, 'Answer event');
  check('модель уезжает в телеметрию', ev.includes(model));
  const view = fs.readFileSync('../telemetry/support_request.sql', 'utf8');
  check('и витрина её читает', view.includes('$.llm_model'));
  check('и режет калибровку по ней',
    /GROUP BY channel_kind, prompt_version, llm_model/.test(view));
}

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
  //
  // ИСКЛЮЧЕНИЕ ОДНО и оно названо: «Build thread DM» стоит на схождении
  // двух выходов ОДНОГО IF «Need thread DM» — продолжение разговора идёт
  // через чтение треда, новое обращение мимо него. Ветви взаимоисключающие,
  // узел выполняется РАЗ. Это не веер, за которым следит проверка: тот же
  // случай, что «Check values» с двумя входами в ядре.
  const CONVERGE_OK = new Set(['Build thread DM']);
  const targets = Object.values(dm.connections)
    .flatMap((c) => (c.main || []).flatMap((b) => (b || []).map((t) => t.node)));
  const twice = targets.filter((n, i) => targets.indexOf(n) !== i)
    .filter((n) => !CONVERGE_OK.has(n));
  check(`ни один узел не получает две ветви${twice.length ? ': ' + twice.join(', ') : ''}`,
    twice.length === 0);
  // И схождение, которое разрешено, обязано быть выходами одного IF.
  const fromNeed = (dm.connections['Need thread DM'].main || [])
    .map((b) => (b || []).map((t) => t.node));
  check('чтение треда и обход — две ветви одного гейта',
    fromNeed[0].includes('Get thread DM') && fromNeed[1].includes('Build thread DM'));

  // РЕАКЦИЯ «БОТ ДУМАЕТ» — только в личке, и только вокруг ожидания.
  //
  // Порядок в списке связей значим: n8n идёт по ветвям в порядке объявления,
  // а отметка «думаю», поставленная после ответа, бессмысленна. Проверяется
  // именно индекс, а не факт наличия — «стоит первой» и «стоит где-то»
  // здесь разные вещи, и вторая ничего не гарантирует.
  const allowed = dm.connections['DM allowed'].main[0].map((t) => t.node);
  // Ядро теперь зовётся не сразу: между гейтом и им стоит чтение треда.
  // Проверяем то же по смыслу — реакция первой, до всей работы.
  check('реакция ставится ПЕРЕД работой ядра',
    allowed.indexOf('React work in DM') === 0 &&
    allowed.indexOf('React work in DM') < allowed.indexOf('Need thread DM'));
  // Снятие — хвостом за отправкой, а не параллельно: параллельная ветвь
  // могла бы снять отметку раньше, чем ответ уйдёт.
  check('реакция снимается ПОСЛЕ отправки ответа',
    dm.connections['Reply in DM'].main[0][0].node === 'Unreact work in DM');

  const react = dm.nodes.find((n) => n.name === 'React work in DM');
  const unreact = dm.nodes.find((n) => n.name === 'Unreact work in DM');
  check('обе операции реакции на месте',
    react.parameters.operation === 'create' &&
    unreact.parameters.operation === 'delete' &&
    react.parameters.resource === 'reaction');
  check('эмодзи одна и та же на постановке и снятии',
    react.parameters.emojiName === unreact.parameters.emojiName &&
    react.parameters.emojiName === 'bully_work');
  // Реакция — украшение: нет эмодзи на сервере, пуст BOT_USER_ID, сменилось
  // имя поля — ответ человеку всё равно обязан уйти. Без onError падение
  // узла оборвало бы выполнение до «Reply in DM».
  check('падение реакции не роняет ответ',
    react.onError === 'continueRegularOutput' &&
    unreact.onError === 'continueRegularOutput');
  // Реакция вешается на сообщение ЧЕЛОВЕКА, а не на пост бота.
  check('реакция адресована посту из guard\'а',
    /Guard DM.*post\.id/.test(String(react.parameters.postId)) &&
    react.parameters.postId === unreact.parameters.postId);

  // В КАНАЛЕ реакций бота нет — там словарь дежурного, и своя реакция
  // читалась бы как чужое действие. Решение владельца, а не недосмотр.
  check('в канале бот реакций не ставит',
    !channel.nodes.some((n) => n.parameters?.resource === 'reaction'));

  // ЛОГ ЛИЧКИ — ШАПКА ПЛЮС ТРЕД, той же конструкцией, что в канале.
  // Тремя постами подряд он забивал канал джуна и читался как три разных
  // обращения; одно обращение обязано выглядеть одной строкой канала.
  check('тред лога лички идёт за шапкой',
    dm.connections['Log DM to junior channel'].main[0][0].node === 'Build DM log thread' &&
    dm.connections['Build DM log thread'].main[0][0].node === 'Log DM thread');
  const logThread = dm.nodes.find((n) => n.name === 'Log DM thread');
  check('тред привязан к id ОТПРАВЛЕННОЙ шапки, а не к своему',
    /Log DM to junior channel.*\.id/.test(
      String(logThread.parameters.otherOptions?.root_id)));
  // Тот же канал, что и шапка: тред в другом канале — это не тред.
  const logHead = dm.nodes.find((n) => n.name === 'Log DM to junior channel');
  check('шапка и тред уходят в один канал',
    logThread.parameters.channelId.value === logHead.parameters.channelId.value);

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
    domains: ['headcount'], articles_read: ['kb/tables/x.md'],
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

  // ------------------------------------------------ КТО СПРОСИЛ В ЛИЧКЕ
  //
  // В личку приходят вопросы, которых в канале не задают, и разбирать их
  // без имени наполовину бессмысленно: «что спросили» видно, «кто и зачем» —
  // нет. В канале для этого берётся автор формы; в личке формы нет вовсе,
  // и отправитель — сам человек, посредника между ними не стоит.
  const withWho = runDmLog(answer, { sender_name: 'u.testov' });
  check('в шапке лога лички виден отправитель', /\*\*Личка\*\* · @u\.testov/.test(withWho));
  check('и уверенность осталась на месте', /уверенность: средняя/.test(withWho));

  // Имени нет — лог всё равно уходит. Строка без «кто» читается,
  // отсутствующая строка — нет.
  const noWho = runDmLog(answer, { sender_name: '' });
  check('без имени шапка не ломается',
    /\*\*Личка\*\* · уверенность/.test(noWho) && !noWho.includes('@'));
  // И guard, не отдавший ничего, тоже не роняет лог.
  check('без guard\'а лог собирается', /\*\*Личка\*\*/.test(runDmLog(answer, null)));

  // Имя читается ПО ИМЕНИ УЗЛА: между guard'ом и этим узлом уже стоят вызов
  // ядра и сборка ответа, и `$json` здесь — выход совсем другой ноды.
  check('отправитель берётся у guard\'а по имени узла',
    /\$\('Guard DM'\)[^\n]*sender_name/.test(js(dm, 'Build DM log')));
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
  // ГЕЙТЫ НЕ ЧИТАЮТ $json — ТОЛЬКО ПОЛЕ У ЕГО ПРОИЗВОДИТЕЛЯ.
  //
  // $json — это то, что притекло по проводу, и зависит оно от всей цепочки
  // перед гейтом. Узел, вставленный или ВЫКЛЮЧЕННЫЙ между производителем поля
  // и гейтом, молча делает условие ложным навсегда: поля в элементе нет,
  // ветка не идёт никогда, флоу при этом зелёный.
  //
  // Живой прогон 01.09: «Need DD» не пустил метаданные, хотя код их запросил
  // и dd_count в плане стоял. До этого — тот же класс на выключенной вручную
  // «Collect articles». Проверка держит конструкцию, а не дисциплину.
  const gates = core.nodes.filter((n) => n.type.endsWith('.if'));
  check('гейты в ядре есть', gates.length >= 6);
  const fragile = [];
  for (const g of gates) {
    for (const c of g.parameters.conditions.conditions) {
      if (/\$json\./.test(String(c.leftValue))) fragile.push(g.name);
    }
  }
  check(`ни один гейт не читает $json${fragile.length ? ': ' + fragile.join(', ') : ''}`,
    fragile.length === 0);
  // И источник обязан быть РАЗНЫМ у двух гейтов проверки: поле одноимённое,
  // а SQL у них разный — первый до доспроса, второй после.
  const lv = (name) => String(core.nodes.find((n) => n.name === name)
    .parameters.conditions.conditions[0].leftValue);
  check('гейты проверки смотрят каждый на свой сборщик',
    /Build check SQL/.test(lv('Need check')) &&
    /Retry check SQL/.test(lv('Need check after ask')));

  check('терминальный узел ядра ровно один', terminal.length === 1);
  check('и это общий финал', terminal[0] === 'Final answer');

  check('автор ведёт в разбор и дальше в сборку проверки',
    out('Parse answer')[0].includes('Build check SQL'));
  // Ложная ветвь гейта ведёт НЕ в финал, а в доспрос: автор мог сам
  // написать, что значение не проверено, — тогда его об этом и спрашиваем.
  check('гейт разводит на проверку и на доспрос',
    out('Need check')[0].includes('Check values') &&
    out('Need check')[1].includes('Need retry'));
  check('доспрос ведёт в данные через свой сборщик',
    out('Need retry')[0].includes('Ask pairs') &&
    out('Retry check SQL')[0].includes('Need check after ask') &&
    out('Need check after ask')[0].includes('Check values'));

  // Доспрос РОВНО ОДИН: обратной связи в первый сборщик нет по конструкции.
  // Цикл «пока не найдёт» вернул бы счётчик итераций, от которого ушли
  // вместе с tool-loop: два прохода видны по схеме, три — уже нет.
  const backEdges = Object.entries(conn).filter(([n, c]) => /after ask|Retry|Ask pairs|Parse pairs/.test(n)
    && (c.main || []).some((b) => b.some((e) => /^Build check SQL$|^Author$|^Parse answer$/.test(e.node))));
  check('обратной связи в первый сборщик нет', backEdges.length === 0);
  check('ветвь проверки сходится там же, где остальные',
    out('Parse revised')[0].includes('Trace'));

  // ТОЧКА СХОЖДЕНИЯ ПЕРЕЕХАЛА НА «Trace», и это не ослабление проверки.
  // Трассировка стоит В РАЗРЫВЕ перед финалом: сабворкфлоу возвращает данные
  // последнего узла, поэтому «Final answer» обязан остаться последним, а
  // собрать отчёт по всем трём путям надо до него. Смысл проверки прежний:
  // сходятся только взаимоисключающие ветви одного IF, поэтому узел
  // выполняется ОДИН раз — это не веер.
  const toTrace = Object.entries(conn)
    .filter(([, c]) => (c.main || []).some((b) => b.some((e) => e.node === 'Trace')))
    .map(([n]) => n).sort();
  check('в трассировку ведут только взаимоисключающие ветви: ' + toTrace.join(', '),
    toTrace.join() === 'Need check after ask,Need retry,Parse revised');
  const toFinal = Object.entries(conn)
    .filter(([, c]) => (c.main || []).some((b) => b.some((e) => e.node === 'Final answer')))
    .map(([n]) => n).sort();
  check('в финал ведёт ровно одна ветвь — трассировка: ' + toFinal.join(', '),
    toFinal.join() === 'Trace');
  // Два входа у «Check values» — тоже сходящиеся ветви разных IF,
  // а не веер: обычный путь и путь после доспроса исключают друг друга.
  const toCheck = Object.entries(conn)
    .filter(([, c]) => (c.main || []).some((b) => b.some((e) => e.node === 'Check values')))
    .map(([n]) => n).sort();
  check('и в проверку тоже: ' + toCheck.join(', '),
    toCheck.join() === 'Need check,Need check after ask');

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

  const ok2 = run({ check_asked: 1, check_rows: 9, revised: false,
                    check_fields: ['emart.x.emp_stream_desc'] });
  check('сверено без правок', /Правок не потребовалось/.test(ok2));
  // ЧИСЛО ОБЯЗАНО НАЗЫВАТЬ ЕДИНИЦУ ИЗМЕРЕНИЯ. Здесь стояло «сверены
  // с данными (600 строк)», и живой вопрос был ровно такой: что за
  // 600 строк, я такого ответа не вижу. Это размер СЛОВАРЯ ЗНАЧЕНИЙ,
  // а не строки ответа и не найденные сотрудники.
  check('и говорит, что это словарь значений, а не строки ответа',
    /словарь значений/.test(ok2) && /вариантов/.test(ok2));
  check('и по скольким полям он поднят', /1 полям/.test(ok2));

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

// ===================================================================== 53
line('53. УСТАРЕВШАЯ ОГОВОРКА: ПРОСИТ ПРОВЕРИТЬ УЖЕ ПРОВЕРЕННОЕ');
{
  const finalJs = core.nodes.find((n) => n.name === 'Final answer').parameters.jsCode;
  const run = (draft, res) => {
    const $ = (name) => {
      if (name === 'Parse answer') {
        return { first: () => ({ json: { draft, confidence_key: 'high',
                                         confidence_claimed: 'high' } }) };
      }
      if (name === 'Build check SQL') {
        return { first: () => ({ json: { check_pairs: [{ field: 'f' }], check_skipped: [] } }) };
      }
      if (name === 'Check result') return { first: () => ({ json: res }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', finalJs)($, {})[0].json;
  };
  const OK = { check_rows: 12, check_failed: '', check_exact: 1 };

  // Правило стоит в промпте автора и всё равно роняется: живой прогон
  // 2026-08-28 дал эту фразу трижды в одном ответе.
  check('оговорка после успешной проверки названа',
    run('значение нужно уточнить через select distinct', OK).draft_stale_caveat === true);
  check('и в другой формулировке тоже',
    run('точное написание нужно подтвердить значение в витрине', OK)
      .draft_stale_caveat === true);

  // Условие узкое НАМЕРЕННО: не проверяли или проверка отказала — совет
  // коллеге уточнить самому остаётся верным, и тревожить джуна незачем.
  check('при отказе проверки оговорка законна',
    run('уточните через select distinct',
      { check_rows: 0, check_failed: 'Table does not exist' }).draft_stale_caveat === false);
  check('и при нулевом результате тоже',
    run('уточните через select distinct',
      { check_rows: 0, check_failed: '' }).draft_stale_caveat === false);
  check('на чистом черновике молчит',
    run('обычный ответ без оговорок', OK).draft_stale_caveat === false);

  // Строка джуну и колонка витрины.
  const msg = runChannelMsg({ draft: 'ч', confidence_key: 'high',
    confidence_basis: ['x'], draft_stale_caveat: true });
  check('джун видит строку', /осталась просьба уточнить значение/.test(msg));
  check('поле читается витриной',
    fs.readFileSync('../telemetry/support_request.sql', 'utf8')
      .includes('draft_stale_caveat'));
}

// ===================================================================== 54
line('54. ПРОМАХ РАЗБОРА ПАР ОБЪЯВЛЯЕТ СЕБЯ САМ');
{
  const finalJs = core.nodes.find((n) => n.name === 'Final answer').parameters.jsCode;
  const run = (parsed, plan) => {
    const $ = (name) => {
      if (name === 'Parse answer') {
        return { first: () => ({ json: { confidence_key: 'medium',
                                         confidence_claimed: 'medium', ...parsed } }) };
      }
      if (name === 'Build check SQL') return { first: () => ({ json: plan }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', finalJs)($, {})[0].json;
  };
  const NOPAIRS = { check_pairs: [], check_skipped: [],
                    check_reason: 'в черновике нет фильтров по значению' };

  // Пары код достаёт из свободного текста модели, и каждый промах разбора
  // до сих пор был ТИХИМ: сначала гейтом был блок автора, потом имя поля
  // в обратных кавычках. Оба раза в логе стояла честная причина, и оба раза
  // она читалась как «проверять было нечего». Ловим само противоречие:
  // автор пишет, что написание неизвестно, а проверка не запускалась.
  const missed = run({
    draft: 'запрос...',
    gaps: 'Значения полей emp_specialization_desc и residential_city_nm ' +
          'не проверены — точное написание в данных неизвестно.',
  }, NOPAIRS);
  check('противоречие поймано', missed.check_missed === true);
  check('и причина от кода сохранена',
    /нет фильтров по значению/.test(missed.check_reason));

  // Проверка прошла — противоречия нет, что бы ни стояло в gaps.
  check('после реальной проверки не срабатывает',
    run({ draft: 'x', gaps: 'значение не проверено' },
      { check_pairs: [{ field: 'f' }], check_skipped: [], check_reason: '' })
      .check_missed === false);

  // Автор ничего про значения не говорил — проверять и правда было нечего.
  check('на ответе без разговора о значениях молчит',
    run({ draft: 'текучесть считается так-то', gaps: 'нет статьи про X' }, NOPAIRS)
      .check_missed === false);

  // Джун видит строку, и она прямо называет это поломкой бота, а не
  // пробелом базы: чинится в разных местах.
  const msg = runChannelMsg({ draft: 'ч', confidence_key: 'medium',
    confidence_basis: ['x'], check_missed: true,
    check_reason: 'в черновике нет фильтров по значению' });
  check('джун видит строку', /проверка не запускалась/.test(msg));
  check('и причину рядом', /нет фильтров по значению/.test(msg));
  check('названо поломкой бота, а не пробелом базы', /поломка бота/.test(msg));

  const view = fs.readFileSync('../telemetry/support_request.sql', 'utf8');
  check('поля читаются витриной',
    view.includes('check_missed') && view.includes('check_reason'));
}

// ===================================================================== 55
line('55. ПОДМЕНА ЗНАЧЕНИЯ: данные сказали «нет», а в фильтр уехало чужое');
{
  const finalJs = js(core, 'Final answer');
  const runFinal = (first, revised, res) => {
    const $ = (name) => {
      if (name === 'Parse answer') return { first: () => ({ json: first }) };
      if (name === 'Parse revised') {
        if (!revised) throw new Error('node not executed: Parse revised');
        return { first: () => ({ json: revised }) };
      }
      if (name === 'Build check SQL') {
        return { first: () => ({ json: { check_pairs: [{ field: 'x' }], check_skipped: [] } }) };
      }
      if (name === 'Check result') return { first: () => ({ json: res }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', finalJs)($, {})[0].json;
  };

  // ЖИВОЙ КЕЙС 2026-08-31: «сколько сотрудников по покраске HQ и BigOps».
  // Ни «HQ», ни «BigOps» не совпали ни с одним значением поля подразделения,
  // и автор подставил в фильтр три значения из перечня прочих, расписав,
  // какие из них «классические штабные функции». Запрос выполнился и вернул
  // неверные цифры молча, а проверка значений отчиталась успехом: строки-то
  // пришли. Это единственный случай, когда проверка работает ХУЖЕ своего
  // отсутствия — без неё автор хотя бы сказал «не нашёл».
  const RES = {
    check_rows: 8, check_failed: '', check_exact: 0,
    check_rest: {
      lvl3_mapped_management_unit_nm: [
        'Финансы', 'Human Capital', 'Технологии, Безопасность, Операции',
        'Бизнес линии',
      ],
    },
  };
  const FIRST = { draft: 'первый', confidence_key: 'high', confidence_claimed: 'high' };
  const subbed = runFinal(FIRST, {
    draft: "where lvl3_mapped_management_unit_nm in ('Финансы', 'Human Capital')",
    confidence_key: 'high', confidence_claimed: 'high',
  }, RES);
  check('подмена поймана', subbed.check_substituted.length === 2);
  check('и названы конкретные значения',
    subbed.check_substituted.some((x) => x.value === 'Финансы'));
  check('уверенность понижена до средней', subbed.confidence_key === 'medium');
  check('и причина названа',
    /которого заказчик не называл/.test(subbed.confidence_capped_reason));

  // Значение, которое данные ПОДТВЕРДИЛИ, подменой не считается — иначе
  // строка горела бы на верном черновике и её перестали бы читать.
  const fine = runFinal(FIRST, {
    draft: "where emp_specialization_oper_code = 'HQ'",
    confidence_key: 'high', confidence_claimed: 'high',
  }, {
    check_rows: 3, check_failed: '', check_exact: 1,
    check_rest: { emp_specialization_oper_code: ['Line', 'Support'] },
  });
  check('подтверждённое значение подменой не считается',
    fine.check_substituted.length === 0 && fine.confidence_key === 'high');

  // Джун видит строку раньше остальных проверок значений.
  const msg = runChannelParts({
    draft: 'черновик', confidence_key: 'medium', check_asked: 2, check_rows: 8,
    check_substituted: [{ field: 'lvl3_mapped_management_unit_nm', value: 'Финансы' }],
  }).join('\n');
  check('джун видит подмену', /значение, которого заказчик не называл/.test(msg));
  check('и подсказку про неверное поле', /выбрано не то поле/.test(msg));

  const view = fs.readFileSync('../telemetry/support_request.sql', 'utf8');
  check('поле читается витриной', view.includes('check_substituted'));
}

// ===================================================================== 56
line('56. СОГЛАСОВАНИЕ ДОСТУПА: пометка 🔒 вместо раздела «Чего не будет»');
{
  // Запрета на выгрузку у нас нет: за выгрузками в канал приходят как раз те,
  // у кого доступа пока нет, и согласуют его в треде. Раздел «Чего не будет»
  // утверждал обратное — бот говорил «этого не будет», человек шёл
  // согласовывать и получал ровно то, чего «не будет».
  const exportRules = fs.readFileSync('prompts/export.md', 'utf8');
  check('раздела «Чего не будет» в правилах режима больше нет',
    !/\*\*Чего не будет\*\*/.test(exportRules));
  check('вместо него пометка замком',
    /помечаются 🔒 прямо в этом списке/.test(exportRules));
  check('и сказано, что запрета нет',
    /ЗАПРЕТА НА ВЫГРУЗКУ У НАС НЕТ/.test(exportRules));
  // Требование ИБ при передаче наружу — единственное, что осталось жёстким.
  check('но требование ИБ не смягчено',
    /не передаём, пока\n?информационная безопасность не согласовала/.test(exportRules));

  // ТЗ стало готовым запросом: бот уже ходит в данные, и переводить прозу
  // в select руками аналитику больше не нужно.
  check('ТЗ — готовый запрос, а не его описание',
    /ТЗ — ЭТО ГОТОВЫЙ ЗАПРОС/.test(exportRules));
  check('и разделы-дубли убраны',
    /отдельными\nразделами больше НЕ выводятся/.test(exportRules));

  // Поля называются ПОИМЁННО: искать их глазами по составу из двадцати имён
  // джун не станет, а число «закрытых 3» не говорит, какие именно без замка.
  const msg = runChannelParts({
    draft: 'состав файла без пометок', confidence_key: 'high',
    is_export: true, sens_fields: 3, sens_unmarked: true,
    sens_unmarked_fields: ['disability_flg', 'full_nm'],
  }).join('\n');
  check('джун видит НАЗВАННЫМИ непомеченные закрытые поля',
    /Закрыто каталогом, а замка в ответе нет: disability_flg, full_nm/.test(msg));
  check('и формулировка без запрета', /запрета нет, есть согласование/.test(msg));

  const quiet = runChannelParts({
    draft: 'логин 🔒', confidence_key: 'high',
    is_export: true, sens_fields: 3, sens_unmarked: false,
  }).join('\n');
  check('с пометкой строка молчит', !/закрытых полей/.test(quiet));
}

// ===================================================================== 57
line('57. ИМЕНА ЭКСПЕРТОВ — ТОЛЬКО ИЗ ТАБЛИЦЫ МАРШРУТОВ');
{
  // 2026-08-31: на вопросе про скоринг и ревью бот написал «зовите
  // @Artur Mermovich» — человека из платёжной темы, при том что про деньги
  // в обращении не было ни слова. Имя стояло ПРЯМО В ПРОМПТЕ автора, мимо
  // таблицы маршрутов: копия имени рядом с реестром разъезжается молча
  // и срабатывает там, где не должна. Тот же класс, что копия состава полей
  // рядом с каталогом.
  const author = fs.readFileSync('prompts/author.md', 'utf8').toLowerCase();
  const names = [];
  const sec = REGISTRY.slice(REGISTRY.indexOf('## Маршруты'));
  for (const ln of sec.split('\n')) {
    const c = ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    if (c.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(c[4] || '')) continue;
    for (const v of [c[2], c[3]]) {
      if (v && v !== '—') for (const one of v.split(',')) {
        const n = one.trim();
        if (n) names.push(n);
      }
    }
  }
  check('адресаты маршрутов найдены', names.length > 0);
  // Сравниваем и по полному имени, и по фамилии: в реестре «Artur Mermovich»,
  // а в промпте стояло «@a.mermovich» — точное совпадение это не поймало бы.
  const leaked = names.filter((n) => {
    const bare = n.replace(/^[~@]/, '').toLowerCase();
    const last = bare.split(/[\s.]+/).filter(Boolean).pop() || '';
    return author.includes(bare) || (last.length > 4 && author.includes(last));
  });
  check('ни одного имени из таблицы маршрутов нет в промпте автора: ' +
    (leaked.join(', ') || 'чисто'), leaked.length === 0);
  check('и правило прямо запрещает называть имя самому',
    /имя ты не называешь сам/.test(author));
}

// ===================================================================== 58
line('58. РАЗРЕШЕНИЕ ССЫЛКИ НА ЮНИТ СТОИТ ДО АВТОРА');
{
  const conn = core.connections;
  const out = (n) => (conn[n]?.main || []).map((b) => b.map((e) => e.node));
  const byName = (n) => core.nodes.find((x) => x.name === n);

  // Порядок здесь и есть смысл правки: автор не может выполнить запрос,
  // и если разрешение стоит ПОСЛЕ него, ему остаётся только плейсхолдер.
  check('ветка DD ведёт в сборщик запроса по юниту',
    out('Call DD Lookup')[0].includes('Build lookups') &&
    out('Need DD')[1].includes('Build lookups'));
  check('гейт разводит на справочник и мимо него',
    out('Need lookup')[0].includes('Run lookups') &&
    out('Need lookup')[1].includes('Build materials'));
  check('обе ветви сходятся на сборке материалов',
    out('Lookup result')[0].includes('Build materials'));
  check('и всё это ДО автора, а не после',
    out('Build materials')[0].includes('Author'));

  // Веер запрещён: узел за развилкой выполнится по разу на каждую дошедшую
  // ветвь, и два выполнения «Build materials» дали бы два вызова автора.
  for (const n of ['Build lookups', 'Run lookups', 'Lookup result']) {
    check(`${n} не ветвится на два узла`,
      (conn[n]?.main || []).every((b) => b.length <= 1));
  }

  const ru = byName('Run lookups');
  const cv = byName('Check values');
  check('справочник спрашивается той же нодой Trino, что и значения',
    ru.type === cv.type && ru.typeVersion === cv.typeVersion);
  check('и тем же credential — вторая копия разъехалась бы молча',
    JSON.stringify(ru.credentials) === JSON.stringify(cv.credentials));
  check('запрос берётся из сборщика, а не пишется в ноде',
    ru.parameters.query === '={{ $json.lookup_sql }}');
  // Ноль строк — осмысленный исход («такого id в справочнике нет»), а n8n
  // на пустом выходе останавливает выполнение. Без флага ненайденный юнит
  // убивал бы конвейер ДО автора, и в канале это «бот промолчал».
  check('пустой ответ не роняет прогон', ru.alwaysOutputData === true);
  check('и отказ справочника тоже', ru.onError === 'continueRegularOutput');
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);
