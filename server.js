// Serveur local de développement : sert index.html et imite l'API du site en ligne.
// Les données sont stockées dans data/<prenom>.json (aucun lien avec les vraies données).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

function emptyStore() {
  return { transactions: [], budget: {}, categories: [], recurring: [], applied: {} };
}

function load(user) {
  const file = path.join(DATA_DIR, safeName(user) + '.json');
  try { return Object.assign(emptyStore(), JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { return emptyStore(); }
}

function save(user, store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, safeName(user) + '.json'), JSON.stringify(store, null, 2));
}

function safeName(user) { return String(user || 'anonyme').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'anonyme'; }

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
  });
}

function sortTxns(arr) { arr.sort((a, b) => String(b.date).localeCompare(String(a.date))); }

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const resource = parts[1];
  const id = parts[2];
  const method = req.method;
  const body = method === 'POST' ? await readBody(req) : {};

  if (resource === 'login' && method === 'POST') {
    return body.prenom ? send(res, 200, { ok: true }) : send(res, 400, { error: 'prenom manquant' });
  }
  if (resource === 'scan-ticket') {
    return send(res, 501, { error: 'Scan de ticket non disponible en local' });
  }

  const user = req.headers['x-user'];
  const store = load(user);

  switch (resource) {
    case 'transactions':
      if (method === 'GET') return send(res, 200, store.transactions);
      if (method === 'POST' && id === 'bulk') {
        store.transactions.push(...(body.transactions || []));
        sortTxns(store.transactions); save(user, store);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST') {
        store.transactions.push(body); sortTxns(store.transactions); save(user, store);
        return send(res, 200, { ok: true, id: body.id });
      }
      if (method === 'DELETE') {
        store.transactions = store.transactions.filter((t) => String(t.id) !== id); save(user, store);
        return send(res, 200, { ok: true });
      }
      break;
    case 'budget':
      if (method === 'GET') return send(res, 200, store.budget);
      if (method === 'POST') { store.budget = body; save(user, store); return send(res, 200, { ok: true }); }
      break;
    case 'categories':
      if (method === 'GET') return send(res, 200, store.categories);
      if (method === 'POST') { store.categories = body.categories || []; save(user, store); return send(res, 200, { ok: true }); }
      break;
    case 'recurring':
      if (method === 'GET') return send(res, 200, store.recurring);
      if (method === 'POST') {
        const item = Object.assign({ id: Date.now() }, body);
        store.recurring.push(item); save(user, store);
        return send(res, 200, { ok: true, id: item.id });
      }
      if (method === 'DELETE') {
        store.recurring = store.recurring.filter((r) => String(r.id) !== id); save(user, store);
        return send(res, 200, { ok: true });
      }
      break;
    case 'applied-months':
      if (method === 'GET') return send(res, 200, store.applied);
      if (method === 'POST' && id) { store.applied[id] = true; save(user, store); return send(res, 200, { ok: true }); }
      break;
  }
  send(res, 404, { error: 'Route inconnue' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Autorise la page ouverte directement depuis le disque (file://)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => send(res, 500, { error: e.message }));
    return;
  }
  // Fichiers statiques (index.html par défaut)
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}).listen(PORT, () => {
  console.log('Budget Mensuel en local : http://localhost:' + PORT);
});
