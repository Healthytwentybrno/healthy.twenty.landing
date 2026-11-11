/**
 * Účetní agent – Healthy Twenty Brno – VŠECHNO V JEDNOM SOUBORU (verze pro mobil).
 * Vlož celý obsah do souboru Kód.gs v Apps Scriptu. Druhý soubor je Index (HTML).
 * Obsah je stejný jako soubory ve složce apps-script/.
 */

// ===================== Config.gs =====================
/**
 * Účetní agent – Healthy Twenty Brno
 * Nastavení. Tady můžeš měnit hodnoty; API klíč sem NEPIŠ
 * (nastavuje se přes menu „Účetní agent → Nastavit API klíč“).
 */
const CONFIG = {
  MODEL: 'claude-opus-5-5',
  EFFORT_RECEIPT: 'medium',   // čtení dokladů
  EFFORT_STATEMENT: 'low',    // přepis výpisu (jednoduchý, ale dlouhý úkol)
  TIMEZONE: 'Europe/Prague',

  // Párování dokladu s platbou
  AMOUNT_TOLERANCE: 1,        // Kč – rozdíl, který ještě bereme jako shodu (zaokrouhlení)
  MATCH_DAYS_BEFORE: 10,      // platba může být max. N dní PŘED datem dokladu (zálohy, karta)
  MATCH_DAYS_AFTER: 60,       // platba může být max. N dní PO datu dokladu (splatnost faktury)

  // Permanentky
  WARN_DAYS: 14,              // „Končí brzy“ = méně než N dní do konce

  // Výpis v CSV se posílá AI po částech (kvůli časovým limitům Googlu)
  CSV_CHUNK_LINES: 60,

  CATEGORIES: [
    'Tržby',
    'Materiál a spotřeba',
    'Zboží k prodeji',
    'Nájem a energie',
    'Marketing a reklama',
    'Mzdy a odměny',
    'Služby a externisté',
    'Vybavení a opravy',
    'Software a předplatné',
    'Bankovní poplatky',
    'Daně a odvody',
    'Ostatní příjmy',
    'Ostatní náklady',
    'Převod (nepočítat)',
  ],

  // Kategorie, u kterých se nečeká doklad (nebude se hlásit „Chybí doklad“)
  NO_RECEIPT_NEEDED: ['Bankovní poplatky', 'Daně a odvody', 'Mzdy a odměny', 'Převod (nepočítat)'],
};

const SHEET_NAMES = {
  OVERVIEW: 'Přehled',
  MEMBERSHIPS: 'Permanentky',
  TYPES: 'Typy permanentek',
};

/** Sloupce měsíční záložky (1 = A). */
const COL = {
  DATE: 1,          // Datum (platby, jinak dokladu)
  AMOUNT: 2,        // Částka Kč (+ příjem, − výdaj)
  PARTY: 3,         // Protistrana
  DESC: 4,          // Popis
  CATEGORY: 5,      // Kategorie
  VS: 6,            // Variabilní symbol
  STATUS: 7,        // Stav
  DOC_LINK: 8,      // Doklad (odkaz na Disk)
  DOC_SUPPLIER: 9,  // Dodavatel podle dokladu
  DOC_NUMBER: 10,   // Číslo dokladu
  VAT: 11,          // DPH
  DOC_DATE: 12,     // Datum dokladu
  SOURCE: 13,       // Zdroj
  PAYMENT_ID: 14,   // ID platby (interní)
  DOC_ID: 15,       // ID dokladu (interní)
  NOTE: 16,         // Poznámka
};
const NUM_COLS = 16;
const MONTH_HEADERS = [
  'Datum', 'Částka (Kč)', 'Protistrana', 'Popis', 'Kategorie', 'VS', 'Stav',
  'Doklad', 'Dodavatel (doklad)', 'Číslo dokladu', 'DPH (Kč)', 'Datum dokladu',
  'Zdroj', 'ID platby', 'ID dokladu', 'Poznámka',
];

const STATUS = {
  MATCHED: 'Spárováno',
  MISSING_DOC: 'Chybí doklad',
  DOC_NO_PAYMENT: 'Doklad bez platby',
  INCOME: 'Příjem',
  NO_DOC_NEEDED: 'Bez dokladu (OK)',
};

