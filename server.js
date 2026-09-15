require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

const REQUIRED = ['LINE_CHANNEL_ACCESS_TOKEN','GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON'];
for (const key of REQUIRED) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const RETRIES = Math.max(0, Number(process.env.GOOGLE_API_MAX_RETRIES || 4));
const INTERVAL_MS = Math.max(30_000, Number(process.env.REMINDER_CHECK_INTERVAL_MS || 60_000));

let serviceAccount;
try { serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 不是有效 JSON；請貼完整 Service Account JSON。'); }

const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version:'v4', auth });

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function retryable(e){
  const s=Number(e?.code||e?.response?.status||0);
  return [429,500,502,503,504].includes(s) || /quota exceeded|rate limit|temporarily unavailable/i.test(String(e?.message||''));
}
async function retry(label, fn){
  let last;
  for(let i=0;i<=RETRIES;i++){
    try{return await fn();}
    catch(e){
      last=e;
      if(!retryable(e)||i>=RETRIES) throw e;
      const w=Math.min(10_000,600*(2**i))+Math.floor(Math.random()*300);
      console.warn(`${label}: retry ${i+1}/${RETRIES} after ${w}ms`);
      await sleep(w);
    }
  }
  throw last;
}
function qsheet(name){ return `'${String(name).replace(/'/g,"''")}'`; }
function norm(v){ return String(v ?? '').trim().replace(/\s+/g,''); }
function splitMembers(v){ return String(v||'').split(/[、,，\/]/).map(s=>s.trim()).filter(Boolean); }
function hmap(h){ return Object.fromEntries((h||[]).map((x,i)=>[String(x).trim(),i])); }
function findHeaderRow(rows, required){
  return (rows||[]).findIndex(r=>Array.isArray(r) && required.every(k=>r.map(x=>String(x).trim()).includes(k)));
}
function settings(rows){ const o={}; for(const r of (rows||[]).slice(2)) if(r[0]) o[String(r[0]).trim()]=String(r[1]??''); return o; }
function nowText(){
  return new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ',' ');
}
function nowParts(){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>parts.find(x=>x.type===t)?.value;
  return {y:+g('year'),m:+g('month'),d:+g('day'),h:+g('hour'),min:+g('minute'),sec:+g('second')};
}
function dateKey(v){
  if(v instanceof Date && !isNaN(v)) return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
  if(typeof v==='number' && Number.isFinite(v)){
    const days=Math.floor(v);
    const dt=new Date(Date.UTC(1899,11,30)+days*86400000);
    return new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(dt);
  }
  const s=String(v??'').trim();
  const m=s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if(m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  const m2=s.match(/^(\d{1,2})[\/](\d{1,2})[\/](\d{4})/);
  return m2 ? `${m2[3]}-${String(m2[1]).padStart(2,'0')}-${String(m2[2]).padStart(2,'0')}` : s.slice(0,10);
}
function timeKey(v){
  if(typeof v==='number'){
    const mins=Math.round((v%1)*24*60);
    return `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  }
  const s=String(v??'').trim();
  const m=s.match(/(\d{1,2}):([0-5]\d)/);
  return m ? `${String(+m[1]).padStart(2,'0')}:${m[2]}` : '';
}
function getRelationCol(h){ return h['學生姓名/關聯（可多位）'] ?? h['學生姓名/關聯'] ?? h['系統登記名稱/學生']; }

async function batchRead(){
  return retry('reminder batchGet', async()=>{
    const ranges=[
      `${qsheet('系統設定')}!A:D`,
      `${qsheet('課程提醒')}!A:O`,
      `${qsheet('聯絡人')}!A:K`,
      `${qsheet('發送紀錄')}!A:L`,
      `${qsheet('訊息模板')}!A:F`
    ];
    const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});
    return (r.data.valueRanges||[]).map(v=>v.values||[]);
  });
}

async function appendLog(row){
  await retry('append 發送紀錄',()=>sheets.spreadsheets.values.append({
    spreadsheetId:SHEET_ID,
    range:`${qsheet('發送紀錄')}!A:K`,
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:{values:[row]}
  }));
}
function sentKeys(rows){
  const hr=rows.findIndex(r=>Array.isArray(r)&&r.some(x=>String(x).trim()==='狀態')&&r.some(x=>/唯一鍵/.test(String(x))));
  if(hr<0) return new Set();
  const h=hmap(rows[hr]);
  const statusCol=h['狀態'];
  const keyCol=Object.entries(h).find(([k])=>/唯一鍵/.test(k))?.[1];
  const out=new Set();
  if(keyCol===undefined) return out;
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const key=String(r[keyCol]||'').trim(); if(!key) continue;
    if(statusCol===undefined || norm(r[statusCol])==='已發送') out.add(key);
  }
  return out;
}
function readTemplates(rows){
  const hr=findHeaderRow(rows,['模板名稱','適用對象','模板內容']);
  if(hr<0) return {};
  const h=hmap(rows[hr]); const out={};
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; const name=String(r[h['模板名稱']]||'').trim(); if(!name) continue;
    if(norm(r[h['啟用']]??'是')==='否') continue;
    out[name]=String(r[h['模板內容']]||'').trim();
  }
  return out;
}
function substitute(t,v){ return String(t||'').replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,k)=>String(v[k.trim()]??'')); }
function weekdayZh(date){
  const s=dateKey(date); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y,m,d]=s.split('-').map(Number); return ['日','一','二','三','四','五','六'][new Date(Date.UTC(y,m-1,d)).getUTCDay()];
}
function messageFor(role,row,h,templates,members){
  const custom=String(row[h['訊息內容']]||'').trim();
  if(custom) return custom;
  const course=String(row[h['課程']]||'').trim();
  const templateName=String(row[h['模板名稱']]||'').trim();
  let t='';
  if(templateName&&templates[templateName]) t=templates[templateName];
  else if(role==='家長') t=course.includes('團班')?(templates['家長團班']||templates['家長一般']||''):(templates['家長一般']||'');
  else if(role==='老師') t=templates['老師通知']||'';
  return substitute(t,{
    '學生':String(row[h['學生/學生成員']]||'').trim(),
    '日期':String(dateKey(row[h['課程日期']])).slice(5).replace(/^0/,'').replace('-','/'),
    '星期':weekdayZh(row[h['課程日期']]),
    '時間':timeKey(row[h['上課時間']]),
    '課程':course,
    '校區':String(row[h['校區']]||'').trim(),
    '學生成員':members ?? String(row[h['學生/學生成員']]||'').trim(),
    '老師':String(row[h['老師']]||'').trim()
  });
}

function contactsIndex(rows){
  const hr=findHeaderRow(rows,['姓名','身分','LINE User ID']);
  if(hr<0) throw new Error('聯絡人工作表欄位不正確。');
  const h=hmap(rows[hr]); const relCol=getRelationCol(h); const list=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[]; if(!r.length) continue;
    list.push({
      name:String(r[h['姓名']]||'').trim(), role:String(r[h['身分']]||'').trim(),
      relation:splitMembers(relCol===undefined?'':r[relCol]), userId:String(r[h['LINE User ID']]||'').trim(),
      bound:norm(r[h['綁定狀態']])==='已綁定', enabled:norm(r[h['通知啟用']]??r[h['啟用']]??'是')!=='否'
    });
  }
  return list;
}
function resolveParent(contacts,student){
  const s=norm(student);
  return contacts.filter(c=>c.role==='家長'&&c.bound&&c.enabled&&/^U/.test(c.userId)&&c.relation.some(x=>norm(x)===s));
}
function resolveTeacher(contacts,recipient){
  const n=norm(recipient);
  return contacts.find(c=>c.role==='老師'&&c.bound&&c.enabled&&/^U/.test(c.userId)&&(norm(c.name)===n||c.relation.some(x=>norm(x)===n)));
}
async function push(uid,text){
  const r=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`},body:JSON.stringify({to:uid,messages:[{type:'text',text}]})});
  return {ok:r.ok,status:r.status,id:r.headers.get('x-line-request-id')||'',body:await r.text()};
}
function dueRows(rows,h){
  const now=nowParts(); const today=`${now.y}-${String(now.m).padStart(2,'0')}-${String(now.d).padStart(2,'0')}`; const nowMin=now.h*60+now.min;
  const out=[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i]||[]; if(!r[h['提醒ID']]) continue;
    if(norm(r[h['確認發送']]??'是')!=='是') continue;
    const d=dateKey(r[h['發送日期']]); const t=timeKey(r[h['發送時間']]); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!t) continue;
    const [hh,mm]=t.split(':').map(Number); if(d<today || (d===today && nowMin>=hh*60+mm)) out.push({index:i,row:r});
  }
  return out;
}

