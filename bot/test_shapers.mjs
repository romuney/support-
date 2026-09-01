// Прогон шейперов DD Lookup.json на подставных данных DD.
// Проверяет: полный инвентарь без search, фильтр search, промах фильтра,
// пустой ответ, HTTP-ошибки, разные варианты обёртки массива.
import fs from 'fs';

// ПРОВЕРКА ОБЯЗАНА УМЕТЬ УРОНИТЬ ПРОГОН.
//
// Группы 0–11 писались как `checkS('имя', выражение)` — они ПЕЧАТАЛИ
// true/false и не считались нигде: файл выходил с кодом 0 и словами «проверки
// прошли», даже когда половина из них печатала false посреди длинного лога.
// То есть регрессия шейпера таблицы выглядела точно так же, как её отсутствие.
// Ровно тот же класс, что `gs.includes('root_id')`: проверка, которая читается
// как проверка и не гарантирует ничего.
let ddFails = 0;
const checkS = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) ddFails++;
};

const wf = JSON.parse(fs.readFileSync('DD Lookup.json', 'utf8'));
const js = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;

// dd_column_cards (одна карточка на колонку) сменился на два отдельных
// запроса — dd_column_summary и dd_column_attrs (entityFields на /entity/{urn}
// перестал их отдавать, см. build_dd_flow.py). Тесты по-прежнему собираются
// вокруг ОДНОЙ фикстуры «карточка» {fqn, summary, attributes} — cards === null
// означает, что узлы в прогоне не выполнялись (Pick columns/Need column cards
// отсеяли), и $() должна бросить, как n8n на невыполненной ноде; иначе она
// здесь же разбирается на summaries[]/attrsList[], а имена полей для
// Pick columns.all() восстанавливаются из fqn через shortNameLocal — в реальном
// флоу оба запроса идут по ОДНОМУ и тому же списку targets, порядок тот же.
// pick — то, что вернула Pick columns (mode/total_cols), для .first(): не
// передан — используется первый восстановленный из cards элемент, а если
// и cards нет — {}, как и раньше по умолчанию это mode: 'by_name'.
function shortNameLocal(o) {
  const fqn = (o && (o.fqn || o.name)) || '';
  const parts = String(fqn).split('.');
  return parts[parts.length - 1] || '';
}

// entityAttrs — ответ dd_entity_attrs (атрибуты ТАБЛИЦЫ, не колонки), для
// «КОММЕНТАРИЙ ИЗ DD». Не передан — как и раньше, {} по умолчанию: comment
// пуст, строка не печатается.
function runTableFull(...a) { return runTableRaw(...a); }
function runTable(...a) { return runTableRaw(...a).dd_meta; }

// ОПТОВЫЙ ОТВЕТ СОБИРАЕТСЯ ЗДЕСЬ ИЗ ТЕХ ЖЕ ФИКСТУР.
//
// Раньше описания и атрибуты приходили двумя запросами НА КАЖДУЮ колонку,
// и харнесс раскладывал фикстуру «карточка» на dd_column_summary
// и dd_column_attrs. Теперь всё это приходит ОДНИМ запросом
// POST /entity/batch/related с entityFields — измерено фазой J разведки
// 2026-09-01: 289 из 289 колонок с описаниями И атрибутами.
//
// Фикстуры оставлены прежними намеренно: меняется транспорт, а не данные,
// и тесты обязаны проверять то же самое поведение на новом транспорте.
// Харнесс сливает `cols` (полный состав) с `cards` (описания по отобранным)
// в форму «urn → {totalCount, data}», как отвечает живая ручка.
function bulkFrom(cols, cards, pickNames, urn) {
  const body = (cols && cols.body) || cols || {};
  // Фикстуры несут список в разных обёртках — `data`, `items`, голым
  // массивом: живой `nodesOf` их все и разбирает, и харнесс обязан быть
  // не строже, иначе тест краснеет на форме, которую прод принимает.
  const list = Array.isArray(body) ? body
    : Array.isArray(body.data) ? body.data
    : Array.isArray(body.items) ? body.items
    : [];
  const byField = new Map();
  if (cards) {
    cards.forEach((c, i) => {
      const b = (c && c.body) || c || {};
      const f = (Array.isArray(pickNames) && pickNames[i]) || shortNameLocal(b);
      if (f) byField.set(f, b);
    });
  }
  const data = list.map((it) => {
    const e = Object.assign({}, (it && it.entity) || it || {});
    const f = shortNameLocal(e);
    const card = byField.get(f);
    if (card) {
      if (card.summary !== undefined) e.summary = card.summary;
      if (card.attributes !== undefined) e.attributes = card.attributes;
    }
    return { relationId: 'r-' + f, entity: e };
  });
  const out = { data };
  if (Number.isFinite(body.totalCount)) out.totalCount = body.totalCount;
  const code = (cols && cols.statusCode) || 200;
  return { statusCode: code, body: { [urn]: out } };
}

function runTableRaw(inputs, card, cols, cards = null, pick = null, entityAttrs = null,
                  valuesPlan = null, valuesRes = undefined, pickNames = null) {
  const urn = String((inputs && inputs.urn) || '');
  const colBody = (cols && cols.body) || cols || {};
  const colList = Array.isArray(colBody) ? colBody
    : Array.isArray(colBody.data) ? colBody.data
    : Array.isArray(colBody.items) ? colBody.items
    : [];
  // Имена, по которым фикстура даёт подробности. Пустой список = «все»,
  // ровно как у живой `Pick columns` в режиме by_meaning.
  const pickList = cards === null ? [] : cards.map((c, i) => ({
    field: (Array.isArray(pickNames) && pickNames[i])
      || shortNameLocal((c && c.body) || c || {}),
  }));
  const $ = (name) => {
    if (name === 'dd_columns_bulk') {
      return { first: () => ({ json: bulkFrom(cols, cards, pickNames, urn) }) };
    }
    // ЧУВСТВИТЕЛЬНОСТЬ ПРИХОДИТ СВЯЗЬЮ, а не атрибутом — измерено фазой I
    // разведки 2026-09-01, — и ОПТОМ, чанками по 120 URN (фаза J).
    // Ответ чанка — словарь «urn колонки → связи»: сопоставление по ключу,
    // а не по порядку, поэтому сдвиг на единицу тут невозможен в принципе.
    if (name === 'dd_columns_sens') {
      if (cards === null) throw new Error('node not executed');
      const map = {};
      let failedCode = 0;
      cards.forEach((c, i) => {
        const b = (c && c.body) || c || {};
        const f = (Array.isArray(pickNames) && pickNames[i]) || shortNameLocal(b);
        const it = colList.find((x) => shortNameLocal((x && x.entity) || x || {}) === f);
        const cUrn = String((((it && it.entity) || it || {}).urn) || ('urn:col:' + f));
        if (b.sensCode) { failedCode = b.sensCode; return; }
        const raw = b.sensitivity;
        const list = raw === undefined ? []
          : (Array.isArray(raw) ? raw : String(raw).split(/,\s*/).filter(Boolean));
        map[cUrn] = { totalCount: list.length,
                      data: list.map((x) => ({ entity: { displayName: x } })) };
      });
      if (failedCode) return { all: () => [{ json: { statusCode: failedCode, body: {} } }] };
      return { all: () => [{ json: { statusCode: 200, body: map } }] };
    }
    if (name === 'Build values SQL') {
      if (valuesPlan === null) throw new Error('node not executed');
      return { first: () => ({ json: valuesPlan }) };
    }
    if (name === 'dd_values') {
      if (valuesRes === undefined) throw new Error('node not executed');
      return { all: () => valuesRes.map((json) => ({ json })) };
    }
    if (name === 'Pick columns') {
      const base = pick !== null ? pick : (pickList[0] ? {} : null);
      if (base === null) return { first: () => ({ json: null }), all: () => [] };
      const j = Object.assign({
        targets: pickList.map((x) => x.field),
        sens_asked: cards === null ? 0 : Object.keys(pickList).length,
      }, base);
      return { first: () => ({ json: j }), all: () => [{ json: j }] };
    }
    return {
      first: () => ({
        json: {
          'When called by agent': inputs,
          dd_entity_card: card,
          dd_entity_attrs: entityAttrs,
        }[name],
      }),
    };
  };
  return new Function('$', js('Shape table meta'))($)[0].json;
}

