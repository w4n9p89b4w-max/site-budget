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
const crypto = require('crypto');
// Envoi des mails (mot de passe oublie) : facultatif, voir mail.config.json
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3003;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'budget.db');
// Comptes administrateurs (par mail) : ils voient la liste de tous les comptes du site
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'etienne@ecotole.re').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);


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
// Mois du compte : vide = calendaire (1 -> 31), sinon id du revenu regulier (paie) qui fait commencer le mois
addColumnIfMissing('accounts', 'cycle_rec', 'TEXT');
// Proprietaire du compte : etienne, noa ou vide (commun)
addColumnIfMissing('accounts', 'owner', 'TEXT');
// Devise du compte (vide = devise du site)
addColumnIfMissing('accounts', 'currency', 'TEXT');
// Page Budget : type d operation reguliere (dep, rev, tra) et lien transaction <-> echeance confirmee
addColumnIfMissing('recurring', 'kind', 'TEXT');
// Frequence : month (defaut), week, day (tous les "every" jours), year ; anchor = date de la premiere echeance
addColumnIfMissing('recurring', 'freq', 'TEXT');
addColumnIfMissing('recurring', 'every', 'INTEGER');
addColumnIfMissing('recurring', 'anchor', 'TEXT');
addColumnIfMissing('recurring', 'end_date', 'TEXT');
addColumnIfMissing('transactions', 'rec_key', 'TEXT');
addColumnIfMissing('transactions', 'note', 'TEXT');
// Reglages libres en JSON (groupes du budget...)
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

// ── Comptes utilisateurs et foyers ──
// Un foyer = jusqu a 3 utilisateurs qui partagent les memes donnees.
// Les anciennes donnees (sans foyer) sont mises de cote : elles restent dans la base mais ne sont plus visibles.
db.exec(`
  CREATE TABLE IF NOT EXISTS households (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    login TEXT UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, household_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, household_id INTEGER NOT NULL, created_by INTEGER, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0);
`);
addColumnIfMissing('transactions', 'household_id', 'INTEGER');
addColumnIfMissing('accounts', 'household_id', 'INTEGER');
addColumnIfMissing('recurring', 'household_id', 'INTEGER');

const MAX_MEMBERS = 3;
const SESSION_DAYS = 60;
const DAY = 86400000;

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
// Mot de passe : on ne garde qu une empreinte (scrypt + sel), jamais le mot de passe lui-meme
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const want = Buffer.from(p[2], 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(p[1], 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_DAYS * DAY);
  return token;
}
function isAdmin(u) { return !!u && ADMIN_EMAILS.indexOf(String(u.email || '').toLowerCase()) >= 0; }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, login: u.login || '', admin: isAdmin(u) }; }
function householdInfo(hid) {
  return { id: hid, members: db.prepare('SELECT id, name FROM users WHERE household_id = ? ORDER BY id').all(hid) };
}

// Trop d essais rates : on bloque quelques minutes (par adresse IP et par identifiant)
const attempts = new Map();
function tooMany(key) { const a = attempts.get(key); return a && a.until > Date.now(); }
function failed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n++; if (a.n >= 5) { a.until = Date.now() + 15 * 60000; a.n = 0; }
  attempts.set(key, a);
}
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

// ── Middleware auth : jeton de session envoye par le site ("Authorization: Bearer ...") ──
function requireAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Connexion requise' });
  const row = db.prepare('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(m[1]));
  if (!row || row.expires_at < Date.now()) return res.status(401).json({ error: 'Session expirée, reconnecte-toi' });
  // la session se prolonge tant qu on utilise le site
  if (row.expires_at - Date.now() < (SESSION_DAYS - 1) * DAY)
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_DAYS * DAY, row.token_hash);
  req.user = row.name; req.uid = row.id; req.hid = row.household_id;
  next();
}
// Cle propre au foyer pour les tables a cle texte (reglages, budget, categories...)
function hk(req, key) { return 'h' + req.hid + '|' + key; }
function unhk(req, key) { const p = 'h' + req.hid + '|'; return key.indexOf(p) === 0 ? key.slice(p.length) : null; }
// Une ligne existante appartenant a un autre foyer ne doit jamais etre ecrasee
function foreignRow(table, id, hid) {
  const r = db.prepare('SELECT household_id FROM ' + table + ' WHERE id = ?').get(id);
  return r && r.household_id !== hid;
}

