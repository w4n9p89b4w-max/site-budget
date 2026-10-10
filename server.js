// ============================================================
// Budget Mensuel - API Server
// Port 3003 - Node.js + SQLite
// ============================================================
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3003;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'budget.db');

// Utilisateurs autorises (login simple par prenom)
const USERS = ['etienne', 'noa'];

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));

// ── Base de donnees ──
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    label TEXT NOT NULL,
    cat TEXT,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    bank TEXT,
    need TEXT,
    auto INTEGER DEFAULT 0,
    transfer_pair INTEGER,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS budget (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    grp TEXT NOT NULL,
    icon TEXT,
    builtin INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    cat TEXT,
    bank TEXT,
    amount REAL NOT NULL,
    day INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applied_months (
    month_key TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS epargne (
    key TEXT PRIMARY KEY,
    verse REAL DEFAULT 0,
    objectif REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    solde REAL DEFAULT 0,
    solde_date TEXT,
    solde_set_at INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_by TEXT
  );
`);

// Colonnes ajoutees apres coup : on les cree si la base ne les a pas encore
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
  if (!cols.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
}
addColumnIfMissing('transactions', 'affect_year', 'INTEGER');
addColumnIfMissing('transactions', 'affect_month_num', 'INTEGER');
addColumnIfMissing('recurring', 'next_month', 'INTEGER DEFAULT 0');
addColumnIfMissing('accounts', 'bank_key', 'TEXT');
addColumnIfMissing('accounts', 'acc_type', 'TEXT');
addColumnIfMissing('accounts', 'description', 'TEXT');
// Options du parcours d ajout : rembourse, a payer plus tard, hors solde, voyage
addColumnIfMissing('transactions', 'remb', 'INTEGER DEFAULT 0');
addColumnIfMissing('transactions', 'later_pay', 'INTEGER DEFAULT 0');
addColumnIfMissing('transactions', 'no_balance', 'INTEGER DEFAULT 0');
addColumnIfMissing('transactions', 'trip', 'TEXT');
// Transferts reguliers (compte destination) et premier mois d application
addColumnIfMissing('recurring', 'to_bank', 'TEXT');
addColumnIfMissing('recurring', 'start_key', 'TEXT');
// Compte masque sur l accueil (hors Total Patrimoine)
addColumnIfMissing('accounts', 'hidden', 'INTEGER DEFAULT 0');
// Page Budget : type d operation reguliere (dep, rev, tra) et lien transaction <-> echeance confirmee
addColumnIfMissing('recurring', 'kind', 'TEXT');
addColumnIfMissing('transactions', 'rec_key', 'TEXT');
// Reglages libres en JSON (groupes du budget...)
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

// ── Middleware auth ──
function requireAuth(req, res, next) {
  const user = (req.headers['x-user'] || '').toLowerCase().trim();
  if (!USERS.includes(user)) {
    return res.status(401).json({ error: 'Utilisateur non reconnu. Login requis.' });
  }
  req.user = user;
  next();
}

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'budget-mensuel-api', port: PORT });
});

// ── Login ──
app.post('/api/login', (req, res) => {
  const prenom = (req.body.prenom || '').toLowerCase().trim();
  if (USERS.includes(prenom)) {
    res.json({ ok: true, user: prenom });
  } else {
    res.status(401).json({ ok: false, error: 'Prenom non reconnu' });
  }
});

// ── TRANSACTIONS ──
app.get('/api/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC').all();
  res.json(rows);
});

app.post('/api/transactions', requireAuth, (req, res) => {
  const t = req.body;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, date, label, cat, amount, type, bank, need, auto, transfer_pair, created_by, affect_year, affect_month_num, remb, later_pay, no_balance, trip, rec_key)
    VALUES (@id, @date, @label, @cat, @amount, @type, @bank, @need, @auto, @transfer_pair, @created_by, @affect_year, @affect_month_num, @remb, @later_pay, @no_balance, @trip, @rec_key)
  `);
  const info = stmt.run({
    id: t.id || Date.now(),
    date: t.date,
    label: t.label,
    cat: t.cat || '',
    amount: parseFloat(t.amount) || 0,
    type: t.type || 'dep',
    bank: t.bank || '',
    need: t.need || '',
    auto: t.auto ? 1 : 0,
    transfer_pair: t.transfer_pair || null,
    created_by: req.user,
    affect_year: t.affect_year || null,
    affect_month_num: t.affect_month_num !== undefined ? t.affect_month_num : null,
    remb: t.remb ? 1 : 0,
    later_pay: t.later_pay ? 1 : 0,
    no_balance: t.no_balance ? 1 : 0,
    trip: t.trip || null,
    rec_key: t.rec_key || null
  });
  res.json({ ok: true, id: t.id || info.lastInsertRowid });
});

