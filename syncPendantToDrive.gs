/**
 * syncPendantToDrive.gs
 * Creates a Google Doc per day: "YYYY-MM-DD Pendant Summary".  
 * Strategy: 24 hourly windows, limit=10, cursor pagination, basic backoff.
 *
 * Script Properties required:
 *  - LIMITLESS_API_KEY
 *  - FOLDER_ID
 *  - TIMEZONE = America/New_York
 * Optional:
 *  - RUN_TODAY = false
 *  - FORCE_DATE = YYYY-MM-DD (one-off backfill)
 *  - BACKFILL_START = YYYY-MM-DD
 *  - BACKFILL_END   = YYYY-MM-DD
 *  - OVERWRITE = true to rebuild existing days during backfill
 *  - BACKFILL_STATE (auto managed)
 */

const API_BASE = 'https://api.limitless.ai/v1/lifelogs';

/** Entry point for daily use */
function syncPendantToDrive() {
  const props = PropertiesService.getScriptProperties();
  const API_KEY = mustProp(props, 'LIMITLESS_API_KEY');
  const FOLDER_ID = mustProp(props, 'FOLDER_ID');
  const TZ = props.getProperty('TIMEZONE') || 'America/New_York';
  const RUN_TODAY = (props.getProperty('RUN_TODAY') || 'false').toLowerCase() === 'true';

  const dates = computeDates(props, TZ, RUN_TODAY);
  const title = `${dates.dateLabel} Pendant Summary`;

  const folder = getFolderStrict(FOLDER_ID);
  const hours = buildHourlyWindows(dates.dateParam, TZ);

  const lifelogs = [];
  for (const win of hours) {
    const windowLogs = fetchWindowWithPagination(API_KEY, TZ, win.startISO, win.endISO);
    lifelogs.push(...windowLogs);
  }

  // Create or overwrite the doc
  let file = findByName(folder, title);
  if (!file) {
    file = DocumentApp.create(title);
    DriveApp.getFileById(file.getId()).moveTo(folder);
  }
  const doc = DocumentApp.openById(file.getId());
  const body = doc.getBody();
  body.clear();

  // Title and meta
  body.appendParagraph(`Daily Pendant Summary — ${dates.dateLabel}`).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`Timezone: ${TZ}`).setItalic(true);
  body.appendParagraph('');

  if (!lifelogs.length) {
    body.appendParagraph('No lifelogs found for this date.');
    doc.saveAndClose();
    Logger.log('Created/Updated: ' + title);
    return;
  }

  // Sort and render
  lifelogs.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  for (let i = 0; i < lifelogs.length; i++) {
    renderLifelogSection(body, lifelogs[i], TZ, i);
  }

  doc.saveAndClose();
  Logger.log('Created/Updated: ' + title);
}

/** Resumeable backfill that skips already created days unless OVERWRITE=true */
function backfillPendantHistoryResume() {
  const props = PropertiesService.getScriptProperties();
  mustProp(props, 'LIMITLESS_API_KEY');
  const FOLDER_ID = mustProp(props, 'FOLDER_ID');
  const TZ = props.getProperty('TIMEZONE') || 'America/New_York';
  const startStr = mustProp(props, 'BACKFILL_START');
  const endStr = mustProp(props, 'BACKFILL_END');
  const OVERWRITE = (props.getProperty('OVERWRITE') || 'false').toLowerCase() === 'true';

  const folder = getFolderStrict(FOLDER_ID);
  const start = new Date(startStr + 'T12:00:00');
  const end = new Date(endStr + 'T12:00:00');
  if (isNaN(start) || isNaN(end) || start > end) {
    throw new Error('Invalid BACKFILL_START or BACKFILL_END range.');
  }

  const existing = listExistingSummaries_(folder); // Set of YYYY-MM-DD
  const resumeStr = props.getProperty('BACKFILL_STATE');
  let current = resumeStr ? new Date(resumeStr + 'T12:00:00') : new Date(start);
  if (current < start) current = new Date(start);

  while (current <= end) {
    const dateStr = toYMD_(current, TZ);
    const title = `${dateStr} Pendant Summary`;

    if (!OVERWRITE && existing.has(dateStr)) {
      Logger.log('Skip existing: ' + title);
      props.setProperty('BACKFILL_STATE', dateStr);
      current.setDate(current.getDate() + 1);
      Utilities.sleep(500);
      continue;
    }

    try {
      Logger.log('Process: ' + title);
      props.setProperty('FORCE_DATE', dateStr);
      syncPendantToDrive();
      Logger.log('Done: ' + title);
    } catch (e) {
      Logger.log('Failed: ' + title + ' -> ' + e);
    } finally {
      props.deleteProperty('FORCE_DATE');
      props.setProperty('BACKFILL_STATE', dateStr);
    }

    Utilities.sleep(1500);
    current.setDate(current.getDate() + 1);
  }

  Logger.log('Backfill complete.');
}