const MONTH_SHEET_RE = /^\d{4}-\d{2}$/;

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

// ===================== Claude.gs =====================
/**
 * Volání Claude API (raw HTTP přes UrlFetchApp – Apps Script nemá oficiální SDK).
 * Vrací rovnou rozparsovaný JSON podle zadaného schématu (structured outputs).
 */
function callClaude_(content, schema, opts) {
  opts = opts || {};
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) {
    throw new Error('Chybí API klíč. V Google Sheetu dej menu „Účetní agent → Nastavit API klíč“.');
  }

  const body = {
    model: CONFIG.MODEL,
    max_tokens: opts.maxTokens || 16000,
    system: opts.system || '',
    messages: [{ role: 'user', content: content }],
    output_config: {
      effort: opts.effort || 'medium',
      format: { type: 'json_schema', schema: schema },
    },
    // Když by bezpečnostní filtr omylem odmítl dotaz, API ho samo zkusí na jiném modelu.
    fallbacks: 'default',
  };

  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };

  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', request);
    const code = res.getResponseCode();
    if (code === 200) break;
    const retryable = code === 429 || code === 529 || code >= 500;
    if (!retryable || attempt === 3) {
      throw new Error('Claude API chyba ' + code + ': ' + res.getContentText().slice(0, 500));
    }
    Utilities.sleep(2000 * Math.pow(2, attempt));
  }

  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal') {
    throw new Error('AI odmítla soubor zpracovat. Zkus ho nahrát znovu nebo zapsat ručně.');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('Odpověď AI byla moc dlouhá a uřízla se. Zkus soubor rozdělit na menší.');
  }
  const textBlocks = (msg.content || []).filter(function (b) { return b.type === 'text'; });
  if (!textBlocks.length) throw new Error('AI nevrátila žádná data.');
  return JSON.parse(textBlocks[textBlocks.length - 1].text);
}

/** Obsahový blok pro soubor (PDF → document, obrázek → image). */
function fileBlock_(mimeType, base64) {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowed.indexOf(mimeType) === -1) {
    throw new Error('Nepodporovaný typ souboru (' + mimeType + '). Pošli PDF, JPG nebo PNG.');
  }
  return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
}

// ===================== Sheets.gs =====================
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

// ===================== Matching.gs =====================
/**
 * Párování dokladu s bankovní platbou. Čistá logika (bez Google služeb), dá se testovat.
 *
 * doc  = { amount: číslo se znaménkem (− výdaj), date: Date|null, vs: '...', supplier: '...' }
 * pay  = { amount: číslo se znaménkem,            date: Date,      vs: '...', party: '...' }
 * Vrací skóre (menší = lepší shoda) nebo null, když to k sobě nepatří.
 */
function matchScore_(doc, pay) {
  if (!doc.amount || !pay.amount) return null;
  if ((doc.amount > 0) !== (pay.amount > 0)) return null;
  if (Math.abs(Math.abs(doc.amount) - Math.abs(pay.amount)) > CONFIG.AMOUNT_TOLERANCE) return null;

  let score = 0;
  if (doc.date && pay.date) {
    const dd = Math.round((pay.date.getTime() - doc.date.getTime()) / 86400000);
    if (dd < -CONFIG.MATCH_DAYS_BEFORE || dd > CONFIG.MATCH_DAYS_AFTER) return null;
    score += Math.abs(dd);
  } else {
    score += 30;
  }

  const vsDoc = normVs_(doc.vs);
  const vsPay = normVs_(pay.vs);
  if (vsDoc && vsPay && vsDoc === vsPay) score -= 1000;

  if (nameOverlap_(doc.supplier, pay.party)) score -= 10;
  return score;
}

/** Z kandidátů vybere nejlepší (nebo null). candidates = [{..., m: objekt pro matchScore_}] */
function bestMatch_(target, candidates, targetIsDoc) {
  let best = null;
  let bestScore = Infinity;
  candidates.forEach(function (c) {
    const s = targetIsDoc ? matchScore_(target, c.m) : matchScore_(c.m, target);
    if (s !== null && s < bestScore) { best = c; bestScore = s; }
  });
  return best;
}

