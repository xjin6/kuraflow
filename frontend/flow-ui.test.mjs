import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn,setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {formatFlowText,safeFlowHref,safeFlowImageHref} from '../flow-ui.js';

const bundle = (await build({entryPoints:['flow-ui.js'],bundle:true,write:false,format:'iife',globalName:'FlowUI',logLevel:'silent'})).outputFiles[0].text;
function conversationService(initial = []) {
  const rows = new Map(initial.map(row=>[row.id,structuredClone(row)]));
  let counter = rows.size;
  const request = async (path,body) => {
    if(path === '/conversations' && body === undefined)return {conversations:[...rows.values()].filter(row=>!row.deleted).map(row=>({id:row.id,title:row.title,updatedAt:row.updatedAt,messageCount:row.messages.length})),limit:100};
    if(path === '/conversations'){
      const existing = body.id ? rows.get(body.id) : null;
      if(existing?.deleted)throw Object.assign(new Error('已删除'),{status:410});
      if(existing && body.version !== existing.version)throw Object.assign(new Error('冲突'),{status:409});
      const id = body.id || `00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`;
      const conversation = structuredClone({...body,id,title:body.messages.find(row=>row.role==='user')?.text || '新对话',version:(existing?.version || 0)+1,updatedAt:'2026-10-19T08:00:00.000Z'});
      rows.set(id,conversation);return {conversation};
    }
    const [,id,action] = /^\/conversations\/([^/]+)(?:\/(delete|restore))?$/.exec(path) || [];
    const conversation = rows.get(id);
    if(!conversation)throw new Error('找不到对话');
    if(action==='delete'){conversation.deleted=true;return {ok:true};}
    if(action==='restore'){conversation.deleted=false;return {conversation:structuredClone(conversation)};}
    return {conversation:structuredClone(conversation)};
  };
  return {rows,request};
}
function fixture(t,options = {}) {
  const dom = new JSDOM('<!doctype html><div id="app"><button id="previous">页面按钮</button></div>',{url:'http://localhost:8787/?page=overview',runScripts:'outside-only'});
  const {window} = dom; window.TextDecoder = TextDecoder; window.eval(bundle);
  const requests = [], service=options.conversations || conversationService();
  const customRequest=options.request;
  const ui = window.FlowUI.createFlowUI({initialStatus:{enabled:true,available:true,connected:true,model:'test-model'},...options,getContext:options.getContext||(()=>({page:'overview'})),request:async(path,body)=>{
    requests.push({path,body});
    if(path.startsWith('/conversations'))return service.request(path,body);
    return customRequest ? customRequest(path,body) : {enabled:true,available:true,connected:true,model:'test-model'};
  }});
  t.after(()=>{ui.destroy();window.close();});
  window.document.getElementById('app').insertAdjacentHTML('beforeend',ui.launcher());
  return {window,document:window.document,ui,requests,service};
}
const click = (document,action) => document.querySelector(`[data-flow-action="${action}"]`).click();
const write = (window,text) => {const input=window.document.querySelector('#flow-message');input.value=text;input.dispatchEvent(new window.Event('input',{bubbles:true}));};
const savedMutation=(requestId,extra={})=>({id:`flow:${requestId}:flow_create_store:${'a'.repeat(64)}`,operation:'flow_create_store',label:'新增门店',recordId:'s-test',recordLabel:'测试门店',href:'/?page=stores&store=s-test',revision:1,status:'saved',...extra});
const submit = window => window.document.querySelector('#flow-compose').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
async function settle(predicate) { for(let i=0;i<100;i++){if(predicate())return;await nextTurn();}assert.fail('UI did not reach the expected state'); }

const preparedProposal=requestId=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId,operation:'flow_delete_store',label:'删除门店',recordLabel:'<script>测试店</script>',status:'pending',details:[{label:'门店',value:'测试门店'},{label:'地址',value:'大阪市浪速区難波中1丁目2番3号'}],impact:'已有订单和单据保留。'});
test('operation cards appear after the answer, remain disabled during generation, and only a human click submits confirmation',async t=>{
  let pending,proposal,releaseConfirm,sent=0;const changes=[];
  const {window,document,requests,service}=fixture(t,{onBusinessChange:row=>changes.push(row),send:(payload,options)=>{sent++;proposal=preparedProposal(payload.requestId);return new Promise(resolve=>{pending={options,resolve};});},request:async(path,body)=>{
    if(path.endsWith('/confirm')){assert.deepEqual(Object.keys(body),[]);await new Promise(resolve=>releaseConfirm=resolve);return {proposal:{...proposal,status:'saved'},mutations:[savedMutation(proposal.requestId,{operation:'flow_delete_store',label:'删除门店'})]};}
    return {enabled:true,available:true,model:'test-model'};
  }});
  click(document,'open');write(window,'删除测试门店');submit(window);await settle(()=>pending);
  pending.options.onEvent({type:'proposal',proposal});pending.options.onEvent({type:'delta',text:'请确认是否删除。'});
  assert.equal(document.querySelector('[data-flow-action="confirm-operation"]').disabled,true);
  assert.equal(document.querySelector('.flow-proposal script'),null);assert.equal(changes.length,0);
  assert.equal(document.querySelector('.flow-message-assistant').lastElementChild.className,'flow-proposals');
  assert.equal(requests.filter(row=>row.path.includes('/actions/')).length,0);
  pending.resolve();await settle(()=>!document.querySelector('[data-flow-action="confirm-operation"]').disabled);
  const button=document.querySelector('[data-flow-action="confirm-operation"]');button.focus();button.click();
  await settle(()=>releaseConfirm);click(document,'confirm-operation');assert.equal(requests.filter(row=>row.path.endsWith('/confirm')).length,1);
  assert.equal(document.querySelector('[data-flow-action="cancel-operation"]').disabled,true);
  releaseConfirm();await settle(()=>document.querySelector('.flow-mutation'));
  assert.equal(document.querySelector('[data-flow-action="confirm-operation"]'),null);
  assert.match(document.querySelector('.flow-proposal').textContent,/已确认并保存/);assert.equal(sent,1);assert.equal(changes.length,1);
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1)?.proposals?.[0]?.status==='saved');
});

