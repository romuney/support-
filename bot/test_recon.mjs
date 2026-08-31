// Прогон Code-нод «DD Recon.json» на подставных ответах каталога.
//
// Воркфлоу одноразовый, но его Code-ноды делают ровно то, на чём этот проект
// уже обжигался: распаковывают ответ /related/{key} (сущность вложена
// в entity — на верхнем уровне лежит связь) и держат пару «объект ↔ его
// ответ» ИНДЕКСОМ. Оба промаха дают не ошибку, а ПУСТОЙ результат, который
// читается как «отчётов в каталоге нет». Проверять это глазами по JSON
// бесполезно — нужен прогон.
//
// Запуск: node test_recon.mjs
import fs from 'fs';

const wf = JSON.parse(fs.readFileSync('DD Recon.json', 'utf8'));
const js = (n) => {
  const node = wf.nodes.find((x) => x.name === n);
  if (!node) throw new Error(`нет ноды ${n}`);
  return node.parameters.jsCode;
};

let fails = 0;
const check = (label, cond) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
};
const line = (t) => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

// Ответ каталога в том виде, в каком он приходит с fullResponse: true.
const ok = (body) => ({ statusCode: 200, body });
const rel = (entities) => ok({
  totalCount: entities.length,
  data: entities.map((e) => ({ relationId: 'r', entity: e })),
});
const note = (n) => ({ urn: `urn:dd:reports:helicopter:note:${n}`, type: 'NOTE',
                       fqn: `reports.helicopter.${n}` });

function runShapeRecon(byName) {
  const $ = (name) => {
    if (!(name in byName)) throw new Error('node not executed: ' + name);
    return { first: () => ({ json: byName[name] }) };
  };
  return new Function('$', js('Shape recon'))($)[0].json;
}

// Группы про мост удалены вместе с фазами B и F: обе оказались
// несостоятельны — от витрины к дашборду в каталоге пути нет, а перечисление
// отчётов бессмысленно, потому что в DD лежат отчёты всех команд компании,
// это десятки тысяч, и разреза по домену у нас нет. Пары «ключ → urn»
// выписывает человек, машинно то же делается поиском ПО НАЗВАНИЮ.
// Подробности — в заголовке build_dd_recon.py.
line('1. Разведка: владелец ищется по всем пяти ответам, 401 назван причиной');
{
  const r = runShapeRecon({
    'Recon related': ok({ columns: {} }),
    'Recon summary': ok({ data: 'Детальные списки' }),
    'Recon attribute': ok({ owner: { type: 'text', data: 'i.ivanov' } }),
    'Recon markdown': ok({ blocks: [] }),
    'Recon link': ok([{ url: 'https://proteus.tcsbank.ru/superset/dashboard/1/' }]),
  });
  check('владелец найден и назван путём',
    r.owner_hits.some((h) => h.includes('owner') && h.includes('i.ivanov')));
  // Значение атрибута — обёртка { type, data }: без распаковки владелец
  // уехал бы строкой «[object Object]», как однажды уехал тип поля.
  check('обёртка attribute распакована',
    r.owner_hits.some((h) => h.endsWith('i.ivanov')));
  check('эталон напечатан рядом', r.report.includes('Aliya Kolomeets'));

  const dead = runShapeRecon({
    'Recon related': { statusCode: 401, body: {} },
    'Recon summary': ok({}),
    'Recon attribute': ok({}),
    'Recon markdown': ok({}),
    'Recon link': ok({}),
  });
  check('401 назван истёкшим Service Account',
    dead.report.includes('истёк Service Account'));
  check('владельца нет — сказано прямо, без выдумки',
    dead.report.includes('ВЛАДЕЛЬЦА НЕ ВИДНО'));

  // Страница логина приходит как 200 с HTML: followRedirects выключен
  // именно от этого, но если пришло — назвать причину, а не «странный ответ».
  const html = runShapeRecon({
    'Recon related': ok('<!DOCTYPE ml><html>lohtgin</html>'),
    'Recon summary': ok({}), 'Recon attribute': ok({}),
    'Recon markdown': ok({}), 'Recon link': ok({}),
  });
  check('HTML опознан как страница логина',
    html.report.includes('страницу логина'));
}

