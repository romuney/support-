import fs from 'fs';
const core = JSON.parse(fs.readFileSync('Support Bot Core.json','utf8'));
const js = (n) => core.nodes.find(x=>x.name===n).parameters.jsCode;
const REGISTRY = fs.readFileSync('../executive-support/kb/index.md','utf8');

function runPlan(routerOutput, trigger) {
  const $ = (name) => {
    if (name === 'Decode registry') return { first: () => ({ json: { text: REGISTRY } }) };
    if (name === 'When called by adapter') return { first: () => ({ json: trigger }) };
    throw new Error('node not executed: ' + name);
  };
  return new Function('$','$json', js('Plan'))($, { output: routerOutput })[0].json;
}
function runMaterials(plan, articles=null, dd=null, trigger={}) {
  const $ = (name) => {
    if (name === 'Plan') return { first: () => ({ json: plan }) };
    if (name === 'When called by adapter') return { first: () => ({ json: trigger }) };
    if (name === 'Read article') { if (articles===null) throw new Error('ne'); return { all: () => articles.map(json=>({json})) }; }
    if (name === 'Call DD Lookup') { if (dd===null) throw new Error('ne'); return { all: () => dd.map(json=>({json})) }; }
    throw new Error('node not executed: ' + name);
  };
  return new Function('$','$json', js('Build materials'))($, {})[0].json;
}

const q = 'Подскажи, как написать select, чтобы выгрузить сотрудника и его юнит из функциональной структуры?';
const router = JSON.stringify({ domains:['headcount-structure'], articles:[], dd:[] });

for (const [label, trig] of [
  ['DM (topic_kind = вся строка, как отдаёт Guard DM)', { question:q, topic_kind:q }],
  ['CHAT (topic_kind пуст)', { question:q, topic_kind:'' }],
]) {
  const p = runPlan(router, trig);
  console.log('---', label);
  console.log('  plan.is_export     =', p.is_export);
  console.log('  plan.is_query_help =', p.is_query_help);
  console.log('  files:', p.files);
  const arts = p.files.map(f=>({ file_path:f, content: Buffer.from('# статья\ntext','utf8').toString('base64') }));
  const m = runMaterials(p, arts, null, trig);
  console.log('  materials.is_export =', m.is_export, ' mode_rules len =', (m.mode_rules||'').length);
}

// проверка: печатается ли в личке заметка о неразобранном признаке ИБ,
// которой по документации в личке быть не должно
{
  const p = runPlan(router, { question:q, topic_kind:q });
  const arts = p.files.map(f=>({ file_path:f, content: Buffer.from('x','utf8').toString('base64') }));
  const m = runMaterials(p, arts, null, { question:q, topic_kind:q, external_transfer:'' });
  console.log('заметка о неразобранном ИБ в личке:', /ПЕРЕДАЧА ВНЕ|не разобран|исключительно внутри/i.test(m.materials||''));
  const idx = (m.materials||'').indexOf('ПЕРЕДАЧ');
  console.log((m.materials||'').slice(idx-100, idx+400));
}
