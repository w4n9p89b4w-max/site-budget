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
// Ajout eclair (lecture des tickets / releves par Claude) : facultatif, voir anthropic.config.json
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); Anthropic = Anthropic.default || Anthropic; } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3003;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'budget.db');
// Comptes administrateurs (par mail) : ils voient la liste de tous les comptes du site
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'etienne@ecotole.re').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);


app.use(cors());
// L ajout eclair envoie des photos / PDF : il a droit a des envois plus gros
const jsonSmall = bodyParser.json({ limit: '5mb' }), jsonBig = bodyParser.json({ limit: '40mb' });
app.use((req, res, next) => (req.path === '/api/import' ? jsonBig : jsonSmall)(req, res, next));

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
addColumnIfMissing('users', 'avatar', 'TEXT');

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
function parseAvatar(v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, login: u.login || '', admin: isAdmin(u), avatar: parseAvatar(u.avatar) }; }
function householdInfo(hid) {
  return { id: hid, members: db.prepare('SELECT id, name, avatar FROM users WHERE household_id = ? ORDER BY id').all(hid).map(m => ({ id: m.id, name: m.name, avatar: parseAvatar(m.avatar) })) };
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
  households.forEach(h => { h.counts = householdCounts(householdData(h.id)); });
  res.json({ users, households });
});

// Avatar : initiales, emoji ou photo sur un fond de couleur
app.post('/api/auth/avatar', requireAuth, (req, res) => {
  const a = req.body.avatar || {}, type = ['initials', 'emoji', 'photo', 'memoji'].indexOf(a.type) >= 0 ? a.type : null;
  if (!type) return res.status(400).json({ error: 'Avatar invalide' });
  const av = { type, bg: /^[#a-z0-9(),.% -]{3,80}$/i.test(a.bg || '') ? a.bg : '#e6b98a' };
  if (type === 'initials') av.text = String(a.text || '').slice(0, 2);
  if (type === 'emoji') av.emoji = String(a.emoji || '').slice(0, 16);
  if (type === 'memoji') {
    // personnage : seulement des choix connus (mots simples ou couleurs)
    av.mj = {};
    ['skin', 'face', 'hair', 'hairc', 'eyes', 'eyec', 'brows', 'nose', 'mouth', 'beard', 'glasses', 'hat', 'extra', 'shirt'].forEach(k => {
      const v = String((a.mj || {})[k] || ''); if (/^#?[a-z0-9]{1,16}$/i.test(v)) av.mj[k] = v;
    });
  }
  if (type === 'photo') {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(a.img || '') || a.img.length > 300000) return res.status(400).json({ error: 'Photo trop lourde' });
    av.img = a.img;
  }
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(JSON.stringify(av), req.uid);
  res.json({ ok: true, avatar: av });
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

// Nouvel ordre des comptes (cartes de l accueil) : liste des ids dans l ordre voulu
app.post('/api/accounts/order', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const upd = db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ? AND household_id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, req.hid)))();
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ? AND household_id = ?').run(req.params.id, req.hid);
  res.json({ ok: true });
});