function normVs_(vs) {
  const d = String(vs || '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length >= 2 ? d : '';
}

/** Mají dva názvy firmy společné aspoň jedno „významné“ slovo? (Alza.cz a.s. vs ALZA CZ) */
function nameOverlap_(a, b) {
  const stop = { 'sro': 1, 'as': 1, 'spol': 1, 'cz': 1, 'com': 1, 'the': 1, 'and': 1, 'platba': 1, 'kartou': 1 };
  const words = function (s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 3 && !stop[w]; });
  };
  const wa = words(a);
  const wb = words(b);
  return wa.some(function (w) { return wb.indexOf(w) !== -1; });
}

// ===================== Doklady.gs =====================
/**
 * Zpracování dokladu: přečíst AI → spárovat s platbou → uložit na Disk → zapsat do Sheetu.
 */

const RECEIPT_SYSTEM = [
  'Jsi pečlivý asistent účetní pro EMS fitness studio Healthy Twenty v Brně (Česko).',
  'Dostaneš jeden účetní doklad (faktura, účtenka, paragon, dobropis, zálohová faktura).',
  'Vytáhni z něj údaje přesně tak, jak jsou na dokladu. Nic si nevymýšlej:',
  'když údaj na dokladu není, vrať prázdný řetězec "" nebo 0.',
  'Data vracej ve formátu YYYY-MM-DD. Částky jako čísla s desetinnou tečkou, bez měny.',
  'castka_celkem = celková částka k úhradě včetně DPH v měně dokladu.',
  'castka_czk = částka v Kč, pokud je doklad v jiné měně a částka v Kč je na dokladu uvedena, jinak 0.',
  'smer: "vydaj", když studio platí (nákup), "prijem", když studio fakturuje svému zákazníkovi.',
  'U dobropisu je směr opačný než u původní faktury.',
  'kategorie: vyber nejvhodnější. EMS obleky, vesty, elektrody, čisticí prostředky, ručníky, drogerie',
  'pro provoz = "Materiál a spotřeba"; nápoje nebo doplňky k dalšímu prodeji = "Zboží k prodeji";',
  'Facebook/Instagram/Google reklama, letáky = "Marketing a reklama"; rezervační systém, aplikace = "Software a předplatné".',
  'popis: krátce česky, co se kupovalo (max. 80 znaků).',
  'je_doklad: false, pokud obrázek vůbec není účetní doklad (pak do poznamka napiš, co na něm je).',
  'poznamka: cokoli neobvyklého (nečitelné, chybí IČO, zálohová faktura, cizí měna…), jinak "".',
].join('\n');

// Funkce (ne konstanta), aby nezáleželo na pořadí souborů v projektu.
function receiptSchema_() {
  return {
  type: 'object',
  properties: {
    je_doklad: { type: 'boolean' },
    typ_dokladu: { type: 'string', enum: ['faktura', 'uctenka', 'zalohova_faktura', 'dobropis', 'jiny'] },
    smer: { type: 'string', enum: ['vydaj', 'prijem'] },
    dodavatel: { type: 'string' },
    ico: { type: 'string' },
    cislo_dokladu: { type: 'string' },
    variabilni_symbol: { type: 'string' },
    datum_vystaveni: { type: 'string' },
    datum_splatnosti: { type: 'string' },
    castka_celkem: { type: 'number' },
    mena: { type: 'string' },
    castka_czk: { type: 'number' },
    dph_celkem: { type: 'number' },
    kategorie: { type: 'string', enum: CONFIG.CATEGORIES },
    popis: { type: 'string' },
    poznamka: { type: 'string' },
  },
  required: ['je_doklad', 'typ_dokladu', 'smer', 'dodavatel', 'ico', 'cislo_dokladu', 'variabilni_symbol',
    'datum_vystaveni', 'datum_splatnosti', 'castka_celkem', 'mena', 'castka_czk', 'dph_celkem',
    'kategorie', 'popis', 'poznamka'],
  additionalProperties: false,
  };
}

/**
 * file = { name, mimeType, data (base64) }
 * Vrací { ok, duplicate?, matched?, message, details }
 */
