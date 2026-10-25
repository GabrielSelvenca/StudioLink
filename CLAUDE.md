# StudioLink (código da ponte)

Este repositório é o próprio StudioLink, não um jogo. Instalado no PC com `install.cmd` (npm link global).

- `bin/studiolink.js`: comando global. `init`/`start`/`plugin`/`mcp`/`version`; o resto vai pra `bridge/cli.js`.
- `bridge/project.js`: acha o projeto subindo pastas até um `studiolink.json`. Versão vem do `package.json`.
- `bridge/server.js`: um por projeto (cwd = projeto). Mudou? `studiolink restart` no projeto.
- `bridge/sync.js`: sync de `src/` com o Studio (junção ao reconectar, backups). Teste: `node bridge/sync.test.js`.
- `bridge/mcp.js`: registrado uma vez com `claude mcp add -s user`; o projeto é a pasta onde o Claude abriu.
- `plugin/StudioLink.server.lua`: depois de mudar, `studiolink plugin` (o Studio recarrega sozinho).
  A versão do plugin instalado sai do `package.json`.
- `template/`: o que o `init` copia pros projetos (CLAUDE.md do jogo, settings do Claude Code).

Fluxo de atualização: editar → `node bridge/sync.test.js` e `studiolink selftest` num projeto → subir a versão
no `package.json` → `git commit` → `git push` → `install.cmd`.
