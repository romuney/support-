// Прогон Code-нод конвейера ядра на подставных данных.
//
// Проверяет то, что в конвейере заменило уговоры в промпте:
//   Plan             — разбор JSON роутера и ДОБОР МАСТЕРОВ ДОМЕНА кодом;
//   Collect articles — свёртка поштучного чтения обратно в поля плана;
//   Build materials  — склейка статей и метаданных, честность заметок о пробелах.
//
// Запуск: node test_pipeline.mjs
import fs from 'fs';

const core = JSON.parse(fs.readFileSync('Support Bot Core.json', 'utf8'));
const js = (n) => {
  const node = core.nodes.find((x) => x.name === n);
  if (!node) throw new Error(`нет ноды ${n}`);
  return node.parameters.jsCode;
};

// Настоящий реестр: тесты мастеров должны ломаться, когда таблица «Домены»
// в kb/index.md изменится, а код разбора — нет.
//
// База знаний лежит уровнем выше — рядом с bot/ и telemetry/. Мест два:
// отдельным репозиторием executive-support/ и просто папкой kb/. Проверяем
// оба и говорим, чего не нашли: молча взять пустой реестр значит получить
// зелёные тесты мастеров на нулевой таблице «Домены».
const REGISTRY_PATHS = ['../executive-support/kb/index.md', '../kb/index.md'];
const REGISTRY_AT = REGISTRY_PATHS.find((p) => fs.existsSync(p));
if (!REGISTRY_AT) {
  console.error('не найден реестр базы знаний, искали: ' + REGISTRY_PATHS.join(', '));
  process.exit(1);
}
const REGISTRY = fs.readFileSync(REGISTRY_AT, 'utf8');

let fails = 0;
const line = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fails++;
};

// --- Plan: на входе вывод роутера, реестр берётся из Decode registry.
// trigger — поля intake-формы: по topic_kind «Выгрузка данных» план добирает
// плейбук и развилку витрины так же, как мастеров домена.
function runPlan(routerOutput, registry = REGISTRY, trigger = {}) {
  const $ = (name) => {
    if (name === 'Decode registry') return { first: () => ({ json: { text: registry } }) };
    if (name === 'When called by adapter') return { first: () => ({ json: trigger }) };
    throw new Error('node not executed: ' + name);
  };
  return new Function('$', '$json', js('Plan'))($, { output: routerOutput })[0].json;
}

// --- Build materials: articles === null означает, что ветка чтения не
// выполнялась и $() должна бросить — ровно так ведёт себя n8n.
// dd — массив результатов DD Lookup, по одному на объект (Split DD + вызов
// на каждый). null означает, что ветка DD в прогоне не выполнялась и $() должна
// бросить — ровно так ведёт себя n8n на невыполненной ноде.
// trigger — поля intake-формы, разобранные guard'ом адаптера. Пустые значения
// это норма (личка и чат формы не знают), поэтому по умолчанию их нет.
function runMaterials(plan, articles = null, dd = null, trigger = {}) {
  const $ = (name) => {
    if (name === 'Plan') return { first: () => ({ json: plan }) };
    if (name === 'When called by adapter') return { first: () => ({ json: trigger }) };
    if (name === 'Read article') {
      if (articles === null) throw new Error('node not executed');
      return { all: () => articles.map((json) => ({ json })) };
    }
    if (name === 'Call DD Lookup') {
      if (dd === null) throw new Error('node not executed');
      return { all: () => dd.map((json) => ({ json })) };
    }
    throw new Error('node not executed: ' + name);
  };
  return new Function('$', '$json', js('Build materials'))($, {})[0].json;
}

const URN_TABLE = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d';
const URN_LEGAL = 'urn:dd:tables:greenplum:table:emart.legal_position_d';
const URN_REPORT = 'urn:dd:reports:helicopter:note:12345';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ====================================================================== 1
line('1. МАСТЕРА ДОМЕНА добираются кодом, а не промптом');
{
  // Роутер назвал домен и одну узкую статью. Мастера headcount-structure —
  // t-emp-structure, m-legal-headcount, rc-structure-choice — код обязан
  // добавить сам, иначе основание неполное.
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure'],
    articles: ['kb/metrics/active-headcount.md'],
    dd_urn: '',
    field_hint: '',
    no_question: false,
  }));
  check('мастер t-emp-structure добавлен',
    p.files.includes('kb/tables/mdm-employee-structure-d.md'));
  check('мастер m-legal-headcount добавлен',
    p.files.includes('kb/metrics/legal-headcount.md'));
  check('мастер rc-structure-choice добавлен',
    p.files.includes('kb/recipes/structure-choice.md'));
  check('статья роутера сохранена',
    p.files.includes('kb/metrics/active-headcount.md'));
  check('мастера идут ПЕРЕД статьёй роутера',
    p.files.indexOf('kb/tables/mdm-employee-structure-d.md')
      < p.files.indexOf('kb/metrics/active-headcount.md'));
  check('добор мастеров виден в отчёте', p.added_masters.length === 3);
}

// ====================================================================== 2
line('2. ДВА ДОМЕНА — мастера обоих');
{
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure', 'legal'],
    articles: [],
    dd_urn: '',
    field_hint: '',
    no_question: false,
  }));
  check('мастер legal добавлен', p.files.includes('kb/tables/legal-position-d.md'));
  check('мастер headcount добавлен',
    p.files.includes('kb/tables/mdm-employee-structure-d.md'));
  check('общий мастер не задвоен',
    p.files.filter((f) => f === 'kb/metrics/legal-headcount.md').length === 1);
}

// ====================================================================== 3
line('3. МАСТЕР БЕЗ СТАТЬИ не попадает в план');
{
  // t-functional-role — мастер домена allocation, но путь в реестре «—».
  // Такой мастер нельзя ни прочитать, ни подставить: путь «—» в GitLab-ноду
  // уехал бы ошибкой чтения и выглядел как «файл недоступен».
  const p = runPlan(JSON.stringify({
    domains: ['allocation'],
    articles: [],
    dd_urn: '',
    field_hint: '',
    no_question: false,
  }));
  check('прочерк не попал в план', !p.files.includes('—'));
  check('мастер со статьёй добавлен', p.files.includes('kb/metrics/fte-by-product.md'));
  check('в плане только реальные пути', p.files.every((f) => f.startsWith('kb/')));
}

// ====================================================================== 4
line('4. ВЫВОД РОУТЕРА В ЗАБОРЕ ```json — разбирается');
{
  const p = runPlan('```json\n{"domains":["movement"],"articles":["kb/metrics/turnover.md"],'
    + '"dd_urn":"","field_hint":"","no_question":false}\n```');
  check('без ошибки разбора', !p.router_error);
  check('статья взята', p.files.includes('kb/metrics/turnover.md'));
  check('мастер movement добавлен',
    p.files.includes('kb/recipes/cohort-analysis.md'));
}