// ── Servir les fichiers statiques du site ──
// ============================================================
// Notifications (Web Push) : envoi chiffre selon les normes des navigateurs (RFC 8291 + VAPID RFC 8292),
// sans module en plus. Les cles du site sont creees au premier lancement dans vapid.json (jamais sur GitHub).
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, household_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS push_prefs (user_id INTEGER PRIMARY KEY, daily INTEGER DEFAULT 1, hour TEXT DEFAULT '20:00', due INTEGER DEFAULT 1, budget INTEGER DEFAULT 1, last_daily TEXT, last_due TEXT);
  CREATE TABLE IF NOT EXISTS push_log (key TEXT PRIMARY KEY, sent_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
`);
// Ce que l administrateur autorise pour tout le site (chaque compte choisit ensuite parmi ces categories)
const PUSH_DEFAULTS = { daily: true, hour: '20:00', due: true, dueHour: '09:00', budget: true };
function pushAdmin() {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('push');
  let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch (e) {}
  return Object.assign({}, PUSH_DEFAULTS, v);
}
function requireAdmin(req, res) {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
  if (!isAdmin(me)) { res.status(403).json({ error: 'Réservé à l’administrateur' }); return false; }
  return true;
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const VAPID_FILE = process.env.VAPID_FILE || path.join(__dirname, 'vapid.json');
let VAPID = null;
function vapidKeys() {
  if (VAPID) return VAPID;
  if (fs.existsSync(VAPID_FILE)) { try { VAPID = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch (e) { VAPID = null; } }
  if (!VAPID) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    VAPID = { jwk: privateKey.export({ format: 'jwk' }), subject: 'mailto:' + (ADMIN_EMAILS[0] || 'contact@example.com') };
    fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID, null, 2));
    console.log('Cles de notification creees dans vapid.json');
  }
  VAPID.publicRaw = Buffer.concat([Buffer.from([4]), unb64u(VAPID.jwk.x), unb64u(VAPID.jwk.y)]);
  VAPID.key = crypto.createPrivateKey({ key: VAPID.jwk, format: 'jwk' });
  return VAPID;
}
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
// Chiffrement du message pour un appareil (aes128gcm)
function encryptPush(sub, payload) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPublic), salt = crypto.randomBytes(16);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).slice(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).slice(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}
function vapidHeader(endpoint) {
  const v = vapidKeys(), aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + b64u(v.publicRaw);
}
async function sendPush(sub, msg) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(sub.endpoint) },
      body: encryptPush(sub, JSON.stringify(msg))
    });
    // appareil desinscrit : on l oublie
    if (res.status === 404 || res.status === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
    return res.status;
  } catch (e) { console.log('Notification non envoyee : ' + e.message); return 0; }
}
function pushToUser(uid, msg) { return Promise.all(db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(uid).map(s => sendPush(s, msg))); }
function pushToHousehold(hid, msg) { return Promise.all(db.prepare('SELECT * FROM push_subs WHERE household_id = ?').all(hid).map(s => sendPush(s, msg))); }
function prefsOf(uid) {
  let p = db.prepare('SELECT * FROM push_prefs WHERE user_id = ?').get(uid);
  if (!p) { db.prepare('INSERT INTO push_prefs (user_id) VALUES (?)').run(uid); p = db.prepare('SELECT * FROM push_prefs WHERE user_id = ?').get(uid); }
  return p;
}

app.get('/api/push/key', requireAuth, (req, res) => { res.json({ key: b64u(vapidKeys().publicRaw) }); });
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const s = req.body.subscription || {};
  if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: 'Abonnement invalide' });
  db.prepare(`INSERT INTO push_subs (endpoint, user_id, household_id, p256dh, auth) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, household_id = excluded.household_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(s.endpoint, req.uid, req.hid, s.keys.p256dh, s.keys.auth);
  prefsOf(req.uid);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body.endpoint || ''), req.uid);
  res.json({ ok: true });
});
app.get('/api/push/prefs', requireAuth, (req, res) => {
  const p = prefsOf(req.uid);
  res.json({ daily: !!p.daily, due: !!p.due, budget: !!p.budget, admin: pushAdmin(), devices: db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id = ?').get(req.uid).n });
});
// Chaque compte autorise (ou non) les categories ouvertes par l admin
app.post('/api/push/prefs', requireAuth, (req, res) => {
  const b = req.body; prefsOf(req.uid);
  db.prepare('UPDATE push_prefs SET daily = ?, due = ?, budget = ? WHERE user_id = ?').run(b.daily ? 1 : 0, b.due ? 1 : 0, b.budget ? 1 : 0, req.uid);
  res.json({ ok: true });
});
// Administration des notifications : categories ouvertes, heures d envoi, annonce a tout le monde
app.post('/api/push/admin', requireAuth, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body, cur = pushAdmin(), hh = v => /^\d{2}:\d{2}$/.test(v || '') ? v : null;
  const v = { daily: !!b.daily, hour: hh(b.hour) || cur.hour, due: !!b.due, dueHour: hh(b.dueHour) || cur.dueHour, budget: !!b.budget };
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('push', JSON.stringify(v));
  res.json({ ok: true, admin: v });
});
app.post('/api/push/broadcast', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = String(req.body.body || '').trim().slice(0, 200);
  if (!body) return res.status(400).json({ error: 'Message vide' });
  const st = await Promise.all(db.prepare('SELECT * FROM push_subs').all().map(s => sendPush(s, { title: String(req.body.title || 'Budget Mensuel').slice(0, 80), body, url: '/' })));
  res.json({ ok: true, sent: st.filter(x => x >= 200 && x < 300).length, devices: st.length });
});
app.post('/api/push/test', requireAuth, async (req, res) => {
  const st = await pushToUser(req.uid, { title: 'Budget Mensuel', body: 'Les notifications fonctionnent sur cet appareil 🎉', url: '/' });
  res.json({ ok: true, sent: st.filter(x => x >= 200 && x < 300).length, devices: st.length });
});
// Alerte de budget envoyee par le site (une seule fois par groupe, par mois et par palier)
app.post('/api/push/budget', requireAuth, async (req, res) => {
  const key = 'b|' + req.hid + '|' + String(req.body.key || '').slice(0, 80);
  if (!req.body.key || db.prepare('SELECT 1 FROM push_log WHERE key = ?').get(key)) return res.json({ ok: true, skipped: true });
  db.prepare('INSERT INTO push_log (key) VALUES (?)').run(key);
  const msg = { title: String(req.body.title || 'Budget').slice(0, 80), body: String(req.body.body || '').slice(0, 200), url: '/' };
  if (!pushAdmin().budget) return res.json({ ok: true, off: true });
  const users = db.prepare('SELECT user_id FROM push_prefs WHERE budget = 1').all().map(r => r.user_id);
  await Promise.all(db.prepare('SELECT * FROM push_subs WHERE household_id = ?').all(req.hid).filter(s => users.indexOf(s.user_id) >= 0).map(s => sendPush(s, msg)));
  res.json({ ok: true });
});