async function main(){
  const [sRows,rRows,cRows,lRows,tRows]=await batchRead();
  const cfg=settings(sRows);
  if(norm(cfg['課程提醒啟用'])!=='是'){ console.log('Reminder Scheduler: OFF'); return; }
  const rh=findHeaderRow(rRows,['提醒ID','課程日期','發送日期','發送時間','確認發送']);
  if(rh<0) throw new Error('課程提醒工作表欄位不正確。');
  const h=hmap(rRows[rh]);
  for(const k of ['訊息內容','身分','收件人','學生/學生成員','課程日期','上課時間']) if(h[k]===undefined) throw new Error(`課程提醒缺少欄位：${k}`);
  const contacts=contactsIndex(cRows); const templates=readTemplates(tRows); const sent=sentKeys(lRows);
  const due=dueRows(rRows.slice(rh+1),h).map(x=>({index:x.index+rh+1,row:x.row}));
  console.log(`Reminder scan: now=${nowText()} due=${due.length} sentKeys=${sent.size}`);

  const teacherGroups=new Map();
  for(const item of due){
    const row=item.row; const id=String(row[h['提醒ID']]); const role=String(row[h['身分']]||'').trim(); const recipient=String(row[h['收件人']]||'').trim(); const student=String(row[h['學生/學生成員']]||'').trim();
    if(role==='家長'){
      const recs=resolveParent(contacts,student); console.log(`Parent resolve: ${recipient} / ${student} -> ${recs.map(x=>x.userId).join(',')||'NONE'}`);
      for(const rec of recs){
        const key=`${id}|${rec.userId}`; if(sent.has(key)){console.log(`Skip sent ${key}`);continue;}
        const msg=messageFor('家長',row,h,templates); if(!msg){console.warn(`No message for ${id}`);continue;}
        const res=await push(rec.userId,msg);
        await appendLog([nowText(),id,String(row[h['課程日期']]||''),rec.name||recipient,'家長',rec.userId,msg,res.ok?'已發送':'失敗',res.id,res.ok?'':res.body,key]);
        console.log(`Parent push ${key}: ${res.ok?'OK':'FAIL '+res.status}`);
        if(res.ok) sent.add(key);
      }
    } else if(role==='老師'){
      const rec=resolveTeacher(contacts,recipient); console.log(`Teacher resolve: ${recipient} -> ${rec?.userId||'NONE'}`);
      if(!rec){ continue; }
      const groupKey=[rec.userId,dateKey(row[h['課程日期']]),timeKey(row[h['上課時間']]),String(row[h['校區']]||'').trim()].join('|');
      if(!teacherGroups.has(groupKey)) teacherGroups.set(groupKey,[]); teacherGroups.get(groupKey).push({item,rec});
    }
  }

  for(const [,group] of teacherGroups){
    const first=group[0], row=first.item.row, rec=first.rec; const allCustom=group.every(x=>String(x.item.row[h['訊息內容']]||'').trim());
    const customItems=group.filter(x=>String(x.item.row[h['訊息內容']]||'').trim());
    if(customItems.length){
      for(const x of group){
        const r=x.item.row, id=String(r[h['提醒ID']]), key=`${id}|${rec.userId}`; if(sent.has(key)) continue;
        const msg=messageFor('老師',r,h,templates);
        if(!msg) continue;
        const res=await push(rec.userId,msg);
        await appendLog([nowText(),id,String(r[h['課程日期']]||''),rec.name,'老師',rec.userId,msg,res.ok?'已發送':'失敗',res.id,res.ok?'':res.body,key]);
        console.log(`Teacher push ${key}: ${res.ok?'OK':'FAIL '+res.status}`);
        if(res.ok) sent.add(key);
      }
    } else {
      const ids=group.map(x=>String(x.item.row[h['提醒ID']]||''));
      const pending=ids.filter(id=>!sent.has(`${id}|${rec.userId}`));
      if(!pending.length) continue;
      const seen=new Set(); const parts=[];
      for(const x of group){
        const r=x.item.row; const course=String(r[h['課程']]||'').trim(); const student=String(r[h['學生/學生成員']]||'').trim();
        const k=course||'__NONE__'; if(!seen.has(k)){ seen.add(k); parts.push(course&&course.includes('團班')?`${course}(${student})`:student); } else if(student){ const idx=parts.length-1; if(course&&parts[idx].startsWith(course+'(')) parts[idx]=parts[idx].replace(/\)$/,`、${student})`); else parts.push(student); }
      }
      const members=parts.filter(Boolean).join('、');
      const msg=messageFor('老師',row,h,templates,members); if(!msg) continue;
      const res=await push(rec.userId,msg);
      for(const id of pending){ const key=`${id}|${rec.userId}`; await appendLog([nowText(),id,String(row[h['課程日期']]||''),rec.name,'老師',rec.userId,msg,res.ok?'已發送':'失敗',res.id,res.ok?'':res.body,key]); if(res.ok) sent.add(key); }
      console.log(`Teacher grouped push ${rec.userId}: ${res.ok?'OK':'FAIL '+res.status}, logs=${pending.length}`);
    }
  }
}

