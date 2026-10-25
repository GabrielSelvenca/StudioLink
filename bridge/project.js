'use strict';
// Acha o projeto (a pasta com studiolink.json, subindo a partir do cwd) e fala com o servidor dele.
const fs = require('fs');
const http = require('http');
const path = require('path');

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, 'studiolink.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function loadProject(start) {
  const root = findRoot(start);
  let config = {};
  if (root) try { config = JSON.parse(fs.readFileSync(path.join(root, 'studiolink.json'), 'utf8')); } catch {}
  const port = Number(config.port) || 34880;
  return { root, config, port, name: config.name || (root ? path.basename(root) : 'sem projeto') };
}

// Segundos que o CLI/MCP esperam por cada tipo de comando (o resto: 60).
const TIMEOUTS = { selftest: 180, play: 120, upload: 240, image: 240, icon: 240, texture: 240 };
function timeoutFor(cmd) {
  if (cmd.type === 'blender') return (Number(cmd.timeout) || 300) + 30; // o Blender tem o próprio limite
  if (Number(cmd.timeout)) return Number(cmd.timeout);
  if (cmd.type === 'fuzz') return (Number(cmd.seconds) || 40) + 150;
  return TIMEOUTS[cmd.type] || 60;
}

// POST /cmd no servidor do projeto. Nunca rejeita: falha vira { ok: false, error }.
function post(port, body, timeoutSec) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/cmd', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Bridge': '1' },
      timeout: (timeoutSec + 10) * 1000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false, error: 'resposta inválida: ' + raw }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout falando com o servidor do projeto')));
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED'
      ? `servidor do projeto não está rodando na porta ${port}: rode "studiolink start" na pasta do jogo` : String(e.message || e) }));
    req.end(data);
  });
}

const VERSION = require('../package.json').version;

module.exports = { findRoot, loadProject, timeoutFor, post, VERSION };
