/**
 * Práce se záložkami: měsíční záložky, Přehled, Disk.
 */

// ---------- Datum ----------

/** 'YYYY-MM-DD' → Date (poledne, ať nás nezlobí časová pásma). Neplatné → null. */
function parseDate_(s) {
  if (s instanceof Date) return s;
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function monthKey_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM');
}

function fmtDate_(date) {
  return date ? Utilities.formatDate(date, CONFIG.TIMEZONE, 'd. M. yyyy') : '';
}

function daysBetween_(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function fmtKc_(n) {
  const s = Math.abs(n).toFixed(2).replace(/\.00$/, '').replace('.', ',');
  return (n < 0 ? '−' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
}

// ---------- Měsíční záložky ----------

function getOrCreateMonthSheet_(key) {
  const ss = ss_();
  let sh = ss.getSheetByName(key);
  if (sh) return sh;

  // Zařadit záložku chronologicky za Přehled
  const months = ss.getSheets().filter(function (s) { return MONTH_SHEET_RE.test(s.getName()); });
  let index = 1;
  months.forEach(function (s) { if (s.getName() > key) return; index = Math.max(index, s.getIndex()); });
  sh = ss.insertSheet(key, index);

  sh.getRange(1, 1, 1, NUM_COLS).setValues([MONTH_HEADERS])
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('A2:A').setNumberFormat('d. M. yyyy');
  sh.getRange('L2:L').setNumberFormat('d. M. yyyy');
  sh.getRange('B2:B').setNumberFormat('#,##0.00 "Kč";[Red]-#,##0.00 "Kč"');
  sh.getRange('K2:K').setNumberFormat('#,##0.00 "Kč"');
  sh.setColumnWidths(1, NUM_COLS, 120);
  sh.setColumnWidth(COL.DESC, 260);
  sh.hideColumns(COL.PAYMENT_ID, 2);

  const statusRange = sh.getRange('G2:G');
  const rules = [
    [STATUS.MATCHED, '#d1fae5'],
    [STATUS.MISSING_DOC, '#fee2e2'],
    [STATUS.DOC_NO_PAYMENT, '#fef3c7'],
    [STATUS.INCOME, '#dbeafe'],
    [STATUS.NO_DOC_NEEDED, '#f3f4f6'],
  ].map(function (r) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(r[0])
      .setBackground(r[1]).setRanges([statusRange]).build();
  });
  sh.setConditionalFormatRules(rules);

  const catRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.CATEGORIES, true).setAllowInvalid(true).build();
  sh.getRange('E2:E').setDataValidation(catRule);

  // Souhrn měsíce vpravo (sloupce R:S) – vzorce, takže sedí i po ručních úpravách
  const excl = '"<>Převod (nepočítat)"';
  const summary = [
    ['Souhrn měsíce', ''],
    ['Tržby', '=SUMIFS(B2:B,B2:B,">0",E2:E,' + excl + ')'],
    ['Náklady', '=-SUMIFS(B2:B,B2:B,"<0",E2:E,' + excl + ')'],
    ['Zisk', '=S2-S3'],
    ['Počet dokladů', '=COUNTA(O2:O)'],
    ['Chybí doklad', '=COUNTIF(G2:G,"' + STATUS.MISSING_DOC + '")'],
    ['Doklad bez platby', '=COUNTIF(G2:G,"' + STATUS.DOC_NO_PAYMENT + '")'],
  ];
  sh.getRange(1, 18, summary.length, 2).setValues(summary);
  sh.getRange('R1:S1').setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.getRange('R2:R7').setFontWeight('bold');
  sh.getRange('S2:S4').setNumberFormat('#,##0 "Kč";[Red]-#,##0 "Kč"');
  sh.getRange('R9').setValue('Náklady podle kategorie').setFontWeight('bold');
  sh.getRange('R10').setFormula(
    '=IFERROR(QUERY(A2:P,"select E, -sum(B) where B < 0 and E <> \'Převod (nepočítat)\' ' +
    'group by E order by sum(B) asc label E \'\', -sum(B) \'\'",0),"")');
  sh.getRange('S10:S40').setNumberFormat('#,##0 "Kč"');
  sh.setColumnWidth(18, 180);
  sh.setColumnWidth(19, 120);

  rebuildOverview_();
  return sh;
}

