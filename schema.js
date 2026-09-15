// LINE 課程提醒｜Excel 詞彙鎖定規格
// Excel 與程式雙方只使用這份規格，不做欄位別名猜測。

module.exports = {
  version: '2.0.0',
  sheets: {
    settings: {
      name: '系統設定',
      required: ['設定項目', '目前值', '用途', '說明'],
      switch: '自動發送總開關',
      onValue: '是',
    },
    reminders: {
      name: '課程提醒',
      required: [
        '提醒ID', '課程日期', '上課時間', '發送日期', '發送時間',
        '身分', '收件人', '學生/學生成員', '課程', '老師', '校區',
        '訊息內容', '確認發送'
      ],
    },
    contacts: {
      name: '聯絡人',
      required: ['姓名', '身分', '學生姓名/關聯（可多位）', 'LINE User ID', '綁定狀態', '通知啟用'],
    },
    logs: {
      name: '發送紀錄',
      required: ['發送時間', 'Course ID', '課程日期', '收件人', '身分', 'LINE User ID', '訊息內容', '狀態', 'LINE Request ID', '錯誤', '唯一鍵 Course ID + User ID'],
      key: '唯一鍵 Course ID + User ID',
    },
    templates: {
      name: '訊息模板',
      required: ['模板名稱', '適用對象', '模板內容', '備註'],
      names: {
        parentGeneral: '家長一般',
        parentGroup: '家長團班',
        teacher: '老師通知',
      },
    },
  },
  values: {
    yes: '是',
    no: '否',
    parent: '家長',
    teacher: '老師',
    bound: '已綁定',
    sent: '已發送',
  },
  templateVariables: ['學生', '日期', '星期', '時間', '課程', '校區', '學生成員', '老師'],
};