// ── Envoi des mails ──
function mailConfig() {
  const file = path.join(__dirname, 'mail.config.json');
  let c = {};
  if (fs.existsSync(file)) { try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('mail.config.json illisible'); } }
  c.host = process.env.MAIL_HOST || c.host; c.port = parseInt(process.env.MAIL_PORT || c.port || 465);
  c.user = process.env.MAIL_USER || c.user; c.pass = process.env.MAIL_PASS || c.pass;
  c.from = process.env.MAIL_FROM || c.from || c.user;
  return c.host && c.user && c.pass && nodemailer ? c : null;
}
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return proto + '://' + req.headers.host;
}

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'budget-mensuel-api', port: PORT });
});

// ── Comptes : creation, connexion, mot de passe ──
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/api/auth/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const email = String(req.body.email || '').trim().toLowerCase();
  const login = String(req.body.login || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Indique ton prénom' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Adresse mail invalide' });
  if (login && !/^[a-z0-9._-]{3,30}$/.test(login)) return res.status(400).json({ error: 'Identifiant : 3 à 30 lettres, chiffres, point ou tiret' });
  if (pw.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Un compte existe déjà avec ce mail' });
  if (login && db.prepare('SELECT 1 FROM users WHERE login = ? OR email = ?').get(login, login)) return res.status(409).json({ error: 'Cet identifiant est déjà pris' });
  const hid = db.prepare('INSERT INTO households DEFAULT VALUES').run().lastInsertRowid;
  const uid = db.prepare('INSERT INTO users (name, email, login, pass_hash, household_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, login || null, hashPassword(pw), hid).lastInsertRowid;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.json({ ok: true, token: newSession(uid), user: publicUser(u), household: householdInfo(hid) });
});