// ====================================================================== 5
line('5. СЛОМАННЫЙ вывод роутера не роняет флоу и НЕ МОЛЧИТ');
{
  const p = runPlan('Я не смог определить домен, извините.');
  check('план пустой', p.files.length === 0);
  check('причина названа', /не удалось разобрать план/.test(p.router_error));
  check('сырой вывод сохранён для лога', p.router_raw.length > 0);

  const m = runMaterials(p);
  check('автор предупреждён о сбое', /Планирование сбилось/.test(m.materials));
  check('автор предупреждён, что статей нет', /Статей по вопросу/.test(m.materials));
}

// ====================================================================== 6
line('6. ЛИМИТ ОБЪЁМА: обрезанное названо, а не выброшено молча');
{
  const many = Array.from({ length: 12 }, (_, i) => `kb/metrics/x${i}.md`);
  const p = runPlan(JSON.stringify({
    domains: [], articles: many, dd_urn: '', field_hint: '', no_question: false,
  }));
  check('план обрезан до 8', p.files.length === 8);
  check('обрезанное перечислено', p.dropped.length === 4);

  const m = runMaterials(p, [{ content: b64('# статья') }]);
  check('автор знает про обрезку', /По лимиту объёма не читались/.test(m.materials));
  check('названы конкретные файлы', /kb\/metrics\/x8\.md/.test(m.materials));
}

// ====================================================================== 7
line('7. НЕЧИТАЕМАЯ статья — расхождение реестра, а не пробел базы');
{
  const p = runPlan(JSON.stringify({
    domains: [], articles: ['kb/metrics/turnover.md', 'kb/metrics/ghost.md'],
    dd_urn: '', field_hint: '', no_question: false,
  }));
  const m = runMaterials(p, [
    { content: b64('# Текучесть\nУволенные / средняя численность.') },
    { error: '404 not found' },
  ]);
  check('прочитанная статья вклеена', /Уволенные \/ средняя численность/.test(m.materials));
  check('нечитаемая названа', /kb\/metrics\/ghost\.md/.test(m.materials));
  check('формулировка про расхождение реестра',
    /Реестр ссылается на файл, которого нет/.test(m.materials));
  check('в отчёте разделены прочитанные и нет',
    m.articles_read.includes('kb/metrics/turnover.md')
      && m.articles_failed.includes('kb/metrics/ghost.md'));
}

// ====================================================================== 8
line('8. МЕТАДАННЫЕ DD вклеиваются, когда ветка выполнялась');
{
  const p = runPlan(JSON.stringify({
    domains: [], articles: ['kb/tables/mdm-employee-structure-d.md'],
    dd: [{ urn: URN_TABLE, hint: 'business_dt' }], no_question: false,
  }));
  check('план DD разобран', p.dd.length === 1 && p.dd[0].urn === URN_TABLE);
  check('hint сохранён', p.dd[0].hint === 'business_dt');
  check('dd_count для IF', p.dd_count === 1);

  const m = runMaterials(
    p,
    [{ content: b64('# Витрина\nГранулярность: сотрудник × день.') }],
    [{ dd_meta: 'ОБЪЕКТ DD: mdm_employee_structure_d\nПОЛЕ business_dt: date — Дата среза' }],
  );
  check('метаданные вклеены', /ПОЛЕ business_dt/.test(m.materials));
  check('блок подписан своим URN',
    m.materials.includes(`=== МЕТАДАННЫЕ КАТАЛОГА: ${URN_TABLE} ===`));
  check('статья тоже на месте', /Гранулярность/.test(m.materials));
  check('dd_used выставлен', m.dd_used === true);
  check('лишних заметок нет', !/СЛУЖЕБНЫЕ ЗАМЕТКИ/.test(m.materials));
}

// ===================================================================== 8б
line('8б. НЕСКОЛЬКО объектов DD: отчёт + витрина под ним');
{
  // Кейс, ради которого мультивызов и делался: по отчёту видно готовое решение,
  // по витрине — из чего оно считается.
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure'],
    articles: [],
    dd: [{ urn: URN_REPORT, hint: '' }, { urn: URN_TABLE, hint: 'численность' }],
    no_question: false,
  }));
  check('оба объекта в плане', p.dd.length === 2);
  check('порядок сохранён: отчёт первым', p.dd[0].urn === URN_REPORT);
  check('свой hint у каждого', p.dd[0].hint === '' && p.dd[1].hint === 'численность');

  const m = runMaterials(p, [{ content: b64('# Мастер') }], [
    { dd_meta: 'ОБЪЕКТ DD: Отчёт по численности\nССЫЛКА: https://helicopter/note/1' },
    { dd_meta: 'ОБЪЕКТ DD: mdm_employee_structure_d\nПОЛЕ active_employee_flg' },
  ]);
  check('метаданные отчёта вклеены', /Отчёт по численности/.test(m.materials));
  check('метаданные витрины вклеены', /active_employee_flg/.test(m.materials));
  check('блок отчёта подписан', m.materials.includes(`КАТАЛОГА: ${URN_REPORT}`));
  check('блок витрины подписан', m.materials.includes(`КАТАЛОГА: ${URN_TABLE}`));
  check('оба объекта в отчёте', m.dd_objects.length === 2);
  check('автор предупреждён не смешивать поля',
    /относятся ТОЛЬКО к нему/.test(m.materials));
}

// ===================================================================== 8в
line('8в. ОДИН из двух объектов не ответил — назван именно он');
{
  const p = runPlan(JSON.stringify({
    domains: [], articles: [],
    dd: [{ urn: URN_TABLE, hint: 'grade' }, { urn: URN_LEGAL, hint: 'position' }],
    no_question: false,
  }));
  const m = runMaterials(p, null, [
    { dd_meta: 'ОБЪЕКТ DD: mdm_employee_structure_d\nПОЛЕ grade_nm' },
    { dd_meta: '' },
  ]);
  check('успешный объект вклеен', /grade_nm/.test(m.materials));
  check('провалившийся назван', m.materials.includes(URN_LEGAL));
  check('успешный НЕ назван провалившимся', m.dd_failed.length === 1);
  check('формулировка не про владельца',
    /получить их не удалось/.test(m.materials) && /НЕЛЬЗЯ/.test(m.materials));
  check('предупреждения о смешивании нет — объект один',
    !/относятся ТОЛЬКО к нему/.test(m.materials));
}

