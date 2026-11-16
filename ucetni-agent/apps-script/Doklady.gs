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

  const saved = saveDocEntry_({
    docId: docId, amount: amount, docDate: docDate,
    matchVs: d.variabilni_symbol || d.cislo_dokladu, vs: d.variabilni_symbol,
    supplier: d.dodavatel, category: d.kategorie, desc: d.popis,
    number: d.cislo_dokladu, vat: d.dph_celkem, notes: notes.join(' '), source: 'Doklad',
  }, function (monthKey) {
    // Uložit soubor na Disk do složky měsíce
    const ext = file.mimeType === 'application/pdf' ? '.pdf' : file.mimeType === 'image/png' ? '.png' : '.jpg';
    const fileName = [d.datum_vystaveni || 'bez-data', safeName_(d.dodavatel) || 'doklad',
      (amountCzk ? Math.abs(amountCzk) : d.castka_celkem) + (currency === 'CZK' ? 'Kc' : currency)].join('_') + ext;
    const driveFile = monthFolder_(monthKey).createFile(Utilities.newBlob(bytes, file.mimeType, fileName));
    return { formula: '=HYPERLINK("' + driveFile.getUrl() + '","📄 ' + fileName.replace(/"/g, '') + '")', url: driveFile.getUrl() };
  });

  const what = (d.dodavatel || 'Doklad') + ' – ' + (amount ? fmtKc_(Math.abs(amount)) : d.castka_celkem + ' ' + currency) +
    (docDate ? ' (' + fmtDate_(docDate) + ')' : '');
  return {
    ok: true, matched: !!saved.match, message: resultMessage_(what, saved),
    details: { kategorie: d.kategorie, popis: d.popis, dph: d.dph_celkem, cislo: d.cislo_dokladu, poznamka: notes.join(' '), url: saved.url },
  };
}

function resultMessage_(what, saved) {
  return saved.match
    ? '✅ ' + what + ' → spárováno s platbou ' + fmtDate_(saved.match.m.date) + ', záložka ' + saved.sheet.getName() + '.'
    : '🟡 ' + what + ' → uloženo do záložky ' + saved.sheet.getName() + ', zatím bez platby' +
      ' (spáruje se samo, až nahraješ výpis; pokud bylo placeno hotově, nech to tak).';
}

/**
 * Společné pro doklad i slovně zadaný náklad: najít platbu, zapsat do Sheetu.
 * e = { docId, amount, docDate, matchVs, vs, supplier, category, desc, number, vat, notes, source }
 * makeLink(monthKey) → { formula, url }  (obsah sloupce „Doklad“)
 */
function saveDocEntry_(e, makeLink) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    // Kandidáti: bankovní platby, které ještě nemají doklad
    const candidates = readAllMonthRows_().filter(function (r) {
      return r.v[COL.PAYMENT_ID - 1] && !r.v[COL.DOC_ID - 1];
    }).map(function (r) {
      r.m = { amount: Number(r.v[COL.AMOUNT - 1]), date: parseDate_(r.v[COL.DATE - 1]), vs: r.v[COL.VS - 1], party: r.v[COL.PARTY - 1] };
      return r;
    });
    const match = e.amount
      ? bestMatch_({ amount: e.amount, date: e.docDate, vs: e.matchVs, supplier: e.supplier }, candidates, true)
      : null;

    const monthKey = match ? match.sheet.getName() : monthKey_(e.docDate || new Date());
    const link = makeLink(monthKey);

    let sheet;
    if (match) {
      sheet = match.sheet;
      const desc = match.v[COL.DESC - 1] ? match.v[COL.DESC - 1] + ' | ' + e.desc : e.desc;
      sheet.getRange(match.row, COL.DESC, 1, 4).setValues([[desc, e.category, match.v[COL.VS - 1], STATUS.MATCHED]]);
      sheet.getRange(match.row, COL.DOC_LINK, 1, 5).setValues([[link.formula, e.supplier, e.number || '', e.vat || '', e.docDate || '']]);
      sheet.getRange(match.row, COL.SOURCE).setValue('Banka + ' + e.source.toLowerCase());
      sheet.getRange(match.row, COL.DOC_ID).setValue(e.docId);
      if (e.notes) sheet.getRange(match.row, COL.NOTE).setValue(e.notes);
    } else {
      sheet = getOrCreateMonthSheet_(monthKey);
      const r = emptyRow_();
      r[COL.DATE - 1] = e.docDate || new Date();
      r[COL.AMOUNT - 1] = e.amount || '';
      r[COL.PARTY - 1] = e.supplier;
      r[COL.DESC - 1] = e.desc;
      r[COL.CATEGORY - 1] = e.category;
      r[COL.VS - 1] = e.vs || '';
      r[COL.STATUS - 1] = STATUS.DOC_NO_PAYMENT;
      r[COL.DOC_LINK - 1] = link.formula;
      r[COL.DOC_SUPPLIER - 1] = e.supplier;
      r[COL.DOC_NUMBER - 1] = e.number || '';
      r[COL.VAT - 1] = e.vat || '';
      r[COL.DOC_DATE - 1] = e.docDate || '';
      r[COL.SOURCE - 1] = e.source;
      r[COL.DOC_ID - 1] = e.docId;
      r[COL.NOTE - 1] = e.notes || '';
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, NUM_COLS).setValues([r]);
      sortMonthSheet_(sheet);
    }
    SpreadsheetApp.flush();
    return { match: match, sheet: sheet, url: link.url || '' };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Náklad zadaný slovně (doklad/smlouvu má účetní) ----------

