# LINE Reminder Service v2.2.0

用途：**只負責讀取 Google Sheet 的「課程提醒」並發送 LINE。**

## 與 line-course-schedule 的明確分工

### 上游：line-course-schedule
負責：
- 固定課表 + 調課課程 → 實際課程。
- 產生／更新「課程提醒」佇列。
- 整理學生、老師、校區、時間與提醒訊息。
- 合併同一提醒條件下的學生，產生 MERGED-...。

### 本服務：lineme-service
負責：
- 讀取「課程提醒」。
- 判斷「確認發送」是否為「是」。
- 判斷發送日期／時間是否已到。
- 解析一般提醒與 MERGED-... 合併提醒。
- 配對「聯絡人」中的 LINE User ID。
- 呼叫 LINE Messaging API 發送提醒。
- 寫入「發送紀錄」，避免同一提醒重複發送。

**本服務不負責固定課表、調課、實際課程、課程時間計算或建立課程提醒。**

## 核心資料流

line-course-schedule
        ↓
Google Sheet「課程提醒」
        ↓
lineme-service
        ↓
LINE Push
        ↓
Google Sheet「發送紀錄」

## API

- GET /health：服務狀態與最近一次掃描結果。
- GET /run：立即執行一次提醒掃描。
- POST /run：立即執行一次提醒掃描。
- GET /report：查看今天的提醒與配對結果。

## 發送條件

「課程提醒」中的：
- 確認發送 = 是
- 發送日期／發送時間 <= 現在

兩者同時符合才會進入 LINE 發送流程。

## MERGED 合併提醒

支援：
- 凱荻、佳叡
- 生物團班(葉依柔、陳翊森)、繹桓、慕萱

老師提醒直接發送「訊息內容」欄位中的完整合併訊息。

家長提醒會把合併欄位拆成實際學生姓名，再配對已綁定且啟用通知的家長。

## Render

Build Command：
npm install

Start Command：
node server.js

Health Check Path：
/health

必要環境變數：
- LINE_CHANNEL_ACCESS_TOKEN
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_JSON
- TIMEZONE=Asia/Taipei

可選：
- GOOGLE_API_MAX_RETRIES=4
- REMINDER_SCAN_INTERVAL_MS=60000
