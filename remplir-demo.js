// ============================================================
// Remplit un compte du site local avec des donnees d'exemple :
// comptes bancaires, depenses, revenus, transferts, operations regulieres et objectifs.
//
//   node remplir-demo.js                       -> remplit etienne@ecotole.re
//   node remplir-demo.js autre@mail.fr         -> remplit un autre compte
//   node remplir-demo.js --effacer             -> retire tout ce que le script a ajoute
//
// Le compte doit deja exister (le creer d'abord sur http://localhost:3003).
// Ne touche qu'a la base locale budget.db, jamais au site en ligne.
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const erase = args.includes('--effacer');
const email = (args.find(a => !a.startsWith('--')) || 'etienne@ecotole.re').toLowerCase();
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'budget.db'));

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
if (!tables.includes('users')) {
  console.log('La base ne contient pas encore de comptes : lance le site une fois (lancer.bat / lancer.command), puis recommence.');
  process.exit(1);
}
const user = db.prepare('SELECT id, name, household_id FROM users WHERE lower(email) = ?').get(email);
if (!user) {
  console.log('Aucun compte avec l\'adresse ' + email + ' sur cet ordinateur.');
  console.log('Cree-le d\'abord sur http://localhost:3003, puis relance ce script.');
  process.exit(1);
}
const hid = user.household_id;
const seedKey = 'h' + hid + '|demo_seed';
const goalsKey = 'h' + hid + '|goals';

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// ---------- Effacer les donnees d'exemple ----------
if (erase) {
  const seed = getSetting(seedKey);
  if (!seed) { console.log('Rien a effacer : aucune donnee d\'exemple pour ' + email + '.'); process.exit(0); }
  db.transaction(() => {
    seed.txns.forEach(id => db.prepare('DELETE FROM transactions WHERE id = ? AND household_id = ?').run(id, hid));
    seed.accounts.forEach(id => db.prepare('DELETE FROM accounts WHERE id = ? AND household_id = ?').run(id, hid));
    seed.recurring.forEach(id => db.prepare('DELETE FROM recurring WHERE id = ? AND household_id = ?').run(id, hid));
    const goals = (getSetting(goalsKey) || []).filter(g => seed.goals.indexOf(String(g.id)) < 0);
    setSetting(goalsKey, goals);
    db.prepare('DELETE FROM settings WHERE key = ?').run(seedKey);
  })();
  console.log('Donnees d\'exemple retirees du compte ' + email + '. Recharge la page du site.');
  process.exit(0);
}

if (getSetting(seedKey)) {
  console.log('Le compte ' + email + ' contient deja les donnees d\'exemple.');
  console.log('Pour recommencer : node remplir-demo.js --effacer, puis relance ce script.');
  process.exit(0);
}

