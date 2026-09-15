const schema = require('./schema');

function norm(v) { return String(v ?? '').trim(); }
function qsheet(name) { return `'${String(name).replace(/'/g, "''")}'`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hmap(h) { return Object.fromEntries((h || []).map((x, i) => [String(x).trim(), i])); }
function splitMembers(v) { return String(v || '').split(/[、,，\/]/).map(s => s.trim()).filter(Boolean); }
function findHeaderRow(rows, required) {
  return (rows || []).findIndex(row => Array.isArray(row) && required.every(k => row.map(x => String(x).trim()).includes(k)));
}
function settings(rows) {
  const hRow = findHeaderRow(rows, schema.sheets.settings.required);
  if (hRow < 0) throw new Error(`工作表「${schema.sheets.settings.name}」缺少標準標題列。`);
  const h = hmap(rows[hRow]);
  const out = {};
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r[h['設定項目']]) out[String(r[h['設定項目']]).trim()] = String(r[h['目前值']] ?? '').trim();
  }
  return out;
}
function nowParts(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => parts.find(x => x.type === t)?.value;
  return { y: +g('year'), m: +g('month'), d: +g('day'), h: +g('hour'), min: +g('minute'), sec: +g('second') };
}
function nowText(timezone) {
  const p = nowParts(timezone);
  return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')} ${String(p.h).padStart(2,'0')}:${String(p.min).padStart(2,'0')}:${String(p.sec).padStart(2,'0')}`;
}
function dateKey(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s.slice(0, 10);
}
function timeKey(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const mins = Math.round((v % 1) * 24 * 60);
    return `${String(Math.floor(mins / 60) % 24).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
  }
  const s = String(v ?? '').trim().replace('下午 ', '').replace('上午 ', '');
  let m = s.match(/^(\d{1,2}):([0-5]\d)(?::\d{2})?$/);
  if (m) return `${String(+m[1]).padStart(2,'0')}:${m[2]}`;
  m = String(v ?? '').trim().match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i);
  if (m) {
    let hh = +m[1] % 12;
    if (m[3].toUpperCase() === 'PM') hh += 12;
    return `${String(hh).padStart(2,'0')}:${m[2]}`;
  }
  return '';
}
function weekdayZh(date) {
  const s = dateKey(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y,m,d] = s.split('-').map(Number);
  return ['日','一','二','三','四','五','六'][new Date(Date.UTC(y,m-1,d)).getUTCDay()];
}
function formatMessageDate(date) {
  const s = dateKey(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [,m,d] = s.split('-');
  return `${Number(m)}/${Number(d)}`;
}
function substitute(t, vars) { return String(t || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => String(vars[k.trim()] ?? '')); }
function retryable(e) {
  const s = Number(e?.code || e?.response?.status || 0);
  return [429,500,502,503,504].includes(s) || /quota exceeded|rate limit|temporarily unavailable/i.test(String(e?.message || ''));
}
async function retry(label, fn, retries) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!retryable(e) || i >= retries) throw e;
      const wait = Math.min(10000, 600 * (2 ** i)) + Math.floor(Math.random() * 300);
      console.warn(`${label}: retry ${i+1}/${retries} after ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}