// ====================================================================== 5
line('2. ФАЗА D: три пробы Trino разбираются и НЕ сливаются в один диагноз');
{
  // Главное, ради чего фаза написана: «витрины нет в Trino» обязано
  // отличаться от «таких значений нет». Слитые в один диагноз, они отправят
  // чинить не то — ровно как ddFailed и ddMissing до 2026-08-27.
  const runValues = (byName) => {
    const $ = (name) => {
      if (!(name in byName)) throw new Error('node not executed: ' + name);
      return { all: () => byName[name].map((json) => ({ json })) };
    };
    return new Function('$', js('Shape values'))($)[0].json.values_recon;
  };

  // Всё отработало: значения пришли.
  const ok = runValues({
    'Probe catalogs': [{ Catalog: 'dl' }, { Catalog: 'gp' }],
    'Probe values': [{ emp_specialization_desc: 'Бизнес-аналитик BI', cnt: 42 },
                     { emp_specialization_desc: 'Системный аналитик', cnt: 17 }],
    'Probe missing': [{ error: 'line 1:15: Table … does not exist' }],
  });
  check('значения показаны', ok.includes('Бизнес-аналитик BI'));
  check('число строк названо', /Probe values: 2 строк/.test(ok));
  check('отказ промаха назван отказом', /Probe missing: ОТКАЗ/.test(ok));
  check('каталоги показаны', ok.includes('Probe catalogs: 2 строк'));

  // Витрина недоступна: и запрос, и промах отказали. Это тот случай,
  // ради которого промах и стоит в цепочке — сравнить тексты.
  const denied = runValues({
    'Probe catalogs': [{ Catalog: 'dl' }],
    'Probe values': [{ error: 'Schema prod_v_emart does not exist' }],
    'Probe missing': [{ error: 'line 1:15: Table … does not exist' }],
  });
  check('отказ по витрине назван отказом', /Probe values: ОТКАЗ/.test(denied));
  check('текст отказа сохранён целиком',
    denied.includes('Schema prod_v_emart does not exist'));
  check('сказано, что делать при отказе',
    denied.includes('дело') && denied.includes('префиксе каталога'));
  check('сказано сравнить два отказа между собой',
    /Сравните текст отказа/.test(denied));

  // Пустой результат — НЕ отказ. Разница принципиальная: «значений нет»
  // и «витрины нет» чинятся в разных местах.
  const empty = runValues({
    'Probe catalogs': [{ Catalog: 'dl' }],
    'Probe values': [],
    'Probe missing': [{ error: 'does not exist' }],
  });
  check('пустой результат не назван отказом',
    /Probe values: ноль элементов/.test(empty) && !/Probe values: ОТКАЗ/.test(empty));

  // Узел не выполнялся вовсе — третий, отдельный случай.
  const notRun = runValues({
    'Probe catalogs': [{ Catalog: 'dl' }],
    'Probe values': [],
  });
  check('невыполненный узел назван отдельно',
    /Probe missing: узел не выполнялся/.test(notRun));
}