// Прогон ноды «Build values SQL»: какой SQL она построит и что исключит.


// pairs — то, что вернула бы модель. null = «взять все кандидаты по порядку»,
// чтобы старые проверки отбора полей остались про отбор, а не про промпт.

// Прогон ноды Pick columns: что она отдаст дальше по флоу.
function runPick(inputs, cols) {
  const urn = String((inputs && inputs.urn) || '');
  const $ = (name) => ({
    first: () => ({
      json: {
        'When called by agent': inputs,
        dd_columns_bulk: bulkFrom(cols, null, null, urn),
      }[name],
    }),
  });
  return new Function('$', js('Pick columns'))($).map((i) => i.json);
}

function runReport(inputs, markdown, attrs, links, sources = { statusCode: 200, body: { data: [] } }) {
  const $ = (name) => ({
    first: () => ({
      json: {
        'When called by agent': inputs,
        dd_report_markdown: markdown,
        dd_report_attrs: attrs,
        dd_report_links: links,
        dd_report_sources: sources,
      }[name],
    }),
  });
  return new Function('$', js('Shape report meta'))($)[0].json.dd_meta;
}

const mkCols = (n) =>
  Array.from({ length: n }, (_, i) => ({
    fqn: `emart.mdm_employee_structure_d.field_${i}`,
    summary: { data: i % 3 ? `описание поля ${i}` : '' },
    attributes: [{ key: 'dataType', value: i % 2 ? 'text' : 'date' }],
  }));

const cols210 = {
  statusCode: 200,
  body: {
    items: mkCols(210).concat([
      {
        fqn: 'emart.mdm_employee_structure_d.emp_grade_desc',
        summary: { data: 'грейд сотрудника | с пайпом внутри' },
        attributes: [{ key: 'dataType', value: 'text' }],
      },
    ]),
  },
};

// dd_entity_card бьёт в /entity/{urn}/summary напрямую (entityFields на
// /entity/{urn} перестал отдавать displayName/summary, см. build_dd_flow.py),
// поэтому тело ответа — просто { data }, без displayName/fqn.
const card = {
  statusCode: 200,
  body: { data: 'сотрудник на каждый\nкалендарный день' },
};

// РЕАЛЬНАЯ форма ответа /related/columns, подтверждена живым запросом 2026-08-06.
// Сущность вложена в entity; summary и attributes не приходят вовсе, хотя
// entityFields передан. totalCount 267 при отданных 4 записях.
const REAL_COLS = [
  'business_dt',
  'mdm_employee_rk',
  'company_hire_dt',
  'company_fire_dt',
].map((n, i) => ({
  relationId: `rel-${i}`,
  entity: {
    id: `id-${i}`,
    urn: `urn:dd:tables:greenplum:column:emart.mdm_employee_structure_d.${n}`,
    system: 'tables.greenplum',
    type: 'COLUMN',
    fqn: `emart.mdm_employee_structure_d.${n}`,
  },
}));

const URN = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d';
const line = (s) => console.log('\n' + '='.repeat(70) + '\n' + s + '\n' + '='.repeat(70));

// НАСТОЯЩАЯ карточка колонки, скопирована из живого ответа 2026-08-06.
const REAL_CARD_BUSINESS_DT = {
  statusCode: 200,
  body: {
    id: 'c-1',
    urn: 'urn:dd:tables:greenplum:column:emart.mdm_employee_structure_d.business_dt',
    system: 'tables.greenplum',
    type: 'COLUMN',
    fqn: 'emart.mdm_employee_structure_d.business_dt',
    summary: { data: 'Дата среза' },
    attributes: {
      keys: { type: 'text-list', data: ['PK'] },
      source: { type: 'text', data: '[EMARTI.MDM_EMPLOYEE_C_STRUCTURE_MAPPED_D.business_dt](https://dd…)' },
      comment: {
        type: 'text',
        data: 'business_dt генерируется от даты найма сотрудника в компанию до даты увольнения.\n* если сотрудник был нанят 10.10.2023, то в business_dt=\'10.10.2023\' первая запись.\nВитрина подневно развернута с 01.01.2021.',
      },
      to_delete: { type: 'boolean', data: false },
      column_type: { type: 'text', data: 'date' },
      can_be_accessed: { type: 'boolean', data: true },
      versioning_type: { type: 'text', data: 'BSN' },
      ordinal_position: { type: 'number', data: 1 },
    },
  },
};

