require('dotenv').config();
const express=require('express');
const {main:runReminders}=require('./reminder_scheduler');
const app=express();
const PORT=Number(process.env.PORT||10000);
const INTERVAL_MS=Math.max(30_000,Number(process.env.REMINDER_CHECK_INTERVAL_MS||60_000));
let running=false,lastRunAt=null,lastRunOk=null,lastRunError=null;
app.get('/health',(_req,res)=>res.json({ok:true,service:'line-course-reminder',version:'1.4.0',intervalMs:INTERVAL_MS,lastRunAt,lastRunOk,lastRunError,running}));
async function tick(){if(running){console.log('Reminder check skipped: previous run still in progress.');return;}running=true;lastRunAt=new Date().toISOString();lastRunError=null;try{await runReminders();lastRunOk=true;}catch(err){lastRunOk=false;lastRunError=err?.message||String(err);console.error('Reminder check failed:',err);}finally{running=false;}}
const server=app.listen(PORT,()=>{console.log(`line-course-reminder Web Service v1.4.0 listening on ${PORT}`);console.log(`Reminder check interval: ${INTERVAL_MS} ms`);setTimeout(()=>void tick(),5000);setInterval(()=>void tick(),INTERVAL_MS);});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('uncaughtException',err=>console.error('Uncaught exception:',err));process.on('unhandledRejection',err=>console.error('Unhandled rejection:',err));
