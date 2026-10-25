#!/usr/bin/env node
'use strict';
// CLI que o Claude Code usa pra falar com o Studio através do server.js

const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadProject } = require('./project');
const PROJECT = loadProject();
const PORT = PROJECT.port;

const HELP = `StudioLink — comandos de projeto (rode na pasta do jogo)

  status                         quem está conectado (edit / server / client)

  OBJETOS (na hora, sem escrever código)
  create <Classe> [--name N] [--parent P] [--props '{json}'] [--replace]
  create '<json>' | arquivo.json [--parent P] [--replace]   cria árvore inteira (formato no CLAUDE.md)
  set <caminho> '{"Prop": valor, ...}'                       muda propriedades (Name/Parent também)
  get <caminho> [--depth N]                                  devolve o objeto em JSON
  delete <caminho> [caminho...]
  clone <caminho> [--parent P] [--name N] [--props '{json}']
  export <caminho> arquivo.json [--depth N]                  salva o objeto (e filhos) em JSON

  TESTE E ASSETS
  fuzz [segundos] [--seed N]                                 teste bruteforce no Play (relatório)
  blender <script.py | -> [--open arquivo.blend]            roda Python no Blender (from rbx import *)
  upload <arquivo> [--name N] [--insert] [--parent P]        sobe fbx/png/mp3 pro Roblox (Open Cloud)
  insert <assetId> [--parent P] [--name N]                  insere um asset no Studio

  IMAGENS (ícones, texturas, referências)
  icons <busca em inglês> [--style color|silhouette]         procura na biblioteca local (coin, sword, brain...)
  icon <id> [--color #hex] [--outline #hex|none] [--thick N] [--upload]
                                                             gera PNG em assets/icons (com --upload: devolve rbxassetid)
  texture studs|grid|dots|stripes|checker [--color #hex] [--upload]   textura repetível em assets/textures
  image <arquivo.png> [--name N]                             sobe uma imagem e devolve o rbxassetid (com cache)

  CÓDIGO
  run <arquivo.luau | ->         executa Luau no Studio (- = lê do stdin)
  eval "<código>"                executa uma linha de Luau
  tree [caminho] [profundidade]  mostra a hierarquia (padrão: Workspace 2)
  logs [n] [--role R] [--clear]  últimas mensagens do Output
  play run|test|stop             Run (sem jogador) | Play (com jogador) | parar
                                 os dois rodam numa cópia: nada do teste fica no place
  resync                         Studio → disco (refaz o snapshot dos scripts)
  pushall                        disco → Studio (manda todos os arquivos de src/)
  selftest                       testa a ponte inteira (sync, execução, playtest)
  restart                        reinicia o servidor (studiolink start sobe de novo)

  --target edit|server|client    onde executar (padrão: edit). server/client só durante teste
  --player <Nome>                com --target client: em qual jogador (Server & Clients)
  --timeout <segundos>           padrão 60`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

// aceita JSON direto ou caminho de arquivo .json
function jsonArg(v, what) {
  if (v === undefined || v === true) return undefined;
  if (typeof v === 'string' && /\.json$/i.test(v) && fs.existsSync(v)) v = fs.readFileSync(v, 'utf8');
  try { return JSON.parse(v); } catch (e) { throw new Error(`${what}: JSON inválido (${e.message})`); }
}

function post(body, timeoutSec) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Bridge': '1' },
      timeout: (timeoutSec + 10) * 1000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('resposta inválida: ' + raw)); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout falando com o server.js')));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error(`servidor do projeto não está rodando na porta ${PORT}: rode "studiolink start" na pasta do jogo`) : e));
    req.end(data);
  });
}

