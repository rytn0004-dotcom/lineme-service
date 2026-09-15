# # LINE Course Reminder Web Service v1.6

獨立的課程提醒服務。每 60 秒檢查 Google Sheets 的「課程提醒」，到指定發送日期／時間且「確認發送=是」時，以 LINE Push Message 發送。

## 本版重點
- 修正 Google Sheets 日期／時間顯示：發送紀錄以 RAW 寫入，避免出現 46279.6965 這種 Excel/Sheets serial number。
- `GOOGLE_API_MAX_RETRIES` 只負責 Google API 429/5xx 重試，不會造成重複 LINE 發送。
- 重複防護：`提醒ID|LINE User ID`。
- 模板層級：`課程提醒!訊息內容` 有內容時優先，做為該筆個別覆蓋；空白時才使用「訊息模板」中的預設模板。
- 家長：依學生逐筆發送。
- 老師：同一老師＋同一日期＋同一上課時間＋同一校區的待發提醒會合併成一則訊息；團班會顯示為「課程(學生A、學生B)」。

## 可用模板變數
`{{學生}}` `{{日期}}` `{{星期}}` `{{時間}}` `{{課程}}` `{{校區}}` `{{學生成員}}` `{{老師}}`

## Required environment variables
- `LINE_CHANNEL_ACCESS_TOKEN`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `TIMEZONE` (建議 `Asia/Taipei`)
- `GOOGLE_API_MAX_RETRIES` (建議 `4`)
- `REMINDER_CHECK_INTERVAL_MS` (建議 `60000`)

## `/today`
回傳今日的「課程提醒」資料，並以標準 `yyyy-mm-dd`、`HH:mm` 格式呈現日期與時間，方便檢查今天有哪些提醒。