line('00. НАСТОЯЩАЯ КАРТОЧКА КОЛОНКИ — тип, описание, комментарий');
let real = runTable(
  { urn: URN, search: 'business_dt' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
  [REAL_CARD_BUSINESS_DT],
);
console.log(real);
console.log('\nПРОВЕРКИ:');
checkS('  тип «date», не [object Object]', /\(date\)/.test(real) && !/object Object/.test(real));
checkS('  versioning_type НЕ выдан за тип', !/BSN/.test(real));
checkS('  описание «Дата среза»', /Дата среза/.test(real));
checkS('  комментарий владельца есть', /подневно развернута/.test(real));
checkS('  ключ PK показан', /\[PK\]/.test(real));

line('00б. Pick columns — какие URN уйдут за карточками');
checkS('пустой search', JSON.stringify(runPick({ urn: URN, search: '' }, { statusCode: 200, body: { data: REAL_COLS } })));
checkS('search=hire', JSON.stringify(runPick({ urn: URN, search: 'hire' }, { statusCode: 200, body: { data: REAL_COLS } })));

line('00в. КОММЕНТАРИЙ ТАБЛИЦЫ (dd_entity_attrs) — печатается, если отличается от summary');
// dd_entity_card отдаёт только summary; comment таблицы — на dd_entity_attrs,
// добавлен по просьбе после фикса entityFields (см. AGENTS.md): в интерфейсе
// DD у таблицы, как и у колонки, есть поле «Комментарий», отдельное от
// summary, и раньше оно не запрашивалось вовсе.
const tableAttrs = {
  statusCode: 200,
  body: {
    comment: { type: 'text', data: 'Витрина считается только по активным юр. договорам, уволенные не попадают.' },
    owner: { type: 'text', data: 'CrossData Team' },
  },
};
const withComment = runTable(
  { urn: URN, search: '' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
  null,
  null,
  tableAttrs,
);
console.log('\nПРОВЕРКИ:');
checkS('  комментарий из DD показан', /КОММЕНТАРИЙ ИЗ DD: Витрина считается только/.test(withComment));

// Comment совпадает с summary дословно — дублировать незачем.
const sameAsSummary = runTable(
  { urn: URN, search: '' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
  null,
  null,
  { statusCode: 200, body: { comment: { type: 'text', data: card.body.data } } },
);
checkS('  дубль summary не печатается', (sameAsSummary.match(/сотрудник на каждый календарный день/g) || []).length === 1);

// Атрибутов у таблицы нет вовсе — как и раньше, строка просто не появляется.
const noComment = runTable(
  { urn: URN, search: '' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
);
checkS('  без атрибутов — без строки', !/КОММЕНТАРИЙ ИЗ DD/.test(noComment));

line('0. РЕАЛЬНАЯ ФОРМА ОТВЕТА DD — entity внутри, без описаний, totalCount 267');
real = runTable({ urn: URN, search: '' }, card, {
  statusCode: 200,
  body: { totalCount: 267, data: REAL_COLS },
});
console.log(real);
console.log('\nПРОВЕРКИ:');
checkS('  поля распакованы из entity', /business_dt, mdm_employee_rk/.test(real));
checkS('  сказано «получено 4 из 267»', /получено 4 из 267/.test(real));
checkS('  список назван НЕПОЛНЫМ', /НЕПОЛНЫЙ/.test(real));
// Совет «вызови dd_lookup ещё раз» убран: в конвейере вызов ОДИН,
// инструментов у автора нет, и невыполнимый совет он пересказывает
// заказчику как «нужен ещё запрос» — то есть выдаёт ограничение бота
// за пробел данных.
// Инвентарь печатается С ОПИСАНИЯМИ: они приходят тем же ответом, и раньше
// выбрасывались «ради токенов» — довод, снятый в проекте измеренно. Цена
// выбрасывания: в запросе стояло `, disability_flg` без комментария, потому
// что подписать поле было нечем, кроме догадки.
checkS('  сказано, чем этот перечень является',
  /Это ПОЛНЫЙ состав витрины/.test(real));
checkS('  и что описание — из каталога, а не выдумано',
  /придумывать его за него нельзя/.test(real));
checkS('  подробностей нет (шаг 1)', !/ПОДРОБНО ПО ПОЛЯМ/.test(real));

line('0б. РЕАЛЬНАЯ ФОРМА + фильтр: таблицы с прочерками быть не должно');
real = runTable({ urn: URN, search: 'dt' }, card, {
  statusCode: 200,
  body: { totalCount: 267, data: REAL_COLS },
});
console.log(real);
console.log('\nПРОВЕРКИ:');
checkS('  нет пустой таблицы с «—»', !/\| — \| — \|/.test(real));
checkS('  найдены поля по фильтру', /business_dt, company_hire_dt, company_fire_dt/.test(real));

line('1. ШАГ 1: БЕЗ ФИЛЬТРА — полный инвентарь 211 имён, обрезки нет');
let out = runTable({ urn: URN, search: '' }, card, cols210);
let lines = out.split('\n');
console.log(lines.slice(0, 7).join('\n'));
console.log('   ...');
console.log(lines.slice(-4).join('\n'));
console.log('\nПРОВЕРКИ:');
checkS('  все 211 имён в тексте', /field_209/.test(out) && /emp_grade_desc/.test(out));
checkS('  нет слова СКРЫТО', !/СКРЫТО/.test(out));
checkS('  размер, КБ', (Buffer.byteLength(out) / 1024).toFixed(1));

line('2. ШАГ 2: ФИЛЬТР grade — таблица с типом и описанием');
console.log(runTable({ urn: URN, search: 'grade' }, card, cols210));

line('3. ФИЛЬТР ПРОМАХНУЛСЯ — должен вернуть полный инвентарь как подсказку');
out = runTable({ urn: URN, search: 'зарплата' }, card, cols210);
lines = out.split('\n');
console.log(lines.slice(0, 9).join('\n'));
console.log('   ...');
console.log('\nПРОВЕРКИ:');
checkS('  инвентарь приложен', /field_100/.test(out));
// Код больше не объявляет отсутствие: промах ПО БУКВАМ про смысл
// не говорит ничего — имена латиницей, понятие названо по-русски.
checkS('  промах фильтра назван промахом по буквам, а не отсутствием',
  /не совпало с «[^»]*» по буквам/.test(out) &&
  !/такого названия в таблице нет/.test(out));

line('4. DD вернул пусто (другой ключ связи)');
console.log(runTable({ urn: URN, search: '' }, card, { statusCode: 200, body: {} }));

line('5. HTTP 404 по колонкам + 401 по карточке');
console.log(
  runTable(
    { urn: URN, search: '' },
    { statusCode: 401, body: {} },
    { statusCode: 404, body: {} },
  ),
);

line('6. Обёртка массива = сырой массив, без items');
console.log(runTable({ urn: URN, search: 'field_1' }, card, { statusCode: 200, body: mkCols(3) }));

line('7. Обёртка = data, attributes объектом, summary строкой');
console.log(
  runTable({ urn: URN, search: '' }, card, {
    statusCode: 200,
    body: {
      data: [
        { fqn: 'a.b.business_dt', summary: 'дата среза', attributes: { dataType: 'date' } },
        { fqn: 'a.b.mdm_employee_rk', summary: 'ключ', attributes: { columnType: 'bigint' } },
      ],
    },
  }),
);

line('8. ФИЛЬТР нашёл 111 полей, карточек приходит 12 — сказать про остальные 99');
// Pick columns режет до MAX_CARDS=12, поэтому карточек приходит ровно 12.
const cards12 = Array.from({ length: 12 }, (_, i) => ({
  statusCode: 200,
  body: {
    fqn: `emart.mdm_employee_structure_d.field_1${i === 0 ? '' : i}`,
    summary: { data: `описание поля 1${i === 0 ? '' : i}` },
    attributes: { column_type: { type: 'text', data: 'text' } },
  },
}));
out = runTable({ urn: URN, search: 'field_1' }, card, cols210, cards12);
lines = out.split('\n');
console.log(lines.slice(0, 6).join('\n'));
console.log('   ...');
console.log(lines.slice(-5).join('\n'));
console.log('\nПРОВЕРКИ:');
checkS('  сказано про 99 без описаний', /описания получены по 12/.test(out) && /остальным 99/.test(out));
checkS('  подробности по 12 есть', /ПОДРОБНО ПО ПОЛЯМ \(12\)/.test(out));

line('8б. ПОИСК ПО СМЫСЛУ — живой кейс: hint «причины» не совпадает ни с одним\nименем колонки латиницей, но dismissal_reason_desc в описании есть');
// Ровно воспроизводит найденный баг: hrmart.legal_position_dismissal_reason,
// 4 поля, hint по-русски. Раньше Pick columns при 0 совпадений по имени
// не запрашивала ни одной карточки, и описание не приходило вовсе.
const dismissalCols = {
  statusCode: 200,
  body: {
    totalCount: 4,
    data: [
      'legal_position_rk',
      'fire_dt',
      'mdm_employee_rk',
      'dismissal_reason_desc',
    ].map((n, i) => ({
      relationId: `rel-${i}`,
      entity: {
        urn: `urn:dd:tables:greenplum:column:hrmart.legal_position_dismissal_reason.${n}`,
        type: 'COLUMN',
        fqn: `hrmart.legal_position_dismissal_reason.${n}`,
      },
    })),
  },
};
const dismissalCard = {
  statusCode: 200,
  body: { displayName: 'hrmart.legal_position_dismissal_reason', fqn: 'hrmart.legal_position_dismissal_reason' },
};
const dismissalPick = runPick({ urn: URN, search: 'причины' }, dismissalCols);
const dismissalCards = dismissalPick[0].targets.map((f) => ({
  statusCode: 200,
  body: {
    fqn: `hrmart.legal_position_dismissal_reason.${f}`,
    summary: {
      data: f === 'dismissal_reason_desc'
        ? 'Причины увольнения текстом от сотрудника'
        : `техническое поле ${f}`,
    },
    attributes: { column_type: { type: 'text', data: 'text' } },
  },
}));
out = runTable(
  { urn: URN, search: 'причины' },
  dismissalCard,
  dismissalCols,
  dismissalCards,
  dismissalPick[0],
);
checkS('Pick columns режим', dismissalPick[0].mode);
console.log(out);
console.log('\nПРОВЕРКИ:');
checkS('  режим by_meaning выбран', dismissalPick[0].mode === 'by_meaning');
// «Заказаны» больше не про число HTTP-запросов: описания приходят
// по всем колонкам ОДНИМ оптовым запросом (измерено фазой J разведки
// 2026-09-01). `Pick columns` теперь отдаёт СПИСОК ИМЁН для подробного
// блока — то есть решает, что ПЕЧАТАТЬ, а не что запрашивать.
checkS('  подробности заказаны на все поля', dismissalPick[0].targets.length === 4);
// КАРТОЧКИ ПРОЧИТАНЫ — ПОКАЗЫВАЮТСЯ ВСЕ. Раньше здесь проверялось
// обратное: «нерелевантные поля не показаны». Это и был архитектурный
// дефект — код уже заплатил запросами за описания всех колонок, а потом
// выбрасывал их по совпадению подстроки, то есть выносил суждение
// о СМЫСЛЕ. Живой прогон 2026-08-31: hint «дети, возраст детей», поле
// `birthdate` с описанием «Дата рождения ребёнка» — подстрокой не совпало
// никогда, и код объявил, что такого поля нет.
checkS('  описания прочитаны и показаны все', /ОПИСАНИЯ ПОЛЕЙ ПРОЧИТАНЫ: 4 из 4/.test(out));
checkS('  нужное поле в ответе', /dismissal_reason_desc/.test(out));
checkS('  описание по-русски пришло', /Причины увольнения текстом от сотрудника/.test(out));
checkS('  и НЕсовпавшие поля тоже показаны — выбирает модель, а не код',
  /техническое поле/.test(out));
checkS('  совпадение по буквам осталось подсказкой, а не фильтром',
  /Подсказка: по буквам/.test(out));

line('8в. ПОИСК ПО СМЫСЛУ — ни имя, ни описание не совпали');
const dismissalPickMiss = runPick({ urn: URN, search: 'зарплата' }, dismissalCols);
const dismissalCardsMiss = dismissalPickMiss[0].targets.map((f) => ({
  statusCode: 200,
  body: {
    fqn: `hrmart.legal_position_dismissal_reason.${f}`,
    // Описание НЕ должно содержать само слово поиска: «зарплата» режется
    // до основы «зарплат», а «к зарплате отношения не имеет» эту основу
    // содержит — фикстура промаха сама себе противоречила и совпадала.
    summary: { data: `служебное поле ${f}, нужно для загрузки данных` },
  },
}));
out = runTable(
  { urn: URN, search: 'зарплата' },
  dismissalCard,
  dismissalCols,
  dismissalCardsMiss,
  dismissalPickMiss[0],
);
console.log('\nПРОВЕРКИ:');
// Ни имя, ни описание не совпали — и это НЕ повод объявлять отсутствие.
// Описания всё равно показываются целиком: выбирает модель.
checkS('  описания показаны, несмотря на промах фильтра',
  /ОПИСАНИЯ ПОЛЕЙ ПРОЧИТАНЫ/.test(out) && /служебное поле/.test(out));
checkS('  код НЕ объявляет, что такого поля нет',
  !/не встретилось ни в одном/.test(out) && !/такого поля или значения в таблице нет/.test(out));
checkS('  инвентарь имён приложен', /dismissal_reason_desc/.test(out) && /ВСЕ ПОЛЯ ТАБЛИЦЫ/.test(out));

line('8г. ПОИСК ПО СМЫСЛУ на широкой таблице — проверяются ВСЕ поля, без потолка');
// Живой баг: таблица на 289 колонок, потолок в 60 карточек обрывал поиск
// до того, как дошёл до искомого поля — «не встретилось» означало «не
// долистали», а не «такого поля нет». Нужное поле здесь на позиции 100,
// заведомо за старым потолком.
const N_WIDE = 150;
const wideCols = {
  statusCode: 200,
  body: {
    totalCount: N_WIDE,
    data: Array.from({ length: N_WIDE }, (_, i) => ({
      relationId: `rel-${i}`,
      entity: {
        urn: `urn:dd:tables:greenplum:column:emart.wide_table.field_${i}`,
        type: 'COLUMN',
        fqn: `emart.wide_table.field_${i}`,
      },
    })),
  },
};
const wideCard = { statusCode: 200, body: { fqn: 'emart.wide_table', displayName: 'emart.wide_table' } };
const widePick = runPick({ urn: URN, search: 'декрет' }, wideCols);
const wideCards = widePick[0].targets.map((f) => ({
  statusCode: 200,
  body: {
    fqn: `emart.wide_table.${f}`,
    summary: {
      data: f === 'field_100' ? 'Признак: сотрудница в декретном отпуске' : `служебное поле ${f}`,
    },
  },
}));
out = runTable({ urn: URN, search: 'декрет' }, wideCard, wideCols, wideCards, widePick[0]);
console.log('\nПРОВЕРКИ:');
checkS('  Pick columns не режет по 60', widePick[0].targets.length === N_WIDE);
checkS('  описания запрошены по ВСЕМ полям', new RegExp(`каталог ответил по ${N_WIDE} из ${N_WIDE}`).test(out));
checkS('  нет упоминания потолка', !/потолок/.test(out));
checkS('  поле за старым потолком найдено', /field_100/.test(out) && /декретном отпуске/.test(out));

// ====================================================================== 8д
line('8д. ДВА ПОНЯТИЯ В ОДНОМ ФИЛЬТРЕ и запрет судить об отсутствии по блоку');
// Живой отказ 2026-08-26. Вопрос был про логин И рабочую почту, роутер отдал
// одну иглу «логин» — и бот уверенно ответил, что рабочей почты в витрине
// нет. Поле wrk_email_address_txt с описанием «Рабочая почта» там есть.
// Два независимых инварианта: фильтр принимает несколько слов, а блок
// результатов прямо говорит, что судить по нему об отсутствии нельзя.
const MIX = {
  statusCode: 200,
  body: {
    totalCount: 3,
    data: ['ad_login', 'wrk_email_address_txt', 'business_dt'].map((f) => ({
      entity: {
        urn: `urn:dd:tables:greenplum:column:emart.mix.${f}`,
        type: 'COLUMN',
        fqn: `emart.mix.${f}`,
      },
    })),
  },
};
const mixCard = { statusCode: 200, body: { fqn: 'emart.mix' } };
const DESCR = {
  ad_login: 'AD логин',
  wrk_email_address_txt: 'Рабочая почта',
  business_dt: 'Дата среза',
};
const mixRun = (search) => {
  const pick = runPick({ urn: URN, search }, MIX);
  const cards = pick[0].targets.map((f) => ({
    statusCode: 200,
    body: { fqn: `emart.mix.${f}`, summary: { data: DESCR[f] || '' } },
  }));
  return { out: runTable({ urn: URN, search }, mixCard, MIX, cards, pick[0]), pick };
};

// Полный список имён печатается ТЕПЕРЬ ВСЕГДА, поэтому «поля нет в выводе»
// проверять больше нельзя — оно есть, и это новое требование, а не регрессия.
// Инвариант остался прежним: поиск по одной игле не должен ВЫДАВАТЬ второе
// поле за найденное. Проверяем блок совпадений, а не весь ответ.
const matchedPart = (out) => out.split('ВСЕ ПОЛЯ ТАБЛИЦЫ')[0];

const one = mixRun('логин');
console.log('\nПРОВЕРКИ:');
checkS('  одна игла: логин найден', /ad_login/.test(matchedPart(one.out)));
// Почта теперь ЕСТЬ в блоке описаний — и это правильно: карточка её
// прочитана, а решать, относится ли поле к вопросу, должен автор.
checkS('  одна игла: почта тоже показана с описанием',
  /wrk_email_address_txt/.test(matchedPart(one.out)));
checkS('  подсказка про совпадение по буквам названа подсказкой',
  /Это НЕ значит, что нужное поле среди них/.test(one.out));
checkS('  и отправлено судить об отсутствии по полному списку',
  /по этому списку и только по нему можно/.test(one.out));
// Ради чего правка 2026-08-31: полный состав таблицы приезжает автору
// и при удачном фильтре тоже. Без него бот писал «поля нет в витрине»,
// глядя на блок совпадений, — а поле там было.
checkS('  полный состав таблицы приложен', /ВСЕ ПОЛЯ ТАБЛИЦЫ/.test(one.out));
checkS('  и почта в нём есть', /wrk_email_address_txt/.test(one.out));

const two = mixRun('логин, почта');
checkS('  две иглы: логин найден', /ad_login/.test(matchedPart(two.out)));
checkS('  две иглы: почта найдена', /wrk_email_address_txt/.test(matchedPart(two.out)));
// «Лишнее не притянуло» больше не проверяем: показываются все прочитанные
// карточки, и это осознанно. Инвариант теперь другой — подсказка называет
// РОВНО совпавшее, не приписывая себе остальное.
checkS('  две иглы: подсказка называет только совпавшее',
  /Подсказка: по буквам с «логин, почта» совпали [^\n]*ad_login/.test(two.out) &&
  !/Подсказка: по буквам[^\n]*business_dt/.test(two.out));

// Склонение: «почты» не содержит подстроку «почта», а описание — «Рабочая почта».
const infl = mixRun('почты');
checkS('  склонение: «почты» → найдено',
  /wrk_email_address_txt/.test(matchedPart(infl.out)));

// Формы ответов подтверждены живым запросом 2026-08-13 на report:1728:
// markdown — плоский объект {ключ: {data}} без обёртки type; attribute —
// {ключ: {type, data}}, как у карточки колонки; link — объект по КЛЮЧУ
// КАТЕГОРИИ ({reports: {url}}), а не массив [{name,url}].
const REPORT_URN = 'urn:dd:reports:reports:report:1728';
const mdFull = {
  statusCode: 200,
  body: {
    summary: { data: 'Отчёт поможет для решения следующих задач: выгрузка атрибутов.' },
    how_to_read: { data: 'Дашборд состоит из трёх блоков: настройка, справка, данные.' },
    additional_info: { data: 'source_table: [sse_crossdata.mdm_employee_d](https://dd/…)' },
  },
};
const attrsFull = {
  statusCode: 200,
  body: {
    period: { type: 'text', data: 'Ежедневно' },
    status: { type: 'enum', data: 'Активен' },
    developers_team: { type: 'text', data: 'CrossData Team' },
  },
};
const linksFull = {
  statusCode: 200,
  body: { reports: { url: 'https://proteus.tcsbank.ru/superset/dashboard/hr-executive-detail-employee' } },
};

line('9. ОТЧЁТ — все три ручки отработали');
console.log(runReport({ urn: REPORT_URN }, mdFull, attrsFull, linksFull));

line('10. ОТЧЁТ — markdown-блоков в DD нет вовсе');
console.log(
  runReport(
    { urn: REPORT_URN },
    { statusCode: 200, body: {} },
    attrsFull,
    linksFull,
  ),
);

line('10б. ОТЧЁТ — одна из ручек упала (401), остальные отработали');
{
  const out = runReport(
    { urn: REPORT_URN },
    mdFull,
    { statusCode: 401, body: { message: 'unauthorized' } },
    linksFull,
  );
  console.log(out);
  console.log('\nПРОВЕРКИ:');
  checkS('  ошибка атрибутов названа', /ОШИБКИ DD:.*атрибуты/.test(out));
  checkS('  markdown при этом виден', /НАЗНАЧЕНИЕ:/.test(out));
}

// ==========================================================================
// 11. ГРУППЫ ДОСТУПА: три состояния, которые нельзя путать
//
// Для запроса на выгрузку это готовый раздел сообщения заказчику: какие поля
// по умолчанию не выгружаются и требуют согласования. Цена ошибки
// несимметрична — принять «признака нет» за «поле открыто» значит уверенно
// сказать заказчику, что согласование не нужно, и ошибиться именно на ПДн.
line('11. ГРУППЫ ДОСТУПА');
{
  const colUrn = (n) => ({
    entity: { urn: `${URN.replace(':table:', ':column:')}.${n}`,
              fqn: `emart.mdm_employee_structure_d.${n}` },
  });
  const cols = { statusCode: 200,
                 body: { totalCount: 2, data: [colUrn('fio_nm'), colUrn('grade_nm')] } };
  const mkCard = (n, attrs, sens, sensCode) => ({
    statusCode: 200,
    body: { fqn: `emart.mdm_employee_structure_d.${n}`,
            summary: { data: `описание ${n}` }, attributes: attrs,
            ...(sens === undefined ? {} : { sensitivity: sens }),
            ...(sensCode === undefined ? {} : { sensCode }) },
  });

  // ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ — ЭТО СВЯЗЬ, А НЕ АТРИБУТ. Измерено фазой I
  // разведки 2026-09-01: `GET /entity/{col}/related` даёт ключ
  // `full_column_sensitivity` (RESTRICTS, dest_src), а в `/attribute`
  // признака нет вовсе. Полтора месяца шейпер искал его среди атрибутов
  // и писал «признака нет ни у одного из N полей. Считать эти поля
  // открытыми НЕЛЬЗЯ» — то есть выдавал промах ключа за факт про данные,
  // и оговорка уезжала в КАЖДЫЙ черновик.
  //
  // Фикстура пишет ярлыки в `sensitivity` карточки, а харнесс превращает
  // их в форму ответа связи: элемент — связь, сущность вложена в `entity`.
  const closed = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', { column_type: { type: 'text', data: 'text' } }, ['EMP_SENS']),
    mkCard('grade_nm', { column_type: { type: 'text', data: 'text' } }, []),
  ]);
  checkS('чувствительное поле помечено у самого поля',
    /fio_nm[\s\S]*ЧУВСТВИТЕЛЬНОЕ ПОЛЕ \(EMP_SENS\)/.test(closed));
  checkS('сказано, что нужно согласование',
    /нужен доступ и согласование/.test(closed));
  checkS('сводка называет чувствительные', /ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ 1 из 2/.test(closed));
  checkS('источник назван связью, а не атрибутом',
    /связи «full_column_sensitivity»/.test(closed));
  // Группа называет, КУДА идти, но на вывод не влияет: заполнено = закрыто.
  checkS('группа названа как адрес, а не как условие',
    /называет, КУДА идти за доступом/.test(closed));
  // Якорь «— » обязателен: без него совпадает упоминание поля в списке
  // «ПОДОШЛИ ПОЛЯ» выше, и проверка ловит чужую пометку.
  checkS('незакрытое поле не помечено', !/— grade_nm[\s\S]*ЧУВСТВИТЕЛЬНОЕ/.test(closed));

  // Связь ответила и вернула пусто — это ФАКТ, а не «не спросили»:
  // запрос сделан, ответ получен.
  const open = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', {}, []),
    mkCard('grade_nm', {}, []),
  ]);
  checkS('пустая связь — сказано прямо, что закрытых нет',
    /признак не проставлен\s+ни у одного/.test(open));

  // Ручка отказала → мы НИЧЕГО не узнали. Ни «открыто», ни «закрыто».
  const failed = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', {}, undefined, 500),
    mkCard('grade_nm', {}, undefined, 500),
  ]);
  checkS('отказ ручки — «спросить не удалось», а не «признака нет»',
    /ЧУВСТВИТЕЛЬНОСТЬ: спросить не удалось/.test(failed));
  checkS('и «поля открыты» из этого не следует',
    /Это не значит «поля открыты»/.test(failed));
  checkS('а запрет на ПДн держится по смыслу поля, а не по каталогу',
    /персональное — ФИО, телефон, почта/.test(failed.replace(/\n/g, ' ')));

  // can_be_accessed: {boolean, true} есть на НАСТОЯЩЕЙ карточке колонки.
  // Свободный поиск по /access/ находил его и печатал «закрыто группами true»
  // у открытого поля — тот же класс ошибки, что versioning_type вместо типа.
  const real = runTable({ urn: URN, search: 'business_dt' }, card,
    { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } }, [REAL_CARD_BUSINESS_DT]);
  checkS('can_be_accessed не выдан за группы доступа', !/ЗАКРЫТО группами true/i.test(real));
  // На настоящей карточке связь чувствительности пустая — значит закрытых
  // полей нет по данным каталога. Это утверждение, а не «не спросили».
  checkS('на настоящей карточке закрытых полей нет',
    /признак не проставлен\s+ни у одного/.test(real));

  // Инвентарь без фильтра: карточек не запрашивали, значит про закрытость
  // не знаем ничего. Молчание здесь прочиталось бы как «поля открыты».
  const inv = runTable({ urn: URN, search: '' }, card,
    { statusCode: 200, body: { totalCount: 2, data: [colUrn('fio_nm'), colUrn('grade_nm')] } });
  checkS('инвентарь: сказано, что не запрашивались',
    /ГРУППЫ ДОСТУПА: не запрашивались/.test(inv));
}

