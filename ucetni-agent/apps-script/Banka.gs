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
