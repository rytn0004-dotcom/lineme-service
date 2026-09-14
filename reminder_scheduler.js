require('dotenv').config();
const { google } = require('googleapis');

for (const key of ['LINE_CHANNEL_ACCESS_TOKEN','GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON']) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const RETRIES = Number(process.env.GOOGLE_API_MAX_RETRIES || 4);
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({version:'v4', auth});

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function retryable(e){const s=Number(e?.code||e?.response?.status||0);return [429,500,502,503,504].includes(s)||/quota exceeded|rate limit|temporarily unavailable/i.test(String(e?.message||''));}
async function retry(label,fn){let last;for(let i=0;i<=RETRIES;i++){try{return await fn();}catch(e){last=e;if(!retryable(e)||i>=RETRIES)throw e;const w=Math.min(10000,600*(2**i))+Math.floor(Math.random()*300);console.warn(`${label}: retry ${i+1}/${RETRIES} after ${w}ms`);await sleep(w);}}throw last;}
function esc(n){return `'${String(n).replace(/'/g,"''")}'`;}
function norm(v){return String(v??'').trim().replace(/\s+/g,'');}
function split(v){return String(v||'').split('、').map(s=>s.trim()).filter(Boolean);}
function hmap(h){return Object.fromEntries((h||[]).map((x,i)=>[String(x),i]));}
function nowText(){
  const p=new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date());
  return p.replace('T',' ');
}
function nowParts(){
  const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>p.find(x=>x.type===t)?.value;
  return{y:+g('year'),m:+g('month'),d:+g('day'),wd:g('weekday'),h:String(g('hour')).padStart(2,'0'),min:String(g('minute')).padStart(2,'0')};
}
async function batchRead(){
  return retry('reminder batchGet',async()=>{
    const ranges=[`${esc('系統設定')}!A:D`,`${esc('課程提醒')}!A:N`,`${esc('聯絡人')}!A:I`,`${esc('發送紀錄')}!A:K`,`${esc('訊息模板')}!A:E`];
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});
    return(r.data.valueRanges||[]).map(v=>v.values||[]);
  });
}
async function appendRows(sheet,rows){
  if(!rows.length)return;
  await retry(`append ${sheet}`,()=>sheets.spreadsheets.values.append({
    spreadsheetId:SHEET_ID,
    range:`${esc(sheet)}!A:Z`,
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:{values:rows}
  }));
}
function settings(rows){const o={};for(const r of (rows||[]).slice(2))if(r[0])o[String(r[0])]=String(r[1]??'');return o;}
function findHeaderRow(rows, requiredAny){
  return (rows||[]).findIndex(r=>Array.isArray(r)&&requiredAny.every(k=>r.includes(k)));
}
function findRecipient(rows,h,role,name){
  const n=norm(name);
  return rows.slice(1).map(r=>({
    name:r[h['姓名']]||'',role:r[h['身分']]||'',
    students:split(r[h['學生姓名/關聯（可多位）']]!==undefined?r[h['學生姓名/關聯（可多位）']]:r[h['學生姓名/關聯']]||''),
    userId:r[h['LINE User ID']]||'',bound:norm(r[h['綁定狀態']])==='已綁定',
    enabled:norm(r[h['通知啟用']]??r[h['啟用']]??'是')!=='否'
  })).find(x=>x.role===role&&x.bound&&x.enabled&&String(x.userId).startsWith('U')&&norm(x.name)===n);
}
function findParent(rows,h,student){
  const s=norm(student),si=h['學生姓名/關聯（可多位）']??h['學生姓名/關聯'];
  return rows.slice(1).map(r=>({
    name:r[h['姓名']]||'',role:r[h['身分']]||'',students:split(r[si]||''),
    userId:r[h['LINE User ID']]||'',bound:norm(r[h['綁定狀態']])==='已綁定',
    enabled:norm(r[h['通知啟用']]??r[h['啟用']]??'是')!=='否'
  })).filter(x=>x.role==='家長'&&x.bound&&x.enabled&&String(x.userId).startsWith('U')&&x.students.some(n=>norm(n)===s));
}
async function push(uid,text){
  const r=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`},body:JSON.stringify({to:uid,messages:[{type:'text',text}]})});
  return{ok:r.ok,status:r.status,id:r.headers.get('x-line-request-id')||'',body:await r.text()};
}
function sentKeys(rows){
  if(!rows.length)return new Set();
  const headerRow=rows.findIndex(r=>Array.isArray(r)&&r.includes('狀態')&&(r.includes('唯一鍵 Course ID + LINE User ID')||r.includes('唯一鍵 Course ID + User ID')||r.includes('唯一鍵')));
  if(headerRow<0)return new Set();
  const h=hmap(rows[headerRow]||[]);
  const statusCol=h['狀態'];
  const keyCol=h['唯一鍵 Course ID + LINE User ID'] ?? h['唯一鍵 Course ID + User ID'] ?? h['唯一鍵'];
  const out=new Set();
  if(keyCol===undefined)return out;
  for(let i=headerRow+1;i<rows.length;i++){
    const r=rows[i]||[]; const key=String(r[keyCol]||'').trim(); if(!key)continue;
    if(statusCol===undefined||norm(r[statusCol])==='已發送')out.add(key);
  }
  return out;
}
function readTemplates(rows){
  const idx=findHeaderRow(rows,['模板名稱','適用對象','模板內容']);
  if(idx<0)return{};
  const h=hmap(rows[idx]); const out={};
  for(let i=idx+1;i<rows.length;i++){
    const r=rows[i]||[]; const name=String(r[h['模板名稱']]||'').trim(); if(!name)continue;
    if(norm(r[h['啟用']]??'是')==='否')continue;
    out[name]=String(r[h['模板內容']]||'').trim();
  }
  return out;
}
function formatDate(date){
  const s=String(date||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const [y,m,d]=s.split('-').map(Number);
  return `${m}/${d}`;
}
function weekdayZh(date){
  const s=String(date||'').slice(0,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return '';
  const [y,m,d]=s.split('-').map(Number); const w=new Date(Date.UTC(y,m-1,d)).getUTCDay();
  return ['日','一','二','三','四','五','六'][w];
}
function substitute(template, vars){
  return String(template||'').replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,k)=>String(vars[k.trim()]??''));
}
function templateMessage({role,row,h,templates,teacherMembers}){
  const templateName=String(row[h['模板名稱']]||'').trim();
  const student=String(row[h['學生/學生成員']]||'').trim();
  const course=String(row[h['課程']]||'').trim();
  let selected='';
  if(templateName&&templates[templateName]) selected=templates[templateName];
  else if(role==='家長') selected=course.includes('團班')?(templates['家長團班']||templates['家長一般']||''): (templates['家長一般']||'');
  else if(role==='老師') selected=templates['老師通知']||'';
  if(!selected)return '';
  return substitute(selected,{
    '學生':student,
    '日期':formatDate(row[h['課程日期']]),
    '星期':weekdayZh(row[h['課程日期']]),
    '時間':String(row[h['上課時間']]||''),
    '課程':course,
    '校區':String(row[h['校區']]||''),
    '學生成員':teacherMembers??student,
    '老師':String(row[h['老師']]||'')
  });
}
function groupTeacherRows(rows,h){
  const groups=new Map();
  for(const item of rows){
    const r=item.row, recipient=String(r[h['收件人']]||'').trim();
    const key=[recipient,String(r[h['課程日期']]||''),String(r[h['上課時間']]||''),String(r[h['校區']]||'')].join('|');
    if(!groups.has(key))groups.set(key,[]); groups.get(key).push(item);
  }
  return [...groups.values()];
}
function formatTeacherMembers(items,h){
  const byCourse=new Map();
  for(const item of items){
    const r=item.row; const student=String(r[h['學生/學生成員']]||'').trim(); const course=String(r[h['課程']]||'').trim();
    const key=course||'__NONE__'; if(!byCourse.has(key))byCourse.set(key,[]); if(student)byCourse.get(key).push(student);
  }
  const parts=[];
  for(const [course,students0] of byCourse.entries()){
    const students=[...new Set(students0)];
    if(course!=='__NONE__'&& (students.length>1 || course.includes('團班'))) parts.push(`${course}(${students.join('、')})`);
    else parts.push(students.join('、'));
  }
  return parts.filter(Boolean).join('、');
}

async function main(){
  const [sRows,rRows,cRows,lRows,tRows]=await batchRead();
  const cfg=settings(sRows);
  if(cfg['課程提醒啟用']!=='是'){console.log('Reminder Scheduler: OFF');return;}

  const rhRow=findHeaderRow(rRows,['提醒ID','課程日期','發送日期','發送時間','確認發送']);
  if(rhRow<0)throw new Error('課程提醒工作表欄位不正確。');
  const rh=hmap(rRows[rhRow]);
  if(rh['訊息內容']===undefined||rh['身分']===undefined||rh['收件人']===undefined)throw new Error('課程提醒缺少必要欄位。');

  const chRow=findHeaderRow(cRows,['姓名','身分','LINE User ID']);
  if(chRow<0)throw new Error('聯絡人工作表欄位不正確。');
  const contactRows=cRows.slice(chRow); const ch=hmap(contactRows[0]);
  const templates=readTemplates(tRows);

  const sent=sentKeys(lRows);
  const now=nowParts(); const nowMinutes=Number(now.h)*60+Number(now.min);
  const due=[];
  for(let i=rhRow+1;i<rRows.length;i++){
    const row=rRows[i]||[]; if(!row.length||!row[rh['提醒ID']])continue;
    const confirmed=norm(row[rh['確認發送']]??'是')==='是'; if(!confirmed)continue;
    const date=String(row[rh['發送日期']]||'').slice(0,10); const time=String(row[rh['發送時間']]||'').trim();
    if(!date||!/^(?:\d{1,2}):\d{2}$/.test(time))continue;
    const [hh,mm]=time.split(':').map(Number);
    const targetDate=new Date(`${date}T00:00:00+08:00`); const today=new Date();
    const partsToday=now; const todayDate=new Date(`${String(partsToday.y).padStart(4,'0')}-${String(partsToday.m).padStart(2,'0')}-${String(partsToday.d).padStart(2,'0')}T00:00:00+08:00`);
    if(targetDate>todayDate)continue;
    if(targetDate.getTime()===todayDate.getTime()&&nowMinutes<hh*60+mm)continue;
    due.push({index:i,row});
  }

  const parentItems=[], teacherItems=[];
  for(const item of due){
    const row=item.row, role=String(row[rh['身分']]||'').trim(), recipientName=String(row[rh['收件人']]||'').trim(), studentText=String(row[rh['學生/學生成員']]||'').trim();
    if(role==='家長'){
      const recs=findParent(contactRows,ch,studentText);
      for(const rec of recs)parentItems.push({item,rec,recipientName,role});
    } else if(role==='老師'){
      const rec=findRecipient(contactRows,ch,'老師',recipientName); if(rec)teacherItems.push({item,rec,recipientName,role});
    }
  }

  const logs=[];
  // 家長：一筆提醒對一位學生，訊息內容可個別覆蓋；空白才套用模板。
  for(const x of parentItems){
    const row=x.item.row; const id=String(row[rh['提醒ID']]); const key=`${id}|${x.rec.userId}`;
    if(sent.has(key))continue;
    const custom=String(row[rh['訊息內容']]||'').trim();
    const message=custom||templateMessage({role:'家長',row,h:rh,templates});
    if(!message)continue;
    const result=await push(x.rec.userId,message);
    logs.push([nowText(),id,String(row[rh['課程日期']]||''),x.rec.name||x.recipientName,'家長',x.rec.userId,message,result.ok?'已發送':'失敗',result.id,result.ok?'':result.body,key]);
    if(result.ok)sent.add(key);
  }

  // 老師：同一老師＋日期＋上課時間＋校區，若所有提醒都沒有個別自訂訊息就合併成一則。
  // 只要其中一筆有「訊息內容」自訂，就改為逐筆發送，讓個別覆蓋不會被群組模板吃掉。
  for(const group of groupTeacherRows(teacherItems,rh)){
    const hasCustom=group.some(x=>String(x.item.row[rh['訊息內容']]||'').trim());
    if(hasCustom){
      for(const x of group){
        const row=x.item.row; const id=String(row[rh['提醒ID']]); const key=`${id}|${x.rec.userId}`;
        if(sent.has(key))continue;
        const custom=String(row[rh['訊息內容']]||'').trim();
        const message=custom||templateMessage({role:'老師',row,h:rh,templates,teacherMembers:String(row[rh['學生/學生成員']]||'').trim()});
        if(!message)continue;
        const result=await push(x.rec.userId,message);
        logs.push([nowText(),id,String(row[rh['課程日期']]||''),x.rec.name||x.recipientName,'老師',x.rec.userId,message,result.ok?'已發送':'失敗',result.id,result.ok?'':result.body,key]);
        if(result.ok)sent.add(key);
      }
      continue;
    }
    const first=group[0]; const row=first.item.row; const idList=group.map(x=>String(x.item.row[rh['提醒ID']]||''));
    const recipient=first.rec; const groupMembers=formatTeacherMembers(group.map(x=>({row:x.item.row})),rh);
    const message=templateMessage({role:'老師',row,h:rh,templates,teacherMembers:groupMembers});
    if(!message)continue;
    const pendingKeys=idList.map(id=>`${id}|${recipient.userId}`).filter(k=>!sent.has(k));
    if(!pendingKeys.length)continue;
    const result=await push(recipient.userId,message);
    for(const key of pendingKeys){
      const reminderId=key.split('|')[0];
      logs.push([nowText(),reminderId,String(row[rh['課程日期']]||''),recipient.name||first.recipientName,'老師',recipient.userId,message,result.ok?'已發送':'失敗',result.id,result.ok?'':result.body,key]);
      if(result.ok)sent.add(key);
    }
  }

  if(logs.length)await appendRows('發送紀錄',logs);
  console.log(`Reminder Scheduler complete: due=${due.length}, logRows=${logs.length}`);
}
if(require.main===module){main().catch(e=>{console.error('Reminder Scheduler failed:',e);process.exit(1);});}
module.exports={main};