function processReceipt(file) {
  const bytes = Utilities.base64Decode(file.data);
  const docId = 'D-' + md5Hex_(bytes);

  const existing = readAllMonthRows_().filter(function (r) { return r.v[COL.DOC_ID - 1] === docId; })[0];
  if (existing) {
    return { ok: true, duplicate: true, message: 'Tenhle doklad už je nahraný (záložka ' + existing.sheet.getName() + ').' };
  }

  const d = callClaude_(
    [fileBlock_(file.mimeType, file.data), { type: 'text', text: 'Zpracuj tento doklad. Název souboru: ' + file.name }],
    receiptSchema_(),
    { system: RECEIPT_SYSTEM, effort: CONFIG.EFFORT_RECEIPT }
  );

  if (!d.je_doklad) {
    return { ok: false, message: 'Tohle nevypadá jako účetní doklad. ' + (d.poznamka || '') };
  }

  const currency = (d.mena || 'CZK').toUpperCase().replace('KČ', 'CZK');
  let amountCzk = currency === 'CZK' ? d.castka_celkem : (d.castka_czk || 0);
  const sign = d.smer === 'prijem' ? 1 : -1;
  const amount = amountCzk ? sign * Math.abs(amountCzk) : 0;
  const docDate = parseDate_(d.datum_vystaveni);
  const notes = [];
  if (d.poznamka) notes.push(d.poznamka);
  if (currency !== 'CZK') notes.push('Doklad v měně ' + currency + ' (' + d.castka_celkem + ').' + (amount ? '' : ' Doplň částku v Kč.'));

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    // Kandidáti: bankovní platby, které ještě nemají doklad
    const rows = readAllMonthRows_();
    const candidates = rows.filter(function (r) {
      return r.v[COL.PAYMENT_ID - 1] && !r.v[COL.DOC_ID - 1];
    }).map(function (r) {
      r.m = { amount: Number(r.v[COL.AMOUNT - 1]), date: parseDate_(r.v[COL.DATE - 1]), vs: r.v[COL.VS - 1], party: r.v[COL.PARTY - 1] };
      return r;
    });
    const docForMatch = { amount: amount, date: docDate, vs: d.variabilni_symbol || d.cislo_dokladu, supplier: d.dodavatel };
    const match = amount ? bestMatch_(docForMatch, candidates, true) : null;

    // Uložit soubor na Disk do složky měsíce
    const monthKey = match ? match.sheet.getName() : monthKey_(docDate || new Date());
    const ext = file.mimeType === 'application/pdf' ? '.pdf' : file.mimeType === 'image/png' ? '.png' : '.jpg';
    const fileName = [d.datum_vystaveni || 'bez-data', safeName_(d.dodavatel) || 'doklad',
      (amountCzk ? Math.abs(amountCzk) : d.castka_celkem) + (currency === 'CZK' ? 'Kc' : currency)].join('_') + ext;
    const blob = Utilities.newBlob(bytes, file.mimeType, fileName);
    const driveFile = monthFolder_(monthKey).createFile(blob);
    const link = '=HYPERLINK("' + driveFile.getUrl() + '","📄 ' + fileName.replace(/"/g, '') + '")';

    let sheet;
    if (match) {
      sheet = match.sheet;
      const desc = match.v[COL.DESC - 1] ? match.v[COL.DESC - 1] + ' | ' + d.popis : d.popis;
      sheet.getRange(match.row, COL.DESC, 1, 4).setValues([[desc, d.kategorie, match.v[COL.VS - 1], STATUS.MATCHED]]);
      sheet.getRange(match.row, COL.DOC_LINK, 1, 5).setValues([[link, d.dodavatel, d.cislo_dokladu, d.dph_celkem || '', docDate || '']]);
      sheet.getRange(match.row, COL.SOURCE).setValue('Banka + doklad');
      sheet.getRange(match.row, COL.DOC_ID).setValue(docId);
      if (notes.length) sheet.getRange(match.row, COL.NOTE).setValue(notes.join(' '));
    } else {
      sheet = getOrCreateMonthSheet_(monthKey);
      const r = emptyRow_();
      r[COL.DATE - 1] = docDate || new Date();
      r[COL.AMOUNT - 1] = amount || '';
      r[COL.PARTY - 1] = d.dodavatel;
      r[COL.DESC - 1] = d.popis;
      r[COL.CATEGORY - 1] = d.kategorie;
      r[COL.VS - 1] = d.variabilni_symbol;
      r[COL.STATUS - 1] = STATUS.DOC_NO_PAYMENT;
      r[COL.DOC_LINK - 1] = link;
      r[COL.DOC_SUPPLIER - 1] = d.dodavatel;
      r[COL.DOC_NUMBER - 1] = d.cislo_dokladu;
      r[COL.VAT - 1] = d.dph_celkem || '';
      r[COL.DOC_DATE - 1] = docDate || '';
      r[COL.SOURCE - 1] = 'Doklad';
      r[COL.DOC_ID - 1] = docId;
      r[COL.NOTE - 1] = notes.join(' ');
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, NUM_COLS).setValues([r]);
      sortMonthSheet_(sheet);
    }
    SpreadsheetApp.flush();

    const what = (d.dodavatel || 'Doklad') + ' – ' + (amount ? fmtKc_(Math.abs(amount)) : d.castka_celkem + ' ' + currency) +
      (docDate ? ' (' + fmtDate_(docDate) + ')' : '');
    const message = match
      ? '✅ ' + what + ' → spárováno s platbou ' + fmtDate_(match.m.date) + ', záložka ' + sheet.getName() + '.'
      : '🟡 ' + what + ' → uloženo do záložky ' + sheet.getName() + ', zatím bez platby' +
        ' (spáruje se samo, až nahraješ výpis; pokud bylo placeno hotově, nech to tak).';

    return {
      ok: true, matched: !!match, message: message,
      details: { kategorie: d.kategorie, popis: d.popis, dph: d.dph_celkem, cislo: d.cislo_dokladu, poznamka: notes.join(' '), url: driveFile.getUrl() },
    };
  } finally {
    lock.releaseLock();
  }
}

