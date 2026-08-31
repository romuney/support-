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
  // Роутер не дал ничего — читается витрина по умолчанию, как и при пустом
  // плане: сломанный разбор это тот же отказ роутера, и отвечать на него
  // «в базе нет ответа» значит выдавать одно за другое. Но подмена должна
  // быть НАЗВАНА, иначе «прочитали дефолт» и «роутер сработал» неразличимы.
  check('роутер не выбрал ни одной статьи', p.router_articles.length === 0);
  check('витрина по умолчанию добрана', p.added_fallback.length === 1);
  check('и это мастер-витрина сотрудников',
    p.files.includes('kb/tables/mdm-employee-structure-d.md'));
  check('причина названа', /не удалось разобрать план/.test(p.router_error));
  check('сырой вывод сохранён для лога', p.router_raw.length > 0);

  const m = runMaterials(p);
  check('автор предупреждён о сбое', /Планирование сбилось/.test(m.materials));
  check('автор предупреждён, что статей нет', /Статей по вопросу/.test(m.materials));
}

// ====================================================================== 6
line('6. ЛИМИТ ОБЪЁМА: обрезанное названо, а не выброшено молча');
{
  const many = Array.from({ length: 20 }, (_, i) => `kb/metrics/x${i}.md`);
  const p = runPlan(JSON.stringify({
    domains: [], articles: many, dd_urn: '', field_hint: '', no_question: false,
  }));
  // Потолок поднят с 8 до 16, и число выведено, а не придумано: кодом
  // добирается до 10 статей (плейбук выгрузки, развилка структуры,
  // маршрутизация, sql-conventions, активная численность, словарь синонимов,
  // поиск юнита, до трёх мастеров), роутеру его промпт разрешает 6.
  // Обрезка при этом бьёт по ХВОСТУ — а хвост здесь и есть выбор роутера,
  // потому что служебное добирается первым. Потолок, который срабатывает,
  // работает ровно наоборот замыслу, поэтому он обязан быть не-связывающим.
  check('план обрезан до 16', p.files.length === 16);
  check('обрезанное перечислено', p.dropped.length === 4);

  const m = runMaterials(p, [{ content: b64('# статья') }]);
  check('автор знает про обрезку', /По лимиту объёма не читались/.test(m.materials));
  check('названы конкретные файлы', /kb\/metrics\/x16\.md/.test(m.materials));

  // ГЛАВНЫЙ ИНВАРИАНТ ПОТОЛКА: он не должен срабатывать на честном плане.
  // Худший случай — выгрузка с просьбой помочь с запросом, вопросом про юнит
  // и доступ: кодом добирается всё, что добирается, плюс мастера домена,
  // плюс шесть статей от роутера (его собственный предел). Если потолок
  // режет здесь, он режет ровно то, что подобрано под вопрос: служебное
  // добирается ПЕРВЫМ, и обрезка бьёт по хвосту.
  const worst = runPlan(
    JSON.stringify({
      domains: ['headcount-structure', 'legal'],
      articles: ['m-turnover', 'm-hiring', 'rc-cohort-analysis',
                 'rc-attribute-tenure', 't-attendance', 't-education'],
      dd: [], no_question: false,
    }),
    REGISTRY,
    { topic_kind: 'Cross Data | Выгрузка данных',
      question: 'нужна выгрузка: как написать select по юниту, нет доступа к отчёту' },
  );
  check('на худшем честном плане потолок не срабатывает',
    worst.dropped.length === 0);
  check('и выбор роутера доехал целиком',
    worst.router_articles.every((x) => worst.files.includes(x)) &&
    worst.router_articles.length === 6);
  // Размер материалов теперь измеряется: без числа все потолки остаются
  // придуманными, и каждый раз, когда они мешают, это выясняется отказом.
  check('размер материалов измерен', m.materials_len === m.materials.length);
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
  // ghost.md нет и в реестре — значит путь придумал роутер, и «расхождение
  // реестра» здесь неверный диагноз: править там нечего. Формулировки
  // разведены, иначе задача уходит на строку, которой не существует.
  check('выдуманный путь назван несуществующим',
    /Не существует: kb\/metrics\/ghost\.md/.test(m.materials));
  check('и не выдан за расхождение реестра',
    !/Реестр ссылается на файл, которого нет/.test(m.materials));
  check('в отчёте разделены прочитанные и нет',
    m.articles_read.includes('kb/metrics/turnover.md')
      && m.articles_invented.includes('kb/metrics/ghost.md')
      && !m.articles_failed.includes('kb/metrics/ghost.md'));

  // А путь ИЗ реестра, который не читается, — по-прежнему расхождение базы.
  const real = runPlan(JSON.stringify({
    domains: [], articles: ['kb/metrics/turnover.md'],
    dd_urn: '', field_hint: '', no_question: false,
  }));
  const mr = runMaterials(real, [{ error: '404 not found' }]);
  check('битая строка реестра названа расхождением',
    /Реестр ссылается на файл, которого нет/.test(mr.materials) &&
    mr.articles_failed.includes('kb/metrics/turnover.md'));
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
  // Отчёта в объектах DD нет. Витрина там БУДЕТ — в режиме выгрузки код
  // добирает инвентарь прочитанных витрин сам, — но это другой механизм,
  // и проверять надо именно отсутствие отчёта, а не пустой список.
  check('нет совпадения — отчёт в dd не уехал',
    !noMatch.dd.some((d) => /reports/.test(d.urn)));
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
  check('шаблон формы не добавил отчёт в объекты DD',
    !bp.dd.some((d) => /reports/.test(d.urn)));
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
line('24. ЭКСПЕРТ ПО ТЕМЕ: код находит, кого позвать, и не заменяет им ответ');
{
  // 13 обращений из 49 в фидбеке аналитика решались тем, что дежурный звал
  // эксперта по теме. Часть этих людей — сотрудники CrossData: обращение
  // остаётся нашим, просто в этой доменной области разбирается не дежурный.
  // Реестр берётся настоящий: тест обязан ломаться при правке таблицы
  // «Маршруты», а не только кода — как тесты мастеров при правке «Доменов».
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
  check('блок эксперта в материалах есть',
    mat.materials.includes('ПОЗВАТЬ ЭКСПЕРТА ПО ТЕМЕ'));
  check('эксперт назван', mat.materials.includes('Kirill Seliverstov'));
  // Формулировка «это не к нам» здесь прямо неверна: часть экспертов —
  // сотрудники CrossData, и отказ в помощи вместо помощи хуже молчания.
  // Проверяем СМЫСЛ, а не подстроку: сам блок эту формулировку упоминает —
  // чтобы её запретить, — и наивный поиск подстроки краснел бы на верном
  // тексте. Ровно та ошибка, которой едва не стала проверка согласования ИБ.
  check('старого заголовка не осталось',
    !/ВЕДЁТ НЕ CROSSDATA/i.test(mat.materials));
  check('сказано, что обращение остаётся нашим',
    /остаётся\s+нашим/i.test(mat.materials));
  check('переадресация названа запрещённой',
    /не переадресация/i.test(mat.materials));
  check('сказано, что эксперты работают в CrossData',
    /работает в CrossData/i.test(mat.materials));
  check('человека зовут в тред', /позвать в тред/i.test(mat.materials));
  // Порядок в блоке обратный привычному: сначала «не заменяет ответ»,
  // потом имя. Иначе автор пишет «идите к такому-то» там, где база отвечает.
  const iRule = mat.materials.indexOf('НЕ ');
  const iName = mat.materials.indexOf('Kirill Seliverstov');
  check('правило «не заменяет ответ» раньше имени', iRule !== -1 && iRule < iName);
  check('запрет склонять имя назван', /склонять/.test(mat.materials));
  check('маршрут доехал до выхода ядра', mat.routes.length === 1);
  check('дата в выходе ядра осталась', mat.routes[0].checked !== '');

  const matNone = runMaterials(none);
  check('без маршрута блока нет', !matNone.materials.includes('ПОЗВАТЬ ЭКСПЕРТА'));
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

  // НОВАЯ СЕКЦИЯ РЕЕСТРА не должна подмешиваться ни в одну существующую.
  // Раньше границей секции служило имя следующей — вписанное в сборщик
  // парами, — и вставка раздела между ними разъезжалась молча: чужие строки
  // разбирались как свои, формат колонок другой, на выходе неверные данные.
  // Реестр правят чаще, чем сборщик, поэтому граница теперь «следующий
  // заголовок ## », какой бы он ни был.
  const inserted = REGISTRY.replace('## Самостоятельные выгрузки',
    '## Новый раздел\n\n| id | тип | что-то |\n|---|---|---|\n' +
    '| r-hr-detail-list | table | подделка |\n| payroll | table | подделка |\n\n' +
    '## Самостоятельные выгрузки');
  const after = runPlan(ROUTER, inserted, {
    question: 'Нужна выгрузка зарплат по юниту', topic_kind: 'Выгрузка данных',
  });
  check('вставленный раздел не подмешался в сущности',
    !after.files.includes('подделка'));
  check('и не подмешался в самообслуживание',
    JSON.stringify(after.self_service) === JSON.stringify(exp.self_service));
  check('и не подмешался в маршруты',
    JSON.stringify(after.routes) === JSON.stringify(exp.routes));
}

// ====================================================================== 25
line('25. ИНВЕНТАРЬ ВИТРИН добирает код, а несобранный — называется');
{
  // Живой прогон 2026-08-27, обращение из инфобеза про телефоны подрядчиков.
  // В служебном блоке стояло «метаданные: 1728» — из каталога пришёл ровно
  // один объект, отчёт. Инвентарь витрины не запрашивался вовсе, а ТЗ при
  // этом утверждало: «в метаданных витрины mdm_employee_structure_d нет поля
  // с мобильным телефоном». Утверждение о факте, которого бот не видел.
  const ROUTER = JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  });

  const exp = runPlan(ROUTER, REGISTRY, {
    topic_kind: 'Выгрузка данных', question: 'Нужны телефоны подрядчиков',
  });
  check('мастер-витрина прочитана',
    exp.files.includes('kb/tables/mdm-employee-structure-d.md'));
  check('её инвентарь добран кодом', exp.dd.some((d) => d.urn === URN_TABLE));
  check('и видно, что добрал именно код', exp.dd_added_by_code.includes(URN_TABLE));
  // Пустой hint намеренно: без фильтра приходит ПОЛНЫЙ список имён полей
  // одним запросом. Вопрос стоял «есть ли такое поле вообще» — тут нужна
  // полнота, а не угаданный за роутера фильтр.
  check('фильтр не выдуман за роутера',
    exp.dd.find((d) => d.urn === URN_TABLE).hint === '');
  check('витрина названа в tables_read',
    exp.tables_read.some((t) => t.urn === URN_TABLE));

  // Гейт: обычный вопрос инвентарь не тянет. 289 имён — это 3 КБ шума
  // и расхода на КАЖДОМ обращении там, где отвечает статья.
  const ask = runPlan(ROUTER, REGISTRY, { question: 'Что такое текучесть?' });
  check('обычный вопрос инвентарь не тянет', ask.dd.length === 0);
  check('и tables_read пуст', ask.tables_read.length === 0);

  // Роутер назвал витрину сам, со своим фильтром — его не затираем:
  // фильтр даёт ещё и описания полей, а пустой их не даёт.
  const withHint = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [],
    dd: [{ urn: URN_TABLE, hint: 'телефон' }], no_question: false,
  }), REGISTRY, { topic_kind: 'Выгрузка данных', question: 'телефоны' });
  check('фильтр роутера сохранён',
    withHint.dd.find((d) => d.urn === URN_TABLE).hint === 'телефон');
  check('дубля объекта нет',
    withHint.dd.filter((d) => d.urn === URN_TABLE).length === 1);

  // ------------------------------------- инвентарь не дошёл: сказать вслух
  const mat = runMaterials(exp, [{ content: b64('# Витрина') }], []);
  check('витрина без инвентаря названа',
    mat.materials.includes('СОСТАВ ПОЛЕЙ не получен'));
  check('запрет на «в витрине нет поля» назван',
    /в витрине нет поля/.test(mat.materials));
  check('и она в отдельном поле выхода',
    mat.tables_no_meta.includes(URN_TABLE));

  // Инвентарь пришёл — заметки нет. Строка, которая печатается всегда,
  // перестаёт читаться.
  const ok = runMaterials(exp, [{ content: b64('# Витрина') }],
    [{ dd_meta: 'ПОЛЯ: mdm_employee_rk, contact_main_phone_no' }]);
  check('инвентарь пришёл — заметки нет',
    !ok.materials.includes('СОСТАВ ПОЛЕЙ не получен'));
  check('и поле пустое', ok.tables_no_meta.length === 0);
}

// ====================================================================== 26
line('26. «КАК НАПИСАТЬ ЗАПРОС» — это вопрос, а не заявка на выгрузку');
{
  // Живой прогон 2026-08-27: «Можешь подсказать, как написать select, чтобы
  // выгрузить сотрудника, его управленческий юнит и его юнит из
  // функциональной структуры?» Формы в чате нет, режим выгрузки включился
  // фолбэком «среди прочитанного есть плейбук» — и на просьбу написать
  // запрос бот выдал согласование состава полей и ТЗ, а SQL не написал.
  const Q = 'Можешь подсказать, как написать select, чтобы выгрузить ' +
            'сотрудника, его управленческий юнит и его юнит из функциональной структуры?';
  const ROUTER = JSON.stringify({
    domains: ['headcount-structure'],
    articles: ['kb/process/export-playbook.md'], dd: [], no_question: false,
  });

  const p = runPlan(ROUTER, REGISTRY, { question: Q });
  check('признак «просят запрос» поднят', p.is_query_help === true);
  // Конвенции запросов роутер выбрать не может — их нет в реестре. До этой
  // правки sql-conventions.md не добирал никто, и на вопрос про запрос
  // у автора не было ни одной статьи о том, как его положено писать.
  check('конвенции запросов добраны кодом',
    p.files.includes('kb/process/sql-conventions.md'));
  check('и видно, что добрал код', p.added_query.length === 1);
  check('инвентарь витрины тоже добран', p.dd.some((d) => d.urn === URN_TABLE));

  const mat = runMaterials(p, [{ content: b64('# Плейбук') }, { content: b64('# Витрина') }],
    [{ dd_meta: 'ПОЛЯ: mdm_employee_rk' }]);
  check('режим выгрузки погашен', mat.is_export === false);
  check('правил режима выгрузки в промпте нет', !mat.mode_rules);
  check('признак доехал до выхода', mat.is_query_help === true);

  // Тему проставил ЧЕЛОВЕК — это факт, и догадкой он не перебивается:
  // заявка на файл со словом «select» в тексте режим не теряет.
  const form = runPlan(ROUTER, REGISTRY, {
    topic_kind: 'Выгрузка данных', question: Q,
  });
  const formMat = runMaterials(form, [{ content: b64('# Плейбук') }], []);
  check('тема из формы сильнее признака', formMat.is_export === true);
  check('правила режима при этом на месте', Boolean(formMat.mode_rules));

  // Обычная выгрузка без просьбы про запрос — режим на месте, как и был.
  const plain = runPlan(ROUTER, REGISTRY, { question: 'Нужна выгрузка по текучести' });
  check('обычная выгрузка режим не теряет',
    runMaterials(plain, [{ content: b64('# Плейбук') }], []).is_export === true);
  check('и конвенции ей не добираются',
    !plain.files.includes('kb/process/sql-conventions.md'));
}

