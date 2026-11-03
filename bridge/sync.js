'use strict';
// Sync de src/ (e dos Packages do Wally) com o Studio: o que foi sincronizado por último (known), backups e a
// junção ao reconectar.
//
// O plugin fala em caminhos do Studio ("ReplicatedStorage/Kit.luau" = ModuleScript Kit, "Kit/A.luau" = filho
// dele). No disco o mesmo script pode estar em mais de um layout, e o scan() traduz:
//   Kit.luau + pasta Kit/          layout do StudioLink
//   Kit/init.luau (ou init.lua, init.server.luau, init.client.luau): layout do Rojo, o resto da pasta é filho
//   .lua vale igual a .luau; *.spec.lua(u) fica de fora (testes)
//   pasta com default.project.json: o tree.$path dele é a instância (pacotes do Wally)
// Com wally.toml no projeto, Packages/ aparece em ReplicatedStorage.Packages e ServerPackages/ em
// ServerScriptService.ServerPackages. Esses são só leitura: o wally install sobrescreve, então edição no Studio
// lá dentro não vai pro disco (só avisa no log) e, ao reconectar, o disco vence.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i; // nomes que o Windows não deixa criar
const hash = (src) => crypto.createHash('sha1').update(src).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const WALLY = [['Packages', 'ReplicatedStorage/Packages'], ['ServerPackages', 'ServerScriptService/ServerPackages']];
const depth = (rel) => rel.split('/').length;
const instOf = (rel) => rel.replace(/(\.server|\.client)?\.luau$/, ''); // "A/B.server.luau" -> "A/B"

// "Gait.luau" -> { name: 'Gait', kind: '' }, "init.server.lua" -> { name: 'init', kind: '.server' }; não é script -> null
function scriptName(file) {
  const m = /^(.+?)(\.server|\.client)?\.luau?$/.exec(file);
  if (!m || m[1].endsWith('.spec')) return null;
  return { name: m[1], kind: m[2] || '' };
}

// Ao reconectar: Studio igual ao último sync → só o disco mudou e ele vence sozinho.
// Studio mudou → a pessoa escolhe no painel do plugin (o código não adivinha quem editou o quê).
function winner(s, d, k) {
  if (s === d) return 'iguais';
  if (s === k) return 'disco';
  return 'perguntar';
}

// Pro plugin: apagar do mais fundo pro mais raso, depois gravar do pai pro filho.
function ordered(cmds) {
  const del = cmds.filter((c) => c.type === 'delete').sort((a, b) => depth(b.file) - depth(a.file));
  const put = cmds.filter((c) => c.type !== 'delete').sort((a, b) => depth(a.file) - depth(b.file));
  return del.concat(put);
}

