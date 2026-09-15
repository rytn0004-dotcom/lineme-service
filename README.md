# LINE Course Reminder Web Service v2.0.0（Excel 詞彙鎖定版）

這一版以「可以正常運作的 V1.5」為基礎，只做必要修正：

1. **Excel 與程式使用同一套固定詞彙，不再猜名稱或使用別名。**
2. 系統總開關固定為 `系統設定 → 自動發送總開關`，只有值 `是` 才會發送。
3. `課程提醒 → 確認發送` 必須是 `是` 才進入發送佇列。
4. 成功發送後立即寫入 `發送紀錄`，唯一鍵固定為 `提醒ID|LINE User ID`。
5. `/today` 可檢查今天的待發提醒與啟用狀態。
6. `/run` 可手動立即執行一次掃描（只會發送已到時間、確認發送=是、且尚未成功記錄的提醒）。
7. `/schema` 可查看程式目前鎖定的 Excel 詞彙規格。
8. 若 Excel 工作表名稱或必要欄位不符合規格，程式會直接報錯，不再自行猜測。

## 鎖定的工作表與欄位

### 系統設定
`設定項目 | 目前值 | 用途 | 說明`

必要設定項目：`自動發送總開關`

### 課程提醒
`提醒ID | 課程日期 | 上課時間 | 發送日期 | 發送時間 | 身分 | 收件人 | 學生/學生成員 | 課程 | 老師 | 校區 | 訊息內容 | 確認發送`

### 聯絡人
`姓名 | 身分 | 學生姓名/關聯（可多位） | LINE User ID | 綁定狀態 | 最後綁定時間 | 通知啟用 | 備註`

### 發送紀錄
`發送時間 | Course ID | 課程日期 | 收件人 | 身分 | LINE User ID | 訊息內容 | 狀態 | LINE Request ID | 錯誤 | 唯一鍵 Course ID + User ID`

### 訊息模板
`模板名稱 | 適用對象 | 模板內容 | 備註`

固定模板名稱：
- `家長一般`
- `家長團班`
- `老師通知`

## 環境變數

- `LINE_CHANNEL_ACCESS_TOKEN`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `TIMEZONE=Asia/Taipei`
- `GOOGLE_API_MAX_RETRIES=4`
- `REMINDER_CHECK_INTERVAL_MS=60000`

## 部署

Render：
- Build Command: `npm install`
- Start Command: `npm start`

## 上線後驗證順序

1. `/health` → `version` 應為 `2.0.0`
2. `/schema` → 確認 `自動發送總開關`
3. `/today` → 確認 `enabled:true`
4. 在 Google Sheet 新增一筆未來 1~2 分鐘後的測試提醒，`確認發送=是`
5. 到 `/run`（POST）或等待 60 秒排程
6. LINE 收到後檢查 `發送紀錄`

## 非常重要

以後更新 Excel 或程式時，**不要自行修改工作表名稱、欄位名稱、開關名稱**。需要增加欄位時，先更新 `schema.js`，再同步更新 Excel，兩者一起升版。