// ---------- Dates : les 2 mois precedents + le mois en cours ----------
const pad = n => (n < 10 ? '0' : '') + n;
const now = new Date();
const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const months = [-2, -1, 0].map(dm => { const d = new Date(now.getFullYear(), now.getMonth() + dm, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const ds = (mo, day) => mo.y + '-' + pad(mo.m + 1) + '-' + pad(Math.min(day, dim(mo.y, mo.m)));
const mKey = mo => mo.y + '-' + pad(mo.m);               // meme format que le site (mois 0-11)
const first = months[0];
const soldeDate = (() => { const d = new Date(first.y, first.m, 0); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); })();
const soldeSetAt = new Date(first.y, first.m, 0, 23, 0, 0).getTime();

let nextId = Date.now();
const newId = () => ++nextId;
const seed = { accounts: [], txns: [], recurring: [], goals: [] };

// ---------- Comptes bancaires ----------
const insAcc = db.prepare(`INSERT INTO accounts (id, name, color, solde, solde_date, solde_set_at, sort_order, created_by, bank_key, acc_type, description, hidden, currency, household_id)
  VALUES (@id, @name, '', @solde, @solde_date, @solde_set_at, @sort_order, @by, @bank, @type, @desc, 0, 'EUR', @hid)`);
const A = {};
[
  ['rev', 'Revolut', 'revolut', 'quotidien', 'Compte Courant', 950],
  ['joint', 'Crédit Agricole', 'ca', 'quotidien', 'Compte Joint', 640],
  ['livret', 'BoursoBank', 'bourso', 'epargne', 'Livret A', 3600],
  ['cash', 'Espèces', 'especes', 'quotidien', 'Espèces', 45],
  ['pea', 'Trade Republic', 'trade', 'invest', 'PEA', 2150]
].forEach((a, i) => {
  const id = newId(); A[a[0]] = String(id); seed.accounts.push(id);
  insAcc.run({ id, name: a[1], solde: a[5], solde_date: soldeDate, solde_set_at: soldeSetAt, sort_order: i, by: user.name, bank: a[2], type: a[3], desc: a[4], hid });
});

// ---------- Operations regulieres ----------
const insRec = db.prepare(`INSERT INTO recurring (label, cat, bank, amount, day, next_month, to_bank, start_key, kind, freq, household_id)
  VALUES (@label, @cat, @bank, @amount, @day, 0, @to, @start, @kind, 'month', @hid)`);
const R = {};
[
  // [cle, libelle, categorie, compte, montant, jour, type, compte destination]
  ['salaire', 'Salaire', 'salaire', 'rev', 2150, 28, 'rev'],
  ['loyer', 'Loyer', 'loyer', 'joint', 750, 5, 'dep'],
  ['edf', 'EDF', 'electricite', 'joint', 68, 10, 'dep'],
  ['box', 'Box internet', 'internet', 'rev', 29.99, 12, 'dep'],
  ['tel', 'Forfait mobile', 'telephone', 'rev', 15.99, 8, 'dep'],
  ['netflix', 'Netflix', 'streaming', 'rev', 13.49, 15, 'dep'],
  ['auto', 'Assurance auto', 'assurance_auto', 'rev', 42, 3, 'dep'],
  ['mutuelle', 'Mutuelle', 'mutuelle', 'rev', 35, 6, 'dep'],
  ['joint', 'Participation compte joint', '', 'rev', 850, 2, 'tra', 'joint'],
  ['epargne', 'Épargne du mois', '', 'rev', 200, 29, 'tra', 'livret'],
  ['pea', 'Versement PEA', '', 'rev', 100, 20, 'tra', 'pea']
].forEach(r => {
  const info = insRec.run({ label: r[1], cat: r[2], bank: A[r[3]], amount: r[4], day: r[5], to: r[7] ? A[r[7]] : null, start: mKey(first), kind: r[6], hid });
  R[r[0]] = { id: info.lastInsertRowid, label: r[1], cat: r[2], acc: r[3], amount: r[4], day: r[5], kind: r[6], to: r[7] };
  seed.recurring.push(info.lastInsertRowid);
});

// ---------- Transactions ----------
const insTx = db.prepare(`INSERT INTO transactions (id, date, label, cat, amount, type, bank, need, auto, transfer_pair, created_by, remb, later_pay, no_balance, rec_key, household_id)
  VALUES (@id, @date, @label, @cat, @amount, @type, @bank, @need, 0, @pair, @by, 0, 0, 0, @rec, @hid)`);
// type et nature de chaque categorie utilisee (comme dans le site)
const CAT = {
  loyer: ['dep', 'obligatoire'], electricite: ['dep', 'obligatoire'], internet: ['dep', 'obligatoire'], telephone: ['dep', 'obligatoire'],
  streaming: ['dep', 'plaisir'], assurance_auto: ['dep', 'obligatoire'], mutuelle: ['dep', 'obligatoire'],
  courses: ['dep_var', 'obligatoire'], carburant: ['dep_var', 'obligatoire'], pharmacie: ['dep_var', 'obligatoire'], repas: ['dep_var', 'obligatoire'],
  restaurant: ['dep_var', 'plaisir'], livraison: ['dep_var', 'plaisir'], snacks: ['dep_var', 'plaisir'], sorties: ['dep_var', 'plaisir'],
  vetements: ['dep_var', 'plaisir'], shopping: ['dep_var', 'plaisir'], cadeaux: ['dep_var', 'plaisir'], high_tech: ['dep_var', 'plaisir'], bar: ['dep_var', 'plaisir']
};
function addTx(date, label, cat, acc, amount, kind, rec) {
  if (date > today) return;                                   // les echeances futures restent "a venir"
  const id = newId(); seed.txns.push(id);
  const t = kind === 'rev' ? ['rev', ''] : (CAT[cat] || ['dep_var', 'plaisir']);
  insTx.run({ id, date, label, cat, amount, type: t[0], bank: A[acc], need: t[1], pair: null, by: user.name, rec: rec || null, hid });
}
function addTransfer(date, label, from, to, amount, rec) {
  if (date > today) return;
  const out = newId(), inn = newId(); seed.txns.push(out, inn);
  insTx.run({ id: out, date, label, cat: 'autres_dep', amount, type: 'transfert', bank: A[from], need: '', pair: inn, by: user.name, rec: rec || null, hid });
  insTx.run({ id: inn, date, label, cat: 'autre_rev', amount, type: 'transfert_in', bank: A[to], need: '', pair: out, by: user.name, rec: rec ? rec + '#in' : null, hid });
}

// Petites variations d'un mois a l'autre, toujours les memes (pas de hasard)
const vary = (base, i, k) => Math.round(base * (1 + ((i * 7 + k * 13) % 11 - 5) / 40) * 100) / 100;

db.transaction(() => {
  months.forEach((mo, i) => {
    // echeances regulieres du mois (confirmees si la date est passee)
    Object.keys(R).forEach(k => {
      const r = R[k], date = ds(mo, r.day), rec = r.id + '@' + mKey(mo);
      if (r.kind === 'tra') addTransfer(date, r.label, r.acc, r.to, r.amount, rec);
      else addTx(date, r.label, r.cat, r.acc, r.amount, r.kind, rec);
    });
    // depenses de tous les jours
    [
      [3, 'Carrefour', 'courses', 'rev', 86.4], [10, 'Lidl', 'courses', 'rev', 54.2], [17, 'E.Leclerc', 'courses', 'joint', 112.7], [24, 'Carrefour Market', 'courses', 'rev', 47.9],
      [6, 'TotalEnergies', 'carburant', 'rev', 61.3], [21, 'Esso', 'carburant', 'rev', 55.8],
      [9, 'Sushi Shop', 'restaurant', 'rev', 38.5], [19, 'Pizzeria Da Marco', 'restaurant', 'joint', 46], [26, 'Uber Eats', 'livraison', 'rev', 24.9],
      [13, 'Boulangerie', 'snacks', 'cash', 6.8], [22, 'Café du coin', 'snacks', 'cash', 4.5],
      [11, 'Pharmacie', 'pharmacie', 'rev', 18.6], [16, 'Cantine boulot', 'repas', 'rev', 32]
    ].forEach((d, k) => addTx(ds(mo, d[0]), d[1], d[2], d[3], vary(d[4], i, k), 'dep'));
    // un ou deux achats plaisir qui changent selon le mois
    const extras = [
      [[14, 'Zara', 'vetements', 'rev', 59.9], [25, 'Cinéma Pathé', 'sorties', 'rev', 24]],
      [[7, 'Fnac', 'high_tech', 'rev', 89.99], [18, 'Anniversaire Léa', 'cadeaux', 'rev', 45], [27, 'Bar Le Zinc', 'bar', 'cash', 22]],
      [[4, 'Decathlon', 'shopping', 'rev', 34.99], [9, 'Concert', 'sorties', 'rev', 55]]
    ][i];
    extras.forEach(d => addTx(ds(mo, d[0]), d[1], d[2], d[3], d[4], 'dep'));
    // revenus ponctuels et retrait d'especes
    if (i === 1) addTx(ds(mo, 15), 'Prime de rentrée', 'prime', 'rev', 300, 'rev');
    if (i === 0) addTx(ds(mo, 20), 'Vente Leboncoin', 'vente_objets', 'rev', 75, 'rev');
    addTransfer(ds(mo, 12), 'Retrait distributeur', 'rev', 'cash', 40);
  });

  // ---------- Objectifs ----------
  const goals = getSetting(goalsKey) || [];
  const y = now.getFullYear();
  [
    { name: 'Vacances au Japon', emoji: '🗾', target: 4000, acc: '', saved: 1250, date: (y + 1) + '-07-01', color: '#3b82f6' },
    { name: 'Épargne de précaution', emoji: '🛟', target: 6000, acc: A.livret, saved: 0, date: (y + 1) + '-06-30', color: '#22a559' },
    { name: 'Nouvelle voiture', emoji: '🚗', target: 12000, acc: '', saved: 2300, date: (y + 2) + '-01-01', color: '#f97316' }
  ].forEach(g => {
    const id = String(newId()); seed.goals.push(id);
    goals.push(Object.assign({ id, start: today, alpha: 20, bg: 'def', img: '', light: 90 }, g));
  });
  setSetting(goalsKey, goals);
  setSetting(seedKey, seed);
})();

console.log('C\'est fait ! Le compte ' + email + ' contient maintenant :');
console.log('  - ' + seed.accounts.length + ' comptes bancaires');
console.log('  - ' + seed.txns.length + ' operations (depenses, revenus, transferts)');
console.log('  - ' + seed.recurring.length + ' operations regulieres');
console.log('  - ' + seed.goals.length + ' objectifs');
console.log('Recharge la page du site pour les voir.');