const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const sub = pos.shift();
  const timeout = Number(flags.timeout) || ({ selftest: 180, play: 120, fuzz: (Number(pos[0]) || 40) + 150, blender: 330, upload: 240, image: 240, icon: 240, texture: 240 }[sub] || 60);
  const target = flags.target || 'edit';
  let cmd;

  switch (sub) {
    case 'status': cmd = { type: 'status' }; break;
    case 'run': {
      const file = pos[0];
      if (!file) throw new Error('uso: run <arquivo.luau | ->');
      const code = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
      cmd = { type: 'run', code, name: file === '-' ? 'stdin' : path.basename(file) };
      break;
    }
    case 'eval': cmd = { type: 'run', code: pos.join(' '), name: 'eval' }; break;
    case 'tree': cmd = { type: 'tree', path: pos[0] || 'Workspace', depth: Number(pos[1]) || 2 }; break;
    case 'logs': cmd = { type: 'logs', n: Number(pos[0]) || 100, role: flags.role, clear: !!flags.clear }; break;
    case 'play': {
      if (!['run', 'test', 'stop'].includes(pos[0])) throw new Error('uso: play run|test|stop');
      cmd = { type: 'play', action: pos[0] };
      break;
    }
    case 'create': {
      const a = pos[0];
      if (!a) throw new Error('uso: create <Classe> [--name N] [--props json] | create <json|arquivo.json>');
      let spec;
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(a) && !fs.existsSync(a)) {
        spec = { class: a };
        if (typeof flags.name === 'string') spec.name = flags.name;
        const props = jsonArg(flags.props, '--props');
        if (props) spec.props = props;
      } else {
        spec = jsonArg(a, 'objeto');
      }
      cmd = { type: 'create', spec, parent: typeof flags.parent === 'string' ? flags.parent : undefined, replace: !!flags.replace };
      break;
    }
    case 'set': {
      if (!pos[0] || !pos[1]) throw new Error("uso: set <caminho> '{\"Prop\": valor}'");
      const body = jsonArg(pos[1], 'propriedades');
      // aceita {props:{...}, attributes, tags} ou direto {Prop: valor}
      cmd = body.props || body.attributes || body.tags || body.pivot || body.move ? { type: 'set', path: pos[0], ...body } : { type: 'set', path: pos[0], props: body };
      break;
    }
    case 'get': cmd = { type: 'get', path: pos[0], depth: Number(flags.depth) || 0 }; break;
    case 'export': {
      if (!pos[0] || !pos[1]) throw new Error('uso: export <caminho> arquivo.json [--depth N]');
      cmd = { type: 'get', path: pos[0], depth: flags.depth !== undefined ? Number(flags.depth) : 50, exportTo: pos[1] };
      break;
    }
    case 'delete': if (!pos.length) throw new Error('uso: delete <caminho> [caminho...]'); cmd = { type: 'delete', path: pos.length === 1 ? pos[0] : pos }; break;
    case 'clone': {
      if (!pos[0]) throw new Error('uso: clone <caminho> [--parent P] [--name N] [--props json]');
      cmd = { type: 'clone', path: pos[0], parent: typeof flags.parent === 'string' ? flags.parent : undefined, name: typeof flags.name === 'string' ? flags.name : undefined, props: jsonArg(flags.props, '--props') };
      break;
    }
    case 'fuzz': cmd = { type: 'fuzz', seconds: Number(pos[0]) || 40, seed: flags.seed ? Number(flags.seed) : undefined }; break;
    case 'blender': {
      if (!pos[0]) throw new Error('uso: blender <script.py | -> [--open arquivo.blend]');
      cmd = pos[0] === '-' ? { type: 'blender', code: fs.readFileSync(0, 'utf8') } : { type: 'blender', script: pos[0] };
      if (typeof flags.open === 'string') cmd.open = flags.open;
      break;
    }
    case 'upload': cmd = { type: 'upload', file: pos[0], name: typeof flags.name === 'string' ? flags.name : undefined, insert: !!flags.insert, parent: typeof flags.parent === 'string' ? flags.parent : undefined }; break;
    case 'image': cmd = { type: 'image', file: pos[0], name: typeof flags.name === 'string' ? flags.name : undefined, force: !!flags.force }; break;
    case 'icons': cmd = { type: 'icons', query: pos.join(' '), limit: Number(flags.limit) || 20, style: typeof flags.style === 'string' ? flags.style : undefined }; break;
    case 'icon': {
      if (!pos[0]) throw new Error('uso: icon <id> [--color #hex] [--outline #hex|none] [--thick N] [--shadow N] [--size N] [--name N] [--upload]');
      cmd = { type: 'icon', id: pos[0], upload: !!flags.upload };
      for (const k of ['color', 'outline', 'name']) if (typeof flags[k] === 'string') cmd[k] = flags[k];
      for (const k of ['thick', 'shadow', 'size']) if (flags[k] !== undefined) cmd[k] = Number(flags[k]);
      break;
    }
    case 'texture': {
      cmd = { type: 'texture', kind: pos[0] || 'studs', upload: !!flags.upload };
      for (const k of ['color', 'name']) if (typeof flags[k] === 'string') cmd[k] = flags[k];
      if (flags.size !== undefined) cmd.size = Number(flags.size);
      break;
    }
    case 'insert': cmd = { type: 'insert', assetId: pos[0], parent: typeof flags.parent === 'string' ? flags.parent : undefined, name: typeof flags.name === 'string' ? flags.name : undefined }; break;
    case 'resync': cmd = { type: 'snapshot' }; break;
    case 'pushall': cmd = { type: 'pushall' }; break;
    case 'restart': cmd = { type: 'restart' }; break;
    case 'selftest': cmd = { type: 'selftest' }; break;
    default: console.log(HELP); process.exit(sub && sub !== 'help' ? 1 : 0);
  }

  if (typeof flags.player === 'string') cmd.player = flags.player; // playtest com vários clientes: qual jogador
  const exportTo = cmd.exportTo;
  delete cmd.exportTo;
  const r = await post({ target, timeout, cmd }, timeout);
  if (exportTo && r.ok && r.object) {
    fs.writeFileSync(exportTo, JSON.stringify(r.object, null, 2));
    console.log(`salvo em ${exportTo}`);
    delete r.object;
  }
  if (r.object) { console.log(JSON.stringify(r.object, null, 2)); delete r.object; }
  if (r.created) { console.log('criado: ' + r.created.join(', ')); delete r.created; }
  if (r.deleted) { console.log('apagado: ' + r.deleted.join(', ')); delete r.deleted; }
  if (r.path && r.ok) { console.log('ok: ' + r.path); delete r.path; }

  if (r.output) for (const line of r.output) console.log(line);
  if (r.logs) for (const l of r.logs) console.log(`[${l.role}] ${l.kind === 'MessageOutput' ? '' : l.kind.replace('Message', '') + ': '}${l.msg}`);
  if (r.text) console.log(r.text);
  if (r.report && r.report.length) console.log('blender: ' + JSON.stringify(r.report, null, 2));
  if (r.resumo) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (r.icones) { for (const i of r.icones) console.log(`${i.id.padEnd(34)} ${i.style === 'color' ? 'colorido ' : 'silhueta '} ${i.name}`); if (!r.icones.length) console.log('nada achado (busque em inglês: coin, sword, brain, gem...)'); delete r.icones; }
  if (r.results) for (const t of r.results) console.log(`${t.ok ? '✓' : '✗'} ${t.teste}${t.info ? '  → ' + (typeof t.info === 'string' ? t.info : JSON.stringify(t.info)) : ''}`);
  if (r.returns && r.returns.length) console.log('→ ' + r.returns.map(fmt).join(', '));
  const rest = { ...r };
  for (const k of ['ok', 'output', 'logs', 'text', 'returns', 'error', 'ms', 'last', 'results']) delete rest[k];
  if (Object.keys(rest).length) console.log(fmt(rest));
  if (r.ms !== undefined) console.log(`(${r.ms} ms)`);
  if (!r.ok) { console.error('ERRO: ' + (r.error || 'falhou')); process.exit(1); }
}

main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
