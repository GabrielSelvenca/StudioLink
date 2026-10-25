<p align="center"><img src="assets/logo.png" width="128" alt="StudioLink"></p>
<h1 align="center">StudioLink</h1>
<p align="center">Ponte entre o Claude Code e o Roblox Studio.</p>

O Claude cria e edita o jogo direto no Studio: scripts sincronizados com arquivos `.luau` nos dois sentidos,
objetos criados por JSON na hora (Parts, Models, UI, luzes, efeitos), playtest controlado pelo terminal,
teste bruteforce (`fuzz`), modelos 3D pelo Blender e upload de assets pela Open Cloud. Uma dependência só:
o resvg, que desenha os PNGs de ícones e texturas.

## Instalar (uma vez por PC)
1. Tenha o **Node.js 20+** e o **Roblox Studio**.
2. Clone este repositório (ex.: `C:\dev\StudioLink`) e dê dois cliques em **`install.cmd`**. Ele:
   - instala o comando `studiolink` (`npm install -g .`);
   - copia o plugin pra pasta de plugins do Studio;
   - registra o MCP no Claude Code pra todos os projetos.

## Usar (cada jogo)
```
cd C:\dev\MeuJogo
studiolink init          # cria studiolink.json (porta livre), src/, CLAUDE.md, start.cmd
studiolink start         # liga o servidor do projeto (deixe aberto) ou dois cliques no start.cmd
```
No Studio, abra o place → aba **Plugins → StudioLink** → ponha a porta do `studiolink.json` → **Conectar**.
Depois é só abrir o Claude Code na pasta do jogo.

Vários Studios ao mesmo tempo: cada projeto tem a sua porta e o seu `studiolink start`.

## Comandos
```
studiolink status                     quem está conectado (edit / server / client)
studiolink create|set|get|delete|clone|export    objetos por JSON
studiolink run arquivo.luau | eval "código"      executa Luau no Studio
studiolink tree Workspace 2           hierarquia
studiolink play test|run|stop         playtest
studiolink logs 50                    Output do Studio
studiolink fuzz 40                    teste bruteforce com relatório
studiolink blender script.py          roda Python no Blender (biblioteca rbx)
studiolink upload modelo.fbx --insert sobe pro Roblox (Open Cloud) e insere
studiolink selftest                   testa a ponte inteira
studiolink restart                    recarrega o servidor do projeto
studiolink key                        salva a chave da Open Cloud
studiolink icons coin                 procura ícones na biblioteca local (5500+)
studiolink icon fluent/coin --upload  gera o PNG com contorno e devolve o rbxassetid
studiolink texture studs --color "#3aa0ff" --upload   textura de studs
studiolink image assets/refs/x.png    sobe qualquer imagem e devolve o rbxassetid
```
`studiolink help` lista tudo.

## Atualizar
Na pasta do StudioLink: edite, `git commit`, `git push` e rode o `install.cmd` de novo
(ele atualiza o plugin e o MCP). Nos projetos abertos: `studiolink restart`.

## Imagens
A biblioteca fica em `library/` (fora do git; o `install.cmd` baixa, ou `studiolink library`):
- **Fluent Emoji** (Microsoft, MIT): ~1600 ícones coloridos, sem crédito obrigatório.
- **game-icons.net** (CC BY 3.0): ~4000 silhuetas pra pintar em qualquer cor. Se usar, ponha
  "Ícones: game-icons.net" nos créditos do jogo.

Os PNGs gerados vão pra `assets/icons` e `assets/textures` do projeto. Imagens já enviadas ficam em
`library/uploaded.json` e não sobem de novo.

## Como funciona
```
Claude Code ──(MCP / studiolink)──► servidor do projeto (localhost:porta) ◄──(HTTP long-poll)── plugin no Studio
                                          │
                                         src/  ⇄  scripts do jogo
```
- Só aceita conexões locais e bloqueia requisições de navegador.
- Ao reconectar nada é apagado. Se um script mudou no Studio, o painel do plugin pergunta qual versão fica;
  a outra vai pra `.bridge/backup/`.
- Upload de assets: crie uma User API Key em create.roblox.com → Open Cloud (permissão assets read + write) e rode
  `studiolink key` (salva no `.env` da pasta do StudioLink, fora do git, e vale pra todos os projetos).

## Estrutura
```
bin/studiolink.js      comando global (init, start, plugin, mcp + CLI)
bridge/server.js       servidor de cada projeto (fila de comandos, HTTP)
bridge/sync.js         sync de src/ com o Studio (teste: node bridge/sync.test.js)
bridge/cli.js          comandos de terminal
bridge/mcp.js          ferramentas MCP (studio_*, blender_run...)
bridge/blender/rbx.py  biblioteca de modelagem pro Blender
plugin/                plugin do Studio
template/              arquivos que o "studiolink init" cria
```
