require('dotenv').config();
const express=require('express');
const { main, todayReport }=require('./reminder_scheduler');
const PORT=Number(process.env.PORT||10000), INTERVAL_MS=Math.max(30000,Number(process.env.REMINDER_CHECK_INTERVAL_MS||60000));
let running=false,lastRunAt=null,lastRunOk=null,lastRunError=null;
async function tick(){if(running){console.log('Reminder check skipped: previous run still in progress.');return}running=true;lastRunAt=new Date().toISOString();lastRunError=null;try{await main();lastRunOk=true}catch(e){lastRunOk=false;lastRunError=e?.message||String(e);console.error('Reminder check failed:',e)}finally{running=false}}
const app=express();
app.get('/health',(_req,res)=>res.json({ok:true,service:'line-course-reminder',version:'2.1.0',intervalMs:INTERVAL_MS,lastRunAt,lastRunOk,lastRunError,running}));
app.get('/today',async(_req,res)=>{try{res.json(await todayReport())}catch(e){res.status(500).json({ok:false,service:'line-course-reminder',version:'2.1.0',error:e?.message||String(e)})}});
app.get('/run',async(_req,res)=>{if(running)return res.status(409).json({ok:false,error:'already-running'});await tick();res.status(lastRunOk?200:500).json({ok:lastRunOk===true,version:'2.1.0',lastRunAt,lastRunOk,lastRunError})});
app.listen(PORT,()=>{console.log(`line-course-reminder Web Service v2.1.0 listening on ${PORT}`);setTimeout(()=>void tick(),3000);setInterval(()=>void tick(),INTERVAL_MS)});
