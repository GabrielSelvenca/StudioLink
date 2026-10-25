'use strict';
// Sync de src/ com o Studio: o que foi sincronizado por último (known), backups e a junção ao reconectar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i; // nomes que o Windows não deixa criar
const hash = (src) => crypto.createHash('sha1').update(src).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Ao reconectar: Studio igual ao último sync → só o disco mudou e ele vence sozinho.
// Studio mudou → a pessoa escolhe no painel do plugin (o código não adivinha quem editou o quê).
function winner(s, d, k) {
  if (s === d) return 'iguais';
  if (s === k) return 'disco';
  return 'perguntar';
}

function createSync({ SRC, BACKUP, STATE, log, enqueue, isOnline }) {
  const known = new Map(); // caminho relativo (a/b/c.server.luau) -> conteúdo sincronizado
  // caminho -> hashes das versões já sincronizadas. Só serve pra dica "Studio com versão antiga" no painel.
  const seen = new Map();
  const undecided = new Map(); // caminho -> versão do Studio, esperando a escolha no painel

  function setKnown(rel, src) {
    known.set(rel, src);
    const list = seen.get(rel) || [];
    const h = hash(src);
    if (!list.includes(h)) { list.push(h); if (list.length > 200) list.shift(); seen.set(rel, list); }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const [k, v] of Object.entries(saved.seen || {})) seen.set(k, v);
    for (const [k, v] of Object.entries(saved.known || {})) setKnown(k, v);
  } catch {}
  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(STATE + '.tmp', JSON.stringify({ known: Object.fromEntries(known), seen: Object.fromEntries(seen) }));
        fs.renameSync(STATE + '.tmp', STATE);
      } catch (e) { log('não consegui salvar ' + STATE + ': ' + e.message); }
    }, 300);
  }

  function toAbs(rel) {
    const parts = typeof rel === 'string' ? rel.split('/') : [];
    if (!parts.length || !rel.endsWith('.luau') || rel.includes('\\') || parts.some((p) => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p) || DEVICE.test(p))) {
      throw new Error('caminho inválido: ' + rel);
    }
    return path.join(SRC, ...parts);
  }
  const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return undefined; } };

  function walk(dir, base = '') {
    let out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
      else if (e.name.endsWith('.luau')) out.push(rel);
    }
    return out;
  }
  function removeEmptyDirs(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
    if (dir !== SRC) { try { fs.rmdirSync(dir); } catch {} }
  }
  function backup(rel, tag, source) {
    const dst = path.join(BACKUP, tag, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, source);
  }

  // Disco com conteúdo que o servidor não conhece (editado fora do sync) vai pro backup antes de ser trocado.
  // Com `tag`, a versão atual vai pro backup sempre (escolha no painel).
  function writeLocal(rel, source, tag) {
    const abs = toAbs(rel);
    const cur = read(abs);
    if (cur !== source) {
      if (cur !== undefined && (tag || cur !== known.get(rel))) backup(rel, tag || stamp(), cur);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, source);
    }
    setKnown(rel, source);
    saveState();
  }
  function deleteLocal(rel) {
    const abs = toAbs(rel);
    const cur = read(abs);
    if (cur !== undefined && cur !== known.get(rel)) backup(rel, stamp(), cur);
    try { fs.unlinkSync(abs); } catch {}
    known.delete(rel);
    saveState();
    let dir = path.dirname(abs);
    while (dir.startsWith(SRC) && dir !== SRC) {
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }

  // Edição vinda do plugin (POST /sync).
  function fromStudio(body) {
    if (undecided.has(body.file)) return; // esperando a escolha no painel
    if (body.type === 'write' && typeof body.source === 'string') {
      if (known.get(body.file) !== body.source) { writeLocal(body.file, body.source); log(`Studio → disco: ${body.file}`); }
    } else if (body.type === 'delete') {
      if (known.has(body.file) || fs.existsSync(toAbs(body.file))) { deleteLocal(body.file); log(`Studio → disco: apagou ${body.file}`); }
    }
  }

  function resolveChoice(choice, files) {
    const tag = stamp();
    let n = 0;
    for (const f of files) {
      if (!undecided.has(f.file)) continue;
      const s = typeof f.source === 'string' ? f.source : undecided.get(f.file);
      undecided.delete(f.file);
      if (choice === 'studio') {
        writeLocal(f.file, s, tag);
      } else {
        const d = read(toAbs(f.file));
        if (d === undefined) continue;
        backup(f.file, tag + '/studio', s);
        setKnown(f.file, d);
        enqueue('edit', { type: 'write', file: f.file, source: d });
      }
      n++;
    }
    saveState();
    log(`escolha no Studio: ${choice === 'studio' ? 'manter o Studio' : 'usar o disco'} em ${n} scripts | a outra versão ficou em .bridge/backup/${tag}`);
    return { ok: true, resolvidos: n };
  }

  // Ao conectar: junta Studio e disco. Existe só de um lado → copia pro outro (na reconexão nada é apagado:
  // o Studio pode ser outra versão do place; apagar só sincroniza ao vivo).
  function applySnapshot(scripts) {
    undecided.clear();
    const perguntar = [];
    const S = new Map();
    for (const s of scripts) {
      try { toAbs(s.file); } catch (e) { log(`snapshot: ignorei ${s.file} (${e.message})`); continue; }
      if (typeof s.source === 'string') S.set(s.file, s.source);
    }
    const D = new Map();
    const unreadable = new Set();
    for (const rel of walk(SRC)) {
      try { D.set(rel, fs.readFileSync(toAbs(rel), 'utf8')); } catch (e) { unreadable.add(rel); log(`snapshot: não li ${rel} (${e.code || e.message}), fica de fora`); }
    }
    const files = new Set([...S.keys(), ...D.keys()]);
    const toStudio = [];
    const st = { iguais: 0, studioParaDisco: 0, discoParaStudio: 0, perguntar: 0 };
    for (const rel of files) {
      if (unreadable.has(rel)) continue;
      const s = S.get(rel), d = D.get(rel), k = known.get(rel);
      try {
        if (s !== undefined && d !== undefined) {
          const w = winner(s, d, k);
          if (w === 'iguais') { setKnown(rel, s); st.iguais++; }
          else if (w === 'disco') { setKnown(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++; }
          else {
            undecided.set(rel, s);
            perguntar.push({ file: rel, velho: (seen.get(rel) || []).includes(hash(s)) });
            st.perguntar++;
          }
        } else if (s !== undefined) {
          writeLocal(rel, s); st.studioParaDisco++;
        } else {
          setKnown(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++;
        }
      } catch (e) { log(`snapshot: falhou em ${rel}: ${e.message}`); }
    }
    for (const rel of [...known.keys()]) if (!files.has(rel)) known.delete(rel);
    for (const rel of [...seen.keys()]) if (!files.has(rel)) seen.delete(rel);
    removeEmptyDirs(SRC);
    saveState();
    for (const c of toStudio) enqueue('edit', c);
    log(`snapshot: ${S.size} no Studio, ${D.size} no disco | ` + Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') + (st.perguntar ? ' | esperando escolha no painel do Studio' : ''));
    return { ok: true, scripts: S.size, ...st, perguntar };
  }

  function pushAll() {
    const files = walk(SRC);
    for (const rel of files) {
      const src = fs.readFileSync(toAbs(rel), 'utf8');
      setKnown(rel, src);
      enqueue('edit', { type: 'write', file: rel, source: src });
    }
    return files.length;
  }

  // Com o Studio offline a mudança fica só no disco e `known` não muda: ao reconectar o disco vence sozinho.
  function syncToStudio(cmd) {
    if (!isOnline('edit')) {
      log(`Studio offline: ${cmd.file} sincroniza quando ele reconectar`);
      return false;
    }
    enqueue('edit', cmd);
    log(`disco → Studio: ${cmd.type} ${cmd.file}`);
    return true;
  }
  function onDiskChange(rel) {
    if (undecided.has(rel)) return; // esperando a escolha no painel; ela lê o disco na hora
    const abs = path.join(SRC, ...rel.split('/'));
    let stat = null;
    try { stat = fs.statSync(abs); } catch {}
    if (stat && stat.isDirectory()) { for (const f of walk(abs, rel)) onDiskChange(f); return; }
    if (!rel.endsWith('.luau')) {
      if (!stat) for (const k of [...known.keys()]) if (k.startsWith(rel + '/')) onDiskChange(k); // pasta apagada
      return;
    }
    try { toAbs(rel); } catch { return; }
    if (!stat) {
      if (known.has(rel) && syncToStudio({ type: 'delete', file: rel })) { known.delete(rel); saveState(); }
      return;
    }
    const src = read(abs);
    if (src === undefined || known.get(rel) === src) return;
    if (syncToStudio({ type: 'write', file: rel, source: src })) { setKnown(rel, src); saveState(); }
  }

  const debounce = new Map();
  function watch() {
    try {
      fs.mkdirSync(SRC, { recursive: true });
      const w = fs.watch(SRC, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = String(name).split(path.sep).join('/');
        clearTimeout(debounce.get(rel));
        debounce.set(rel, setTimeout(() => { debounce.delete(rel); onDiskChange(rel); }, 150));
      });
      w.on('error', (e) => { log(`vigia de src/ caiu (${e.code || e.message}), religando`); w.close(); setTimeout(watch, 1000); });
    } catch (e) {
      log(`não consegui vigiar src/ (${e.code || e.message}), tento de novo em 5s`);
      setTimeout(watch, 5000);
    }
  }

  return { known, undecided, toAbs, walk, setKnown, writeLocal, deleteLocal, fromStudio, resolveChoice, applySnapshot, pushAll, onDiskChange, start: watch };
}

module.exports = { createSync, winner, stamp };