test('cancelling a prepared operation leaves no saved receipt or business refresh',async t=>{
  let proposal;const changes=[];
  const {window,document}=fixture(t,{onBusinessChange:row=>changes.push(row),send:async payload=>{proposal=preparedProposal(payload.requestId);return {text:'请确认',proposals:[proposal]};},request:async path=>path.endsWith('/cancel')?{proposal:{...proposal,status:'cancelled'},mutations:[]}:{enabled:true,available:true}});
  click(document,'open');write(window,'删除门店');submit(window);
  await settle(()=>document.querySelector('[data-flow-action="cancel-operation"]')?.disabled===false);click(document,'cancel-operation');
  await settle(()=>document.querySelector('.flow-proposal')?.textContent.includes('已取消'));
  assert.equal(document.querySelector('.flow-mutation'),null);assert.equal(changes.length,0);
});

test('lost confirmation responses recover saved receipts without asking the model to repeat the operation',async t=>{
  let proposal,confirmCount=0;const changes=[];
  const {window,document}=fixture(t,{onBusinessChange:row=>changes.push(row),send:async payload=>{proposal=preparedProposal(payload.requestId);return {text:'请确认',proposals:[proposal]};},request:async path=>{
    if(path.endsWith('/confirm')){confirmCount++;throw new Error('连接中断');}
    if(path.startsWith('/actions/'))return {proposals:[{...proposal,status:'saved'}],mutations:[savedMutation(proposal.requestId)]};
    return {enabled:true,available:true};
  }});
  click(document,'open');write(window,'删除门店');submit(window);await settle(()=>document.querySelector('[data-flow-action="confirm-operation"]')?.disabled===false);click(document,'confirm-operation');
  await settle(()=>document.querySelector('.flow-mutation'));assert.equal(confirmCount,1);assert.equal(changes.length,1);assert.equal(document.querySelector('[data-flow-action="confirm-operation"]'),null);
});

test('reopening replaces archived card contents and status with the authoritative server proposal',async t=>{
  const requestId=crypto.randomUUID(),proposal=preparedProposal(requestId),service=conversationService([{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,title:'待确认',messages:[{role:'user',text:'删除门店',requestId},{role:'assistant',text:'请确认',proposals:[{...proposal,recordLabel:'过期的本地内容'}]}],draft:''}]);
  const {document}=fixture(t,{conversations:service,request:async path=>path.startsWith('/actions/')?{proposals:[{...proposal,recordLabel:'最新核对的门店',status:'cancelled'}],mutations:[]}:{enabled:true,available:true}});
  click(document,'open');click(document,'history');await settle(()=>document.querySelector('.flow-history-select'));document.querySelector('.flow-history-select').click();
  await settle(()=>document.querySelector('.flow-proposal')?.textContent.includes('最新核对的门店'));
  assert.doesNotMatch(document.querySelector('.flow-proposal').textContent,/过期的本地内容/);assert.equal(document.querySelector('[data-flow-action="confirm-operation"]'),null);
});

test('a stale confirmation shows the conflict and retains a cancellable card',async t=>{
  let proposal;
  const {window,document}=fixture(t,{send:async payload=>{proposal=preparedProposal(payload.requestId);return {text:'请确认',proposals:[proposal]};},request:async path=>{
    if(path.endsWith('/confirm'))throw new Error('业务资料已更新，请重新发送请求。');
    if(path.startsWith('/actions/'))return {proposals:[proposal],mutations:[]};return {enabled:true,available:true};
  }});
  click(document,'open');write(window,'删除门店');submit(window);await settle(()=>document.querySelector('[data-flow-action="confirm-operation"]')?.disabled===false);click(document,'confirm-operation');
  await settle(()=>document.querySelector('.flow-proposal-error'));assert.match(document.querySelector('.flow-proposal-error').textContent,/业务资料已更新/);assert.equal(document.querySelector('[data-flow-action="cancel-operation"]').disabled,false);
});

test('saved write receipts survive a failed answer, retry reuses its request ID, and sources stay safe',async t=>{
  const calls=[],changes=[],service=conversationService();let fail=true;
  const {window,document}=fixture(t,{conversations:service,onBusinessChange:row=>changes.push(row),send:async(payload,{onEvent})=>{
    calls.push(payload);
    const mutation=savedMutation(payload.requestId,{recordLabel:'<img src=x onerror=alert(1)>测试门店'});
    onEvent({type:'mutation',mutation});
    onEvent({type:'mutation',mutation:{...mutation,id:'bad',href:'javascript:alert(1)'}});
    if(fail)throw new Error('回答连接中断');
    onEvent({type:'done',text:'已核对原操作',mutations:[{...mutation,replayed:true}]});
  }});
  click(document,'open');write(window,'请新增门店');submit(window);
  await settle(()=>document.querySelector('[data-flow-action="retry"]'));
  assert.equal(document.querySelectorAll('.flow-mutation').length,1);
  assert.equal(document.querySelector('.flow-mutation img'),null);
  assert.match(document.querySelector('.flow-mutation').textContent,/已保存/);
  assert.equal(changes.length,1);
  fail=false;click(document,'retry');
  await settle(()=>calls.length===2&&document.querySelector('.flow-conversation').getAttribute('aria-busy')==='false');
  assert.equal(calls[0].requestId,calls[1].requestId);
  assert.equal(document.querySelectorAll('.flow-mutation').length,1);
  assert.equal(changes.length,1);
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1)?.text==='已核对原操作');
  const stored=[...service.rows.values()][0];
  assert.equal(stored.messages[0].requestId,calls[0].requestId);
  assert.equal(stored.messages[1].mutations[0].recordId,'s-test');
});

