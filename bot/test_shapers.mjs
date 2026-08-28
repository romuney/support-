// Прогон шейперов DD Lookup.json на подставных данных DD.
// Проверяет: полный инвентарь без search, фильтр search, промах фильтра,
// пустой ответ, HTTP-ошибки, разные варианты обёртки массива.
import fs from 'fs';

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
function runValuesSql(inputs, cols, picked, cards, summaries = null) {
  const $ = (name) => {
    if (name === 'Pick columns') {
      return { all: () => picked.map((json) => ({ json })) };
    }
    if (name === 'dd_column_attrs') {
      return { all: () => cards.map((json) => ({ json })) };
    }
    if (name === 'dd_column_summary') {
      const list = summaries !== null ? summaries : picked.map(() => ({ body: { data: '' } }));
      return { all: () => list.map((json) => ({ json })) };
    }
    return {
      first: () => ({ json: { 'When called by agent': inputs, dd_columns: cols }[name] }),
    };
  };
  return new Function('$', js('Build values SQL'))($)[0].json;
}

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
console.log('  тип «date», не [object Object]:', /\(date\)/.test(real) && !/object Object/.test(real));
console.log('  versioning_type НЕ выдан за тип:', !/BSN/.test(real));
console.log('  описание «Дата среза»:          ', /Дата среза/.test(real));
console.log('  комментарий владельца есть:     ', /подневно развернута/.test(real));
console.log('  ключ PK показан:                ', /\[PK\]/.test(real));

line('00б. Pick columns — какие URN уйдут за карточками');
console.log('пустой search:', JSON.stringify(runPick({ urn: URN, search: '' }, { statusCode: 200, body: { data: REAL_COLS } })));
console.log('search=hire: ', JSON.stringify(runPick({ urn: URN, search: 'hire' }, { statusCode: 200, body: { data: REAL_COLS } })));

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
console.log('  комментарий из DD показан:    ', /КОММЕНТАРИЙ ИЗ DD: Витрина считается только/.test(withComment));

// Comment совпадает с summary дословно — дублировать незачем.
const sameAsSummary = runTable(
  { urn: URN, search: '' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
  null,
  null,
  { statusCode: 200, body: { comment: { type: 'text', data: card.body.data } } },
);
console.log('  дубль summary не печатается:  ', (sameAsSummary.match(/сотрудник на каждый календарный день/g) || []).length === 1);

// Атрибутов у таблицы нет вовсе — как и раньше, строка просто не появляется.
const noComment = runTable(
  { urn: URN, search: '' },
  card,
  { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } },
);
console.log('  без атрибутов — без строки:  ', !/КОММЕНТАРИЙ ИЗ DD/.test(noComment));

line('0. РЕАЛЬНАЯ ФОРМА ОТВЕТА DD — entity внутри, без описаний, totalCount 267');
real = runTable({ urn: URN, search: '' }, card, {
  statusCode: 200,
  body: { totalCount: 267, data: REAL_COLS },
});
console.log(real);
console.log('\nПРОВЕРКИ:');
console.log('  поля распакованы из entity:', /business_dt, mdm_employee_rk/.test(real));
console.log('  сказано «получено 4 из 267»:', /получено 4 из 267/.test(real));
console.log('  список назван НЕПОЛНЫМ:     ', /НЕПОЛНЫЙ/.test(real));
console.log('  предложен шаг 2 с фильтром: ', /вызови dd_lookup ещё раз/.test(real));
console.log('  подробностей нет (шаг 1):   ', !/ПОДРОБНО ПО ПОЛЯМ/.test(real));

line('0б. РЕАЛЬНАЯ ФОРМА + фильтр: таблицы с прочерками быть не должно');
real = runTable({ urn: URN, search: 'dt' }, card, {
  statusCode: 200,
  body: { totalCount: 267, data: REAL_COLS },
});
console.log(real);
console.log('\nПРОВЕРКИ:');
console.log('  нет пустой таблицы с «—»:', !/\| — \| — \|/.test(real));
console.log('  найдены поля по фильтру: ', /business_dt, company_hire_dt, company_fire_dt/.test(real));

line('1. ШАГ 1: БЕЗ ФИЛЬТРА — полный инвентарь 211 имён, обрезки нет');
let out = runTable({ urn: URN, search: '' }, card, cols210);
let lines = out.split('\n');
console.log(lines.slice(0, 7).join('\n'));
console.log('   ...');
console.log(lines.slice(-4).join('\n'));
console.log('\nПРОВЕРКИ:');
console.log('  все 211 имён в тексте:', /field_209/.test(out) && /emp_grade_desc/.test(out));
console.log('  нет слова СКРЫТО:     ', !/СКРЫТО/.test(out));
console.log('  размер, КБ:           ', (Buffer.byteLength(out) / 1024).toFixed(1));

