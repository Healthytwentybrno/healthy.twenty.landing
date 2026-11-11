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