// ── Programmateur : rappel du soir et echeances du jour (heure de Paris) ──
function parisNow() {
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), time: g('hour') + ':' + g('minute') };
}
// Meme regle que le site : jours ou tombe une operation reguliere dans le mois (m de 0 a 11)
function recDaysSrv(r, y, m) {
  const dim = new Date(y, m + 1, 0).getDate(), f = r.freq || 'month', ev = Math.max(1, parseInt(r.every, 10) || 1);
  const an = r.anchor ? new Date(r.anchor + 'T00:00:00') : null; let out = [];
  if (f === 'month') { const md = an ? (y - an.getFullYear()) * 12 + (m - an.getMonth()) : 0; if (md >= 0 && md % ev === 0) out.push(Math.min(parseInt(r.day, 10) || (an ? an.getDate() : 1), dim)); }
  else if (f === 'year') { if (an && an.getMonth() === m && y >= an.getFullYear() && (y - an.getFullYear()) % ev === 0) out.push(Math.min(an.getDate(), dim)); }
  else if (f === 'week') { const wd = an ? an.getDay() : 1; for (let d = 1; d <= dim; d++) { const dt = new Date(y, m, d); if (dt.getDay() !== wd) continue; const w = an ? Math.round((dt - an) / 86400000) / 7 : 0; if (w >= 0 && w % ev === 0) out.push(d); } }
  else if (f === 'day') { for (let d = 1; d <= dim; d++) { const diff = an ? Math.round((new Date(y, m, d) - an) / 86400000) : d - 1; if (diff >= 0 && diff % ev === 0) out.push(d); } }
  if (an) out = out.filter(d => new Date(y, m, d) >= an);
  if (r.end_date) { const en = new Date(r.end_date + 'T00:00:00'); out = out.filter(d => new Date(y, m, d) <= en); }
  return out;
}
function dueToday(hid, today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1, d = +today.slice(8, 10);
  const sk = db.prepare('SELECT value FROM settings WHERE key = ?').get('h' + hid + '|skipped');
  const skipped = sk ? (JSON.parse(sk.value) || []) : [];
  const list = [];
  db.prepare('SELECT * FROM recurring WHERE household_id = ? AND kind IS NOT NULL').all(hid).forEach(r => {
    if (recDaysSrv(r, y, m).indexOf(d) < 0) return;
    const key = (r.freq || 'month') === 'month' ? r.id + '@' + y + '-' + String(m).padStart(2, '0') : r.id + '@' + today;
    if (skipped.indexOf(key) >= 0) return;
    if (db.prepare('SELECT 1 FROM transactions WHERE household_id = ? AND rec_key = ?').get(hid, key)) return;
    list.push(r);
  });
  return list;
}
const euro = v => (Math.round(v * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
function pushTick() {
  const now = parisNow(), ad = pushAdmin();
  db.prepare('SELECT p.*, u.household_id hid FROM push_prefs p JOIN users u ON u.id = p.user_id').all().forEach(p => {
    if (!db.prepare('SELECT 1 FROM push_subs WHERE user_id = ?').get(p.user_id)) return;
    if (ad.daily && p.daily && ad.hour === now.time && p.last_daily !== now.date) {
      db.prepare('UPDATE push_prefs SET last_daily = ? WHERE user_id = ?').run(now.date, p.user_id);
      pushToUser(p.user_id, { title: 'Budget Mensuel', body: 'T’as bien noté tes dépenses aujourd’hui ?', url: '/' });
    }
    if (ad.due && p.due && now.time >= ad.dueHour && p.last_due !== now.date) {
      db.prepare('UPDATE push_prefs SET last_due = ? WHERE user_id = ?').run(now.date, p.user_id);
      const due = dueToday(p.hid, now.date);
      if (due.length) pushToUser(p.user_id, { title: due.length > 1 ? due.length + ' échéances aujourd’hui' : 'Échéance aujourd’hui',
        body: due.slice(0, 4).map(r => r.label + ' ' + euro(r.amount)).join(' · ') + ' — à confirmer dans le Budget', url: '/' });
    }
  });
}
setInterval(pushTick, 60000);

// ── Sauvegardes des foyers (dossier sauvegardes/, jamais sur GitHub) ──
// Une copie complete des donnees d un foyer : automatique chaque nuit, et avant tout effacement ou restauration.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'sauvegardes');
const BACKUP_KEEP = 40;                                       // copies gardees par foyer
const HH_ROWS = ['transactions', 'accounts', 'recurring'];   // tables avec une colonne household_id
const HH_KEYS = { settings: 'key', budget: 'key', categories: 'key', applied_months: 'month_key', epargne: 'key' }; // cles "h<id>|..."
const REASONS = { auto: 'Sauvegarde de la nuit', manuel: 'Sauvegarde manuelle', 'avant-effacement': 'Avant effacement', 'avant-restauration': 'Avant restauration' };

function householdData(hid) {
  const out = {}, p = 'h' + hid + '|';
  HH_ROWS.forEach(t => { out[t] = db.prepare('SELECT * FROM ' + t + ' WHERE household_id = ?').all(hid); });
  Object.keys(HH_KEYS).forEach(t => { const c = HH_KEYS[t]; out[t] = db.prepare('SELECT * FROM ' + t + ' WHERE substr(' + c + ', 1, ?) = ?').all(p.length, p); });
  return out;
}
function householdCounts(data) {
  const goals = (data.settings || []).find(r => /\|goals$/.test(r.key));
  let ng = 0; try { ng = goals ? JSON.parse(goals.value).length : 0; } catch (e) {}
  return { accounts: data.accounts.length, transactions: data.transactions.length, recurring: data.recurring.length, goals: ng };
}
function wipeHousehold(hid) {
  const p = 'h' + hid + '|';
  HH_ROWS.forEach(t => db.prepare('DELETE FROM ' + t + ' WHERE household_id = ?').run(hid));
  Object.keys(HH_KEYS).forEach(t => { const c = HH_KEYS[t]; db.prepare('DELETE FROM ' + t + ' WHERE substr(' + c + ', 1, ?) = ?').run(p.length, p); });
}
function backupDir(hid) { return path.join(BACKUP_DIR, 'foyer-' + parseInt(hid, 10)); }
function saveBackup(hid, reason) {
  const data = householdData(hid), now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const dir = backupDir(hid);
  fs.mkdirSync(dir, { recursive: true });
  const file = stamp + '_' + reason + '.json';
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 1, household_id: hid, at: now.toISOString(), reason, counts: householdCounts(data), data }));
  // on ne garde que les plus recentes
  fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(BACKUP_KEEP).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
  return file;
}
function listBackups(hid) {
  const dir = backupDir(hid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
    try { const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { file: f, at: b.at, reason: b.reason, label: REASONS[b.reason] || b.reason, counts: b.counts }; }
    catch (e) { return null; }
  }).filter(Boolean);
}
function backupFile(hid, file) {
  if (!/^[\w-]+\.json$/.test(String(file || ''))) return null;
  const f = path.join(backupDir(hid), file);
  return fs.existsSync(f) ? f : null;
}
function restoreHousehold(hid, backup) {
  if (!backup || backup.household_id !== hid || !backup.data) throw new Error('Sauvegarde d’un autre foyer');
  db.transaction(() => {
    wipeHousehold(hid);
    [...HH_ROWS, ...Object.keys(HH_KEYS)].forEach(t => {
      const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
      (backup.data[t] || []).forEach(row => {
        const keys = Object.keys(row).filter(k => cols.indexOf(k) >= 0);
        if (!keys.length) return;
        db.prepare('INSERT OR REPLACE INTO ' + t + ' (' + keys.join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')').run(keys.map(k => row[k]));
      });
    });
  })();
}
// Chaque nuit (a partir de 3 h) : une sauvegarde par foyer qui a des donnees
function nightlyBackups() {
  const now = new Date(), today = now.toISOString().slice(0, 10);
  if (now.getHours() < 3) return;
  db.prepare('SELECT id FROM households').all().forEach(h => {
    const last = listBackups(h.id).find(b => b.reason === 'auto');
    if (last && String(last.at).slice(0, 10) === today) return;
    const c = householdCounts(householdData(h.id));
    if (!c.accounts && !c.transactions && !c.recurring) return;
    try { saveBackup(h.id, 'auto'); } catch (e) { console.log('Sauvegarde du foyer ' + h.id + ' impossible : ' + e.message); }
  });
}
setTimeout(nightlyBackups, 10000);
setInterval(nightlyBackups, 3600000);