function md5Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ===================== Banka.gs =====================
/**
 * Import bankovního výpisu (CSV / PDF / obrázek) → pohyby do měsíčních záložek
 * → automatické spárování s doklady, které už čekají.
 */

const STATEMENT_SYSTEM = [
  'Jsi asistent účetní pro EMS fitness studio Healthy Twenty v Brně.',
  'Dostaneš bankovní výpis (nebo jeho část). Přepiš VŠECHNY pohyby na účtu, každý zvlášť, nic nevynechávej',
  'a nic nevymýšlej. Nezahrnuj počáteční/konečný zůstatek ani souhrnné řádky.',
  'datum: datum zaúčtování ve formátu YYYY-MM-DD.',
  'castka: číslo v Kč se znaménkem – příchozí platba kladně, odchozí platba a poplatek záporně.',
  'protistrana: název protiúčtu / obchodníka (u karty název obchodníka), jinak číslo účtu.',
  'popis: zpráva pro příjemce / poznámka / typ transakce, stručně.',
  'vs: variabilní symbol, pokud je, jinak "".',
  'kategorie: příchozí platby od klientů, vyúčtování platebního terminálu nebo platební brány',
  '(SumUp, Comgate, GoPay, GP webpay, Stripe, Teya…) = "Tržby"; převod mezi vlastními účty, vklad/výběr',
  'hotovosti majitele = "Převod (nepočítat)"; poplatek bance = "Bankovní poplatky";',
  'finanční úřad, ČSSZ, zdravotní pojišťovna = "Daně a odvody"; jinak nejvhodnější kategorie.',
  'Když je v textu ZÁHLAVÍ jen pro kontext, pohyby z něj nepřepisuj.',
].join('\n');

function statementSchema_() {
  return {
    type: 'object',
    properties: {
      pohyby: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            datum: { type: 'string' },
            castka: { type: 'number' },
            protistrana: { type: 'string' },
            popis: { type: 'string' },
            vs: { type: 'string' },
            kategorie: { type: 'string', enum: CONFIG.CATEGORIES },
          },
          required: ['datum', 'castka', 'protistrana', 'popis', 'vs', 'kategorie'],
          additionalProperties: false,
        },
      },
    },
    required: ['pohyby'],
    additionalProperties: false,
  };
}

