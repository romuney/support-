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
function runTable(inputs, card, cols, cards = null, pick = null, entityAttrs = null,
                  valuesPlan = null, valuesRes = undefined) {
  const pickList = cards !== null ? cards.map((c) => ({ field: shortNameLocal((c && c.body) || c || {}) })) : [];
  const $ = (name) => {
    if (name === 'dd_column_summary') {
      if (cards === null) throw new Error('node not executed');
      return {
        all: () =>
          cards.map((c) => {
            const b = (c && c.body) || c || {};
            const s = b.summary;
            const data = s && typeof s === 'object' ? s.data ?? '' : typeof s === 'string' ? s : '';
            return { json: { statusCode: c ? c.statusCode : 200, body: { data } } };
          }),
      };
    }
    if (name === 'dd_column_attrs') {
      if (cards === null) throw new Error('node not executed');
      return {
        all: () =>
          cards.map((c) => {
            const b = (c && c.body) || c || {};
            return { json: { statusCode: c ? c.statusCode : 200, body: b.attributes || {} } };
          }),
      };
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
      return {
        first: () => ({ json: pick !== null ? pick : pickList[0] || null }),
        all: () => pickList.map((json) => ({ json })),
      };
    }
    return {
      first: () => ({
        json: {
          'When called by agent': inputs,
          dd_entity_card: card,
          dd_entity_attrs: entityAttrs,
          dd_columns: cols,
        }[name],
      }),
    };
  };
  return new Function('$', js('Shape table meta'))($)[0].json.dd_meta;
}

// Прогон ноды «Build values SQL»: какой SQL она построит и что исключит.


// pairs — то, что вернула бы модель. null = «взять все кандидаты по порядку»,
// чтобы старые проверки отбора полей остались про отбор, а не про промпт.

