# StudioLink (código da ponte)

Este repositório é o próprio StudioLink, não um jogo. Instalado no PC com `install.cmd` (npm link global).

- `bin/studiolink.js`: comando global. `init`/`start`/`plugin`/`mcp`/`version`; o resto vai pra `bridge/cli.js`.
- `bridge/project.js`: acha o projeto subindo pastas até um `studiolink.json`. Versão vem do `package.json`.
- `bridge/server.js`: um por projeto (cwd = projeto). Mudou? `studiolink restart` no projeto.
- `bridge/mcp.js`: registrado uma vez com `claude mcp add -s user`; o projeto é a pasta onde o Claude abriu.
- `plugin/StudioLink.server.lua`: depois de mudar, `studiolink plugin` (o Studio recarrega sozinho).
  Mantenha `VERSION` do plugin igual ao `package.json`.
- `template/`: o que o `init` copia pros projetos (CLAUDE.md do jogo, settings do Claude Code).

Fluxo de atualização: editar → testar num projeto (`studiolink selftest`) → subir a versão no `package.json`
e no plugin → `git commit` → `git push` → `install.cmd`.
