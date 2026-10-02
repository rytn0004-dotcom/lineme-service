require('dotenv').config();

const express = require('express');
const { main: runReminderScan, todayReport } = require('./reminder_scheduler');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const RUN_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.REMINDER_SCAN_INTERVAL_MS || 60_000)
);

let lastRun = {
  status: 'not_run',
  at: null,
  result: null,
  error: null
};

let lastReport = null;
let runningPromise = null;

async function runOnce(source = 'manual') {
  if (runningPromise) return runningPromise;

  runningPromise = (async () => {
    const startedAt = new Date().toISOString();
    try {
      const result = await runReminderScan();
      lastRun = {
        status: 'ok',
        at: new Date().toISOString(),
        source,
        startedAt,
        result: result || null,
        error: null
      };
      return lastRun;
    } catch (error) {
      lastRun = {
        status: 'error',
        at: new Date().toISOString(),
        source,
        startedAt,
        result: null,
        error: String(error?.message || error)
      };
      console.error('Reminder scan failed:', error);
      throw error;
    } finally {
      runningPromise = null;
    }
  })();

  return runningPromise;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'lineme-service',
    version: '2.2.0',
    timezone: TZ,
    endpoints: ['/health', '/run', '/report']
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'lineme-service',
    version: '2.2.0',
    timezone: TZ,
    scanIntervalMs: RUN_INTERVAL_MS,
    running: Boolean(runningPromise),
    lastRun
  });
});

app.get('/run', async (req, res) => {
  try {
    const result = await runOnce('manual');
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'lineme-service',
      error: String(error?.message || error),
      lastRun
    });
  }
});

app.post('/run', async (req, res) => {
  try {
    const result = await runOnce('manual-post');
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'lineme-service',
      error: String(error?.message || error),
      lastRun
    });
  }
});

app.get('/report', async (req, res) => {
  try {
    lastReport = await todayReport();
    res.json(lastReport);
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'lineme-service',
      error: String(error?.message || error)
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `lineme-service v2.2.0 listening on port ${PORT}; timezone=${TZ}; scanIntervalMs=${RUN_INTERVAL_MS}`
  );
});

// Run once at startup, then keep scanning so Render does not need a separate cron service.
runOnce('startup').catch(() => {});

const timer = setInterval(() => {
  runOnce('interval').catch(() => {});
}, RUN_INTERVAL_MS);

timer.unref?.();