// Прогон ноды Pick columns: что она отдаст дальше по флоу.
function runPick(inputs, cols) {
  const $ = (name) => ({
    first: () => ({
      json: { 'When called by agent': inputs, dd_columns: cols }[name],
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
checkS('  предложен шаг 2 с фильтром', /вызови dd_lookup ещё раз/.test(real));
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
checkS('  сказано, что поля нет', /такого названия в таблице нет|поля с таким/.test(out));

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
const dismissalCards = dismissalPick.map((t) => ({
  statusCode: 200,
  body: {
    fqn: t.field === 'dismissal_reason_desc'
      ? 'hrmart.legal_position_dismissal_reason.dismissal_reason_desc'
      : `hrmart.legal_position_dismissal_reason.${t.field}`,
    summary: {
      data: t.field === 'dismissal_reason_desc'
        ? 'Причины увольнения текстом от сотрудника'
        : `техническое поле ${t.field}`,
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
checkS('  карточки заказаны на все поля', dismissalPick.length === 4);
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
const dismissalCardsMiss = dismissalPickMiss.map((t) => ({
  statusCode: 200,
  body: {
    fqn: `hrmart.legal_position_dismissal_reason.${t.field}`,
    // Описание НЕ должно содержать само слово поиска: «зарплата» режется
    // до основы «зарплат», а «к зарплате отношения не имеет» эту основу
    // содержит — фикстура промаха сама себе противоречила и совпадала.
    summary: { data: `служебное поле ${t.field}, нужно для загрузки данных` },
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
const wideCards = widePick.map((t) => ({
  statusCode: 200,
  body: {
    fqn: `emart.wide_table.${t.field}`,
    summary: {
      data: t.field === 'field_100' ? 'Признак: сотрудница в декретном отпуске' : `служебное поле ${t.field}`,
    },
  },
}));
out = runTable({ urn: URN, search: 'декрет' }, wideCard, wideCols, wideCards, widePick[0]);
console.log('\nПРОВЕРКИ:');
checkS('  Pick columns не режет по 60', widePick.length === N_WIDE);
checkS('  проверены ВСЕ поля', new RegExp(`проверены ${N_WIDE} из ${N_WIDE} полей`).test(out));
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
  const cards = pick.map((t) => ({
    statusCode: 200,
    body: { fqn: `emart.mix.${t.field}`, summary: { data: DESCR[t.field] || '' } },
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
  const mkCard = (n, attrs) => ({
    statusCode: 200,
    body: { fqn: `emart.mdm_employee_structure_d.${n}`,
            summary: { data: `описание ${n}` }, attributes: attrs },
  });

  // Атрибут sensitivity ПОДТВЕРЖДЁН владельцем задачи 2026-08-27: заполнен —
  // поле чувствительное, нужен доступ и согласование. Значение называет
  // AD-группу, но вывод от неё не зависит.
  const closed = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', { column_type: { type: 'text', data: 'text' },
                       sensitivity: { type: 'text-list', data: ['HR_PII_READ'] } }),
    mkCard('grade_nm', { column_type: { type: 'text', data: 'text' },
                         sensitivity: { type: 'text-list', data: [] } }),
  ]);
  checkS('чувствительное поле помечено у самого поля',
    /fio_nm[\s\S]*ЧУВСТВИТЕЛЬНОЕ ПОЛЕ \(sensitivity: HR_PII_READ\)/.test(closed));
  checkS('сказано, что нужно согласование',
    /нужен доступ и согласование/.test(closed));
  checkS('сводка называет чувствительные', /ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ 1 из 2/.test(closed));
  checkS('сводка называет имя атрибута', /атрибута «sensitivity»/.test(closed));
  // Группа называет, КУДА идти, но на вывод не влияет: заполнено = закрыто.
  checkS('группа названа как адрес, а не как условие',
    /называет, КУДА идти за доступом/.test(closed));
  // Якорь «— » обязателен: без него совпадает упоминание поля в списке
  // «ПОДОШЛИ ПОЛЯ» выше, и проверка ловит чужую пометку.
  checkS('незакрытое поле не помечено', !/— grade_nm[\s\S]*ЧУВСТВИТЕЛЬНОЕ/.test(closed));

  // sensitivity стоит ПЕРВЫМ в ACCESS_KEYS — значит выигрывает у прежних
  // кандидатов, даже если карточка несёт оба атрибута сразу.
  const both = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', { sensitivity: { type: 'text-list', data: ['SENS_GRP'] },
                       access_groups: { type: 'text-list', data: ['OLD_GRP'] } }),
  ]);
  checkS('sensitivity выигрывает у прежних кандидатов',
    /sensitivity: SENS_GRP/.test(both) && !/OLD_GRP/.test(both));

  // Признак есть, групп нет ни у кого → закрытых нет, и это утверждение.
  const open = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', { sensitivity: { type: 'text-list', data: [] } }),
    mkCard('grade_nm', { sensitivity: { type: 'text-list', data: [] } }),
  ]);
  checkS('признак пуст — сказано прямо',
    /признак не проставлен\s+ни у одного/.test(open));

  // Признака нет вовсе → НЕИЗВЕСТНО, и молчать об этом нельзя.
  const unknown = runTable({ urn: URN, search: 'nm' }, card, cols, [
    mkCard('fio_nm', { column_type: { type: 'text', data: 'text' } }),
    mkCard('grade_nm', { column_type: { type: 'text', data: 'text' } }),
  ]);
  // ПРИЗНАК НЕ НАЙДЕН — НАЗЫВАЕТСЯ ФАКТОМ, А НЕ ТРЕВОГОЙ, и печатает
  // атрибуты, которые реально пришли. Живой прогон 2026-08-31: в карточке
  // витрины детей стоит EMP_SENS, а шейпер писал «признака нет ни у одного
  // из 25 полей» — то есть ключ мы читаем не тот, и по строке этого
  // не видно. Плюс сама формулировка требовала оговорки в КАЖДОМ черновике.
  checkS('признак не найден — сказано без тревоги',
    /признак в ответе каталога не найден/.test(unknown));
  checkS('и перечислены атрибуты, которые пришли',
    /в карточках пришли атрибуты: .*column_type/.test(unknown));
  checkS('и «поля открыты» из этого не следует',
    /Это не значит «поля открыты»/.test(unknown));
  checkS('а запрет на ПДн держится по смыслу поля, а не по каталогу',
    /персональное — ФИО, телефон, почта/.test(unknown.replace(/\n/g, ' ')));

  // can_be_accessed: {boolean, true} есть на НАСТОЯЩЕЙ карточке колонки.
  // Свободный поиск по /access/ находил его и печатал «закрыто группами true»
  // у открытого поля — тот же класс ошибки, что versioning_type вместо типа.
  const real = runTable({ urn: URN, search: 'business_dt' }, card,
    { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } }, [REAL_CARD_BUSINESS_DT]);
  checkS('can_be_accessed не выдан за группы доступа', !/ЗАКРЫТО группами true/i.test(real));
  checkS('на настоящей карточке признак признан отсутствующим',
    /признак в ответе каталога не найден/.test(real));

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
line('11б. НЕПРИШЕДШИЕ КАРТОЧКИ: проверенным считается только полученное');
{
  const URN_W = 'urn:dd:tables:greenplum:table:emart.t';
  const cols = { statusCode: 200, body: { totalCount: 3, data: [
    { entity: { fqn: 'emart.t.a_col' } },
    { entity: { fqn: 'emart.t.b_col' } },
    { entity: { fqn: 'emart.t.c_col' } },
  ] } };
  // Карточки запрошены по всем трём полям, но две вернули 500.
  const cards = [
    { statusCode: 200, body: { fqn: 'emart.t.a_col', summary: { data: 'Дата приёма' },
                               attributes: {} } },
    { statusCode: 500, body: { fqn: 'emart.t.b_col' } },
    { statusCode: 500, body: { fqn: 'emart.t.c_col' } },
  ];
  const pick = { mode: 'by_meaning', total_cols: 3, picked: 3, matched: 0 };
  const out = runTable({ urn: URN_W, search: 'декрет' },
    { statusCode: 200, body: {} }, cols, cards, pick);

  // Раньше здесь печаталось «проверены 3 из 3»: details строится из targets
  // и фильтруется по `d.field || d.failed`, то есть упавшие карточки шли
  // в зачёт наравне с полученными, и ветка про непроверенные поля была
  // мёртвой. «Не встретилось» читалось как «такого поля нет», хотя две
  // трети полей никто не смотрел.
  checkS('проверенным считается только полученное', /проверены 1 из 3/.test(out));
  checkS('отказ карточек назван числом', /по 2 каталог не отдал карточку/.test(out));
  // Утверждать отсутствие поля код не имеет права НИКОГДА — ни когда
  // карточки не пришли, ни когда пришли и не совпали. Это суждение
  // о смысле, оно за моделью.
  checkS('и код нигде не объявляет, что такого поля нет',
    !/не встретилось ни в одном/.test(out) &&
    !/такого поля или значения в таблице нет/.test(out));
  checkS('а непришедшие карточки названы числом и списком',
    /Не проверены описания у/.test(out) || /каталог не отдал карточку/.test(out));
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

  // Все карточки пришли — лишних строк нет.
  const okCards = cards.map((c, i) => ({ statusCode: 200,
    body: { fqn: `emart.t.${['a', 'b', 'c'][i]}_col`, summary: { data: 'x' }, attributes: {} } }));
  const clean = runTable({ urn: URN_W, search: 'декрет' },
    { statusCode: 200, body: {} }, cols, okCards, pick);
  checkS('без отказов лишнего не пишется',
    /проверены 3 из 3/.test(clean) && !/ОПИСАНИЯ НЕ ПОЛУЧЕНЫ/.test(clean));

  // Карточки прочитаны, но совпадений нет: inventory() больше не утверждает,
  // что карточки не запрашивались — признак чувствительности у нас на руках.
  checkS('в by_meaning без совпадений признак не объявлен отсутствующим',
    !/карточки в этом режиме не запрашивались/.test(clean));
  checkS('и сводка по чувствительности напечатана',
    /ЧУВСТВИТЕЛЬНОСТЬ|ЧУВСТВИТЕЛЬНЫХ ПОЛЕЙ/.test(clean));

  // А при пустом search карточек правда нет — там формулировка верна.
  const noCards = runTable({ urn: URN_W, search: '' },
    { statusCode: 200, body: {} }, cols);
  checkS('без карточек формулировка прежняя',
    /карточки в этом режиме не запрашивались/.test(noCards));
}


console.log(ddFails ? `ПРОВАЛОВ: ${ddFails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(ddFails ? 1 : 0);