// ====================================================================== 27
line('27. ПУСТОЙ ПЛАН РОУТЕРА — не «нет ответа», а витрина по умолчанию');
{
  // Живой прогон 2026-08-27: «где взять инфу о количестве биай аналитиков
  // в стриме дата 15 грейда в юните human capital origination». Роутер
  // вернул пустые domains и articles, мастера не добрались, читать было
  // нечего — и бот ответил «нет ответа». А ответ в базе есть: это обычная
  // численность с фильтрами, и считается она по мастер-витрине сотрудников.
  const EMPTY = JSON.stringify({
    domains: [], articles: [], dd: [], no_question: false,
  });
  const p = runPlan(EMPTY, REGISTRY, { question: 'где взять инфу о количестве ' +
    'биай аналитиков в стриме дата 15 грейда в юните human capital origination' });

  check('материалы не пустые', p.files.length > 0);
  check('добрана мастер-витрина сотрудников',
    p.files.includes('kb/tables/mdm-employee-structure-d.md'));
  // Витрина по умолчанию выводится ИЗ РЕЕСТРА — сущность, назначенная
  // мастером в наибольшем числе доменов. Тест пришпиливает вывод: реестр
  // изменится так, что умолчание переедет, — он покраснеет, и решение
  // примет человек, а не молча поедет поведение бота.
  check('умолчание выведено из реестра, а не вписано',
    p.added_fallback.length === 1 && p.added_fallback[0] === 't-emp-structure');
  // «Роутер промахнулся» и «в базе нет ответа» обязаны различаться
  // по выходу ядра: это разные задачи и чинятся в разных местах.
  check('подмена названа', p.router_articles.length === 0);

  // Роутер назвал ХОТЬ ЧТО-ТО — страховка не нужна: одного домена
  // достаточно, чтобы мастера добрались сами.
  const withDomain = runPlan(JSON.stringify({
    domains: ['movement'], articles: [], dd: [], no_question: false,
  }), REGISTRY, { question: 'сколько наняли' });
  check('при названном домене умолчание не добирается',
    withDomain.added_fallback.length === 0);

  // Реплики без вопроса это не касается — там читать и не надо.
  const noQ = runPlan(JSON.stringify({
    domains: [], articles: [], dd: [], no_question: true,
  }), REGISTRY, { question: 'ага, спасибо' });
  check('на реплике без вопроса ничего не читается', noQ.files.length === 0);

  // ------------------------------------------------ автор предупреждён
  const mat = runMaterials(p, [{ content: b64('# Витрина сотрудников') }]);
  check('автору сказано, что совпадения не было',
    mat.materials.includes('НИ домена, НИ статьи'));
  check('и запрещено пересказывать витрину вместо ответа',
    /не пересказывай/.test(mat.materials));
  check('признак доехал до выхода', mat.router_empty === true);

  // Слова заказчика в таблице «Домены» дополнены по выгрузке канала —
  // страховка нужна, но догонять роутер данными тоже надо.
  const dom = REGISTRY.slice(REGISTRY.indexOf('| домен |'),
                             REGISTRY.indexOf('## Сущности')).toLowerCase();
  for (const w of ['грейд', 'юнит', 'стрим', 'специализац', 'должност']) {
    check(`слово «${w}» есть в описании доменов`, dom.includes(w));
  }
}

// ===================================================================== 28
line('28. ЗНАЧЕНИЯ ФИЛЬТРОВ: роутер их больше не выделяет');
{
  // Раньше роутер возвращал values рядом с hint, и каталог ходил в данные
  // ещё до того, как хоть что-то прочитано. Выбор «в каком поле искать слово
  // заказчика» делается по правилу из статьи, а у роутера статьи нет — он
  // раз за разом отправлял искать «юнит» в юридической структуре вместо
  // управленческой. Проверку перенесли за автора, у которого есть и статья,
  // и рецепт, и инвентарь разом.
  //
  // Оставлять сбор values «на всякий случай» нельзя: это код, который
  // не работает и выглядит рабочим. Тест держит именно отсутствие пути.
  const p = runPlan(JSON.stringify({
    domains: ['headcount-structure'],
    articles: ['kb/tables/mdm-employee-structure-d.md'],
    dd: [{ urn: 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d',
           hint: 'специализация, стрим', values: 'BI-аналитик, Дата' }],
    no_question: false,
  }), REGISTRY, { question: 'сколько BI-аналитиков в стриме Дата' });
  const d = p.dd.find((x) => /mdm_employee_structure_d/.test(x.urn));
  check('объект каталога есть', Boolean(d));
  check('значения роутера в план не едут', d && d.values === undefined);
  check('и не подмешаны в hint', d && !/BI-аналитик/.test(d.hint));
  check('счётчика значений в плане тоже нет', p.values_asked === undefined);

  // Живое поведение, которое переносом не тронуто: повтор URN склеивает
  // иглы. Вопрос «какое поле хранит логин и есть ли рабочая почта» — это
  // один объект и ДВА понятия, и вторая игла раньше выбрасывалась.
  const merged = runPlan(JSON.stringify({
    domains: ['headcount-structure'], articles: [],
    dd: [{ urn: 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d',
           hint: 'логин' },
         { urn: 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d',
           hint: 'почта' }],
    no_question: false,
  }), REGISTRY, { question: 'какое поле хранит логин и есть ли рабочая почта' });
  const m = merged.dd.find((x) => /mdm_employee_structure_d/.test(x.urn));
  check('объект по-прежнему один', merged.dd.filter(
    (x) => /mdm_employee_structure_d/.test(x.urn)).length === 1);
  check('иглы обоих элементов склеены',
    m && /логин/.test(m.hint) && /почт/.test(m.hint));

  // Ни в сборщике, ни в промпте роутера мёртвого пути не осталось: иначе
  // модель платит токенами за правила, по которым никто не действует.
  const src = fs.readFileSync('build_time_flows.py', 'utf8');
  check('в промпте роутера про values не сказано',
    !/values/.test(fs.readFileSync('prompts/router.md', 'utf8')));
  check('и сборщик их нигде не собирает',
    !/byUrnValues|values_asked|field_values/.test(src));
}

// ===================================================================== 29
line('29. reached_by: code — контракт между базой знаний и сборщиком');
{
  // Регламенты из kb/process/ роутер не выбирает никогда: строк process
  // в реестре нет. До бота они доезжают только тем, что путь вписан
  // в сборщик и добирается признаком обращения. Поэтому у каждого файла
  // есть фронтматтер reached_by: code — «меня добирает код» — или human.
  //
  // validate_kb.py проверить это не может: сборщик в другом репозитории.
  // Отсюда — может, оба каталога лежат рядом. Отказ здесь тихий с обеих
  // сторон: файл со статусом code, которого нет в сборщике, не доезжает
  // до бота НИ РАЗУ (так месяцами не доезжал sql-conventions.md), а путь
  // в сборщике без файла в базе даёт «статью не удалось прочитать».
  const dir = REGISTRY_AT.replace(/index\.md$/, 'process');
  if (!fs.existsSync(dir)) {
    check('папка регламентов найдена', false);
  } else {
    const src = fs.readFileSync('build_time_flows.py', 'utf8');
    const declared = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const head = fs.readFileSync(`${dir}/${f}`, 'utf8').slice(0, 600);
      const m = head.match(/^reached_by:\s*(\w+)/m);
      check(`${f}: признак reached_by объявлен`, Boolean(m));
      if (m && m[1] === 'code') declared.push(`kb/process/${f}`);
    }
    check('файлы с reached_by: code есть', declared.length > 0);
    for (const path of declared) {
      check(`${path} вписан в сборщик`, src.includes(`'${path}'`));
    }
    // И обратно: путь, вписанный в сборщик, обязан существовать в базе.
    const inCode = [...src.matchAll(/'(kb\/process\/[a-z0-9-]+\.md)'/g)]
      .map((m) => m[1]);
    check('пути регламентов в сборщике найдены', inCode.length > 0);
    for (const path of new Set(inCode)) {
      check(`${path} есть в базе`, fs.existsSync(`${dir}/../${path.slice(3)}`));
    }
  }
}

// ===================================================================== 30
line('30. ВОПРОС ПРО ОТЧЁТ распознаётся и без формы — в чате и в личке');
{
  // «Build materials» брал тему и ссылку из СЫРЫХ полей формы, а формы нет
  // ни в чате, ни в личке: оба поля там пустые. Значит правило «спрашивали
  // про отчёт, а отчёта в материалах нет» — и понижение уверенности за ним —
  // не срабатывало НИ РАЗУ вне канала. Ровно та же асимметрия, из-за которой
  // в чате не работало самообслуживание: у режима выгрузки фолбэк был,
  // у поиска отчёта — нет.
  const ROUTER = JSON.stringify({
    domains: ['headcount-structure'], articles: [], dd: [], no_question: false,
  });
  const q = 'привет! почему в дашборде ' +
    'https://proteus.tcsbank.ru/superset/dashboard/budget-corporate-events/ ' +
    'цифры не сходятся?';

  // Канал: тема и ссылка пришли формой.
  const ch = runPlan(ROUTER, REGISTRY, {
    question: q, topic_kind: 'Вопрос по отчетам',
    report_url: 'https://proteus.tcsbank.ru/superset/dashboard/budget-corporate-events/',
  });
  const chM = runMaterials(ch, ch.files.map(() => ({ content: b64('# Витрина') })));
  check('в канале вопрос про отчёт распознан', chM.asks_report === true);

  // Чат/личка: формы нет вовсе, ссылка — в тексте обращения.
  const chat = runPlan(ROUTER, REGISTRY, { question: q });
  check('ссылка найдена в тексте',
    /budget-corporate-events/.test(chat.report_url_found || ''));
  const chatM = runMaterials(chat, chat.files.map(() => ({ content: b64('# Витрина') })));
  check('без формы вопрос про отчёт тоже распознан', chatM.asks_report === true);
  // Отчёта среди материалов нет — автор обязан это увидеть.
  check('и отчёт в материалах не найден', chatM.report_seen === false);
  check('автору сказано про отсутствие отчёта',
    /отч[её]т/i.test(chatM.materials));

  // Обычный вопрос без отчёта — правило молчит: строка, которая горит
  // всегда, перестаёт читаться.
  const plain = runPlan(ROUTER, REGISTRY, { question: 'что такое текучесть' });
  const plainM = runMaterials(plain, plain.files.map(() => ({ content: b64('# Х') })));
  check('на обычном вопросе правило молчит', plainM.asks_report === false);
}

// ===================================================================== 31
line('31. ВОПРОС ПРО ПОДРАЗДЕЛЕНИЕ: рецепт поиска юнита добирается кодом');
{
  // Заказчик называет юнит словами, а в витрине это ключ на одном из десяти
  // уровней иерархии, и поля разные для каждого N. Угадать уровень нельзя —
  // нужен двухшаговый алгоритм из rc-find-unit-level. Роутер этот рецепт
  // выбирает не всегда: вопрос выглядит как «сколько аналитиков»,
  // и подразделение в нём — одно слово из пяти.
  const ROUTER = JSON.stringify({
    domains: [], articles: [], dd: [], no_question: false,
  });
  const ask = (q) => runPlan(ROUTER, REGISTRY, { question: q });

  const unit = ask('сколько BI-аналитиков в юните Human Capital Origination');
  check('рецепт добран по слову «юнит»', unit.added_unit.includes('rc-find-unit-level'));
  check('и статья реально уехала автору',
    unit.files.includes('kb/recipes/find-unit-level.md'));
  check('по слову «подразделение» тоже',
    ask('в каком подразделении работает Иванов').added_unit.length === 1);
  check('и по «департаменту»',
    ask('выгрузка по департаменту').added_unit.length === 1);

  // Без подразделения правило молчит: статья, которая приезжает всегда,
  // это 3 КБ шума на каждом обращении.
  check('на вопросе не про юнит правило молчит',
    ask('что такое текучесть').added_unit.length === 0);

  // \b рядом с кириллицей не работает — это пятый случай в проекте,
  // и первым написанием этого правила я его повторил.
  check('признак не сломан границей слова',
    ask('нужен список по юниту').added_unit.length === 1 &&
    ask('юнит Human Capital').added_unit.length === 1);

  // Путь берётся по id из реестра, а не вписан в сборщик: переименование
  // статьи не должно молча отключать правило.
  const src = fs.readFileSync('build_time_flows.py', 'utf8');
  check('рецепт добирается по id, а не по пути',
    src.includes("UNIT_IDS = ['rc-find-unit-level']") &&
    !src.includes("'kb/recipes/find-unit-level.md'"));
}