const TEXT_EXPENSE_SYSTEM = [
  'Jsi asistent účetní pro EMS fitness studio Healthy Twenty v Brně.',
  'Majitel slovně popíše NÁKLAD (výdaj), ke kterému už účetní eviduje smlouvu nebo doklad',
  '(např. nájem, energie, leasing, pojištění, mzda). Vytáhni z textu údaje. Nic si nevymýšlej:',
  'co v textu není, vrať jako "" nebo 0.',
  'castka: celková částka v Kč jako kladné číslo („25 tisíc“ = 25000, „1,5 tis.“ = 1500).',
  'datum: YYYY-MM-DD. Když je uveden jen měsíc („za listopad“), použij 1. den toho měsíce.',
  'Když datum chybí úplně, vrať "" (doplní se dnešní).',
  'dodavatel: komu se platí. popis: krátce česky, co to je (max. 80 znaků).',
  'kategorie: nejvhodnější z nabídky (nájem a energie, služby, mzdy…).',
].join('\n');

function textExpenseSchema_() {
  return {
    type: 'object',
    properties: {
      castka: { type: 'number' },
      datum: { type: 'string' },
      dodavatel: { type: 'string' },
      popis: { type: 'string' },
      variabilni_symbol: { type: 'string' },
      kategorie: { type: 'string', enum: CONFIG.CATEGORIES },
      poznamka: { type: 'string' },
    },
    required: ['castka', 'datum', 'dodavatel', 'popis', 'variabilni_symbol', 'kategorie', 'poznamka'],
    additionalProperties: false,
  };
}

/** text = volný popis nákladu, např. „Nájem studia za listopad 25 000 Kč, pronajímatel Novák“ */
function processTextExpense(text) {
  text = String(text || '').trim();
  if (text.length < 3) return { ok: false, message: 'Napiš, o jaký náklad jde a kolik stál.' };

  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  // Stejný text ve stejný den = omylem odesláno dvakrát
  const docId = 'T-' + md5Hex_(Utilities.newBlob(today + '|' + text.toLowerCase().replace(/\s+/g, ' ')).getBytes());
  const existing = readAllMonthRows_().filter(function (r) { return r.v[COL.DOC_ID - 1] === docId; })[0];
  if (existing) {
    return { ok: true, duplicate: true, message: 'Tenhle náklad jsi dnes už zapsal (záložka ' + existing.sheet.getName() + ').' };
  }

  const d = callClaude_([{ type: 'text', text: 'Dnešní datum: ' + today + '\nPopis nákladu: ' + text }],
    textExpenseSchema_(), { system: TEXT_EXPENSE_SYSTEM, effort: 'low', maxTokens: 4000 });

  if (!d.castka) {
    return { ok: false, message: 'V textu jsem nenašel částku. Napiš ji, např. „… 25 000 Kč“.' };
  }
  const amount = -Math.abs(d.castka);   // vždy náklad
  const docDate = parseDate_(d.datum) || parseDate_(today);
  const notes = ['Zadáno slovně – doklad/smlouvu eviduje účetní.', d.poznamka].filter(String).join(' ');

  const saved = saveDocEntry_({
    docId: docId, amount: amount, docDate: docDate,
    matchVs: d.variabilni_symbol, vs: d.variabilni_symbol,
    supplier: d.dodavatel, category: d.kategorie, desc: d.popis || text.slice(0, 80),
    number: '', vat: '', notes: notes, source: 'Slovně',
  }, function () {
    return { formula: '📝 u účetní (smlouva)', url: '' };
  });

  const what = (d.dodavatel || d.popis || 'Náklad') + ' – ' + fmtKc_(Math.abs(amount)) + ' (' + fmtDate_(docDate) + ')';
  return {
    ok: true, matched: !!saved.match, message: resultMessage_(what, saved),
    details: { kategorie: d.kategorie, popis: d.popis, poznamka: notes },
  };
}

function md5Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
