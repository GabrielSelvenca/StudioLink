#!/usr/bin/env node
'use strict';
// StudioLink MCP — ferramentas do Roblox Studio pro Claude Code (stdio, sem dependências).
// Fala com o server.js do projeto (porta do studiolink.json, padrão 34880).
// Registro (uma vez, vale pra todos os projetos): claude mcp add -s user studiolink -- node <StudioLink>/bridge/mcp.js
// O projeto é a pasta onde o Claude Code abriu (ou a mais próxima acima com studiolink.json).

const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadProject, VERSION } = require('./project');
const PROJECT = loadProject();
const ROOT = PROJECT.root || process.cwd();
const PORT = PROJECT.port;

const FORMAT = `Formato de objeto: { "class": "Part", "name": "Chao", "props": { ... }, "attributes": { ... }, "tags": [ ... ], "children": [ ... ] }.
Valores: Vector3 [x,y,z] · Color3 "#hex" ou [r,g,b] 0-255 · UDim2 [xScale,xOffset,yScale,yOffset] · UDim [scale,offset] ·
CFrame [x,y,z] ou {"pos":[x,y,z],"rot":[graus x,y,z]} ou {"pos":[...],"lookAt":[...]} · Enum pelo nome ("Neon", "Center") ·
FontFace "FredokaOne" ou {"family","weight","style"} · NumberSequence n ou [[t,v],...] · ColorSequence "#hex" ou [[t,"#hex"],...] ·
NumberRange [min,max] · referência a outro objeto "@Workspace/Peça". Caminhos usam "/": "Workspace/Mapa/Spawn", "StarterGui/HUD/Frame".`;