function createSync({ SRC, ROOT = path.dirname(SRC), BACKUP, STATE, log, enqueue, isOnline }) {
  const known = new Map(); // caminho no Studio (a/b/c.server.luau) -> conteúdo sincronizado
  // caminho -> hashes das versões já sincronizadas. Só serve pra dica "Studio com versão antiga" no painel.
  const seen = new Map();
  const undecided = new Map(); // caminho -> versão do Studio, esperando a escolha no painel
  const warned = new Set();
  const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); log(msg); } };

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

  // Valida o caminho do Studio e devolve onde ele fica no layout do StudioLink.
  function toAbs(rel) {
    const parts = typeof rel === 'string' ? rel.split('/') : [];
    if (!parts.length || !rel.endsWith('.luau') || rel.includes('\\') || parts.some((p) => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p) || DEVICE.test(p))) {
      throw new Error('caminho inválido: ' + rel);
    }
    return path.join(SRC, ...parts);
  }
  const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return undefined; } };
  const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

  // ---------------------------------------------------------------- disco -> caminhos do Studio
  // ponytail: varre tudo a cada mudança (lê todos os scripts); cache por mtime se um projeto ficar grande demais.
  let map = null; // { files: caminho -> arquivo, dirs: instância -> pasta dos filhos, readOnly: [{ wire, exists }] }
  function scan() {
    const files = new Map();
    const dirs = new Map();
    const readOnly = [];
    const add = (rel, abs) => {
      const zone = readOnly.find((z) => rel.startsWith(z.wire + '/'));
      if (zone && abs.startsWith(SRC + path.sep)) return warnOnce(`src/${zone.wire} ficou de fora: com wally.toml os pacotes vêm da pasta do Wally`);
      if (files.has(rel)) return warnOnce(`dois arquivos viram o mesmo script ${rel}: usei ${files.get(rel)}, ignorei ${abs}`);
      files.set(rel, abs);
    };
    // A pasta `dir` guarda os filhos da instância `base` ('' = raiz do src).
    function children(dir, base) {
      if (base && !dirs.has(base)) dirs.set(base, dir);
      const entries = list(dir).sort((a, b) => (a.isDirectory() - b.isDirectory()) || (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const rel = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) node(path.join(dir, e.name), rel);
        else {
          const s = scriptName(e.name);
          if (s && !(base && s.name === 'init')) add(`${base ? base + '/' : ''}${s.name}${s.kind}.luau`, path.join(dir, e.name));
        }
      }
    }
    // A pasta `dir` é a instância `rel`: Folder, ou o script do init (Rojo), ou o $path do default.project.json.
    function node(dir, rel) {
      let target = dir;
      const project = path.join(dir, 'default.project.json');
      if (fs.existsSync(project)) {
        try {
          const p = JSON.parse(fs.readFileSync(project, 'utf8')).tree.$path;
          if (typeof p === 'string') target = path.resolve(dir, p);
        } catch (e) { warnOnce(`não li ${project} (${e.message}), uso a pasta`); }
      }
      let st = null;
      try { st = fs.statSync(target); } catch { return; }
      if (st.isFile()) {
        const s = scriptName(path.basename(target));
        if (s) add(`${rel}${s.kind}.luau`, target);
        return;
      }
      const init = list(target).find((e) => e.isFile() && (scriptName(e.name) || {}).name === 'init');
      if (init) add(`${rel}${scriptName(init.name).kind}.luau`, path.join(target, init.name));
      children(target, rel);
    }
    if (fs.existsSync(path.join(ROOT, 'wally.toml'))) {
      for (const [dir, wire] of WALLY) {
        const abs = path.join(ROOT, dir);
        readOnly.push({ wire, exists: fs.existsSync(abs) });
        children(abs, wire); // antes do src/: o Wally vence uma cópia antiga em src/ReplicatedStorage/Packages
      }
    }
    children(SRC, '');
    return { files, dirs, readOnly };
  }
  const getMap = () => map || (map = scan());
  const zoneOf = (rel) => getMap().readOnly.find((z) => rel.startsWith(z.wire + '/'));
  const lookup = (rel) => getMap().files.get(rel);
  const dirOf = (inst) => getMap().dirs.get(inst) || path.join(SRC, ...inst.split('/'));
  // "A/B/c.luau" -> c.luau dentro da pasta dos filhos de A/B (que num pacote pode ser o $path do projeto)
  const place = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? path.join(SRC, rel) : path.join(dirOf(rel.slice(0, i)), rel.slice(i + 1)); };
  // Onde gravar: o arquivo que já existe (init.luau, .lua...) ou, se é novo, o layout do StudioLink.
  const target = (rel) => { toAbs(rel); return lookup(rel) || place(rel); };

  function removeEmptyDirs(dir) {
    for (const e of list(dir)) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
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
    if (zoneOf(rel)) { warnOnce(`${rel} é do Wally: edição no Studio não vai pro disco (o wally install sobrescreve)`); return false; }
    if (!lookup(rel) && /\/init(\.server|\.client)?\.luau$/.test(rel)) { warnOnce(`${rel}: script chamado init não vai pro disco (lá init.luau é o próprio pai)`); return false; }
    const abs = target(rel);
    const cur = read(abs);
    if (cur !== source) {
      if (cur !== undefined && (tag || cur !== known.get(rel))) backup(rel, tag || stamp(), cur);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, source);
      map = null;
    }
    setKnown(rel, source);
    saveState();
    return true;
  }
  function deleteLocal(rel) {
    if (zoneOf(rel)) { warnOnce(`${rel} é do Wally: apagar no Studio não apaga no disco`); return; }
    const abs = target(rel);
    const cur = read(abs);
    if (cur !== undefined && cur !== known.get(rel)) backup(rel, stamp(), cur);
    try { fs.unlinkSync(abs); } catch {}
    map = null;
    known.delete(rel);
    saveState();
    let dir = path.dirname(abs);
    while (dir.startsWith(SRC) && dir !== SRC) {
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }

  // Move `src` pra `dst`; se `dst` já é uma pasta, junta o conteúdo (os filhos às vezes chegam antes do pai).
  function moveInto(src, dst) {
    const a = fs.statSync(src);
    const b = fs.statSync(dst, { throwIfNoEntry: false });
    if (!b || a.ino === b.ino) { // ino igual: só mudou maiúscula/minúscula (Kit -> kit no Windows)
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    } else if (a.isDirectory() && b.isDirectory()) {
      for (const e of fs.readdirSync(src)) moveInto(path.join(src, e), path.join(dst, e));
      try { fs.rmdirSync(src); } catch {}
    } else {
      log(`mover: ${dst} já existe, ${src} ficou onde estava`);
    }
  }

  // Renomear/mover no Studio: o arquivo e a pasta dos filhos vão juntos, no layout em que já estavam.
  function moveLocal(from, to, source) {
    toAbs(from); toAbs(to);
    const abs = lookup(from);
    if (!abs || zoneOf(from) || zoneOf(to) || lookup(to)) {
      if (known.has(from) || fs.existsSync(target(from))) deleteLocal(from);
      if (typeof source === 'string' && known.get(to) !== source) writeLocal(to, source);
      return;
    }
    const a = instOf(from), b = instOf(to);
    const kids = getMap().dirs.get(a);
    const newDir = place(b);
    const init = kids && path.dirname(abs) === kids && scriptName(path.basename(abs)).name === 'init';
    if (init) {
      moveInto(kids, newDir); // Kit/init.luau: a pasta é o script
    } else {
      // Kit.server.lua -> Novo.server.lua (a extensão fica), e a pasta Kit/ vai junto
      moveInto(abs, newDir + path.basename(abs).slice(a.length - a.lastIndexOf('/') - 1));
      if (kids && fs.existsSync(kids)) moveInto(kids, newDir);
    }
    map = null;
    for (const [k, v] of [...known]) {
      if (k === from || k.startsWith(a + '/')) { known.delete(k); setKnown(k === from ? to : b + k.slice(a.length), v); }
    }
    for (let dir = path.dirname(init ? kids : abs); dir.startsWith(SRC) && dir !== SRC; dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
    saveState();
    if (typeof source === 'string' && known.get(to) !== source) writeLocal(to, source);
  }

  // Edição vinda do plugin (POST /sync).
  function fromStudio(body) {
    if (undecided.has(body.file) || undecided.has(body.to)) return; // esperando a escolha no painel
    if (body.type === 'write' && typeof body.source === 'string') {
      if (known.get(body.file) !== body.source && writeLocal(body.file, body.source)) log(`Studio → disco: ${body.file}`);
    } else if (body.type === 'delete') {
      if (known.has(body.file) || fs.existsSync(target(body.file))) { deleteLocal(body.file); log(`Studio → disco: apagou ${body.file}`); }
    } else if (body.type === 'move') {
      moveLocal(body.file, body.to, body.source);
      log(`Studio → disco: ${body.file} → ${body.to}`);
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
        const d = read(target(f.file));
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
  // o Studio pode ser outra versão do place; apagar só sincroniza ao vivo). Nos Packages do Wally o disco manda.
  function applySnapshot(scripts) {
    undecided.clear();
    map = null;
    const perguntar = [];
    const S = new Map();
    for (const s of scripts) {
      try { toAbs(s.file); } catch (e) { log(`snapshot: ignorei ${s.file} (${e.message})`); continue; }
      if (typeof s.source === 'string') S.set(s.file, s.source);
    }
    const D = new Map();
    const unreadable = new Set();
    for (const [rel, abs] of getMap().files) {
      try { D.set(rel, fs.readFileSync(abs, 'utf8')); } catch (e) { unreadable.add(rel); log(`snapshot: não li ${rel} (${e.code || e.message}), fica de fora`); }
    }
    const files = new Set([...S.keys(), ...D.keys()]);
    const toStudio = [];
    const st = { iguais: 0, studioParaDisco: 0, discoParaStudio: 0, perguntar: 0, apagadosNoStudio: 0 };
    for (const rel of files) {
      if (unreadable.has(rel)) continue;
      const s = S.get(rel), d = D.get(rel), k = known.get(rel);
      const zone = zoneOf(rel);
      try {
        if (s !== undefined && d !== undefined) {
          const w = zone && s !== d ? 'disco' : winner(s, d, k);
          if (w === 'iguais') { setKnown(rel, s); st.iguais++; }
          else if (w === 'disco') { setKnown(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++; }
          else {
            undecided.set(rel, s);
            perguntar.push({ file: rel, velho: (seen.get(rel) || []).includes(hash(s)) });
            st.perguntar++;
          }
        } else if (s !== undefined && zone) {
          // versão velha de pacote no place; sem a pasta no disco (wally install não rodou) o Studio fica como está
          if (zone.exists) { toStudio.push({ type: 'delete', file: rel }); st.apagadosNoStudio++; }
          else warnOnce(`${zone.wire} está no Studio mas não no disco: rode wally install`);
        } else if (s !== undefined) {
          writeLocal(rel, s); st.studioParaDisco++;
        } else {
          setKnown(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++;
        }
      } catch (e) { log(`snapshot: falhou em ${rel}: ${e.message}`); }
    }
    for (const rel of [...known.keys()]) if (!files.has(rel) || !D.has(rel) && zoneOf(rel)) known.delete(rel);
    for (const rel of [...seen.keys()]) if (!files.has(rel)) seen.delete(rel);
    removeEmptyDirs(SRC);
    saveState();
    for (const c of ordered(toStudio)) enqueue('edit', c);
    log(`snapshot: ${S.size} no Studio, ${D.size} no disco | ` + Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') + (st.perguntar ? ' | esperando escolha no painel do Studio' : ''));
    return { ok: true, scripts: S.size, ...st, perguntar };
  }

  function pushAll() {
    map = null;
    const cmds = [];
    for (const [rel, abs] of getMap().files) {
      const src = read(abs);
      if (src === undefined) continue;
      setKnown(rel, src);
      cmds.push({ type: 'write', file: rel, source: src });
    }
    for (const c of ordered(cmds)) enqueue('edit', c);
    return cmds.length;
  }

  // Disco → Studio: compara o disco inteiro com o último sync. Trocar o layout (Kit.luau → Kit/init.luau), um
  // default.project.json novo ou um wally install no meio do caminho convergem na varredura seguinte.
  // Com o Studio offline a mudança fica só no disco e `known` não muda: ao reconectar o disco vence sozinho.
  function rescan() {
    map = null;
    const { files } = getMap();
    const cmds = [];
    for (const [rel, abs] of files) {
      if (undecided.has(rel)) continue; // esperando a escolha no painel; ela lê o disco na hora
      const src = read(abs);
      if (src !== undefined && known.get(rel) !== src) cmds.push({ type: 'write', file: rel, source: src });
    }
    for (const rel of known.keys()) if (!files.has(rel) && !undecided.has(rel)) cmds.push({ type: 'delete', file: rel });
    if (!cmds.length) return cmds;
    if (!isOnline('edit')) {
      log(`Studio offline: ${cmds.length} mudanças (${cmds[0].file}...) sincronizam quando ele reconectar`);
      return [];
    }
    for (const c of ordered(cmds)) {
      enqueue('edit', c);
      if (c.type === 'write') setKnown(c.file, c.source); else known.delete(c.file);
      log(`disco → Studio: ${c.type} ${c.file}`);
    }
    saveState();
    return cmds;
  }

  let timer = null;
  let wait = 0;
  const SRC_TOP = path.relative(ROOT, SRC).split(path.sep)[0];
  const WATCHED = new Set([SRC_TOP, 'wally.toml', ...WALLY.map(([d]) => d)]);
  function watch() {
    try {
      fs.mkdirSync(SRC, { recursive: true });
      // a raiz inteira: Packages/ some e volta a cada wally install
      const w = fs.watch(ROOT, { recursive: true }, (_ev, name) => {
        const top = name && String(name).split(path.sep)[0];
        if (!WATCHED.has(top)) return;
        map = null;
        // o wally install apaga a versão velha e baixa a nova (~0,5s no meio): espera mais pra não apagar e recriar
        wait = Math.max(wait, top === SRC_TOP ? 150 : 1000);
        clearTimeout(timer);
        timer = setTimeout(() => { wait = 0; rescan(); }, wait);
      });
      w.on('error', (e) => { log(`vigia de src/ caiu (${e.code || e.message}), religando`); w.close(); setTimeout(watch, 1000); });
    } catch (e) {
      log(`não consegui vigiar src/ (${e.code || e.message}), tento de novo em 5s`);
      setTimeout(watch, 5000);
    }
  }

  return { known, undecided, toAbs, scan, setKnown, writeLocal, deleteLocal, moveLocal, fromStudio, resolveChoice, applySnapshot, pushAll, rescan, start: watch };
}

module.exports = { createSync, winner, stamp, scriptName };