// Import en masse (releve bancaire, depenses recurrentes)
app.post('/api/transactions/bulk', requireAuth, (req, res) => {
  const txns = req.body.transactions || [];
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, date, label, cat, amount, type, bank, need, auto, transfer_pair, created_by, affect_year, affect_month_num, remb, later_pay, no_balance, trip, rec_key)
    VALUES (@id, @date, @label, @cat, @amount, @type, @bank, @need, @auto, @transfer_pair, @created_by, @affect_year, @affect_month_num, @remb, @later_pay, @no_balance, @trip, @rec_key)
  `);
  const insertMany = db.transaction((items) => {
    for (const t of items) {
      insert.run({
        id: t.id || Date.now() + Math.random(),
        date: t.date,
        label: t.label,
        cat: t.cat || '',
        amount: parseFloat(t.amount) || 0,
        type: t.type || 'dep',
        bank: t.bank || '',
        need: t.need || '',
        auto: t.auto ? 1 : 0,
        transfer_pair: t.transfer_pair || null,
        created_by: req.user,
        affect_year: t.affect_year || null,
        affect_month_num: t.affect_month_num !== undefined ? t.affect_month_num : null,
        remb: t.remb ? 1 : 0,
        later_pay: t.later_pay ? 1 : 0,
        no_balance: t.no_balance ? 1 : 0,
        trip: t.trip || null,
        rec_key: t.rec_key || null
      });
    }
  });
  insertMany(txns);
  res.json({ ok: true, count: txns.length });
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── REGLAGES (JSON libre : groupes du budget...) ──
app.get('/api/settings', requireAuth, (req, res) => {
  const out = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { try { out[r.key] = JSON.parse(r.value); } catch (e) {} });
  res.json(out);
});
app.post('/api/settings/:key', requireAuth, (req, res) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(req.params.key, JSON.stringify(req.body.value));
  res.json({ ok: true });
});

// ── BUDGET (montants mensuels de reference) ──
app.get('/api/budget', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM budget').all();
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

app.post('/api/budget', requireAuth, (req, res) => {
  const data = req.body;
  const upsert = db.prepare(`
    INSERT INTO budget (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const upsertMany = db.transaction((obj) => {
    for (const [key, value] of Object.entries(obj)) {
      upsert.run(key, parseFloat(value) || 0);
    }
  });
  upsertMany(data);
  res.json({ ok: true });
});

// ── CATEGORIES ──
app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order, key').all();
  res.json(rows.map(r => ({
    key: r.key, label: r.label, group: r.grp, icon: r.icon, builtin: !!r.builtin
  })));
});

app.post('/api/categories', requireAuth, (req, res) => {
  const cats = req.body.categories || [];
  const upsert = db.prepare(`
    INSERT INTO categories (key, label, grp, icon, builtin, sort_order)
    VALUES (@key, @label, @grp, @icon, @builtin, @sort_order)
    ON CONFLICT(key) DO UPDATE SET label=excluded.label, grp=excluded.grp, icon=excluded.icon, sort_order=excluded.sort_order
  `);
  const upsertMany = db.transaction((items) => {
    items.forEach((c, i) => upsert.run({
      key: c.key, label: c.label, grp: c.group, icon: c.icon || '',
      builtin: c.builtin ? 1 : 0, sort_order: i
    }));
  });
  upsertMany(cats);
  res.json({ ok: true });
});

app.delete('/api/categories/:key', requireAuth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE key = ? AND builtin = 0').run(req.params.key);
  res.json({ ok: true });
});