// ====================================================================== 6
line('3. ФАЗА E: связи таблицы, источники отчёта, форма поиска');
{
  const mk = (json) => ({ first: () => ({ json }) });
  const runProbes = (byName) => {
    const $ = (name) => {
      if (!(name in byName)) throw new Error('node not executed: ' + name);
      return mk(byName[name]);
    };
    return new Function('$', js('Shape probes'))($)[0].json.probes;
  };
  const ok200 = (body) => ({ statusCode: 200, body });

  // Прогон 2026-08-27: мост через `notes` дал 0 пар из 1782, и все проверенные
  // оказались ноутбуками Helicopter. Связь `notes` по построению отдаёт тип
  // NOTE, а дашборды Proteus это REPORT — дело не в лимите. Какая связь
  // отдаёт REPORT, надо УЗНАТЬ, а не угадать: ключи таблицы мы ни разу
  // не запрашивали, они взяты из документации, и `notes` оттуда же.
  const out = runProbes({
    'Table related': ok200({
      columns: { entity: { type: 'COLUMN', system: 'tables.greenplum' } },
      notes: { entity: { type: 'NOTE', system: 'reports.helicopter' } },
      consumers: { entity: { type: 'REPORT', system: 'reports.reports' } },
    }),
    'Report sources': ok200({ data: [{ entity: { fqn: 'emart.mdm_employee_structure_d' } }] }),
    'Search base': ok200([{ urn: 'urn:a' }]),
    'Search text': ok200([{ urn: 'urn:b' }]),
    'Search searchText': ok200([{ urn: 'urn:a' }]),
    'Search by slug': ok200([]), 'Search by id': ok200([]),
    'Search reports': ok200([]), 'Search reports p2': ok200([]),
  });
  check('связь, отдающая REPORT, названа', /ОТДАЮТ REPORT.*consumers/.test(out));
  check('типы всех связей показаны', /notes: type=NOTE/.test(out));
  check('источник отчёта показан', out.includes('mdm_employee_structure_d'));
  // Поиск отвечает 200 на любое тело и о неизвестных полях молчит — значит
  // рабочее поле опознаётся только тем, что выдача ОТЛИЧАЕТСЯ от базовой.
  check('рабочее поле поиска опознано',
    /поле «text» РАБОТАЕТ/.test(out));
  check('нерабочее поле названо игнорируемым',
    /поле «searchText» игнорируется/.test(out));

  // Перечисление: фильтр по спецификации и пагинация через offset.
  const enumOk = runProbes({
    'Table related': ok200({}), 'Report sources': ok200({ data: [] }),
    'Search base': ok200([]), 'Search text': ok200([]), 'Search searchText': ok200([]),
    'Search by slug': ok200([]), 'Search by id': ok200([]),
    'Search reports': ok200([{ urn: 'urn:dd:reports:reports:report:a' },
                            { urn: 'urn:dd:reports:reports:report:b' }]),
    'Search reports p2': ok200([{ urn: 'urn:dd:reports:reports:report:c' }]),
  });
  check('фильтр признан рабочим, когда пришли только дашборды',
    /фильтр по systemType\/systemName\/type РАБОТАЕТ/.test(enumOk));
  check('offset признан рабочим по НОВЫМ урнам', /offset РАБОТАЕТ/.test(enumOk));

  // Вторая страница повторяет первую — это не пагинация.
  const enumDup = runProbes({
    'Table related': ok200({}), 'Report sources': ok200({ data: [] }),
    'Search base': ok200([]), 'Search text': ok200([]), 'Search searchText': ok200([]),
    'Search by slug': ok200([]), 'Search by id': ok200([]),
    'Search reports': ok200([{ urn: 'urn:dd:reports:reports:report:a' }]),
    'Search reports p2': ok200([{ urn: 'urn:dd:reports:reports:report:a' }]),
  });
  check('повтор страницы не выдан за пагинацию',
    /повторяет первую/.test(enumDup) && !/offset РАБОТАЕТ/.test(enumDup));

  // Чужие типы в выдаче — фильтр не сработал, и это надо сказать.
  const enumDirty = runProbes({
    'Table related': ok200({}), 'Report sources': ok200({ data: [] }),
    'Search base': ok200([]), 'Search text': ok200([]), 'Search searchText': ok200([]),
    'Search by slug': ok200([]), 'Search by id': ok200([]),
    'Search reports': ok200([{ urn: 'urn:dd:reports:reports:report:a' },
                             { urn: 'urn:dd:tables:greenplum:table:x' }]),
    'Search reports p2': ok200([]),
  });
  check('чужие типы в выдаче названы',
    /фильтр не сработал/.test(enumDirty));

  // Поиск по ключу ссылки — от него зависит, нужен ли мост вообще.
  const byKey = runProbes({
    'Table related': ok200({}), 'Report sources': ok200({ data: [] }),
    'Search base': ok200([]), 'Search text': ok200([]), 'Search searchText': ok200([]),
    'Search by slug': ok200([{ urn: 'urn:dd:reports:reports:report:1728' }]),
    'Search by id': ok200([{ urn: 'urn:dd:tables:greenplum:table:x' }]),
    'Search reports': ok200([]), 'Search reports p2': ok200([]),
  });
  check('найденный по слагу отчёт снимает нужду в мосте',
    /НАЙДЕН нужный отчёт/.test(byKey) && /Мост не нужен/.test(byKey));
  check('ненайденный по числу — мост нужен',
    /нужного отчёта в выдаче НЕТ/.test(byKey));

  // Ни одна связь не отдаёт REPORT — от витрины к дашборду пути нет,
  // и это тоже ответ, а не пустота.
  const noRep = runProbes({
    'Table related': ok200({ columns: { entity: { type: 'COLUMN' } } }),
    'Report sources': ok200({ data: [] }),
    'Search base': ok200([]), 'Search text': ok200([]), 'Search searchText': ok200([]),
    'Search by slug': ok200([]), 'Search by id': ok200([]),
    'Search reports': ok200([]), 'Search reports p2': ok200([]),
  });
  check('отсутствие связи к REPORT названо', /НИ ОДНА связь/.test(noRep));
  check('пустые source_tables названы', /связь есть, но не заполнена/.test(noRep));

  // Переносы строк должны быть НАСТОЯЩИМИ. Дважды за сессию сборщик писал
  // литерал \n вместо переноса, и вывод склеивался в одну строку: JS при
  // этом парсится, тесты по подстрокам зелёные, а читать невозможно.
  check('переносы строк настоящие, а не литерал',
    out.includes('\n') && !out.includes('\\n'));
}