test('a stopped write keeps its receipt and can be resumed without making a fresh operation ID',async t=>{
  let pending;const requests=[];
  const {window,document}=fixture(t,{send:async(payload,options)=>{
    requests.push(payload);
    options.onEvent({type:'mutation',mutation:savedMutation(payload.requestId)});
    if(requests.length>1)return {text:'已核对保存结果'};
    pending=options;
    await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new window.DOMException('Aborted','AbortError')),{once:true}));
  }});
  click(document,'open');write(window,'新增门店');submit(window);await settle(()=>pending);
  document.querySelector('.flow-send').click();
  await settle(()=>document.querySelector('.flow-message-note'));
  assert.match(document.querySelector('.flow-message-note').textContent,/已保存的操作仍然有效/);
  click(document,'retry');await settle(()=>requests.length===2);
  assert.equal(requests[0].requestId,requests[1].requestId);
  assert.equal(document.querySelectorAll('.flow-mutation').length,1);
});

test('reopening a saved conversation retains completed write receipts without triggering another mutation',async t=>{
  const id='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
  const service=conversationService([{id,version:1,title:'历史操作',updatedAt:'2026-10-22',messages:[{role:'user',text:'新增门店',requestId},{role:'assistant',text:'已保存',mutations:[savedMutation(requestId)]}],draft:''}]);
  let writes=0,refreshes=0;
  const {document,ui}=fixture(t,{conversations:service,onBusinessChange:()=>refreshes++,send:async()=>writes++});
  ui.open();click(document,'history');await settle(()=>document.querySelector('[data-flow-action="select-conversation"]'));
  click(document,'select-conversation');await settle(()=>document.querySelector('.flow-mutation'));
  assert.match(document.querySelector('.flow-mutation').textContent,/测试门店/);assert.equal(writes,0);assert.equal(refreshes,0);
});

test('closing the browser during a write leaves a resumable message with the original request ID',async t=>{
  const id='00000000-0000-4000-8000-000000000003',requestId='00000000-0000-4000-8000-000000000004';
  const service=conversationService([{id,version:1,title:'中断的操作',updatedAt:'2026-10-22',messages:[{role:'user',text:'新增门店',requestId},{role:'assistant',text:'',pending:true}],draft:''}]);
  let payload;
  const {document,ui}=fixture(t,{conversations:service,send:async(value,{onEvent})=>{payload=value;onEvent({type:'mutation',mutation:savedMutation(value.requestId,{replayed:true})});return {text:'已核对原先的门店'};}});
  ui.open();click(document,'history');await settle(()=>document.querySelector('[data-flow-action="select-conversation"]'));
  click(document,'select-conversation');await settle(()=>document.querySelector('[data-flow-action="retry"]'));
  assert.match(document.querySelector('.flow-error').textContent,/上次处理已中断/);
  click(document,'retry');await settle(()=>payload&&document.querySelector('.flow-conversation').getAttribute('aria-busy')==='false');
  assert.equal(payload.requestId,requestId);assert.equal(document.querySelectorAll('.flow-mutation').length,1);
  assert.equal([...service.rows.values()][0].messages[1].pending,undefined);
});

test('a write request is not sent until its retry ID has been saved with the conversation',async t=>{
  const service=conversationService(),original=service.request;let failing=true,calls=0,requestId;
  service.request=async(route,body)=>{
    if(route==='/conversations'&&body){requestId ||= body.messages[0].requestId;if(failing)throw new Error('保存连接中断');}
    return original(route,body);
  };
  const {window,document}=fixture(t,{conversations:service,send:async payload=>{calls++;assert.equal(payload.requestId,requestId);return {text:'已处理'};}});
  click(document,'open');write(window,'新增门店');submit(window);
  await settle(()=>document.querySelector('.flow-error'));
  assert.match(document.querySelector('.flow-error').textContent,/操作尚未执行/);assert.equal(calls,0);
  failing=false;click(document,'retry');await settle(()=>calls===1);
});

test('Flow renders untrusted model text as escaped content and only permits business citations',()=>{
  const html = formatFlowText('**已送达**\n<img src=x onerror=alert(1)>\n- `订单`');
  assert.match(html,/<strong>已送达<\/strong>/);
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/&lt;img/);
  assert.equal(safeFlowHref('/?page=orders&order=ORD-1'),'/?page=orders&order=ORD-1');
  for(const url of ['javascript:alert(1)','https://example.com','//example.com/?page=orders','/?login=platform','/?page=orders&token=secret','/?page=team'])assert.equal(safeFlowHref(url),null);
});

test('portals without Flow have no DOM, launcher, listeners or service requests',t=>{
  const {document,ui,requests}=fixture(t,{enabled:false});
  ui.open();ui.sync();
  assert.equal(ui.launcher(),'');
  assert.equal(document.querySelector('#flow-root'),null);
  assert.deepEqual(requests,[]);
});

test('Flow keeps its draft and conversation mount through application redraw and close/reopen',async t=>{
  const {window,document,ui}=fixture(t);
  click(document,'open');
  await nextTurn();write(window,'查找今天的订单');
  const panel=document.querySelector('#flow-panel');
  document.getElementById('app').innerHTML=ui.launcher();ui.sync();
  assert.equal(document.querySelector('#flow-panel'),panel);
  assert.equal(document.querySelector('#flow-message').value,'查找今天的订单');
  click(document,'close');assert.equal(panel.hidden,true);
  click(document,'open');assert.equal(document.querySelector('#flow-message').value,'查找今天的订单');
  assert.equal(document.querySelector('[data-flow-action="open"]').getAttribute('aria-expanded'),'true');
});

