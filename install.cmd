@echo off
chcp 65001 >nul
title Instalador do StudioLink
cd /d "%~dp0"
echo.
echo   StudioLink - instalador
echo   =======================
echo.
where node >nul 2>nul || (echo Node.js nao encontrado. Instale o Node 20+ em https://nodejs.org e rode de novo. & pause & exit /b 1)

echo [1/4] Instalando o comando "studiolink"...
call npm install --omit=dev --no-fund --no-audit || goto erro
call npm install -g . --no-fund --no-audit || goto erro

echo.
echo [2/4] Instalando o plugin no Roblox Studio...
call node bin\studiolink.js plugin || goto erro

echo.
if not exist .env copy .env.example .env >nul
echo [3/4] Registrando o MCP no Claude Code (vale pra todos os projetos)...
where claude >nul 2>nul
if errorlevel 1 (
  echo   Claude Code nao encontrado no PATH, pulei. Depois rode:
  echo   claude mcp add -s user studiolink -- node "%~dp0bridge\mcp.js"
) else (
  call claude mcp remove -s user studiolink >nul 2>nul
  call claude mcp add -s user studiolink -- node "%~dp0bridge\mcp.js"
)

echo.
echo [4/4] Baixando/atualizando a biblioteca de icones...
call node bin\studiolink.js library || echo   (sem internet? rode "studiolink library" depois)

echo.
for /f %%v in ('node bin\studiolink.js version') do echo Pronto! StudioLink %%v instalado.
echo Num projeto novo: abra o terminal na pasta do jogo e rode "studiolink init".
echo.
if not "%1"=="/q" pause
exit /b 0

:erro
echo.
echo Deu erro na instalacao (veja acima).
if not "%1"=="/q" pause
exit /b 1