const obj = { type: 'object' };
const TOOLS = [
  {
    name: 'studio_status',
    description: 'Mostra se o Roblox Studio está conectado (edit, e server/client durante playtest), projeto e porta.',
    inputSchema: { type: 'object', properties: {} },
    cmd: () => ({ cmd: { type: 'status' } }),
  },
  {
    name: 'studio_create',
    description: 'Cria objetos no Studio na hora (Parts, Models, UI, luzes, efeitos...), com filhos, a partir de JSON. Cada criação vira um Ctrl+Z. ' + FORMAT,
    inputSchema: {
      type: 'object',
      properties: {
        spec: { description: 'Um objeto ou uma lista de objetos no formato StudioLink.', oneOf: [obj, { type: 'array', items: obj }] },
        parent: { type: 'string', description: 'Onde criar (padrão: Workspace). Ex.: "StarterGui", "Workspace/Mapa".' },
        replace: { type: 'boolean', description: 'Se já existir um filho com o mesmo nome no parent, apaga antes de criar.' },
      },
      required: ['spec'],
    },
    cmd: (a) => ({ cmd: { type: 'create', spec: a.spec, parent: a.parent, replace: !!a.replace } }),
  },
  {
    name: 'studio_set',
    description: 'Muda propriedades, atributos e tags de um objeto existente. "Name" e "Parent" ("@caminho") também funcionam em props. ' + FORMAT,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do objeto, ex.: "Workspace/Tower/Platform1".' },
        props: obj, attributes: obj,
        tags: { type: 'array', items: { type: 'string' } },
        pivot: { description: 'Move um Model/parte inteiro pra este CFrame. Sem "rot" mantém a rotação atual.' },
        move: { type: 'array', items: { type: 'number' }, description: 'Desloca o Model/parte em [dx,dy,dz].' },
      },
      required: ['path'],
    },
    cmd: (a) => ({ cmd: { type: 'set', path: a.path, props: a.props, attributes: a.attributes, tags: a.tags, pivot: a.pivot, move: a.move } }),
  },
  {
    name: 'studio_get',
    description: 'Lê um objeto do Studio no formato StudioLink (só as propriedades fora do padrão). depth > 0 inclui os filhos. Bom pra copiar, editar e recriar.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'number', description: 'Quantos níveis de filhos incluir (padrão 0).' },
        props: { type: 'array', items: { type: 'string' }, description: 'Ler só estas propriedades (inclusive as que estão no padrão).' },
      },
      required: ['path'],
    },
    cmd: (a) => ({ cmd: { type: 'get', path: a.path, depth: a.depth || 0, props: a.props } }),
  },
  {
    name: 'studio_delete',
    description: 'Apaga um ou mais objetos (vira um Ctrl+Z).',
    inputSchema: { type: 'object', properties: { path: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['path'] },
    cmd: (a) => ({ cmd: { type: 'delete', path: a.path } }),
  },
  {
    name: 'studio_clone',
    description: 'Duplica um objeto (com filhos), opcionalmente em outro lugar, com outro nome e propriedades.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' }, props: obj },
      required: ['path'],
    },
    cmd: (a) => ({ cmd: { type: 'clone', path: a.path, parent: a.parent, name: a.name, props: a.props } }),
  },
  {
    name: 'studio_tree',
    description: 'Mostra a hierarquia a partir de um caminho (nome [Classe]).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Padrão: Workspace' }, depth: { type: 'number', description: 'Padrão: 2' } } },
    cmd: (a) => ({ cmd: { type: 'tree', path: a.path || 'Workspace', depth: a.depth || 2 } }),
  },
  {
    name: 'studio_run_luau',
    description: 'Executa Luau no Studio (permissão de plugin) e devolve prints, retornos e erros. Use pra lógica que os comandos de objeto não cobrem (geração procedural, cálculos, APIs). Helpers: B.get(path), B.make(class, props, parent), B.find(root, nomeOuClasse), B.clear(path), B.path(inst). Durante playtest, target "server" ou "client".',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        target: { type: 'string', enum: ['edit', 'server', 'client'] },
        timeout: { type: 'number', description: 'Segundos (padrão 60).' },
      },
      required: ['code'],
    },
    cmd: (a) => ({ target: a.target || 'edit', timeout: a.timeout || 60, cmd: { type: 'run', name: 'mcp', code: a.code } }),
  },
  {
    name: 'studio_play',
    description: 'Controla o playtest: "test" (Play com jogador), "run" (só servidor), "stop". Roda numa cópia do place: nada do teste fica salvo.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['test', 'run', 'stop'] } }, required: ['action'] },
    cmd: (a) => ({ timeout: 30, cmd: { type: 'play', action: a.action } }),
  },
  {
    name: 'studio_logs',
    description: 'Últimas mensagens do Output do Studio (edit, server e client).',
    inputSchema: { type: 'object', properties: { n: { type: 'number' }, role: { type: 'string', enum: ['edit', 'server', 'client'] } } },
    cmd: (a) => ({ cmd: { type: 'logs', n: a.n || 50, role: a.role } }),
  },
  {
    name: 'studio_fuzz',
    description: 'Teste bruteforce automático: inicia o Play, joga sozinho (anda por todas as superfícies, pula, clica nos botões da UI), audita a UI (tamanho zero, fora da tela, texto cortado, uso de Offset, contraste, botões sobrepostos) e o mapa (peças caindo, paredes invisíveis, duplicadas, sem nome, sem spawn) e junta todos os erros e avisos do Output. Para o Play no fim e devolve o relatório pronto.',
    inputSchema: { type: 'object', properties: {
      seconds: { type: 'number', description: 'Quanto tempo jogando (padrão 40, máx 300).' },
      seed: { type: 'number', description: 'Semente pra repetir exatamente o mesmo teste.' },
      keepRunning: { type: 'boolean', description: 'Não parar o Play no fim (pra investigar com studio_run_luau).' },
    } },
    cmd: (a) => ({ timeout: (a.seconds || 40) + 150, cmd: { type: 'fuzz', seconds: a.seconds, seed: a.seed, keepRunning: a.keepRunning } }),
  },
  {
    name: 'blender_run',
    description: 'Roda Python no Blender deste PC (em segundo plano) pra modelar, fazer retopologia, UV, textura (bake), rig e exportar FBX. Comece o código com "from rbx import *" (biblioteca pronta: reset, box, cylinder, cone, sphere, torus, from_points, bevel, mirror, array, subdivide, boolean, join, limit_tris, remesh, clean, shade_smooth, smart_uv, material, paint_by_height, bake_color, armature, bind, export_fbx, save_blend, report). Tamanhos em studs, Z pra cima. Salve em assets/models/*.fbx e assets/textures/*.png e termine com report(). Depois use studio_upload_asset.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', description: 'Código Python (use isto OU script).' },
      script: { type: 'string', description: 'Caminho de um .py do projeto (ex.: tools/blender/carro.py).' },
      open: { type: 'string', description: 'Abrir um .blend antes de rodar (ex.: assets/blend/carro.blend).' },
      timeout: { type: 'number', description: 'Segundos (padrão 300).' },
    } },
    cmd: (a) => ({ timeout: (a.timeout || 300) + 30, cmd: { type: 'blender', code: a.code, script: a.script, open: a.open, timeout: a.timeout } }),
  },
  {
    name: 'studio_upload_asset',
    description: 'Sobe um arquivo pro Roblox (Open Cloud) e opcionalmente já insere no Studio. .fbx/.glb/.obj → Model (vira MeshPart), .png/.jpg → Decal (textura/imagem), .mp3/.ogg → Audio. Precisa de ROBLOX_API_KEY e ROBLOX_USER_ID no .env do projeto.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Caminho no projeto, ex.: assets/models/carro.fbx' },
      name: { type: 'string', description: 'Nome do asset (e do objeto inserido).' },
      insert: { type: 'boolean', description: 'Inserir no Studio depois do upload (padrão true pra modelos).' },
      parent: { type: 'string', description: 'Onde inserir (padrão Workspace).' },
    }, required: ['file'] },
    cmd: (a) => ({ timeout: 240, cmd: { type: 'upload', file: a.file, name: a.name, insert: a.insert !== undefined ? a.insert : /\.(fbx|glb|gltf|obj)$/i.test(a.file || ''), parent: a.parent } }),
  },
  {
    name: 'studio_icon_search',
    description: 'Procura ícones na biblioteca local do StudioLink (5500+: Fluent Emoji coloridos + game-icons silhuetas). Busque em INGLÊS com 1–2 palavras (coin, money bag, sword, brain, gem, lock, gear, trophy, shop, heart, star). style "color" = ícone colorido pronto; "silhouette" = desenho de uma cor que você pinta com color.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Palavras em inglês.' },
      style: { type: 'string', enum: ['color', 'silhouette'], description: 'Filtra o tipo (opcional).' },
      limit: { type: 'number', description: 'Máximo de resultados (padrão 20).' },
    }, required: ['query'] },
    cmd: (a) => ({ cmd: { type: 'icons', query: a.query, style: a.style, limit: a.limit } }),
  },
  {
    name: 'studio_icon',
    description: 'Gera o PNG de um ícone da biblioteca no estilo de jogo (contorno grosso + sombra), salva em assets/icons/ e, com upload:true, sobe pro Roblox e devolve imageUri (rbxassetid://...) pra pôr em ImageLabel.Image. Mesma imagem não sobe duas vezes (cache).',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Id do studio_icon_search, ex.: fluent/money-bag, gi/brain.' },
      color: { type: 'string', description: 'Cor "#hex" (só pra silhueta; ganha degradê automático).' },
      outline: { type: 'string', description: 'Cor do contorno "#hex" (padrão #000000) ou "none".' },
      thick: { type: 'number', description: 'Espessura do contorno (padrão 14, numa imagem de 512).' },
      shadow: { type: 'number', description: 'Sombra embaixo em px (padrão 10; 0 = sem).' },
      size: { type: 'number', description: 'Tamanho do PNG (padrão 512).' },
      name: { type: 'string', description: 'Nome do arquivo/asset.' },
      upload: { type: 'boolean', description: 'Sobe pro Roblox e devolve imageUri.' },
    }, required: ['id'] },
    cmd: (a) => ({ timeout: 240, cmd: { type: 'icon', ...a } }),
  },
  {
    name: 'studio_texture',
    description: 'Gera textura repetível (studs, grid, dots, stripes, checker) na cor pedida, salva em assets/textures/ e, com upload:true, devolve imageUri pra usar num objeto Texture (StudsPerTileU/V = 1 pra studs).',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['studs', 'grid', 'dots', 'stripes', 'checker'] },
      color: { type: 'string', description: 'Cor base "#hex".' },
      size: { type: 'number', description: 'Pixels do tile (padrão 256).' },
      name: { type: 'string' },
      upload: { type: 'boolean' },
    }, required: ['kind'] },
    cmd: (a) => ({ timeout: 240, cmd: { type: 'texture', ...a } }),
  },
  {
    name: 'studio_image_upload',
    description: 'Sobe uma imagem do projeto (png/jpg; ex.: baixada da internet pra assets/refs/) pro Roblox e devolve imageUri (rbxassetid://...) pra ImageLabel/Decal/Texture. Tem cache: a mesma imagem não sobe duas vezes.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Caminho no projeto, ex.: assets/refs/fundo.png' },
      name: { type: 'string' },
    }, required: ['file'] },
    cmd: (a) => ({ timeout: 240, cmd: { type: 'image', file: a.file, name: a.name } }),
  },
  {
    name: 'studio_insert_asset',
    description: 'Insere no Studio um asset do Roblox pelo id (modelo, mesh, decal, áudio). Para Decal devolve imageUri (use em ImageLabel.Image, SurfaceAppearance.ColorMap, Texture.Texture).',
    inputSchema: { type: 'object', properties: {
      assetId: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' },
    }, required: ['assetId'] },
    cmd: (a) => ({ timeout: 60, cmd: { type: 'insert', assetId: a.assetId, parent: a.parent, name: a.name } }),
  },
];

function post(body, timeoutSec) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Bridge': '1' },
      timeout: (timeoutSec + 10) * 1000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false, error: 'resposta inválida: ' + raw }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED'
      ? `servidor StudioLink não está rodando na porta ${PORT} (rode "studiolink start" em ${ROOT})` : String(e.message || e) }));
    req.end(data);
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'studiolink', version: VERSION },
      instructions: `StudioLink: controla o Roblox Studio do projeto em ${ROOT}. Crie e edite objetos com studio_create/studio_set/studio_get (JSON, sem escrever código). Scripts ficam em src/ como .luau e sincronizam sozinhos.`,
    } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'ferramenta desconhecida: ' + (params && params.name) } });
    const body = tool.cmd((params && params.arguments) || {});
    const r = await post(body, body.timeout || 60);
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok } });
  }
  if (id !== undefined && id !== null) {
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'método não suportado: ' + method } });
  }
  // notificações (notifications/initialized etc.): nada a fazer
}

let buf = '';
let pending = 0;
let ended = false;
const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); continue; }
    pending++;
    onMessage(msg)
      .catch((e) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } }))
      .finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); }); // termina só depois de responder tudo