test('streaming Flow keeps tools, sources, safe text and context without posting business snapshots',async t=>{
  let payload;
  const {window,document}=fixture(t,{send:async(value,{onEvent})=>{
    payload=value;
    onEvent({type:'tool_result',name:'flow_search',label:'查找订单'});
    onEvent({type:'delta',text:'找到了 **2 单**。\n'});
    onEvent({type:'delta',text:'<script>globalThis.pwned=true</script>'});
    onEvent({type:'sources',sources:[{label:'订单 ORD-1',href:'/?page=orders&order=ORD-1'},{label:'坏链接',href:'https://evil.test'}]});
  }});
  click(document,'open');write(window,'今天有什么订单？');submit(window);
  await settle(()=>document.querySelector('.flow-conversation').getAttribute('aria-busy')==='false');
  assert.equal(payload.message,'今天有什么订单？');
  assert.deepEqual(Object.keys(payload).sort(),['context','conversationId','history','message','requestId']);
  assert.match(payload.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(payload.context.page,'overview');
  assert.equal(payload.state,undefined);
  assert.equal(document.querySelectorAll('.flow-message-user').length,1);
  assert.equal(document.querySelector('.flow-answer strong').textContent,'2 单');
  assert.equal(document.querySelector('.flow-answer script'),null);
  assert.equal(window.pwned,undefined);
  assert.equal(document.querySelectorAll('.flow-source-link').length,1);
  assert.match(document.querySelector('.flow-tool-trace').textContent,/查找订单/);
});

test('starting a new conversation aborts the old request and stale deltas cannot enter the new one',async t=>{
  let first,second;
  const {window,document}=fixture(t,{send:(payload,options)=>new Promise((resolve,reject)=>{
    if(!first)first={payload,options,resolve,reject};else second={payload,options,resolve,reject};
  })});
  click(document,'open');write(window,'旧问题');submit(window);
  await settle(()=>first);
  click(document,'new');assert.equal(first.options.signal.aborted,true);
  await settle(()=>document.querySelector('.flow-conversation').textContent.includes('从这里开始'));
  write(window,'新问题');submit(window);await settle(()=>second);
  first.options.onEvent({type:'delta',text:'旧数据'});first.resolve();await nextTurn();
  assert.equal(document.querySelector('.flow-conversation').getAttribute('aria-busy'),'true');
  assert.doesNotMatch(document.querySelector('.flow-conversation').textContent,/旧数据|旧问题/);
  second.options.onEvent({type:'delta',text:'新回答'});second.resolve();
  await settle(()=>document.querySelector('.flow-conversation').getAttribute('aria-busy')==='false');
  assert.match(document.querySelector('.flow-answer').textContent,/新回答/);
});

test('Flow starts with a disabled visible launcher until the server confirms access',async t=>{
  let resolveStatus;
  const {document,ui,requests}=fixture(t,{initialStatus:null,request:()=>new Promise(resolve=>{resolveStatus=resolve;})});
  const launcher=document.querySelector('[data-flow-action="open"]');
  assert.equal(launcher.disabled,true);
  assert.equal(launcher.getAttribute('aria-label'),'正在确认 Flow 状态');
  assert.ok(launcher.querySelector('.flow-mark'));
  assert.equal(document.querySelector('#flow-panel').hidden,true);
  launcher.click();assert.equal(document.querySelector('#flow-panel').hidden,true);
  ui.open();
  assert.deepEqual(requests.map(row=>row.path),['/status']);
  resolveStatus({enabled:true,available:true,connected:true,model:'assigned-model'});
  await settle(()=>document.querySelector('#flow-panel').hidden===false);
  assert.equal(launcher.disabled,false);
  assert.equal(launcher.getAttribute('aria-expanded'),'true');
  assert.match(document.querySelector('.flow-status').textContent,/assigned-model/);
});

test('platform-disabled Flow stays visible but cannot open or request conversation data',async t=>{
  let status={enabled:false,configured:false,available:false,managed:true};
  const {document,ui,requests}=fixture(t,{initialStatus:status,request:async()=>status});
  await ui.refreshStatus();
  const launcher=document.querySelector('[data-flow-action="open"]');
  assert.equal(launcher.disabled,true);
  assert.equal(launcher.classList.contains('is-unavailable'),true);
  assert.equal(launcher.title,'Flow 已停用');
  assert.ok(launcher.querySelector('.flow-mark'));
  ui.open();launcher.click();
  assert.equal(document.querySelector('#flow-panel').hidden,true);
  assert.ok(requests.every(row=>row.path==='/status'));
  status={enabled:true,available:true,connected:true,model:'assigned-model',managed:true};
  await ui.refreshStatus();
  assert.equal(launcher.disabled,false);
  assert.equal(launcher.classList.contains('is-unavailable'),false);
  launcher.click();
  assert.equal(document.querySelector('#flow-panel').hidden,false);
});

test('NDJSON split across UTF-8 and line boundaries preserves a partial answer and reports stream errors',async t=>{
  const {window,document}=fixture(t);
  const encoded=new TextEncoder().encode([
    {type:'status',message:'正在查询'},
    {type:'delta',text:'已查到 2 单。'},
    {type:'error',message:'上游连接中断'},
  ].map(event=>JSON.stringify(event)).join('\n')+'\n');
  window.fetch=async()=>({ok:true,headers:new Headers({'content-type':'application/x-ndjson'}),body:new ReadableStream({start(controller){
    for(let offset=0;offset<encoded.length;offset+=7)controller.enqueue(encoded.slice(offset,offset+7));
    controller.close();
  }})});
  click(document,'open');write(window,'检查订单');submit(window);
  await settle(()=>document.querySelector('.flow-error'));
  assert.equal(document.querySelector('.flow-answer').textContent,'已查到 2 单。');
  assert.match(document.querySelector('.flow-error').textContent,/上游连接中断/);
  assert.equal(document.querySelector('.flow-message-note'),null);
  assert.equal(document.querySelector('.flow-conversation').getAttribute('aria-busy'),'false');
});

test('stopping the NDJSON request aborts HTTP and keeps partial text explicitly marked stopped',async t=>{
  const {window,document}=fixture(t);
  let requestSignal;
  window.fetch=async(path,options)=>{
    requestSignal=options.signal;
    return {ok:true,headers:new Headers({'content-type':'application/x-ndjson'}),body:new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'delta',text:'正在核对这批订单。'})+'\n'));
      requestSignal.addEventListener('abort',()=>controller.error(new window.DOMException('Stopped','AbortError')),{once:true});
    }})};
  };
  click(document,'open');write(window,'检查订单');submit(window);
  await settle(()=>document.querySelector('.flow-answer').textContent.includes('正在核对这批订单'));
  assert.equal(document.querySelector('.flow-send').getAttribute('aria-label'),'停止生成');
  submit(window);
  await settle(()=>document.querySelector('.flow-message-note'));
  assert.equal(requestSignal.aborted,true);
  assert.equal(document.querySelector('.flow-message-note').textContent,'已停止');
  assert.match(document.querySelector('.flow-answer').textContent,/正在核对这批订单/);
  assert.equal(document.querySelector('.flow-error'),null);
});