function requireAdmin(req, res, next) {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.uid);
  if (!isAdmin(me)) return res.status(403).json({ error: 'Réservé à l’administrateur' });
  const hid = parseInt(req.params.hid, 10);
  if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(hid)) return res.status(404).json({ error: 'Foyer introuvable' });
  req.target = hid;
  next();
}
app.get('/api/admin/households/:hid', requireAuth, requireAdmin, (req, res) => {
  res.json({ id: req.target, members: householdInfo(req.target).members, counts: householdCounts(householdData(req.target)), backups: listBackups(req.target) });
});
app.post('/api/admin/households/:hid/backup', requireAuth, requireAdmin, (req, res) => {
  const file = saveBackup(req.target, 'manuel');
  res.json({ ok: true, file, backups: listBackups(req.target) });
});
app.post('/api/admin/households/:hid/wipe', requireAuth, requireAdmin, (req, res) => {
  if (req.body.confirm !== 'EFFACER') return res.status(400).json({ error: 'Confirmation manquante' });
  const file = saveBackup(req.target, 'avant-effacement');
  db.transaction(() => wipeHousehold(req.target))();
  console.log('Administration : donnees du foyer ' + req.target + ' effacees par ' + req.user + ' (copie ' + file + ')');
  res.json({ ok: true, file, counts: householdCounts(householdData(req.target)), backups: listBackups(req.target) });
});
app.post('/api/admin/households/:hid/restore', requireAuth, requireAdmin, (req, res) => {
  const f = backupFile(req.target, req.body.file);
  if (!f) return res.status(404).json({ error: 'Sauvegarde introuvable' });
  let backup; try { backup = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return res.status(400).json({ error: 'Sauvegarde illisible' }); }
  const before = saveBackup(req.target, 'avant-restauration');
  try { restoreHousehold(req.target, backup); } catch (e) { return res.status(400).json({ error: e.message }); }
  console.log('Administration : foyer ' + req.target + ' remis a la sauvegarde ' + req.body.file + ' par ' + req.user + ' (copie ' + before + ')');
  res.json({ ok: true, counts: householdCounts(householdData(req.target)), backups: listBackups(req.target) });
});
app.get('/api/admin/households/:hid/backups/:file', requireAuth, requireAdmin, (req, res) => {
  const f = backupFile(req.target, req.params.file);
  if (!f) return res.status(404).json({ error: 'Sauvegarde introuvable' });
  res.download(f, 'foyer-' + req.target + '_' + req.params.file);
});

