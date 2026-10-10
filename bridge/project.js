'use strict';
// Acha o projeto StudioLink: sobe de pasta em pasta a partir de onde o comando rodou até achar um studiolink.json.
const fs = require('fs');
const path = require('path');

function findRoot(start) {
  if (process.env.STUDIOLINK_ROOT) return path.resolve(process.env.STUDIOLINK_ROOT);
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
  const port = Number(process.env.BRIDGE_PORT) || Number(config.port) || 34880;
  return { root, config, port, name: config.name || (root ? path.basename(root) : 'sem projeto') };
}

const VERSION = require('../package.json').version;

module.exports = { findRoot, loadProject, VERSION };