test('IME composition cannot accidentally send a chat prompt',async t=>{
  let sent=0;
  const {window,document}=fixture(t,{send:async()=>{sent++;return {text:'回答'};}});
  click(document,'open');write(window,'正在输入中文');
  document.querySelector('#flow-message').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
  await nextTurn();
  assert.equal(sent,0);
  assert.equal(document.querySelector('#flow-message').value,'正在输入中文');
});

test('the assigned model is display-only and source navigation preserves the open conversation',async t=>{
  let payload,navigated;
  const {window,document,requests}=fixture(t,{
    request:async()=>({enabled:true,available:true,connected:true,model:'model-a',modelName:'Model A',managed:true}),
    onNavigate:url=>{navigated=url;},
    send:async(value,{onEvent})=>{payload=value;onEvent({type:'delta',text:'已找到订单'});onEvent({type:'sources',sources:[{title:'订单1',url:'/?page=orders&order=ORDER-1'}]});},
  });
  click(document,'open');await settle(()=>document.querySelector('.flow-status').textContent==='Model A');
  assert.equal(document.querySelector('#flow-model'),null);
  assert.equal(document.querySelector('.flow-status').closest('button'),null);
  write(window,'查找订单');submit(window);
  await settle(()=>document.querySelector('.flow-source-link'));
  assert.equal(Object.hasOwn(payload,'model'),false);
  assert.ok(requests.every(row=>row.path==='/status'||row.path.startsWith('/conversations')));
  const panel=document.querySelector('#flow-panel');
  document.querySelector('.flow-source-link').click();
  assert.equal(navigated,'/?page=orders&order=ORDER-1');
  assert.equal(document.querySelector('#flow-panel'),panel);
  assert.equal(panel.hidden,false);
});

test('neither management owners nor members have credential or model configuration controls',async t=>{
  for(const accountRole of ['owner','member']){
    const {window,document,ui,requests}=fixture(t,{principal:{role:'admin',accountRole}});
    window.Storage.prototype.setItem=()=>assert.fail('Flow must not write credentials or configuration to browser storage');
    ui.open();await ui.refreshStatus();
    assert.equal(document.querySelector('#flow-token-login,#flow-github-token,#flow-model,.flow-connection,.flow-provider-tabs,[data-flow-action="connection"],[data-flow-action="connect"],[data-flow-action="change-account"]'),null);
    assert.equal(document.querySelector('input[type="password"],select'),null);
    assert.doesNotMatch(document.querySelector('#flow-root').textContent,/GitHub|API Key|连接模型|更换账号/);
    assert.ok(requests.every(row=>row.path==='/status'||row.path.startsWith('/conversations')));
    assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  }
});

test('saved conversations and drafts can be reopened after a fresh UI mount without browser storage',async t=>{
  const service=conversationService();
  const first=fixture(t,{conversations:service,send:async()=>({text:'这是一条已保存的回答。'})});
  first.window.Storage.prototype.setItem=()=>assert.fail('chat history must not use browser storage');
  first.ui.open();write(first.window,'本月有多少订单？');submit(first.window);
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1).text==='这是一条已保存的回答。');
  write(first.window,'这个草稿暂时不发');first.ui.close();
  await settle(()=>[...service.rows.values()][0]?.draft==='这个草稿暂时不发');
  const second=fixture(t,{conversations:service});second.ui.open();click(second.document,'history');
  await settle(()=>second.document.querySelector('.flow-history-select'));
  assert.match(second.document.querySelector('.flow-history-select').textContent,/本月有多少订单/);
  second.document.querySelector('.flow-history-select').click();
  await settle(()=>second.document.querySelector('#flow-message').value==='这个草稿暂时不发');
  assert.match(second.document.querySelector('.flow-answer').textContent,/已保存的回答/);
  assert.equal(second.document.querySelector('#flow-history').hidden,true);
  assert.equal(second.window.localStorage.length,0);
});

