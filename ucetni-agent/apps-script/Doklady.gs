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
