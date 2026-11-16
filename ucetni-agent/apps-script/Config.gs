/**
 * Účetní agent – Healthy Twenty Brno
 * Nastavení. Tady můžeš měnit hodnoty; API klíč sem NEPIŠ
 * (nastavuje se přes menu „Účetní agent → Nastavit API klíč“).
 */
const CONFIG = {
  VERSION: '2026-11-16b',      // zobrazuje se dole v aplikaci – podle toho poznáš, že běží nová verze
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

const MONTH_SHEET_RE = /^\d{4}-\d{2}$/;   // starý název záložky (2026-11)

// Měsíční záložky se jmenují „Listopad 2026“. Interně pracujeme s klíčem „2026-11“.
const MONTH_NAMES = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];

/** '2026-11' → 'Listopad 2026' */
function monthSheetName_(key) {
  return MONTH_NAMES[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
}

/** 'Listopad 2026' (i starý '2026-11') → '2026-11'; jiná záložka → null */
function monthKeyFromName_(name) {
  name = String(name || '').trim();
  if (MONTH_SHEET_RE.test(name)) return name;
  const m = name.match(/^(\S+)\s+(\d{4})$/);
  if (!m) return null;
  const i = MONTH_NAMES.indexOf(m[1]);
  return i === -1 ? null : m[2] + '-' + ('0' + (i + 1)).slice(-2);
}

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