line('2. ШАГ 2: ФИЛЬТР grade — таблица с типом и описанием');
console.log(runTable({ urn: URN, search: 'grade' }, card, cols210));

line('3. ФИЛЬТР ПРОМАХНУЛСЯ — должен вернуть полный инвентарь как подсказку');
out = runTable({ urn: URN, search: 'зарплата' }, card, cols210);
lines = out.split('\n');
console.log(lines.slice(0, 9).join('\n'));
console.log('   ...');
console.log('\nПРОВЕРКИ:');
console.log('  инвентарь приложен:   ', /field_100/.test(out));
console.log('  сказано, что поля нет:', /такого названия в таблице нет|поля с таким/.test(out));

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
console.log('  сказано про 99 без описаний:', /описания получены по 12/.test(out) && /остальным 99/.test(out));
console.log('  подробности по 12 есть:     ', /ПОДРОБНО ПО ПОЛЯМ \(12\)/.test(out));

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
console.log('Pick columns режим:', dismissalPick[0].mode);
console.log(out);
console.log('\nПРОВЕРКИ:');
console.log('  режим by_meaning выбран:      ', dismissalPick[0].mode === 'by_meaning');
console.log('  карточки заказаны на все поля:', dismissalPick.length === 4);
console.log('  найдено по смыслу:            ', /НАЙДЕНО ПО СМЫСЛУ: 1/.test(out));
console.log('  нужное поле в ответе:         ', /dismissal_reason_desc/.test(out));
console.log('  описание по-русски пришло:    ', /Причины увольнения текстом от сотрудника/.test(out));
console.log('  нерелевантные поля не показаны:', !/техническое поле/.test(out));