/** file = { name, mimeType, data (base64) } */
function processStatement(file) {
  const bytes = Utilities.base64Decode(file.data);
  const isText = /csv|text|excel/.test(file.mimeType) || /\.(csv|txt|gpc)$/i.test(file.name);

  // 1) AI přepíše výpis na pohyby
  let moves = [];
  if (isText) {
    const text = decodeText_(bytes);
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    const head = lines.slice(0, 20).join('\n');
    for (let i = 0; i < lines.length; i += CONFIG.CSV_CHUNK_LINES) {
      const part = lines.slice(i, i + CONFIG.CSV_CHUNK_LINES).join('\n');
      const prompt = (i === 0 ? '' : 'ZÁHLAVÍ SOUBORU (jen pro kontext, pohyby z něj nepřepisuj):\n' + head + '\n\n') +
        'ČÁST VÝPISU KE ZPRACOVÁNÍ:\n' + part;
      const res = callClaude_([{ type: 'text', text: prompt }], statementSchema_(),
        { system: STATEMENT_SYSTEM, effort: CONFIG.EFFORT_STATEMENT, maxTokens: 20000 });
      moves = moves.concat(res.pohyby);
    }
  } else {
    const res = callClaude_(
      [fileBlock_(file.mimeType, file.data), { type: 'text', text: 'Přepiš všechny pohyby z tohoto výpisu.' }],
      statementSchema_(),
      { system: STATEMENT_SYSTEM, effort: CONFIG.EFFORT_STATEMENT, maxTokens: 32000 }
    );
    moves = res.pohyby;
  }

  moves = moves.filter(function (p) { return parseDate_(p.datum) && Number(p.castka); });
  if (!moves.length) return { ok: false, message: 'Ve výpisu jsem nenašel žádné pohyby.' };

  // Stabilní ID pohybu (stejný výpis nahraný 2× se nezduplikuje)
  const seen = {};
  moves.forEach(function (p) {
    const base = 'P-' + md5Hex_(Utilities.newBlob([p.datum, Number(p.castka).toFixed(2),
      p.protistrana, p.vs, p.popis].join('|')).getBytes());
    seen[base] = (seen[base] || 0) + 1;
    p.id = base + '#' + seen[base];
    p.date = parseDate_(p.datum);
    p.amount = Math.round(Number(p.castka) * 100) / 100;
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const rows = readAllMonthRows_();
    const existingIds = {};
    rows.forEach(function (r) { if (r.v[COL.PAYMENT_ID - 1]) existingIds[r.v[COL.PAYMENT_ID - 1]] = true; });

    // Doklady, které čekají na platbu
    let pending = rows.filter(function (r) {
      return r.v[COL.DOC_ID - 1] && !r.v[COL.PAYMENT_ID - 1];
    }).map(function (r) {
      r.m = { amount: Number(r.v[COL.AMOUNT - 1]), date: parseDate_(r.v[COL.DOC_DATE - 1]) || parseDate_(r.v[COL.DATE - 1]),
        vs: r.v[COL.VS - 1] || r.v[COL.DOC_NUMBER - 1], supplier: r.v[COL.DOC_SUPPLIER - 1] || r.v[COL.PARTY - 1] };
      return r;
    });

    const appends = {};   // název záložky → [řádky]
    const deletes = [];   // {sheet, row}
    const touched = {};
    const stats = { added: 0, skipped: 0, matched: 0, missing: [] };

    moves.forEach(function (p) {
      if (existingIds[p.id]) { stats.skipped++; return; }
      existingIds[p.id] = true;
      const key = monthKey_(p.date);
      const payM = { amount: p.amount, date: p.date, vs: p.vs, party: p.protistrana };
      const hit = bestMatch_(payM, pending, false);

      if (hit) {
        pending = pending.filter(function (x) { return x !== hit; });
        stats.matched++;
        const merged = hit.v.slice();
        merged[COL.DATE - 1] = p.date;
        merged[COL.AMOUNT - 1] = p.amount;
        merged[COL.PARTY - 1] = p.protistrana;
        merged[COL.DESC - 1] = [p.popis, hit.v[COL.DESC - 1]].filter(String).join(' | ');
        merged[COL.VS - 1] = p.vs || hit.v[COL.VS - 1];
        merged[COL.STATUS - 1] = STATUS.MATCHED;
        merged[COL.SOURCE - 1] = 'Banka + doklad';
        merged[COL.PAYMENT_ID - 1] = p.id;
        if (hit.sheet.getName() === key) {
          hit.sheet.getRange(hit.row, 1, 1, NUM_COLS).setValues([merged]);
          touched[key] = hit.sheet;
        } else {
          // Doklad je v jiném měsíci než platba → přesunout k platbě
          (appends[key] = appends[key] || []).push(merged);
          deletes.push({ sheet: hit.sheet, row: hit.row });
        }
        return;
      }

      const r = emptyRow_();
      r[COL.DATE - 1] = p.date;
      r[COL.AMOUNT - 1] = p.amount;
      r[COL.PARTY - 1] = p.protistrana;
      r[COL.DESC - 1] = p.popis;
      r[COL.CATEGORY - 1] = p.kategorie;
      r[COL.VS - 1] = p.vs;
      r[COL.SOURCE - 1] = 'Banka';
      r[COL.PAYMENT_ID - 1] = p.id;
      if (CONFIG.NO_RECEIPT_NEEDED.indexOf(p.kategorie) !== -1) r[COL.STATUS - 1] = STATUS.NO_DOC_NEEDED;
      else if (p.amount > 0) r[COL.STATUS - 1] = STATUS.INCOME;
      else {
        r[COL.STATUS - 1] = STATUS.MISSING_DOC;
        stats.missing.push(fmtDate_(p.date) + ' · ' + p.protistrana + ' · ' + fmtKc_(p.amount));
      }
      (appends[key] = appends[key] || []).push(r);
      stats.added++;
    });

    Object.keys(appends).forEach(function (key) {
      const sh = getOrCreateMonthSheet_(key);
      const list = appends[key];
      sh.getRange(sh.getLastRow() + 1, 1, list.length, NUM_COLS).setValues(list);
      touched[key] = sh;
    });
    // Mazat odspodu, ať se neposunou čísla řádků
    deletes.sort(function (a, b) { return b.row - a.row; }).forEach(function (x) {
      x.sheet.deleteRow(x.row);
      touched[x.sheet.getName()] = x.sheet;
    });
    Object.keys(touched).forEach(function (k) { sortMonthSheet_(touched[k]); });

    // Uložit výpis na Disk (měsíc, kterého se týká nejvíc pohybů)
    const counts = {};
    moves.forEach(function (p) { const k = monthKey_(p.date); counts[k] = (counts[k] || 0) + 1; });
    const mainMonth = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    monthFolder_(mainMonth, 'Výpisy').createFile(Utilities.newBlob(bytes, file.mimeType, file.name));
    SpreadsheetApp.flush();

    const parts = ['✅ Výpis zpracován: ' + moves.length + ' pohybů.',
      'Nově zapsáno ' + (stats.added + stats.matched) + ', z toho ' + stats.matched + ' rovnou spárováno s doklady.'];
    if (stats.skipped) parts.push(stats.skipped + ' pohybů už v tabulce bylo (přeskočeno).');
    parts.push(stats.missing.length ? '❗ Chybí doklad u ' + stats.missing.length + ' plateb – viz seznam.' : 'U všech výdajů je doklad. 🎉');

    return { ok: true, message: parts.join(' '), missing: stats.missing, months: Object.keys(touched).sort() };
  } finally {
    lock.releaseLock();
  }
}

/** České banky často exportují CSV ve windows-1250. */
function decodeText_(bytes) {
  const utf = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  if (utf.indexOf('�') === -1) return utf.replace(/^﻿/, '');
  return Utilities.newBlob(bytes).getDataAsString('windows-1250');
}

/** Seznam plateb bez dokladu napříč měsíci (nejnovější nahoře). */
function getMissingDocs_() {
  return readAllMonthRows_().filter(function (r) {
    return r.v[COL.STATUS - 1] === STATUS.MISSING_DOC;
  }).map(function (r) {
    const d = parseDate_(r.v[COL.DATE - 1]);
    return { ts: d ? d.getTime() : 0, date: fmtDate_(d), party: String(r.v[COL.PARTY - 1]),
      amount: Number(r.v[COL.AMOUNT - 1]) || 0, desc: String(r.v[COL.DESC - 1]), month: r.sheet.getName() };
  }).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 100);
}

