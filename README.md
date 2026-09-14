# LINE Course Reminder v1.1

Web Service 版本：每 60 秒檢查一次 Google Sheets 的「課程提醒」，到達指定日期/時間且「確認發送=是」時，透過 LINE Push Message 發送。

本服務只負責課程提醒，不讀取固定課表、調課課程、實際課程；不需要 LINE Webhook，因此不需要 LINE_CHANNEL_SECRET。

Required environment variables:
- LINE_CHANNEL_ACCESS_TOKEN
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_JSON
- TIMEZONE=Asia/Taipei
- GOOGLE_API_MAX_RETRIES=4

Optional:
- REMINDER_CHECK_INTERVAL_MS=60000

Render:
- Type: Web Service
- Build: npm install
- Start: npm start
- Health: /health