console.log(`\n${'='.repeat(70)}`);
// ===================================================================== 9б
line('9б. ОТЧЁТ — витрины-источники приходят из каталога, а не из git');
{
  // Ключ связи source_tables подтверждён живым прогоном 2026-08-27:
  // на report:1728 вернул три витрины. Это половина того, ради чего затевался
  // реестр отчётов, и в git оно не дублируется — как владелец и состав полей.
  const srcOk = { statusCode: 200, body: { data: [
    { entity: { fqn: 'emart.mdm_employee_structure_d', urn: 'urn:t:1' } },
    { entity: { fqn: 'hrmart.summary_evaluation', urn: 'urn:t:2' } },
  ] } };
  const out = runReport({ urn: REPORT_URN }, mdFull, attrsFull, linksFull, srcOk);
  checkS('витрины названы', out.includes('ПОСТРОЕН НА ВИТРИНАХ'));
  checkS('первая витрина в списке', out.includes('emart.mdm_employee_structure_d'));
  checkS('вторая тоже', out.includes('hrmart.summary_evaluation'));
  // Инвентарь оттуда, смысл — из статьи витрины. Иначе автор начнёт брать
  // правила среза из карточки отчёта, где их нет и не будет.
  checkS('правила среза отправлены в статью витрины',
    /правила среза.*из статьи витрины/.test(out));

  // Пусто — сказать вслух. Молчание читается как «отчёт ни на чём не построен».
  const srcEmpty = runReport({ urn: REPORT_URN }, mdFull, attrsFull, linksFull);
  checkS('пусто — сказано прямо', /витрины-источники.*не указаны/.test(srcEmpty));
  checkS('и запрещено додумывать', /Не додумывай/.test(srcEmpty));

  // Отказ ручки — это не «витрин нет», а «спросить не удалось».
  const srcFail = runReport({ urn: REPORT_URN }, mdFull, attrsFull, linksFull,
    { statusCode: 401, body: {} });
  checkS('401 назван отказом, а не пустотой',
    /истёк Service Account/.test(srcFail) && !/не указаны/.test(srcFail));
}