// ===================================================================== 8г
line('8г. ЛИМИТ и ДУБЛИ объектов DD');
{
  const many = Array.from({ length: 7 }, (_, i) => ({
    urn: `urn:dd:tables:greenplum:table:emart.t${i}`, hint: '',
  }));
  const p = runPlan(JSON.stringify({
    domains: [], articles: [], dd: many, no_question: false,
  }));
  check('обрезано до 4', p.dd.length === 4);
  check('обрезанное перечислено', p.dd_dropped.length === 3);

  const m = runMaterials(p, null, p.dd.map(() => ({ dd_meta: 'ОБЪЕКТ DD: x' })));
  check('автор знает про обрезку',
    /По лимиту не запрашивались метаданные/.test(m.materials));

  // Один объект дважды — лишние запросы и два одинаковых инвентаря в контексте.
  const dup = runPlan(JSON.stringify({
    domains: [], articles: [],
    dd: [{ urn: URN_TABLE, hint: 'a' }, { urn: URN_TABLE, hint: 'b' }],
    no_question: false,
  }));
  check('дубль URN отброшен', dup.dd.length === 1);

  // Мусор вместо URN не должен уехать в DD Lookup и вернуться 404.
  const junk = runPlan(JSON.stringify({
    domains: [], articles: [],
    dd: [{ urn: '—', hint: '' }, { urn: 'mdm_employee_structure_d', hint: '' },
         { urn: URN_TABLE, hint: '' }],
    no_question: false,
  }));
  check('не-URN отброшены', junk.dd.length === 1 && junk.dd[0].urn === URN_TABLE);
}

// ===================================================================== 8д
line('8д. СТАРАЯ скалярная форма роутера принимается');
{
  // Модель может сбиться на формат из прежнего промпта. Терять из-за этого
  // метаданные целиком нельзя: пустой инвентарь читается как «полей нет».
  const p = runPlan(JSON.stringify({
    domains: [], articles: [],
    dd_urn: URN_TABLE, field_hint: 'active', no_question: false,
  }));
  check('скалярный dd_urn подхвачен', p.dd.length === 1 && p.dd[0].urn === URN_TABLE);
  check('field_hint подхвачен', p.dd[0].hint === 'active');
  check('без ошибки разбора', !p.router_error);
}

// ====================================================================== 9
line('9. DD ЗАПРАШИВАЛСЯ, но не ответил — формулировка не про владельца');
{
  // Ключевое правило из AGENTS.md: «описание получить не удалось» и «владелец
  // не заполнил» — разные вещи, и вторую нельзя утверждать вместо первой.
  //
  // Узел ВЫПОЛНИЛСЯ и вернул элемент без dd_meta — это и есть «запрашивали,
  // не ответил». Раньше здесь стояло dd = null, то есть узел не выполнялся
  // вовсе, и тест проверял совсем другой случай. Разница стоила двух недель:
  // в n8n ветка DD не выполнялась ни разу, а тест был зелёным (см. тест 9б).
  const p = runPlan(JSON.stringify({
    domains: [], articles: ['kb/tables/mdm-employee-structure-d.md'],
    dd: [{ urn: URN_TABLE, hint: 'grade' }], no_question: false,
  }));
  const m = runMaterials(p, [{ content: b64('# Витрина') }], [{ dd_meta: '' }]);
  check('пробел назван', /получить их не удалось/.test(m.materials));
  check('назван конкретный объект', m.materials.includes(URN_TABLE));
  check('запрет на «владелец не заполнил» передан',
    /НЕЛЬЗЯ/.test(m.materials) && /ограничение выгрузки/.test(m.materials));
  check('dd_used ложь', m.dd_used === false);
  check('это НЕ сбой конвейера', m.dd_never_ran === false);
}

// ===================================================================== 9б
line('9б. УЗЕЛ DD НЕ ВЫПОЛНЯЛСЯ, хотя объекты запланированы — сбой конвейера');
{
  // Живой отказ 2026-08-26. В «Support Bot Core» руками выключили ноду
  // «Collect articles»; выключенная нода в n8n пропускает данные насквозь,
  // и в «Need DD» вместо плана приходил ответ GitLab по статье. Условие
  // `$json.dd_count > 0` читало undefined, ветка DD не выполнялась НИ РАЗУ
  // за 49 обращений — а по логу это было неотличимо от нормальной работы:
  // dd_count в телеметрии считает «Plan», то есть план роутера, а не факт.
  //
  // Инвариант: запланированные объекты плюс невыполнившийся узел = отдельный
  // класс отказа, названный своими словами. Он чинится в n8n, а не правкой
  // базы знаний, и путать его с «каталог не ответил» нельзя.
  const p = runPlan(JSON.stringify({
    domains: [], articles: ['kb/tables/mdm-employee-structure-d.md'],
    dd: [{ urn: URN_TABLE, hint: 'grade' }], no_question: false,
  }));
  const m = runMaterials(p, [{ content: b64('# Витрина') }], null);
  check('флаг сбоя поднят', m.dd_never_ran === true);
  check('получено ноль объектов', m.dd_received === 0);
  check('сказано, что НЕ запрашивались', /НЕ ЗАПРАШИВАЛИСЬ/.test(m.materials));
  check('названо сбоем конвейера', /сбой конвейера/i.test(m.materials));
  check('формулировка про владельца не подставляется',
    !/получить их не удалось/.test(m.materials));
  check('объект назван', m.materials.includes(URN_TABLE));

  // Вопрос был не про поля — объектов не планировали, узел законно не
  // выполнялся. Это НЕ сбой, и флаг подниматься не должен.
  const p2 = runPlan(JSON.stringify({
    domains: [], articles: ['kb/tables/mdm-employee-structure-d.md'],
    dd: [], no_question: false,
  }));
  const m2 = runMaterials(p2, [{ content: b64('# Витрина') }], null);
  check('без запланированных объектов флага нет', m2.dd_never_ran === false);
  check('и лишней заметки нет', !/НЕ ЗАПРАШИВАЛИСЬ/.test(m2.materials));
}

// ====================================================================== 10
line('10. РЕПЛИКА БЕЗ ВОПРОСА: ни чтения, ни DD');
{
  const p = runPlan(JSON.stringify({
    domains: [], articles: [], dd_urn: '', field_hint: '', no_question: true,
  }));
  check('план пуст', p.files.length === 0);
  check('no_question проброшен', p.no_question === true);
  check('объектов DD нет — ветка не пойдёт', p.dd.length === 0 && p.dd_count === 0);

  const m = runMaterials(p);
  check('материалов нет', /материалов нет|Статей по вопросу/.test(m.materials));
}

// ====================================================================== 11
line('11. Collect articles возвращает поля плана для IF «Need DD»');
{
  // Без этого узла $json после GitLab-ноды — ответ API, и условие по dd_count
  // молча не срабатывает ни разу: метаданные не запрашиваются никогда.
  const plan = {
    files: ['kb/a.md'], dropped: [], added_masters: [], domains: [],
    dd: [{ urn: URN_TABLE, hint: 'hire' }], dd_dropped: [], dd_count: 1,
    no_question: false, router_error: '', router_raw: '{}',
  };
  const $ = (name) => {
    if (name === 'Plan') return { first: () => ({ json: plan }) };
    throw new Error('node not executed: ' + name);
  };
  const out = new Function('$', '$json', js('Collect articles'))($, {})[0].json;
  check('dd_count доступен для IF', out.dd_count === 1);
  check('массив объектов доступен для Split DD',
    Array.isArray(out.dd) && out.dd[0].urn === URN_TABLE);
  check('hint доехал', out.dd[0].hint === 'hire');
}