test('conversation deletion stops an active answer, stale events are ignored, and undo restores the list',async t=>{
  let pending;
  const {window,document,service}=fixture(t,{send:(payload,options)=>new Promise(resolve=>{pending={payload,options,resolve};})});
  click(document,'open');write(window,'稍后会删除的问题');submit(window);await settle(()=>pending);
  pending.options.onEvent({type:'delta',text:'正在回答'});
  click(document,'history');await settle(()=>document.querySelector('.flow-delete-conversation'));
  document.querySelector('.flow-delete-conversation').click();
  await settle(()=>[...service.rows.values()][0]?.deleted===true);
  assert.equal(pending.options.signal.aborted,true);
  pending.options.onEvent({type:'delta',text:'不应回来的内容'});pending.resolve();await nextTurn();
  assert.doesNotMatch(document.querySelector('.flow-conversation').textContent,/不应回来的内容|稍后会删除的问题/);
  assert.equal(document.querySelector('.flow-history-select'),null);
  assert.match(document.querySelector('.flow-history-feedback').textContent,/已删除/);
  click(document,'undo-delete');
  await settle(()=>document.querySelector('.flow-history-select'));
  assert.equal([...service.rows.values()][0].deleted,false);
  assert.equal(document.querySelector('.flow-history-feedback').hidden,true);
});

test('failed saves keep the transcript and stop switching until the data can be saved',async t=>{
  const service=conversationService();let failing=false;
  const {window,document}=fixture(t,{conversations:{...service,request:async(path,body)=>{
    if(failing && path==='/conversations' && body)throw new Error('临时断开');
    return service.request(path,body);
  }},send:async()=>({text:'需要保留的回答'})});
  click(document,'open');write(window,'需要保留的问题');submit(window);
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1).text==='需要保留的回答');
  failing=true;write(window,'未保存的草稿');click(document,'new');
  await settle(()=>document.querySelector('.flow-save-status').textContent.includes('未能保存'));
  assert.match(document.querySelector('.flow-conversation').textContent,/需要保留的回答/);
  assert.equal(document.querySelector('#flow-message').value,'未保存的草稿');
  failing=false;click(document,'save-again');
  await settle(()=>document.querySelector('.flow-save-status').textContent==='');
  click(document,'new');await settle(()=>document.querySelector('.flow-empty'));
  assert.equal([...service.rows.values()][0].draft,'未保存的草稿');
});

test('concurrent drafts serialize saves with fresh versions and do not clobber a newer draft',async t=>{
  const service=conversationService();let release;
  const {window,document,ui}=fixture(t,{conversations:{...service,request:async(path,body)=>{
    if(path==='/conversations' && body && !release)await new Promise(resolve=>{release=resolve;});
    return service.request(path,body);
  }}});
  ui.open();write(window,'第一份草稿');ui.close();await settle(()=>release);
  ui.open();write(window,'后写入的完整草稿');ui.close();release();
  await settle(()=>[...service.rows.values()][0]?.version===2);
  assert.equal(service.rows.size,1);
  assert.equal([...service.rows.values()][0].draft,'后写入的完整草稿');
  assert.equal(document.querySelector('.flow-save-status').textContent,'');
});

