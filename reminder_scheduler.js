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
function uniq(a){return [...new Set(a)];}
function split(v){return String(v||'').split('、').map(s=>s.trim()).filter(Boolean);}
function hmap(h){return Object.fromEntries((h||[]).map((x,i)=>[String(x),i]));}
function now(){return new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date());}
function parts(){const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());const g=t=>p.find(x=>x.type===t)?.value;return{y:+g('year'),m:+g('month'),d:+g('day'),wd:g('weekday'),h:String(g('hour')).padStart(2,'0'),min:String(g('minute')).padStart(2,'0')};}
async function batchRead(){return retry('reminder batchGet',async()=>{const ranges=[`${esc('系統設定')}!A:D`,`${esc('課程提醒')}!A:M`,`${esc('聯絡人')}!A:I`,`${esc('發送紀錄')}!A:K`];const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});return(r.data.valueRanges||[]).map(v=>v.values||[]);});}
async function appendRows(sheet,rows){if(!rows.length)return;await retry(`append ${sheet}`,()=>sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:`${esc(sheet)}!A:Z`,valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',requestBody:{values:rows}}));}
function settings(rows){const o={};for(const r of (rows||[]).slice(2))if(r[0])o[String(r[0])]=String(r[1]||'');return o;}
function findRecipient(rows,h,role,name){const n=norm(name);return rows.slice(1).map(r=>({name:r[h['姓名']]||'',role:r[h['身分']]||'',students:r[h['學生姓名/關聯（可多位）']]!==undefined?split(r[h['學生姓名/關聯（可多位）']]):split(r[h['學生姓名/關聯']]||''),userId:r[h['LINE User ID']]||'',bound:norm(r[h['綁定狀態']])==='已綁定',enabled:norm(r[h['通知啟用']]??r[h['啟用']]??'是')!=='否'})).find(x=>x.role===role&&x.bound&&x.enabled&&String(x.userId).startsWith('U')&&norm(x.name)===n);
}
function findParent(rows,h,student){const s=norm(student),si=h['學生姓名/關聯（可多位）']??h['學生姓名/關聯'];return rows.slice(1).map(r=>({name:r[h['姓名']]||'',role:r[h['身分']]||'',students:split(r[si]||''),userId:r[h['LINE User ID']]||'',bound:norm(r[h['綁定狀態']])==='已綁定',enabled:norm(r[h['通知啟用']]??r[h['啟用']]??'是')!=='否'})).filter(x=>x.role==='家長'&&x.bound&&x.enabled&&String(x.userId).startsWith('U')&&x.students.some(n=>norm(n)===s));}
async function push(uid,text){const r=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`},body:JSON.stringify({to:uid,messages:[{type:'text',text}]})});return{ok:r.ok,status:r.status,id:r.headers.get('x-line-request-id')||'',body:await r.text()};}
function sentKeys(rows){
  if(!rows.length)return new Set();
  const h=hmap(rows[0]||[]);
  const statusCol=h['狀態'];
  const keyCol=h['唯一鍵 Course ID + LINE User ID'] ?? h['唯一鍵 Course ID + User ID'] ?? h['唯一鍵'];
  const out=new Set();
  if(keyCol===undefined)return out;
  for(let i=1;i<rows.length;i++){
    const r=rows[i]||[];
    if((statusCol===undefined || norm(r[statusCol])==='已發送') && r[keyCol])out.add(String(r[keyCol]));
  }
  return out;
}

function effectiveSendAt(date,time){return String(date||'').slice(0,10)+' '+String(time||'00:00');}

async function main(){
  const [sRows,rRows,cRows,lRows]=await batchRead();
  const cfg=settings(sRows);
  if(cfg['課程提醒啟用']!=='是'){console.log('Reminder Scheduler: OFF');return;}

  const rrh=hmap(rRows[1]&&rRows[1][0]==='提醒ID'?rRows[1]:rRows[0]||[]);
  const rhRow = rRows[0]&&rRows[0][0]==='提醒ID'?0:1;
  const headers=rRows[rhRow]||[];
  if(rrh['提醒ID']===undefined)throw new Error('課程提醒工作表欄位不正確，找不到「提醒ID」。');
  const sendOnIdx=rrh['確認發送'];
  const statusIdx=rrh['發送狀態'];

  const nowParts=parts();
  const nowMinutes=Number(nowParts.h)*60+Number(nowParts.min);
  const logs=[];
  const sent=sentKeys(lRows);
  const contacts = cRows || [];
  const contactHeaderRow = contacts.findIndex(r => Array.isArray(r) && r.includes('姓名') && (r.includes('身分') || r.includes('LINE User ID')));
  const contactRows = contactHeaderRow >= 0 ? contacts.slice(contactHeaderRow) : [];
  const ch = hmap(contactRows[0] || []);
  if (ch['姓名'] === undefined || ch['身分'] === undefined || ch['LINE User ID'] === undefined) {
    throw new Error('聯絡人工作表欄位不正確，找不到「姓名／身分／LINE User ID」。');
  }

  for(let i=rhRow+1;i<rRows.length;i++){
    const row=rRows[i]||[];
    if(!row.length||!row[rrh['提醒ID']])continue;
    const confirmed=sendOnIdx===undefined?true:norm(row[sendOnIdx])==='是';
    if(!confirmed)continue;
    const status=statusIdx===undefined?'':norm(row[statusIdx]);
    if(status==='已發送')continue;

    const date=String(row[rrh['發送日期']]||'').slice(0,10);
    const time=String(row[rrh['發送時間']]||'').trim();
    if(!date||!/^\d{1,2}:\d{2}$/.test(time))continue;

    const [hh,mm]=time.split(':').map(Number);
    const targetDate=new Date(`${date}T00:00:00+08:00`);
    const today=new Date(new Date().toLocaleString('en-US',{timeZone:TZ}));
    today.setHours(0,0,0,0);
    targetDate.setHours(0,0,0,0);
    if(targetDate>today)continue;
    if(targetDate.getTime()===today.getTime() && nowMinutes < hh*60+mm)continue;

    const role=String(row[rrh['身分']]||'').trim();
    const recipientName=String(row[rrh['收件人']]||'').trim();
    const studentText=String(row[rrh['學生/學生成員']]||'').trim();
    const explicitUid=''; // LINE User ID is intentionally resolved from 聯絡人.
    let recipients=[];
    if(role==='家長') recipients=findParent(contactRows,ch,studentText);
    else if(role==='老師'){
      const t=findRecipient(contactRows,ch,'老師',recipientName);
      if(t)recipients=[t];
    } else continue;

    const message=String(row[rrh['訊息內容']]||'').trim();
    for(const rec of recipients){
      const reminderId=String(row[rrh['提醒ID']]);
      const key=`${reminderId}|${rec.userId}`;
      if(sent.has(key))continue;
      const result=await push(rec.userId,message);
      logs.push([now(),reminderId,date,recipientName||rec.name,role,rec.userId,message,result.ok?'已發送':'失敗',result.id,result.ok?'':result.body,key]);
      if(result.ok)sent.add(key);
    }
  }

  if(logs.length)await appendRows('發送紀錄',logs);
  console.log(`Reminder Scheduler complete: logRows=${logs.length}`);
}
if (require.main === module) {
  main().catch(e=>{console.error('Reminder Scheduler failed:',e);process.exit(1);});
}
module.exports={main};
