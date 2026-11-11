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
