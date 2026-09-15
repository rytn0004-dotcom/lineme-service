require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { main, todayReport, validateWorkbookContract } = require('./reminder_scheduler');
const schema = require('./schema');

const REQUIRED = ['LINE_CHANNEL_ACCESS_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
for (const key of REQUIRED) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const PORT = Number(process.env.PORT || 10000);
const INTERVAL_MS = Math.max(30_000, Number(process.env.REMINDER_CHECK_INTERVAL_MS || 60_000));

let serviceAccount;
try { serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 不是有效 JSON；請貼完整 Service Account JSON。'); }

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const app = express();
app.use(express.json());

let state = {
  lastRunAt: null,
  lastRunOk: null,
  lastRunError: null,
  running: false,
  lastReport: null,
};

function safeError(e) { return String(e?.message || e || 'Unknown error'); }

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'line-course-reminder',
    version: schema.version,
    timezone: TZ,
    intervalMs: INTERVAL_MS,
    lastRunAt: state.lastRunAt,
    lastRunOk: state.lastRunOk,
    lastRunError: state.lastRunError,
    running: state.running,
  });
});

app.get('/schema', (req, res) => {
  res.json({ ok: true, version: schema.version, contract: schema });
});

app.get('/today', async (req, res) => {
  try {
    const report = await todayReport({ sheets, spreadsheetId: SHEET_ID, timezone: TZ });
    state.lastReport = report;
    res.json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: safeError(e), version: schema.version });
  }
});

// 手動執行一次掃描。只會送「確認發送=是」且已到時間、且尚未成功記錄的提醒。
app.post('/run', async (req, res) => {
  if (state.running) return res.status(409).json({ ok: false, error: '目前已有排程執行中。' });
  state.running = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const report = await main({ sheets, spreadsheetId: SHEET_ID, token: TOKEN, timezone: TZ });
    state.lastRunOk = true;
    state.lastRunError = null;
    state.lastReport = report;
    res.json(report);
  } catch (e) {
    state.lastRunOk = false;
    state.lastRunError = safeError(e);
    res.status(500).json({ ok: false, error: state.lastRunError, version: schema.version });
  } finally {
    state.running = false;
  }
});

app.get('/', (req, res) => {
  res.type('text').send('LINE Course Reminder v2.0.0 OK - use /health, /today, POST /run');
});

app.listen(PORT, () => console.log(`line-course-reminder ${schema.version} listening on ${PORT}`));

async function tick() {
  if (state.running) return;
  state.running = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const report = await main({ sheets, spreadsheetId: SHEET_ID, token: TOKEN, timezone: TZ });
    state.lastRunOk = true;
    state.lastRunError = null;
    state.lastReport = report;
    console.log(JSON.stringify(report));
  } catch (e) {
    state.lastRunOk = false;
    state.lastRunError = safeError(e);
    console.error('Reminder Scheduler failed:', state.lastRunError);
  } finally {
    state.running = false;
  }
}

setTimeout(tick, 1500);
setInterval(tick, INTERVAL_MS);
