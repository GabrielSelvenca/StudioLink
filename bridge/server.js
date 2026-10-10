#!/usr/bin/env node
'use strict';
// StudioLink — servidor local entre o Claude Code (bridge/cli.js) e o plugin do Roblox Studio.
// Rode na pasta do projeto:  studiolink start
// Os scripts do jogo ficam sincronizados (nos dois sentidos) em ./src

const http = require('http');
const fs = require('fs');
const path = require('path');

const { findRoot, VERSION } = require('./project');
const ROOT = path.resolve(process.env.BRIDGE_ROOT || findRoot() || process.cwd());
// Porta: variável BRIDGE_PORT > studiolink.json { "port": 34881 } > 34880. Um servidor por projeto.
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'studiolink.json'), 'utf8')); } catch {}
const PORT = Number(process.env.BRIDGE_PORT) || Number(CONFIG.port) || 34880;
const PROJECT = CONFIG.name || path.basename(ROOT);
const SRC = path.join(ROOT, 'src');
const BACKUP = path.join(ROOT, '.bridge', 'backup');
const POLL_HOLD_MS = 8000; // o HttpService do Studio corta requisições longas (~15s)
const ONLINE_MS = 20000;
const MAX_BODY = 64 * 1024 * 1024;

fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(path.join(ROOT, '.bridge'), { recursive: true });
const LOGFILE = path.join(ROOT, '.bridge', 'server.log');
try { if (fs.statSync(LOGFILE).size > 2e6) fs.renameSync(LOGFILE, LOGFILE + '.old'); } catch {}
const log = (...a) => {
  const line = [new Date().toTimeString().slice(0, 8), ...a].join(' ');
  console.log(line);
  try { fs.appendFileSync(LOGFILE, new Date().toISOString().slice(0, 10) + ' ' + line + '\n'); } catch {}
};

// ---------------------------------------------------------------- filas por papel
// edit = Studio em modo edição | server/client = DataModels de um playtest
const roles = new Map();
function getRole(name) {
  if (!roles.has(name)) roles.set(name, { queue: [], waiter: null, lastSeen: 0, online: false });
  return roles.get(name);
}
function isOnline(name) {
  const r = roles.get(name);
  return !!r && (r.waiter !== null || Date.now() - r.lastSeen < ONLINE_MS);
}
function json(res, code, body) {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function flush(name) {
  const r = getRole(name);
  if (r.waiter && r.queue.length) {
    const w = r.waiter;
    r.waiter = null;
    clearTimeout(w.timer);
    json(w.res, 200, r.queue.splice(0));
  }
}
let nextId = 1;
const pending = new Map();
function enqueue(name, cmd) {
  cmd.id = String(nextId++);
  getRole(name).queue.push(cmd);
  flush(name);
  return cmd.id;
}
function call(name, cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    cmd.reply = true;
    cmd.id = String(nextId++);
    const timer = setTimeout(() => {
      pending.delete(cmd.id);
      const q = getRole(name).queue;
      const i = q.indexOf(cmd);
      if (i >= 0) q.splice(i, 1);
      resolve({ ok: false, error: `timeout: Studio (${name}) não respondeu em ${timeoutMs / 1000}s` });
    }, timeoutMs);
    pending.set(cmd.id, { resolve, timer });
    getRole(name).queue.push(cmd);
    flush(name);
  });
}

// ---------------------------------------------------------------- logs do Studio
const logs = [];
let logSeq = 0;
function addLog(role, kind, msg) {
  logs.push({ seq: ++logSeq, t: Date.now(), role, kind, msg });
  if (logs.length > 3000) logs.splice(0, logs.length - 3000);
}

// ---------------------------------------------------------------- sync de scripts
const known = new Map(); // caminho relativo (a/b/c.server.luau) -> conteúdo sincronizado
const STATE = path.join(ROOT, '.bridge', 'state.json');
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(STATE, 'utf8')).known || {})) known.set(k, v); } catch {}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE, JSON.stringify({ known: Object.fromEntries(known) })); } catch {}
  }, 300);
}