async function todaySnapshot(){
  const [sRows,rRows,,,]=await batchRead();
  const cfg=settings(sRows);
  const rh=findHeaderRow(rRows,['提醒ID','課程日期','發送日期','發送時間','確認發送']);
  if(rh<0) throw new Error('課程提醒工作表欄位不正確。');
  const h=hmap(rRows[rh]);
  const sentRows=await retry('today 發送紀錄',()=>sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:`${qsheet('發送紀錄')}!A:L`,majorDimension:'ROWS'}));
  const sent=sentKeys(sentRows.data.values||[]);
  const np=nowParts();
  const today=`${np.y}-${String(np.m).padStart(2,'0')}-${String(np.d).padStart(2,'0')}`;
  const rows=[];
  for(let i=rh+1;i<rRows.length;i++){
    const r=rRows[i]||[]; const id=String(r[h['提醒ID']]||'').trim(); if(!id) continue;
    const sendDate=dateKey(r[h['發送日期']]);
    if(sendDate!==today) continue;
    const role=String(r[h['身分']]||'').trim(); const recipient=String(r[h['收件人']]||'').trim();
    const courseDate=dateKey(r[h['課程日期']]); const sendTime=timeKey(r[h['發送時間']]);
    const confirmed=norm(r[h['確認發送']]??'是')==='是';
    rows.push({
      row:i+1,提醒ID:id,發送日期:sendDate,發送時間:sendTime,確認發送:confirmed?'是':'否',
      課程日期:courseDate,上課時間:timeKey(r[h['上課時間']]),身分:role,收件人:recipient,
      學生: String(r[h['學生/學生成員']]||'').trim(),課程:String(r[h['課程']]||'').trim(),老師:String(r[h['老師']]||'').trim(),校區:String(r[h['校區']]||'').trim(),
      訊息內容:String(r[h['訊息內容']]||'').trim()
    });
  }
  return {ok:true,service:'line-course-reminder',version:'1.6.0',timezone:TZ,today,enabled:norm(cfg['課程提醒啟用'])==='是',count:rows.length,rows};
}