// ====================================================================== 12
line('12. ПОРЯДОК материалов: статьи, потом метаданные, потом заметки');
{
  const p = runPlan(JSON.stringify({
    domains: [], articles: ['kb/a.md', 'kb/b.md'],
    dd: [{ urn: URN_TABLE, hint: 'x' }], no_question: false,
  }));
  const m = runMaterials(
    p,
    [{ content: b64('первая') }, { error: 'нет файла' }],
    [{ dd_meta: 'ОБЪЕКТ DD: x' }],
  );
  const iArt = m.materials.indexOf('=== СТАТЬЯ');
  const iDD = m.materials.indexOf('=== МЕТАДАННЫЕ');
  const iNotes = m.materials.indexOf('=== СЛУЖЕБНЫЕ');
  check('статьи первыми', iArt >= 0 && iArt < iDD);
  check('метаданные перед заметками', iDD < iNotes);
  check('заметки последними', iNotes > 0);
}

// ====================================================================== 13
line('13. ПРОЕКЦИЯ РЕЕСТРА: в промпт уходят только таблицы');
{
  const run = (text) =>
    new Function('$json', js('Decode registry'))({
      content: Buffer.from(text, 'utf8').toString('base64'),
    })[0].json;

  const out = run(REGISTRY);
  check('комментарии для разработчика срезаны', !out.text.includes('<!--'));
  check('таблица «Домены» на месте', out.text.includes('## Домены'));
  check('таблица «Сущности» на месте', out.text.includes('## Сущности'));
  check('мастера сохранились', out.text.includes('t-emp-structure'));
  check('пути сохранились', out.text.includes('kb/tables/mdm-employee-structure-d.md'));
  check('dd_urn сохранились', out.text.includes('urn:dd:tables:greenplum'));
  check('проза отброшена', !out.text.includes('Домен дробится, когда'));
  check('проекция короче исходника', out.text.length < REGISTRY.length);
  check('экономия заявлена честно',
    out.saved_chars === REGISTRY.length - out.text.length && out.saved_chars > 2000);
  check('полный текст сохранён для Plan', out.full === REGISTRY);

  // Таблицы, по которым решение принимает КОД, роутеру не нужны и стоят
  // токенов на каждом обращении. Хуже расхода — то, что модель, увидев
  // «Маршруты», может подставить id маршрута в articles как путь к статье.
  check('«Самостоятельные выгрузки» в проекцию не уходят',
    !out.text.includes('## Самостоятельные выгрузки'));
  check('«Маршруты» в проекцию не уходят', !out.text.includes('## Маршруты'));
  check('и строки маршрутов тоже', !out.text.includes('Kirill Seliverstov'));
  // Сам id отчёта остаётся — он есть и в «Сущности», где он законен.
  // Проверяем по ключевым словам: они живут только в таблице самообслуживания.
  check('и ключевые слова самообслуживания тоже',
    !out.text.includes('my.tbank.ru/structure'));
  // Plan читает full, а не проекцию — иначе матчинг остался бы без таблиц.
  check('полный текст маршруты сохранил', out.full.includes('## Маршруты'));

  // Неизвестный заголовок остаётся: реестр растёт, и новая таблица должна
  // доезжать до роутера по умолчанию, а не пропадать молча.
  const grown = run('## Домены\n| домен |\n| a |\n\n## Новая таблица\n| x |\n| y |\n');
  check('новая таблица в проекции остаётся', grown.text.includes('## Новая таблица'));

  // Формат index.md изменился так, что таблиц не осталось: молча отдать
  // пустой реестр нельзя — роутер перестал бы находить статьи вообще.
  const degraded = run('# Реестр\n\nНикаких таблиц здесь больше нет.\n');
  check('без таблиц отдаётся полный текст',
    degraded.text.includes('Никаких таблиц здесь больше нет'));
}

// ====================================================================== 14
line('14. Plan работает от ПРОЕКЦИИ, а не только от полного текста');
{
  // Страховка на случай, если поле full когда-нибудь пропадёт: разбор мастеров
  // должен переживать и проекцию.
  const projection = REGISTRY.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('##') || l.startsWith('|'))
    .join('\n');
  const p = runPlan(JSON.stringify({
    domains: ['attendance'], articles: [], dd_urn: '', field_hint: '', no_question: false,
  }), projection);
  check('мастер attendance найден в проекции',
    p.files.includes('kb/tables/mdm-employee-attendance.md'));
}

// ===================================================================== 15
line('15. ВЫБОР РОУТЕРА отделён от добора мастеров');
{
  // Живой прогон 2026-08-11: роутер не вернул ни одной статьи, но назвал домен,
  // код добрал трёх мастеров — и автор ответил по ним с высокой уверенностью
  // на вопрос про бюджеты. Инвариант «мастера читаются всегда» сработал, а
  // подобранного под вопрос основания не было. Отличить эти два случая можно
  // только имея выбор роутера отдельно от итога.
  const mastersOnly = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }));
  check('мастера всё равно добраны', mastersOnly.files.length === 3);
  check('выбор роутера пуст', mastersOnly.router_articles.length === 0);

  const picked = runPlan(JSON.stringify({
    domains: ['movement'], articles: ['kb/metrics/turnover.md'], dd: [], no_question: false,
  }));
  check('выбор роутера виден', picked.router_articles.includes('kb/metrics/turnover.md'));
  check('мастера в выбор роутера не попали',
    !picked.router_articles.includes('kb/tables/mdm-employee-structure-d.md'));

  // Путь «—» в реестре означает «статьи нет». Считать его выбором роутера
  // значит принять пробел базы за совпадение — и потерять понижение
  // уверенности там, где оно нужно.
  const dash = runPlan(JSON.stringify({
    domains: [], articles: ['—', ''], dd: [], no_question: false,
  }));
  check('прочерк выбором роутера не считается', dash.router_articles.length === 0);
}