test('Flow renders deduplicated safe images, escapes labels, and refuses external or executable image URLs',async t=>{
  const id='12345678-1234-4000-8000-123456789012', url=`/api/flow/artifacts/${id}`;
  const {window,document}=fixture(t,{send:async(payload,{onEvent})=>{
    onEvent({type:'image',image:{id,url,alt:'<script>image attack</script>'}});
    return {text:`库存图\n![库存统计](${url})\n![危险](https://evil.test/pixel.png)`,images:[{id,url,alt:'重复图'},{url:'data:image/svg+xml;base64,AAAA'},{url:'/public/product-images/32.jpg',alt:'商品图片'}]};
  }});
  click(document,'open');write(window,'出一张库存图');submit(window);
  await settle(()=>document.querySelectorAll('[data-flow-image]').length===2);
  assert.equal(document.querySelector('[data-flow-image]').getAttribute('src'),url);
  assert.equal(document.querySelector('.flow-answer script'),null);
  assert.doesNotMatch(document.querySelector('.flow-answer').innerHTML,/src="(?:https:|data:|javascript:)/);
  const preview=document.querySelector('[data-flow-image]');preview.dispatchEvent(new window.Event('load'));
  assert.equal(preview.closest('.flow-image').classList.contains('is-loaded'),true);
  preview.dispatchEvent(new window.Event('error'));
  assert.match(preview.closest('.flow-image').textContent,/暂时无法加载/);
  for(const unsafe of ['https://example.com/x.jpg','//evil.test/x.png','javascript:alert(1)','/api/flow/artifacts/../auth','/api/flow/artifacts/'+id+'?token=x','/public/product-images/12.svg','/public/product-images/%31.jpg'])assert.equal(safeFlowImageHref(unsafe),null);
  assert.equal(safeFlowImageHref('/public/product-images/12.jpg'),'/public/product-images/12.jpg');
});

test('a platform disable aborts generation and hides Flow while preserving its transcript and draft',async t=>{
  let pending,status={enabled:true,available:true,connected:true,model:'assigned-model',managed:true};
  const {window,document,ui,requests,service}=fixture(t,{request:async()=>status,send:(payload,options)=>new Promise(resolve=>{pending={options,resolve};})});
  click(document,'open');write(window,'这段对话需要保留');submit(window);await settle(()=>pending);
  pending.options.onEvent({type:'delta',text:'已经核对部分订单。'});
  write(window,'下一条还没发送的草稿');
  status={enabled:false,configured:true,available:false,managed:true};
  await ui.refreshStatus();
  const savedBeforeStale=JSON.stringify([...service.rows.values()]);
  const requestCount=requests.length;
  assert.equal(pending.options.signal.aborted,true);
  assert.equal(document.querySelector('#flow-panel').hidden,true);
  assert.equal(document.querySelector('[data-flow-action="open"]').disabled,true);
  assert.equal(document.querySelector('.flow-conversation').getAttribute('aria-busy'),'false');
  assert.equal(document.querySelector('.flow-message-note').textContent,'已停止');
  assert.equal(document.querySelector('#flow-message').value,'下一条还没发送的草稿');
  assert.match(document.querySelector('.flow-conversation').textContent,/这段对话需要保留.*已经核对部分订单/s);
  pending.options.onEvent({type:'delta',text:'disabled-stale-sentinel'});pending.resolve();await nextTurn();
  assert.doesNotMatch(document.querySelector('#flow-root').textContent,/disabled-stale-sentinel/);
  assert.equal(JSON.stringify([...service.rows.values()]),savedBeforeStale);
  assert.equal(requests.length,requestCount);
  status={enabled:true,available:true,connected:true,model:'assigned-model',managed:true};
  await ui.refreshStatus();click(document,'open');
  assert.equal(document.querySelector('#flow-panel').hidden,false);
  assert.equal(document.querySelector('#flow-message').value,'下一条还没发送的草稿');
  assert.match(document.querySelector('.flow-conversation').textContent,/已经核对部分订单/);
  click(document,'close');
  await settle(()=>[...service.rows.values()][0]?.draft==='下一条还没发送的草稿');
});

test('disabling Flow cancels a pending autosave but keeps the unsent draft for reenable',async t=>{
  let status={enabled:true,available:true,connected:true,model:'assigned-model'};
  const {window,document,ui,requests}=fixture(t,{request:async()=>status});
  click(document,'open');await ui.refreshStatus();
  write(window,'尚未自动保存的草稿');
  status={enabled:false,available:false,managed:true};
  await ui.refreshStatus();
  const before=requests.length;
  await delay(950);
  assert.equal(requests.length,before,'revoking Flow access must cancel queued draft writes');
  status={enabled:true,available:true,connected:true,model:'assigned-model'};
  await ui.refreshStatus();click(document,'open');
  assert.equal(document.querySelector('#flow-message').value,'尚未自动保存的草稿');
});

test('stop while the initial save is pending preserves a stopped message and never calls the model',async t=>{
  const service=conversationService();let release,sent=0;
  const {window,document}=fixture(t,{conversations:{request:async(path,body)=>{
    if(path==='/conversations'&&body&&!release)await new Promise(resolve=>{release=resolve;});
    return service.request(path,body);
  }},send:async()=>{sent++;return {text:'should not generate'};}});
  click(document,'open');write(window,'等待保存时停止');submit(window);await settle(()=>release);
  submit(window);release();await settle(()=>document.querySelector('.flow-message-note'));
  assert.equal(document.querySelector('.flow-message-note').textContent,'已停止');
  assert.equal(document.querySelector('.flow-thinking'),null);
  assert.equal(sent,0);
});


test('temporary status failures preserve access, transcript and draft and can be retried',async t=>{
  let failing=false;
  const {window,document,ui,requests}=fixture(t,{request:async()=>{
    if(failing)throw new Error('temporary network failure');
    return {enabled:true,available:true,connected:true,model:'assigned-model',managed:true};
  },send:async()=>({text:'已保存的回答'})});
  click(document,'open');write(window,'需要保留的问题');submit(window);
  await settle(()=>document.querySelector('.flow-answer')?.textContent==='已保存的回答');
  await ui.refreshStatus();write(window,'保留这份草稿');failing=true;
  await ui.refreshStatus();
  assert.equal(document.querySelector('[data-flow-action="open"]').disabled,false);
  assert.equal(document.querySelector('#flow-panel').hidden,false);
  assert.equal(document.querySelector('#flow-message').value,'保留这份草稿');
  assert.match(document.querySelector('.flow-answer').textContent,/已保存的回答/);
  assert.match(document.querySelector('.flow-access-note').textContent,/状态暂时无法更新/);
  assert.equal(document.querySelector('.flow-access-note').hidden,false);
  failing=false;click(document,'refresh-status');
  await settle(()=>document.querySelector('.flow-access-note').hidden);
  assert.ok(requests.every(row=>row.path==='/status'||row.path.startsWith('/conversations')));
});

test('assigned-model unavailability blocks sending without discarding the draft or offering a model picker',async t=>{
  let available=true,sent=0;
  const {window,document,ui,requests}=fixture(t,{request:async()=>({enabled:true,available,connected:available,model:'assigned-model',managed:true,message:'当前配置的模型暂不可用。'}),send:async()=>{sent++;return {text:'回答'};}});
  click(document,'open');await ui.refreshStatus();write(window,'保留这份草稿');
  available=false;await ui.refreshStatus();submit(window);await nextTurn();
  assert.equal(sent,0);
  assert.equal(document.querySelector('.flow-send').disabled,true);
  assert.equal(document.querySelector('#flow-message').value,'保留这份草稿');
  assert.equal(document.querySelector('#flow-model'),null);
  assert.match(document.querySelector('.flow-access-note').textContent,/模型暂不可用/);
  available=true;await ui.refreshStatus();submit(window);await settle(()=>sent===1);
  assert.ok(requests.every(row=>row.path==='/status'||row.path.startsWith('/conversations')));
});

test('returning focus refreshes platform entitlement and a failed initial status never enables Flow',async t=>{
  let status={enabled:true,available:true,connected:true,model:'assigned-model'};
  const first=fixture(t,{request:async()=>status});
  await first.ui.refreshStatus();
  status={enabled:false,available:false,managed:true};
  first.window.dispatchEvent(new first.window.Event('focus'));
  await settle(()=>first.document.querySelector('[data-flow-action="open"]').disabled);
  assert.equal(first.document.querySelector('#flow-panel').hidden,true);
  const second=fixture(t,{initialStatus:null,request:async()=>{throw new Error('offline');}});
  await second.ui.refreshStatus();
  assert.equal(second.document.querySelector('[data-flow-action="open"]').disabled,true);
  second.ui.open();await second.ui.refreshStatus();
  assert.equal(second.document.querySelector('#flow-panel').hidden,true);
  assert.ok(second.requests.every(row=>row.path==='/status'));
});

test('public progress shows a flowing bar and retained steps while model reasoning never appears or persists',async t=>{
  let pending;
  const {window,document,service}=fixture(t,{send:(payload,options)=>new Promise(resolve=>{pending={options,resolve};})});
  click(document,'open');write(window,'检查库存');submit(window);await settle(()=>pending);
  pending.options.onEvent({type:'progress',id:'prepare',label:'正在理解问题',status:'done'});
  pending.options.onEvent({type:'progress',id:'tool-1',label:'核对库存和报价',status:'running'});
  pending.options.onEvent({type:'reasoning',text:'private-thought-sentinel'});
  pending.options.onEvent({type:'delta',phase:'analysis',text:'private-phase-sentinel'});
  pending.options.onEvent({type:'progress',id:'thought',label:'private-progress-sentinel',status:'running'});
  assert.ok(document.querySelector('.flow-generation-track'));
  assert.match(document.querySelector('.flow-generation-caption').textContent,/核对库存和报价/);
  const trace=document.querySelector('.flow-tool-trace');trace.open=true;trace.querySelector('summary').focus();
  pending.options.onEvent({type:'progress',id:'tool-1',label:'核对库存和报价',status:'done',detail:'已核对 12 个商品'});
  assert.equal(document.querySelector('.flow-tool-trace').open,true);
  assert.equal(document.activeElement.tagName,'SUMMARY');
  pending.options.onEvent({type:'delta',text:'库存已核对。'});pending.resolve();
  await settle(()=>document.querySelector('.flow-conversation').getAttribute('aria-busy')==='false');
  assert.equal(document.querySelector('.flow-generation-track'),null);
  assert.match(document.querySelector('.flow-tool-trace').textContent,/已完成 2 步.*已核对 12 个商品/);
  assert.doesNotMatch(document.querySelector('#flow-root').textContent,/private-/);
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1)?.steps?.length===2);
  assert.doesNotMatch(JSON.stringify([...service.rows.values()]),/private-/);
});

