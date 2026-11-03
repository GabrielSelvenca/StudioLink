'use strict';
// node bridge/sync.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSync } = require('./sync');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiolink-sync-'));
const SRC = path.join(dir, 'src');
const BACKUP = path.join(dir, 'backup');
const sent = [];
const sync = createSync({
  SRC, BACKUP, STATE: path.join(dir, 'state.json'), log: () => {}, enqueue: (_role, c) => sent.push(c), isOnline: () => true,
});
const abs = (rel) => path.join(SRC, ...rel.split('/'));
const put = (rel, s) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), s); };
const backups = () => fs.readdirSync(BACKUP, { recursive: true })
  .filter((f) => fs.statSync(path.join(BACKUP, f)).isFile())
  .map((f) => fs.readFileSync(path.join(BACKUP, f), 'utf8'));

try {
  // só o disco mudou desde o último sync: o disco vence sem perguntar
  sync.writeLocal('A/x.luau', 'v1');
  put('A/x.luau', 'v2');
  let r = sync.applySnapshot([{ file: 'A/x.luau', source: 'v1' }]);
  assert.strictEqual(r.discoParaStudio, 1);
  assert.deepStrictEqual(sent.pop(), { type: 'write', file: 'A/x.luau', source: 'v2' });
  assert.strictEqual(sync.known.get('A/x.luau'), 'v2');

  // o Studio mudou: pergunta, e o disco fica como está até a escolha
  r = sync.applySnapshot([{ file: 'A/x.luau', source: 'v3' }]);
  assert.deepStrictEqual(r.perguntar.map((p) => p.file), ['A/x.luau']);
  assert.strictEqual(fs.readFileSync(abs('A/x.luau'), 'utf8'), 'v2');
  sync.resolveChoice('studio', [{ file: 'A/x.luau' }]);
  assert.strictEqual(fs.readFileSync(abs('A/x.luau'), 'utf8'), 'v3');
  assert.ok(backups().includes('v2'), 'a versão do disco que perdeu vai pro backup');

  // escrita que falha não marca o arquivo como sincronizado
  put('B', 'um arquivo onde devia ser pasta');
  assert.throws(() => sync.writeLocal('B/y.luau', 'novo'));
  assert.strictEqual(sync.known.has('B/y.luau'), false);

  // disco editado fora do sync vai pro backup antes de ser sobrescrito
  sync.writeLocal('C/z.luau', 'sincronizado');
  put('C/z.luau', 'editado à mão');
  sync.writeLocal('C/z.luau', 'do Studio');
  assert.strictEqual(fs.readFileSync(abs('C/z.luau'), 'utf8'), 'do Studio');
  assert.ok(backups().includes('editado à mão'));

  for (const bad of ['../x.luau', 'A/CON.luau', 'A/b:c.luau', 'A./x.luau', 'A/x.txt', 'A\\x.luau']) {
    assert.throws(() => sync.toAbs(bad), undefined, bad);
  }

  // ---------------------------------------------------------------- layout do Rojo
  const RS = 'ReplicatedStorage';
  put('ReplicatedStorage/Kit/init.luau', 'kit');
  put('ReplicatedStorage/Kit/A.lua', 'a');
  put('ReplicatedStorage/Kit/A.spec.lua', 'teste');
  put('ReplicatedStorage/Kit/Sub/B.client.lua', 'b');
  put('ServerScriptService/Main/init.server.lua', 'main');
  put('ServerScriptService/Main/Helper.luau', 'helper');
  put('ReplicatedStorage/Mod.luau', 'mod'); // o layout do StudioLink continua igual
  put('ReplicatedStorage/Mod/C.luau', 'c');
  sent.length = 0;
  sync.rescan();
  const files = sync.scan().files;
  for (const [rel, file] of [
    [`${RS}/Kit.luau`, 'ReplicatedStorage/Kit/init.luau'], // init em pasta vira o script
    [`${RS}/Kit/A.luau`, 'ReplicatedStorage/Kit/A.lua'], // .lua igual a .luau
    [`${RS}/Kit/Sub/B.client.luau`, 'ReplicatedStorage/Kit/Sub/B.client.lua'],
    ['ServerScriptService/Main.server.luau', 'ServerScriptService/Main/init.server.lua'],
    ['ServerScriptService/Main/Helper.luau', 'ServerScriptService/Main/Helper.luau'],
    [`${RS}/Mod.luau`, 'ReplicatedStorage/Mod.luau'],
    [`${RS}/Mod/C.luau`, 'ReplicatedStorage/Mod/C.luau'],
  ]) assert.strictEqual(files.get(rel), abs(file), rel);
  assert.ok(![...files.keys()].some((f) => f.includes('spec')), '.spec fica de fora');
  // pai antes do filho, senão o plugin cria uma Folder no lugar do pai
  const order = sent.map((c) => c.file);
  assert.ok(order.indexOf(`${RS}/Kit.luau`) < order.indexOf(`${RS}/Kit/A.luau`));
  assert.ok(order.indexOf(`${RS}/Kit/A.luau`) < order.indexOf(`${RS}/Kit/Sub/B.client.luau`));

  // Studio -> disco grava no arquivo que já existe
  sync.fromStudio({ type: 'write', file: `${RS}/Kit.luau`, source: 'kit 2' });
  sync.fromStudio({ type: 'write', file: `${RS}/Kit/A.luau`, source: 'a 2' });
  assert.strictEqual(fs.readFileSync(abs('ReplicatedStorage/Kit/init.luau'), 'utf8'), 'kit 2');
  assert.strictEqual(fs.readFileSync(abs('ReplicatedStorage/Kit/A.lua'), 'utf8'), 'a 2');
  assert.ok(!fs.existsSync(abs('ReplicatedStorage/Kit.luau')) && !fs.existsSync(abs('ReplicatedStorage/Kit/A.luau')));
  // script novo do Studio: layout do StudioLink (dentro de Kit/, que é a pasta dos filhos do Kit)
  sync.fromStudio({ type: 'write', file: `${RS}/Kit/Novo.luau`, source: 'novo' });
  assert.strictEqual(fs.readFileSync(abs('ReplicatedStorage/Kit/Novo.luau'), 'utf8'), 'novo');
  sync.fromStudio({ type: 'delete', file: `${RS}/Kit/Novo.luau` });
  assert.ok(!fs.existsSync(abs('ReplicatedStorage/Kit/Novo.luau')));
  sent.length = 0;
  sync.rescan();
  assert.deepStrictEqual(sent, [], 'o que veio do Studio não volta pra ele');

  // renomear/mover no Studio leva a pasta inteira, no mesmo layout; o move dos filhos depois não faz nada
  sync.fromStudio({ type: 'move', file: `${RS}/Kit.luau`, to: `${RS}/Libs/Kit2.luau`, source: 'kit 2' });
  sync.fromStudio({ type: 'move', file: `${RS}/Kit/A.luau`, to: `${RS}/Libs/Kit2/A.luau`, source: 'a 2' });
  sync.fromStudio({ type: 'move', file: `${RS}/Kit/Sub/B.client.luau`, to: `${RS}/Libs/Kit2/Sub/B.client.luau`, source: 'b' });
  assert.ok(!fs.existsSync(abs('ReplicatedStorage/Kit')));
  for (const f of ['init.luau', 'A.lua', 'A.spec.lua', 'Sub/B.client.lua']) assert.ok(fs.existsSync(abs('ReplicatedStorage/Libs/Kit2/' + f)), f);
  assert.strictEqual(sync.known.get(`${RS}/Libs/Kit2/A.luau`), 'a 2');
  assert.ok(!sync.known.has(`${RS}/Kit/A.luau`));
  sync.fromStudio({ type: 'move', file: `${RS}/Mod.luau`, to: `${RS}/Mod2.luau`, source: 'mod editado' });
  assert.strictEqual(fs.readFileSync(abs('ReplicatedStorage/Mod2.luau'), 'utf8'), 'mod editado');
  assert.ok(fs.existsSync(abs('ReplicatedStorage/Mod2/C.luau')) && !fs.existsSync(abs('ReplicatedStorage/Mod')));
  // o filho chegando antes do pai: as pastas se juntam
  sync.fromStudio({ type: 'move', file: 'ServerScriptService/Main/Helper.luau', to: 'ServerScriptService/Boot/Helper.luau', source: 'helper' });
  sync.fromStudio({ type: 'move', file: 'ServerScriptService/Main.server.luau', to: 'ServerScriptService/Boot.server.luau', source: 'main' });
  assert.ok(fs.existsSync(abs('ServerScriptService/Boot/init.server.lua')) && fs.existsSync(abs('ServerScriptService/Boot/Helper.luau')));
  assert.ok(!fs.existsSync(abs('ServerScriptService/Main')));
  // só maiúscula/minúscula (no Windows o arquivo "já existe")
  sync.fromStudio({ type: 'move', file: 'ServerScriptService/Boot.server.luau', to: 'ServerScriptService/boot.server.luau', source: 'main' });
  assert.ok(fs.readdirSync(abs('ServerScriptService')).includes('boot'));
  sync.fromStudio({ type: 'move', file: `${RS}/Mod2.luau`, to: `${RS}/mod2.luau`, source: 'mod editado' });
  assert.ok(fs.readdirSync(abs(RS)).includes('mod2.luau') && fs.readdirSync(abs(RS)).includes('mod2'));
  sent.length = 0;
  sync.rescan();
  assert.deepStrictEqual(sent, [], 'mover no Studio não ecoa de volta');

  // ---------------------------------------------------------------- Wally
  const pkg = (rel, s) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  fs.writeFileSync(path.join(dir, 'wally.toml'), '[dependencies]\n');
  pkg('Packages/Shake.lua', 'return require(script.Parent._Index["sleitnick_shake@1.1.0"]["shake"])');
  pkg('Packages/Stance.lua', 'return require(script.Parent._Index["gabrielselvenca_stance@0.1.0"]["stance"])');
  pkg('Packages/_Index/sleitnick_shake@1.1.0/shake/init.lua', 'shake');
  pkg('Packages/_Index/sleitnick_shake@1.1.0/shake/init.spec.lua', 'teste');
  pkg('Packages/_Index/sleitnick_shake@1.1.0/shake/wally.toml', '');
  pkg('Packages/_Index/sleitnick_shake@1.1.0/Trove.lua', 'return require(script.Parent.Parent["sleitnick_trove@1.8.0"]["trove"])');
  pkg('Packages/_Index/gabrielselvenca_stance@0.1.0/stance/default.project.json', '{ "name": "stance", "tree": { "$path": "src" } }');
  pkg('Packages/_Index/gabrielselvenca_stance@0.1.0/stance/src/init.luau', 'stance');
  pkg('Packages/_Index/gabrielselvenca_stance@0.1.0/stance/src/Gait.luau', 'gait');
  pkg('ServerPackages/Data.lua', 'data');
  put('ReplicatedStorage/Packages/Shake.luau', 'cópia velha em src'); // o Wally vence
  sent.length = 0;
  sync.rescan();
  const w = sync.scan().files;
  const P = `${RS}/Packages`;
  for (const [rel, file] of [
    [`${P}/Shake.luau`, 'Packages/Shake.lua'], // o link vira ModuleScript
    [`${P}/_Index/sleitnick_shake@1.1.0/shake.luau`, 'Packages/_Index/sleitnick_shake@1.1.0/shake/init.lua'],
    [`${P}/_Index/sleitnick_shake@1.1.0/Trove.luau`, 'Packages/_Index/sleitnick_shake@1.1.0/Trove.lua'], // dependência: irmã do pacote
    [`${P}/_Index/gabrielselvenca_stance@0.1.0/stance.luau`, 'Packages/_Index/gabrielselvenca_stance@0.1.0/stance/src/init.luau'], // $path
    [`${P}/_Index/gabrielselvenca_stance@0.1.0/stance/Gait.luau`, 'Packages/_Index/gabrielselvenca_stance@0.1.0/stance/src/Gait.luau'],
    ['ServerScriptService/ServerPackages/Data.luau', 'ServerPackages/Data.lua'],
  ]) assert.strictEqual(w.get(rel), path.join(dir, ...file.split('/')), rel);
  assert.ok(![...w.keys()].some((f) => f.includes('spec') || f.includes('wally')));
  assert.ok(sent.find((c) => c.file === `${P}/Shake.luau`).source.includes('_Index'));
  // editar no Studio dentro de Packages não grava no disco
  sync.fromStudio({ type: 'write', file: `${P}/_Index/sleitnick_shake@1.1.0/shake.luau`, source: 'mexido no Studio' });
  sync.fromStudio({ type: 'delete', file: `${P}/Stance.luau` });
  sync.fromStudio({ type: 'write', file: `${P}/Novo.luau`, source: 'novo' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'Packages/_Index/sleitnick_shake@1.1.0/shake/init.lua'), 'utf8'), 'shake');
  assert.ok(fs.existsSync(path.join(dir, 'Packages/Stance.lua')) && !fs.existsSync(path.join(dir, 'Packages/Novo.luau')));
  // ao reconectar o disco vence nos Packages, e o que só existe no Studio (versão velha) sai
  const studio = [...w.keys()].map((file) => ({ file, source: sync.known.get(file) }));
  studio.find((s) => s.file === `${P}/Shake.luau`).source = 'mexido';
  studio.push({ file: `${P}/_Index/sleitnick_shake@1.0.0/shake.luau`, source: 'velho' });
  sent.length = 0;
  r = sync.applySnapshot(studio);
  assert.strictEqual(r.perguntar.length, 0);
  assert.deepStrictEqual(sent.map((c) => c.type + ' ' + c.file), [`delete ${P}/_Index/sleitnick_shake@1.0.0/shake.luau`, `write ${P}/Shake.luau`]);
  // wally install de novo (shake 1.1.0 -> 1.2.0): o Studio acompanha sozinho, apagando antes de criar
  fs.rmSync(path.join(dir, 'Packages/_Index/sleitnick_shake@1.1.0'), { recursive: true });
  pkg('Packages/Shake.lua', 'return require(script.Parent._Index["sleitnick_shake@1.2.0"]["shake"])');
  pkg('Packages/_Index/sleitnick_shake@1.2.0/shake/init.lua', 'shake 2');
  sent.length = 0;
  sync.rescan();
  assert.deepStrictEqual(sent.map((c) => c.type + ' ' + c.file), [
    `delete ${P}/_Index/sleitnick_shake@1.1.0/Trove.luau`,
    `delete ${P}/_Index/sleitnick_shake@1.1.0/shake.luau`,
    `write ${P}/Shake.luau`,
    `write ${P}/_Index/sleitnick_shake@1.2.0/shake.luau`,
  ]);
  console.log('sync: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