// ====================================================================== 7
line('4. КАЖДАЯ Code-нода флоу парсится как JavaScript');
{
  // Четыре раза за сессию сборщик писал в JS литерал \\n вместо переноса
  // или, наоборот, ронял экранирование — и нода переставала парситься.
  // Ловилось это только случайным прогоном конкретной ноды: тесты гоняют
  // отдельные шейперы, а те, до которых руки не дошли, уезжали в n8n
  // сломанными и падали уже там.
  //
  // Проверка тупая и потому надёжная: взять КАЖДУЮ Code-ноду собранного
  // флоу и скормить её new Function. Синтаксис ловится целиком, независимо
  // от того, есть ли на ноду отдельный тест.
  const codeNodes = wf.nodes.filter((n) => n.type.endsWith('.code'));
  check('Code-ноды в флоу есть', codeNodes.length > 0);
  for (const n of codeNodes) {
    let err = '';
    try { new Function('$', '$input', '$json', n.parameters.jsCode); }
    catch (e) { err = e.message; }
    check(`${n.name} парсится${err ? ' — ' + err : ''}`, !err);
  }
}

console.log(`\n${'='.repeat(70)}`);
// ====================================================================== 8
line('8. ФАЗА G: URN ИЗ РЕЕСТРА ПОБЕЖДАЕТ РАНГ ВЫДАЧИ');
{
  const shape = js('Shape urns');
  const run = (asked, res) => new Function('$', '$json', shape)(
    (n) => {
      if (n === 'Tables to resolve') return { all: () => asked.map((json) => ({ json })) };
      if (n === 'Search table') return { all: () => res.map((json) => ({ json })) };
      throw new Error('node not executed: ' + n);
    }, {})[0].json.report;

  const ASK = { urn: 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d',
                fqn: 'emart.mdm_employee_structure_d', name: 'mdm_employee_structure_d' };

  // Одна таблица лежит в каталоге под ДВУМЯ системами, и поиск ранжирует
  // dlh выше. Первый прогон 2026-08-31 на этом предложил заменить
  // единственный подтверждённый URN, с которого приезжают 267 колонок.
  const both = run([ASK], [{ body: { data: [
    { urn: 'urn:dd:tables:dlh:table:emart.mdm_employee_structure_d',
      fqn: 'emart.mdm_employee_structure_d' },
    { urn: 'urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d',
      fqn: 'emart.mdm_employee_structure_d' },
  ] } }]);
  check('URN из реестра признан подтверждённым, а не заменён',
    /Подтверждены как есть \(1\)/.test(both) &&
    !/в реестре: urn:dd:tables:greenplum/.test(both));

  // А когда в реестре записан URN, которого в выдаче нет вовсе, — кандидаты
  // печатаются ВСЕ, и выбирает человек: код не имеет права заменять URN,
  // который может оказаться рабочим, на непроверенный.
  const other = run([ASK], [{ body: { data: [
    { urn: 'urn:dd:tables:dlh:table:emart.mdm_employee_structure_d',
      fqn: 'emart.mdm_employee_structure_d' },
    { urn: 'urn:dd:tables:iceberg:table:emart.mdm_employee_structure_d',
      fqn: 'emart.mdm_employee_structure_d' },
  ] } }]);
  check('оба кандидата названы', /tables:dlh/.test(other) && /tables:iceberg/.test(other));
  check('и сказано, что выбирает человек', /выбирает ЧЕЛОВЕК/.test(other));
  check('подтверждённым это не считается', !/Подтверждены как есть/.test(other));

  // Совпадение по имени таблицы, но НЕ по схеме — отдельный диагноз:
  // схема в каталоге записана иначе, чем в Trino.
  const bySchema = run([ASK], [{ body: { data: [
    { urn: 'urn:dd:tables:dlh:table:hrmart.mdm_employee_structure_d',
      fqn: 'hrmart.mdm_employee_structure_d' },
  ] } }]);
  check('чужая схема не выдаётся за совпадение',
    /точного совпадения нет, но по имени таблицы есть/.test(bySchema));

  const none = run([ASK], [{ body: { data: [] } }]);
  check('пустая выдача названа своим диагнозом',
    /в каталоге не нашлось/.test(none));
  const bad = run([ASK], [{ statusCode: 500 }]);
  check('отказ запроса — не «не нашлось»', /HTTP 500/.test(bad));
}