test('stopping generation removes the animated bar and marks unfinished public steps as stopped',async t=>{
  let pending;
  const {window,document,service}=fixture(t,{send:(payload,options)=>new Promise(resolve=>{pending={options,resolve};})});
  click(document,'open');write(window,'检查订单');submit(window);await settle(()=>pending);
  pending.options.onEvent({type:'progress',id:'model',label:'正在整理回答',status:'running'});
  submit(window);await settle(()=>document.querySelector('.flow-message-note'));
  assert.equal(document.querySelector('.flow-generation-track'),null);
  assert.equal(document.querySelector('.flow-tool-trace .is-stopped')?.textContent,'正在整理回答');
  await settle(()=>[...service.rows.values()][0]?.messages.at(-1)?.steps?.[0]?.status==='stopped');
  pending.options.onEvent({type:'delta',text:'stale-answer'});pending.resolve();await nextTurn();
  assert.doesNotMatch(document.querySelector('#flow-root').textContent,/stale-answer/);
});

test('attachment upload persists before sending, keeps source chips in history, and retries the same attachment and request',async t=>{
  const id='11111111-1111-4111-8111-111111111111',attachment={id,name:'报价 <script>.pdf',kind:'pdf',pages:1};let finishRead,attempts=0;const payloads=[];
  const {window,document,service,requests}=fixture(t,{prepareAttachment:()=>new Promise(resolve=>finishRead=resolve),request:async(path,body)=>{
    if(path==='/attachments')return {attachment};
    if(path==='/attachments/'+id)return {attachment,parts:[{label:'第 1 页',text:'<script>not executable</script> 单价 1200'}]};
    return {enabled:true,available:true,model:'test-model'};
  },send:async payload=>{payloads.push(payload);if(++attempts===1)throw Error('临时网络中断');return {text:'已识别，待核对。'};}});
  click(document,'open');const input=document.querySelector('#flow-attachment-input');Object.defineProperty(input,'files',{value:[new window.File(['test'],'报价单.pdf',{type:'application/pdf'})],configurable:true});input.dispatchEvent(new window.Event('change',{bubbles:true}));
  await settle(()=>finishRead);assert.equal(document.querySelector('.flow-send').disabled,true);
  finishRead({id,name:attachment.name,kind:'pdf',bytes:4,parts:[{label:'第 1 页',text:'单价 1200'}]});
  await settle(()=>document.querySelector('[data-flow-action="view-attachment"]'));
  await settle(()=>[...service.rows.values()].some(row=>row.attachments?.[0]?.id===id));
  assert.equal(document.querySelector('.flow-draft-attachments script'),null);write(window,'更新销售报价，先给我核对');submit(window);
  await settle(()=>document.querySelector('[data-flow-action="retry"]'));assert.equal(payloads[0].attachments[0].id,id);assert.equal(payloads[0].attachments[0].parts,undefined);
  click(document,'retry');await settle(()=>payloads.length===2&&document.querySelector('.flow-answer').textContent.includes('已识别'));
  assert.equal(payloads[1].requestId,payloads[0].requestId);assert.deepEqual(payloads[1].attachments,payloads[0].attachments);
  assert.ok(document.querySelector('.flow-message-user [data-flow-action="view-attachment"]'));
  click(document,'view-attachment');await settle(()=>document.querySelector('.flow-attachment-pages pre'));assert.equal(document.querySelector('.flow-attachment-pages script'),null);assert.match(document.querySelector('.flow-attachment-pages pre').textContent,/not executable/);
  assert.equal(requests.filter(row=>row.path==='/attachments').length,1);
});