// ===================================================================== 16
line('16. Материалы: вопрос про отчёт, а отчёта в материалах нет');
{
  const plan = {
    files: ['kb/tables/mdm-employee-structure-d.md'],
    router_articles: [],
    dd: [{ urn: URN_TABLE, hint: 'бюджет' }],
    dd_count: 1,
  };
  const trigger = {
    topic_kind: 'Вопрос по отчетам',
    report_url: 'https://proteus.tcsbank.ru/superset/dashboard/budget-corporate-events/',
  };
  const m = runMaterials(
    plan,
    [{ content: b64('# Витрина сотрудников\nГранулярность: сотрудник × день.') }],
    [{ dd_meta: 'ПОЛЯ: employee_id, business_dt' }],
    trigger,
  );
  check('факт «спрашивали про отчёт»', m.asks_report === true);
  check('факт «отчёт не разбирался»', m.report_seen === false);
  check('факт «только мастера»', m.masters_only === true);
  check('автор предупреждён про отчёт',
    /спрашивают про ОТЧ[ЁЕ]Т/i.test(m.materials));
  check('автор предупреждён про мастеров',
    /мастер-статьи домена по умолчанию/.test(m.materials));

  // Отчёт РАЗОБРАН: пришёл объект reports.helicopter — предупреждения быть
  // не должно, иначе автор начнёт извиняться там, где всё в порядке.
  const withReport = runMaterials(
    { ...plan, dd: [{ urn: 'urn:dd:reports:helicopter:note:12345', hint: '' }], dd_count: 1 },
    [{ content: b64('# Витрина') }],
    [{ dd_meta: 'ОТЧЁТ: HR Executive' }],
    trigger,
  );
  check('отчёт разобран — предупреждения нет', withReport.report_seen === true);
  check('текст предупреждения не попал',
    !/спрашивают про ОТЧ[ЁЕ]Т/i.test(withReport.materials));

  // Формы не было (личка, чат): правило не срабатывает вовсе.
  const noForm = runMaterials(plan, [{ content: b64('# Витрина') }], null);
  check('без формы про отчёт не спрашивали', noForm.asks_report === false);
}

// ====================================================================== 17
line('17. ВЫГРУЗКА: плейбук и развилка витрины добираются кодом');
{
  // Тема обращения проставлена ЧЕЛОВЕКОМ в intake-форме — сигнал надёжнее
  // любого вывода модели. Роутер может не вернуть ни одной статьи, но
  // плейбук согласования и развилка «сотрудник или позиция» обязаны быть
  // прочитаны: без первого автор ответит по существу вместо согласования,
  // без второй не спросит про «все оформления» — и выгрузка выйдет
  // правдоподобной и неверной.
  const EXPORT = { topic_kind: 'Выгрузка данных' };
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, EXPORT);

  check('режим выгрузки определён', p.is_export === true);
  check('плейбук добавлен', p.files.includes('kb/process/export-playbook.md'));
  check('развилка витрины добавлена',
    p.files.includes('kb/recipes/structure-choice.md'));
  check('добор виден в отчёте', p.added_export.includes('kb/process/export-playbook.md'));
  // Плейбук и развилка — основание выгрузки, мастера домена — частности.
  check('плейбук идёт первым', p.files[0] === 'kb/process/export-playbook.md');
  check('мастера домена никуда не делись',
    p.files.includes('kb/tables/mdm-employee-structure-d.md'));

  // Развилка витрины — мастер домена headcount-structure, то есть добралась
  // бы и так. Дубля в files быть не должно.
  check('дублей нет', new Set(p.files).size === p.files.length);

  // Не выгрузка — ничего не добавляется: за правила выгрузки платят токенами
  // 43% обращений, остальные 57% платить не должны.
  const other = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { topic_kind: 'Вопрос по отчетам' });
  check('вопрос по отчёту: режима нет', other.is_export === false);
  check('вопрос по отчёту: плейбука нет',
    !other.files.includes('kb/process/export-playbook.md'));
}

// ====================================================================== 18
line('18. ВЫГРУЗКА: правила режима вклеиваются кодом, а не живут в промпте');
{
  const EXPORT = { topic_kind: 'Выгрузка данных' };
  const plan = {
    files: ['kb/process/export-playbook.md'],
    router_articles: [], dd: [], dd_count: 0, is_export: true,
  };
  const m = runMaterials(plan, [{ content: b64('# Плейбук выгрузки') }], null, EXPORT);
  check('режим доехал до материалов', m.is_export === true);
  check('правила режима непустые', m.mode_rules.includes('РЕЖИМ ВЫГРУЗКИ'));
  check('в правилах есть требование двух блоков',
    m.mode_rules.includes('ТЗ ДЛЯ АНАЛИТИКА'));
  // Правила — не материалы: смешать их значит отдать автору инструкцию
  // как статью, из которой можно цитировать заказчику.
  check('правила не подмешаны в материалы',
    !m.materials.includes('РЕЖИМ ВЫГРУЗКИ'));

  // Без метаданных состав полей неизвестен. Самое опасное здесь —
  // правдоподобный список полей, придуманный по смыслу.
  check('нет метаданных — автор предупреждён',
    /ВЫГРУЗКУ, а метаданных ни по одному объекту не пришло/.test(m.materials));

  const withDd = runMaterials(
    { ...plan, dd: [{ urn: URN_TABLE, hint: 'грейд' }], dd_count: 1 },
    [{ content: b64('# Плейбук') }],
    [{ dd_meta: 'ПОЛЯ: grade_nm' }],
    EXPORT,
  );
  check('метаданные есть — предупреждения нет',
    !/метаданных ни по одному объекту/.test(withDd.materials));

  // Обычный вопрос: правил режима нет вовсе, платить за них токенами незачем.
  const other = runMaterials(
    { files: ['kb/metrics/turnover.md'], router_articles: ['kb/metrics/turnover.md'],
      dd: [], dd_count: 0, is_export: false },
    [{ content: b64('# Текучесть') }], null, { topic_kind: 'Вопрос по отчетам' });
  check('обычный вопрос: правил режима нет', other.mode_rules === '');
  check('обычный вопрос: режим выключен', other.is_export === false);

  // Личка: формы нет, topic_kind пустой — но роутер по своему правилу
  // добавил плейбук. Терять режим из-за отсутствия формы нельзя.
  const dm = runMaterials(
    { files: ['kb/process/export-playbook.md'],
      router_articles: ['kb/process/export-playbook.md'],
      dd: [], dd_count: 0, is_export: false },
    [{ content: b64('# Плейбук') }], null, {});
  check('личка: режим по плейбуку в материалах', dm.is_export === true);
  check('личка: правила приехали', dm.mode_rules.includes('РЕЖИМ ВЫГРУЗКИ'));

  // Статью не удалось прочитать — режим по ней включать нельзя: правил
  // в материалах нет, а формат ответа поменялся бы.
  const broken = runMaterials(
    { files: ['kb/process/export-playbook.md'], router_articles: [],
      dd: [], dd_count: 0, is_export: false },
    [{ error: 'not found' }], null, {});
  check('нечитаемый плейбук режим не включает', broken.is_export === false);
}

console.log(`\n${'='.repeat(70)}`);