// ====================================================================== 9
line('9. ФАЗА H: ДВЕ РЕГИСТРАЦИИ РЯДОМ, СРАВНЕНИЕ И ЕСТЬ ОТВЕТ');
{
  const shape = js('Shape probe table');
  // Ответы каталога по обеим системам. null = узел не выполнялся.
  const run = (byNode) => new Function('$', '$json', shape)(
    (n) => {
      if (!(n in byNode)) throw new Error('node not executed: ' + n);
      const v = byNode[n];
      if (v === null) throw new Error('node not executed: ' + n);
      return { first: () => ({ json: v }) };
    }, {})[0].json.report;

  const OK = (b) => ({ statusCode: 200, body: b });
  const cols = (n) => OK({ totalCount: n,
    data: Array.from({ length: n }, (_, i) => ({ entity: { fqn: 'x.y.c' + i } })) });

  // Колонки есть у одной регистрации и нет у другой — значит в реестре
  // записана не та, и чинится строка kb/index.md.
  const oneSided = run({
    'H greenplum related': OK({ notes: {}, terms: {} }),
    'H greenplum columns': { statusCode: 404 },
    'H greenplum summary': OK({ data: 'дети' }),
    'H dlh related': OK({ columns: {}, notes: {} }),
    'H dlh columns': cols(12),
    'H dlh summary': OK({ data: 'дети' }),
  });
  check('видно, что у greenplum ключа columns НЕТ',
    /--- greenplum ---[\s\S]*есть ли «columns»: НЕТ/.test(oneSided));
  check('и что у dlh он ЕСТЬ',
    /--- dlh ---[\s\S]*есть ли «columns»: ДА/.test(oneSided));
  check('число колонок названо', /totalCount: 12/.test(oneSided));
  check('и отказ по ключу назван кодом, а не «колонок нет»',
    /\/related\/columns → HTTP 404/.test(oneSided));

  // Сущность есть, связей нет вовсе — единственный случай, когда описаний
  // полей действительно не будет.
  const noRel = run({
    'H greenplum related': OK({}),
    'H greenplum columns': OK({ totalCount: 0, data: [] }),
    'H greenplum summary': OK({ data: 'дети' }),
    'H dlh related': { statusCode: 404 },
    'H dlh columns': { statusCode: 404 },
    'H dlh summary': { statusCode: 404 },
  });
  check('пустой /related назван пустым, а не отказом',
    /\/related        → ключи: \(пусто\)/.test(noRel));
  check('несуществующая регистрация названа кодом',
    /--- dlh ---[\s\S]*\/related        → HTTP 404/.test(noRel));
  check('и в отчёте написано, как это читать', /ЧИТАТЬ ТАК:/.test(noRel));

  // Невыполнившийся узел не должен ронять шейпер: прогон бывает частичным.
  const partial = run({
    'H greenplum related': null, 'H greenplum columns': null,
    'H greenplum summary': null, 'H dlh related': null,
    'H dlh columns': null, 'H dlh summary': null,
  });
  check('невыполнившиеся узлы шейпер переживает', /ФАЗА H/.test(partial));
}