// ── Ajout eclair : Claude lit un ticket de caisse ou un releve (photo, PDF, CSV) ──
// Cle dans anthropic.config.json (jamais sur GitHub) ou variable ANTHROPIC_API_KEY
function anthropicConfig() {
  const file = path.join(__dirname, 'anthropic.config.json');
  let c = {};
  if (fs.existsSync(file)) { try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('anthropic.config.json illisible'); } }
  c.apiKey = process.env.ANTHROPIC_API_KEY || c.apiKey;
  c.model = process.env.ANTHROPIC_MODEL || c.model || 'claude-opus-5-5';
  return Anthropic && c.apiKey && !/^sk-ant-\.\.\./.test(c.apiKey) ? c : null;
}
app.get('/api/import', requireAuth, (req, res) => {
  res.json({ ready: !!anthropicConfig(), module: !!Anthropic });
});
app.post('/api/import', requireAuth, async (req, res) => {
  const conf = anthropicConfig();
  if (!conf) return res.status(503).json({ error: Anthropic ? 'Clé Anthropic pas encore réglée sur le serveur (anthropic.config.json).' : 'Module Anthropic absent : lance « npm install --ignore-scripts » puis relance le site.' });
  const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 10) : [];
  const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 400000) : '';
  const cats = (Array.isArray(req.body.cats) ? req.body.cats : []).filter(c => c && c.key).slice(0, 200);
  if (!files.length && !text) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const content = [];
  for (const f of files) {
    const type = String(f.type || '').toLowerCase(), data = String(f.data || '');
    if (!data) continue;
    if (type === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    else if (/^image\/(jpeg|png|gif|webp)$/.test(type)) content.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
    else return res.status(400).json({ error: 'Format non pris en charge : ' + (f.name || type) });
  }
  if (text) content.push({ type: 'text', text: '<fichier nom="' + String(req.body.textName || 'import.csv').replace(/[<>"]/g, '') + '">\n' + text + '\n</fichier>' });
  const today = new Date().toISOString().slice(0, 10);
  content.push({ type: 'text', text:
    'Date du jour : ' + today + '.\n' +
    'Catégories disponibles (clé : nom, groupe) :\n' + cats.map(c => '- ' + c.key + ' : ' + c.label + ' (' + (c.group === 'rev' ? 'revenu' : 'dépense') + ')').join('\n') + '\n\n' +
    'Extrais les opérations de ce document pour un carnet de budget personnel.\n' +
    '- Ticket de caisse ou facture : UNE seule opération (le total payé), libellé = nom de l\'enseigne, date du ticket ; ' +
    'mets le détail utile des articles dans "detail" (court).\n' +
    '- Relevé bancaire (PDF, photo ou CSV) : une opération par ligne du relevé. Ignore les soldes, totaux, reports et lignes d\'en-tête. ' +
    'Libellé court et lisible (nom du commerçant ou de l\'organisme, sans les numéros de carte ni références) ; "detail" peut garder le libellé brut.\n' +
    '- amount toujours positif ; sens = "depense" pour un débit, "revenu" pour un crédit.\n' +
    '- date au format AAAA-MM-JJ (date de l\'opération). Si l\'année manque, déduis-la du document, sinon prends la plus récente avant la date du jour.\n' +
    '- cat = la clé de catégorie la plus adaptée parmi la liste (une catégorie de revenu pour un revenu).\n' +
    '- Si le document est illisible ou ne contient aucune opération, renvoie une liste vide et explique pourquoi dans "remarque".\n' +
    '- Comptes : liste dans "comptes" chaque compte qui a ses propres opérations dans le document (compte principal, sous-comptes, ' +
    'Pockets ou coffres Revolut, livrets…), avec son nom tel qu\'écrit (sans la devise entre parenthèses), la banque, et les soldes de début ' +
    'et de fin de période s\'ils sont indiqués (nombre écrit avec un point, ex. "12.54", sinon ""). Pour un ticket de caisse, liste vide.\n' +
    '- "compte" de chaque opération = le nom exact du compte (tel que dans "comptes") dans lequel la ligne apparaît ; "" pour un ticket.\n' +
    '- Mouvements entre deux comptes du document (ex. « Sur la Pocket… », « Vers la Pocket… », « Retrait depuis une Pocket », virement vers ' +
    'son propre coffre ou livret) : interne = true et "compte_lie" = le nom de l\'autre compte (si la ligne ne le dit pas, c\'est le compte ' +
    'principal pour une Pocket ou un coffre). Garde chaque ligne telle qu\'elle apparaît dans chaque compte, sans les fusionner. ' +
    'Sinon interne = false et compte_lie = "".\n' +
    '- arrondi = true pour les virements automatiques de petite monnaie (arrondi à l\'euro supérieur après un achat, quelques centimes ' +
    'à quelques euros, ex. « Sur la Pocket EUR Loisir depuis EUR » juste après un paiement), des deux côtés ; false sinon (un vrai virement choisi).'
  });

  const catKeys = cats.map(c => String(c.key));
  const schema = {
    type: 'object', additionalProperties: false, required: ['document', 'remarque', 'comptes', 'operations'],
    properties: {
      document: { type: 'string', enum: ['ticket', 'releve', 'autre'] },
      remarque: { type: 'string' },
      comptes: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['nom', 'banque', 'solde_debut', 'solde_fin'],
        properties: { nom: { type: 'string' }, banque: { type: 'string' }, solde_debut: { type: 'string' }, solde_fin: { type: 'string' } }
      } },
      operations: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['date', 'label', 'amount', 'sens', 'cat', 'detail', 'compte', 'interne', 'compte_lie', 'arrondi'],
        properties: {
          date: { type: 'string' }, label: { type: 'string' }, amount: { type: 'number' },
          compte: { type: 'string' }, interne: { type: 'boolean' }, compte_lie: { type: 'string' }, arrondi: { type: 'boolean' },
          sens: { type: 'string', enum: ['depense', 'revenu'] },
          cat: catKeys.length ? { type: 'string', enum: catKeys } : { type: 'string' },
          detail: { type: 'string' }
        }
      } }
    }
  };

  try {
    const client = new Anthropic({ apiKey: conf.apiKey });
    const msg = await client.beta.messages.create({
      model: conf.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }]
    });
    if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'Claude n’a pas voulu lire ce document.' });
    if (msg.stop_reason === 'max_tokens') return res.status(422).json({ error: 'Document trop long : découpe-le (par exemple un mois à la fois).' });
    const out = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const data = JSON.parse(out);
    const ops = (data.operations || []).filter(o => o && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Math.abs(+o.amount) > 0)
      .map(o => ({ date: o.date, label: String(o.label || '').slice(0, 120), amount: Math.round(Math.abs(+o.amount) * 100) / 100,
        kind: o.sens === 'revenu' ? 'rev' : 'dep', cat: o.cat || '', detail: String(o.detail || '').slice(0, 300),
        compte: String(o.compte || '').slice(0, 80), interne: !!(o.interne || o.arrondi), lie: String(o.compte_lie || '').slice(0, 80), arrondi: !!o.arrondi }));
    const num = v => { const n = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
    const comptes = (data.comptes || []).filter(c => c && c.nom).slice(0, 30)
      .map(c => ({ nom: String(c.nom).slice(0, 80), banque: String(c.banque || '').slice(0, 80), debut: num(c.solde_debut), fin: num(c.solde_fin) }));
    console.log('Ajout eclair : ' + ops.length + ' operation(s) lue(s) pour ' + req.user + ' (' + msg.usage.input_tokens + ' + ' + msg.usage.output_tokens + ' jetons)');
    res.json({ ok: true, document: data.document, remarque: data.remarque || '', comptes, operations: ops });
  } catch (e) {
    console.log('Ajout eclair : erreur', e.status || '', e.message);
    let m = 'Lecture impossible pour le moment, réessaie.';
    if (e instanceof Anthropic.AuthenticationError) m = 'Clé Anthropic refusée : vérifie anthropic.config.json.';
    else if (e instanceof Anthropic.PermissionDeniedError) m = 'Clé Anthropic sans accès à ce modèle.';
    else if (e instanceof Anthropic.RateLimitError) m = 'Trop de demandes d’un coup, réessaie dans une minute.';
    else if (e instanceof Anthropic.BadRequestError) m = /credit|billing/i.test(e.message) ? 'Plus de crédit sur le compte Anthropic.' : 'Document refusé (trop gros ou illisible ?).';
    else if (e instanceof SyntaxError) m = 'Réponse illisible, réessaie.';
    res.status(502).json({ error: m });
  }
});

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
  ['sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'].forEach(f => {
    app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
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
