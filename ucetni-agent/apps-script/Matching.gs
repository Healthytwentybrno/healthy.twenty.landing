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
