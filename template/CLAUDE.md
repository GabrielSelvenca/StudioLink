# Projeto Roblox com StudioLink

Você controla o Roblox Studio pela ponte StudioLink: o plugin no Studio conversa com o servidor do projeto
(`studiolink start`, porta no `studiolink.json`). Use as ferramentas MCP `studio_*` ou o comando `studiolink` no terminal.

## Antes de tudo
- `studiolink status` → precisa mostrar `edit: online (<nome do place>)`.
  Se não: Studio fechado, botão "StudioLink" desligado na aba Plugins, ou servidor parado (rode `studiolink start` / `start.cmd`).
- **Só uma janela do Studio por place.** Duas janelas disputam a ponte (o log avisa "duas janelas").
- Olhe antes de mexer: `studiolink tree Workspace 2`, `tree StarterGui 3`.

## Scripts do jogo
- Ficam espelhados em `src/` e sincronizam nos dois sentidos. Edite os arquivos; não crie scripts via `run`.
- Caminho = hierarquia: `src/ServerScriptService/Combat/Damage.luau`
  `.server.luau` = Script · `.client.luau` = LocalScript · `.luau` = ModuleScript · pasta nova = Folder.
- Apagar o arquivo apaga o script. Renomear/mover no Studio renomeia/move o arquivo.
- Ao (re)conectar, Studio e disco são mesclados. Só o disco mudou: o disco vence. O script mudou no Studio:
  o painel do plugin pergunta qual versão fica e a outra vai pra `.bridge/backup/`; até a escolha, esses
  scripts não sincronizam (`studiolink status` avisa). Nada é perdido.

## Objetos (Parts, Models, UI, luzes, efeitos) sem escrever código
UI: sempre Scale (nunca Offset) e sempre física no StarterGui; o LocalScript só acha os elementos e anima.
Prefira as ferramentas MCP `studio_create`, `studio_set`, `studio_get`, `studio_delete`, `studio_clone`
(ou o CLI: `studiolink create|set|get|delete|clone|export`). Aparece no Studio na hora e vira Ctrl+Z.

Formato:
```json
{ "class": "Frame", "name": "Painel",
  "props": { "AnchorPoint": [0.5, 1], "Position": [0.5, 0, 0.97, 0], "Size": [0.2, 0, 0.1, 0],
             "BackgroundColor3": "#12141e", "BackgroundTransparency": 0.15 },
  "attributes": { "Tema": "escuro" }, "tags": ["HUD"],
  "children": [ { "class": "UICorner", "props": { "CornerRadius": [0.25, 0] } },
                { "class": "TextLabel", "name": "Valor", "props": { "Text": "0", "FontFace": "FredokaOne", "TextScaled": true,
                  "Size": [1, 0, 1, 0], "BackgroundTransparency": 1 } } ] }
```
Valores: Vector3 `[x,y,z]` · Color3 `"#hex"` ou `[r,g,b]` 0-255 · UDim2 `[xScale,xOffset,yScale,yOffset]` · UDim `[s,o]` ·
CFrame `[x,y,z]` ou `{"pos":[..],"rot":[graus]}` ou `{"pos":[..],"lookAt":[..]}` · Enum pelo nome (`"Neon"`) ·
FontFace `"FredokaOne"` · NumberSequence `n` ou `[[t,v],..]` · ColorSequence `"#hex"` ou `[[t,"#hex"],..]` ·
NumberRange `[min,max]` · referência `"@Workspace/Peça"` · `"pivot"` (CFrame) no nível do objeto move um Model inteiro.

- `studio_get` com `depth` devolve o objeto no mesmo formato (só o que difere do padrão): leia, ajuste e recrie.
- `replace: true` no create troca um objeto com o mesmo nome (bom pra refazer).
- CLI: `create Part --name Chao --props '{"Size":[50,1,50],"Anchored":true}'` ou `create arquivo.json --parent StarterGui`.
- Use `studio_run_luau` só quando precisar de lógica (gerar 200 peças num padrão, cálculos, APIs do Roblox).

## Código Luau no Studio (quando precisar de lógica)
Execute Luau no Studio:
```
studiolink run tools/build/loja_ui.luau
studiolink run - <<'LUAU'
local p = B.make("Part", { Size = Vector3.new(4, 1, 4), Anchored = true, Parent = workspace })
return p
LUAU
```
- `print`/`warn` e os valores de `return` voltam pro terminal; erros vêm com a linha certa.
- Cada `run` em modo edição vira um passo de Ctrl+Z.
- Prefira scripts de construção **idempotentes** em `tools/build/` (apagam o que criaram antes e recriam).
- Roda com permissão de plugin (InsertService, Selection, ChangeHistoryService, CoreGui...).

Helpers `B` dentro do `run`:
`B.get("Workspace/Map/Spawn")` · `B.make(class, props, parent?)` · `B.find(root, nomeOuClasse)` ·
`B.clear(path)` · `B.tree(path, prof)` · `B.path(inst)`

## Imagens (ícones, texturas, referências)
1. Ícone: `studio_icon_search` (inglês: coin, sword, brain...) → `studio_icon` com `upload: true` → `imageUri` no ImageLabel.
2. Textura: `studio_texture` (studs, grid, dots, stripes, checker) com `upload: true` → objeto `Texture`.
3. Não achou na biblioteca: procure na internet uma imagem com licença livre (CC0, CC BY, MIT), baixe com
   `curl -L -o assets/refs/<nome>.png <url>`, anote fonte e licença em `assets/CREDITOS.md` e suba com `studio_image_upload`.
   Nunca suba arte de outros jogos, marcas ou personagens conhecidos.

## Testar (você mesmo, sempre)
1. `studiolink play test` (com jogador) ou `play run` (só servidor). Rodam numa cópia do place.
2. `status` mostra `server` online e `client: via server`.
3. Execute dentro do teste: `studiolink eval "return #game.Players:GetPlayers()" --target server`
   ou `--target client` (LocalPlayer, câmera, PlayerGui). O client passa pelo server porque não pode fazer HTTP.
4. `studiolink logs 50` (`--role server|client|edit`) pra ver o Output.
5. `studiolink play stop`.
Não diga que algo funciona sem ter testado assim.

## Quando o Claude não roda neste PC (sessão na nuvem)
Grave `.bridge/inbox/<id>.json` com `{ "target": "edit", "cmd": { "type": "run", "code": "..." } }`
(ou `"file": "tools/x.luau"` no lugar de `code`) e leia a resposta em `.bridge/outbox/<id>.json`.
Os `type` são os mesmos do CLI: status, run, tree, logs, play, snapshot, pushall, restart.
O log do servidor fica em `.bridge/server.log`.

## Atualizar a ponte
O StudioLink é instalado uma vez (pasta do StudioLink → `install.cmd`) e vale pra todos os projetos.
Depois de atualizar lá: `studiolink restart` aqui pra recarregar o servidor deste projeto.

## Limitações atuais
- Você não vê a tela. Valide por código (tamanhos, posições, propriedades) e peça print quando o visual importar.
- Imagens/meshes novas precisam de upload (Open Cloud): chave salva com `studiolink key` (vale pra todos os projetos).

## Estilo do jogo
(Preencher: paleta, fontes, corner radius padrão, estilo de UI e de build, convenções de código.)