function toAbs(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error('caminho inválido: ' + rel);
  }
  return path.join(SRC, ...rel.split('/'));
}
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
function backup(rel, tag) {
  const dst = path.join(BACKUP, tag, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(toAbs(rel), dst);
}
function writeLocal(rel, source) {
  const abs = toAbs(rel);
  known.set(rel, source);
  saveState();
  try { if (fs.readFileSync(abs, 'utf8') === source) return; } catch {}
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, source);
}
function deleteLocal(rel) {
  const abs = toAbs(rel);
  known.delete(rel);
  saveState();
  try { fs.unlinkSync(abs); } catch {}
  let dir = path.dirname(abs);
  while (dir.startsWith(SRC) && dir !== SRC) {
    try { fs.rmdirSync(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

// Ao conectar (ou reconectar), junta Studio e disco usando o último estado sincronizado (known):
// existe dos dois lados e só um mudou → esse lado vence; os dois mudaram → Studio vence e o disco vai pra backup.
// Existe só de um lado → copia pro outro (nunca apaga na reconexão). Nada é perdido.
function applySnapshot(scripts) {
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  const S = new Map();
  for (const s of scripts) { toAbs(s.file); S.set(s.file, s.source); }
  const D = new Map();
  for (const rel of walk(SRC)) D.set(rel, fs.readFileSync(toAbs(rel), 'utf8'));
  const files = new Set([...S.keys(), ...D.keys()]);
  const toStudio = [];
  const st = { iguais: 0, studioParaDisco: 0, discoParaStudio: 0, apagados: 0, conflitos: 0, backup: 0 };
  for (const rel of files) {
    const s = S.get(rel), d = D.get(rel), k = known.get(rel);
    if (s !== undefined && d !== undefined) {
      if (s === d) { known.set(rel, s); st.iguais++; }
      else if (d === k) { backup(rel, tag); st.backup++; writeLocal(rel, s); st.studioParaDisco++; }
      else if (s === k) { known.set(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++; }
      else { backup(rel, tag); st.backup++; writeLocal(rel, s); st.conflitos++; log(`conflito em ${rel}: Studio venceu, versão do disco em .bridge/backup/${tag}`); }
    } else if (s !== undefined) {
      // só no Studio: vai pro disco. Na reconexão nunca se apaga nada (o Studio pode ser outra versão do place);
      // apagar só sincroniza ao vivo, com os dois lados conectados.
      writeLocal(rel, s); st.studioParaDisco++;
    } else {
      // só no disco: vai pro Studio
      known.set(rel, d); toStudio.push({ type: 'write', file: rel, source: d }); st.discoParaStudio++;
    }
  }
  for (const rel of [...known.keys()]) if (!files.has(rel)) known.delete(rel);
  removeEmptyDirs(SRC);
  saveState();
  for (const c of toStudio) enqueue('edit', c);
  log(`snapshot: ${S.size} no Studio, ${D.size} no disco | ` + Object.entries(st).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') + (st.backup ? ` | backup em .bridge/backup/${tag}` : ''));
  return { ok: true, scripts: S.size, ...st };
}

function syncToStudio(cmd) {
  if (!isOnline('edit')) {
    log(`Studio offline: ${cmd.file} ficou só no disco (rode "cli.js pushall" depois)`);
    return;
  }
  enqueue('edit', cmd);
  log(`disco → Studio: ${cmd.type} ${cmd.file}`);
}
function onDiskChange(rel) {
  let abs, stat = null;
  try { abs = toAbs(rel); } catch { return; }
  try { stat = fs.statSync(abs); } catch {}
  if (stat && stat.isDirectory()) { for (const f of walk(abs, rel)) onDiskChange(f); return; }
  if (!rel.endsWith('.luau')) {
    if (!stat) for (const k of [...known.keys()]) if (k.startsWith(rel + '/')) onDiskChange(k); // pasta apagada
    return;
  }
  if (!stat) {
    if (known.has(rel)) { known.delete(rel); saveState(); syncToStudio({ type: 'delete', file: rel }); }
    return;
  }
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
  if (known.get(rel) === src) return;
  known.set(rel, src);
  saveState();
  syncToStudio({ type: 'write', file: rel, source: src });
}
const debounce = new Map();
fs.watch(SRC, { recursive: true }, (_ev, name) => {
  if (!name) return;
  const rel = String(name).split(path.sep).join('/');
  clearTimeout(debounce.get(rel));
  debounce.set(rel, setTimeout(() => { debounce.delete(rel); onDiskChange(rel); }, 150));
});

// ---------------------------------------------------------------- comandos do CLI
async function handleCmd(body) {
  const cmd = body.cmd || {};
  const target = body.target || 'edit';
  const timeout = Math.max(1, Number(body.timeout) || 60) * 1000;
  switch (cmd.type) {
    case 'status': {
      const out = {};
      for (const [name, r] of roles) out[name] = isOnline(name) ? `online (${r.place || '?'})` : 'offline';
      if (isOnline('server') && !isOnline('client')) out.client = 'via server';
      return { ok: true, projeto: PROJECT, porta: PORT, studio: out, src: SRC, scripts: known.size };
    }
    case 'logs': {
      let list = logs;
      if (cmd.role) list = list.filter((l) => l.role === cmd.role);
      if (cmd.since) list = list.filter((l) => l.seq > cmd.since);
      list = list.slice(-(cmd.n || 100));
      const last = logSeq;
      if (cmd.clear) logs.length = 0;
      return { ok: true, logs: list, last };
    }
    case 'open-project': {
      // sobe o servidor de outro projeto (pasta com studiolink.json) numa janela própria
      const root = path.resolve(String(cmd.root || ''));
      if (!fs.existsSync(path.join(root, 'studiolink.json'))) return { ok: false, error: 'sem studiolink.json em ' + root + ' (rode studiolink init lá)' };
      const { spawn } = require('child_process');
      const title = path.basename(root).replace(/"/g, '');
      const bin = path.join(__dirname, '..', 'bin', 'studiolink.js');
      const child = spawn('cmd.exe', ['/c', `start "${title} (StudioLink)" /D "${root}" "${process.execPath}" "${bin}" start`], {
        detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
      });
      child.unref();
      log(`abriu o servidor do projeto ${root}`);
      return { ok: true, root };
    }
    case 'selftest':
      return selftest();
    case 'fuzz':
      return fuzz(cmd);
    case 'blender':
      return runBlender(cmd);
    case 'upload':
      return uploadAsset(cmd);
    case 'restart': {
      log('reiniciando a pedido (studiolink start sobe de novo)');
      const tStop = Date.now();
      const tryExit = () => (inboxBusy.size <= 1 && pending.size === 0) || Date.now() - tStop > 120000 ? process.exit(0) : setTimeout(tryExit, 500);
      setTimeout(tryExit, 1500); // espera o que já está rodando (ex.: Blender) terminar
      return { ok: true, restarting: true };
    }
    case 'pushall': {
      if (!isOnline('edit')) return { ok: false, error: 'Studio (edit) offline' };
      const files = walk(SRC);
      for (const rel of files) {
        const src = fs.readFileSync(toAbs(rel), 'utf8');
        known.set(rel, src);
        enqueue('edit', { type: 'write', file: rel, source: src });
      }
      return { ok: true, pushed: files.length };
    }
    case 'play': {
      if (cmd.action === 'stop' && isOnline('server')) return call('server', { type: 'play', action: 'endtest' }, timeout);
      return call('edit', cmd, timeout);
    }
    default: {
      // logo depois de um restart/recarregar plugin/iniciar playtest o papel pode demorar uns segundos pra voltar
      for (let i = 0; i < 30 && !isOnline(target) && !(target === 'client' && isOnline('server')); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (target === 'client' && !isOnline('client') && isOnline('server')) {
        return call('server', { ...cmd, relay: 'client' }, timeout); // client não faz HTTP: vai pelo server
      }
      if (!isOnline(target)) {
        return { ok: false, error: `Studio (${target}) offline. ` + (target === 'edit' ? 'Abra o Studio com o plugin ligado.' : 'Inicie um playtest primeiro.') };
      }
      return call(target, cmd, timeout);
    }
  }
}


// ---------------------------------------------------------------- autoteste
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function selftest() {
  const results = [];
  const check = (name, ok, info) => { results.push({ teste: name, ok: !!ok, info: ok ? undefined : info }); log(`selftest: ${ok ? 'OK ' : 'FALHOU'} ${name}`); };
  const run = (code, target = 'edit', timeout = 30) => handleCmd({ target, timeout, cmd: { type: 'run', name: 'selftest', code } });
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };
  const REL = 'ServerStorage/__StudioLinkSelfTest.luau';
  const ABS = toAbs(REL);
  try {
    check('Studio (edit) online', isOnline('edit'), 'abra o Studio com o plugin ligado');
    if (!isOnline('edit')) return { ok: false, results };

    let r = await run('return 1 + 1, "ok"');
    check('executar Luau e receber retorno', r.ok && r.returns && r.returns[0] === 2, r);
    r = await run('local = 1');
    check('erro de compilação é reportado', !r.ok && /compila/.test(r.error || ''), r);
    r = await run('local t = nil\nreturn t.x');
    check('erro de execução tem a linha certa', !r.ok && /:2:/.test(r.error || ''), r);

    // disco -> Studio
    fs.mkdirSync(path.dirname(ABS), { recursive: true });
    fs.writeFileSync(ABS, 'return "disco ✓"\n');
    const viaDisk = await waitFor(async () => {
      const x = await run('local m = game.ServerStorage:FindFirstChild("__StudioLinkSelfTest")\nreturn m and m.Source');
      return x.ok && x.returns[0] === 'return "disco ✓"\n';
    });
    check('sync disco → Studio (com acento)', viaDisk);

    // Studio -> disco
    await run('game.ServerStorage.__StudioLinkSelfTest.Source = "return \\"studio\\"\\n"');
    const viaStudio = await waitFor(async () => { try { return fs.readFileSync(ABS, 'utf8') === 'return "studio"\n'; } catch { return false; } });
    check('sync Studio → disco', viaStudio);

    // apagar no Studio -> some do disco
    await run('game.ServerStorage.__StudioLinkSelfTest:Destroy()');
    const gone = await waitFor(async () => !fs.existsSync(ABS));
    check('apagar no Studio apaga o arquivo', gone);
    try { fs.unlinkSync(ABS); } catch {}

    // playtest
    r = await handleCmd({ cmd: { type: 'play', action: 'test' } });
    check('iniciar Play', r.ok, r);
    if (r.ok) {
      const up = await waitFor(async () => isOnline('server'), 30000);
      check('server do playtest conectou', up);
      if (up) {
        const hasPlayer = await waitFor(async () => {
          const x = await run('return #game.Players:GetPlayers()', 'server');
          return x.ok && x.returns[0] >= 1;
        }, 20000);
        check('executar no server (jogador entrou)', hasPlayer);
        const cli = await waitFor(async () => {
          const x = await handleCmd({ target: 'client', timeout: 10, cmd: { type: 'run', name: 'selftest', code: 'return game.Players.LocalPlayer ~= nil' } });
          return x.ok && x.returns[0] === true;
        }, 20000);
        check('executar no client (via server)', cli);
      }
      r = await handleCmd({ cmd: { type: 'play', action: 'stop' } });
      check('parar o Play', r.ok, r);
      const down = await waitFor(async () => !isOnline('server'), 30000);
      check('server do playtest desconectou', down);
    }
  } catch (e) {
    check('sem exceções no autoteste', false, String(e && e.stack || e));
  }
  const ok = results.every((x) => x.ok);
  log(`selftest: ${ok ? 'TUDO OK' : 'COM FALHAS'} (${results.filter((x) => x.ok).length}/${results.length})`);
  return { ok, results };
}



// ---------------------------------------------------------------- Blender e assets (rodam neste PC)
const { spawn: spawnProc } = require('child_process');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return { ...env, ...process.env };
}

function findBlender() {
  const env = loadEnv();
  const list = [env.BLENDER_PATH, CONFIG.blenderPath];
  for (const base of ['C:\\Program Files\\Blender Foundation', 'C:\\Program Files (x86)\\Blender Foundation']) {
    try {
      const dirs = fs.readdirSync(base).filter((d) => /^Blender/i.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const d of dirs) list.push(path.join(base, d, 'blender.exe'));
    } catch {}
  }
  list.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe', '/usr/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender');
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return null;
}

function runBlender(cmd) {
  return new Promise((resolve) => {
    const exe = findBlender();
    if (!exe) return resolve({ ok: false, error: 'Blender não encontrado. Defina "blenderPath" no studiolink.json ou BLENDER_PATH no .env' });
    const dir = path.join(ROOT, '.bridge', 'blender');
    fs.mkdirSync(dir, { recursive: true });
    let file;
    if (cmd.code) {
      file = path.join(dir, `run_${Date.now()}.py`);
      fs.writeFileSync(file, cmd.code);
    } else if (cmd.script) {
      file = path.resolve(ROOT, cmd.script);
      if (!fs.existsSync(file)) return resolve({ ok: false, error: 'script não existe: ' + file });
    } else return resolve({ ok: false, error: 'passe code ou script' });
    const lib = path.join(__dirname, 'blender');
    const boot = `import sys, os; sys.path.insert(0, r"${lib}"); os.chdir(r"${ROOT}")`;
    const args = ['-b', '--factory-startup', '--python-exit-code', '1', '--python-expr', boot];
    if (cmd.open) args.splice(1, 0, path.resolve(ROOT, cmd.open)); // abrir um .blend existente
    args.push('--python', file, '--', ...(cmd.args || []));
    const timeoutMs = Math.max(10, Number(cmd.timeout) || 300) * 1000;
    const t0 = Date.now();
    log(`blender: ${path.basename(file)}`);
    const child = spawnProc(exe, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    const keep = (d) => { out += d.toString(); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const reports = [];
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('RBX_REPORT ')) { try { reports.push(...JSON.parse(line.slice(11))); } catch {} }
      }
      const clean = out.split(/\r?\n/).filter((l) => l && !/^(Fra:|Blender quit|Read prefs|RBX_REPORT )/.test(l) && !/^\s*(Saved|Info: Saved)/.test(l));
      const tail = clean.join('\n').slice(-6000);
      const timedOut = Date.now() - t0 >= timeoutMs;
      resolve({ ok: code === 0 && !timedOut, exitCode: code, segundos: Math.round((Date.now() - t0) / 1000),
        report: reports, output: tail.split('\n'), error: timedOut ? `timeout (${timeoutMs / 1000}s)` : code !== 0 ? 'o script do Blender falhou (veja output)' : undefined });
    });
  });
}

const ASSET_TYPES = {
  '.fbx': ['Model', 'model/fbx'], '.gltf': ['Model', 'model/gltf+json'], '.glb': ['Model', 'model/gltf-binary'], '.obj': ['Model', 'model/obj'],
  '.png': ['Decal', 'image/png'], '.jpg': ['Decal', 'image/jpeg'], '.jpeg': ['Decal', 'image/jpeg'], '.bmp': ['Decal', 'image/bmp'], '.tga': ['Decal', 'image/tga'],
  '.mp3': ['Audio', 'audio/mpeg'], '.ogg': ['Audio', 'audio/ogg'], '.wav': ['Audio', 'audio/wav'], '.flac': ['Audio', 'audio/flac'],
};

async function uploadAsset(cmd) {
  const env = loadEnv();
  const key = env.ROBLOX_API_KEY;
  const userId = env.ROBLOX_USER_ID || CONFIG.creatorUserId;
  const groupId = env.ROBLOX_GROUP_ID || CONFIG.creatorGroupId;
  if (!key) return { ok: false, error: 'falta ROBLOX_API_KEY no .env do projeto (Open Cloud, permissão assets:write)' };
  if (!userId && !groupId) return { ok: false, error: 'falta ROBLOX_USER_ID (ou ROBLOX_GROUP_ID) no .env do projeto' };
  const file = path.resolve(ROOT, String(cmd.file || ''));
  if (!fs.existsSync(file)) return { ok: false, error: 'arquivo não existe: ' + file };
  const ext = path.extname(file).toLowerCase();
  const kind = ASSET_TYPES[ext];
  if (!kind) return { ok: false, error: 'tipo não suportado: ' + ext + ' (use fbx/gltf/glb/obj, png/jpg, mp3/ogg/wav)' };
  const name = String(cmd.name || path.basename(file, ext)).slice(0, 50);
  const request = {
    assetType: cmd.assetType || kind[0], displayName: name, description: String(cmd.description || 'StudioLink').slice(0, 1000),
    creationContext: { creator: groupId ? { groupId: String(groupId) } : { userId: String(userId) } },
  };
  const form = new FormData();
  form.append('request', JSON.stringify(request));
  form.append('fileContent', new Blob([fs.readFileSync(file)], { type: kind[1] }), path.basename(file));
  log(`upload: ${path.basename(file)} como ${request.assetType}`);
  let res, body;
  try {
    res = await fetch('https://apis.roblox.com/assets/v1/assets', { method: 'POST', headers: { 'x-api-key': key }, body: form });
    body = await res.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: 'rede: ' + e.message }; }
  if (!res.ok) return { ok: false, error: `Open Cloud ${res.status}: ${JSON.stringify(body).slice(0, 400)}` };
  let op = body;
  const t0 = Date.now();
  while (!op.done && Date.now() - t0 < 120000) {
    await sleep(2000);
    try {
      const r = await fetch('https://apis.roblox.com/assets/v1/' + op.path, { headers: { 'x-api-key': key } });
      op = await r.json();
    } catch {}
  }
  if (!op.done) return { ok: false, error: 'o Roblox não terminou de processar em 2 min (operação ' + op.path + ')' };
  if (op.error) return { ok: false, error: 'Roblox recusou: ' + JSON.stringify(op.error).slice(0, 400) };
  const assetId = op.response && op.response.assetId;
  const out = { ok: true, assetId, tipo: request.assetType, nome: name };
  if (cmd.insert) {
    const ins = await handleCmd({ timeout: 60, cmd: { type: 'insert', assetId, parent: cmd.parent, name: cmd.insertName || name, pivot: cmd.pivot } });
    out.insert = ins;
    if (!ins.ok) out.aviso = 'upload ok, mas inserir falhou (asset novo pode levar alguns segundos/minutos na moderação): ' + ins.error;
  }
  return out;
}

// ---------------------------------------------------------------- teste bruteforce
async function fuzz(cmd) {
  const seconds = Math.min(300, Math.max(5, Number(cmd.seconds) || 40));
  const seq0 = logSeq; // antes do Play: pega também erros de quando os scripts iniciam
  let weStarted = false;
  if (!isOnline('server')) {
    const r = await handleCmd({ cmd: { type: 'play', action: 'test' } });
    if (!r.ok) return { ok: false, error: 'não consegui iniciar o playtest: ' + r.error };
    weStarted = true;
  }
  const t0 = Date.now();
  while (!isOnline('server') && Date.now() - t0 < 40000) await sleep(500);
  if (!isOnline('server')) return { ok: false, error: 'o server do playtest não conectou em 40s' };
  let players = 0;
  for (let i = 0; i < 40 && players < 1; i++) {
    const r = await handleCmd({ target: 'server', timeout: 10, cmd: { type: 'run', name: 'fuzz_wait', code: 'return #game:GetService("Players"):GetPlayers()' } });
    players = r.ok ? r.returns[0] : 0;
    if (players < 1) await sleep(500);
  }
  if (players < 1) return { ok: false, error: 'nenhum jogador entrou no playtest' };
  await sleep(3000); // deixa a UI e os scripts do client subirem

  log(`fuzz: jogando ${seconds}s`);
  const uiAntes = await handleCmd({ target: 'client', timeout: 30, cmd: { type: 'audit_ui' } });
  const jogo = await handleCmd({ target: 'client', timeout: seconds + 40, cmd: { type: 'fuzz_input', seconds, seed: cmd.seed } });
  const uiDepois = await handleCmd({ target: 'client', timeout: 30, cmd: { type: 'audit_ui' } });
  const mundo = await handleCmd({ target: 'server', timeout: 30, cmd: { type: 'audit_world' } });
  await sleep(1000);

  // erros e avisos do Output (server e client), agrupados
  const group = (kind) => {
    const map = new Map();
    for (const l of logs) {
      if (l.seq <= seq0 || l.kind !== kind || /^\[StudioLink\]/.test(l.msg)) continue;
      const k = l.role + '|' + l.msg;
      if (map.has(k)) map.get(k).vezes++;
      else map.set(k, { onde: l.role, mensagem: l.msg.slice(0, 500), vezes: 1 });
    }
    return [...map.values()];
  };
  const erros = group('MessageError');
  const avisos = group('MessageWarning');

  const uiProblemas = [];
  const seen = new Set();
  for (const [quando, r] of [['início', uiAntes], ['depois de jogar', uiDepois]]) {
    for (const p of (r.ok && r.problemas) || []) {
      const k = p.tipo + '|' + p.onde;
      if (seen.has(k)) continue;
      seen.add(k);
      uiProblemas.push({ ...p, quando });
    }
  }
  if (weStarted && !cmd.keepRunning) await handleCmd({ cmd: { type: 'play', action: 'stop' } });

  const falhas = [uiAntes, jogo, uiDepois, mundo].filter((r) => !r.ok).map((r) => r.error);
  const resumo = {
    erros: erros.length, avisos: avisos.length, ui: uiProblemas.length,
    mundo: (mundo.ok && mundo.problemas.length) || 0, jogo: (jogo.ok && jogo.eventos.length) || 0,
  };
  log(`fuzz: ${JSON.stringify(resumo)}`);
  return {
    ok: true, resumo, segundos: seconds,
    erros, avisos, ui: uiProblemas, mundo: mundo.ok ? mundo.problemas : [],
    jogo: jogo.ok ? { acoes: jogo.acoes, cliquesReais: jogo.cliquesReais, botoesVisiveis: jogo.botoesVisiveis, nota: jogo.nota, eventos: jogo.eventos } : null,
    tela: uiAntes.ok ? uiAntes.tela : null,
    falhasDoTeste: falhas.length ? falhas : undefined,
  };
}

// ---------------------------------------------------------------- HTTP
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  // Bloqueia navegadores (CSRF): só aceita quem manda o header X-Bridge e nenhum Origin.
  if (req.headers.origin || req.headers['x-bridge'] !== '1') return json(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/poll') {
      const name = url.searchParams.get('role') || 'edit';
      const sid = url.searchParams.get('sid') || '?';
      const place = url.searchParams.get('place') || '';
      const r = getRole(name);
      // Uma janela por papel: se outra janela já está ligada aqui, recusa (o painel mostra "porta em uso").
      if (name === 'edit' && r.owner && r.owner !== sid && isOnline(name)) {
        if (r.rejected !== sid) { r.rejected = sid; log(`recusou ${place} [${sid}] no papel ${name}: ${r.place} [${r.owner}] já está ligado`); }
        return json(res, 409, { conflict: true, place: r.place });
      }
      if (r.owner !== sid) r.flips = 0;
      r.owner = sid;
      r.lastSeen = Date.now();
      if (!r.online) { r.online = true; log(`Studio (${name}) conectado: ${place} [${sid}]`); }
      // Duas janelas no mesmo papel alternam o sid sem parar; uma troca isolada é só o plugin recarregando.
      if (r.sid && r.sid !== sid && Date.now() - (r.sidSeen || 0) < 15000) {
        r.flips = (r.flips || 0) + 1;
        if (r.flips >= 4 && !r.dupWarned) { r.dupWarned = true; log(`AVISO: duas janelas do Studio disputando o papel ${name} (${r.place} e ${place}). Feche uma.`); }
      } else if (r.sid === sid) { r.flips = Math.max(0, (r.flips || 0) - 1); if (!r.flips) r.dupWarned = false; }
      r.sid = sid; r.place = place; r.sidSeen = Date.now();
      if (r.waiter) { clearTimeout(r.waiter.timer); json(r.waiter.res, 200, []); r.waiter = null; }
      if (r.queue.length) return json(res, 200, r.queue.splice(0));
      const w = { res };
      w.timer = setTimeout(() => {
        if (r.waiter === w) { r.waiter = null; r.lastSeen = Date.now(); json(res, 200, []); }
      }, POLL_HOLD_MS);
      r.waiter = w;
      res.on('close', () => { if (r.waiter === w) { r.waiter = null; clearTimeout(w.timer); r.lastSeen = Date.now(); } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/info') {
      return json(res, 200, {
        name: PROJECT, root: ROOT, port: PORT, version: VERSION, scripts: known.size,
        playtest: isOnline('server'),
        roles: Object.fromEntries([...roles].map(([n, r]) => [n, { online: isOnline(n), place: r.place || null }])),
      });
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    switch (url.pathname) {
      case '/bye': {
        const r = roles.get(body.role || 'edit');
        if (r && r.owner === body.sid) {
          r.owner = null;
          r.lastSeen = 0;
          if (r.waiter) { clearTimeout(r.waiter.timer); json(r.waiter.res, 200, []); r.waiter = null; }
          if (r.online) { r.online = false; log(`Studio (${body.role || 'edit'}) desconectou: ${r.place}`); }
        }
        return json(res, 200, { ok: true });
      }
      case '/result': {
        const p = pending.get(String(body.id));
        if (p) { pending.delete(String(body.id)); clearTimeout(p.timer); p.resolve(body.result || { ok: false, error: 'sem resultado' }); }
        return json(res, 200, { ok: true });
      }
      case '/sync': {
        if (body.type === 'write' && typeof body.source === 'string') {
          if (known.get(body.file) !== body.source) { writeLocal(body.file, body.source); log(`Studio → disco: ${body.file}`); }
        } else if (body.type === 'delete') {
          if (known.has(body.file) || fs.existsSync(toAbs(body.file))) { deleteLocal(body.file); log(`Studio → disco: apagou ${body.file}`); }
        }
        return json(res, 200, { ok: true });
      }
      case '/snapshot':
        return json(res, 200, applySnapshot(Array.isArray(body.scripts) ? body.scripts : []));
      case '/log':
        for (const e of body.entries || []) addLog(body.role || 'edit', e.kind, e.msg);
        return json(res, 200, { ok: true });
      case '/cmd':
        return json(res, 200, await handleCmd(body));
      default:
        return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------------------------------------------------------------- inbox por arquivo
// Pra quando o Claude não roda nesta máquina (sessão na nuvem): ele grava .bridge/inbox/<id>.json
// ({ target, timeout, cmd }) e lê a resposta em .bridge/outbox/<id>.json
const INBOX = path.join(ROOT, '.bridge', 'inbox');
const OUTBOX = path.join(ROOT, '.bridge', 'outbox');
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(OUTBOX, { recursive: true });
const inboxBusy = new Set();
setInterval(() => {
  let files = [];
  try { files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    if (inboxBusy.has(f)) continue;
    inboxBusy.add(f);
    const abs = path.join(INBOX, f);
    (async () => {
      let result;
      try {
        const body = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (body.cmd && body.cmd.type === 'run' && body.cmd.file && !body.cmd.code) {
          body.cmd.code = fs.readFileSync(path.resolve(ROOT, body.cmd.file), 'utf8');
          body.cmd.name = path.basename(body.cmd.file);
        }
        log(`inbox: ${f} (${body.cmd && body.cmd.type})`);
        result = await handleCmd(body);
      } catch (e) {
        result = { ok: false, error: 'inbox: ' + e.message };
      }
      try { fs.writeFileSync(path.join(OUTBOX, f), JSON.stringify(result, null, 2)); } catch {}
      try { fs.unlinkSync(abs); } catch {}
      inboxBusy.delete(f);
    })();
  }
}, 500);

// Marca papéis que pararam de fazer poll como offline (só pro log ficar claro)
setInterval(() => {
  for (const [name, r] of roles) if (r.online && !isOnline(name)) { r.online = false; log(`Studio (${name}) desconectado`); }
}, 5000);

const main = http.createServer(handler);
main.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Porta ${PORT} já em uso (outra ponte rodando?)` : e);
  process.exit(1);
});
main.listen(PORT, '127.0.0.1', () => log(`StudioLink ${VERSION} | projeto "${PROJECT}" | http://localhost:${PORT} | sincronizando ${SRC}`));
// "localhost" às vezes resolve pra IPv6 no Windows; escuta no ::1 também (só local).
const v6 = http.createServer(handler);
v6.on('error', () => {});
v6.listen(PORT, '::1');
