// ============================================================
// Fabrique un faux releve bancaire pour essayer l'ajout eclair et le controle des doublons.
// Il reprend des operations deja notees dans la base locale (certaines a l'identique,
// d'autres avec un ou deux jours d'ecart ou un autre libelle) et en ajoute de nouvelles.
//
//   node releve-test.js                  -> releve du compte de test (test@budget.local)
//   node releve-test.js autre@mail.fr    -> releve d'un autre compte de la base locale
//
// Cree releve-test.csv et releve-test.pdf dans ce dossier (jamais envoyes sur GitHub).
// Ne modifie rien dans la base.
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const email = (process.argv[2] || 'test@budget.local').toLowerCase();
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'budget.db'), { readonly: true });
const user = db.prepare('SELECT id, name, household_id FROM users WHERE lower(email) = ?').get(email);
if (!user) {
  console.log('Aucun compte ' + email + ' sur cet ordinateur.');
  console.log('Pour le compte de test : node remplir-demo.js --compte-test, puis relance ce script.');
  process.exit(1);
}
const hid = user.household_id;

const pad = n => (n < 10 ? '0' : '') + n;
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fr = s => s.split('-').reverse().join('/');
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());
const from = addDays(today, -30);

// Le compte qui a le plus d'operations ces 30 derniers jours
const acc = db.prepare(`SELECT a.id, a.name, COUNT(t.id) n FROM accounts a JOIN transactions t ON t.bank = CAST(a.id AS TEXT) OR t.bank = a.id
  WHERE a.household_id = ? AND t.household_id = ? AND t.date >= ? AND t.type NOT IN ('transfert','transfert_in')
  GROUP BY a.id ORDER BY n DESC LIMIT 1`).get(hid, hid, from);
if (!acc) { console.log('Pas assez d\'operations recentes sur ce compte pour fabriquer un releve.'); process.exit(1); }
const txns = db.prepare(`SELECT date, label, amount, type FROM transactions
  WHERE household_id = ? AND (bank = ? OR bank = ?) AND date >= ? AND date <= ? AND type NOT IN ('transfert','transfert_in')
  ORDER BY date DESC, id DESC`).all(hid, String(acc.id), acc.id, from, today);

// Libelle comme sur un vrai releve : CB pour la carte, PRLV pour les prelevements, VIR pour les virements recus
const up = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
function raw(t, date) {
  if (t.type === 'rev') return 'VIR SEPA ' + up(t.label);
  if (t.type === 'dep') return 'PRLV SEPA ' + up(t.label);
  return 'CB ' + up(t.label) + ' ' + fr(date).slice(0, 5);
}

const lines = [], expected = [];
txns.forEach((t, i) => {
  const kind = i % 4;
  if (kind === 0 || kind === 1) {             // copie exacte (meme jour, meme montant)
    lines.push({ date: t.date, label: raw(t, t.date), amount: t.amount, rev: t.type === 'rev' });
    expected.push('doublon      ' + fr(t.date) + '  ' + t.label + ' ' + t.amount.toFixed(2) + ' (identique)');
  } else if (kind === 2) {                    // debitee 1 ou 2 jours plus tard par la banque
    const d = addDays(t.date, 1 + (i % 2));
    if (d > today) return;
    lines.push({ date: d, label: raw(t, d), amount: t.amount, rev: t.type === 'rev' });
    expected.push('doublon      ' + fr(d) + '  ' + t.label + ' ' + t.amount.toFixed(2) + ' (' + fr(t.date) + ' dans le budget)');
  }                                           // kind 3 : absente du releve
});

// Pieges : meme jour et meme montant qu'une operation notee, mais une autre depense
const trap = txns.find((t, i) => i % 4 < 2 && t.type === 'dep_var' && t.amount < 30);
if (trap) {
  lines.push({ date: trap.date, label: 'CB TABAC PRESSE DU PORT ' + fr(trap.date).slice(0, 5), amount: trap.amount, rev: false });
  expected.push('piege        ' + fr(trap.date) + '  Tabac Presse ' + trap.amount.toFixed(2) + ' (meme montant que « ' + trap.label + ' », mais une autre)');
}

// Nouvelles operations, absentes du budget
const news = [
  [-1, 'CB CARREFOUR MARKET ', 38.47], [-3, 'CB AMAZON PAYMENTS ', 24.99], [-5, 'CB SNCF INTERNET ', 46.30],
  [-8, 'CB PHARMACIE DE LA GARE ', 12.80], [-12, 'CB DECATHLON ', 59.99], [-16, 'CB UBER EATS ', 21.45],
  [-20, 'VIR SEPA REMBOURSEMENT CPAM', 18.50, true], [-24, 'CB FNAC ', 34.90]
];
news.forEach(([dd, label, amount, rev]) => {
  const d = addDays(today, dd);
  lines.push({ date: d, label: rev ? label : label + fr(d).slice(0, 5), amount, rev: !!rev });
  expected.push('nouvelle     ' + fr(d) + '  ' + label.replace(/^(CB|VIR SEPA) /, '').trim() + ' ' + amount.toFixed(2));
});
lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

