require('dotenv').config();
const { google } = require('googleapis');
for (const key of ['LINE_CHANNEL_ACCESS_TOKEN','GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON']) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const TOKEN=process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHEET_ID=process.env.GOOGLE_SHEET_ID;
const TZ=process.env.TIMEZONE||'Asia/Taipei';
const RETRIES=Math.max(0,Number(process.env.GOOGLE_API_MAX_RETRIES||4));
const auth=new google.auth.GoogleAuth({credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),scopes:['https://www.googleapis.com/auth/spreadsheets']});
const sheets=google.sheets({version:'v4',auth});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function retryable(e){const s=Number(e?.code||e?.response?.status||0);return [429,500,502,503,504].includes(s)||/quota exceeded|rate limit|temporarily unavailable/i.test(String(e?.message||''));}
async function retry(label,fn){let last;for(let i=0;i<=RETRIES;i++){try{return await fn()}catch(e){last=e;if(!retryable(e)||i>=RETRIES)throw e;const w=Math.min(10000,600*(2**i))+Math.floor(Math.random()*300);console.warn(`${label}: retry ${i+1}/${RETRIES} after ${w}ms`);await sleep(w)}}throw last}
const q=n=>`'${String(n).replace(/'/g,"''")}'`;
const norm=v=>String(v??'').trim().replace(/\s+/g,'');
const split=v=>String(v||'').split(/[、,，\/]/).map(s=>s.trim()).filter(Boolean);
const hmap=h=>Object.fromEntries((h||[]).map((x,i)=>[String(x).trim(),i]));
function findHeaderRow(rows,required){return (rows||[]).findIndex(r=>Array.isArray(r)&&required.every(k=>r.map(x=>String(x).trim()).includes(k)));}
function settings(rows){const o={};for(const r of (rows||[]).slice(2))if(r[0])o[String(r[0]).trim()]=String(r[1]??'').trim();return o;}
function nowParts(){const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());const g=t=>p.find(x=>x.type===t)?.value;return{y:+g('year'),m:+g('month'),d:+g('day'),wd:g('weekday'),h:+g('hour'),min:+g('minute'),sec:+g('second')}}
function nowText(){const n=nowParts();return `${String(n.y).padStart(4,'0')}-${String(n.m).padStart(2,'0')}-${String(n.d).padStart(2,'0')} ${String(n.h).padStart(2,'0')}:${String(n.min).padStart(2,'0')}:${String(n.sec).padStart(2,'0')}`}
function dateKey(v){const s=String(v??'').trim();if(/^\d+(?:\.\d+)?$/.test(s)){const serial=Number(s);if(serial>30000){const ms=Math.round((serial-25569)*86400000);const d=new Date(ms);return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}}const m=s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s.slice(0,10)}
function timeKey(v){if(typeof v==='number'||/^\d+(?:\.\d+)?$/.test(String(v??'').trim())){const n=Number(v);if(Number.isFinite(n)&&n>0&&n<1.5){const mins=Math.round((n%1)*1440);return `${String(Math.floor(mins/60)%24).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`}}const s=String(v??'').trim().replace(/上午|下午/g,' ');const m=s.match(/(\d{1,2}):([0-5]\d)/);if(m){let h=+m[1];if(/PM|下午/i.test(s)&&h<12)h+=12;if(/AM|上午/i.test(s)&&h===12)h=0;return `${String(h).padStart(2,'0')}:${m[2]}`}return ''}
async function read(){return retry('batchGet',async()=>{const ranges=[`${q('系統設定')}!A:D`,`${q('課程提醒')}!A:M`,`${q('聯絡人')}!A:I`,`${q('發送紀錄')}!A:K`,`${q('訊息模板')}!A:D`];const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:SHEET_ID,ranges,majorDimension:'ROWS'});return (r.data.valueRanges||[]).map(x=>x.values||[])})}
async function appendLog(row){return retry('append 發送紀錄',()=>sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:`${q('發送紀錄')}!A:K`,valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:[row]}}))}
function sentKeys(rows){const hr=rows.findIndex(r=>Array.isArray(r)&&r.some(x=>String(x).trim()==='狀態')&&r.some(x=>String(x).trim()==='唯一鍵 Course ID + User ID'));if(hr<0)return new Set();const h=hmap(rows[hr]);const k=h['唯一鍵 Course ID + User ID'];const st=h['狀態'];const out=new Set();for(let i=hr+1;i<rows.length;i++){const r=rows[i]||[];const key=String(r[k]||'').trim();if(key&&norm(r[st])==='已發送')out.add(key)}return out}
function readTemplates(rows){const hr=findHeaderRow(rows,['模板名稱','適用對象','模板內容']);if(hr<0)throw new Error('訊息模板缺少標準欄位');const h=hmap(rows[hr]),out={};for(let i=hr+1;i<rows.length;i++){const r=rows[i]||[];const name=String(r[h['模板名稱']]||'').trim();if(name)out[name]=String(r[h['模板內容']]||'').trim()}return out}
function weekdayZh(d){const s=dateKey(d);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return '';const [y,m,dd]=s.split('-').map(Number);return ['日','一','二','三','四','五','六'][new Date(Date.UTC(y,m-1,dd)).getUTCDay()]}
function msg(role,r,h,templates,members){const custom=String(r[h['訊息內容']]||'').trim();if(custom)return custom;const course=String(r[h['課程']]||'').trim();let t='';if(role==='家長')t=course.includes('團班')?(templates['家長團班']||templates['家長一般']||''):(templates['家長一般']||'');if(role==='老師')t=templates['老師通知']||'';return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,k)=>String(({學生:String(r[h['學生/學生成員']]||'').trim(),日期:dateKey(r[h['課程日期']]).slice(5).replace(/^0/,'').replace('-','/'),星期:weekdayZh(r[h['課程日期']]),時間:timeKey(r[h['上課時間']]),課程:course,校區:String(r[h['校區']]||'').trim(),學生成員:members??String(r[h['學生/學生成員']]||'').trim(),老師:String(r[h['老師']]||'').trim()})[k.trim()]??''))}
function contacts(rows){const hr=findHeaderRow(rows,['姓名','身分','LINE User ID']);if(hr<0)throw new Error('聯絡人缺少標準欄位');const h=hmap(rows[hr]);const rel=h['學生姓名/關聯（可多位）'];const out=[];for(let i=hr+1;i<rows.length;i++){const r=rows[i]||[];out.push({name:String(r[h['姓名']]||'').trim(),role:String(r[h['身分']]||'').trim(),relation:split(r[rel]||''),uid:String(r[h['LINE User ID']]||'').trim(),bound:norm(r[h['綁定狀態']])==='已綁定',enabled:norm(r[h['通知啟用']])!=='否'})}return out}
function isMergedReminderId(id){return /^MERGED-/.test(String(id??'').trim())}

