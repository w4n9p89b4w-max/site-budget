// ============================================================
// Reprend les donnees de l'ancienne version du site (avant les comptes utilisateurs) dans un compte.
// A lancer une seule fois, sur le serveur, APRES avoir demarre la nouvelle version et cree son compte sur le site.
//
//   node reprendre-anciennes-donnees.js ton@mail.fr          -> montre ce qui sera repris (ne change rien)
//   node reprendre-anciennes-donnees.js ton@mail.fr --oui    -> reprend pour de bon (copie de la base faite avant)
//
// Ce qui est repris dans le foyer de ce compte :
//   - les operations et operations regulieres sans foyer ;
//   - les anciennes banques ecrites en dur (cepac, revolut, ca...) deviennent des cartes de comptes ;
//   - budgets, categories, mois appliques, epargne et reglages (copies dans le foyer, les anciens restent).
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const go = args.includes('--oui');
const ident = (args.find(a => !a.startsWith('--')) || '').toLowerCase();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'budget.db');
if (!ident) { console.log('Indique ton mail ou ton identifiant : node reprendre-anciennes-donnees.js ton@mail.fr'); process.exit(1); }
if (!fs.existsSync(DB_PATH)) { console.log('Base introuvable : ' + DB_PATH); process.exit(1); }

const db = new Database(DB_PATH);
const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').map(t => t.name);
const cols = t => tables.includes(t) ? db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name) : [];
if (!tables.includes('users') || !cols('transactions').includes('household_id') || !tables.includes('accounts')) {
  console.log('La nouvelle version n\'a pas encore ete lancee sur cette base : demarre le site une fois, cree ton compte, puis relance ce script.');
  process.exit(1);
}
const user = db.prepare('SELECT id, name, household_id FROM users WHERE lower(email) = ? OR lower(login) = ?').get(ident, ident);
if (!user) { console.log('Aucun compte « ' + ident + ' » : cree-le d\'abord sur le site.'); process.exit(1); }
const hid = user.household_id;

// Anciennes banques ecrites en dur -> carte de compte (cle de banque du site + nom)
const OLD_BANKS = { cepac: ['ce', 'Caisse d’Épargne'], ce: ['ce', 'Caisse d’Épargne'], revolut: ['revolut', 'Revolut'], ca: ['ca', 'Crédit Agricole'],
  bourso: ['bourso', 'BoursoBank'], lbp: ['lbp', 'La Banque Postale'], especes: ['especes', 'Espèces'] };

const txns = db.prepare('SELECT id, bank FROM transactions WHERE household_id IS NULL').all();
const recs = db.prepare('SELECT id, bank' + (cols('recurring').includes('to_bank') ? ', to_bank' : '') + ' FROM recurring WHERE household_id IS NULL').all();
const accIds = new Set(db.prepare('SELECT id FROM accounts').all().map(a => String(a.id)));
const oldBanks = new Set();
txns.concat(recs).forEach(r => [r.bank, r.to_bank].forEach(b => { if (b != null && b !== '' && !accIds.has(String(b).replace(/\.0+$/, ''))) oldBanks.add(String(b)); }));

const KEY_TABLES = [['budget', 'key'], ['categories', 'key'], ['applied_months', 'month_key'], ['epargne', 'key'], ['settings', 'key']].filter(([t]) => tables.includes(t));
const keyRows = {};
KEY_TABLES.forEach(([t, k]) => { keyRows[t] = db.prepare('SELECT * FROM ' + t).all().filter(r => !/^h\d+\|/.test(String(r[k]))); });

console.log('Compte : ' + user.name + ' (foyer ' + hid + ')');
console.log('À reprendre :');
console.log('  ' + txns.length + ' opération(s), ' + recs.length + ' opération(s) régulière(s)');
console.log('  ' + oldBanks.size + ' ancienne(s) banque(s) → carte(s) de compte : ' + ([...oldBanks].map(b => (OLD_BANKS[b.toLowerCase()] || [null, b])[1]).join(', ') || 'aucune'));
KEY_TABLES.forEach(([t]) => console.log('  ' + t + ' : ' + keyRows[t].length + ' ligne(s)'));
if (!go) { console.log('\nRien n\'a été modifié. Pour reprendre pour de bon, relance avec --oui à la fin.'); process.exit(0); }

// Copie de securite de la base avant de toucher a quoi que ce soit
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const backup = DB_PATH.replace(/\.db$/, '') + '.avant-reprise-' + stamp + '.db';
db.backup(backup).then(() => {
  console.log('\nCopie de sécurité : ' + backup);
  const run = db.transaction(() => {
    // 1. les anciennes banques deviennent des cartes de comptes
    const map = {}, base = Date.now();
    const nAcc = db.prepare('SELECT COUNT(*) n FROM accounts WHERE household_id = ?').get(hid).n;
    [...oldBanks].forEach((b, i) => {
      const def = OLD_BANKS[b.toLowerCase()] || ['', b.charAt(0).toUpperCase() + b.slice(1)];
      const id = base + i;
      db.prepare(`INSERT INTO accounts (id, name, color, solde, solde_date, solde_set_at, sort_order, created_by, bank_key, acc_type, description, hidden, household_id)
        VALUES (?, ?, '', 0, NULL, 0, ?, ?, ?, 'quotidien', '', 0, ?)`).run(id, def[1], nAcc + i, user.name, def[0], hid);
      map[b] = String(id);
    });
    // 2. operations et regulieres : dans le foyer, et sur leur nouvelle carte de compte
    const upT = db.prepare('UPDATE transactions SET household_id = ?, bank = ? WHERE id = ?');
    txns.forEach(t => upT.run(hid, map[t.bank] || t.bank, t.id));
    const hasTo = cols('recurring').includes('to_bank');
    const upR = db.prepare('UPDATE recurring SET household_id = ?, bank = ?' + (hasTo ? ', to_bank = ?' : '') + ' WHERE id = ?');
    recs.forEach(r => hasTo ? upR.run(hid, map[r.bank] || r.bank, r.to_bank != null ? (map[r.to_bank] || r.to_bank) : null, r.id) : upR.run(hid, map[r.bank] || r.bank, r.id));
    // 3. tables a cle : copie prefixee pour le foyer (les anciennes lignes restent, invisibles)
    KEY_TABLES.forEach(([t, k]) => {
      keyRows[t].forEach(r => {
        const row = Object.assign({}, r); row[k] = 'h' + hid + '|' + r[k];
        const names = Object.keys(row);
        db.prepare('INSERT OR IGNORE INTO ' + t + ' (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')').run(...names.map(n => row[n]));
      });
    });
    return map;
  });
  const map = run();
  console.log('Repris : ' + txns.length + ' opération(s), ' + recs.length + ' régulière(s), ' + Object.keys(map).length + ' carte(s) de compte créée(s).');
  console.log('Recharge le site. Pense à régler le solde de chaque carte (toucher le solde sur la carte pour le modifier).');
}).catch(e => { console.log('Copie de sécurité impossible, rien n\'a été modifié : ' + e.message); process.exit(1); });