// ---------- CSV (format des banques francaises : point-virgule, virgule decimale) ----------
const num = v => v.toFixed(2).replace('.', ',');
let csv = 'Relevé de compte;' + acc.name + '\nPériode;du ' + fr(from) + ' au ' + fr(today) + '\n\n';
csv += 'Date opération;Libellé;Débit;Crédit\n';
lines.forEach(l => { csv += fr(l.date) + ';' + l.label + ';' + (l.rev ? '' : '-' + num(l.amount)) + ';' + (l.rev ? num(l.amount) : '') + '\n'; });
csv += ';Solde au ' + fr(today) + ';;1 234,56\n';
fs.writeFileSync(path.join(__dirname, 'releve-test.csv'), '﻿' + csv, 'utf8');

// ---------- PDF (fait main : texte simple, police Helvetica) ----------
function pdfText(s) {
  const b = Buffer.from(String(s).replace(/€/g, '\u0080'), 'latin1');
  let out = '';
  for (const c of b) out += c === 0x28 || c === 0x29 || c === 0x5c ? '\\' + String.fromCharCode(c) : c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c);
  return '(' + out + ')';
}
const pages = [];
let ops = [], y = 0;
function newPage(first) {
  ops = []; pages.push(ops); y = 790;
  if (first) {
    ops.push('BT /F2 16 Tf 50 ' + y + ' Td ' + pdfText('BANQUE EXEMPLE') + ' Tj ET'); y -= 22;
    ops.push('BT /F1 11 Tf 50 ' + y + ' Td ' + pdfText('Relevé de compte - ' + acc.name) + ' Tj ET'); y -= 15;
    ops.push('BT /F1 10 Tf 50 ' + y + ' Td ' + pdfText('Période du ' + fr(from) + ' au ' + fr(today) + ' - document d\'essai, sans valeur') + ' Tj ET'); y -= 28;
  }
  ops.push('BT /F2 10 Tf 50 ' + y + ' Td ' + pdfText('Date') + ' Tj ET', 'BT /F2 10 Tf 120 ' + y + ' Td ' + pdfText('Libellé') + ' Tj ET',
    'BT /F2 10 Tf 430 ' + y + ' Td ' + pdfText('Débit') + ' Tj ET', 'BT /F2 10 Tf 500 ' + y + ' Td ' + pdfText('Crédit') + ' Tj ET');
  y -= 6; ops.push('50 ' + y + ' m 560 ' + y + ' l S'); y -= 16;
}
newPage(true);
lines.forEach(l => {
  if (y < 60) newPage(false);
  ops.push('BT /F1 10 Tf 50 ' + y + ' Td ' + pdfText(fr(l.date)) + ' Tj ET', 'BT /F1 10 Tf 120 ' + y + ' Td ' + pdfText(l.label.slice(0, 48)) + ' Tj ET',
    'BT /F1 10 Tf ' + (l.rev ? 500 : 430) + ' ' + y + ' Td ' + pdfText(num(l.amount)) + ' Tj ET');
  y -= 18;
});
if (y < 60) newPage(false);
y -= 6; ops.push('50 ' + (y + 12) + ' m 560 ' + (y + 12) + ' l S');
ops.push('BT /F2 10 Tf 120 ' + y + ' Td ' + pdfText('Solde au ' + fr(today)) + ' Tj ET', 'BT /F2 10 Tf 500 ' + y + ' Td ' + pdfText('1 234,56') + ' Tj ET');

const objs = [];
const fontsId = 3 + pages.length * 2;
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objs[2] = '<< /Type /Pages /Kids [' + pages.map((p, i) => (3 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>';
pages.forEach((p, i) => {
  const content = p.join('\n');
  objs[3 + i * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + fontsId + ' 0 R /F2 ' + (fontsId + 1) + ' 0 R >> >> /Contents ' + (4 + i * 2) + ' 0 R >>';
  objs[4 + i * 2] = '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream';
});
objs[fontsId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
objs[fontsId + 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
let pdf = '%PDF-1.4\n', offs = [];
for (let i = 1; i < objs.length; i++) { offs[i] = Buffer.byteLength(pdf, 'latin1'); pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n' + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
pdf += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
fs.writeFileSync(path.join(__dirname, 'releve-test.pdf'), Buffer.from(pdf, 'latin1'));

console.log('Releve d\'essai cree pour le compte « ' + acc.name + ' » (' + lines.length + ' lignes) :');
console.log('  releve-test.csv et releve-test.pdf, dans ce dossier.');
console.log('');
console.log('Dans Ajout eclair, choisis le compte « ' + acc.name + ' ». Ce qui est attendu :');
const key = e => e.slice(0, 13) + e.slice(13, 23).split('/').reverse().join('-');
expected.sort((a, b) => key(a).localeCompare(key(b))).forEach(e => console.log('  ' + e));