app.post('/api/auth/login', (req, res) => {
  const ident = String(req.body.ident || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const kIp = 'ip:' + clientIp(req), kId = 'id:' + ident;
  if (tooMany(kIp) || tooMany(kId)) return res.status(429).json({ error: 'Trop d’essais. Réessaie dans quelques minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE email = ? OR login = ?').get(ident, ident);
  if (!u || !checkPassword(pw, u.pass_hash)) { failed(kIp); failed(kId); return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' }); }
  attempts.delete(kId);
  res.json({ ok: true, token: newSession(u.id), user: publicUser(u), household: householdInfo(u.household_id) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(m[1]));
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
  res.json({ user: publicUser(u), household: householdInfo(req.hid) });
});

// Administration : liste de tous les comptes et foyers (sans mot de passe ni donnees de budget)
app.get('/api/admin/users', requireAuth, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
  if (!isAdmin(me)) return res.status(403).json({ error: 'Réservé à l’administrateur' });
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.login, u.household_id, u.created_at,
      (SELECT MAX(expires_at) FROM sessions s WHERE s.user_id = u.id) AS last_exp
    FROM users u ORDER BY u.household_id, u.id`).all();
  users.forEach(u => {
    // derniere activite deduite de la session la plus recente (prolongee a chaque visite)
    u.last_seen = u.last_exp ? new Date(u.last_exp - SESSION_DAYS * DAY).toISOString() : null;
    delete u.last_exp;
    u.admin = isAdmin(u);
  });
  const households = db.prepare('SELECT id, created_at FROM households ORDER BY id').all();
  res.json({ users, households });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
  if (!checkPassword(String(req.body.current || ''), u.pass_hash)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(req.body.password), u.id);
  res.json({ ok: true });
});

// Mot de passe oublie : un lien valable 1 heure est envoye par mail.
// La reponse est la meme que le mail existe ou non (on ne revele pas qui a un compte).
app.post('/api/auth/forgot', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const kIp = 'forgot:' + clientIp(req);
  if (tooMany(kIp)) return res.status(429).json({ error: 'Trop de demandes. Réessaie plus tard.' });
  failed(kIp);
  const conf = mailConfig();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (u) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), u.id, Date.now() + 3600000);
    const link = siteUrl(req) + '/?reset=' + token;
    if (conf) {
      nodemailer.createTransport({ host: conf.host, port: conf.port, secure: conf.port === 465, auth: { user: conf.user, pass: conf.pass } })
        .sendMail({ from: conf.from, to: u.email, subject: 'Budget Mensuel : nouveau mot de passe',
          text: 'Bonjour ' + u.name + ',\n\nPour choisir un nouveau mot de passe, ouvre ce lien (valable 1 heure) :\n' + link + '\n\nSi tu n’as rien demandé, ignore ce message.' })
        .catch(e => console.log('Envoi du mail impossible : ' + e.message));
    } else {
      // Pas de service de mail configure : le lien n apparait que dans la fenetre du serveur
      console.log('[Mot de passe oublie] ' + u.email + ' -> ' + link);
    }
  }
  res.json({ ok: true, mail: !!conf });
});

app.post('/api/auth/reset', (req, res) => {
  const r = db.prepare('SELECT * FROM resets WHERE token_hash = ?').get(sha256(String(req.body.token || '')));
  if (!r || r.used || r.expires_at < Date.now()) return res.status(400).json({ error: 'Lien expiré ou déjà utilisé. Refais une demande.' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(req.body.password), r.user_id);
  db.prepare('UPDATE resets SET used = 1 WHERE token_hash = ?').run(r.token_hash);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // deconnecte les autres appareils
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  res.json({ ok: true, token: newSession(u.id), user: publicUser(u), household: householdInfo(u.household_id) });
});

// ── Foyer : comptes lies (jusqu a 3) avec un code d invitation ──
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
app.post('/api/household/invite', requireAuth, (req, res) => {
  if (householdInfo(req.hid).members.length >= MAX_MEMBERS) return res.status(400).json({ error: 'Le foyer est complet (3 personnes maximum)' });
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO invites (code, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)').run(code, req.hid, req.uid, Date.now() + DAY);
  res.json({ ok: true, code: code, expires: Date.now() + DAY });
});

app.post('/api/household/join', requireAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const kIp = 'join:' + clientIp(req);
  if (tooMany(kIp)) return res.status(429).json({ error: 'Trop d’essais. Réessaie dans quelques minutes.' });
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv || inv.expires_at < Date.now()) { failed(kIp); return res.status(400).json({ error: 'Code invalide ou expiré' }); }
  if (inv.household_id === req.hid) return res.status(400).json({ error: 'Tu fais déjà partie de ce foyer' });
  if (householdInfo(inv.household_id).members.length >= MAX_MEMBERS) return res.status(400).json({ error: 'Ce foyer est complet (3 personnes maximum)' });
  db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(inv.household_id, req.uid);
  db.prepare('DELETE FROM invites WHERE code = ?').run(code);
  res.json({ ok: true, household: householdInfo(inv.household_id) });
});

// Quitter le foyer : on repart avec un foyer vide
app.post('/api/household/leave', requireAuth, (req, res) => {
  if (householdInfo(req.hid).members.length <= 1) return res.status(400).json({ error: 'Tu es seul dans ce foyer' });
  const hid = db.prepare('INSERT INTO households DEFAULT VALUES').run().lastInsertRowid;
  db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(hid, req.uid);
  res.json({ ok: true, household: householdInfo(hid) });
});

// ── TRANSACTIONS ──
app.get('/api/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE household_id = ? ORDER BY date DESC, id DESC').all(req.hid);
  res.json(rows);
});

app.post('/api/transactions', requireAuth, (req, res) => {
  const t = req.body;
  if (t.id && foreignRow('transactions', t.id, req.hid)) return res.status(403).json({ error: 'Opération introuvable' });
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, date, label, cat, amount, type, bank, need, auto, transfer_pair, created_by, affect_year, affect_month_num, remb, later_pay, no_balance, trip, rec_key, note, household_id)
    VALUES (@id, @date, @label, @cat, @amount, @type, @bank, @need, @auto, @transfer_pair, @created_by, @affect_year, @affect_month_num, @remb, @later_pay, @no_balance, @trip, @rec_key, @note, @household_id)
  `);
  const info = stmt.run({
    id: t.id || Date.now(),
    date: t.date,
    label: t.label,
    cat: t.cat || '',
    amount: parseFloat(t.amount) || 0,
    type: t.type || 'dep',
    bank: t.bank == null ? '' : String(t.bank),
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
    rec_key: t.rec_key || null,
    note: t.note || null,
    household_id: req.hid
  });
  res.json({ ok: true, id: t.id || info.lastInsertRowid });
});

// Import en masse (releve bancaire, depenses recurrentes)
app.post('/api/transactions/bulk', requireAuth, (req, res) => {
  const txns = req.body.transactions || [];
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transactions (id, date, label, cat, amount, type, bank, need, auto, transfer_pair, created_by, affect_year, affect_month_num, remb, later_pay, no_balance, trip, rec_key, note, household_id)
    VALUES (@id, @date, @label, @cat, @amount, @type, @bank, @need, @auto, @transfer_pair, @created_by, @affect_year, @affect_month_num, @remb, @later_pay, @no_balance, @trip, @rec_key, @note, @household_id)
  `);
  const insertMany = db.transaction((items) => {
    for (const t of items) {
      if (t.id && foreignRow('transactions', t.id, req.hid)) continue;
      insert.run({
        id: t.id || Date.now() + Math.random(),
        date: t.date,
        label: t.label,
        cat: t.cat || '',
        amount: parseFloat(t.amount) || 0,
        type: t.type || 'dep',
        bank: t.bank == null ? '' : String(t.bank),
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
        rec_key: t.rec_key || null,
        note: t.note || null,
        household_id: req.hid
      });
    }
  });
  insertMany(txns);
  res.json({ ok: true, count: txns.length });
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ? AND household_id = ?').run(req.params.id, req.hid);
  res.json({ ok: true });
});

// ── REGLAGES (JSON libre : groupes du budget...) ──
app.get('/api/settings', requireAuth, (req, res) => {
  const out = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { const k = unhk(req, r.key); if (k === null) return; try { out[k] = JSON.parse(r.value); } catch (e) {} });
  res.json(out);
});
app.post('/api/settings/:key', requireAuth, (req, res) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(hk(req, req.params.key), JSON.stringify(req.body.value));
  res.json({ ok: true });
});

// ── BUDGET (montants mensuels de reference) ──
app.get('/api/budget', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM budget').all();
  const result = {};
  rows.forEach(r => { const k = unhk(req, r.key); if (k !== null) result[k] = r.value; });
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
      upsert.run(hk(req, key), parseFloat(value) || 0);
    }
  });
  upsertMany(data);
  res.json({ ok: true });
});

// ── CATEGORIES ──
app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order, key').all();
  res.json(rows.filter(r => unhk(req, r.key) !== null).map(r => ({
    key: unhk(req, r.key), label: r.label, group: r.grp, icon: r.icon, builtin: !!r.builtin
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
      key: hk(req, c.key), label: c.label, grp: c.group, icon: c.icon || '',
      builtin: c.builtin ? 1 : 0, sort_order: i
    }));
  });
  upsertMany(cats);
  res.json({ ok: true });
});

app.delete('/api/categories/:key', requireAuth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE key = ? AND builtin = 0').run(hk(req, req.params.key));
  res.json({ ok: true });
});

// ── DEPENSES RECURRENTES ──
app.get('/api/recurring', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM recurring WHERE household_id = ? ORDER BY id').all(req.hid));
});

app.post('/api/recurring', requireAuth, (req, res) => {
  const r = req.body;
  // Mise a jour d une operation reguliere existante
  if (r.id) {
    db.prepare('UPDATE recurring SET label=?, cat=?, bank=?, amount=?, day=?, to_bank=?, kind=? WHERE id=? AND household_id=?')
      .run(r.label, r.cat || '', r.bank == null ? '' : String(r.bank), parseFloat(r.amount) || 0, parseInt(r.day)||1, r.to_bank == null || r.to_bank === '' ? null : String(r.to_bank), r.kind || null, r.id, req.hid);
    return res.json({ ok: true, id: r.id });
  }
  const info = db.prepare(
    'INSERT INTO recurring (label, cat, bank, amount, day, next_month, to_bank, start_key, kind, freq, every, anchor, end_date, household_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(r.label, r.cat || '', r.bank == null ? '' : String(r.bank), parseFloat(r.amount) || 0, parseInt(r.day)||1, parseInt(r.next_month)||0, r.to_bank == null || r.to_bank === '' ? null : String(r.to_bank), r.start_key || null, r.kind || null,
    r.freq || null, parseInt(r.every) || null, r.anchor || null, r.end_date || null, req.hid);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/recurring/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM recurring WHERE id = ? AND household_id = ?').run(req.params.id, req.hid);
  res.json({ ok: true });
});

// ── MOIS APPLIQUES (depenses fixes auto) ──
app.get('/api/applied-months', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT month_key FROM applied_months').all();
  const result = {};
  rows.forEach(r => { const k = unhk(req, r.month_key); if (k !== null) result[k] = true; });
  res.json(result);
});

app.post('/api/applied-months/:key', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO applied_months (month_key) VALUES (?)').run(hk(req, req.params.key));
  res.json({ ok: true });
});

// ── EPARGNE ──
app.get('/api/epargne', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, verse, objectif FROM epargne').all();
  const result = {};
  rows.forEach(r => { const k = unhk(req, r.key); if (k !== null) result[k] = { verse: r.verse, objectif: r.objectif }; });
  res.json(result);
});

app.post('/api/epargne/:key', requireAuth, (req, res) => {
  const { verse, objectif } = req.body;
  db.prepare(`
    INSERT INTO epargne (key, verse, objectif, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET verse=excluded.verse, objectif=excluded.objectif, updated_at=excluded.updated_at
  `).run(hk(req, req.params.key), parseFloat(verse)||0, parseFloat(objectif)||0);
  res.json({ ok: true });
});

// ── COMPTES BANCAIRES ──
function accountFromRow(r) {
  return {
    id: r.id, name: r.name, color: r.color, solde: r.solde, soldeDate: r.solde_date, soldeSetAt: r.solde_set_at,
    bank: r.bank_key || '', type: r.acc_type || '', description: r.description || '', hidden: !!r.hidden,
    cycle: r.cycle_rec || '', owner: r.owner || '', currency: r.currency || ''
  };
}

app.get('/api/accounts', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts WHERE household_id = ? ORDER BY sort_order, id').all(req.hid).map(accountFromRow));
});

// Cree ou met a jour un compte
app.post('/api/accounts', requireAuth, (req, res) => {
  const a = req.body;
  if (!a.name) return res.status(400).json({ error: 'Nom du compte manquant' });
  const id = a.id || Date.now();
  if (foreignRow('accounts', id, req.hid)) return res.status(403).json({ error: 'Compte introuvable' });
  db.prepare(`
    INSERT INTO accounts (id, name, color, solde, solde_date, solde_set_at, sort_order, created_by, bank_key, acc_type, description, hidden, cycle_rec, owner, currency, household_id)
    VALUES (@id, @name, @color, @solde, @solde_date, @solde_set_at, @sort_order, @created_by, @bank_key, @acc_type, @description, @hidden, @cycle_rec, @owner, @currency, @household_id)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, solde=excluded.solde,
      solde_date=excluded.solde_date, solde_set_at=excluded.solde_set_at, sort_order=excluded.sort_order,
      bank_key=excluded.bank_key, acc_type=excluded.acc_type, description=excluded.description, hidden=excluded.hidden,
      cycle_rec=excluded.cycle_rec, owner=excluded.owner, currency=excluded.currency
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
    hidden: a.hidden ? 1 : 0,
    cycle_rec: a.cycle ? String(a.cycle) : null,
    owner: a.owner || null,
    currency: /^[A-Z]{3}$/.test(a.currency || '') ? a.currency : null,
    household_id: req.hid
  });
  res.json({ ok: true, id: id });
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ? AND household_id = ?').run(req.params.id, req.hid);
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

  // Adresse a taper sur l'iPhone (meme Wi-Fi que cet ordinateur)
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('');
  console.log('  Sur cet ordinateur : http://localhost:' + PORT);
  if (ips.length) {
    console.log('  Sur ton iPhone (meme Wi-Fi), ouvre dans Safari :');
    ips.forEach(ip => console.log('     http://' + ip + ':' + PORT));
  }
  console.log('');
});
