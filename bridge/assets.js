'use strict';
// Biblioteca local de ícones + gerador de texturas (roda no PC, sem internet depois de baixar).
//   Fontes: Fluent Emoji (Microsoft, MIT, coloridos) e game-icons.net (CC BY 3.0, silhuetas pra colorir).
//   studiolink library            baixa/atualiza a biblioteca em <StudioLink>/library
//   studiolink icons <busca>      procura ícones
//   studiolink icon <id> [...]    gera PNG (cor, contorno, sombra) e opcionalmente sobe pro Roblox
//   studiolink texture <tipo>     gera textura repetível (studs, grid, dots, stripes, checker)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = path.join(__dirname, '..');
const LIB = path.join(PKG, 'library');
const INDEX = path.join(LIB, 'index.json');

const SOURCES = {
  fluent: {
    repo: 'https://github.com/microsoft/fluentui-emoji.git', dir: 'fluentui-emoji',
    sparse: ['/assets/*/metadata.json', '/assets/*/Color/*.svg', '/LICENSE'],
    license: 'MIT (Microsoft Fluent Emoji) — sem crédito obrigatório',
  },
  gi: {
    repo: 'https://github.com/game-icons/icons.git', dir: 'game-icons',
    license: 'CC BY 3.0 (game-icons.net) — ponha o crédito "Ícones: game-icons.net" na descrição do jogo',
  },
};

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function download(log = console.log) {
  fs.mkdirSync(LIB, { recursive: true });
  for (const [key, s] of Object.entries(SOURCES)) {
    const dest = path.join(LIB, s.dir);
    if (fs.existsSync(path.join(dest, '.git'))) {
      log(`atualizando ${key}...`);
      git(['pull', '--ff-only', '-q'], dest);
      continue;
    }
    log(`baixando ${key} (${s.repo})...`);
    if (s.sparse) {
      git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', s.repo, s.dir], LIB);
      git(['sparse-checkout', 'set', '--no-cone', ...s.sparse], dest);
    } else {
      git(['clone', '-q', '--depth', '1', s.repo, s.dir], LIB);
    }
  }
  const n = buildIndex();
  log(`biblioteca pronta: ${n} ícones em ${LIB}`);
  return n;
}

const slug = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildIndex() {
  const items = [];
  const fe = path.join(LIB, SOURCES.fluent.dir, 'assets');
  if (fs.existsSync(fe)) {
    for (const name of fs.readdirSync(fe)) {
      const colorDir = path.join(fe, name, 'Color');
      let svg;
      try { svg = fs.readdirSync(colorDir).find((f) => f.endsWith('.svg')); } catch {}
      if (!svg) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(fe, name, 'metadata.json'), 'utf8')); } catch {}
      items.push({ id: 'fluent/' + slug(name), name, words: slug(name).split('-'), kw: [...new Set([...(meta.keywords || []).flatMap((k) => slug(k).split('-')), slug(meta.group || '')])].filter(Boolean),
        file: path.relative(LIB, path.join(colorDir, svg)), style: 'color', src: 'fluent' });
    }
  }
  const gi = path.join(LIB, SOURCES.gi.dir);
  if (fs.existsSync(gi)) {
    for (const author of fs.readdirSync(gi)) {
      const dir = path.join(gi, author);
      if (!fs.statSync(dir).isDirectory() || author.startsWith('.')) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.svg')) continue;
        const name = f.slice(0, -4);
        items.push({ id: `gi/${name}`, name: name.replace(/-/g, ' '), words: name.split('-'), author, file: path.relative(LIB, path.join(dir, f)), style: 'silhouette', src: 'gi' });
      }
    }
  }
  // ids repetidos no game-icons (mesmo nome, autores diferentes): sufixo com o autor
  const seen = new Map();
  for (const it of items) seen.set(it.id, (seen.get(it.id) || 0) + 1);
  for (const it of items) if (seen.get(it.id) > 1 && it.src === 'gi') it.id = `gi/${it.author}/${it.file.split(/[\\/]/).pop().slice(0, -4)}`;
  fs.writeFileSync(INDEX, JSON.stringify(items));
  return items.length;
}

let cache = null;
function index() {
  if (cache) return cache;
  if (!fs.existsSync(INDEX)) throw new Error('biblioteca não baixada: rode "studiolink library"');
  cache = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  return cache;
}

// busca em inglês (os nomes das fontes são em inglês). Ex.: "coin", "sword", "money bag"
function search(query, { limit = 20, style } = {}) {
  const q = slug(query);
  const terms = q.split('-').filter(Boolean);
  const out = [];
  for (const it of index()) {
    if (style && it.style !== style) continue;
    const kw = it.kw || [];
    let score = it.words.join('-') === q ? 10 : 0;
    for (const t of terms) {
      if (it.words.includes(t)) score += 4;
      else if (kw.includes(t)) score += 2;
      else if (it.words.some((w) => w.startsWith(t)) || kw.some((w) => w.startsWith(t))) score += 1;
      else { score = 0; break; }
    }
    if (score > 0) out.push({ score: score + (it.style === 'color' ? 0.5 : 0) - it.words.length * 0.01, it });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ it }) => ({ id: it.id, name: it.name, style: it.style }));
}

function find(id) {
  const it = index().find((x) => x.id === id) || index().find((x) => x.id.endsWith('/' + id));
  if (!it) throw new Error(`ícone "${id}" não existe. Procure com: studiolink icons <palavra>`);
  return it;
}

