// Temporary live performance diagnostics; never export request headers or tokens.
import fs from 'node:fs';
import { API, guardDashboard, runPage, safari } from './safari-bridge.mjs';
guardDashboard();
const command=process.argv[2];
if(command==='start') {
  console.log(JSON.stringify(await runPage(`
    const response=await fetch('${API}/workers/scripts/kuraflow-kitchen/tails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filters:[]})});
    const data=await response.json();
    if(!response.ok||!data.success)throw new Error('Live diagnostics '+response.status+': '+JSON.stringify(data.errors));
    window.__kfTailId=data.result.id;window.__kfTailEvents=[];
    const socket=new WebSocket(data.result.url,'trace-v1');window.__kfTailSocket=socket;
    socket.onmessage=async event=>{try{
      const value=JSON.parse(typeof event.data==='string'?event.data:await event.data.text());
      window.__kfTailEvents.push({path:value.event?.request?.url?new URL(value.event.request.url).pathname:null,method:value.event?.request?.method,cpu:value.cpuTime,wall:value.wallTime,outcome:value.outcome,status:value.event?.response?.status,timestamp:value.eventTimestamp});
    }catch{window.__kfTailEvents.push({parseError:true});}};
    await new Promise((resolve,reject)=>{socket.onopen=()=>{socket.send(JSON.stringify({debug:false}));resolve();};socket.onerror=()=>reject(new Error('Live diagnostics socket connection failed.'));});
    return {connected:true};
  `)));
}else if(command==='stop') {
  const result=await runPage(`
    const events=window.__kfTailEvents||[];
    window.__kfTailSocket?.close();
    if(window.__kfTailId){
      const response=await fetch('${API}/workers/scripts/kuraflow-kitchen/tails/'+window.__kfTailId,{method:'DELETE'});
      if(!response.ok)throw new Error('Could not close live diagnostic session.');
    }
    delete window.__kfTailId;delete window.__kfTailSocket;return events;
  `);
  fs.writeFileSync('private-deploy/live-performance.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result,null,2));
}else console.log(safari('JSON.stringify(window.__kfTailEvents||[])'));
