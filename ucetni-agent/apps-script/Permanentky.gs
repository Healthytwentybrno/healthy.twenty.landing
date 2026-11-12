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
  const weeks = 'IFERROR(VLOOKUP(D2:D,' + t + ',2,FALSE),0)';
  const days = 'IFERROR(VLOOKUP(D2:D,' + t + ',3,FALSE),0)';
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

function getMemberships_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.MEMBERSHIPS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, MEMBERSHIP_HEADERS.length).getValues()
    .filter(function (r) { return r[0] !== '' || r[4] !== ''; })
    .map(function (r) {
      const end = r[6] instanceof Date ? r[6] : null;
      // Zbývající dny počítáme tady (nespoléháme jen na vzorec ve sloupci H)
      const daysLeft = end ? daysUntil_(end) : null;
      return {
        name: String(r[0]), email: String(r[1]), phone: String(r[2]), type: String(r[3]),
        bought: r[4] instanceof Date ? fmtDate_(r[4]) : '',
        end: end ? fmtDate_(end) : '', endTs: end ? end.getTime() : null,
        daysLeft: daysLeft, status: String(r[8]), note: String(r[9]),
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
  const end = sh.getRange(row, 7).getValue();
  if (!(end instanceof Date)) {
    return { ok: true, message: '⚠️ Uloženo, ale typ „' + m.type + '“ nemá v záložce Typy permanentek vyplněnou platnost.' };
  }
  return { ok: true, message: '✅ ' + m.name + ' – ' + m.type + ', platí do ' + fmtDate_(end) +
    ' (zbývá ' + daysUntil_(end) + ' dní).' };
}

/** Počet dní od dneška do data (dnes = 0, včera = −1). */
function daysUntil_(date) {
  const tz = CONFIG.TIMEZONE;
  const a = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const b = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
  return Math.round((parseDate_(b).getTime() - parseDate_(a).getTime()) / 86400000);
}