/** Clears the resume marker for backfill */
function backfillClearState() {
  PropertiesService.getScriptProperties().deleteProperty('BACKFILL_STATE');
  Logger.log('Cleared BACKFILL_STATE.');
}

/** One-off helper to run for a specific date. Set date within the function then run it. */
function runFor_YYYY_MM_DD() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('FORCE_DATE', '2025-08-08'); // change to your date
  try { syncPendantToDrive(); }
  finally { props.deleteProperty('FORCE_DATE'); }
}

/** ================= Helpers ================= */

function mustProp(props, key) {
  const v = props.getProperty(key);
  if (!v) throw new Error('Missing Script Property ' + key);
  return v;
}

function computeDates(props, TZ, runToday) {
  const forced = props.getProperty('FORCE_DATE');
  const now = new Date();
  let base = forced ? new Date(forced + 'T12:00:00') : new Date(now);
  if (!forced && !runToday) base.setDate(now.getDate() - 1);
  const yyyy = Utilities.formatDate(base, TZ, 'yyyy');
  const mm = Utilities.formatDate(base, TZ, 'MM');
  const dd = Utilities.formatDate(base, TZ, 'dd');
  const dateParam = `${yyyy}-${mm}-${dd}`;
  const dateLabel = `${yyyy}-${mm}-${dd}`;
  return { dateParam, dateLabel };
}

function buildHourlyWindows(dateParam, TZ) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const start = toISO(dateParam, h, 0, 0, TZ);
    const end = toISO(dateParam, h + 1, 0, 0, TZ);
    out.push({ startISO: start, endISO: end, label: pad(h) + ':00→' + pad((h + 1) % 24) + ':00' });
  }
  return out;
}

function toISO(dateStr, hour, min, sec, TZ) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const d = new Date(Y, M - 1, D, hour, min, sec);
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fetchWindowWithPagination(API_KEY, TZ, startISO, endISO) {
  const results = [];
  let cursor = null;
  let page = 0;
  const pageCap = 20;

  do {
    const url = buildUrl({ TZ, startISO, endISO, cursor });
    const json = httpGetJson(url, API_KEY);
    const items = extractLifelogs(json);
    results.push(...items);
    cursor = extractNextCursor(json);
    page++;
    if (page >= pageCap) {
      results.push({ __note: 'Truncated window due to page cap at ' + pageCap });
      break;
    }
  } while (cursor);

  return results;
}

function buildUrl({ TZ, startISO, endISO, cursor }) {
  let url = API_BASE
    + '?timezone=' + encodeURIComponent(TZ)
    + '&start=' + encodeURIComponent(startISO)
    + '&end=' + encodeURIComponent(endISO)
    + '&includeMarkdown=true&includeHeadings=true&includeContents=false&limit=10';
  if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
  return url;
}

function httpGetJson(url, API_KEY) {
  const maxRetries = 3;
  let attempt = 0;
  while (true) {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'X-API-Key': API_KEY },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 200) return safeJson(res.getContentText());

    if (code === 429 || (code >= 500 && code < 600)) {
      attempt++;
      if (attempt > maxRetries) throw new Error('API ' + code + ' after ' + maxRetries + ' retries: ' + res.getContentText());
      const retryAfter = parseRetryAfter(res);
      Utilities.sleep((retryAfter || 3) * 1000);
      continue;
    }

    throw new Error('API error ' + code + ': ' + res.getContentText() + ' URL=' + url);
  }
}

