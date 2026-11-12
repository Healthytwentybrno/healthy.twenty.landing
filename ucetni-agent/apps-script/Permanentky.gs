/**
 * Permanentky: evidence a přehled, komu kdy končí platnost.
 * Konec platnosti se počítá vzorcem z typu permanentky (záložka „Typy permanentek“),
 * takže funguje i když řádek zapíšeš rovnou do Sheetu.
 */

const MEMBERSHIP_HEADERS = ['Jméno', 'E-mail', 'Telefon', 'Typ', 'Datum zakoupení',
  'Konec ručně (nepovinné)', 'Konec platnosti', 'Zbývá dní', 'Stav', 'Poznámka'];

function setupMemberships_() {
  const ss = ss_();

  const typeHeaders = [['Typ', 'Platnost (týdny)', 'Platnost (dny navíc)', 'Cena (Kč)']];
  let types = ss.getSheetByName(SHEET_NAMES.TYPES);
  if (!types) {
    types = ss.insertSheet(SHEET_NAMES.TYPES);
    // Ukázkové typy – přepiš podle svého ceníku
    types.getRange(2, 1, 4, 4).setValues([
      ['Zkušební trénink', 2, 0, ''],
      ['Měsíční', 4, 0, ''],
      ['10 vstupů', 12, 0, ''],
      ['20 vstupů', 24, 0, ''],
    ]);
    types.setFrozenRows(1);
    types.setColumnWidths(1, 4, 160);
  } else if (types.getRange('B1').getValue() === 'Platnost (měsíce)') {
    // Starší verze měla platnost v měsících → převést na týdny
    const n = types.getLastRow() - 1;
    if (n > 0) {
      const b = types.getRange(2, 2, n, 1).getValues().map(function (r) {
        return [r[0] === '' ? '' : Math.round(Number(r[0]) * 52 / 12)];
      });
      types.getRange(2, 2, n, 1).setValues(b);
    }
  }
  types.getRange(1, 1, 1, 4).setValues(typeHeaders)
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');

  let sh = ss.getSheetByName(SHEET_NAMES.MEMBERSHIPS);
  if (!sh) sh = ss.insertSheet(SHEET_NAMES.MEMBERSHIPS, 1);

  sh.getRange(1, 1, 1, MEMBERSHIP_HEADERS.length).setValues([MEMBERSHIP_HEADERS])
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('E2:G').setNumberFormat('d. M. yyyy');
  sh.getRange('H2:H').setNumberFormat('0');

  const t = "'" + SHEET_NAMES.TYPES + "'!$A$2:$C";
  // Číslo vytáhneme i z textu typu „15 týdnů“
  const num = function (col) {
    return 'IFERROR(VALUE(REGEXEXTRACT(TO_TEXT(VLOOKUP(D2:D,' + t + ',' + col + ',FALSE)),"[0-9]+")),0)';
  };
  const weeks = num(2);
  const days = num(3);
  // Konec = datum nákupu + týdny × 7 + dny navíc
  sh.getRange('G1').setFormula('={"Konec platnosti";ARRAYFORMULA(IF(E2:E="","",IF(F2:F<>"",F2:F,' +
    'E2:E+' + weeks + '*7+' + days + ')))}');
  sh.getRange('H1').setFormula('={"Zbývá dní";ARRAYFORMULA(IF(G2:G="","",G2:G-TODAY()))}');
  sh.getRange('I1').setFormula('={"Stav";ARRAYFORMULA(IF(H2:H="","",IF(H2:H<0,"Prošlá",IF(H2:H<=' +
    CONFIG.WARN_DAYS + ',"Končí brzy","Platná"))))}');
  sh.getRange('G1:I1').setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');

  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(types.getRange('A2:A'), true).setAllowInvalid(true).build();
  sh.getRange('D2:D').setDataValidation(typeRule);

  const st = sh.getRange('A2:J');
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$I2="Prošlá"')
      .setBackground('#f3f4f6').setFontColor('#9ca3af').setRanges([st]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$I2="Končí brzy"')
      .setBackground('#fef3c7').setRanges([st]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$I2="Platná"')
      .setBackground('#ecfdf5').setRanges([sh.getRange('I2:I')]).build(),
  ]);
  sh.setColumnWidths(1, MEMBERSHIP_HEADERS.length, 140);
  sh.setColumnWidth(10, 220);
}

function getMembershipTypes_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.TYPES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(String);
}