/** Všechny řádky ze všech měsíčních záložek: [{sheet, row, v: [...hodnoty]}] */
function readAllMonthRows_() {
  const out = [];
  ss_().getSheets().forEach(function (sh) {
    if (!MONTH_SHEET_RE.test(sh.getName())) return;
    const last = sh.getLastRow();
    if (last < 2) return;
    const values = sh.getRange(2, 1, last - 1, NUM_COLS).getValues();
    const links = sh.getRange(2, COL.DOC_LINK, last - 1, 1).getFormulas();
    values.forEach(function (v, i) {
      if (v[COL.DATE - 1] === '' && v[COL.AMOUNT - 1] === '') return;
      // odkaz na doklad je vzorec HYPERLINK – getValues by vrátil jen text
      if (links[i][0]) v[COL.DOC_LINK - 1] = links[i][0];
      out.push({ sheet: sh, row: i + 2, v: v });
    });
  });
  return out;
}

function sortMonthSheet_(sh) {
  const last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, NUM_COLS).sort({ column: COL.DATE, ascending: true });
}

function emptyRow_() {
  const r = [];
  for (let i = 0; i < NUM_COLS; i++) r.push('');
  return r;
}

// ---------- Přehled ----------

/** Záložka Přehled: řádek za každý měsíc, hodnoty odkazem na souhrn měsíce (živě). */
function rebuildOverview_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEET_NAMES.OVERVIEW);
  if (!sh) sh = ss.insertSheet(SHEET_NAMES.OVERVIEW, 0);

  const months = ss.getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return MONTH_SHEET_RE.test(n); }).sort();

  sh.clear();
  const header = ['Měsíc', 'Tržby', 'Náklady', 'Zisk', 'Marže', 'Počet dokladů', 'Chybí doklad', 'Doklad bez platby'];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const rows = months.map(function (m, i) {
    const r = i + 2;
    const q = "'" + m + "'!";
    return [m, '=' + q + 'S2', '=' + q + 'S3', '=B' + r + '-C' + r,
      '=IF(B' + r + '=0,"",D' + r + '/B' + r + ')',
      '=' + q + 'S5', '=' + q + 'S6', '=' + q + 'S7'];
  });
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    const t = rows.length + 2;
    sh.getRange(t, 1, 1, header.length).setValues([[
      'Celkem', '=SUM(B2:B' + (t - 1) + ')', '=SUM(C2:C' + (t - 1) + ')', '=B' + t + '-C' + t,
      '=IF(B' + t + '=0,"",D' + t + '/B' + t + ')',
      '=SUM(F2:F' + (t - 1) + ')', '=SUM(G2:G' + (t - 1) + ')', '=SUM(H2:H' + (t - 1) + ')',
    ]]).setFontWeight('bold').setBackground('#f3f4f6');
    sh.getRange(2, 2, rows.length + 1, 3).setNumberFormat('#,##0 "Kč";[Red]-#,##0 "Kč"');
    sh.getRange(2, 5, rows.length + 1, 1).setNumberFormat('0 %');
  }
  sh.setColumnWidths(1, header.length, 130);
}

function getOverviewData_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.OVERVIEW);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().map(function (r) {
    return {
      month: String(r[0]), revenue: Number(r[1]) || 0, costs: Number(r[2]) || 0,
      profit: Number(r[3]) || 0, docs: Number(r[5]) || 0, missing: Number(r[6]) || 0,
      unpaid: Number(r[7]) || 0,
    };
  });
}

// ---------- Google Disk ----------

function rootFolder_() {
  const id = prop_('DRIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const f = DriveApp.createFolder('Účetnictví – Healthy Twenty');
  setProp_('DRIVE_FOLDER_ID', f.getId());
  return f;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Složka měsíce: <kořen>/2026/2026-11 (+ volitelně podsložka). */
function monthFolder_(key, sub) {
  const year = childFolder_(rootFolder_(), key.slice(0, 4));
  const month = childFolder_(year, key);
  return sub ? childFolder_(month, sub) : month;
}

function safeName_(s) {
  return String(s || '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