// ===================================================================== 8е
line('8е. ОСНОВА СЛОВА не короче четырёх букв');
{
  // Правило «минус два символа» превращало пятибуквенное слово в ТРЁХбуквенное:
  // «грейд» → «гре», «стрим» → «стр». Совпадение идёт подстрокой, поэтому
  // «стр» ловит и структуру, и стратегию, и страну — и в фильтре описаний,
  // и в ilike по данным, где это ещё и скан витрины ради мусора. Ровно тот
  // класс, из-за которого из ключевых слов маршрутов выброшен «рид» внутри
  // «гибрида». А слова эти не случайные: «грейд» и «стрим» — самые частые
  // в живом трафике, их для того и дописали в описания доменов.
  const URN_S = 'urn:dd:tables:greenplum:table:emart.t';
  const cols = { statusCode: 200, body: { totalCount: 2, data: [
    { entity: { fqn: 'emart.t.emp_stream_desc' } },
    { entity: { fqn: 'emart.t.legal_unit_nm' } },
  ] } };
  const cards = [
    { statusCode: 200, body: { fqn: 'emart.t.emp_stream_desc',
        summary: { data: 'Стрим сотрудника' }, attributes: {} } },
    { statusCode: 200, body: { fqn: 'emart.t.legal_unit_nm',
        summary: { data: 'Структурное подразделение' }, attributes: {} } },
  ];
  const pick = { mode: 'by_meaning', total_cols: 2, picked: 2, matched: 0 };
  const out = runTable({ urn: URN_S, search: 'стрим' },
    { statusCode: 200, body: {} }, cols, cards, pick);
  checkS('искомое поле найдено', /emp_stream_desc/.test(out));
  // «стр» совпало бы со «Структурным подразделением» — и в блок совпадений
  // уехало бы поле, к вопросу отношения не имеющее.
  // Основа слова теперь влияет только на ПОДСКАЗКУ (описания показываются
  // все), но стемминг всё равно обязан быть точным: подсказка, которая
  // тянет чужое поле, уводит автора не туда.
  checkS('«структура» под «стрим» в подсказку не попала',
    !/Подсказка: по буквам[^\n]*legal_unit_nm/.test(out));
  checkS('а искомое поле в подсказке есть',
    /Подсказка: по буквам[^\n]*emp_stream_desc/.test(out));

  // Склонение при этом ловиться обязано — ради него основа и режется.
  const decl = runTable({ urn: URN_S, search: 'стриме' },
    { statusCode: 200, body: {} }, cols, cards, pick);
  checkS('склонение всё ещё ловится', /emp_stream_desc/.test(decl));
}