function ensureExactHeaders(rows, sheetName, required) {
  const row = findHeaderRow(rows, required);
  if (row < 0) throw new Error(`工作表「${sheetName}」欄位不符合鎖定規格。需要：${required.join('、')}`);
  return { row, map: hmap(rows[row]) };
}
function readTemplates(rows) {
  const { row, map } = ensureExactHeaders(rows, schema.sheets.templates.name, schema.sheets.templates.required.slice(0,3));
  const out = {};
  for (let i = row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[map['模板名稱']] || '').trim();
    if (!name) continue;
    out[name] = String(r[map['模板內容']] || '').trim();
  }
  return out;
}
function contacts(rows) {
  const { row, map } = ensureExactHeaders(rows, schema.sheets.contacts.name, schema.sheets.contacts.required);
  const out = [];
  for (let i = row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r[map['LINE User ID']]) continue;
    out.push({
      name: String(r[map['姓名']] || '').trim(), role: String(r[map['身分']] || '').trim(),
      students: splitMembers(r[map['學生姓名/關聯（可多位）']] || ''),
      userId: String(r[map['LINE User ID']] || '').trim(),
      bound: norm(r[map['綁定狀態']]) === schema.values.bound,
      enabled: norm(r[map['通知啟用']]) !== schema.values.no,
    });
  }
  return out;
}
function sentKeys(rows) {
  const { row, map } = ensureExactHeaders(rows, schema.sheets.logs.name, schema.sheets.logs.required);
  const out = new Set();
  for (let i = row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const key = String(r[map[schema.sheets.logs.key]] || '').trim();
    if (key && (map['狀態'] === undefined || norm(r[map['狀態']]) === schema.values.sent)) out.add(key);
  }
  return out;
}
function messageFor(role, row, h, templates, teacherMembers) {
  const custom = String(row[h['訊息內容']] || '').trim();
  if (custom) return custom;
  const course = String(row[h['課程']] || '').trim();
  const template = role === schema.values.parent
    ? (course.includes('團班') ? (templates[schema.sheets.templates.names.parentGroup] || templates[schema.sheets.templates.names.parentGeneral] || '') : (templates[schema.sheets.templates.names.parentGeneral] || ''))
    : (templates[schema.sheets.templates.names.teacher] || '');
  return substitute(template, {
    '學生': String(row[h['學生/學生成員']] || '').trim(),
    '日期': formatMessageDate(row[h['課程日期']]),
    '星期': weekdayZh(row[h['課程日期']]),
    '時間': timeKey(row[h['上課時間']]),
    '課程': course,
    '校區': String(row[h['校區']] || '').trim(),
    '學生成員': teacherMembers ?? String(row[h['學生/學生成員']] || '').trim(),
    '老師': String(row[h['老師']] || '').trim(),
  });
}
function dueRows(rows, h, timezone) {
  const now = nowParts(timezone);
  const today = `${now.y}-${String(now.m).padStart(2,'0')}-${String(now.d).padStart(2,'0')}`;
  const nowMin = now.h * 60 + now.min;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r[h['提醒ID']]) continue;
    if (norm(r[h['確認發送']] ?? schema.values.no) !== schema.values.yes) continue;
    const d = dateKey(r[h['發送日期']]);
    const t = timeKey(r[h['發送時間']]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !t) continue;
    const [hh,mm] = t.split(':').map(Number);
    if (d < today || (d === today && nowMin >= hh * 60 + mm)) out.push({ index: i, row: r });
  }
  return out;
}
function resolveParent(list, student) {
  const s = norm(student);
  return list.filter(c => c.role === schema.values.parent && c.bound && c.enabled && /^U/.test(c.userId) && c.students.some(x => norm(x) === s));
}
function resolveTeacher(list, name) {
  const n = norm(name);
  return list.find(c => c.role === schema.values.teacher && c.bound && c.enabled && /^U/.test(c.userId) && norm(c.name) === n);
}
async function push(token, uid, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: uid, messages: [{ type: 'text', text }] }),
  });
  return { ok: r.ok, status: r.status, id: r.headers.get('x-line-request-id') || '', body: await r.text() };
}
function teacherGroups(items, h) {
  const groups = new Map();
  for (const item of items) {
    const r = item.row;
    const key = [String(r[h['收件人']] || '').trim(), dateKey(r[h['課程日期']]), timeKey(r[h['上課時間']]), String(r[h['校區']] || '').trim()].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}
function teacherMembers(items, h) {
  const byCourse = new Map();
  for (const item of items) {
    const r = item.row;
    const student = String(r[h['學生/學生成員']] || '').trim();
    const course = String(r[h['課程']] || '').trim() || '__NONE__';
    if (!byCourse.has(course)) byCourse.set(course, []);
    if (student) byCourse.get(course).push(student);
  }
  const parts = [];
  for (const [course, list] of byCourse.entries()) {
    const students = [...new Set(list)];
    if (course !== '__NONE__' && (students.length > 1 || course.includes('團班'))) parts.push(`${course}(${students.join('、')})`);
    else parts.push(students.join('、'));
  }
  return parts.filter(Boolean).join('、');
}
async function readAll({ sheets, spreadsheetId, retries = 4 }) {
  return retry('batchGet', async () => {
    const ranges = [
      `${qsheet(schema.sheets.settings.name)}!A:D`,
      `${qsheet(schema.sheets.reminders.name)}!A:M`,
      `${qsheet(schema.sheets.contacts.name)}!A:H`,
      `${qsheet(schema.sheets.logs.name)}!A:K`,
      `${qsheet(schema.sheets.templates.name)}!A:D`,
    ];
    const r = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges, majorDimension: 'ROWS' });
    return (r.data.valueRanges || []).map(v => v.values || []);
  }, retries);
}
async function appendLogs({ sheets, spreadsheetId, rows, retries = 4 }) {
  if (!rows.length) return;
  await retry('appendLogs', () => sheets.spreadsheets.values.append({
    spreadsheetId, range: `${qsheet(schema.sheets.logs.name)}!A:K`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows }
  }), retries);
}
function validateWorkbookContract(allRows) {
  const [sRows, rRows, cRows, lRows, tRows] = allRows;
  const errors = [];
  try { ensureExactHeaders(sRows, schema.sheets.settings.name, schema.sheets.settings.required); } catch (e) { errors.push(e.message); }
  try { ensureExactHeaders(rRows, schema.sheets.reminders.name, schema.sheets.reminders.required); } catch (e) { errors.push(e.message); }
  try { ensureExactHeaders(cRows, schema.sheets.contacts.name, schema.sheets.contacts.required); } catch (e) { errors.push(e.message); }
  try { ensureExactHeaders(lRows, schema.sheets.logs.name, schema.sheets.logs.required); } catch (e) { errors.push(e.message); }
  try { ensureExactHeaders(tRows, schema.sheets.templates.name, schema.sheets.templates.required.slice(0,3)); } catch (e) { errors.push(e.message); }
  return { ok: errors.length === 0, version: schema.version, errors };
}
async function todayReport({ sheets, spreadsheetId, timezone, retries = 4 }) {
  const all = await readAll({ sheets, spreadsheetId, retries });
  const [sRows, rRows, cRows, lRows, tRows] = all;
  const contract = validateWorkbookContract(all);
  if (!contract.ok) throw new Error(contract.errors.join(' | '));
  const cfg = settings(sRows);
  const enabled = cfg[schema.sheets.settings.switch] === schema.sheets.settings.onValue;
  const rhInfo = ensureExactHeaders(rRows, schema.sheets.reminders.name, schema.sheets.reminders.required);
  const due = dueRows(rRows.slice(rhInfo.row + 1), rhInfo.map, timezone).map(x => x.row);
  const sent = sentKeys(lRows);
  const contactsList = contacts(cRows);
  const rows = due.map(row => {
    const id = String(row[rhInfo.map['提醒ID']] || '');
    const role = String(row[rhInfo.map['身分']] || '').trim();
    const recipient = String(row[rhInfo.map['收件人']] || '').trim();
    const student = String(row[rhInfo.map['學生/學生成員']] || '').trim();
    let users = [];
    if (role === schema.values.parent) users = resolveParent(contactsList, student).map(x => x.userId);
    if (role === schema.values.teacher) { const t = resolveTeacher(contactsList, recipient); if (t) users = [t.userId]; }
    const keys = users.map(uid => `${id}|${uid}`);
    return {
      提醒ID: id,
      發送日期: dateKey(row[rhInfo.map['發送日期']]),
      發送時間: timeKey(row[rhInfo.map['發送時間']]),
      確認發送: norm(row[rhInfo.map['確認發送']]),
      身分: role,
      收件人: recipient,
      學生: student,
      LINEUserID: users,
      已發送: keys.length > 0 && keys.every(k => sent.has(k)),
      待發送: enabled && keys.some(k => !sent.has(k)),
    };
  });
  return { ok: true, service: 'line-course-reminder', version: schema.version, timezone, today: `${String(nowParts(timezone).y).padStart(4,'0')}-${String(nowParts(timezone).m).padStart(2,'0')}-${String(nowParts(timezone).d).padStart(2,'0')}`, enabled, count: rows.length, rows, contract }; 
}
async function main({ sheets, spreadsheetId, token, timezone, retries = 4 }) {
  const all = await readAll({ sheets, spreadsheetId, retries });
  const [sRows, rRows, cRows, lRows, tRows] = all;
  const contract = validateWorkbookContract(all);
  if (!contract.ok) throw new Error(contract.errors.join(' | '));
  const cfg = settings(sRows);
  if (cfg[schema.sheets.settings.switch] !== schema.sheets.settings.onValue) {
    return { ok: true, service: 'line-course-reminder', version: schema.version, enabled: false, sentCount: 0, skipped: '自動發送總開關不是「是」' };
  }
  const rhInfo = ensureExactHeaders(rRows, schema.sheets.reminders.name, schema.sheets.reminders.required);
  const h = rhInfo.map;
  const cList = contacts(cRows);
  const templates = readTemplates(tRows);
  const sent = sentKeys(lRows);
  const due = dueRows(rRows.slice(rhInfo.row + 1), h, timezone).map(x => ({ index: x.index + rhInfo.row + 1, row: x.row }));
  const logs = [];
  const now = nowText(timezone);
  const parentItems = [];
  const teacherItems = [];

  for (const item of due) {
    const row = item.row;
    const role = String(row[h['身分']] || '').trim();
    const recipient = String(row[h['收件人']] || '').trim();
    const student = String(row[h['學生/學生成員']] || '').trim();
    if (role === schema.values.parent) {
      for (const rec of resolveParent(cList, student)) parentItems.push({ item, rec, recipient });
    } else if (role === schema.values.teacher) {
      const rec = resolveTeacher(cList, recipient);
      if (rec) teacherItems.push({ item, rec, recipient });
    }
  }

  for (const x of parentItems) {
    const row = x.item.row;
    const id = String(row[h['提醒ID']]);
    const key = `${id}|${x.rec.userId}`;
    if (sent.has(key)) continue;
    const message = messageFor(schema.values.parent, row, h, templates);
    if (!message) continue;
    const result = await push(token, x.rec.userId, message);
    logs.push([now, id, dateKey(row[h['課程日期']]), x.rec.name || x.recipient, schema.values.parent, x.rec.userId, message, result.ok ? schema.values.sent : '失敗', result.id, result.ok ? '' : result.body, key]);
    if (result.ok) sent.add(key);
  }

  for (const group of teacherGroups(teacherItems, h)) {
    const hasCustom = group.some(x => String(x.item.row[h['訊息內容']] || '').trim());
    if (hasCustom) {
      for (const x of group) {
        const row = x.item.row;
        const id = String(row[h['提醒ID']]);
        const key = `${id}|${x.rec.userId}`;
        if (sent.has(key)) continue;
        const message = messageFor(schema.values.teacher, row, h, templates, String(row[h['學生/學生成員']] || '').trim());
        if (!message) continue;
        const result = await push(token, x.rec.userId, message);
        logs.push([now, id, dateKey(row[h['課程日期']]), x.rec.name || x.recipient, schema.values.teacher, x.rec.userId, message, result.ok ? schema.values.sent : '失敗', result.id, result.ok ? '' : result.body, key]);
        if (result.ok) sent.add(key);
      }
      continue;
    }
    const first = group[0];
    const pendingKeys = group.map(x => `${x.item.row[h['提醒ID']]}|${x.rec.userId}`).filter(k => !sent.has(k));
    if (!pendingKeys.length) continue;
    const message = messageFor(schema.values.teacher, first.item.row, h, templates, teacherMembers(group, h));
    if (!message) continue;
    const result = await push(token, first.rec.userId, message);
    for (const key of pendingKeys) {
      const id = key.split('|')[0];
      logs.push([now, id, dateKey(first.item.row[h['課程日期']]), first.rec.name || first.recipient, schema.values.teacher, first.rec.userId, message, result.ok ? schema.values.sent : '失敗', result.id, result.ok ? '' : result.body, key]);
      if (result.ok) sent.add(key);
    }
  }

  await appendLogs({ sheets, spreadsheetId, rows: logs, retries });
  return { ok: true, service: 'line-course-reminder', version: schema.version, enabled: true, dueCount: due.length, sentCount: logs.filter(r => r[7] === schema.values.sent).length, failedCount: logs.filter(r => r[7] === '失敗').length, logRows: logs.length, at: new Date().toISOString(), contract };
}

module.exports = { main, todayReport, validateWorkbookContract, schema };