function extractMemberNames(value){
  const source=String(value??'').trim();
  if(!source) return [];

  const names=[];
  const seen=new Set();
  const add=v=>{
    const name=String(v??'').trim();
    if(!name) return;
    const key=norm(name);
    if(!key || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  // 團班格式：生物團班(葉依柔、陳翊森)
  // 只把括號內真正的學生姓名加入配對名單，不把「生物團班」當成學生。
  const groupPattern=/[^、,，\/()（）]+[（(]([^（）()]*)[）)]/g;
  let match;
  const consumed=[];
  while((match=groupPattern.exec(source))){
    consumed.push(match[0]);
    for(const name of split(match[1])) add(name);
  }

  // 移除已處理的團班區塊，再處理一般「凱荻、佳叡」格式。
  let remainder=source;
  for(const block of consumed) remainder=remainder.replace(block,'');
  for(const name of split(remainder)) add(name);

  return names;
}

function resolveParent(cs,student,{merged=false}={}){
  const names=merged?extractMemberNames(student):[String(student??'').trim()];
  const wanted=new Set(names.map(norm).filter(Boolean));
  if(!wanted.size) return [];
  return cs.filter(c=>
    c.role==='家長' &&
    c.bound &&
    c.enabled &&
    /^U/.test(c.uid) &&
    c.relation.some(x=>wanted.has(norm(x)))
  );
}
function resolveTeacher(cs,recipient,teacherName){const names=[recipient,teacherName].map(norm).filter(Boolean);return cs.find(c=>c.role==='老師'&&c.bound&&c.enabled&&/^U/.test(c.uid)&&names.some(n=>norm(c.name)===n||c.relation.some(x=>norm(x)===n)))}
async function push(uid,text){const r=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${TOKEN}`},body:JSON.stringify({to:uid,messages:[{type:'text',text}]})});return{ok:r.ok,status:r.status,id:r.headers.get('x-line-request-id')||'',body:await r.text()}}
function dueRows(rows,h){const n=nowParts(),today=`${n.y}-${String(n.m).padStart(2,'0')}-${String(n.d).padStart(2,'0')}`,nowMin=n.h*60+n.min,out=[];for(let i=0;i<rows.length;i++){const r=rows[i]||[];if(!r[h['提醒ID']]||norm(r[h['確認發送']])!=='是')continue;const d=dateKey(r[h['發送日期']]),t=timeKey(r[h['發送時間']]);if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!t)continue;const [hh,mm]=t.split(':').map(Number);if(d<today||(d===today&&nowMin>=hh*60+mm))out.push({row:r,index:i})}return out}
async function main(){
  const [sRows,rRows,cRows,lRows,tRows]=await read();
  const cfg=settings(sRows);
  if(cfg['自動發送總開關']!=='是'){
    console.log('Reminder Scheduler: OFF');
    return;
  }

  const rh=findHeaderRow(rRows,['提醒ID','課程日期','發送日期','發送時間','確認發送']);
  if(rh<0) throw new Error('課程提醒缺少標準標題列');
  const h=hmap(rRows[rh]);
  for(const k of ['訊息內容','身分','收件人','學生/學生成員','課程日期','上課時間','課程','老師','校區']){
    if(h[k]===undefined) throw new Error(`課程提醒缺少標準欄位：${k}`);
  }

  const cs=contacts(cRows);
  const templates=readTemplates(tRows);
  const sent=sentKeys(lRows);
  const due=dueRows(rRows.slice(rh+1),h);

  for(const item of due){
    const r=item.row;
    const id=String(r[h['提醒ID']]).trim();
    const role=String(r[h['身分']]||'').trim();
    const recipient=String(r[h['收件人']]||'').trim();
    const student=String(r[h['學生/學生成員']]||'').trim();
    const merged=isMergedReminderId(id);

    if(role==='家長'){
      const recipients=resolveParent(cs,student,{merged});
      if(merged){
        console.log(`Merged parent reminder: id=${id} members=${extractMemberNames(student).join('、')} matched=${recipients.length}`);
      }
      for(const rec of recipients){
        const key=`${id}|${rec.uid}`;
        if(sent.has(key)) continue;
        const text=msg('家長',r,h,templates);
        if(!text) continue;

        const res=await push(rec.uid,text);
        try{
          await appendLog([
            nowText(),id,dateKey(r[h['課程日期']]),rec.name||recipient,'家長',
            rec.uid,text,res.ok?'已發送':'失敗',res.id,res.ok?'':res.body,key
          ]);
        }catch(e){
          console.error(`LINE 已送出但發送紀錄寫入失敗 key=${key}:`,e?.message||e);
        }
        if(res.ok) sent.add(key);
      }
    }else if(role==='老師'){
      const rec=resolveTeacher(cs,recipient,String(r[h['老師']]||''));
      if(!rec){
        console.warn(`Teacher resolve FAILED reminder=${id} merged=${merged} recipient=${recipient} teacher=${r[h['老師']]||''}`);
        continue;
      }

      const key=`${id}|${rec.uid}`;
      if(sent.has(key)) continue;
      const text=msg('老師',r,h,templates);
      if(!text) continue;

      const res=await push(rec.uid,text);
      try{
        await appendLog([
          nowText(),id,dateKey(r[h['課程日期']]),rec.name||recipient,'老師',
          rec.uid,text,res.ok?'已發送':'失敗',res.id,res.ok?'':res.body,key
        ]);
      }catch(e){
        console.error(`LINE 已送出但發送紀錄寫入失敗 key=${key}:`,e?.message||e);
      }
      if(res.ok) sent.add(key);
    }
  }

  console.log(`Reminder scan complete due=${due.length}`);
}

async function todayReport(){
  const [sRows,rRows,cRows,lRows,tRows]=await read();
  const cfg=settings(sRows);
  const enabled=cfg['自動發送總開關']==='是';
  const rh=findHeaderRow(rRows,['提醒ID','課程日期','發送日期','發送時間','確認發送']);
  if(rh<0) throw new Error('課程提醒缺少標準標題列');

  const h=hmap(rRows[rh]);
  const cs=contacts(cRows);
  const sent=sentKeys(lRows);
  const n=nowParts();
  const today=`${n.y}-${String(n.m).padStart(2,'0')}-${String(n.d).padStart(2,'0')}`;
  const rows=[];

  for(let i=rh+1;i<rRows.length;i++){
    const r=rRows[i]||[];
    if(!r[h['提醒ID']]) continue;

    const id=String(r[h['提醒ID']]).trim();
    const sendDate=dateKey(r[h['發送日期']]);
    if(sendDate!==today) continue;

    const role=String(r[h['身分']]||'').trim();
    const recipient=String(r[h['收件人']]||'').trim();
    const student=String(r[h['學生/學生成員']]||'').trim();
    const merged=isMergedReminderId(id);

    let matches=[];
    if(role==='家長'){
      matches=resolveParent(cs,student,{merged});
    }else if(role==='老師'){
      const rec=resolveTeacher(cs,recipient,String(r[h['老師']]||''));
      if(rec) matches=[rec];
    }

    rows.push({
      row:i+1,
      提醒ID:id,
      合併提醒:merged?'是':'否',
      身分:role,
      收件人:recipient,
      學生:student,
      成員:merged?extractMemberNames(student):[student].filter(Boolean),
      發送日期:sendDate,
      發送時間:timeKey(r[h['發送時間']]),
      確認發送:norm(r[h['確認發送']]),
      matches:matches.map(x=>({姓名:x.name,LINEUserID:x.uid})),
      sent:matches.some(x=>sent.has(`${id}|${x.uid}`))
    });
  }

  return{
    ok:true,
    service:'line-course-reminder',
    version:'2.2.0',
    timezone:TZ,
    today,
    enabled,
    count:rows.length,
    rows
  };
}
module.exports={main,todayReport};