// ===================================================================== 9в
line('9в. ОТЧЁТ: владелец и канал поддержки не выбрасываются');
{
  const REP = 'urn:dd:reports:reports:report:1728';
  // Форма подтверждена живым прогоном разведки 2026-08-27: в /attribute
  // отчёта лежат report_developer, developers_team, data_team,
  // support_channel. Раньше шейпер печатал только команду и два УГАДАННЫХ
  // ключа, а владельца и канал отбрасывал молча — при том что по фидбеку
  // аналитика это два самых частых вопроса канала (11 и 13 обращений из 49).
  const attrs = { statusCode: 200, body: {
    report_developer: { type: 'text', data: 'Ivan Petrov' },
    developers_team: { type: 'text', data: 'CrossData' },
    support_channel: { type: 'text', data: '~hr_reports_ask' },
    period: { type: 'text', data: 'ежедневно' },
    some_other_key: { type: 'text', data: 'x' },
  } };
  const md = { statusCode: 200, body: { data: [{ key: 'summary', value: 'Отчёт про людей' }] } };
  const links = { statusCode: 200, body: { reports: { url: 'https://proteus/x' } } };
  const out = runReport({ urn: REP }, md, attrs, links);

  checkS('владелец назван', /ВЛАДЕЛЕЦ ОТЧЁТА: Ivan Petrov/.test(out));
  checkS('команда рядом с владельцем', /команда CrossData/.test(out));
  // Владельца потому и не дублируют в git: он меняется без нашего ведома.
  checkS('сказано, что владелец из каталога', /Взято из каталога/.test(out));
  checkS('канал поддержки назван', /КУДА ПИСАТЬ ПО ОТЧЁТУ: ~hr_reports_ask/.test(out));
  checkS('и сказано, что канал чужой', /это канал поддержки/.test(out));
  // Незнакомые ключи не выбрасываются молча: именно так владелец и канал
  // полгода были невидимы — разведка искала их по угаданному списку слов.
  checkS('прочие атрибуты названы именами', /ЕЩЁ АТРИБУТЫ В КАРТОЧКЕ.*some_other_key/.test(out));

  // Пустая карточка — лишних заголовков нет.
  const bare = runReport({ urn: REP }, md, { statusCode: 200, body: {} }, links);
  checkS('без атрибутов владельца строки нет', !/ВЛАДЕЛЕЦ ОТЧЁТА/.test(bare));
  checkS('без канала строки нет', !/КУДА ПИСАТЬ ПО ОТЧЁТУ/.test(bare));
}