/** Typy permanentek → { 'název': { weeks, days } } (čísla bere i z textu „15 týdnů“). */
function typesMap_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.TYPES);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    const name = String(r[0]).trim();
    if (name) map[name.toLowerCase()] = { weeks: num_(r[1]), days: num_(r[2]) };
  });
  return map;
}

function num_(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** Datum z buňky: Date, '2026-11-12', '12. 11. 2026' i '12.11.2026'. */
function anyDate_(v) {
  if (v instanceof Date) return v;
  const iso = parseDate_(v);
  if (iso) return iso;
  const m = String(v || '').match(/^\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0) : null;
}

/** Konec platnosti = ruční datum, jinak datum nákupu + týdny × 7 + dny navíc. Neznámý typ → null. */
function membershipEnd_(bought, manualEnd, type, types) {
  const manual = anyDate_(manualEnd);
  if (manual) return manual;
  const b = anyDate_(bought);
  const t = types[String(type || '').trim().toLowerCase()];
  if (!b || !t || !(t.weeks || t.days)) return null;
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 12, 0, 0);
  end.setDate(end.getDate() + Math.round(t.weeks * 7 + t.days));
  return end;
}

function membershipStatus_(daysLeft) {
  if (daysLeft === null) return '';
  return daysLeft < 0 ? 'Prošlá' : daysLeft <= CONFIG.WARN_DAYS ? 'Končí brzy' : 'Platná';
}

function getMemberships_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.MEMBERSHIPS);
  if (!sh || sh.getLastRow() < 2) return [];
  const types = typesMap_();
  return sh.getRange(2, 1, sh.getLastRow() - 1, MEMBERSHIP_HEADERS.length).getValues()
    .filter(function (r) { return r[0] !== '' || r[4] !== ''; })
    .map(function (r) {
      // Počítáme tady v kódu – nespoléháme na vzorce v tabulce
      const end = membershipEnd_(r[4], r[5], r[3], types);
      const daysLeft = end ? daysUntil_(end) : null;
      const bought = anyDate_(r[4]);
      return {
        name: String(r[0]), email: String(r[1]), phone: String(r[2]), type: String(r[3]),
        bought: bought ? fmtDate_(bought) : '',
        end: end ? fmtDate_(end) : '',
        daysLeft: daysLeft, status: membershipStatus_(daysLeft), note: String(r[9]),
      };
    })
    .sort(function (a, b) {
      // Nejdřív platné podle toho, komu končí nejdřív, prošlé až na konec
      const ka = a.daysLeft === null ? 1e9 : (a.daysLeft < 0 ? 1e6 - a.daysLeft : a.daysLeft);
      const kb = b.daysLeft === null ? 1e9 : (b.daysLeft < 0 ? 1e6 - b.daysLeft : b.daysLeft);
      return ka - kb;
    });
}

/** m = { name, email, phone, type, bought: 'YYYY-MM-DD', note } */
function addMembership_(m) {
  if (!m.name || !m.type || !m.bought) throw new Error('Vyplň jméno, typ a datum zakoupení.');
  const bought = parseDate_(m.bought);
  if (!bought) throw new Error('Neplatné datum zakoupení.');
  const sh = ss_().getSheetByName(SHEET_NAMES.MEMBERSHIPS);
  // Najít první prázdný řádek ve sloupci A (sloupce G–I jsou vzorce přes celý sloupec)
  const colA = sh.getRange('A2:A').getValues();
  let row = 2;
  for (let i = 0; i < colA.length; i++) { if (colA[i][0] === '') { row = i + 2; break; } row = i + 3; }
  sh.getRange(row, 1, 1, 6).setValues([[m.name, m.email || '', m.phone || '', m.type, bought, '']]);
  sh.getRange(row, 10).setValue(m.note || '');
  SpreadsheetApp.flush();

  const end = membershipEnd_(bought, '', m.type, typesMap_());
  if (!end) {
    return { ok: true, message: '⚠️ Uloženo, ale typ „' + m.type + '“ nemá v záložce Typy permanentek ' +
      'vyplněnou platnost (do sloupce B napiš jen číslo týdnů, např. 15).' };
  }
  return { ok: true, message: '✅ ' + m.name + ' – ' + m.type + ' · Platí do: ' + fmtDate_(end) +
    ' · Zbývá ' + daysUntil_(end) + ' dní' };
}

/** Počet dní od dneška do data (dnes = 0, včera = −1). */
function daysUntil_(date) {
  const tz = CONFIG.TIMEZONE;
  const a = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const b = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
  return Math.round((parseDate_(b).getTime() - parseDate_(a).getTime()) / 86400000);
}