// ── DEPENSES RECURRENTES ──
app.get('/api/recurring', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM recurring ORDER BY id').all());
});

app.post('/api/recurring', requireAuth, (req, res) => {
  const r = req.body;
  // Mise a jour d une operation reguliere existante
  if (r.id) {
    db.prepare('UPDATE recurring SET label=?, cat=?, bank=?, amount=?, day=?, to_bank=?, kind=? WHERE id=?')
      .run(r.label, r.cat || '', r.bank || '', parseFloat(r.amount) || 0, parseInt(r.day)||1, r.to_bank || null, r.kind || null, r.id);
    return res.json({ ok: true, id: r.id });
  }
  const info = db.prepare(
    'INSERT INTO recurring (label, cat, bank, amount, day, next_month, to_bank, start_key, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(r.label, r.cat || '', r.bank || '', parseFloat(r.amount) || 0, parseInt(r.day)||1, parseInt(r.next_month)||0, r.to_bank || null, r.start_key || null, r.kind || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/recurring/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM recurring WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── MOIS APPLIQUES (depenses fixes auto) ──
app.get('/api/applied-months', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT month_key FROM applied_months').all();
  const result = {};
  rows.forEach(r => result[r.month_key] = true);
  res.json(result);
});

app.post('/api/applied-months/:key', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO applied_months (month_key) VALUES (?)').run(req.params.key);
  res.json({ ok: true });
});

// ── EPARGNE ──
app.get('/api/epargne', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, verse, objectif FROM epargne').all();
  const result = {};
  rows.forEach(r => result[r.key] = { verse: r.verse, objectif: r.objectif });
  res.json(result);
});

app.post('/api/epargne/:key', requireAuth, (req, res) => {
  const { verse, objectif } = req.body;
  db.prepare(`
    INSERT INTO epargne (key, verse, objectif, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET verse=excluded.verse, objectif=excluded.objectif, updated_at=excluded.updated_at
  `).run(req.params.key, parseFloat(verse)||0, parseFloat(objectif)||0);
  res.json({ ok: true });
});

// ── COMPTES BANCAIRES ──
function accountFromRow(r) {
  return {
    id: r.id, name: r.name, color: r.color, solde: r.solde, soldeDate: r.solde_date, soldeSetAt: r.solde_set_at,
    bank: r.bank_key || '', type: r.acc_type || '', description: r.description || '', hidden: !!r.hidden
  };
}

app.get('/api/accounts', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all().map(accountFromRow));
});

// Cree ou met a jour un compte
app.post('/api/accounts', requireAuth, (req, res) => {
  const a = req.body;
  if (!a.name) return res.status(400).json({ error: 'Nom du compte manquant' });
  const id = a.id || Date.now();
  db.prepare(`
    INSERT INTO accounts (id, name, color, solde, solde_date, solde_set_at, sort_order, created_by, bank_key, acc_type, description, hidden)
    VALUES (@id, @name, @color, @solde, @solde_date, @solde_set_at, @sort_order, @created_by, @bank_key, @acc_type, @description, @hidden)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, solde=excluded.solde,
      solde_date=excluded.solde_date, solde_set_at=excluded.solde_set_at, sort_order=excluded.sort_order,
      bank_key=excluded.bank_key, acc_type=excluded.acc_type, description=excluded.description, hidden=excluded.hidden
  `).run({
    id: id,
    name: a.name,
    color: a.color || '',
    solde: parseFloat(a.solde) || 0,
    solde_date: a.soldeDate || null,
    solde_set_at: a.soldeSetAt || null,
    sort_order: parseInt(a.sortOrder) || 0,
    created_by: req.user,
    bank_key: a.bank || '',
    acc_type: a.type || '',
    description: a.description || '',
    hidden: a.hidden ? 1 : 0
  });
  res.json({ ok: true, id: id });
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Servir les fichiers statiques du site ──
const PUBLIC = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(PUBLIC, 'index.html'));
  });
} else {
  // En local (pas de dossier public) : on sert seulement index.html a cote du serveur
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('Budget Mensuel API demarree sur le port ' + PORT);
  console.log('DB: ' + DB_PATH);
});