// ===================================================================== 19
line('19. ДОСТУП: статья процесса добирается кодом по теме формы');
{
  // Четыре темы формы Cross Data — четыре рабочих сценария, и ответ в базе
  // должен быть по каждому. Статьи kb/process/ не заведены сущностями
  // в реестре (у них нет ни домена, ни dd_urn — они про процесс, а не про
  // данные), поэтому роутер их не выберет никогда. Добирает код по теме,
  // как и плейбук выгрузки.
  const ACCESS = { topic_kind: 'Нет доступа к отчету' };
  const p = runPlan(JSON.stringify({
    domains: [], articles: [], dd: [], no_question: false,
  }), REGISTRY, ACCESS);

  check('тема доступа определена', p.is_access === true);
  check('статья маршрутизации добавлена', p.files.includes('kb/process/routing.md'));
  check('добор виден в отчёте', p.added_access.includes('kb/process/routing.md'));
  check('режим выгрузки не включился', p.is_export === false);

  // Остальные три темы статью про доступ НЕ тянут: лишняя статья в материалах
  // это и токены, и повод ответить не о том.
  for (const topic of ['Выгрузка данных', 'Вопрос по отчетам', 'Другое']) {
    const other = runPlan(JSON.stringify({
      domains: [], articles: [], dd: [], no_question: false,
    }), REGISTRY, { topic_kind: topic });
    check('«' + topic + '» статью про доступ не тянет',
      other.is_access === false && !other.files.includes('kb/process/routing.md'));
  }
}