// ===================================================================== 32
line('32. ПРОВЕРКА ЗНАЧЕНИЙ ПОСЛЕ АВТОРА: сборка запроса');
{
  // Инвентарь в материалах — то, по чему сверяются имена полей. Придуманное
  // моделью имя это либо ошибка Trino, либо обращение к полю, которое мы
  // намеренно не показывали: ответ модели здесь данные, а не команда.
  const MAT = {
    materials:
      '=== МЕТАДАННЫЕ urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===\n' +
      'ПОЛЯ: business_dt, last_day_flg, emp_stream_desc, ' +
      'mapped_management_unit_nm, legal_unit_nm, grade, ' +
      'emp_specialization_desc, emp_specialization_oper_code, ' +
      'active_type_nm, emp_grade_desc\n',
  };

  const runCheck = (parsed, mat = MAT) => {
    const $ = (name) => {
      if (name === 'Build materials') return { first: () => ({ json: mat }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', js('Build check SQL'))($, parsed).map((i) => i.json);
  };

  // --- автор ничего не просил: это НОРМАЛЬНЫЙ путь, а не отказ.
  const none = runCheck({ check_values: '' });
  check('без блока автора SQL пустой', none.length === 1 && none[0].check_sql === '');
  check('и причина названа словами',
    /не просил/.test(none[0].check_reason));

  // --- обычный случай: две пары.
  const two = runCheck({
    check_values: 'emp_stream_desc = Дата\nmapped_management_unit_nm = Human Capital Origination',
  });
  check('запрос на КАЖДОЕ поле, а не один UNION на все', two.length === 2);
  check('и UNION в них нет вовсе',
    two.every((i) => !/\bUNION\b/i.test(i.check_sql)));
  check('канонический срез на месте',
    two.every((i) => /WHERE last_day_flg = 1/.test(i.check_sql)));
  check('регистронезависимость через lower(), а не ILIKE',
    two.every((i) => /lower\(/.test(i.check_sql) && !/ILIKE/i.test(i.check_sql)));
  check('схема чтения prod_v_, а не каталожная',
    two.every((i) => /FROM prod_v_emart\.mdm_employee_structure_d/.test(i.check_sql)));

  // Совпавшее поднято сортировкой, поэтому потолок строк не может выбросить
  // искомое — иначе «таких значений нет» стало бы утверждением о факте,
  // которого никто не проверял.
  check('совпавшее поднято сортировкой раньше потолка',
    two.every((i) => /ORDER BY exact_hit DESC, matched DESC[\s\S]*LIMIT/.test(i.check_sql)));

  // Пятый случай литерального \n вместо переноса строки был именно в SQL.
  check('в SQL настоящие переносы, а не литерал',
    two.every((i) => i.check_sql.includes('\n') && !i.check_sql.includes('\\n')));

  // Фраза бьётся на слова, кириллица режется до основы РОВНО ОДИН РАЗ:
  // «аналитик» → «аналит», второй проход дал бы «анал».
  const phrase = runCheck({ check_values: 'emp_stream_desc = BI-аналитики' })[0].check_sql;
  check('фраза ищется целиком', phrase.includes("'%bi-аналитики%'"));
  check('и слово из неё отдельно, срезанное до основы',
    phrase.includes("'%аналити%'"));
  check('стемминг не применён дважды', !/'%анал%'/.test(phrase));
  check('короткие куски отброшены', !/'%bi%'/.test(phrase));

  // --- имя поля не из инвентаря: отбрасывается и НАЗЫВАЕТСЯ.
  const bad = runCheck({ check_values: 'employee_login_nm = Иванов' });
  check('выдуманное поле не уходит в запрос', bad[0].check_sql === '');
  check('и названо в отсеве',
    bad[0].check_skipped.some((x) => /employee_login_nm/.test(x) && /инвентар/.test(x)));

  // --- потолок пар: тоже называется, а не режет молча.
  // Потолок поднят с 4 до 8: запрос идёт ПО ЗАПРОСУ НА ПОЛЕ, и GROUP BY
  // в нём всё равно проходит по всему срезу — восьмая пара стоит одного
  // вызова, а не восьмикратного скана. В выгрузках фильтров всегда больше
  // четырёх, и «не проверялись» в логе читалось как «проверять было нечего».
  const many = runCheck({
    check_values: ['emp_stream_desc = a', 'legal_unit_nm = b', 'grade = c',
                   'business_dt = d', 'mapped_management_unit_nm = e',
                   'emp_specialization_desc = f', 'emp_specialization_oper_code = g',
                   'active_type_nm = h', 'emp_grade_desc = i'].join('\n'),
  });
  check('потолок пар соблюдён', many.length === 8);
  check('и остаток назван числом',
    many[0].check_skipped.some((x) => /потолок/.test(x)));
  // Поле без подчёркивания — не выдуманное. `grade` самое частое слово
  // в живом трафике, и требование `_` молча выключало бы проверку на нём.
  check('однословное поле не считается выдуманным',
    runCheck({ check_values: 'grade = 15' })[0].check_sql.includes('grade'));

  // --- витрины в материалах нет: идти некуда, и это сказано.
  const noTable = runCheck({ check_values: 'grade = 15' }, { materials: 'статья без метаданных' });
  check('без витрины запроса нет', noTable[0].check_sql === '');
  check('и причина отличается от «автор не просил»',
    /витрин/.test(noTable[0].check_reason));

  // --- апостроф в значении не ломает запрос.
  const quote = runCheck({ check_values: "legal_unit_nm = O'Brien" })[0].check_sql;
  check('кавычка экранирована', quote.includes("''"));
}

// ===================================================================== 33
line('33. ПРОВЕРКА ЗНАЧЕНИЙ: пять исходов звучат по-разному');
{
  const PLAN = { check_pairs: [{ field: 'emp_stream_desc' }], check_skipped: [] };
  const runRes = (rows, plan = PLAN) => {
    const $ = (name) => {
      if (name === 'Build check SQL') return { first: () => ({ json: plan }) };
      if (name === 'Check values') {
        if (rows === null) throw new Error('node not executed: Check values');
        return { all: () => rows.map((json) => ({ json })) };
      }
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', js('Check result'))($, {})[0].json;
  };

  // 1. Совпало: значения заказчика есть в данных.
  const hit = runRes([
    { fld: 'emp_stream_desc', val: 'Data', cnt: 120, exact_hit: true, matched: true },
    { fld: 'emp_stream_desc', val: 'Retail', cnt: 90, matched: false },
  ]);
  check('совпавшее названо отдельно', /ТОЧНОЕ СОВПАДЕНИЕ/.test(hit.check_block));
  check('и значение дословно', hit.check_block.includes('«Data»'));
  check('прочие подписаны иначе', /прочие значения поля/.test(hit.check_block));
  check('строки посчитаны', hit.check_rows === 2);

  // 2. Не совпало ничего: перечень и ЕСТЬ ответ. Справочники ведутся
  //    по-английски, заказчик называет по-русски — по буквам не сойдётся
  //    никогда, искомое находится только глазами по списку.
  const miss = runRes([
    { fld: 'emp_stream_desc', val: 'Data', cnt: 120, matched: false },
    { fld: 'emp_stream_desc', val: 'Retail', cnt: 90, matched: false },
  ]);
  check('промах назван прямо', /НЕ СОВПАЛО НИЧЕГО/.test(miss.check_block));
  // Случай (а) — другое написание того же понятия — остаётся: ради него
  // перечень и печатается целиком.
  check('другое написание того же понятия названо',
    /«Дата» это «Data»/.test(miss.check_block));
  // А случай (б) — слово из ДРУГОГО поля — раньше отсутствовал, и вместо
  // него стояло «найди подходящее ПО СМЫСЛУ». Ровно эта строка 2026-08-31
  // велела автору подставить «Финансы» вместо «HQ».
  check('неверно выбранное поле названо вторым случаем',
    /ПОЛЕ\s*\n?\s*ВЫБРАНО НЕВЕРНО/.test(miss.check_block));
  check('подбор похожего запрещён прямо',
    /НЕ подбирай «похожее/.test(miss.check_block));
  check('раскладка одного слова в набор запрещена',
    /НЕ раскладывай одно слово заказчика/.test(miss.check_block));
  check('приглашения «найди по смыслу» больше нет',
    !/найди подходящее/i.test(miss.check_block));

  // Потолок словаря зависит от исхода: при совпадениях словарь это фон
  // и шести хватает, без совпадений словарь и есть ответ.
  const wide = (matched) => runRes(
    Array.from({ length: 40 }, (_, i) => (
      { fld: 'emp_stream_desc', val: 'v' + i, cnt: 1, matched: false }))
      .concat(matched
        ? [{ fld: 'emp_stream_desc', val: 'ЦЕЛЬ', cnt: 5, exact_hit: true, matched: true }]
        : []),
  );
  const cnt = (b) => (b.match(/^ {4}«/gm) || []).length;
  check('без совпадений словарь печатается целиком', cnt(wide(false).check_block) === 40);
  check('с совпадением словарь урезан до фона', cnt(wide(true).check_block) === 7);

  // ПОТОЛОК ЗАПРОСА И ПОТОЛОК ПЕЧАТИ ЖИВУТ В РАЗНЫХ НОДАХ И ОБЯЗАНЫ СОВПАДАТЬ.
  // «Build check SQL» ставит LIMIT, «Check result» режет печать — разъедутся
  // молча: строки придут, за них заплатят запросом, а автор их не увидит,
  // и «не встретилось» опять прочитается как «такого нет». Тот же класс,
  // что связка режима записи и условия фильтра в телеметрии (тест 33).
  const sqlCap = Number((js('Build check SQL').match(/MAX_ROWS\s*=\s*(\d+)/) || [])[1]);
  const printCap = Number(
    (js('Check result').match(/\?\s*6\s*:\s*(\d+)\s*\)\)/) || [])[1]);
  check('потолок словаря найден в обеих нодах',
    Number.isFinite(sqlCap) && Number.isFinite(printCap));
  check('и он один и тот же: ' + sqlCap + ' / ' + printCap, sqlCap === printCap);
  // Про emp_specialization_desc известно только «не меньше 200» — прогон
  // 2026-08-27 упёрся в LIMIT и измерил сам потолок, а не кардинальность.
  // Ставить потолком то самое число значит гарантированно резать хвост.
  check('и он выше единственного известного замера (200)', sqlCap > 200);

  // 3. Запрос отказал — это НЕ «значений нет».
  const failed = runRes([{ error: "mismatched input 'ILIKE'" }]);
  check('отказ назван отказом', /не выполнился/.test(failed.check_block));
  check('и прямо запрещено утверждать отсутствие',
    /ничего не утверждай/.test(failed.check_block));
  check('текст отказа сохранён', /ILIKE/.test(failed.check_failed));

  // 4. Ноль строк: n8n отдаёт пустой элемент при alwaysOutputData.
  const empty = runRes([{}]);
  check('пустой элемент читается как «строк нет»', empty.check_rows === 0);
  check('и это не выдаётся за отсутствие значения',
    /ничего не утверждай/.test(empty.check_block) && !/НЕ СОВПАЛО/.test(empty.check_block));

  // 5. Узел не выполнялся вовсе.
  const never = runRes(null);
  check('невыполненный узел назван своим исходом',
    /не выполнялся/.test(never.check_failed));

  // Отсев пар доезжает до автора: молча урезанная проверка читается как полная.
  const skipped = runRes([{ fld: 'emp_stream_desc', val: 'Data', cnt: 1, matched: true }],
    { check_pairs: [], check_skipped: ['grade (нет в инвентаре)'] });
  check('отсев назван автору', /Не проверялись: grade/.test(skipped.check_block));
}

// ===================================================================== 34
line('34. РЕШЕНИЕ «ПРОВЕРЯТЬ ЛИ» ПРИНИМАЕТ КОД, А НЕ АВТОР');
{
  const MAT = { materials:
    '=== МЕТАДАННЫЕ urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===\n' +
    'ПОЛЯ: last_day_flg, emp_specialization_desc, emp_stream_desc, grade, ' +
    'legal_unit_nm, mapped_management_unit_nm, full_nm, ad_login, ' +
    'wrk_email_address_txt, contact_main_phone_no\n' };
  const runCheck = (parsed, mat = MAT) => {
    const $ = (name) => {
      if (name === 'Build materials') return { first: () => ({ json: mat }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', js('Build check SQL'))($, parsed).map((i) => i.json);
  };

  // ЖИВОЙ КЕЙС 2026-08-28. Бот выдал готовый SQL с фильтром по специализации,
  // сам написал в «Чего не хватило», что значение не проверено и нужен
  // select distinct, — и блок ПРОВЕРИТЬ ЗНАЧЕНИЯ не поставил. В логе осталось
  // «автор не просил проверять значения»: узел зелёный, ветка пропущена,
  // по виду прогона отказ неотличим от нормы.
  const live = runCheck({
    check_values: '',
    draft: "select count(*) from prod_v_emart.mdm_employee_structure_d\n" +
           "where last_day_flg = 1 and grade = 13\n" +
           "  and emp_specialization_desc = 'Продуктовый аналитик'",
  });
  check('проверка идёт без просьбы автора', live.length === 1);
  check('и именно по полю из фильтра', live[0].check_field === 'emp_specialization_desc');
  check('значение взято из литерала', live[0].check_value === 'Продуктовый аналитик');
  check('источник пары назван', live[0].check_pairs[0].src === 'фильтр в черновике');

  // Число без кавычек не берём: ошибаются на справочниках, которые ведутся
  // словами, а grade = 13 стоил бы лишнего скана витрины.
  check('числовой фильтр не проверяется',
    !live.some((i) => i.check_field === 'grade'));

  // Блок автора остаётся вторым каналом — им просят проверить то, чего
  // в черновике ещё нет.
  const asked = runCheck({ check_values: 'emp_stream_desc = Дата', draft: 'без SQL' });
  check('блок автора по-прежнему работает', asked[0].check_field === 'emp_stream_desc');
  check('и помечен своим источником', asked[0].check_pairs[0].src === 'блок автора');

  // Дубль не удваивает запрос: одна пара — один поход в данные.
  const dup = runCheck({
    check_values: 'emp_stream_desc = Дата',
    draft: "where emp_stream_desc = 'Дата'",
  });
  check('пара из двух источников не дублируется', dup.length === 1);

  // Список IN разбирается целиком: проверить первое и промолчать про
  // остальные значит назвать проверенным то, что не проверяли.
  const inList = runCheck({ check_values: '',
    draft: "where emp_specialization_desc in ('Аналитик BI', 'Продуктовый аналитик')" });
  check('список IN разобран целиком', inList.length === 2);

  // lower(...) LIKE '%...%' — самая частая форма в черновиках бота.
  const like = runCheck({ check_values: '',
    draft: "where lower(emp_stream_desc) like '%data%'" });
  check('форма lower(...) LIKE разобрана', like.length === 1);
  check('и проценты из литерала срезаны', like[0].check_value === 'data');

  // Нет фильтров по значению — проверять нечего, и это НОРМАЛЬНЫЙ путь.
  // Причина обязана отличаться от «пары были и не прошли»: чинится разное.
  const none = runCheck({ check_values: '', draft: 'обычный текстовый ответ без запроса' });
  check('без фильтров запроса нет', none[0].check_sql === '');
  check('и причина не сваливает вину на автора',
    /нет фильтров по значению/.test(none[0].check_reason));
}

// ===================================================================== 35
line('35. ПДн НЕ ТЯНУТСЯ, И ФИЛЬТРОВ ДВА');
{
  const BASE = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ' +
    'ПОЛЯ: last_day_flg, emp_specialization_desc, legal_unit_nm, ' +
    'mapped_management_unit_nm, full_nm, ad_login, wrk_email_address_txt, ' +
    'contact_main_phone_no';
  const runCheck = (draft, materials = BASE) => {
    const $ = (name) => ({ first: () => ({
      json: name === 'Parse answer' ? { draft } : { materials },
    }) });
    return new Function('$', '$json', js('Build check SQL'))($, { draft, check_values: '' })
      .map((i) => i.json);
  };

  // Пока пары приходили только от автора, дыру прикрывала дисциплина модели,
  // то есть ничего. Теперь пары добывает код прямо из черновика, и запрос
  // по ФИО собрался бы САМ, без чьего-либо решения.
  const pii = runCheck("where full_nm = 'Иванов' and ad_login = 'ivanov' " +
    "and wrk_email_address_txt like '%@t%' and contact_main_phone_no = '+7'");
  check('по ПДн запрос не собирается', pii[0].check_sql === '');
  check('и каждое поле названо в отсеве',
    ['full_nm', 'ad_login', 'wrk_email_address_txt', 'contact_main_phone_no']
      .every((f) => pii[0].check_skipped.some((x) => x.startsWith(f))));
  check('причина отсева — именно ПДн',
    pii[0].check_skipped.every((x) => /персональные данные/.test(x)));

  // `_nm` — это название ЧЕГО-ТО, а не имя человека. Голый суффикс в списке
  // отсеивал бы ровно те поля, ради которых ветка и заведена.
  const units = runCheck("where legal_unit_nm = 'ООО Т' " +
    "and mapped_management_unit_nm = 'Human Capital Origination'");
  check('поля с _nm персональными не считаются', units.length === 2);

  // Второй фильтр: признак каталога может стоять на поле, которого
  // в списке имён нет.
  const sens = runCheck("where emp_specialization_desc = 'Аналитик'",
    BASE + ' ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ 1 из 9: emp_specialization_desc (ad_group_hr). Каждое');
  check('признак каталога тоже отсеивает', sens[0].check_sql === '');
  check('и назван отдельной причиной',
    sens[0].check_skipped.some((x) => /признаку каталога/.test(x)));

  // Без признака то же поле проверяется — иначе фильтр гасил бы всё подряд.
  check('без признака поле проверяется',
    runCheck("where emp_specialization_desc = 'Аналитик'").length === 1);
}

// ===================================================================== 36
line('36. АКТИВНАЯ ЧИСЛЕННОСТЬ — УМОЛЧАНИЕ ЛЮБОГО ЗАПРОСА ПО СОТРУДНИКАМ');
{
  const EMPTY = JSON.stringify({ domains: [], articles: [], dd: [], no_question: false });
  const ask = (q) => runPlan(EMPTY, REGISTRY, { question: q });

  // Статья с формулой добирается КОДОМ. Роутер её не выбирает: вопрос
  // выглядит как «выгрузи аналитиков», а не как «что такое численность».
  const sql = ask('помоги написать sql, чтобы выгрузить продуктовых аналитиков 13 грейда');
  check('на просьбе про запрос статья добрана',
    sql.added_headcount.includes('m-active-headcount'));
  check('и реально уехала автору',
    sql.files.includes('kb/metrics/active-headcount.md'));

  const exp = runPlan(EMPTY, REGISTRY,
    { question: 'нужна выгрузка', topic_kind: 'Выгрузка данных' });
  check('на выгрузке тоже добрана', exp.added_headcount.length === 1);

  // На обычном вопросе не добирается: статья, которая приезжает всегда, —
  // это расход на каждом обращении без причины.
  check('на обычном вопросе правило молчит',
    ask('что такое текучесть').added_headcount.length === 0);

  // Путь берётся по id из реестра: переименование статьи не должно молча
  // отключать правило.
  const src = fs.readFileSync('build_time_flows.py', 'utf8');
  check('добирается по id, а не по вписанному пути',
    src.includes("HEADCOUNT_IDS = ['m-active-headcount']") &&
    !src.includes("'kb/metrics/active-headcount.md'"));

  // Формула НЕ дублируется в сборщике: правила расчёта живут в git, и вторая
  // копия разъехалась бы молча. Код добирает статью и мерит результат,
  // но условия не выписывает — кроме проверочного запроса, где SQL пишет он.
  check('формулы метрики в узле Plan нет — ни кодом, ни комментарием',
    !/active_employee_flg/.test(js('Plan')));

  // ЕДИНСТВЕННАЯ копия формулы — в проверочном запросе, потому что там SQL
  // пишет код. Копия и статья лежат рядом на диске, и разъехаться им нечем
  // только если это проверять: тот же приём, что двусторонняя сверка
  // reached_by. Изменится формула в базе — покраснеет здесь, а не в проде.
  const article = ['../executive-support/kb/metrics/active-headcount.md',
                   '../kb/metrics/active-headcount.md'].find((f) => fs.existsSync(f));
  check('статья про активную численность найдена', Boolean(article));
  const formula = fs.readFileSync(article, 'utf8')
    .match(/```sql\n(active_employee_flg[^`]*?)\n```/);
  check('формула в статье найдена детектором', Boolean(formula));
  const want = formula[1].trim().toLowerCase().replace(/\s+/g, ' ');
  const got = (js('Build check SQL')
    .match(/'(active_employee_flg[^']*company_fire_flg[^']*)'/) || [])[1] || '';
  check(`условие в коде совпадает со статьёй: «${want}»`,
    got.toLowerCase().replace(/\s+/g, ' ') === want);
}

// ===================================================================== 37
line('37. ЗАПРОС БЕЗ ФИЛЬТРА АКТИВНОСТИ НАЗЫВАЕТСЯ');
{
  const parseJs = js('Parse answer');
  const runParse = (draft, question) => {
    const $ = (name) => {
      if (name === 'When called by adapter') return { first: () => ({ json: { question } }) };
      if (name === 'Plan') return { first: () => ({ json: {} }) };
      if (name === 'Build materials') {
        return { first: () => ({ json: { materials: 'x', has_materials: true } }) };
      }
      if (name === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', parseJs)($, {
      output: 'ЧЕРНОВИК ОТВЕТА: ' + draft + '\nУВЕРЕННОСТЬ: высокая',
    })[0].json;
  };

  const BAD = 'select count(*) from prod_v_emart.mdm_employee_structure_d ' +
    "where last_day_flg = 1 and emp_specialization_desc = 'Продуктовый аналитик'";
  const GOOD = BAD + ' and active_employee_flg = 1 and company_fire_flg = 0';

  // Ошибка, которую заказчик не замечает: запрос не падает, просто людей
  // больше, чем есть.
  check('запрос без фильтра назван',
    runParse(BAD, 'выгрузи продуктовых аналитиков').draft_no_active_filter === true);
  check('с фильтром — молчит',
    runParse(GOOD, 'выгрузи продуктовых аналитиков').draft_no_active_filter === false);

  // Оба флага обязательны: одного мало, и половина правила хуже, чем видно.
  check('одного флага недостаточно',
    runParse(BAD + ' and active_employee_flg = 1',
      'выгрузи аналитиков').draft_no_active_filter === true);

  // Там, где спрашивают про уволенных, фильтр как раз НЕВЕРЕН — он выбросит
  // ровно тех, про кого вопрос. Ложная тревога на верном черновике
  // обесценивает и себя, и соседние строки.
  for (const q of ['сколько человек уволилось за год', 'посчитай отток по юнитам',
                   'текучесть в дирекции', 'динамика найма за период',
                   'нужны все сотрудники, включая уволенных']) {
    check(`не срабатывает на «${q.slice(0, 24)}…»`,
      runParse(BAD, q).draft_no_active_filter === false);
  }

  // Черновик без запроса по витрине сотрудников проверку не трогает.
  check('на ответе без SQL молчит',
    runParse('текучесть считается по статье', 'что такое текучесть')
      .draft_no_active_filter === false);
}

// ===================================================================== 38
line('38. ТОЧНОЕ СОВПАДЕНИЕ НЕ ПОДМЕНЯЕТСЯ ПОХОЖИМ');
{
  // ЖИВОЙ КЕЙС 2026-08-28. Заказчик спросил продуктовых аналитиков; в поле
  // есть и «Продуктовый аналитик» (685), и «Продуктовый аналитик (DA)» (806).
  // Обе строки matched, и при сортировке по count вариант с (DA) встал ВЫШЕ
  // точного совпадения — автор взял первую строку и подставил в фильтр
  // не то, что сам же написал в первом проходе. Проверка ЗАМЕНИЛА верное
  // значение на неверное, а это хуже, чем не проверять вовсе.
  const MAT = { materials:
    'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ' +
    'ПОЛЯ: last_day_flg, active_employee_flg, company_fire_flg, emp_specialization_desc' };
  const D38 = "where emp_specialization_desc = 'Продуктовый аналитик'";
  const sql = new Function('$', '$json', js('Build check SQL'))(
    (name) => ({ first: () => ({ json: name === 'Parse answer' ? { draft: D38 } : MAT }) }),
    { check_values: '', draft: D38 },
  )[0].json.check_sql;

  check('признак точного совпадения есть в запросе',
    /AS exact_hit/.test(sql));
  check('и сравнение идёт с целой фразой',
    sql.includes("= 'продуктовый аналитик'"));
  check('сортировка ставит точное ПЕРВЫМ, раньше частоты',
    /ORDER BY exact_hit DESC, matched DESC, cnt DESC/.test(sql));

  // Блок для автора: три уровня, и точное названо точным.
  const rows = [
    { fld: 'emp_specialization_desc', val: 'Продуктовый аналитик', cnt: 685,
      exact_hit: true, matched: true },
    { fld: 'emp_specialization_desc', val: 'Продуктовый аналитик (DA)', cnt: 806,
      exact_hit: false, matched: true },
    { fld: 'emp_specialization_desc', val: 'Кредитный аналитик', cnt: 158,
      exact_hit: false, matched: false },
  ];
  const res = new Function('$', '$json', js('Check result'))(
    (n) => (n === 'Build check SQL'
      ? { first: () => ({ json: { check_skipped: [] } }) }
      : { all: () => rows.map((json) => ({ json })) }),
    {},
  )[0].json;
  const b = res.check_block;

  check('точное совпадение названо точным', /ТОЧНОЕ СОВПАДЕНИЕ/.test(b));
  check('и стоит выше похожего',
    b.indexOf('«Продуктовый аналитик»') < b.indexOf('«Продуктовый аналитик (DA)»'));
  check('похожее прямо запрещено ставить в фильтр',
    /В ФИЛЬТР НЕ СТАВЬ/.test(b));
  check('но его велено НАЗВАТЬ коллеге', /НАЗОВИ\s+коллеге/.test(b));
  check('факт точного совпадения посчитан', res.check_exact === 1);

  // Точного нет — прежнее поведение: выбрать по смыслу.
  const noExact = new Function('$', '$json', js('Check result'))(
    (n) => (n === 'Build check SQL'
      ? { first: () => ({ json: { check_skipped: [] } }) }
      : { all: () => rows.slice(1).map((json) => ({ json })) }),
    {},
  )[0].json;
  check('без точного совпадения — два случая, а не «выбери по смыслу»',
    /дословного совпадения нет/.test(noExact.check_block) &&
    /НИЧЕГО НЕ ПОДСТАВЛЯЙ/.test(noExact.check_block) &&
    !/ТОЧНОЕ СОВПАДЕНИЕ/.test(noExact.check_block));
  check('и счётчик точных нулевой', noExact.check_exact === 0);

  // Промпт правки: подтверждённое значение не заменяется, а устаревшая
  // оговорка вычищается — именно она пережила правку в живом прогоне,
  // потому что «всё остальное оставь как было».
  const rev = JSON.parse(fs.readFileSync('Support Bot Core.json', 'utf8'))
    .nodes.find((n) => n.name === 'Revise draft').parameters.text;
  check('правка не даёт заменить подтверждённое похожим',
    /не меняй ни на что из соседних блоков/.test(rev));
  check('и велит вычистить устаревшую оговорку',
    /select distinct/.test(rev) && /вычистить/.test(rev));
}

// ===================================================================== 39
line('39. ЧЕРНОВИК — MARKDOWN, А НЕ ЧИСТЫЙ SQL');
{
  const MAT = { materials:
    'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ПОЛЯ: ' +
    'last_day_flg, active_employee_flg, company_fire_flg, ' +
    'emp_specialization_desc, residential_city_nm, emp_stream_desc' };
  const runCheck = (draft) => {
    const $ = (name) => ({ first: () => ({
      json: name === 'Parse answer' ? { draft } : MAT,
    }) });
    return new Function('$', '$json', js('Build check SQL'))($, { draft, check_values: '' })
      .map((i) => i.json);
  };

  // ЖИВОЙ КЕЙС 2026-08-28. Автор не стал ставить значения в запрос, а вынес
  // их списком в текст — то есть сделал ровно то, что от него требуется.
  // Проверка всё равно не запустилась: имя поля обёрнуто в обратные кавычки,
  // и прежняя регулярка допускала между именем и оператором только скобку.
  // В логе осталось «в черновике нет фильтров по значению».
  const live = runCheck([
    'Подготовьте пары для проверки:',
    '',
    "- `emp_specialization_desc` = 'GO разработчик'",
    "- `residential_city_nm` = 'Краснодар'",
  ].join('\n'));
  check('пара в обратных кавычках разобрана', live.length === 2);
  check('имя поля не потеряно',
    live.map((i) => i.check_field).sort().join()
      === 'emp_specialization_desc,residential_city_nm');
  check('значение не потеряно',
    live.some((i) => i.check_value === 'GO разработчик'));

  // Подчёркивание — и разметка курсива, и часть КАЖДОГО имени поля.
  // Снять его вместе с остальной разметкой значит превратить
  // emp_specialization_desc в три слова и отправить в отбор `desc`.
  check('подчёркивание в имени уцелело',
    !live.some((i) => /^(desc|nm)$/.test(i.check_field)));

  // Кавычки у значения в прозе бывают разные: пропустить пару из-за ёлочки
  // значит не проверить значение, названное прямым текстом.
  check('двойные кавычки', runCheck('emp_stream_desc = "Data"')[0].check_value === 'Data');
  check('ёлочки', runCheck('emp_stream_desc = «Data»')[0].check_value === 'Data');
  check('жирный шрифт вокруг поля не мешает',
    runCheck("**emp_stream_desc** = 'Data'")[0].check_field === 'emp_stream_desc');

  // Прежние формы не сломались.
  check('обычный SQL по-прежнему разбирается',
    runCheck("where emp_stream_desc = 'Data'")[0].check_field === 'emp_stream_desc');
  check('и список IN тоже',
    runCheck("where emp_stream_desc in ('Data', 'Retail')").length === 2);
}

// ===================================================================== 40
line('40. ДОСПРОС: автор сам знает, чего не хватило — надо спросить');
{
  const MAT = { materials:
    'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ПОЛЯ: ' +
    'last_day_flg, active_employee_flg, company_fire_flg, ' +
    'emp_specialization_desc, residential_city_nm' };
  const build = (parsed, input) => {
    const $ = (name) => {
      if (name === 'Build materials') return { first: () => ({ json: MAT }) };
      if (name === 'Parse answer') return { first: () => ({ json: parsed }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', js('Build check SQL'))($, input ?? parsed)
      .map((i) => i.json);
  };

  // ЖИВОЙ КЕЙС 2026-08-28. Разбор пар промахнулся, но автор в «Чего
  // не хватило» прямым текстом написал, что проверить: выбрасывать это
  // и гадать по разметке — расточительно.
  const GAPS = 'Значения полей emp_specialization_desc и residential_city_nm ' +
    'не проверены — точное написание «GO разработчик» и «Краснодар» ' +
    'в данных неизвестно.';
  const missed = build({ draft: 'запрос без литералов', gaps: GAPS, check_values: '' });
  check('пар не нашлось', missed[0].check_sql === '');
  check('но доспрос включён', missed[0].check_retry === true);

  // Гейт узкий: без признания автора лишний вызов модели не нужен.
  check('без признания автора доспроса нет',
    build({ draft: 'обычный ответ', gaps: 'нет статьи про X', check_values: '' })[0]
      .check_retry === false);
  // Пары нашлись — доспрашивать не о чем.
  const ok = build({ draft: "where emp_specialization_desc = 'GO разработчик'",
                     gaps: GAPS, check_values: '' });
  check('при найденных парах доспроса нет', ok[0].check_retry === false);

  // Разбор ответа доспроса: модель просили вернуть голые строки, но она
  // может обернуть их в markdown или дописать пояснение.
  const parsePairs = (output) =>
    new Function('$', '$json', js('Parse pairs'))(() => {
      throw new Error('нет узлов');
    }, { output })[0].json;
  const p1 = parsePairs([
    'Вот пары:',
    '- `emp_specialization_desc` = GO разработчик',
    '- **residential_city_nm** = Краснодар',
  ].join('\n'));
  check('пары из доспроса разобраны', p1.ask_pairs_found === 2);
  check('и лишнее не попало', !/Вот пары/.test(p1.check_values));
  check('пустой ответ — нормальный исход',
    parsePairs('НЕТ').ask_pairs_found === 0);

  // ВТОРОЙ сборщик работает тем же кодом: пары из доспроса, черновик
  // по-прежнему у «Parse answer».
  const retried = build({ draft: 'запрос без литералов', gaps: GAPS },
    { check_values: p1.check_values });
  check('после доспроса запросы собрались', retried.length === 2);
  check('и по тем самым полям',
    retried.map((i) => i.check_field).sort().join()
      === 'emp_specialization_desc,residential_city_nm');
  check('значения из доспроса доехали',
    retried.some((i) => i.check_value === 'GO разработчик'));

  // Доспрос РОВНО ОДИН: второй сборщик доспрос уже не включает, даже
  // если пар опять нет. Иначе вернулся бы счётчик итераций.
  const twice = build({ draft: 'x', gaps: GAPS }, { check_values: 'НЕТ' });
  check('второго доспроса не запрашивается', twice[0].check_retry === true);
  const conn = JSON.parse(fs.readFileSync('Support Bot Core.json', 'utf8')).connections;
  check('и его некуда сделать: обратной связи в графе нет',
    !(conn['Need check after ask']?.main || []).flat()
      .some((e) => /Ask pairs|Need retry/.test(e.node)));
}

// ===================================================================== 41
line('41. ПУТЬ СТАТЬИ: реестр — источник правды, а не память роутера');
{
  // ЖИВОЙ КЕЙС 2026-08-31. Роутер назвал `kb/field-synonyms.md`; настоящий
  // путь — `kb/recipes/field-synonyms.md`. Разошлись на одну папку, и
  // потерялась ровно та статья, в которой лежал ответ: словарь
  // «слово заказчика → поле» со строкой HQ/Line/Support →
  // emp_specialization_oper_code. Бот сам понял, чего ему не хватает,
  // сам это попросил — и написал в ТЗ «поля не обнаружено».
  const said = (arts) => runPlan(JSON.stringify({
    domains: [], articles: arts, dd: [], no_question: false,
  }));

  const miss = said(['kb/field-synonyms.md']);
  check('промах в папке восстановлен по имени файла',
    miss.files.includes('kb/recipes/field-synonyms.md'));
  check('и восстановление названо, а не сделано молча',
    miss.articles_recovered.length === 1 &&
    miss.articles_recovered[0].said === 'kb/field-synonyms.md');
  check('выдуманным такой путь больше не считается',
    miss.articles_invented.length === 0);

  // Основная форма после правки: роутер называет id, путь подставляет код.
  // Тогда выдуманный путь невозможен по конструкции, а не по дисциплине.
  const byId = said(['rc-field-synonyms', 'm-turnover']);
  check('id резолвится в путь по реестру',
    byId.files.includes('kb/recipes/field-synonyms.md') &&
    byId.files.includes('kb/metrics/turnover.md'));
  check('и это видно отдельным полем', byId.articles_by_id.length === 2);
  check('выбор роутера засчитан путями, а не сырым вводом',
    byId.router_articles.includes('kb/metrics/turnover.md'));

  // Восстанавливаем ТОЛЬКО при единственном кандидате: тихо прочитать
  // не ту статью хуже, чем не прочитать никакую. И то, что не резолвится
  // ничем, остаётся выдуманным — диагноз у него свой.
  const ghost = said(['kb/recipes/nothing-like-this.md']);
  check('невосстановимый путь остаётся выдуманным',
    ghost.articles_invented.includes('kb/recipes/nothing-like-this.md'));
  check('и восстановленным не объявляется', ghost.articles_recovered.length === 0);

  // Понижение уверенности: статья, которую роутер счёл нужной, не доехала.
  // Раньше это уверенность не трогало вовсе, и по логу потеря статьи была
  // неотличима от «такой статьи в базе нет».
  const parseJs = js('Parse answer');
  const runP = (mat) => new Function('$', '$json', parseJs)(
    (name) => {
      if (name === 'When called by adapter') return { first: () => ({ json: { question: 'q' } }) };
      if (name === 'Plan') return { first: () => ({ json: {} }) };
      if (name === 'Build materials') return { first: () => ({ json: mat }) };
      if (name === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
      throw new Error('node not executed: ' + name);
    },
    { output: 'ЧЕРНОВИК ОТВЕТА: текст\nУВЕРЕННОСТЬ: высокая' },
  )[0].json;

  const lost = runP({
    materials: 'x', has_materials: true,
    articles_invented: ['kb/field-synonyms.md'],
  });
  check('непрочитанная статья понижает уверенность',
    lost.confidence_key === 'medium');
  check('и причина названа путём',
    /kb\/field-synonyms\.md/.test(lost.confidence_capped_reason));

  const ok = runP({
    materials: 'x', has_materials: true,
    articles_recovered: [{ said: 'kb/field-synonyms.md',
                           path: 'kb/recipes/field-synonyms.md' }],
  });
  check('восстановленная статья уверенность НЕ понижает — она доехала',
    ok.confidence_key === 'high');
}

// ===================================================================== 41б
line('41б. СЛОВАРЬ СИНОНИМОВ добирается КОДОМ, а не по просьбе в промпте');
{
  // ЖИВОЙ КЕЙС 2026-08-31, личка: «напиши sql сколько актуальных сотрудников
  // по покраске hq и bigops». Словаря в материалах не было, и «HQ» ушло
  // искаться среди названий управленческих подразделений — где его нет
  // и быть не может. Заказчику уехал запрос по трём подразделениям,
  // подобранным «по смыслу».
  //
  // Мост «слово заказчика → поле» существует ТОЛЬКО в rc-field-synonyms:
  // в описаниях полей каталога нет ни «покраски», ни «HQ», и поиск
  // по смыслу их не находит никогда.
  const q = 'напиши sql сколько актуальных сотрудников по покраске hq и bigops';
  const p = runPlan(
    JSON.stringify({ domains: ['headcount-structure'], articles: [], dd: [], no_question: false }),
    REGISTRY, { question: q },
  );
  check('словарь синонимов добран кодом',
    p.added_synonyms.includes('rc-field-synonyms'));
  check('и доехал до чтения',
    p.files.includes('kb/recipes/field-synonyms.md'));

  // Гейт тот же, что у sql-conventions и активной численности: там, где
  // пишется select или собирается состав выгрузки. На вопросе «что такое
  // текучесть» словарь не нужен и стоил бы токенов на каждом обращении.
  const plain = runPlan(
    JSON.stringify({ domains: ['movement'], articles: [], dd: [], no_question: false }),
    REGISTRY, { question: 'что такое текучесть' },
  );
  check('на обычном вопросе словарь не добирается',
    !plain.added_synonyms.length);

  // Сам мост должен быть в статье: слова из живого трафика обязаны
  // переводиться в имена полей. Тест ломается при правке базы, а не только
  // кода — как тесты мастеров домена.
  const dict = fs.readFileSync(
    REGISTRY_AT.replace('index.md', 'recipes/field-synonyms.md'), 'utf8');
  check('покраска ведёт к оперативному коду',
    /покраска/i.test(dict) && /emp_specialization_oper_code/.test(dict));
  check('IT-покраска — к своему полю',
    /emp_specialization_it_code/.test(dict));
  check('BigOps назван старым именем Line + Support',
    /BigOps/.test(dict) && /Line/.test(dict) && /Support/.test(dict));
  check('и требует вопроса, а не раскладки за заказчика',
    /задай один вопрос/i.test(dict));
}

// ===================================================================== 42
line('42. УВОЛЬНЕНИЕ — ТОЛЬКО ПО ФЛАГУ, И НАЗВАНИЕ КОМПАНИИ НЕ ФИЛЬТР');
{
  const parseJs = js('Parse answer');
  const runP = (draft, question = 'сколько уволилось') =>
    new Function('$', '$json', parseJs)(
      (name) => {
        if (name === 'When called by adapter') return { first: () => ({ json: { question } }) };
        if (name === 'Plan') return { first: () => ({ json: {} }) };
        if (name === 'Build materials') {
          return { first: () => ({ json: { materials: 'x', has_materials: true } }) };
        }
        if (name === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
        throw new Error('node not executed: ' + name);
      },
      { output: 'ЧЕРНОВИК ОТВЕТА: ' + draft + '\nУВЕРЕННОСТЬ: высокая' },
    )[0].json;

  // Живой кейс 2026-08-31: «мастер id и дата увольнения всех, кто уволился
  // с января 2023 по август 2026». Дата увольнения проставляется ЗАРАНЕЕ,
  // и такое увольнение может не состояться — в счёт уезжают несвершившиеся
  // события. Запрос не падает, цифра правдоподобна, сверить не с чем.
  const byDate = runP(
    "select mdm_employee_rk, company_fire_dt from prod_v_emart.mdm_employee_structure_d " +
    "where company_fire_dt between date '2023-01-01' and date '2026-08-31'");
  check('увольнение по дате поймано', byDate.draft_fire_by_date === true);

  const byFlag = runP(
    "select mdm_employee_rk, company_fire_dt from prod_v_emart.mdm_employee_structure_d " +
    "where company_fire_flg = 1 and company_fire_dt >= date '2023-01-01'");
  check('по флагу — тревоги нет', byFlag.draft_fire_by_date === false);

  // Дата как ВЫВОДИМОЕ значение проверку не тревожит: неверно определять
  // ею факт, а не упоминать её вовсе. Ложная тревога на верном черновике
  // обесценивает и себя, и соседние строки.
  const asColumn = runP(
    "select mdm_employee_rk, company_fire_dt from prod_v_emart.mdm_employee_structure_d " +
    'where last_day_flg = 1');
  check('дата в select тревоги не даёт', asColumn.draft_fire_by_date === false);

  // Название компании — это вся витрина, а не значение поля.
  const company = runP(
    "select * from prod_v_emart.mdm_employee_structure_d " +
    "where lvl3_mapped_management_unit_nm = 'Тбанк' and company_fire_flg = 1");
  check('название компании в фильтре поймано',
    company.draft_company_filter.length === 1 &&
    company.draft_company_filter[0].value === 'Тбанк');

  const normal = runP(
    "select * from prod_v_emart.mdm_employee_structure_d " +
    "where lvl3_mapped_management_unit_nm = 'Финансы' and company_fire_flg = 1");
  check('обычное подразделение тревоги не даёт',
    normal.draft_company_filter.length === 0);
}

// ===================================================================== 43
line('43. ДВЕ ВИТРИНЫ: срез не уезжает к чужой таблице');
{
  // ЖИВОЙ КЕЙС 2026-08-31, вопрос про скоринг сотрудников. В материалах было
  // два объекта — summary_evaluation и mdm_employee_structure_d. Сборщик брал
  // ПЕРВЫЙ урн как таблицу для всех пар, а известные поля — объединением
  // по обеим витринам. Получилось
  //   SELECT … FROM prod_v_hrmart.summary_evaluation WHERE last_day_flg = 1
  // и Trino ответил «Column 'last_day_flg' cannot be resolved»: срез одной
  // витрины прикрутили к другой.
  const MAT2 = { materials:
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:greenplum:table:hrmart.summary_evaluation ===\n' +
    'ПОЛЯ: mdm_employee_rk, summary_score, light_review_score, valid_to_dttm, deleted_flg\n\n' +
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===\n' +
    'ПОЛЯ: last_day_flg, active_employee_flg, company_fire_flg, emp_stream_desc, grade\n' };
  const run2 = (parsed) => new Function('$', '$json', js('Build check SQL'))(
    (n) => {
      if (n === 'Build materials') return { first: () => ({ json: MAT2 }) };
      throw new Error('node not executed: ' + n);
    }, parsed).map((i) => i.json);

  // Поле из витрины оценок: срез и флаги активности к ней НЕ приписываются.
  const ev = run2({ check_values: 'summary_score = отлично' });
  check('поле привязано к своей витрине',
    ev[0].check_table === 'prod_v_hrmart.summary_evaluation');
  check('срез чужой витрины НЕ подставлен',
    !/last_day_flg/.test(ev[0].check_sql));
  check('и флаги активности тоже нет',
    !/active_employee_flg/.test(ev[0].check_sql));

  // Поле из витрины сотрудников: там срез и флаги на месте.
  const st = run2({ check_values: 'emp_stream_desc = Дата' });
  check('вторая витрина адресована верно',
    st[0].check_table === 'prod_v_emart.mdm_employee_structure_d');
  check('и её собственный срез на месте', /last_day_flg = 1/.test(st[0].check_sql));
  check('вместе с фильтром активности',
    /active_employee_flg = 1 AND company_fire_flg = 0/.test(st[0].check_sql));

  // Обе пары в одном прогоне — каждая к своей витрине.
  const both = run2({ check_values: 'summary_score = отлично\nemp_stream_desc = Дата' });
  check('две пары — две разные витрины',
    new Set(both.map((i) => i.check_table)).size === 2);
  check('и ни в одном запросе нет чужого поля',
    both.every((i) => !/FROM prod_v_hrmart[\s\S]*last_day_flg/.test(i.check_sql)));

  // Витрина едет в выдачу: два перечня значений без подписи неразличимы.
  check('витрина названа в самом запросе',
    both.every((i) => i.check_sql.includes('AS tbl')));
}

// ===================================================================== 48
line('44. ВЫДУМАННОЕ ИМЯ ПОЛЯ И ПОТЕРЯННЫЕ БЛОКИ ВТОРОГО ПРОХОДА');
{
  const parseJs = js('Parse answer');
  const runP = (draft, materials) => new Function('$', '$json', parseJs)(
    (name) => {
      if (name === 'When called by adapter') return { first: () => ({ json: { question: 'выгрузка' } }) };
      if (name === 'Plan') return { first: () => ({ json: {} }) };
      if (name === 'Build materials') {
        return { first: () => ({ json: { materials, has_materials: true } }) };
      }
      if (name === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
      throw new Error('node not executed: ' + name);
    },
    { output: 'ЧЕРНОВИК ОТВЕТА: ' + draft + '\nУВЕРЕННОСТЬ: высокая' },
  )[0].json;

  // ЖИВОЙ КЕЙС 2026-08-31, выгрузка про детей сотрудников. Бот назвал
  // заказчику поле `age`, а идентификатор юнита предложил искать
  // в `unit_id`, `structure_resource_link`, `internal_id`. Ни одного
  // из четырёх имён в метаданных не было — выведены из ссылки в обращении.
  const MAT = 'ПОЛЯ: mdm_employee_rk, birthdate, firstname, surname, ' +
    'mapped_management_unit_nm';
  const bad = runP('в витрине есть поле age ребёнка, а юнит скорее всего ' +
    'в unit_id или structure_resource_link', MAT);
  check('выдуманные имена полей названы',
    bad.draft_invented_fields.includes('unit_id') &&
    bad.draft_invented_fields.includes('structure_resource_link'));

  // Настоящее поле тревоги не даёт — иначе строка горела бы на верном
  // черновике и её перестали бы читать.
  const good = runP('дата рождения ребёнка в поле birthdate, ' +
    'сотрудник — mdm_employee_rk', MAT);
  check('настоящие поля тревоги не дают', good.draft_invented_fields.length === 0);

  // Ссылки не разбираются как имена полей: в URL подчёркиваний хватает.
  const url = runP('юнит https://my.tbank.ru/structure/resource/units/e28?searchEmployee=1', MAT);
  check('ссылка выдуманным полем не считается', url.draft_invented_fields.length === 0);
}

// ===================================================================== 45
line('45. ВТОРОЙ ПРОХОД НЕ ТЕРЯЕТ БЛОКИ ПЕРВОГО');
{
  const finalJs = js('Final answer');
  const runFinal = (first, revised) => new Function('$', '$json', finalJs)(
    (name) => {
      if (name === 'Parse answer') return { first: () => ({ json: first }) };
      if (name === 'Parse revised') {
        if (!revised) throw new Error('node not executed');
        return { first: () => ({ json: revised }) };
      }
      if (name === 'Build check SQL') {
        return { first: () => ({ json: { check_pairs: [{ field: 'x' }], check_skipped: [] } }) };
      }
      if (name === 'Check result') {
        return { first: () => ({ json: { check_rows: 600, check_failed: '', check_exact: 1 } }) };
      }
      throw new Error('node not executed: ' + name);
    }, {})[0].json;

  const FIRST = { draft: 'первый', tech_spec: 'ТАБЛИЦА: prod_v_emart.x',
                  sources: 'kb/a.md', confidence_key: 'high', confidence_claimed: 'high' };

  // ЖИВОЙ КЕЙС: правка вернулась без ТЗ, и оно исчезло целиком — REVISE_PROMPT
  // о нём не говорил вовсе, а в логе это выглядело сбоем формата.
  const lost = runFinal(FIRST, { draft: 'правленый', tech_spec: '',
                                 confidence_key: 'high', confidence_claimed: 'high' });
  check('ТЗ добрано из первого прохода', lost.tech_spec === 'ТАБЛИЦА: prod_v_emart.x');
  check('и потеря названа, а не сделана молча',
    lost.revise_carried.includes('tech_spec'));
  check('правленый черновик при этом сохранён', lost.draft === 'правленый');

  // Формат сломан целиком: черновиком стал сырой текст со служебными
  // рассуждениями модели. Тогда первый черновик лучше правленого.
  const broken = runFinal(FIRST, {
    draft: 'Отлично, принимаю инструкцию. Проверил значения…',
    parse_error: 'в ответе агента не найдено ни одного блока',
    confidence_key: 'medium', confidence_claimed: 'medium' });
  check('сырой текст второго прохода не уходит заказчику',
    broken.draft === 'первый');
  check('и это названо джуну', broken.revise_dropped === true);
  check('с честной причиной', /значения в нём НЕ проверены/.test(broken.parse_error));
}

// ===================================================================== 46
line('46. ССЫЛКА НА ЮНИТ: id разбирается кодом, справочник добирается');
{
  // ЖИВОЙ КЕЙС 2026-08-31. Заказчик прислал ссылку на юнит, бот пошёл искать
  // uuid из неё среди значений mapped_management_unit_nm и
  // lvl5_mapped_management_unit_rk, не нашёл — и написал заказчику, что юнит
  // «не обнаружился ни по названию, ни по идентификатору», предложив самому
  // сказать, где его искать. Ни в одном из этих полей его и не могло быть:
  // в ссылке `id`, а в основных витринах только `rk`.
  const MGMT = 'https://my.tbank.ru/structure/resource/units/' +
    'e289067b-26b6-44f2-917e-668d1ea65cc5?searchEmployee=68058';
  const PROD = 'https://my.tbank.ru/product-catalog/product/' +
    'c5b3a0ac-a44b-4353-9f37-902ef0f5d4c6';
  const run = (q) => runPlan(
    JSON.stringify({ domains: [], articles: [], dd: [], no_question: false }),
    REGISTRY, { question: q });

  const m = run('нужна выгрузка по юниту ' + MGMT);
  check('вид ссылки называет структуру, а не догадка',
    m.unit_link_kind === 'management');
  check('id из ссылки разобран',
    m.unit_link_id === 'e289067b-26b6-44f2-917e-668d1ea65cc5');
  check('хвост ?searchEmployee в id не попал',
    !/searchEmployee/.test(m.unit_link_id));
  check('рецепт перевода добран', m.files.includes('kb/recipes/unit-link.md'));
  check('и справочник управленческой структуры',
    m.files.includes('kb/tables/management-unit.md'));
  check('справочник Каталога продуктов НЕ добран — структура другая',
    !m.files.includes('kb/tables/functional-unit.md'));

  const f = run('сколько людей на продукте ' + PROD);
  check('продуктовая ссылка опознана', f.unit_link_kind === 'functional');
  check('и добран её справочник',
    f.files.includes('kb/tables/functional-unit.md') &&
    !f.files.includes('kb/tables/management-unit.md'));

  // Без ссылки признак молчит: строка в материалах, которая горит всегда,
  // перестаёт читаться.
  const none = run('сколько сотрудников в юните Human Capital');
  check('без ссылки признака нет', none.unit_link_kind === '');
  check('и справочники не добираются',
    !none.files.some((p) => /unit-link|management-unit|functional-unit/.test(p)));

  // Блок в материалах: автор должен узнать, что за uuid и где его искать.
  const mat = runMaterials(m, [{ content: b64('# рецепт') }]);
  check('автору сказано, что в обращении ссылка на юнит',
    /В ОБРАЩЕНИИ ССЫЛКА НА ЮНИТ/.test(mat.materials));
  check('и названо поле справочника, а не витрины',
    /management_unit_id/.test(mat.materials));
  check('и прямо сказано, что в основных витринах id нет',
    /этого идентификатора НЕТ/.test(mat.materials));
}

// ===================================================================== 47
line('47. ПРОВЕРКА ЗНАЧЕНИЙ НЕ ЛОМАЕТ САМА СЕБЯ');
{
  const sqlJs = js('Build check SQL');
  const run = (materials, draft) => new Function('$', '$json', sqlJs)(
    (n) => {
      if (n === 'Build materials') return { first: () => ({ json: { materials } }) };
      if (n === 'Parse answer') return { first: () => ({ json: { draft, tech_spec: '' } }) };
      throw new Error('node not executed: ' + n);
    }, { check_values: '' }).map((i) => i.json);

  // ЖИВОЙ КЕЙС 2026-08-31. ТЗ стало готовым запросом, и в него попал
  // канонический фильтр версии из рецепта. Разбор пар честно вытащил
  // `valid_to_dttm = '5999-01-01'`, отправил его в Trino, запрос отказал —
  // и ОТКАЗ ПОНИЗИЛ УВЕРЕННОСТЬ ПО ВСЕМУ ОТВЕТУ. Ответ испортила проверка
  // того, что и так было известно из статьи.
  const MAT = [
    '=== СТАТЬЯ kb/recipes/unit-link.md ===',
    "where management_unit_id = <id> and valid_to_dttm = '5999-01-01' and deleted_flg = 0",
    '',
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:dlh:table:dds.management_unit ===',
    'ПОЛЯ: management_unit_rk, management_unit_id, valid_to_dttm, deleted_flg',
  ].join('\n');
  const DRAFT = "where management_unit_id = 'e289067b-26b6-44f2-917e-668d1ea65cc5' " +
    "and valid_to_dttm = '5999-01-01'";
  const r = run(MAT, DRAFT);
  const asked = r.filter((i) => i.check_sql);
  check('константа из статьи в проверку не идёт',
    !asked.some((i) => i.check_field === 'valid_to_dttm'));
  check('и отсев назван причиной, а не молчанием',
    r[0].check_skipped.some((x) => /константа из статьи/.test(x)));
  check('а неизвестное значение проверяется как раньше',
    asked.some((i) => i.check_field === 'management_unit_id'));

  // UUID на иглы не режется: `%26b6%` и `%44f2%` совпадут с чем угодно.
  const uuidSql = asked.find((i) => i.check_field === 'management_unit_id').check_sql;
  // Подстрочный поиск по идентификатору не нужен вовсе: написание известно
  // дословно. LIKE '5999%' в срезе версии — другое дело, это не поиск
  // значения, а фильтр актуальной версии.
  check('по идентификатору подстрочного поиска нет',
    !/LIKE\s+'%/.test(uuidSql));
  check('и куски hex в запрос не попали', !/%26b6%|%44f2%|%917e%/.test(uuidSql));

  // ТОЧНЫЙ ИДЕНТИФИКАТОР — ТОЧЕЧНЫЙ ЗАПРОС, А НЕ СЛОВАРЬ ЗНАЧЕНИЙ.
  // Словарь отвечает на вопрос «как записано слово заказчика»; по uuid
  // написание известно дословно, и вопрос другой — «есть ли такая строка».
  // Живой прогон 2026-08-31 сканировал ВЕСЬ справочник юнитов, группируя
  // по уникальному ключу, чтобы ответить на то, на что отвечает WHERE.
  check('по идентификатору запрос точечный, а не GROUP BY по всей таблице',
    /WHERE lower\(CAST\(management_unit_id/.test(uuidSql) &&
    !/ORDER BY exact_hit/.test(uuidSql));
  check('и словарь на 300 строк не поднимается', !/LIMIT 300/.test(uuidSql));

  // Ноль строк на точечном запросе — ОТВЕТ, а не отказ проверки.
  const resJs = js('Check result');
  const empty = new Function('$', '$json', resJs)(
    (n) => {
      if (n === 'Retry check SQL') throw new Error('доспроса не было');
      if (n === 'Build check SQL') {
        return { first: () => ({ json: {
          check_pairs: [{ field: 'management_unit_id',
                          value: 'e289067b-26b6-44f2-917e-668d1ea65cc5' }],
          check_skipped: [] } }) };
      }
      if (n === 'Check values') return { all: () => [{ json: {} }] };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;
  check('пустой точечный запрос — определённый ответ',
    /ИДЕНТИФИКАТОР В СПРАВОЧНИКЕ НЕ НАЙДЕН/.test(empty.check_block));
  check('и автору запрещено подбирать похожий',
    /Не подбирай похожий идентификатор/.test(empty.check_block));

  // Регулярка uuid живёт в ДВУХ нодах и обязана совпадать: «Build check SQL»
  // решает форму запроса, «Check result» — как читать пустой результат.
  const reOf = (node) =>
    (js(node).match(/\[0-9a-f\]\{8\}-[^/\n]*\{12\}/) || [])[0];
  check('регулярка идентификатора найдена в обеих нодах',
    Boolean(reOf('Build check SQL')) && Boolean(reOf('Check result')));
  check('и она одна и та же',
    reOf('Build check SQL') === reOf('Check result'));

  // ВЕРСИОННОСТЬ: срез обязан отсекать исторические и удалённые строки.
  // Живой прогон 2026-08-31 искал идентификатор юнита по ВСЕМ версиям
  // справочника: переименованный или удалённый юнит подтвердился бы наравне
  // с действующим, и по виду результата это не заметно.
  const VER = [
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:dlh:table:dds.management_unit ===',
    'ПОЛЯ: management_unit_rk, management_unit_id, valid_from_dttm, valid_to_dttm, deleted_flg',
  ].join('\n');
  const ver = run(VER, "where management_unit_id = 'e289067b-26b6-44f2-917e-668d1ea65cc5'");
  // ЖЁСТКОЕ РАВЕНСТВО, А НЕ ПРЕФИКС. Здесь стоял `LIKE '5999%'`, и это была
  // ошибка, а не компромисс: префикс пропускает любую дату 5999 года, тогда
  // как признак актуальной версии — конкретный день, и статьи витрин пишут
  // его конкретным. Приводится КОЛОНКА, а не литерал: Trino строг по типам.
  check('версионная витрина режется по актуальной версии',
    /CAST\(valid_to_dttm AS date\) = DATE '5999-01-01'/.test(ver[0].check_sql));
  check('и это равенство, а не подстрочный поиск',
    !/valid_to_dttm[^\n]*LIKE/.test(ver[0].check_sql));
  check('и удалённые строки отсекаются',
    /deleted_flg AS varchar\) IN \('0', 'false'\)/.test(ver[0].check_sql));
  // Сравнение через CAST намеренно: у одного и того же по смыслу поля тип
  // разный (`deleted_flg = 0` в crm_user, `= false` в disciplinary_sanction),
  // и прямое сравнение упало бы на boolean-колонке.
  check('сравнение типобезопасное, а не с числом',
    !/deleted_flg = 0/.test(ver[0].check_sql));

  // Витрина БЕЗ версионности лишних условий не получает — иначе запрос
  // упал бы на несуществующем поле.
  const plain = run(
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===\n' +
    'ПОЛЯ: mdm_employee_rk, last_day_flg, active_employee_flg, company_fire_flg, emp_stream_desc',
    "where emp_stream_desc = 'Дата'");
  check('без версионности лишних условий нет',
    !/valid_to_dttm|deleted_flg/.test(plain[0].check_sql));
  check('а свой срез на месте', /last_day_flg = 1/.test(plain[0].check_sql));

  const kbDir = REGISTRY_AT.replace(/index\.md$/, '');

  // ПРАВИЛО СЛОЯ: dds версионен целиком, и это подтверждено владельцем.
  // Нужно как страховка — инвентарь мог не прийти, и тогда по составу полей
  // версионность не видна. У dds.mdm_employee_x_profession её не было даже
  // в статье: дыра существовала и в базе, и в коде одновременно.
  const conv = fs.readFileSync(kbDir + 'process/sql-conventions.md', 'utf8');
  check('правило слоя DDS записано в базе',
    /Слой DDS: любая таблица версионная/.test(conv) &&
    /valid_to_dttm = '5999-01-01'/.test(conv));
  check('и сказано, что оно действует помимо статьи таблицы',
    /даже если в статье конкретной таблицы про это/.test(conv));
  check('а слои не смешиваются',
    /`valid_to_dttm` в `emart` нет, `last_day_flg` в `dds` нет/.test(conv));
  const xprof = fs.readFileSync(kbDir + 'tables/mdm-employee-x-profession.md', 'utf8');
  check('дыра в статье dds-таблицы закрыта',
    /valid_to_dttm = '5999-01-01'/.test(xprof));
  // ИНВЕНТАРЬ — ЭТО СПИСОК, А НЕ ТЕКСТ БЛОКА.
  //
  // Живой прогон 2026-08-31: у колонки витрины сотрудников в комментарии
  // владельца упомянут `valid_to_dttm`, поля выскребались регуляркой по всей
  // прозе блока — и в запрос к `emart` уехал фильтр версии:
  // «Column 'valid_to_dttm' cannot be resolved». Проверяется ПРОГОНОМ,
  // а не поиском подстроки в коде: подстрока поведения не гарантирует.
  const PROSE = [
    '=== МЕТАДАННЫЕ КАТАЛОГА: ' +
      'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===',
    'ВСЕ ПОЛЯ ТАБЛИЦЫ:',
    '',
    'mdm_employee_rk, last_day_flg, active_employee_flg, company_fire_flg, ' +
      'lvl13_mapped_management_unit_rk',
    '',
    'ПОДРОБНО ПО ПОЛЯМ (1):',
    '',
    '— lvl13_mapped_management_unit_rk (text)',
    '  описание: ключ юнита 13 уровня',
    '  комментарий из DD: собирается из справочника по актуальной версии ' +
      'valid_to_dttm, удалённые версии помечены deleted_flg',
  ].join('\n');
  const prose = run(PROSE, "where lvl13_mapped_management_unit_rk = 'abc'");
  check('поле из ОПИСАНИЯ не становится полем витрины',
    !/valid_to_dttm/.test(prose[0].check_sql));
  check('и флаг удаления из описания тоже',
    !/deleted_flg/.test(prose[0].check_sql));
  check('а свой срез при этом на месте',
    /last_day_flg = 1/.test(prose[0].check_sql) &&
    /company_fire_flg = 0/.test(prose[0].check_sql));
  check('поле из перечня разобрано, проверка не выключилась',
    /GROUP BY lvl13_mapped_management_unit_rk/.test(prose[0].check_sql));

  // Правило слоя — страховка на случай, когда список полей витрины `dds`
  // не разобрался или неполон: версионность там свойство СХЕМЫ, а не
  // отдельной таблицы, и молча собрать словарь по всем версиям хуже,
  // чем громко упасть на несуществующей колонке.
  const DDS_THIN = [
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:dlh:table:dds.management_unit ===',
    'ПОЛЯ: management_unit_rk, management_unit_id',
  ].join('\n');
  const thin = run(DDS_THIN, "where management_unit_id = 'e289067b-26b6-44f2-917e-668d1ea65cc5'");
  check('на слое dds фильтр версии ставится и без него в перечне',
    /valid_to_dttm/.test(thin[0].check_sql));

  // СРЕЗ СВЕРЯЕТСЯ СО СТАТЬЯМИ. Единственная копия условия живёт в коде,
  // и разъехаться с базой она может молча — как однажды разъехалась формула
  // активной численности.
  const arts = fs.readdirSync(kbDir + 'tables').map(
    (f) => fs.readFileSync(kbDir + 'tables/' + f, 'utf8')).join('\n');
  // Дата вынимается ИЗ СТАТЬИ и сверяется с кодом: единственная копия
  // условия живёт в сборщике, и разъехаться с базой она может молча —
  // как однажды разъехалась формула активной численности.
  const openDt = (arts.match(/valid_to_dttm\s*=\s*'(\d{4}-\d{2}-\d{2})'/) || [])[1];
  check('признак актуальной версии взят из статей', Boolean(openDt));
  check('и код использует ровно эту дату',
    Boolean(openDt) && js('Build check SQL').includes(openDt) &&
    js('Build lookups').includes(openDt));
  check('и оба написания флага удаления в базе есть',
    /deleted_flg\s*=\s*0/.test(arts) && /deleted_flg\s*=\s*false/i.test(arts));

  // ГРАНИЦА БЛОКА — следующий «=== » любого вида. Между блоками каталога
  // лежат другие блоки, и в них полно имён полей: приписав их предыдущей
  // витрине, пара уйдёт в запрос к таблице, где такого поля нет.
  const MIXED = [
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d ===',
    'ПОЛЯ: mdm_employee_rk, last_day_flg, mapped_management_unit_nm',
    '',
    '=== В ОБРАЩЕНИИ ССЫЛКА НА ЮНИТ ===',
    'Это значение поля management_unit_id в справочнике',
    '',
    '=== МЕТАДАННЫЕ КАТАЛОГА: urn:dd:tables:dlh:table:dds.management_unit ===',
    'ПОЛЯ: management_unit_rk, management_unit_id, valid_to_dttm',
  ].join('\n');
  const mixed = run(MIXED, "where management_unit_id = 'e289067b-26b6-44f2-917e-668d1ea65cc5'");
  check('поле из соседнего блока не приписано чужой витрине',
    mixed[0].check_table === 'prod_v_dds.management_unit');
}

// ===================================================================== 48
line('48. ССЫЛКА НА ЮНИТ: КЛЮЧ ДОБЫВАЕТ КОД, А НЕ ПЛЕЙСХОЛДЕР В ТЗ');
{
  const UUID = 'e289067b-26b6-44f2-917e-668d1ea65cc5';
  // Сборщик возвращает СПИСОК запросов: разрешение ссылки и добор состава
  // полей у витрин, про которые каталог промолчал. Здесь берём тот, что
  // про юнит.
  const runLookups = (plan, dd = null) =>
    new Function('$', '$json', js('Build lookups'))(
      (n) => {
        if (n === 'Plan') return { first: () => ({ json: plan }) };
        if (n === 'Call DD Lookup') {
          if (dd === null) throw new Error('node not executed');
          return { all: () => dd.map((json) => ({ json })) };
        }
        throw new Error('node not executed: ' + n);
      }, {}).map((i) => i.json);
  const runUnitSql = (plan) => {
    const all = runLookups(plan);
    const u = all.find((j) => j.lookup_kind === 'unit');
    return u || { lookup_needed: false, lookup_sql: '' };
  };

  const mgmt = runUnitSql({ unit_link_kind: 'management', unit_link_id: UUID });
  check('запрос собран', mgmt.lookup_needed === true && mgmt.lookup_sql.length > 0);
  check('справочник — управленческий',
    /prod_v_dds\.management_unit/.test(mgmt.lookup_sql));
  check('идентификатор подставлен ДОСЛОВНО, а не кусками',
    mgmt.lookup_sql.includes("'" + UUID + "'"));
  // Живой прогон 2026-08-31 разложил uuid на `%26b6%`, `%44f2%`, `%917e%`
  // и просканировал весь справочник. Точный идентификатор ищется равенством.
  check('LIKE по идентификатору не собирается', !/LIKE\s+'%/.test(mgmt.lookup_sql));
  check('фильтр версии на месте', /valid_to_dttm/.test(mgmt.lookup_sql));
  check('признак удаления на месте', /deleted_flg/.test(mgmt.lookup_sql));
  // Второй шаг рецепта — «на каком уровне лежит этот rk» — идёт тем же
  // запросом: зависимость не повод ходить дважды.
  check('второй шаг рецепта в том же запросе',
    /management_unit_lvl_num/.test(mgmt.lookup_sql) &&
    /mdm_employee_structure_d/.test(mgmt.lookup_sql));
  // LEFT, а не INNER: пустой юнет иначе выглядел бы как ненайденный,
  // и автор сказал бы заказчику неправду про его же ссылку.
  check('джойн LEFT, пустой юнит не читается как ненайденный',
    /LEFT JOIN/.test(mgmt.lookup_sql));
  check('срез витрины сотрудников в джойне',
    /last_day_flg = 1/.test(mgmt.lookup_sql) &&
    /company_fire_flg = 0/.test(mgmt.lookup_sql));
  check('перенос строки настоящий, а не литерал \\n',
    mgmt.lookup_sql.includes('\n') && !mgmt.lookup_sql.includes('\\n'));

  const fn = runUnitSql({ unit_link_kind: 'functional', unit_link_id: UUID });
  check('Каталог продуктов — свой справочник',
    /prod_v_dds\.functional_unit/.test(fn.lookup_sql));
  check('и close_flg, без которого закрытые юниты попадут в выборку',
    /close_flg/.test(fn.lookup_sql));
  check('мост в управленческую структуру взят из поля, а не по названию',
    /management_unit_rk/.test(fn.lookup_sql));

  check('ссылки нет — запроса нет',
    runUnitSql({}).lookup_needed === false);

  // --- разбор ответа: четыре исхода звучат по-разному, потому что чинятся
  //     в разных местах.
  const UNIT_JOB = { lookup_kind: 'unit', unit_kind: 'management',
                    unit_id: UUID, unit_table: 'prod_v_dds.management_unit' };
  // jobs — список запросов, которые сборщик отправил в Trino; rows — то,
  // что нода вернула по каждому из них (null = нода не выполнялась).
  const runUnitRes = (rows, jobs = [UNIT_JOB]) =>
    new Function('$', '$json', js('Lookup result'))(
      (n) => {
        if (n === 'Build lookups') return { all: () => jobs.map((json) => ({ json })) };
        if (n === 'Run lookups') {
          if (rows === null) throw new Error('node not executed');
          return { all: () => rows.map((json) => ({ json })) };
        }
        throw new Error('node not executed: ' + n);
      }, {})[0].json;

  const found = runUnitRes([
    { unit_rk: '10045', unit_nm: 'Human Capital', lvl_num: '4',
      mapped_nm: 'Human Capital', emp_cnt: 312 },
  ]);
  check('ключ извлечён', found.unit_state === 'found' && found.unit_rk === '10045');
  check('уровень извлечён', found.unit_levels.join(',') === '4');
  check('численность посчитана', found.unit_emp_cnt === 312);

  check('ноль строк — это НЕ НАЙДЕН, определённый факт',
    runUnitRes([]).unit_state === 'not_found');
  check('отказ запроса — отдельный исход',
    runUnitRes([{ error: 'Table does not exist' }]).unit_state === 'failed');
  check('невыполнившийся узел — третий исход',
    runUnitRes(null).unit_state === 'never_ran');
  check('ссылки не было — ветка молчит',
    runUnitRes(null, []).unit_state === 'skip');

  // --- материалы: автор получает ключ как ФАКТ, а не задание.
  const runMat = (unit) => {
    const $ = (name) => {
      if (name === 'Plan') {
        return { first: () => ({ json: {
          files: [], domains: [], dd: [], dd_count: 0,
          unit_link_kind: 'management', unit_link_id: UUID,
        } }) };
      }
      if (name === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (name === 'Lookup result') {
        if (unit === null) throw new Error('node not executed');
        return { first: () => ({ json: unit }) };
      }
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', js('Build materials'))($, {})[0].json;
  };

  const mFound = runMat(found);
  check('ключ уехал автору', mFound.materials.includes('10045'));
  check('и название юнита тоже', mFound.materials.includes('Human Capital'));
  check('уровень назван полем, а не числом',
    /lvl4_mapped_management_unit_rk/.test(mFound.materials));
  check('плейсхолдер запрещён прямым текстом',
    /ПЛЕЙСХОЛДЕР/i.test(mFound.materials));
  check('исход доехал до выхода', mFound.unit_state === 'found');

  const mNone = runMat(runUnitRes([]));
  check('ненайденный юнит назван определённо, а не «проверить не удалось»',
    /НЕ НАЙДЕН/.test(mNone.materials));
  check('и автору запрещено искать id среди названий',
    /НЕ ищи этот идентификатор/.test(mNone.materials));

  const mFail = runMat(runUnitRes([{ error: 'boom' }]));
  check('отказ назван отказом, а не отсутствием юнита',
    /ПОЛУЧИТЬ НЕ УДАЛОСЬ/.test(mFail.materials) && !/НЕ НАЙДЕН/.test(mFail.materials));

  // --- проверка значений: разрешённый идентификатор второй раз не гоняем.
  const META = '=== МЕТАДАННЫЕ КАТАЛОГА: ' +
    'urn:dd:tables:dlh:table:dds.management_unit ===\n' +
    'ПОЛЯ: management_unit_rk, management_unit_id, valid_to_dttm';
  const $chk = (name) => ({ first: () => ({
    json: name === 'Parse answer'
      ? { draft: "where management_unit_id = '" + UUID + "'" }
      : { materials: META, unit_link_id: UUID },
  }) });
  const chk = new Function('$', '$json', js('Build check SQL'))(
    $chk, { draft: "where management_unit_id = '" + UUID + "'", check_values: '' })
    .map((i) => i.json);
  check('идентификатор юнита в проверку значений не идёт второй раз',
    chk[0].check_sql === '' &&
    chk[0].check_skipped.some((x) => /уже разрешён кодом/.test(x)));
}

// ===================================================================== 49
line('49. ПЛЕЙСХОЛДЕР В ГОТОВОМ ЗАПРОСЕ НАЗЫВАЕТСЯ');
{
  const parseJs = js('Parse answer');
  const runParse = (spec) => {
    const $ = (name) => {
      if (name === 'When called by adapter') return { first: () => ({ json: { question: 'q' } }) };
      if (name === 'Plan') return { first: () => ({ json: {} }) };
      if (name === 'Build materials') {
        return { first: () => ({ json: { materials: 'x', has_materials: true } }) };
      }
      if (name === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
      throw new Error('node not executed: ' + name);
    };
    return new Function('$', '$json', parseJs)($, {
      output: 'ЧЕРНОВИК ОТВЕТА: текст\nУВЕРЕННОСТЬ: высокая\n' +
        'ТЗ ДЛЯ АНАЛИТИКА:\n' + spec,
    })[0].json;
  };

  // Ровно то, что уехало заказчику 2026-08-31: запрос, который нельзя
  // скопировать и запустить, а «шаг 1» выполнять ему нечем.
  const BAD = '```sql\nselect * from prod_v_emart.mdm_employee_structure_d\n' +
    "where lvl5_mapped_management_unit_rk = '<rk из шага 1>'\n```";
  check('плейсхолдер найден', runParse(BAD).draft_placeholders.length === 1);
  check('и назван дословно',
    runParse(BAD).draft_placeholders[0] === '<rk из шага 1>');

  const GOOD = '```sql\nselect * from prod_v_emart.mdm_employee_structure_d\n' +
    "where lvl5_mapped_management_unit_rk = '10045'\n" +
    '  and birthdate <= date \'2026-01-01\'\n' +
    '  and status <> \'closed\'\n```';
  // Ложная тревога здесь дороже промаха: строка, которая горит на верном
  // запросе, обесценивает и себя, и соседние.
  check('сравнения <= и <> тревогу не поднимают',
    runParse(GOOD).draft_placeholders.length === 0);

  // Плейсхолдер в ПРОЗЕ — это не запрос: рецепт сам велит подписывать
  // фильтр названием подразделения в комментарии.
  const PROSE = 'Гранулярность: одна строка = сотрудник.\n' +
    'Подставьте <название подразделения> в комментарий.';
  check('вне блока ```sql``` не проверяется',
    runParse(PROSE).draft_placeholders.length === 0);
}

// ===================================================================== 50
line('50. ГРАНУЛЯРНОСТЬ ВИТРИНЫ ДЕТЕЙ ПОДТВЕРЖДЕНА, А НЕ «УТОЧНИТЬ»');
{
  const kbDir = REGISTRY_AT.replace(/index\.md$/, '');
  const kids = fs.readFileSync(kbDir + 'tables/employee-children.md', 'utf8');

  // Бот честно писал заказчику «гранулярность и первичный ключ не
  // подтверждены» — и был прав: в статье так и стояло. Владелец подтвердил
  // 2026-08-31, и пока статья говорит «уточнить», бот будет повторять это
  // в каждом ответе про детей.
  const gran = (kids.match(/## Гранулярность строки[\s\S]*?(?=\n## )/) || [''])[0];
  const pk = (kids.match(/## Первичный ключ[\s\S]*?(?=\n## )/) || [''])[0];
  check('гранулярность больше не «не подтверждено»',
    gran.length > 0 && !/не подтверждено/i.test(gran));
  check('первичный ключ больше не «не подтверждено»',
    pk.length > 0 && !/не подтверждено/i.test(pk));
  check('гранулярность названа: одна строка = один ребёнок',
    /одна строка = один ребёнок/i.test(gran));
  check('первичный ключ назван', /`id`/.test(pk));

  // Главное следствие, а не педантизм: слева «сотрудник», справа «ребёнок»,
  // и джойн выравнивает их в пользу правой стороны. count(*) после такого
  // джойна считает детей и называет это сотрудниками — ошибка не падает
  // и выглядит правдоподобно.
  check('размножение строк при джойне названо',
    /размножа/i.test(kids) || /замнож/i.test(kids));
  check('и назван способ считать сотрудников',
    /count\(distinct/i.test(kids));
  check('агрегат ДО джойна показан примером',
    /GROUP BY individualid/i.test(kids));

  // Политика: запрета на выгрузку нет, есть согласование. Прежняя редакция
  // запрещала «в любом виде, включая агрегаты» — и противоречила разделу
  // «Персональные данные» той же статьи, где агрегат назван типовым.
  check('агрегаты не запрещены — это типовой сценарий',
    !/включая агрегаты/i.test(kids));
}

// ===================================================================== 51
line('51. СОСТАВ ПОЛЕЙ ИЗ ДАННЫХ, КОГДА КАТАЛОГ ПРОМОЛЧАЛ');
{
  const URN_KIDS = 'urn:dd:tables:greenplum:table:' +
    'chrono_peoplehub_masterid.individualchildren_public';
  const PLAN = {
    files: [], domains: [], dd: [{ urn: URN_TABLE, hint: '' }, { urn: URN_KIDS, hint: '' }],
    dd_count: 2, unit_link_kind: '', unit_link_id: '',
  };
  const jobs = new Function('$', '$json', js('Build lookups'))(
    (n) => {
      if (n === 'Plan') return { first: () => ({ json: PLAN }) };
      if (n === 'Call DD Lookup') return { all: () => [
        // Каталог по витрине сотрудников состав дал…
        { json: { dd_meta: 'ВСЕ ПОЛЯ ТАБЛИЦЫ:\n\nmdm_employee_rk, last_day_flg' } },
        // …а по витрине детей ответил, но состава не дал.
        { json: { dd_meta: 'Каталог ответил 404: объект не найден.' } },
      ] };
      throw new Error('node not executed: ' + n);
    }, {}).map((i) => i.json);

  const cols = jobs.filter((j) => j.lookup_kind === 'columns');
  check('состав спрашивается ровно у той витрины, про которую каталог промолчал',
    cols.length === 1 && cols[0].lookup_table ===
      'chrono_peoplehub_masterid.individualchildren_public');
  check('и не спрашивается у той, про которую он ответил',
    !cols.some((c) => /mdm_employee_structure_d/.test(c.lookup_table)));
  check('запрос идёт в information_schema, а не в саму витрину',
    /information_schema\.columns/.test(cols[0].lookup_sql) &&
    !/select \*/i.test(cols[0].lookup_sql));
  check('схема с префиксом prod_v_, иначе запрос не пойдёт',
    /prod_v_chrono_peoplehub_masterid/.test(cols[0].lookup_sql));
  check('перенос строки настоящий, а не литерал \\n',
    cols[0].lookup_sql.includes('\n') && !cols[0].lookup_sql.includes('\\n'));

  // Разбор ответа: имена полей и три исхода отказа.
  const res = (rows) => new Function('$', '$json', js('Lookup result'))(
    (n) => {
      if (n === 'Build lookups') return { all: () => jobs.map((json) => ({ json })) };
      if (n === 'Run lookups') {
        if (rows === null) throw new Error('node not executed');
        return { all: () => rows.map((json) => ({ json })) };
      }
      throw new Error('node not executed: ' + n);
    }, {})[0].json;

  const got = res([
    { data: [{ column_name: 'id' }, { column_name: 'individualid' },
             { column_name: 'birthdate' }, { column_name: 'isdeleted' }] },
  ]);
  const kidsCols = got.columns['chrono_peoplehub_masterid.individualchildren_public'];
  check('имена полей разобраны', Array.isArray(kidsCols) && kidsCols.length === 4);
  check('и порядок колонок сохранён', kidsCols[0] === 'id' && kidsCols[1] === 'individualid');

  // Пустой ответ — это НЕ отказ доступа: витрины с таким именем в Trino нет,
  // и чинить надо URN в реестре, а не права.
  check('пустой ответ назван своим диагнозом',
    /витрины с таким именем нет/.test(
      res([{}]).columns_failed['chrono_peoplehub_masterid.individualchildren_public']));
  check('отказ запроса — другой диагноз',
    /boom/.test(res([{ error: 'boom' }])
      .columns_failed['chrono_peoplehub_masterid.individualchildren_public']));

  // Материалы: состав печатается как ФАКТ, и оговорка «не подтверждено»
  // из них уходит — иначе она горит на каждом вопросе про эту витрину.
  const mat = (unit) => new Function('$', '$json', js('Build materials'))(
    (n) => {
      if (n === 'Plan') {
        return { first: () => ({ json: { ...PLAN,
          tables_read: [{ urn: URN_KIDS, title: 'Данные о детях' }] } }) };
      }
      if (n === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (n === 'Call DD Lookup') return { all: () => [{ json: { dd_meta: 'ПОЛЯ: a, b' } }] };
      if (n === 'Lookup result') return { first: () => ({ json: unit }) };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;

  const m = mat(got);
  check('состав из данных уехал автору',
    /СОСТАВ ПОЛЕЙ ИЗ ДАННЫХ/.test(m.materials) && /individualid/.test(m.materials));
  check('и прямо сказано, что это факт, а не догадка',
    /не подтверждён.{0,40}больше нельзя/s.test(m.materials));
  check('вечная оговорка «состав полей не получен» снята',
    !/СОСТАВ ПОЛЕЙ не получен по витринам[^.]*individualchildren/.test(m.materials));
  check('исход доехал до выхода',
    m.cols_from_data.includes('chrono_peoplehub_masterid.individualchildren_public'));

  // А когда состава не дали ни каталог, ни данные — оговорка обязана остаться.
  const mBad = mat(res([{}]));
  check('без состава оговорка остаётся',
    /не дали ни каталог, ни данные/.test(mBad.materials));
  check('и это названо пробелом на выходе',
    mBad.cols_unknown.length === 1 && mBad.cols_from_data.length === 0);
}

// ===================================================================== 52
line('52. ИДЕНТИФИКАТОР БЕЗ ДЕФИСОВ — ТОЖЕ ИДЕНТИФИКАТОР');
{
  // Живой прогон 2026-08-31: ключ юнита в витрине — 32 hex БЕЗ дефисов,
  // регулярка требовала дефисов, и вместо точечного запроса собрался
  // словарь с LIKE по всему полю. Заказчику уехал список чужих хешей.
  const HEX = '7232d11411120c5914cabb21956a9e61';
  const META = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d\n' +
    'ПОЛЯ: last_day_flg, active_employee_flg, company_fire_flg, ' +
    'lvl13_mapped_management_unit_rk';
  const runCheck = (draft, extra = {}) => {
    const $ = (n) => ({ first: () => ({
      json: n === 'Parse answer' ? { draft } : { materials: META, ...extra },
    }) });
    return new Function('$', '$json', js('Build check SQL'))($, { draft, check_values: '' })
      .map((i) => i.json);
  };

  const r = runCheck(`where lvl13_mapped_management_unit_rk = '${HEX}'`);
  check('идентификатор без дефисов опознан', r[0].check_exact_lookup === true);
  check('подстрочного поиска нет', !/LIKE/.test(r[0].check_sql));
  check('и словарь по всему полю не поднимается',
    !/GROUP BY[\s\S]*ORDER BY exact_hit/.test(r[0].check_sql));

  // Свой ключ, уже разрешённый кодом, второй раз не проверяется — даже если
  // в ссылке он с дефисами, а в черновике без них.
  const dashed = HEX.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const skipped = runCheck(`where lvl13_mapped_management_unit_rk = '${HEX}'`,
    { unit_link_id: dashed });
  check('разрешённый ключ не идёт в проверку второй раз',
    skipped[0].check_sql === '' &&
    skipped[0].check_skipped.some((x) => /уже разрешён кодом/.test(x)));

  // По идентификатору перечень значений автору не показывается вовсе:
  // выбрать из хешей нельзя, а любой чужой — чужое подразделение.
  const resJs = js('Check result');
  const runRes = (rows) => new Function('$', '$json', resJs)(
    (n) => {
      if (n === 'Retry check SQL') throw new Error('node not executed');
      if (n === 'Build check SQL') return { first: () => ({ json: r[0] }) };
      if (n === 'Check values') return { all: () => rows.map((json) => ({ json })) };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;

  const block = runRes([
    { fld: 'lvl13_mapped_management_unit_rk', tbl: 'emart.mdm_employee_structure_d',
      val: HEX, cnt: 45295, exact_hit: true, matched: true },
    { fld: 'lvl13_mapped_management_unit_rk', tbl: 'emart.mdm_employee_structure_d',
      val: '6693daa41585dcd9b2712c2a72d66531', cnt: 15141, exact_hit: false, matched: false },
  ]).check_block;
  check('подтверждённый ключ назван', block.includes(HEX));
  check('чужие ключи автору НЕ показаны', !block.includes('6693daa4'));
  check('и предлагать выбор из хешей прямо запрещено',
    /НЕ предлагай заказчику/.test(block));
}

// ===================================================================== 53
line('53. «КАТАЛОГ ОТВЕТИЛ» И «КАТАЛОГ ДАЛ СОСТАВ» — РАЗНЫЕ ВЕЩИ');
{
  const URN_KIDS = 'urn:dd:tables:greenplum:table:' +
    'chrono_peoplehub_masterid.individualchildren_public';
  const PLAN = {
    files: [], domains: [], dd: [{ urn: URN_TABLE, hint: '' }, { urn: URN_KIDS, hint: '' }],
    dd_count: 2, unit_link_kind: '', unit_link_id: '',
  };
  const mat = (unit) => new Function('$', '$json', js('Build materials'))(
    (n) => {
      if (n === 'Plan') return { first: () => ({ json: PLAN }) };
      if (n === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (n === 'Call DD Lookup') return { all: () => [
        { json: { dd_meta: 'ВСЕ ПОЛЯ ТАБЛИЦЫ:\n\nmdm_employee_rk, last_day_flg' } },
        // Шейпер на неверном URN возвращает НЕПУСТОЙ текст — именно на этом
        // объект и попадал в «метаданные получены».
        { json: { dd_meta: 'ОШИБКИ DD: карточка объекта: HTTP 404 — URN неверный.' } },
      ] };
      if (n === 'Lookup result') {
        if (unit === null) throw new Error('node not executed');
        return { first: () => ({ json: unit }) };
      }
      throw new Error('node not executed: ' + n);
    }, {})[0].json;

  const mat0 = (kidsMeta) => new Function('$', '$json', js('Build materials'))(
    (n) => {
      if (n === 'Plan') return { first: () => ({ json: PLAN }) };
      if (n === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (n === 'Call DD Lookup') return { all: () => [
        { json: { dd_meta: 'ВСЕ ПОЛЯ ТАБЛИЦЫ:\n\nmdm_employee_rk, last_day_flg' } },
        { json: { dd_meta: kidsMeta } },
      ] };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;
  const parse = (m) => new Function('$', '$json', js('Parse answer'))(
    (n) => {
      if (n === 'When called by adapter') return { first: () => ({ json: { question: 'q' } }) };
      if (n === 'Plan') return { first: () => ({ json: {} }) };
      if (n === 'Build materials') return { first: () => ({ json: m }) };
      if (n === 'Decode registry') return { first: () => ({ json: { full: REGISTRY } }) };
      throw new Error('node not executed: ' + n);
    }, { output: 'ЧЕРНОВИК ОТВЕТА: текст\nУВЕРЕННОСТЬ: высокая' })[0].json;

  const m = mat(null);
  check('витрина без состава полей НАЗВАНА',
    m.dd_no_fields.length === 1 && m.dd_no_fields[0] === URN_KIDS);
  check('а та, что состав дала, в этот список не попала',
    !m.dd_no_fields.includes(URN_TABLE));

  // Джун должен увидеть строку и понять, что чинить: не доступ и не пробел
  // базы, а одну строку реестра.
  const parsed = parse(m);
  check('признак доехал до разбора', parsed.dd_no_fields.length === 1);

  // ПРИЧИН ДВЕ, И ЧИНЯТСЯ ОНИ В РАЗНЫХ МЕСТАХ. Прогон фазы G 2026-08-31
  // показал, что URN витрины детей ВЕРНЫЙ: каталог объект знает, а колонок
  // у него не заведено. Валя это в один диагноз, джуна отправляли править
  // строку реестра, которая не сломана.
  check('отказ каталога назван отказом', parsed.dd_bad_urn.length === 1);
  check('и «Задача для базы» говорит про URN и Service Account',
    parsed.kb_tasks.some((t) => /КАТАЛОГ ОТКАЗАЛ/.test(t)) &&
    parsed.kb_tasks.some((t) => /kb\/index\.md/.test(t)));

  const mZero = mat0('ПОЛЯ ИЗ DD: 0\nDD не вернул ни одного поля.');
  const pZero = parse(mZero);
  check('«колонок не заведено» — это НЕ отказ каталога',
    pZero.dd_no_fields.length === 1 && pZero.dd_bad_urn.length === 0);
  check('и джуна не отправляют править верный URN',
    pZero.kb_tasks.some((t) => /ПУСТОЙ СПИСОК КОЛОНОК/.test(t)) &&
    !pZero.kb_tasks.some((t) => /КАТАЛОГ ОТКАЗАЛ/.test(t)));
  // ПРИЧИНУ КОД НЕ ВЫДУМЫВАЕТ. Здесь стояло «колонок не заведено» — догадка,
  // записанная как факт, и уже вторая подряд по этой витрине. Называется
  // факт, а причину меряет фаза H разведки.
  check('причина не выдумана, а названа как невыясненная',
    pZero.kb_tasks.some((t) => /по ответу не видно/.test(t) && /фаза H/.test(t)));
}

// ===================================================================== 54
line('54. ИНВЕНТАРЬ ИЗ DD LOOKUP РАЗБИРАЕТСЯ ЯДРОМ ЦЕЛИКОМ');
{
  // СКВОЗНАЯ проверка через ДВА флоу: шейпер «DD Lookup» печатает инвентарь,
  // «Build materials» его читает. Формат печатает одна нода, читает другая,
  // и разъехаться они могут молча — что и случилось 2026-08-31: каталог
  // отдал 25 полей витрины детей, а разбор увидел ноль, потому что среди
  // имён было `id`, а правило требовало не короче трёх символов ОТ КАЖДОГО
  // элемента строки. Сутки отказ выглядел молчанием каталога.
  const dd = JSON.parse(fs.readFileSync('DD Lookup.json', 'utf8'));
  const ddJs = (n) => dd.nodes.find((x) => x.name === n).parameters.jsCode;

  const URN_KIDS = 'urn:dd:tables:greenplum:table:' +
    'chrono_peoplehub_masterid.individualchildren_public';
  // Реальные имена: первое — двухбуквенное, как в живом ответе каталога.
  const NAMES = ['id', 'individualid', 'birthdate', 'isdeleted', 'firstname',
    'lastname', 'gender', 'createdon', 'statecode', 'ownerid'];
  const colsRes = { statusCode: 200, body: { totalCount: NAMES.length,
    data: NAMES.map((n) => ({ entity: {
      fqn: 'chrono_peoplehub_masterid.individualchildren_public.' + n } })) } };

  const meta = new Function('$', '$json', ddJs('Shape table meta'))(
    (n) => {
      if (n === 'When called by agent') return { first: () => ({ json: { urn: URN_KIDS, search: '' } }) };
      if (n === 'dd_entity_card') {
        return { first: () => ({ json: { statusCode: 200, body: { data: 'Данные о детях' } } }) };
      }
      if (n === 'dd_entity_attrs') return { first: () => ({ json: { statusCode: 200, body: {} } }) };
      if (n === 'dd_columns') return { first: () => ({ json: colsRes }), all: () => [{ json: colsRes }] };
      if (n === 'Pick columns') {
        return { first: () => ({ json: { targets: [], mode: '', total: NAMES.length } }) };
      }
      throw new Error('node not executed: ' + n);
    }, {})[0].json.dd_meta;

  check('шейпер напечатал перечень полей', /ВСЕ ПОЛЯ ТАБЛИЦЫ/.test(meta));
  check('и двухбуквенное имя в нём есть', /\bid,/.test(meta));

  const m = new Function('$', '$json', js('Build materials'))(
    (n) => {
      if (n === 'Plan') {
        return { first: () => ({ json: {
          files: [], domains: [], dd: [{ urn: URN_KIDS, hint: '' }], dd_count: 1,
          unit_link_kind: '', unit_link_id: '' } }) };
      }
      if (n === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (n === 'Call DD Lookup') return { all: () => [{ json: { dd_meta: meta } }] };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;

  check('ядро разобрало инвентарь, а не объявило его пустым',
    m.dd_no_fields.length === 0);
  check('и не попросило добирать состав из данных',
    m.cols_from_data.length === 0 && m.cols_unknown.length === 0);

  // А если формат перечня всё-таки разъедется — это обязано быть ГРОМКО
  // и названо поломкой бота, а не молчанием каталога.
  const broken = meta.replace(NAMES.join(', '), NAMES.join(' | '));
  const mb = new Function('$', '$json', js('Build materials'))(
    (n) => {
      if (n === 'Plan') {
        return { first: () => ({ json: {
          files: [], domains: [], dd: [{ urn: URN_KIDS, hint: '' }], dd_count: 1,
          unit_link_kind: '', unit_link_id: '' } }) };
      }
      if (n === 'When called by adapter') return { first: () => ({ json: {} }) };
      if (n === 'Call DD Lookup') return { all: () => [{ json: { dd_meta: broken } }] };
      throw new Error('node not executed: ' + n);
    }, {})[0].json;
  check('разъезд формата назван поломкой разбора',
    mb.dd_parse_failed.length === 1 && /обещано полей: 10/.test(mb.dd_parse_failed[0]));
  check('и не выдан за отказ каталога',
    mb.dd_bad_urn.length === 0 && mb.dd_no_columns.length === 0);

  // ТРИ РЕЖИМА ШЕЙПЕРА, И РАЗБОР ОБЯЗАН РАБОТАТЬ В КАЖДОМ. Число полей
  // шейпер называет во всех трёх, но по-разному, и без сверки с ним промах
  // разбора снова стал бы молчанием каталога — только уже в другом режиме.
  const shaped = (search, pick) => new Function('$', '$json', ddJs('Shape table meta'))(
    (n) => {
      if (n === 'When called by agent') return { first: () => ({ json: { urn: URN_KIDS, search } }) };
      if (n === 'dd_entity_card') {
        return { first: () => ({ json: { statusCode: 200, body: { data: 'Данные о детях' } } }) };
      }
      if (n === 'dd_entity_attrs') return { first: () => ({ json: { statusCode: 200, body: {} } }) };
      if (n === 'dd_columns') return { first: () => ({ json: colsRes }), all: () => [{ json: colsRes }] };
      if (n === 'Pick columns') return { first: () => ({ json: pick }) };
      if (n === 'dd_column_summary') {
        return { all: () => pick.targets.map((t) => ({
          json: { statusCode: 200, body: { data: 'описание ' + t.field } } })) };
      }
      if (n === 'dd_column_attrs') {
        return { all: () => pick.targets.map(() => ({
          json: { statusCode: 200, body: { column_type: { data: 'text' } } } })) };
      }
      throw new Error('node not executed: ' + n);
    }, {})[0].json.dd_meta;

  const bcs = js('Build check SQL');
  const api = new Function(
    bcs.slice(bcs.indexOf('const IDENT'), bcs.indexOf('return set;\n}') + 13) +
    '\nreturn { fieldsOf, declaredOf };')();

  for (const [label, search, pick] of [
    ['без фильтра', '', { targets: [], mode: '', total: NAMES.length }],
    ['фильтр попал', 'дата рождения',
     { targets: [{ field: 'birthdate', idx: 2 }], mode: 'by_name', total: NAMES.length }],
    ['фильтр промахнулся', 'зарплата',
     { targets: [], mode: 'by_name', total: NAMES.length }],
  ]) {
    const t = shaped(search, pick);
    check(`${label}: инвентарь разобран целиком`,
      api.fieldsOf(t).size === NAMES.length);
    check(`${label}: число полей объявлено и прочитано`,
      api.declaredOf(t) === NAMES.length);
  }
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(fails ? 1 : 0);
