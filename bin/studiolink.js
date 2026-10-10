#!/usr/bin/env node
'use strict';
// studiolink — comando global do StudioLink.
//   studiolink init | start | plugin | mcp | version   (coisas da instalação/projeto)
//   qualquer outro comando vai pro CLI do projeto (status, create, run, play, fuzz...)

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findRoot, loadProject, VERSION } = require('../bridge/project');

const PKG = path.join(__dirname, '..');
const sub = process.argv[2];

const HELP = `StudioLink ${VERSION} — liga o Claude Code ao Roblox Studio

  INSTALAÇÃO E PROJETO
  init [nome] [--port N]         prepara a pasta atual como projeto (studiolink.json, src/, CLAUDE.md)
  start                          liga o servidor do projeto (deixe a janela aberta)
  plugin                         instala/atualiza o plugin no Roblox Studio
  key                            salva a chave da Open Cloud (vale pra todos os projetos)
  mcp                            servidor MCP (usado pelo Claude Code, não precisa rodar na mão)
  version                        versão instalada
`;

function pluginsDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
  return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
}

function installPlugin() {
  const dir = pluginsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'StudioLink.server.lua');
  fs.copyFileSync(path.join(PKG, 'plugin', 'StudioLink.server.lua'), dest);
  console.log(`plugin ${VERSION} instalado em ${dest}`);
  console.log('O Studio recarrega sozinho (se não, feche e abra o place).');
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

// portas já usadas por outros projetos nas pastas vizinhas (ex.: C:\dev\*)
function siblingPorts(dir) {
  const used = new Set();
  const parent = path.dirname(dir);
  let names = [];
  try { names = fs.readdirSync(parent); } catch {}
  for (const n of names) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(parent, n, 'studiolink.json'), 'utf8'));
      if (c.port) used.add(Number(c.port));
    } catch {}
  }
  return used;
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

async function init(args) {
  const dir = process.cwd();
  const cfgFile = path.join(dir, 'studiolink.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
  const portFlag = args.indexOf('--port');
  const name = args.find((a, i) => !a.startsWith('--') && (portFlag < 0 || i !== portFlag + 1)) || cfg.name || path.basename(dir);
  let port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(cfg.port);
  if (!port) {
    const used = siblingPorts(dir);
    port = 34880;
    while (used.has(port) || !(await portFree(port))) port++;
  }
  fs.writeFileSync(cfgFile, JSON.stringify({ port, name }, null, 2) + '\n');

  const made = ['studiolink.json'];
  for (const d of ['src/ServerScriptService', 'src/ReplicatedStorage', 'src/StarterPlayer/StarterPlayerScripts', 'tools/build']) {
    if (!fs.existsSync(path.join(dir, d))) { fs.mkdirSync(path.join(dir, d), { recursive: true }); made.push(d + '/'); }
  }
  const tpl = (f) => fs.readFileSync(path.join(PKG, 'template', f), 'utf8');
  if (writeIfMissing(path.join(dir, 'CLAUDE.md'), tpl('CLAUDE.md'))) made.push('CLAUDE.md');
  if (writeIfMissing(path.join(dir, '.gitignore'), '.bridge/\n.env\nnode_modules/\n')) made.push('.gitignore');
  if (writeIfMissing(path.join(dir, 'start.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nstudiolink start\r\n')) made.push('start.cmd');
  if (writeIfMissing(path.join(dir, '.claude', 'settings.json'), tpl('claude-settings.json'))) made.push('.claude/settings.json');

  console.log(`projeto "${name}" pronto na porta ${port}`);
  console.log('criado/atualizado: ' + made.join(', '));
  console.log(`\nAgora: "studiolink start" (ou dois cliques no start.cmd), abra o place no Studio e,`);
  console.log(`no painel StudioLink, ponha a porta ${port} e clique em Conectar.`);
}

// mantém o servidor de pé: se cair (ou pedir restart), sobe de novo
function start() {
  const root = findRoot();
  if (!root) {
    console.error('Esta pasta não é um projeto StudioLink (sem studiolink.json). Rode "studiolink init" primeiro.');
    process.exit(1);
  }
  const { name, port } = loadProject();
  if (process.platform === 'win32') process.stdout.write(`\x1b]0;${name} (StudioLink :${port})\x07`);
  let child = null;
  let stopping = false;
  const run = () => {
    child = spawn(process.execPath, [path.join(PKG, 'bridge', 'server.js')], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (stopping) return process.exit(0);
      console.log(`[StudioLink] servidor parou (código ${code}), subindo de novo em 2s...`);
      setTimeout(run, 2000);
    });
  };
  const stop = () => { stopping = true; if (child) child.kill(); else process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  run();
}

// chave da Open Cloud no .env da pasta do StudioLink (fora do git)
function ensureEnv() {
  const env = path.join(PKG, '.env');
  if (!fs.existsSync(env)) fs.copyFileSync(path.join(PKG, '.env.example'), env);
  return env;
}
async function saveKey(arg) {
  const env = ensureEnv();
  let key = arg;
  if (!key) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    key = await new Promise((r) => rl.question('Cole a chave da Open Cloud e aperte Enter: ', (a) => { rl.close(); r(a); }));
  }
  key = String(key || '').trim();
  if (!key) return console.log('nada salvo.');
  let text = fs.readFileSync(env, 'utf8');
  text = /^ROBLOX_API_KEY=.*$/m.test(text) ? text.replace(/^ROBLOX_API_KEY=.*$/m, 'ROBLOX_API_KEY=' + key) : text + '\r\nROBLOX_API_KEY=' + key + '\r\n';
  fs.writeFileSync(env, text);
  console.log('chave salva em ' + env + '. Nos projetos abertos: studiolink restart');
}

(async () => {
  switch (sub) {
    case 'key': return saveKey(process.argv[3]);
    case 'env': return console.log(ensureEnv());
    case 'init': return init(process.argv.slice(3));
    case 'start': return start();
    case 'plugin': return installPlugin();
    case 'mcp': return require('../bridge/mcp.js');
    case 'version': case '--version': case '-v':
      return console.log(VERSION);
    case undefined: case 'help': case '--help': case '-h':
      console.log(HELP);
      process.argv = process.argv.slice(0, 2).concat('help');
      return require('../bridge/cli.js');
    default:
      return require('../bridge/cli.js'); // status, create, set, get, run, play, fuzz, blender, upload...
  }
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