function parseRetryAfter(res) {
  try {
    const headers = res.getAllHeaders();
    const ra = headers['Retry-After'] || headers['retry-after'];
    if (!ra) return 0;
    const n = Number(ra);
    return isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

function safeJson(txt) {
  try { return JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON from API: ' + txt); }
}

function extractLifelogs(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.lifelogs && Array.isArray(json.lifelogs)) return json.lifelogs;
  if (json.items && Array.isArray(json.items)) return json.items;
  if (json.results && Array.isArray(json.results)) return json.results;
  if (json.data) {
    if (Array.isArray(json.data)) return json.data;
    if (json.data.lifelogs && Array.isArray(json.data.lifelogs)) return json.data.lifelogs;
    if (json.data.items && Array.isArray(json.data.items)) return json.data.items;
    if (json.data.results && Array.isArray(json.data.results)) return json.data.results;
  }
  return [];
}

function extractNextCursor(json) {
  if (!json) return null;
  if (json.nextCursor) return json.nextCursor;
  if (json.meta && json.meta.nextCursor) return json.meta.nextCursor;
  if (json.meta && json.meta.lifelogs && json.meta.lifelogs.nextCursor) return json.meta.lifelogs.nextCursor;
  if (json.data && json.data.nextCursor) return json.data.nextCursor;
  return null;
}

function getFolderStrict(idOrName) {
  try {
    const f = DriveApp.getFolderById(idOrName);
    f.getName(); // verify access
    return f;
  } catch (e) {
    // fallback by name when id is not a valid ID and looks like a plain name
    if (idOrName.indexOf('/') === -1 && idOrName.indexOf(' ') !== -1) {
      const it = DriveApp.getFoldersByName(idOrName);
      if (it.hasNext()) return it.next();
    }
    throw new Error('Drive folder not accessible. Check FOLDER_ID. Value=' + idOrName + ' | Err=' + e);
  }
}

function findByName(folder, name) {
  const it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function renderLifelogSection(body, e, TZ, idx) {
  const start = e.start ? fmtLocal(e.start, TZ) : 'Unknown start';
  const end = e.end ? fmtLocal(e.end, TZ) : 'Unknown end';
  const duration = e.start && e.end ? computeDuration(e.start, e.end) : '';
  const header = e.title || e.heading || e.calendarEventTitle || ('Entry ' + (idx + 1));
  const md = (e.markdown || '').trim();
  const tag = inferTag(md, header);

  const h2 = (tag ? tag + ' ' : '') + header + ' — ' + start + ' → ' + end + (duration ? ' (' + duration + ')' : '');
  body.appendParagraph(h2).setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const autoSummary = deriveAutoSummary(md);
  if (autoSummary) {
    body.appendParagraph('Summary').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(autoSummary);
  }

  const dec = extractSection(md, /^Decisions?\s*[:\-]/im);
  const act = extractSection(md, /^(?:Action Items?|Next Steps?)\s*[:\-]/im);
  const risk = extractSection(md, /^(?:Risks?|Open Questions?)\s*[:\-]/im);

  body.appendParagraph('Decisions').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph(dec || 'None noted');

  body.appendParagraph('Action Items').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph(act || 'None noted');

  body.appendParagraph('Risks/Questions').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph(risk || 'None noted');

  const id = e.id || e._id || 'unknown-id';
  body.appendParagraph('Source: lifelog ID ' + id).setItalic(true);
  body.appendParagraph('');
}

function fmtLocal(iso, TZ) {
  const d = new Date(iso);
  const date = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  const time = Utilities.formatDate(d, TZ, 'HH:mm');
  return date + ' ' + time;
}

function computeDuration(startISO, endISO) {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  if (!isFinite(s) || !isFinite(e) || e <= s) return '';
  const mins = Math.round((e - s) / 60000);
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? (h + ' h ' + m + ' min') : (h + ' h');
}

function inferTag(text, header) {
  const hay = (header || '') + '\n' + (text || '');
  const low = hay.toLowerCase();
  const salesHints = ['pipeline', 'deal', 'client', 'prospect', 'purchase order', 'quote', 'renewal', 'pricing', 'discount'];
  const workHints = ['meeting', 'project', 'roadmap', 'qbr', 'okr', 'budget', 'launch', 'sprint', 'design review'];
  if (salesHints.some(x => low.indexOf(x) !== -1)) return '[Sales]';
  if (workHints.some(x => low.indexOf(x) !== -1)) return '[Work]';
  const personalHints = ['note to self', 'journal', 'reflect', 'habit', 'meditation', 'family'];
  if (personalHints.some(x => low.indexOf(x) !== -1)) return '[Personal]';
  return '';
}

function deriveAutoSummary(md) {
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  const bullets = lines.filter(l => /^\s*[-*•]\s+/.test(l)).slice(0, 6);
  if (bullets.length) return bullets.join('\n');
  return lines.filter(l => l.trim()).slice(0, 6).join('\n');
}

function extractSection(md, headerRegex) {
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  let capture = false, buf = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (headerRegex.test(L)) { capture = true; continue; }
    if (capture) {
      if (/^[A-Z][A-Za-z ]{0,40}:?$/.test(L.trim()) || /^#{1,6}\s/.test(L)) break;
      buf.push(L);
    }
  }
  return buf.join('\n').trim();
}

/** Helpers for backfill */
function listExistingSummaries_(folder) {
  const out = new Set();
  const it = folder.getFiles();
  const re = /^(\d{4}-\d{2}-\d{2}) Pendant Summary$/;
  while (it.hasNext()) {
    const f = it.next();
    const m = f.getName().match(re);
    if (m) out.add(m[1]);
  }
  return out;
}

function toYMD_(d, TZ) {
  const yyyy = Utilities.formatDate(d, TZ, 'yyyy');
  const mm = Utilities.formatDate(d, TZ, 'MM');
  const dd = Utilities.formatDate(d, TZ, 'dd');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Debug functions (optional) to test permissions.
 */
function testDriveAuth() {
  const me = Session.getActiveUser().getEmail();
  const rootName = DriveApp.getRootFolder().getName();
  Logger.log('Authorized as: ' + me + ' | Root: ' + rootName);
}

function debugFolder() {
  const props = PropertiesService.getScriptProperties();
  const FOLDER_ID = props.getProperty('FOLDER_ID');
  Logger.log('FOLDER_ID raw: [' + FOLDER_ID + '] len=' + (FOLDER_ID ? FOLDER_ID.length : 0));
  const f = DriveApp.getFolderById(FOLDER_ID);
  Logger.log('Folder name: ' + f.getName());
}