function attr(svg, name) {
  const m = svg.match(new RegExp(`<svg[^>]*\\s${name}="([^"]+)"`));
  return m && m[1];
}

// monta o SVG final: ícone + contorno grosso + sombra embaixo (estilo cartoon de jogo Roblox)
function iconSvg(it, o = {}) {
  let raw = fs.readFileSync(path.join(LIB, it.file), 'utf8');
  const size = 512;
  const outline = o.outline === 'none' ? null : (o.outline || '#000000');
  const thick = o.thick !== undefined ? Number(o.thick) : 14;
  const shadow = o.shadow !== undefined ? Number(o.shadow) : 10;
  const pad = outline ? thick + shadow + 14 : 8;
  let inner;
  if (it.style === 'silhouette') {
    // game-icons: 1º path é o fundo preto; o resto é o desenho (branco). Recolore.
    raw = raw.replace(/<path d="M0 0h512v512H0z"\s*\/>/, '');
    const fill = o.color || '#ffffff';
    const grad = o.gradient !== false;
    const defs = grad ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(fill, 0.25)}"/><stop offset="1" stop-color="${fill}"/></linearGradient></defs>` : '';
    const body = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/fill="[^"]*"/g, '');
    inner = `<svg x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" viewBox="0 0 512 512">${defs}<g fill="${grad ? 'url(#g)' : fill}">${body}</g></svg>`;
  } else {
    const vb = attr(raw, 'viewBox') || '0 0 32 32';
    const body = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    inner = `<svg x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" viewBox="${vb}">${body}</svg>`;
  }
  const filter = outline ? `<filter id="ol" x="-10%" y="-10%" width="120%" height="120%">
    <feMorphology in="SourceAlpha" operator="dilate" radius="${thick}" result="d"/>
    <feFlood flood-color="${outline}"/><feComposite in2="d" operator="in" result="o"/>
    <feOffset in="o" dy="${shadow}" result="s0"/><feFlood flood-color="#000" flood-opacity="0.45"/><feComposite in2="s0" operator="in" result="s"/>
    <feMerge><feMergeNode in="s"/><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs>${filter}</defs><g${outline ? ' filter="url(#ol)"' : ''}>${inner}</g></svg>`;
}

function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function lighten(h, k) { const [r, g, b] = hexToRgb(h); return rgbToHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k); }
function darken(h, k) { const [r, g, b] = hexToRgb(h); return rgbToHex(r * (1 - k), g * (1 - k), b * (1 - k)); }

function render(svg, width) {
  let Resvg;
  try { ({ Resvg } = require('@resvg/resvg-js')); } catch { throw new Error('falta a dependência de render: rode o install.cmd do StudioLink de novo'); }
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng();
}

function icon(id, o = {}) {
  const it = find(id);
  const png = render(iconSvg(it, o), Number(o.size) || 512);
  return { png, it, license: SOURCES[it.src].license };
}

// texturas repetíveis (1 tile = 1 repetição; use em Texture com StudsPerTileU/V)
function textureSvg(kind, o = {}) {
  const c = o.color || '#a3a2a5';
  const hi = lighten(c, 0.35), lo = darken(c, 0.3), mid = darken(c, 0.12);
  const S = 256;
  switch (kind) {
    case 'studs': return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
      <defs><radialGradient id="t" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs>
      <rect width="${S}" height="${S}" fill="${c}"/>
      <circle cx="${S / 2 + 6}" cy="${S / 2 + 8}" r="${S * 0.3}" fill="${lo}" opacity="0.55"/>
      <circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.3}" fill="url(#t)" stroke="${mid}" stroke-width="4"/>
      <circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.22}" fill="none" stroke="${hi}" stroke-width="3" opacity="0.5"/></svg>`;
    case 'grid': return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${c}"/>
      <rect x="2" y="2" width="${S - 4}" height="${S - 4}" fill="none" stroke="${lo}" stroke-width="6"/></svg>`;
    case 'dots': return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${c}"/>
      <circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.18}" fill="${hi}"/></svg>`;
    case 'stripes': return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${c}"/>
      <path d="M0 0 L${S / 2} 0 L0 ${S / 2} Z M${S} 0 L${S} ${S / 2} L${S / 2} ${S} L0 ${S} Z" fill="${mid}"/></svg>`;
    case 'checker': return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="${c}"/>
      <rect width="${S / 2}" height="${S / 2}" fill="${mid}"/><rect x="${S / 2}" y="${S / 2}" width="${S / 2}" height="${S / 2}" fill="${mid}"/></svg>`;
    default: throw new Error('tipo de textura: studs, grid, dots, stripes, checker');
  }
}

function texture(kind, o = {}) {
  return render(textureSvg(kind, o), Number(o.size) || 256);
}

// ids já enviados (não sobe a mesma imagem duas vezes)
const UPLOADED = path.join(LIB, 'uploaded.json');
function uploadedGet(hash) { try { return JSON.parse(fs.readFileSync(UPLOADED, 'utf8'))[hash]; } catch { return undefined; } }
function uploadedSet(hash, val) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(UPLOADED, 'utf8')); } catch {}
  all[hash] = val;
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(UPLOADED, JSON.stringify(all, null, 1));
}

module.exports = { download, buildIndex, search, icon, iconSvg, texture, textureSvg, uploadedGet, uploadedSet, SOURCES, LIB };