line('8в. ПОИСК ПО СМЫСЛУ — ни имя, ни описание не совпали');
const dismissalPickMiss = runPick({ urn: URN, search: 'зарплата' }, dismissalCols);
const dismissalCardsMiss = dismissalPickMiss.map((t) => ({
  statusCode: 200,
  body: {
    fqn: `hrmart.legal_position_dismissal_reason.${t.field}`,
    summary: { data: `служебное поле ${t.field}, к зарплате отношения не имеет` },
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
console.log('  сказано, что не встретилось:  ', /не встретилось ни в одном/.test(out));
console.log('  инвентарь имён приложен:      ', /dismissal_reason_desc/.test(out) && /ВСЕ ПОЛЯ ТАБЛИЦЫ/.test(out));

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
console.log('  Pick columns не режет по 60:  ', widePick.length === N_WIDE);
console.log('  проверены ВСЕ поля:           ', new RegExp(`проверены ${N_WIDE} из ${N_WIDE} полей`).test(out));
console.log('  нет упоминания потолка:       ', !/потолок/.test(out));
console.log('  поле за старым потолком найдено:', /field_100/.test(out) && /декретном отпуске/.test(out));

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

const one = mixRun('логин');
console.log('\nПРОВЕРКИ:');
console.log('  одна игла: логин найден:      ', /ad_login/.test(one.out));
console.log('  одна игла: почта НЕ найдена:  ', !/wrk_email_address_txt/.test(one.out));
console.log('  но сказано, что показаны не все:',
  /Показаны ТОЛЬКО поля, совпавшие/.test(one.out));
console.log('  и запрещено судить об отсутствии:',
  /об отсутствии в таблице ДРУГОГО поля/.test(one.out));

const two = mixRun('логин, почта');
console.log('  две иглы: логин найден:       ', /ad_login/.test(two.out));
console.log('  две иглы: почта найдена:      ', /wrk_email_address_txt/.test(two.out));
console.log('  две иглы: лишнее не притянуло:', !/business_dt/.test(two.out));

// Склонение: «почты» не содержит подстроку «почта», а описание — «Рабочая почта».
const infl = mixRun('почты');
console.log('  склонение: «почты» → найдено: ', /wrk_email_address_txt/.test(infl.out));

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
  console.log('  ошибка атрибутов названа:  ', /ОШИБКИ DD:.*атрибуты/.test(out));
  console.log('  markdown при этом виден:   ', /НАЗНАЧЕНИЕ:/.test(out));
}

// ==========================================================================
// 11. ГРУППЫ ДОСТУПА: три состояния, которые нельзя путать
//
// Для запроса на выгрузку это готовый раздел сообщения заказчику: какие поля
// по умолчанию не выгружаются и требуют согласования. Цена ошибки
// несимметрична — принять «признака нет» за «поле открыто» значит уверенно
// сказать заказчику, что согласование не нужно, и ошибиться именно на ПДн.
let ddFails = 0;
const checkS = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) ddFails++;
};

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
  checkS('признака нет — назван неизвестным', /признака нет в метаданных/.test(unknown));
  checkS('признака нет — запрет на вывод «открыто»',
    /Считать эти поля открытыми НЕЛЬЗЯ/.test(unknown));

  // can_be_accessed: {boolean, true} есть на НАСТОЯЩЕЙ карточке колонки.
  // Свободный поиск по /access/ находил его и печатал «закрыто группами true»
  // у открытого поля — тот же класс ошибки, что versioning_type вместо типа.
  const real = runTable({ urn: URN, search: 'business_dt' }, card,
    { statusCode: 200, body: { totalCount: 267, data: REAL_COLS } }, [REAL_CARD_BUSINESS_DT]);
  checkS('can_be_accessed не выдан за группы доступа', !/ЗАКРЫТО группами true/i.test(real));
  checkS('на настоящей карточке признак признан отсутствующим',
    /признака нет в метаданных/.test(real));

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
  checkS('и сказано, что утверждать об отсутствии нельзя',
    /сказать НЕЛЬЗЯ|НЕПРОВЕРЕННЫМИ/.test(out));
  // Отказы по карточкам обязаны быть видны сами по себе: поле, чьё описание
  // не пришло, выглядело в точности как поле без описания.
  checkS('поля без описаний перечислены', /ОПИСАНИЯ НЕ ПОЛУЧЕНЫ по 2 полям/.test(out));
  checkS('и это не выдано за отсутствие описания',
    /НЕ значит, что описания\s+нет/.test(out.replace(/\n/g, ' ')));

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

// ===================================================================== 12
line('12. ЗНАЧЕНИЯ ПОЛЕЙ: SQL строится по данным, а не по вере');
{
  const URN_T = 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d';
  const colsWithSlice = { statusCode: 200, body: { totalCount: 3, data: [
    { entity: { fqn: 'emart.mdm_employee_structure_d.emp_specialization_desc' } },
    { entity: { fqn: 'emart.mdm_employee_structure_d.full_nm' } },
    { entity: { fqn: 'emart.mdm_employee_structure_d.last_day_flg' } },
  ] } };
  const picked = [{ field: 'emp_specialization_desc' }, { field: 'full_nm' }];
  const cardsOpen = [{ body: {} }, { body: {} }];

  const plan = runValuesSql({ urn: URN_T, search: 'специализация', values: 'аналитик' },
    colsWithSlice, picked, cardsOpen);
  checkS('SQL построен', plan.values_sql.length > 0);
  // Имя таблицы выводится из URN и получает префикс prod_v_: читать из emart
  // напрямую нельзя, запросы идут из prod_v-схемы.
  checkS('таблица с префиксом prod_v_',
    plan.values_table === 'prod_v_emart.mdm_employee_structure_d');
  // Канонический срез добавляется, ТОЛЬКО если поле есть в таблице: слепое
  // добавление уронило бы запрос на витрине без last_day_flg.
  checkS('канонический срез добавлен, раз поле есть',
    plan.values_slice === true && /last_day_flg = 1/.test(plan.values_sql));
  // ПДн не тянем никогда, даже если признак чувствительности пуст.
  checkS('поле с именем ПДн исключено',
    !plan.values_fields.includes('full_nm') &&
    plan.values_skipped.some((x) => /full_nm/.test(x)));
  checkS('исключение названо, а не молча', plan.values_skipped.length === 1);
  // ilike по числовому столбцу Trino не выполнит — приводим тип.
  checkS('тип приводится перед ilike', /CAST\(emp_specialization_desc AS varchar\) ILIKE/.test(plan.values_sql));
  // Слово режется до основы тем же needlesOf, что и фильтр по описаниям, и это
  // здесь намеренно: ilike '%аналит%' поймает и «Бизнес-аналитик BI», и
  // «Аналитики BI», а точное '%аналитик%' промахнулось бы мимо склонения —
  // ровно как промахивалась подстрока «почты» до правки 2026-08-27.
  checkS('слово подставлено с обёртками, по основе', /ILIKE '%аналит%'/.test(plan.values_sql));
  // Перенос строки в SQL обязан быть настоящим переносом: литеральный \\n
  // Trino не разберёт, а по виду JSON это неотличимо от нормального запроса.
  checkS('в SQL настоящие переносы строк',
    plan.values_sql.includes('\n') && !/\\n/.test(plan.values_sql));

  // Витрина без last_day_flg: срез не добавляем, иначе запрос упадёт.
  const noSlice = runValuesSql({ urn: URN_T, values: 'аналитик' },
    { statusCode: 200, body: { data: [
      { entity: { fqn: 'emart.t.emp_specialization_desc' } }] } },
    [{ field: 'emp_specialization_desc' }], [{ body: {} }]);
  checkS('без last_day_flg срез не добавляется',
    noSlice.values_slice === false && !/last_day_flg/.test(noSlice.values_sql));

  // Чувствительное поле исключается по признаку из каталога.
  const sens = runValuesSql({ urn: URN_T, values: 'аналитик' }, colsWithSlice,
    [{ field: 'emp_specialization_desc' }],
    [{ body: { sensitivity: { type: 'text-list', data: ['HR_PII_READ'] } } }]);
  checkS('чувствительное поле исключено', sens.values_sql === '');
  checkS('и причина названа', /чувствительн/.test(sens.values_reason));

  // В by_meaning «Pick columns» отдаёт ВСЕ колонки таблицы — совпадение
  // считается позже, по описаниям. Если брать «первые отобранные», запрос
  // уйдёт по случайному полю: витрина просканирована, автору показаны
  // значения не из того столбца, и по виду ответа это неотличимо от работы.
  const wideCols = { statusCode: 200, body: { data: [
    { entity: { fqn: 'emart.t.a_first_col' } },
    { entity: { fqn: 'emart.t.b_second_col' } },
    { entity: { fqn: 'emart.t.emp_specialization_desc' } },
  ] } };
  const widePicked = [
    { field: 'a_first_col', mode: 'by_meaning' },
    { field: 'b_second_col', mode: 'by_meaning' },
    { field: 'emp_specialization_desc', mode: 'by_meaning' },
  ];
  const meaning = runValuesSql(
    { urn: 'urn:dd:tables:greenplum:table:emart.t', search: 'специализация', values: 'аналитик' },
    wideCols, widePicked, [{ body: {} }, { body: {} }, { body: {} }],
    [{ body: { data: 'Дата приёма' } }, { body: { data: 'Табельный номер' } },
     { body: { data: 'Специализация сотрудника' } }],
  );
  checkS('by_meaning: значения тянутся по совпавшему полю',
    meaning.values_fields.length === 1 &&
    meaning.values_fields[0] === 'emp_specialization_desc');
  checkS('by_meaning: несовпавшие поля в запрос не попали',
    !/a_first_col|b_second_col/.test(meaning.values_sql));

  // Слов не задали — запроса нет вовсе: тянуть значения «на всякий случай»
  // значит платить сканом витрины на каждой выгрузке.
  const noWords = runValuesSql({ urn: URN_T, values: '' }, colsWithSlice, picked, cardsOpen);
  checkS('без слов SQL не строится', noWords.values_sql === '');

  // --------------------------------------------- три исхода в шейпере
  const card = { statusCode: 200, body: {} };
  const shape = (valuesPlan, valuesRes) => runTable(
    { urn: URN_T, search: 'специализация' }, card, colsWithSlice,
    [{ statusCode: 200, body: { fqn: 'emart.t.emp_specialization_desc', attributes: {} } }],
    null, null, valuesPlan, valuesRes);

  const okPlan = { values_sql: 'select 1', values_fields: ['emp_specialization_desc'],
                   values_words: ['аналитик'], values_skipped: [],
                   values_table: 'prod_v_emart.mdm_employee_structure_d',
                   values_slice: true, values_reason: '' };

  const found = shape(okPlan, [
    { fld: 'emp_specialization_desc', val: 'Бизнес-аналитик BI', cnt: 42 },
    { fld: 'emp_specialization_desc', val: 'Системный аналитик', cnt: 17 },
  ]);
  checkS('найденные значения показаны', /«Бизнес-аналитик BI» — 42 строк/.test(found));
  checkS('сказано, что это реальные значения', /РЕАЛЬНЫЕ значения из витрины/.test(found));
  // Значение выбирает АВТОР: автоподстановка «похожего» даст запрос, который
  // выполнится и вернёт не те цифры.
  checkS('подставлять похожее запрещено', /подставлять «похожее» нельзя/.test(found));

  // Значений нет — это НЕ то же самое, что «витрины нет».
  const empty = shape(okPlan, []);
  checkS('пусто названо отсутствием значений', /НЕ НАЙДЕНО/.test(empty));
  checkS('и предложено уточнить, а не угадать', /Уточни формулировку/.test(empty));

  // Витрина не доехала до Trino — третий, отдельный диагноз.
  const missing = shape(okPlan, [{ error: "Table 'dl.prod_v_emart.x' does not exist" }]);
  checkS('недоступная витрина названа отдельно',
    /в хранилище запросов нет/.test(missing) && !/НЕ НАЙДЕНО/.test(missing));
  checkS('и сказано, что значение неизвестно',
    /КОНКРЕТНОГО значения мы не знаем/.test(missing));

  // Прочий отказ запроса — не «значений нет».
  const failed = shape(okPlan, [{ error: 'Query exceeded per-node memory limit' }]);
  checkS('прочий отказ не выдан за отсутствие значений',
    /отказ запроса, а не отсутствие значений/.test(failed));

  // Узел не выполнялся, хотя SQL был построен — сбой конвейера.
  const notRun = shape(okPlan, undefined);
  checkS('неисполнившийся узел назван сбоем', /сбой конвейера/.test(notRun));

  // Форма ответа CUSTOM.trino на SELECT живым прогоном не подтверждена.
  // Строки могут приехать и обёрткой — разобрать обязаны обе формы.
  const wrapped = shape(okPlan, [{ data: [
    { fld: 'emp_specialization_desc', val: 'Бизнес-аналитик BI', cnt: 42 },
  ] }]);
  checkS('строки в обёртке разобраны', /«Бизнес-аналитик BI» — 42 строк/.test(wrapped));

  // А вот НЕРАСПОЗНАННАЯ форма обязана называться сбоем разбора. Выдать её
  // за «значений не найдено» значит ответить про данные, которых никто
  // не смотрел, — и по виду ответа это неотличимо от проверенного факта.
  const weird = shape(okPlan, [{ someUnknownShape: 1, columns: ['a'] }]);
  checkS('нераспознанный ответ назван сбоем разбора',
    /разобрать его не удалось/.test(weird) && !/НЕ НАЙДЕНО/.test(weird));
  checkS('и запрещено утверждать про значения',
    /ничего не утверждай/.test(weird));
  // Пустая обёртка — это честное «строк нет», а не сбой разбора.
  const emptyWrap = shape(okPlan, [{ data: [] }]);
  checkS('пустая обёртка — это отсутствие значений', /НЕ НАЙДЕНО/.test(emptyWrap));

  // Список упёрся в потолок — обрезка называется, иначе «других значений
  // нет» становится утверждением о факте, которого никто не проверял.
  const capped = shape({ ...okPlan, values_limit: 3 }, [
    { fld: 'f', val: 'a', cnt: 3 }, { fld: 'f', val: 'b', cnt: 2 },
    { fld: 'f', val: 'c', cnt: 1 },
  ]);
  checkS('обрезка по лимиту названа', /список ОБРЕЗАН лимитом/.test(capped));
  const notCapped = shape({ ...okPlan, values_limit: 60 }, [
    { fld: 'f', val: 'a', cnt: 3 },
  ]);
  checkS('без обрезки лишнего не пишется', !/ОБРЕЗАН/.test(notCapped));

  // Ветки значений не было вовсе (старый вызов без values) — блока нет.
  const silent = shape(null, undefined);
  checkS('без ветки значений блока нет', !/ЗНАЧЕНИЯ ПОЛЕЙ/.test(silent));

  // Значения ПРОСИЛИ, а ветка не запустилась (пустой search — карточки полей
  // не запрашивались вовсе). Молчать нельзя: по виду ответа это неотличимо
  // от «значений не просили», и автор решит, что проверка была.
  const askedButSkipped = runTable(
    { urn: URN_T, search: '', values: 'BI-аналитик' }, card, colsWithSlice,
    null, null, null, null, undefined);
  checkS('непроверенные значения названы',
    /НЕ ПРОВЕРЯЛИСЬ/.test(askedButSkipped) && /BI-аналитик/.test(askedButSkipped));
  checkS('и запрещено утверждать про их наличие',
    /не утверждай ничего/.test(askedButSkipped));
  const notAsked = runTable(
    { urn: URN_T, search: '' }, card, colsWithSlice, null, null, null, null, undefined);
  checkS('без запроса значений блока нет', !/ЗНАЧЕНИЯ ПОЛЕЙ/.test(notAsked));
}

console.log(ddFails ? `ПРОВАЛОВ: ${ddFails}` : 'ПРОВЕРКИ ГРУПП ДОСТУПА ПРОШЛИ');
console.log('='.repeat(70));
process.exit(ddFails ? 1 : 0);
