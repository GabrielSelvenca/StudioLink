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
  console.log('sync: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