// ===================== Permanentky.gs =====================
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
      return {
        name: String(r[0]), email: String(r[1]), phone: String(r[2]), type: String(r[3]),
        bought: r[4] instanceof Date ? fmtDate_(r[4]) : '',
        end: end ? fmtDate_(end) : '', endTs: end ? end.getTime() : null,
        daysLeft: r[7] === '' ? null : Number(r[7]), status: String(r[8]), note: String(r[9]),
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
  return { ok: true, message: '✅ ' + m.name + ' – ' + m.type + ', platí do ' + (end instanceof Date ? fmtDate_(end) : '?') + '.' };
}

// ===================== Setup.gs =====================
/**
 * Menu v Google Sheetu a první nastavení.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🤖 Účetní agent')
    .addItem('1) První nastavení', 'setup')
    .addItem('2) Nastavit API klíč', 'setApiKey')
    .addItem('3) Nastavit složku účetní na Disku', 'setDriveFolder')
    .addSeparator()
    .addItem('Obnovit Přehled', 'refreshOverview')
    .addItem('Otevřít aplikaci', 'showWebAppLink')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  setProp_('SPREADSHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  rebuildOverview_();
  setupMemberships_();
  getOrCreateMonthSheet_(monthKey_(new Date()));
  const folder = rootFolder_();
  const msg = 'Hotovo ✅\n\nZáložky Přehled, Permanentky a aktuální měsíc jsou připravené.\n' +
    'Doklady se budou ukládat do složky na Disku:\n' + folder.getName() + '\n' + folder.getUrl() +
    '\n\nTuhle složku nasdílej účetní (pravým tlačítkem → Sdílet). Nebo si v menu nastav vlastní složku.';
  // Spuštěno z editoru (např. na mobilu) → okno nejde zobrazit, vypíše se do protokolu
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('API klíč Claude', 'Vlož API klíč z console.anthropic.com (začíná sk-ant-):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!/^sk-ant-/.test(key)) { ui.alert('Tohle nevypadá jako API klíč (má začínat sk-ant-).'); return; }
  setProp_('ANTHROPIC_API_KEY', key);
  ui.alert('Klíč uložen ✅ (je uložený v nastavení skriptu, ne v tabulce).');
}

function setDriveFolder() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Složka účetní', 'Vlož odkaz na složku na Google Disku, kam se mají ukládat doklady:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = r.getResponseText().match(/[-\w]{25,}/);
  if (!m) { ui.alert('V odkazu jsem nenašel ID složky.'); return; }
  try {
    const f = DriveApp.getFolderById(m[0]);
    setProp_('DRIVE_FOLDER_ID', f.getId());
    ui.alert('Nastaveno ✅ Doklady se budou ukládat do: ' + f.getName());
  } catch (e) {
    ui.alert('Ke složce nemám přístup. Zkontroluj odkaz a že máš ke složce právo úprav.');
  }
}

function showWebAppLink() {
  const url = ScriptApp.getService().getUrl();
  const html = url
    ? '<p>Aplikace: <a href="' + url + '" target="_blank">' + url + '</a></p><p>Ulož si odkaz do mobilu na plochu.</p>'
    : '<p>Aplikace ještě není nasazená. V editoru skriptu dej <b>Nasadit → Nové nasazení → Webová aplikace</b> (viz návod).</p>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(480).setHeight(160), 'Účetní agent');
}

function refreshOverview() {
  rebuildOverview_();
}

// ===================== WebApp.gs =====================
/**
 * Webová aplikace (otevřeš v mobilu / počítači). Funkce bez podtržítka na konci
 * volá stránka přes google.script.run.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Účetní agent – Healthy Twenty')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function safe_(fn) {
  try {
    return fn();
  } catch (e) {
    console.error(e && e.stack || e);
    return { ok: false, message: '⚠️ ' + (e && e.message ? e.message : String(e)) };
  }
}

function apiProcessReceipt(file) { return safe_(function () { return processReceipt(file); }); }
function apiProcessStatement(file) { return safe_(function () { return processStatement(file); }); }

function apiDashboard() {
  return safe_(function () {
    return {
      ok: true,
      overview: getOverviewData_(),
      missing: getMissingDocs_(),
      sheetUrl: ss_().getUrl(),
      folderUrl: prop_('DRIVE_FOLDER_ID') ? DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID')).getUrl() : '',
    };
  });
}

function apiMemberships() {
  return safe_(function () {
    return { ok: true, list: getMemberships_(), types: getMembershipTypes_(), warnDays: CONFIG.WARN_DAYS };
  });
}

function apiAddMembership(m) { return safe_(function () { return addMembership_(m); }); }
