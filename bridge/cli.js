#!/usr/bin/env node
'use strict';
// CLI que o Claude Code usa pra falar com o Studio através do server.js

const fs = require('fs');
const path = require('path');

const { loadProject, timeoutFor, post } = require('./project');
const PORT = loadProject().port;

const HELP = `StudioLink: comandos de projeto (rode na pasta do jogo)

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

const BOOL = new Set(['replace', 'insert', 'upload', 'clear', 'force']);
const TARGETS = ['edit', 'server', 'client'];

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // o código do eval pode começar com "--" (comentário Luau)
    if (!a.startsWith('--') || (pos.length === 1 && pos[0] === 'eval')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!BOOL.has(k) && next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
  }
  return { pos, flags };
}

// aceita JSON direto ou caminho de arquivo .json
function jsonArg(v, what) {
  if (v === undefined || v === true) return undefined;
  if (typeof v === 'string' && /\.json$/i.test(v) && fs.existsSync(v)) v = fs.readFileSync(v, 'utf8');
  try { return JSON.parse(v); } catch (e) { throw new Error(`${what}: JSON inválido (${e.message})`); }
}

const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const sub = pos.shift();
  const str = (k) => (typeof flags[k] === 'string' ? flags[k] : undefined);
  const target = str('target') || 'edit';
  if (!TARGETS.includes(target)) throw new Error('--target: use edit, server ou client');
  let cmd;
  let exportTo;

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
    case 'tree': {
      const depth = Number(pos[1] ?? 2);
      cmd = { type: 'tree', path: pos[0] || 'Workspace', depth: Number.isNaN(depth) ? 2 : depth };
      break;
    }
    case 'logs': cmd = { type: 'logs', n: Number(pos[0]) || 100, role: str('role'), clear: !!flags.clear }; break;
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
        spec = { class: a, name: str('name') };
        const props = jsonArg(flags.props, '--props');
        if (props) spec.props = props;
      } else {
        spec = jsonArg(a, 'objeto');
      }
      cmd = { type: 'create', spec, parent: str('parent'), replace: !!flags.replace };
      break;
    }
    case 'set': {
      if (!pos[0] || !pos[1]) throw new Error("uso: set <caminho> '{\"Prop\": valor}'");
      const body = jsonArg(pos[1], 'propriedades');
      // aceita {props, attributes, tags, pivot, move} ou direto {Prop: valor}
      cmd = body.props || body.attributes || body.tags || body.pivot || body.move ? { ...body, type: 'set', path: pos[0] } : { type: 'set', path: pos[0], props: body };
      break;
    }
    case 'get': cmd = { type: 'get', path: pos[0], depth: Number(flags.depth) || 0 }; break;
    case 'export': {
      if (!pos[0] || !pos[1]) throw new Error('uso: export <caminho> arquivo.json [--depth N]');
      cmd = { type: 'get', path: pos[0], depth: flags.depth !== undefined ? Number(flags.depth) : 50 };
      exportTo = pos[1];
      break;
    }
    case 'delete': if (!pos.length) throw new Error('uso: delete <caminho> [caminho...]'); cmd = { type: 'delete', path: pos.length === 1 ? pos[0] : pos }; break;
    case 'clone': {
      if (!pos[0]) throw new Error('uso: clone <caminho> [--parent P] [--name N] [--props json]');
      cmd = { type: 'clone', path: pos[0], parent: str('parent'), name: str('name'), props: jsonArg(flags.props, '--props') };
      break;
    }
    case 'fuzz': cmd = { type: 'fuzz', seconds: Number(pos[0]) || 40, seed: flags.seed ? Number(flags.seed) : undefined }; break;
    case 'blender': {
      if (!pos[0]) throw new Error('uso: blender <script.py | -> [--open arquivo.blend]');
      cmd = pos[0] === '-' ? { type: 'blender', code: fs.readFileSync(0, 'utf8') } : { type: 'blender', script: pos[0] };
      cmd.open = str('open');
      break;
    }
    case 'upload': cmd = { type: 'upload', file: pos[0], name: str('name'), insert: !!flags.insert, parent: str('parent') }; break;
    case 'image': cmd = { type: 'image', file: pos[0], name: str('name'), force: !!flags.force }; break;
    case 'icons': cmd = { type: 'icons', query: pos.join(' '), limit: Number(flags.limit) || 20, style: str('style') }; break;
    case 'icon': {
      if (!pos[0]) throw new Error('uso: icon <id> [--color #hex] [--outline #hex|none] [--thick N] [--shadow N] [--size N] [--name N] [--upload]');
      cmd = { type: 'icon', id: pos[0], upload: !!flags.upload, color: str('color'), outline: str('outline'), name: str('name') };
      for (const k of ['thick', 'shadow', 'size']) if (flags[k] !== undefined) cmd[k] = Number(flags[k]);
      break;
    }
    case 'texture': {
      cmd = { type: 'texture', kind: pos[0] || 'studs', upload: !!flags.upload, color: str('color'), name: str('name') };
      if (flags.size !== undefined) cmd.size = Number(flags.size);
      break;
    }
    case 'insert': cmd = { type: 'insert', assetId: pos[0], parent: str('parent'), name: str('name') }; break;
    case 'resync': cmd = { type: 'snapshot' }; break;
    case 'pushall': cmd = { type: 'pushall' }; break;
    case 'restart': cmd = { type: 'restart' }; break;
    case 'selftest': cmd = { type: 'selftest' }; break;
    default: console.log(HELP); process.exit(!sub || ['help', '-h'].includes(sub) ? 0 : 1);
  }

  if (str('player')) cmd.player = str('player'); // playtest com vários clientes: qual jogador
  if (str('timeout')) cmd.timeout = Number(flags.timeout);
  const timeout = timeoutFor(cmd);
  const r = await post(PORT, { target, timeout, cmd }, timeout);
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
  for (const k of ['ok', 'output', 'logs', 'text', 'returns', 'error', 'ms', 'results', 'report']) delete rest[k];
  if (Object.keys(rest).length) console.log(fmt(rest));
  if (r.ms !== undefined) console.log(`(${r.ms} ms)`);
  if (!r.ok) { console.error('ERRO: ' + (r.error || 'falhou')); process.exit(1); }
  if (sub === 'status' && !/^online/.test((r.studio && r.studio.edit) || '')) process.exit(3); // código 3: Studio (edit) não conectado
}

main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