// ===================================================================== 11б
line('11б. ПУСТОЕ ОПИСАНИЕ — ФАКТ, А МОЛЧАНИЕ ПРО ЗАКРЫТОСТЬ — ТРЕВОГА');
{
  // ОТКАЗА ПО ОТДЕЛЬНОЙ КОЛОНКЕ БОЛЬШЕ НЕ БЫВАЕТ. Раньше описания шли
  // запросом НА КАЖДУЮ колонку, и часть из них могла отдать 500 — отсюда
  // «проверены N из M» и целая ветка про непришедшие карточки. Оптовая
  // ручка отвечает по всей витрине сразу: либо ответила, либо нет, и второе
  // это ошибка уровня таблицы (она в ОШИБКИ DD и в dd.http).
  //
  // Осталось два разных случая, и путать их дорого:
  //   пустое ОПИСАНИЕ  — владелец не заполнил. Факт, не тревога;
  //   молчание про ЧУВСТВИТЕЛЬНОСТЬ — спросили и не ответили. Тревога,
  //   потому что молчание неотличимо от «поле открыто».
  const URN_W = 'urn:dd:tables:greenplum:table:emart.t';
  const cols = { statusCode: 200, body: { totalCount: 3, data: [
    { entity: { urn: 'urn:dd:tables:greenplum:column:emart.t.a_col', fqn: 'emart.t.a_col' } },
    { entity: { urn: 'urn:dd:tables:greenplum:column:emart.t.b_col', fqn: 'emart.t.b_col' } },
    { entity: { urn: 'urn:dd:tables:greenplum:column:emart.t.c_col', fqn: 'emart.t.c_col' } },
  ] } };
  // Описание есть только у одного поля — у двух владелец его не завёл.
  const cards = [
    { statusCode: 200, body: { fqn: 'emart.t.a_col', summary: { data: 'Дата приёма' },
                               attributes: {} } },
    { statusCode: 200, body: { fqn: 'emart.t.b_col', attributes: {} } },
    { statusCode: 200, body: { fqn: 'emart.t.c_col', attributes: {} } },
  ];
  const pick = { mode: 'by_meaning', total_cols: 3, picked: 3, matched: 0, sens_asked: 3 };
  const out = runTable({ urn: URN_W, search: 'декрет' },
    { statusCode: 200, body: {} }, cols, cards, pick);

  checkS('каталог ответил по всем полям, и это сказано числом',
    /каталог ответил по 3 из 3/.test(out));
  checkS('а заполненных описаний названо своё число',
    /описание заполнено у 1/.test(out));
  // Утверждать отсутствие поля код не имеет права НИКОГДА — ни когда
  // описания пусты, ни когда они есть и не совпали. Это суждение
  // о смысле, оно за моделью.
  checkS('и код нигде не объявляет, что такого поля нет',
    !/не встретилось ни в одном/.test(out) &&
    !/такого поля или значения в таблице нет/.test(out));
  // Поля без описаний перечисляются — но как ФАКТ, а не как тревога.
  //
  // Живой прогон 2026-08-31: у витрины детей девять полей без описаний
  // (служебные колонки шины), шейпер объявил их «НЕПРОВЕРЕННЫМИ», автор
  // поставил среднюю уверенность и попросил «подтвердить состав полей» —
  // при том что все поля про детей описаны и ответа хватало полностью.
  // Описания заводит ВЛАДЕЛЕЦ витрины, не мы и не джун: это не пробел базы,
  // не задача и не основание снижать уверенность.
  checkS('поля без описаний перечислены', /БЕЗ ОПИСАНИЯ 2 полей/.test(out));
  checkS('и прямо сказано, что уверенность из-за этого не снижают',
    /Уверенность из-за\s+этого НЕ снижай/.test(out.replace(/\n/g, ' ')));

  // Все описания заполнены — лишних строк нет.
  const okCards = ['a', 'b', 'c'].map((n) => ({ statusCode: 200,
    body: { fqn: `emart.t.${n}_col`, summary: { data: 'x' }, attributes: {} } }));
  const clean = runTable({ urn: URN_W, search: 'декрет' },
    { statusCode: 200, body: {} }, cols, okCards, pick);
  checkS('без пустых описаний лишнего не пишется',
    /описание заполнено у 3/.test(clean) && !/БЕЗ ОПИСАНИЯ/.test(clean));

  // Карточки прочитаны, но совпадений нет: inventory() больше не утверждает,
  // что карточки не запрашивались — признак чувствительности у нас на руках.
  checkS('в by_meaning без совпадений признак не объявлен отсутствующим',
    !/карточки в этом режиме не запрашивались/.test(clean));
  checkS('и сводка по чувствительности напечатана',
    /ЧУВСТВИТЕЛЬНОСТЬ|ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ/.test(clean));

  // ГЛАВНОЕ В ЭТОЙ ГРУППЕ: СПРОСИЛИ 3, ОТВЕТИЛИ ПО 2.
  //
  // Оптовая ручка чувствительности отвечает словарём «urn → связи», и фаза J
  // измерила равенство: 120 URN → 120 ключей. Если равенства не будет,
  // про недостающие колонки мы не знаем НИЧЕГО — а по виду ответа они
  // выглядят ровно как незакрытые. Это самый дорогой из возможных исходов:
  // уверенное «согласование не нужно» на чувствительном поле.
  const partial = runTableRaw({ urn: URN_W, search: 'декрет' },
    { statusCode: 200, body: {} }, cols, okCards,
    { mode: 'by_meaning', total_cols: 3, picked: 3, matched: 0, sens_asked: 9 });
  checkS('неполный ответ про закрытость НАЗВАН, а не проглочен',
    /признак спрошен по 9 полям, ответ пришёл по 3/.test(partial.dd_meta));
  checkS('и прямо сказано, что молчание — не «поле открыто»',
    /молчание\s+тут НЕ значит/.test(partial.dd_meta.replace(/\n/g, ' ')));
  checkS('и это уехало структурой, а не только текстом',
    partial.dd.sens_partial === true && partial.dd.sens_asked === 9 &&
    partial.dd.sens_answered === 3);
  checkS('а при равенстве тревоги нет',
    /ЧУВСТВИТЕЛЬНОСТЬ/.test(clean) && !/признак спрошен по/.test(clean));

  // А когда признак не спрашивали вовсе — формулировка про это, и она
  // больше НЕ говорит «карточки не запрашивались»: описания приходят
  // всегда и по всем полям, отдельным запросом идёт только закрытость.
  // Утверждение, переставшее быть верным, — это тот же разъезд, только
  // в тексте для модели.
  const noSens = runTable({ urn: URN_W, search: '' },
    { statusCode: 200, body: {} }, cols);
  checkS('признак не спрашивали — так и сказано',
    /ГРУППЫ ДОСТУПА: не запрашивались/.test(noSens) &&
    /Считать поля\s+открытыми по этому ответу НЕЛЬЗЯ/.test(noSens.replace(/\n/g, ' ')));
  checkS('и про карточки там больше не врётся',
    !/карточки в этом режиме не запрашивались/.test(noSens));
}


// ===================================================================== 12
line('12. РЕЖИМ ВЫБИРАЕТСЯ ПО КАЖДОЙ ИГЛЕ, А НЕ ПО ОДНОЙ СОВПАВШЕЙ');
{
  // Живой отказ, найденный аудитом 2026-09-01 и воспроизведённый прогоном:
  // роутер даёт hint списком понятий, и если ОДНА игла случайно оказалась
  // латинским именем поля, весь вызов уходил в by_name — карточка читалась
  // только по ней, второе понятие не сравнивалось НИ С ЧЕМ.
  // Это дословный отказ 2026-08-26 («в витрине нет рабочей почты» при живом
  // wrk_email_address_txt), заново взведённый ФОРМОЙ иглы. Тест 8д его
  // не ловил: там все иглы кириллические.
  const URN_M = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d';
  const NAMES = ['mdm_employee_rk', 'ad_login', 'wrk_email_address_txt',
                 'business_dt', 'grade', 'full_nm'];
  const colsM = { statusCode: 200, body: { totalCount: NAMES.length,
    data: NAMES.map((n) => ({ entity: {
      fqn: `emart.mdm_employee_structure_d.${n}`,
      urn: `urn:dd:tables:greenplum:column:emart.mdm_employee_structure_d.${n}` } })) } };
  const pickM = (search) => runPick({ urn: URN_M, search }, colsM);

  const mixed = pickM('ad_login, рабочая почта');
  checkS('смешанная игла: режим by_meaning, а не by_name',
    mixed[0].mode === 'by_meaning');
  checkS('и подробности заказаны по ВСЕМ полям, включая почту',
    mixed[0].targets.length === NAMES.length &&
    mixed[0].targets.includes('wrk_email_address_txt'));

  const tech = pickM('ad_login, business_dt');
  checkS('все иглы техническими именами: режим by_name',
    tech[0].mode === 'by_name');
  checkS('и заказаны обе колонки, а не одна',
    tech[0].targets.length === 2 &&
    tech[0].targets.includes('ad_login') &&
    tech[0].targets.includes('business_dt'));

  const one = pickM('ad_login');
  checkS('одна техническая игла: by_name, одно поле подробно',
    one[0].mode === 'by_name' && one[0].targets.length === 1);

  const ru = pickM('логин, почта');
  checkS('все иглы по-русски: by_meaning, как и раньше',
    ru[0].mode === 'by_meaning' && ru[0].targets.length === NAMES.length);
}

// ===================================================================== 13
line('13. МЁРТВЫЙ СОВЕТ ВРЕМЁН TOOL-LOOP УБРАН');
{
  // «Вызови dd_lookup ещё раз со словом-фильтром» остался от конструкции,
  // где у агента были инструменты. В конвейере вызов ОДИН, у автора
  // инструментов нет: совет, который нельзя выполнить, автор пересказывает
  // заказчику как «нужен ещё один запрос» — то есть выдаёт ограничение
  // бота за пробел данных.
  const ddSrc = fs.readFileSync('DD Lookup.json', 'utf8');
  checkS('шейпер больше не предлагает вызвать dd_lookup ещё раз',
    !/вызови dd_lookup ещё раз/i.test(ddSrc));
  checkS('но говорит, что перечень — полный состав витрины с описаниями',
    /Это ПОЛНЫЙ состав витрины/.test(ddSrc));
}