const app=express();
const PORT=Number(process.env.PORT||10000);
let running=false,lastRunAt=null,lastRunOk=null,lastRunError=null;
app.get('/health',(_req,res)=>res.json({ok:true,service:'line-course-reminder',version:'1.6.0',intervalMs:INTERVAL_MS,lastRunAt,lastRunOk,lastRunError,running}));
app.get('/today',async(_req,res)=>{ try{ res.json(await todaySnapshot()); } catch(e){ res.status(500).json({ok:false,service:'line-course-reminder',version:'1.6.0',error:e?.message||String(e)}); }});
const server=app.listen(PORT,()=>{
  console.log(`line-course-reminder Web Service v1.6.0 listening on ${PORT}`);
  const tick=async()=>{ if(running){console.log('Reminder check skipped: previous run still in progress.');return;} running=true; lastRunAt=new Date().toISOString(); lastRunError=null; try{await main();lastRunOk=true;}catch(e){lastRunOk=false;lastRunError=e?.message||String(e);console.error('Reminder check failed:',e);}finally{running=false;} };
  setTimeout(()=>void tick(),3000); setInterval(()=>void tick(),INTERVAL_MS);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('uncaughtException',e=>console.error('Uncaught exception:',e));
process.on('unhandledRejection',e=>console.error('Unhandled rejection:',e));
