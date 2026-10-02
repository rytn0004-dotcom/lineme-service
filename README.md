# LINE Reminder Service v2.2.0

用途：讀取 Google Sheet「課程提醒」→ 依「確認發送」與發送時間 → 發送 LINE Push → 寫入「發送紀錄」。

## 功能

- 支援一般課程提醒。
- 明確辨識 `MERGED-...` 合併課程提醒。
- 老師合併提醒只發送該列的 1 則訊息。
- 家長合併提醒支援：
  - `凱荻、佳叡`
  - `生物團班(葉依柔、陳翊森)、繹桓、慕萱`
- 發送紀錄唯一鍵仍為「提醒ID + LINE User ID」，避免重複發送。
- Render Web Service 每 1 分鐘自動掃描一次。
- 可用 `/run` 手動立即掃描。
- 可用 `/report` 查看今天的提醒與配對結果。

## API

- `GET /health`：服務狀態與最近一次掃描結果。
- `GET /run`：立即執行一次提醒掃描。
- `POST /run`：立即執行一次提醒掃描。
- `GET /report`：查看今天的提醒資料與 LINE 配對結果。

## Render

Build Command：
```
npm install
```

Start Command：
```
node server.js
```

Health Check Path：
```
/health
```

## 必要環境變數

- `LINE_CHANNEL_ACCESS_TOKEN`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `TIMEZONE=Asia/Taipei`

可選：

- `GOOGLE_API_MAX_RETRIES=4`
- `REMINDER_SCAN_INTERVAL_MS=60000`

## 發送條件

「課程提醒」中的：

`確認發送 = 是`

且：

`發送日期/時間 <= 現在`

才會進入發送流程。

若「自動發送總開關」不是「是」，服務只會掃描而不發送。