// ===================================================================== 20
line('20. САМООБСЛУЖИВАНИЕ: self-service отчёт находится кодом по ключевым словам');
{
  const SS_URN = 'urn:dd:reports:reports:report:1728';
  const EXPORT_Q = {
    topic_kind: 'Выгрузка данных',
    question: 'Нужна выгрузка ФИО и логинов моей команды',
  };
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, EXPORT_Q);

  check('self-service отчёт найден', p.self_service.some((s) => s.id === 'r-hr-detail-list'));
  check('urn отчёта попал в объекты DD', p.dd.some((d) => d.urn === SS_URN));

  // Ключевое слово есть, но про выгрузку не сказано ни в теме, ни в тексте —
  // матчинг не запускается: у вопроса по отчётам свой маршрут.
  //
  // В фикстуре намеренно НЕТ слова «выгрузка»: раньше здесь стояло «Нужна
  // выгрузка ФИО и логинов» при теме «Вопрос по отчетам», и тест проверял
  // не то, что заявлено. Гейт самообслуживания теперь принимает и слово
  // в тексте — в личке формы нет вовсе, и там это единственный сигнал.
  const notExport = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { topic_kind: 'Вопрос по отчетам',
                  question: 'Где посмотреть табельный номер сотрудника?' });
  check('не выгрузка: self-service не ищется', notExport.self_service.length === 0);

  // Личка и чат: темы нет вовсе, но человек просит выгрузку словами.
  // Ровно этот случай и провалился на живом прогоне 2026-08-17.
  const dm = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { question: 'Нужна выгрузка логинов моей команды' });
  check('личка: self-service находится без темы',
    dm.self_service.some((s) => s.id === 'r-hr-detail-list'));
  check('личка: режим выгрузки при этом НЕ включается', dm.is_export === false);
  check('личка: лишних статей не добавлено',
    !dm.files.includes('kb/process/export-playbook.md'));

  // Выгрузка, но ни одно ключевое слово не совпало — пусто, а не что попало.
  const noMatch = runPlan(JSON.stringify({
    domains: ['movement'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { topic_kind: 'Выгрузка данных', question: 'Нужна выгрузка по текучести за квартал' });
  check('нет совпадения — self-service пуст', noMatch.self_service.length === 0);
  check('нет совпадения — dd не тронут', noMatch.dd.length === 0);
}

// ===================================================================== 21
line('21. САМООБСЛУЖИВАНИЕ: блок в материалах ссылается на метаданные, не дублирует их');
{
  const SS_URN = 'urn:dd:reports:reports:report:1728';
  const selfService = [{
    id: 'r-hr-detail-list', title: 'HR Executive — Детальные списки', urn: SS_URN,
  }];
  const plan = {
    files: [], router_articles: [], dd: [{ urn: SS_URN, hint: '' }],
    dd_count: 1, is_export: true, self_service: selfService,
  };
  const m = runMaterials(plan, null,
    [{ dd_meta: `ОБЪЕКТ DD: отчёт ${SS_URN}\nГДЕ ОТКРЫТЬ:\n— reports: https://proteus/…` }],
    { topic_kind: 'Выгрузка данных' });

  check('блок самообслуживания есть',
    m.materials.includes('САМОСТОЯТЕЛЬНАЯ ВЫГРУЗКА ВОЗМОЖНА: HR Executive — Детальные списки'));
  // Ссылка и подробности берутся из блока метаданных по тому же urn, а не
  // печатаются второй раз — иначе одна и та же ссылка разъедется при правке.
  check('ссылается на метаданные по urn, не дублирует ссылку',
    m.materials.includes(`МЕТАДАННЫЕ КАТАЛОГА: ${SS_URN}`) &&
    (m.materials.match(/https:\/\/proteus/g) || []).length === 1);

  // Отчёт совпал по ключевым словам, но метаданные из DD не пришли —
  // выдумывать ссылку на несуществующий блок нельзя.
  const noDd = runMaterials({ ...plan, dd: [] }, null, [], { topic_kind: 'Выгрузка данных' });
  check('метаданных нет — сказано прямо, а не выдумана ссылка',
    noDd.materials.includes('метаданные из DD получить не удалось'));

  // Обычный вопрос без self_service — блока нет вовсе.
  const none = runMaterials(
    { files: [], router_articles: [], dd: [], dd_count: 0, is_export: false, self_service: [] },
    null, null, {},
  );
  check('self_service пуст — блока нет', !none.materials.includes('САМОСТОЯТЕЛЬНАЯ ВЫГРУЗКА'));

  // Старый план без поля self_service вообще (до этой правки) не должен ронять ноду.
  const legacy = runMaterials(
    { files: [], router_articles: [], dd: [], dd_count: 0, is_export: false }, null, null, {});
  check('план без self_service не роняет материалы', !legacy.materials.includes('САМОСТОЯТЕЛЬНАЯ'));
}

// ===================================================================== 22
line('22. САМООБСЛУЖИВАНИЕ на РЕАЛЬНОМ обращении: тема из шапки, слова человека');
{
  // Обращение из живого прогона 2026-08-17, из-за которого правился гейт.
  // Бот прошёл мимо «Детальных списков», хотя дежурный на такой же вопрос
  // (выгрузка канала, обращение @k.d.yudina) ответил именно этим отчётом.
  const REAL = [
    'Cross Data | Выгрузка данных от пользователя @Alisa Pipkina',
    '',
    'Почему не получается выгрузить самостоятельно?:',
    'направили сюда',
    'Бизнес-задача, решаемая выгрузкой:',
    'Для переезда на творк, нужно дать скилл всем сотрудникам юнита,',
    'его можно навесить по логинам',
    'Опиши требования к выгрузке (какие данные, состав атрибутов, по каким' +
      ' сотрудникам/юнитам/вакансиям, особенности и ограничения):',
    'нужны все логины https://my.tbank.ru/structure/resource/units/UUID/teams',
    'Наличие чувствительных данных (если нужно несколько, выбери самый' +
      ' критичный, а в поле выше укажи все нужные):',
    'Персональные данные сотрудников (неполное ФИО, логин, раб. почта,' +
      ' возраст, master ID и др. внутренние ID)',
    'Перечисли логины сотрудников, кому необходимо дать доступ к выгрузке:',
    'a.pipkina',
  ].join('\n');

  // Чат: guard формы не разбирал, topic_kind пустой — ровно как в прогоне.
  const chat = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { question: REAL });

  check('тема восстановлена из шапки: режим выгрузки включён', chat.is_export === true);
  check('плейбук впереди мастеров', chat.files[0] === 'kb/process/export-playbook.md');
  check('отчёт найден', chat.self_service.some((s) => s.id === 'r-hr-detail-list'));

  const hit = chat.self_service.find((s) => s.id === 'r-hr-detail-list') || {};
  // Совпасть должны слова ЗАКАЗЧИКА, а не служебный текст формы.
  check('совпало по словам человека', (hit.matched || []).some(
    (kw) => kw === 'логин' || kw === 'юнит' || kw === 'my.tbank.ru/structure'));
  // «ФИО» здесь есть только внутри варианта списка чувствительности.
  // Совпадение по нему означало бы, что отчёт предлагается по шаблону формы.
  check('НЕ совпало по «фио» из варианта списка', !(hit.matched || []).includes('фио'));
  check('urn отчёта уехал в объекты DD',
    chat.dd.some((d) => d.urn === 'urn:dd:reports:reports:report:1728'));

  // Слово «доступ» стоит в подписи поля формы выгрузки. Статья маршрутизации
  // от этого тянуться не должна: у обращения тема «Выгрузка данных».
  check('статья про доступ не добралась',
    chat.is_access === false && !chat.files.includes('kb/process/routing.md'));

  // Канал: guard тему разобрал. Результат обязан быть тем же — иначе тест
  // в чате проверяет не то, что работает в канале.
  const channel = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { topic_kind: 'Выгрузка данных', question: REAL });
  check('канал и чат дают один результат',
    JSON.stringify(channel.self_service) === JSON.stringify(chat.self_service) &&
    channel.is_export === chat.is_export);

  // Служебный текст формы САМ ПО СЕБЕ отчёт не предлагает. Здесь заказчик
  // просит выгрузку по текучести: ни одного своего слова из списка нет,
  // а шаблонные «ФИО» в скобках и «логины» в подписи поля — есть.
  const boilerplate = [
    'Cross Data | Выгрузка данных от пользователя @Ivan Ivanov',
    'Бизнес-задача, решаемая выгрузкой:',
    'посчитать текучесть по департаменту за квартал',
    'Наличие чувствительных данных (если нужно несколько, выбери самый' +
      ' критичный, а в поле выше укажи все нужные):',
    'Персональные данные сотрудников (неполное ФИО, логин, раб. почта,' +
      ' возраст, master ID и др. внутренние ID)',
    'Перечисли логины сотрудников, кому необходимо дать доступ к выгрузке:',
    'i.ivanov',
  ].join('\n');
  const bp = runPlan(JSON.stringify({
    domains: ['movement'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { topic_kind: 'Выгрузка данных', question: boilerplate });

  check('шаблон формы отчёт не предлагает', bp.self_service.length === 0);
  check('шаблон формы не тронул объекты DD', bp.dd.length === 0);
  check('режим выгрузки при этом на месте', bp.is_export === true);
}

// ====================================================================== 23
line('23. ИБ: передача вне контура — блок в материалах обязателен');
{
  // Признак проставил человек в форме, и он однозначен. Модель это правило
  // пропускала: в фидбеке аналитика 4 обращения из 5 с ответом «нет, наружу»
  // были поправлены на «сначала согласование в ~sec_analytics_ask».
  const EXPORT_PLAN = {
    files: ['kb/process/export-playbook.md'],
    dropped: [], dd: [], dd_dropped: [], router_articles: [],
    is_export: true, self_service: [],
  };
  const article = [{ content: b64('# Плейбук выгрузки') }];

  const out = runMaterials(EXPORT_PLAN, article, [], { external_transfer: 'yes' });
  check('блок ИБ в материалах есть',
    out.materials.includes('СОГЛАСОВАНИЕ ИБ ОБЯЗАТЕЛЬНО'));
  check('канал согласования назван', out.materials.includes('~sec_analytics_ask'));
  check('требование помечено флагом', out.ib_required === true);
  check('значение из формы доехало', out.external_transfer === 'yes');
  // Смягчить требование модели нечем: в блоке прямо сказано, что оно
  // не условное. Формулировка «возможно потребуется» — то же молчание.
  check('требование названо безусловным',
    /не условн/i.test(out.materials));

  // Внутри контура — тишина. Строка, которая печатается всегда, перестаёт
  // читаться: ровно так «ФИО» из шаблона формы обесценило самообслуживание.
  const inside = runMaterials(EXPORT_PLAN, article, [], { external_transfer: 'no' });
  check('внутри контура: блока нет', !inside.materials.includes('СОГЛАСОВАНИЕ ИБ'));
  check('внутри контура: требования нет', inside.ib_required === false);
  check('внутри контура: заметки про неразобранное нет',
    !inside.materials.includes('РАЗОБРАТЬ НЕ УДАЛОСЬ'));

  // Признак не разобран, а форма БЫЛА (plan.is_export === true, тему
  // проставил человек). Это промах разбора, а не «данные остаются внутри»,
  // и молчание здесь неотличимо от «согласование не нужно».
  const unknown = runMaterials(EXPORT_PLAN, article, [], { external_transfer: '' });
  check('форма была, признак пуст: сказано вслух',
    unknown.materials.includes('РАЗОБРАТЬ НЕ УДАЛОСЬ'));
  check('форма была, признак пуст: требования не выдумываем',
    unknown.ib_required === false);

  // Личка и чат: формы нет вовсе, режим восстановлен по плейбуку среди
  // прочитанного. Заметка там печаталась бы на каждой второй выгрузке.
  const dm = runMaterials(
    { ...EXPORT_PLAN, is_export: false }, article, [], { external_transfer: '' });
  check('личка: режим восстановлен по плейбуку', dm.is_export === true);
  check('личка: заметки про неразобранный признак нет',
    !dm.materials.includes('РАЗОБРАТЬ НЕ УДАЛОСЬ'));

  // Не выгрузка: признак из формы может прийти каким угодно, требование
  // относится к передаче файла, а файла здесь нет.
  const question = runMaterials(
    { ...EXPORT_PLAN, files: ['kb/metrics/turnover.md'], is_export: false },
    article, [], { external_transfer: 'yes' });
  check('обычный вопрос: требования ИБ нет', question.ib_required === false);
}

// ====================================================================== 24
line('24. МАРШРУТЫ вне CrossData: код находит адресата и не заменяет им ответ');
{
  // Половина канала — не вопрос про данные: 13 обращений из 49 в фидбеке
  // аналитика решались одной строкой «это ведёт такой-то». Реестр берётся
  // настоящий: тест обязан ломаться при правке таблицы «Маршруты», а не
  // только кода — так же, как тесты мастеров ломаются при правке «Доменов».
  const ROUTER = JSON.stringify({
    domains: [], articles: [], dd: [], no_question: false,
  });

  const plan = (question) => runPlan(ROUTER, REGISTRY, { question });

  const p = plan('Подскажите, кто ведёт квоты на найм в нашем юните?');
  check('маршрут найден', p.routes.length === 1);
  check('это quotas', p.routes[0].id === 'quotas');
  check('адресат приехал из реестра', p.routes[0].who === 'Kirill Seliverstov');
  check('дата подтверждения приехала', /^\d{4}-\d{2}-\d{2}$/.test(p.routes[0].checked));
  check('видно, по какому слову сработало', p.routes[0].matched.includes('квот'));
  // Прочерк в колонке «где» значит «в личку», а не строку «—» в тексте.
  check('прочерк не уезжает адресом', p.routes[0].where === '');

  const chan = plan('Где посмотреть воронку найма и источники найма?');
  check('канал вместо человека тоже маршрут', chan.routes[0].id === 'recruitment');
  check('канал приехал', chan.routes[0].where === '~recruitment_reports_ask');
  check('человека нет — и это не ошибка', chan.routes[0].who === '');

  // ГЕЙТА НЕТ: маршрут ищется на любой теме, в том числе в личке без формы.
  // У самообслуживания гейт защищает от расхода в DD Lookup, а маршрут
  // не стоит ничего — и «кто ведёт квоты» приходит любым типом обращения.
  check('маршрут не требует режима выгрузки', p.is_export === false);
  check('и не добавляет объектов в DD', p.dd.length === 0);

  // Слов маршрута нет — блока нет. Строка, которая появляется всегда,
  // перестаёт читаться: ровно так «ФИО» из шаблона формы обесценило
  // подсказку про самообслуживание.
  const none = plan('Сколько сотрудников в юните на 1 августа?');
  check('без совпадения маршрутов нет', none.routes.length === 0);

  // Ложные совпадения, выброшенные при выверке по выгрузке канала.
  // Каждое било по НАШЕМУ же обращению, и каждое молча превращало бы
  // ответ в переадресацию.
  const hire = plan('Сколько человек наняли в июле? Данные о найме и оттоке.');
  check('«найм» больше не уводит подбору', hire.routes.length === 0);
  const cand = plan('Отчёт «проверка кандидатов на прошлое трудоустройство»');
  check('«кандидат» не уводит подбору', cand.routes.length === 0);
  const hybrid = plan('Нужны работники на 30.07 — офисный и гибридный договор');
  check('«рид» внутри «гибрид» не срабатывает', hybrid.routes.length === 0);
  const report = plan('Подготовьте доклад по численности за квартал');
  check('«оклад» внутри «доклад» не срабатывает', report.routes.length === 0);
  const byLegal = plan('Численность с разбивкой по подразделениям и юрлицам');
  check('«юрлиц» в разбивке не срабатывает', byLegal.routes.length === 0);

  // Матчинг идёт по тому, что написал ЧЕЛОВЕК: подписи полей формы
  // и содержимое скобок выброшены — та же чистка, что у самообслуживания.
  const form = plan([
    'Cross Data | Выгрузка данных от пользователя @Ivan Petrov',
    'Опиши, куда пойдут зарплаты и начисления:',
    'нужна численность юнита на 1 августа',
  ].join('\n'));
  check('подпись поля маршрутом не считается', form.routes.length === 0);
  const paren = plan('Нужна выгрузка (зарплаты, начисления) по юниту');
  check('текст в скобках маршрутом не считается', paren.routes.length === 0);

  // Потолок: больше двух адресатов в одном черновике — это не помощь,
  // а список. Обрезанное называется, а не режется молча.
  const many = plan('Вопрос про usr_cnb, forge, квоты и воронку найма разом');
  check('маршрутов не больше двух', many.routes.length === 2);
  check('обрезанное названо', many.routes_dropped.length >= 1);
  check('и названо id, а не именем', /^[a-z-]+$/.test(many.routes_dropped[0]));

  // ------------------------------------------------ блок в материалах
  const mat = runMaterials(p);
  check('блок маршрута в материалах есть',
    mat.materials.includes('ЭТО ВЕДЁТ НЕ CROSSDATA'));
  check('адресат назван', mat.materials.includes('Kirill Seliverstov'));
  // Порядок в блоке обратный привычному: сначала «не заменяет ответ»,
  // потом имя. Иначе автор пишет переадресацию там, где база отвечает.
  const iRule = mat.materials.indexOf('НЕ ');
  const iName = mat.materials.indexOf('Kirill Seliverstov');
  check('правило «не заменяет ответ» раньше имени', iRule !== -1 && iRule < iName);
  check('запрет склонять имя назван', /склонять/.test(mat.materials));
  check('маршрут доехал до выхода ядра', mat.routes.length === 1);
  check('дата в выходе ядра осталась', mat.routes[0].checked !== '');

  const matNone = runMaterials(none);
  check('без маршрута блока нет', !matNone.materials.includes('ЭТО ВЕДЁТ НЕ CROSSDATA'));
  check('и поле пустое, а не отсутствует', Array.isArray(matNone.routes) &&
    matNone.routes.length === 0);

  // Строки таблицы «Маршруты» НЕ должны разобраться как отчёты
  // самообслуживания: у них свой формат колонок, и без границы секции
  // бот предлагал бы «самостоятельную выгрузку» под названием «payroll».
  const exp = runPlan(ROUTER, REGISTRY, {
    question: 'Нужна выгрузка зарплат по юниту', topic_kind: 'Выгрузка данных',
  });
  // В секции «Маршруты» реестра лежит и пояснительная таблица «какие слова
  // выброшены и почему» — двухколоночная. Без проверки формы её строки
  // разобрались бы маршрутами: «найм» стал бы id, а объяснение — списком
  // ключевых слов, и маршрут срабатывал бы ровно на том слове, которое
  // из списка выброшено.
  const rejected = plan('Отчёт по данным о найме и оттоке за июль');
  check('пояснительная таблица маршрутом не становится', rejected.routes.length === 0);
  const rejectedWord = plan('почему выброшено это слово');
  check('и её заголовок тоже', rejectedWord.routes.length === 0);

  check('маршрут в самообслуживание не протёк',
    exp.self_service.every((x) => !/^(payroll|quotas|forge|recruitment)$/.test(x.id)));
  check('маршрут при этом найден', exp.routes.some((r) => r.id === 'payroll'));
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(fails ? 1 : 0);
