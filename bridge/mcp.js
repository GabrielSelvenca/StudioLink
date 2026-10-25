#!/usr/bin/env node
'use strict';
// MCP do StudioLink (stdio): cada ferramenta vira um comando pro servidor do projeto.
// Registrado uma vez pra todos os projetos (install.cmd); o projeto é a pasta onde o Claude Code abriu.

const { loadProject, timeoutFor, post, VERSION } = require('./project');
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
    type: 'status',
    description: 'Mostra se o Roblox Studio está conectado (edit, e server/client durante playtest), projeto e porta.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'studio_create',
    type: 'create',
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
  },
  {
    name: 'studio_set',
    type: 'set',
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
  },
  {
    name: 'studio_get',
    type: 'get',
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
  },
  {
    name: 'studio_delete',
    type: 'delete',
    description: 'Apaga um ou mais objetos (vira um Ctrl+Z).',
    inputSchema: { type: 'object', properties: { path: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['path'] },
  },
  {
    name: 'studio_clone',
    type: 'clone',
    description: 'Duplica um objeto (com filhos), opcionalmente em outro lugar, com outro nome e propriedades.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' }, props: obj },
      required: ['path'],
    },
  },
  {
    name: 'studio_tree',
    type: 'tree',
    description: 'Mostra a hierarquia a partir de um caminho (nome [Classe]).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Padrão: Workspace' }, depth: { type: 'number', description: 'Padrão: 2' } } },
  },
  {
    name: 'studio_run_luau',
    type: 'run',
    description: 'Executa Luau no Studio (permissão de plugin) e devolve prints, retornos e erros. Use pra lógica que os comandos de objeto não cobrem (geração procedural, cálculos, APIs). Helpers: B.get(path), B.make(class, props, parent), B.find(root, nomeOuClasse), B.clear(path), B.path(inst). Durante playtest, target "server" ou "client". O código roda na thread do plugin: um loop longo sem task.wait() trava o plugin inteiro (sync, status, outros comandos) até fechar o Studio. O timeout só para de esperar, não cancela o código.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        target: { type: 'string', enum: ['edit', 'server', 'client'] },
        timeout: { type: 'number', description: 'Segundos (padrão 60).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'studio_play',
    type: 'play',
    description: 'Controla o playtest: "test" (Play com jogador), "run" (só servidor), "stop". Roda numa cópia do place: nada do teste fica salvo.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['test', 'run', 'stop'] } }, required: ['action'] },
  },
  {
    name: 'studio_logs',
    type: 'logs',
    description: 'Últimas mensagens do Output do Studio (edit, server e client).',
    inputSchema: { type: 'object', properties: { n: { type: 'number' }, role: { type: 'string', enum: ['edit', 'server', 'client'] } } },
  },
  {
    name: 'studio_fuzz',
    type: 'fuzz',
    description: 'Teste bruteforce automático: inicia o Play, joga sozinho (anda por todas as superfícies, pula, clica nos botões da UI), audita a UI (tamanho zero, fora da tela, texto cortado, uso de Offset, contraste, botões sobrepostos) e o mapa (peças caindo, paredes invisíveis, duplicadas, sem nome, sem spawn) e junta todos os erros e avisos do Output. Para o Play no fim e devolve o relatório pronto.',
    inputSchema: { type: 'object', properties: {
      seconds: { type: 'number', description: 'Quanto tempo jogando (padrão 40, máx 300).' },
      seed: { type: 'number', description: 'Semente pra repetir exatamente o mesmo teste.' },
      keepRunning: { type: 'boolean', description: 'Não parar o Play no fim (pra investigar com studio_run_luau).' },
    } },
  },
  {
    name: 'blender_run',
    type: 'blender',
    description: 'Roda Python no Blender deste PC (em segundo plano) pra modelar e exportar FBX pro Roblox. Comece com "from rbx import *". Peças: box, cylinder, cone, sphere, torus, loft (tubo por seções), prism (placa grossa), dome, from_points; acabamento: bevel, mirror, array, boolean, limit_tris, remesh, shade_flat, shade_auto; cor: material e palette_texture. Monte com union() (nunca junte malhas sobrepostas com join); confira com check() (lista vazia = ok) e preview() (4 vistas num PNG, olhe a imagem). Depois export_fbx em assets/models/*.fbx e report(). Tamanhos em studs, Z pra cima, frente = -Y. Em seguida use studio_upload_asset.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', description: 'Código Python (use isto ou script).' },
      script: { type: 'string', description: 'Caminho de um .py do projeto (ex.: tools/blender/carro.py).' },
      open: { type: 'string', description: 'Abrir um .blend antes de rodar (ex.: assets/blend/carro.blend).' },
      timeout: { type: 'number', description: 'Segundos (padrão 300).' },
    } },
  },
  {
    name: 'studio_upload_asset',
    type: 'upload',
    description: 'Sobe um arquivo pro Roblox (Open Cloud) e opcionalmente já insere no Studio. .fbx/.glb/.obj → Model (vira MeshPart), .png/.jpg → Decal (textura/imagem), .mp3/.ogg → Audio. Usa a chave da Open Cloud salva com "studiolink key" (vale pra todos os projetos).',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Caminho no projeto, ex.: assets/models/carro.fbx' },
      name: { type: 'string', description: 'Nome do asset (e do objeto inserido).' },
      insert: { type: 'boolean', description: 'Inserir no Studio depois do upload (padrão true pra modelos).' },
      parent: { type: 'string', description: 'Onde inserir (padrão Workspace).' },
    }, required: ['file'] },
  },
  {
    name: 'studio_icon_search',
    type: 'icons',
    description: 'Procura ícones na biblioteca local do StudioLink (5500+: Fluent Emoji coloridos + game-icons silhuetas). Busque em inglês com 1 ou 2 palavras (coin, money bag, sword, brain, gem, lock, gear, trophy, shop, heart, star). style "color" = ícone colorido pronto; "silhouette" = desenho de uma cor que você pinta com color.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Palavras em inglês.' },
      style: { type: 'string', enum: ['color', 'silhouette'], description: 'Filtra o tipo (opcional).' },
      limit: { type: 'number', description: 'Máximo de resultados (padrão 20).' },
    }, required: ['query'] },
  },
  {
    name: 'studio_icon',
    type: 'icon',
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
  },
  {
    name: 'studio_texture',
    type: 'texture',
    description: 'Gera textura repetível (studs, grid, dots, stripes, checker) na cor pedida, salva em assets/textures/ e, com upload:true, devolve imageUri pra usar num objeto Texture (StudsPerTileU/V = 1 pra studs).',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['studs', 'grid', 'dots', 'stripes', 'checker'] },
      color: { type: 'string', description: 'Cor base "#hex".' },
      size: { type: 'number', description: 'Pixels do tile (padrão 256).' },
      name: { type: 'string' },
      upload: { type: 'boolean' },
    }, required: ['kind'] },
  },
  {
    name: 'studio_image_upload',
    type: 'image',
    description: 'Sobe uma imagem do projeto (png/jpg/svg; ex.: baixada da internet pra assets/refs/) pro Roblox e devolve imageUri (rbxassetid://...) pra ImageLabel/Decal/Texture. Tem cache: a mesma imagem não sobe duas vezes.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string', description: 'Caminho no projeto, ex.: assets/refs/fundo.png' },
      name: { type: 'string' },
    }, required: ['file'] },
  },
  {
    name: 'studio_insert_asset',
    type: 'insert',
    description: 'Insere no Studio um asset do Roblox pelo id (modelo, mesh, decal, áudio). Para Decal devolve imageUri (use em ImageLabel.Image, SurfaceAppearance.ColorMap, Texture.Texture).',
    inputSchema: { type: 'object', properties: {
      assetId: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' },
    }, required: ['assetId'] },
  },
];

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
    const { target, ...args } = (params && params.arguments) || {};
    const cmd = { ...args, type: tool.type };
    const timeout = timeoutFor(cmd);
    const r = await post(PORT, { target, timeout, cmd }, timeout);
    let text = JSON.stringify(r, null, 2);
    if (text.length > 100000) text = text.slice(0, 100000) + '\n... (cortado em 100 KB; pra objetos grandes use "studiolink export <caminho> arquivo.json" e leia o arquivo)';
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !r.ok } });
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
