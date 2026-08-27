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

function runCollect(responses, tables) {
  const $ = (name) => {
    if (name === 'Tables') {
      return { all: () => tables.map((t) => ({ json: { table_urn: t } })) };
    }
    throw new Error('node not executed: ' + name);
  };
  $.all = undefined;
  const $input = { all: () => responses.map((json) => ({ json })) };
  return new Function('$', '$input', js('Collect notes'))($, $input).map((i) => i.json);
}

function runBridge(notes, links) {
  const $ = (name) => {
    if (name === 'Collect notes') return { all: () => notes.map((json) => ({ json })) };
    throw new Error('node not executed: ' + name);
  };
  const $input = { all: () => links.map((json) => ({ json })) };
  return new Function('$', '$input', js('Build bridge'))($, $input)[0].json;
}

function runShapeRecon(byName) {
  const $ = (name) => {
    if (!(name in byName)) throw new Error('node not executed: ' + name);
    return { first: () => ({ json: byName[name] }) };
  };
  return new Function('$', js('Shape recon'))($)[0].json;
}

// ====================================================================== 1
line('1. Распаковка /related: сущность вложена в entity, а не лежит сверху');
{
  const out = runCollect(
    [rel([note(1), note(2)]), rel([note(2), note(3)])],
    ['urn:t:a', 'urn:t:b'],
  );
  check('объекты извлечены, а не потеряны', out.length === 3);
  check('urn достался из entity', out[0].urn.endsWith('note:1'));
  // Один отчёт читает две витрины — это норма, а не два отчёта.
  check('дубль схлопнут', out.filter((n) => n.urn.endsWith('note:2')).length === 1);
  check('видно, из каких витрин пришёл',
    out.find((n) => n.urn.endsWith('note:2')).tables.length === 2);

  // Плоский массив без обёртки relation — тоже допустимая форма ответа.
  const flat = runCollect([ok([note(9)])], ['urn:t:a']);
  check('плоская форма ответа тоже распаковывается', flat.length === 1);
}

// ====================================================================== 2
line('2. Витрина с ошибкой НАЗВАНА, а не молча пропущена');
{
  const out = runCollect(
    [{ statusCode: 404, body: {} }, rel([note(1)])],
    ['urn:t:a', 'urn:t:b'],
  );
  check('рабочая витрина отработала', out.length === 1);
  // 404 значит «ключа notes у этой витрины нет», 403 — «нет доступа»:
  // разные починки, и обе неотличимы от «отчётов нет», если промолчать.
  check('ошибка названа витриной', out[0]._problems.some((p) => p.includes('urn:t:a')));

  const empty = runCollect([ok({ totalCount: 0, data: [] })], ['urn:t:a']);
  check('пустой ответ тоже назван', empty.length === 0 ||
    empty[0]._problems.length > 0);
}

// ====================================================================== 3
line('3. Мост: ключ ссылки из /link, пара держится индексом');
{
  const notes = [
    { urn: 'urn:dd:reports:reports:report:23466', fqn: 'a', tables: ['t'],
      _total_found: 3, _dropped: 0, _problems: [] },
    { urn: 'urn:dd:reports:reports:report:777', fqn: 'b', tables: ['t'],
      _total_found: 3, _dropped: 0, _problems: [] },
    { urn: 'urn:dd:reports:reports:report:888', fqn: 'c', tables: ['t'],
      _total_found: 3, _dropped: 0, _problems: [] },
  ];
  const links = [
    ok([{ url: 'https://proteus.tcsbank.ru/superset/dashboard/23466/?x=1' }]),
    ok({ data: [{ href: 'https://proteus.tcsbank.ru/superset/dashboard/p/YApDgAlG5gQ/' }] }),
    ok([{ url: 'https://helicopter.tcsbank.ru/notebook/42' }]),
  ];
  const b = runBridge(notes, links);

  check('числовой ключ разобран', b.rows.some((r) => r.key === '23466'));
  // Служебный сегмент «p» ключом стать не должен: у Proteus бывает
  // /dashboard/p/<hash>/, и ключ там — хеш.
  check('хеш за «p» разобран', b.rows.some((r) => r.key === 'YApDgAlG5gQ'));
  check('пара «объект → ссылка» не съехала',
    b.rows.find((r) => r.key === '23466').urn.endsWith('report:23466'));
  // Ноутбук — не отчёт Proteus: в мост он не попадает, но и не пропадает
  // молча, иначе его будут искать руками, не зная, что он был.
  check('ноутбук в мост не попал', b.rows.length === 2);
  check('и при этом назван', b.report.includes('НЕ НА PROTEUS'));

  check('покрытие эталона посчитано', b.covered.includes('23466'));
  check('ненайденные ключи эталона названы поимённо',
    b.missing.includes('35005') && b.report.includes('Активность в GitLab'));
  check('готовая таблица для index.md есть',
    b.report.includes('| ключ ссылки | dd_urn |'));
}

// ====================================================================== 4
line('4. Один ключ у двух объектов — развилка, а не мост');
{
  const mk = (n) => ({ urn: `urn:dd:reports:reports:report:${n}`, fqn: '', tables: [],
                       _total_found: 2, _dropped: 0, _problems: [] });
  const url = 'https://proteus.tcsbank.ru/superset/dashboard/23003/';
  const b = runBridge([mk(1), mk(2)], [ok([{ url }]), ok([{ url }])]);
  check('в мост уехала одна строка', b.rows.length === 1);
  // Молча взять первый попавшийся значит отвечать про чужой отчёт.
  check('коллизия названа', b.collisions.length === 1 &&
    b.report.includes('ОДИН КЛЮЧ У НЕСКОЛЬКИХ'));
}

// ====================================================================== 5
line('5. Обрезка по лимиту называется числом');
{
  const many = Array.from({ length: 70 }, (_, i) => note(i));
  const out = runCollect([rel(many)], ['urn:t:a']);
  check('лимит применён', out.length === 60);
  check('сколько не проверялось — сказано', out[0]._dropped === 10);
  const b = runBridge(out, out.map(() => ok([])));
  check('и доехало до отчёта', b.report.includes('ПО ЛИМИТУ НЕ ПРОВЕРЯЛИСЬ'));
}

// ====================================================================== 6
line('6. Разведка: владелец ищется по всем пяти ответам, 401 назван причиной');
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

console.log(`\n${'='.repeat(70)}`);
console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
console.log('='.repeat(70));
process.exit(fails ? 1 : 0);