// ===================================================================== 10
line('10. ФАЗА I: ГДЕ ЛЕЖИТ ПРИЗНАК ЧУВСТВИТЕЛЬНОСТИ');
{
  const shape = js('Shape sensitivity');
  const run = (byNode) => new Function('$', '$json', shape)(
    (n) => {
      if (!(n in byNode)) throw new Error('node not executed: ' + n);
      if (byNode[n] === null) throw new Error('node not executed: ' + n);
      return { first: () => ({ json: byNode[n] }) };
    }, {})[0].json.report;

  const OK = (b) => ({ statusCode: 200, body: b });
  const base = {
    'I summary': OK({ data: 'Дата рождения ребёнка' }),
    'I attribute': OK({ column_type: { data: 'date' }, keys: { data: ['PK'] } }),
    'I tag': OK([{ name: 'EMP_SENS', type: 'sensitivity' }]),
    'I markdown': OK({}), 'I link': OK({}), 'I table': OK({}),
    'I code': OK({}), 'I related': OK({ columns: {} }), 'I history': OK([]),
  };
  const r = run(base);
  // Признак ищется ПО ЗНАЧЕНИЮ, а не по имени ключа: имени мы как раз
  // и не знаем — угадывание по нему уже стоило суток.
  check('признак найден там, где он есть', /ПРИЗНАК НАЙДЕН В: tag/.test(r));
  check('и напечатан кусок ответа, чтобы имя ключа было видно',
    /EMP_SENS/.test(r) && /sensitivity/.test(r));
  check('ресурсы без признака названы «нет»', /\/attribute\s+→ нет/.test(r));
  check('ключи каждого ресурса перечислены', /ключи: column_type, keys/.test(r));

  // Ничего не нашлось — это тоже ответ, и он не должен звучать как отказ.
  const none = run({ ...base, 'I tag': OK([]) });
  check('пусто — сказано прямо, без догадок',
    /ПРИЗНАКА НЕТ НИ В ОДНОМ/.test(none));
  check('и назван честный вывод: запрет на ПДн по смыслу поля',
    /по смыслу поля, а не по каталогу/.test(none));

  const bad = run({ ...base, 'I tag': { statusCode: 404 } });
  check('отказ ручки назван кодом, а не «признака нет»',
    /\/tag\s+→ HTTP 404/.test(bad));
  const partial = run({ ...base, 'I tag': null });
  check('невыполнившийся узел шейпер переживает', /ФАЗА I/.test(partial));
}

console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(fails ? 1 : 0);
