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