// ===================================================================== 14
line('14. КОНТРАКТ НА ВЫХОДЕ: ДАННЫЕ РЯДОМ С ТЕКСТОМ');
{
  // Пока факт существовал только как формулировка внутри `dd_meta`, каждый
  // потребитель в ядре разгадывал его своей регуляркой, и правка текста
  // молча ослепляла соседа. Проверяем, что структура есть и полна ДАЖЕ
  // на фикстуре, где текст намеренно неудобен: двухбуквенное имя, смешанный
  // регистр, служебные колонки в двойных подчёркиваниях.
  const URN_K = 'urn:dd:tables:greenplum:table:' +
    'chrono_peoplehub_masterid.individualchildren_public';
  const NAMES = ['id', 'individualid', 'birthdate', 'CommonAddressId',
                 'Email', '__contract__', '__offset__'];
  const colsK = { statusCode: 200, body: { totalCount: NAMES.length,
    data: NAMES.map((n) => ({ entity: {
      fqn: `chrono_peoplehub_masterid.individualchildren_public.${n}`,
      urn: `urn:dd:tables:greenplum:column:chrono_peoplehub_masterid.individualchildren_public.${n}` } })) } };
  // Служебные колонки шины идут БЕЗ описания — так они и приходят из
  // каталога. Отказа по отдельной колонке в фикстуре больше нет: описания
  // приходят одним оптовым запросом, и поштучных отказов не бывает.
  const cardsK = NAMES.map((n) => (n.startsWith('__')
    ? { statusCode: 200, body: {
        fqn: `chrono_peoplehub_masterid.individualchildren_public.${n}`,
        attributes: {} } }
    : { statusCode: 200, body: {
        fqn: `chrono_peoplehub_masterid.individualchildren_public.${n}`,
        summary: { data: `описание ${n}` },
        attributes: { column_type: { type: 'text', data: 'text' } },
        ...(n === 'birthdate' ? { sensitivity: ['EMP_SENS'] } : {}) } }));
  const pickK = runPick({ urn: URN_K, search: 'дети, возраст детей' }, colsK);
  // Атрибуты ТАБЛИЦЫ отдали 500 — отказ уровня таблицы, единственный вид
  // отказа, который в этой ветке ещё возможен. Он обязан дожить до ядра
  // числом: 404 это строка реестра, 401 — Service Account, 500 — ретрай,
  // и это три РАЗНЫХ действия.
  const res = runTableFull({ urn: URN_K, search: 'дети, возраст детей' },
    { statusCode: 200, body: { data: 'Данные о детях' } }, colsK, cardsK, pickK[0],
    { statusCode: 500 }, null, undefined, NAMES);

  checkS('структура отдана рядом с текстом',
    res.dd && typeof res.dd === 'object' && typeof res.dd_meta === 'string');
  checkS('тип объекта назван', res.dd.object_type === 'table');
  checkS('состав полей полон, включая двухбуквенное и служебные',
    res.dd.fields.length === NAMES.length &&
    res.dd.fields.some((f) => f.name === 'id') &&
    res.dd.fields.some((f) => f.name === '__contract__'));
  checkS('описания лежат рядом с именами',
    (res.dd.fields.find((f) => f.name === 'birthdate') || {}).desc === 'описание birthdate');
  checkS('чувствительность — тоже поле структуры, а не строка текста',
    (res.dd.fields.find((f) => f.name === 'birthdate') || {}).sensitive === true &&
    (res.dd.fields.find((f) => f.name === 'id') || {}).sensitive === false);
  // ОТКАЗА ПО ОТДЕЛЬНОЙ КОЛОНКЕ БОЛЬШЕ НЕ БЫВАЕТ: описания приходят одним
  // оптовым запросом на всю витрину, и он либо ответил, либо нет — второе
  // это ошибка уровня таблицы, она в `problems` и в `http`. Поэтому `card`
  // теперь различает только «поле попало в подробный блок» и «не попало».
  checkS('исход по каждому полю назван',
    (res.dd.fields.find((f) => f.name === '__contract__') || {}).card === 'ok' &&
    (res.dd.fields.find((f) => f.name === 'id') || {}).card === 'ok');
  checkS('поля с описанием посчитаны фактом, а не пересказом',
    res.dd.cards_requested === NAMES.length &&
    res.dd.cards_received === res.dd.fields.filter((f) => f.desc).length);
  // Статус измерен двумя нодами и раньше выбрасывался — теперь доживает
  // до ядра: 404 это строка реестра, 401 — Service Account, 500 — ретрай,
  // и это три РАЗНЫХ действия.
  checkS('статусы запросов сохранены числами',
    Array.isArray(res.dd.http) && res.dd.http.some((h) => h.status === 500));
  checkS('режим назван', res.dd.mode === 'by_meaning');

  // Главное: структура собирается НЕЗАВИСИМО от текста.
  checkS('состав полей не зависит от разборности текста',
    res.dd.fields.length === NAMES.length && res.dd_total === NAMES.length);
}

// ===================================================================== 15
line('15. ОПТОВЫЙ ФЕТЧ: ГРАФ И ТЕЛА ЗАПРОСОВ');
{
  // Три запроса на колонку (289 × 3 ≈ 870 на вопрос) заменены одним
  // оптовым вызовом плюс чанками за чувствительностью. Измерено фазой J
  // разведки 2026-09-01, а не выведено: 289 из 289 колонок пришли
  // с описаниями И атрибутами, а сверка с эталоном из одиночной ручки
  // доказала, что entityFields не проигнорирован молча.
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const bulk = byName.get('dd_columns_bulk');
  const sens = byName.get('dd_columns_sens');
  checkS('оптовые ноды на месте', Boolean(bulk) && Boolean(sens));
  checkS('поштучных запросов за карточками не осталось',
    !byName.has('dd_column_summary') && !byName.has('dd_column_attrs') &&
    !byName.has('dd_columns'));

  const body = String(bulk.parameters.jsonBody || '');
  checkS('оптовый запрос идёт в batch/related',
    /entity\/batch\/related$/.test(String(bulk.parameters.url || '')));
  checkS('и просит именно те поля, которые измерены как приходящие',
    /displayName/.test(body) && /summary/.test(body) && /attributes/.test(body));
  // limit 500, а не 100 по умолчанию: у витрины 289 колонок, и потолок,
  // срабатывающий на выдаче, тихо превратил бы «столько полей у витрины»
  // в «столько поместилось».
  checkS('limit выше измеренного числа колонок (289)',
    Number((body.match(/limit:\s*(\d+)/) || [])[1]) > 289);

  // ЧАНК ЧУВСТВИТЕЛЬНОСТИ — ИЗМЕРЕННЫЙ РАЗМЕР, А НЕ КРУГЛОЕ ЧИСЛО.
  // Прогон подтвердил ровно 120 URN в теле (120 отправлено → 120 ключей).
  // Что пройдут 289, неизвестно, а отказ по размеру тела был бы по виду
  // неотличим от «признака нет», то есть тихо превратил бы закрытое поле
  // в открытое. Число обязано называть, откуда оно взято, — иначе это
  // придуманный порог, каких в этом проекте уже снимали четыре.
  const pickSrc = js('Pick columns');
  const chunk = Number((pickSrc.match(/SENS_CHUNK\s*=\s*(\d+)/) || [])[1]);
  checkS('чанк чувствительности задан константой', Number.isFinite(chunk));
  checkS('и он не больше измеренного (120)', chunk <= 120);
  checkS('и происхождение числа названо в коде',
    /120 URN в одном теле|подтвердил ровно 120/.test(pickSrc));

  // Нода чувствительности выполняется ПО РАЗУ НА ЧАНК: executeOnce тут
  // означал бы, что спросили только первые 120 колонок, а про остальные
  // молчание — и молчание неотличимо от «поле открыто».
  checkS('чанки не схлопываются в один запрос', !sens.executeOnce);
  checkS('а отказ ручки не роняет прогон',
    sens.onError === 'continueRegularOutput' &&
    bulk.onError === 'continueRegularOutput');

  // ВЕЕРА БЫТЬ НЕ ДОЛЖНО: в n8n нет неявного слияния, и узел за развилкой
  // выполнится по разу на каждую дошедшую ветвь. Сходящиеся ветви IF —
  // наоборот, норма: они взаимоисключающие.
  const IF_NODES = new Set(wf.nodes
    .filter((n) => (n.type || '').endsWith('.if')).map((n) => n.name));
  for (const [from, conn] of Object.entries(wf.connections)) {
    const branches = (conn.main || []);
    if (IF_NODES.has(from)) continue;
    const targets = branches.flat().map((e) => e.node);
    checkS(`${from}: один выход, а не веер`, targets.length <= 1);
  }
}

console.log(ddFails ? `ПРОВАЛОВ: ${ddFails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(ddFails ? 1 : 0);
