# LINE Course Reminder Web Service v1.3

修正重複發送問題：現有「發送紀錄」表的欄位標題位於第 2 列，v1.2 只讀第 1 列，導致每分鐘都無法看到既有的唯一鍵，因此重複發送。

v1.3 會自動尋找真正的「發送紀錄」標題列，讀取「唯一鍵 Course ID + User ID」等欄位，成功發送後以「提醒ID|LINE User ID」防止後續重複。

GOOGLE_API_MAX_RETRIES 只控制 Google Sheets API 遇到 429/5xx 等錯誤時的重試次數，不是這次重複發送的原因。
