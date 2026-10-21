import test from 'node:test';
import assert from 'node:assert/strict';
import {handleFlow} from './flow-service.js';

const ORIGIN='https://flow.example.test';
const owner={role:'admin',accountRole:'owner',tenantId:'tenant-a',userId:'owner-a'};
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><text x="40" y="50">订单流程</text></svg>';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
function req(route,body,headers={},extra={}) {
  return new Request(ORIGIN+'/api/flow'+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{Origin:ORIGIN,'Content-Type':'application/json',...headers},...extra});
}
function harness(options={}) {
  const calls={identity:[],policy:0,status:0,load:0,chat:0,save:0,token:0,start:0,poll:0,artifacts:0,leases:[],release:[],tools:[]},leases=new Map(),conversations=new Map(),artifacts=new Map(),pending=[];
  const key=p=>p.tenantId+'/'+p.userId;
  const store={
    async list(p){return {conversations:[...conversations.values()].filter(row=>row.actor===key(p)&&!row.deletedAt).map(({actor,...row})=>row),limit:100};},
    async get(p,id){const row=conversations.get(key(p)+'/'+id);if(!row)throw error('未找到对话。',404);if(row.deletedAt)throw error('对话已删除。',410);return structuredClone(row);},
    async save(p,body){const row={actor:key(p),id:body.id||crypto.randomUUID(),version:1,messages:body.messages||[],draft:body.draft||''};conversations.set(key(p)+'/'+row.id,row);return structuredClone(row);},
    async remove(p,id){const row=await this.get(p,id);row.deletedAt='now';conversations.set(key(p)+'/'+id,row);return {ok:true};},
    async restore(p,id){const row=conversations.get(key(p)+'/'+id);if(!row)throw error('未找到对话。',404);delete row.deletedAt;return structuredClone(row);},
    async createArtifact(p,input){calls.artifacts++;const id=crypto.randomUUID();artifacts.set(key(p)+'/'+id,input.svg);return {id,url:'/api/flow/artifacts/'+id,title:input.title,alt:input.title};},
    async getArtifact(p,id){const data=artifacts.get(key(p)+'/'+id);if(!data)throw error('未找到图片。',404);return data;},
    async acquireLease(scope,id,ttl){calls.leases.push({scope,id,ttl});if(leases.has(scope))return false;leases.set(scope,id);return true;},
    async releaseLease(scope,id){calls.release.push({scope,id});if(leases.get(scope)===id)leases.delete(scope);},
    ...options.store,
  };
  const provider={
    async status(p){calls.status++;assert.equal(p.role,'admin');return {provider:'copilot',connected:true,model:'model-a',models:[{id:'model-a',name:'Model A'}],fetchedAt:'2026-10-19T00:00:00Z',runtime:{token:'never-show'},githubToken:'never-show',client:{secret:'never-show'}};},
    async save(p,body){calls.save++;assert.equal(p.accountRole,'owner');assert.equal(body.provider,'copilot');},
    async loginToken(p,token){calls.token++;assert.equal(p.accountRole,'owner');assert.equal(token,'user-token-input');return {provider:'copilot',connected:true,login:'test-user',model:'model-a',models:[{id:'model-a'}],githubToken:token};},
    async startAuth(p){calls.start++;assert.equal(p.accountRole,'owner');return {authId:'auth-id',userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:123,pending:true,deviceCode:'private-device-secret'};},
    async pollAuth(p,id){calls.poll++;assert.equal(p.accountRole,'owner');assert.equal(id,'auth-id');return {pending:true};},
    async chat(args){calls.chat++;assert.equal(args.principal.tenantId,'tenant-a');await options.chat?.(args);if(!options.chat)args.onEvent({type:'message',text:'收到。'});},
    ...options.provider,
  };
  const identity=options.identity||async function(request,env){
    calls.identity.push(env);
    const role=request.headers.get('X-Test-Auth');
    if(role==='none')return null;
    if(role==='member')return {...owner,userId:'member-a',accountRole:'member'};
    if(role==='tenant-b')return {...owner,tenantId:'tenant-b'};
    if(role==='store-id')return {...owner,storeId:'store-a'};
    if(role==='no-user')return {...owner,userId:null};
    return role?{...owner,role}:owner;
  };
  const loadData=options.loadData||async function(db,p){
    calls.load++;assert.equal(p.role,'admin');
    return {index:{products:5,stores:2,orders:0,complete:true},tools:{
      async execute(name,args){calls.tools.push({name,args});return {total:5,categoryCount:2,source:{kind:'catalogue',recordId:'summary',label:'商品目录',href:'/?page=catalogue'}};},
    }};
  };
  let policy={enabled:true,model:'model-a',version:1};
  const getPolicy=options.getPolicy||(async()=>{calls.policy++;return {...policy};});
  const env={PUBLIC_ORIGIN:ORIGIN,LOCAL_TEST:'0',DB:{},...options.env};
  const ctx={waitUntil(promise){pending.push(promise);}};
  const handle=request=>handleFlow(request,env,ctx,{identity,store,provider,loadData,getPolicy});
  return {handle,calls,leases,provider,store,setPolicy:value=>policy={...policy,...value},settle:()=>Promise.all(pending)};
}
async function events(response){assert.equal(response.status,200);return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);}

test('Flow routes require current management identity, including reads and private artifacts',async()=>{
  const h=harness();assert.equal(await h.handle(new Request(ORIGIN+'/api/health')),null);
  for(const route of ['/status','/conversations','/artifacts/any-id'])for(const [auth,status] of [['none',401],['store',403],['platform',403],['store-id',403],['no-user',403]]) {
    assert.equal((await h.handle(req(route,undefined,{'X-Test-Auth':auth}))).status,status);
  }
  assert.equal(h.calls.status,0);assert.equal(h.calls.load,0);
});

test('mutations enforce configured origin, explicit local exception, and cross-site rejection',async()=>{
  const h=harness();
  for(const headers of [{Origin:'https://evil.test'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await h.handle(req('/conversations',{messages:[]},headers))).status,403);
  assert.equal((await h.handle(new Request('http://localhost:8787/api/flow/conversations',{method:'POST',body:'{}',headers:{Origin:'http://localhost:8787','Content-Type':'application/json'}}))).status,403);
  const local=harness({env:{LOCAL_TEST:'1'}});
  assert.equal((await local.handle(new Request('http://localhost:8787/api/flow/conversations',{method:'POST',body:'{}',headers:{Origin:'http://localhost:8787','Content-Type':'application/json'}}))).status,200);
});

test('management status is lightweight and exposes only platform-pinned readiness',async()=>{
  const h=harness();
  for(const route of ['/status','/status?refresh=1']) {
    const response=await h.handle(req(route));const data=await response.json();
    assert.equal(data.managed,true);assert.equal(data.model,'model-a');assert.equal(data.modelName,'Model A');assert.equal(data.connected,true);
    assert.equal(data.models,undefined);assert.equal(data.fetchedAt,undefined);assert.equal(data.index,undefined);
    assert.doesNotMatch(JSON.stringify(data),/never-show|githubToken|runtime|client|login|hasToken/);
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  }
  assert.equal(h.calls.status,2);assert.equal(h.calls.load,0);
  h.setPolicy({model:'absent'});assert.equal((await (await h.handle(req('/status'))).json()).available,false);
});

test('GitHub and model configuration are blocked for management owners and members alike',async()=>{
  const h=harness();
  for(const auth of ['member','admin'])for(const [route,body] of [['/auth/token',{token:'user-token-input'}],['/auth/start',{}],['/auth/poll',{authId:'auth-id'}],['/provider',{provider:'copilot',model:'model-a'}]]) {
    assert.equal((await h.handle(req(route,body,{'X-Test-Auth':auth}))).status,403);
    assert.equal((await h.handle(req(route,undefined,{'X-Test-Auth':auth}))).status,403);
  }
  assert.equal(h.calls.token+h.calls.start+h.calls.poll+h.calls.save,0);
});

test('platform disable gates every data route without provider calls and preserves history for re-enable',async()=>{
  const h=harness();
  const saved=await (await h.handle(req('/conversations',{messages:[],draft:'keep my draft'}))).json();
  h.setPolicy({enabled:false});
  const status=await (await h.handle(req('/status'))).json();assert.equal(status.enabled,false);assert.equal(status.managed,true);assert.equal(status.available,false);
  assert.equal(h.calls.status,0);assert.equal(h.calls.load,0);
  for(const [route,body] of [['/chat',{message:'查商品'}],['/conversations'],['/conversations/'+saved.conversation.id],['/conversations',{messages:[]}],['/artifacts/id'],['/conversations/'+saved.conversation.id+'/delete',{}],['/conversations/'+saved.conversation.id+'/restore',{}]])assert.equal((await h.handle(req(route,body))).status,403);
  assert.equal(h.calls.status,0);assert.equal(h.calls.chat,0);
  h.setPolicy({enabled:true});
  assert.equal((await (await h.handle(req('/conversations/'+saved.conversation.id))).json()).conversation.draft,'keep my draft');
});

test('chat cannot choose another model or replace the authorized tenant',async()=>{
  let selected;const h=harness({chat:async args=>{selected=args.model;assert.equal(args.principal.tenantId,'tenant-a');args.onEvent({type:'message',text:'ready'});}});
  assert.equal((await h.handle(req('/chat',{message:'开始',model:'model-b',tenantId:'tenant-b'}))).status,403);
  await events(await h.handle(req('/chat',{message:'开始',tenantId:'tenant-b'})));assert.equal(selected,'model-a');
  assert.equal(h.calls.chat,1);
});

test('disable during inference prevents the next visible answer and subsequent tools',async()=>{
  const h=harness({chat:async args=>{
    h.setPolicy({enabled:false});
    args.onEvent({type:'message',text:'must not be visible'});
    await args.runTool('flow_render_visual',{svg,title:'private'});
  }});
  const output=await events(await h.handle(req('/chat',{message:'开始'})));await h.settle();
  assert.equal(h.calls.artifacts,0);assert.ok(output.some(row=>row.type==='error'&&/停用/.test(row.message)));
  assert.doesNotMatch(JSON.stringify(output),/must not be visible/);assert.equal(h.leases.size,0);
});

test('disable before the final response rejects even a model that emits no intermediate events',async()=>{
  const h=harness({chat:async()=>{h.setPolicy({enabled:false});}});
  const output=await events(await h.handle(req('/chat',{message:'开始'})));
  assert.ok(output.some(row=>row.type==='error'));assert.ok(!output.some(row=>row.type==='done'));assert.equal(h.leases.size,0);
});

test('platform revocation cancels stalled inference without waiting for another model event',{timeout:3000},async()=>{
  let started,signal;const ready=new Promise(resolve=>started=resolve);
  const h=harness({chat:async args=>{signal=args.signal;started();await new Promise(()=>{});}});
  const response=await h.handle(req('/chat',{message:'开始'}));await ready;h.setPolicy({enabled:false});
  const output=await events(response);await h.settle();
  assert.ok(signal.aborted);assert.ok(output.some(row=>row.type==='error'&&/停用/.test(row.message)));assert.equal(h.leases.size,0);
});

test('conversation routes pass exact actor scope and retain delete/undo behavior',async()=>{
  const h=harness();const saved=await (await h.handle(req('/conversations',{messages:[{role:'user',text:'查商品'}],draft:'下一句'}))).json();const id=saved.conversation.id;
  assert.equal((await (await h.handle(req('/conversations'))).json()).conversations.length,1);
  assert.equal((await (await h.handle(req('/conversations/'+id))).json()).conversation.draft,'下一句');
  for(const auth of ['member','tenant-b'])assert.equal((await h.handle(req('/conversations/'+id,undefined,{'X-Test-Auth':auth}))).status,404);
  assert.equal((await h.handle(req('/conversations/'+id+'/delete',{}))).status,200);
  assert.equal((await h.handle(req('/conversations/'+id))).status,410);
  assert.equal((await h.handle(req('/conversations/'+id+'/restore',{}))).status,200);
});

test('stream emits real tool steps, sources and private images without reasoning or provider extras',async()=>{
  let sent;
  const h=harness({chat:async args=>{
    sent=args;
    args.onEvent({type:'reasoning',text:'hidden-reasoning'});args.onEvent({type:'status',text:'hidden-reasoning'});args.onEvent({type:'message',phase:'analysis',text:'hidden-reasoning'});
    await args.runTool('flow_catalogue_summary',{});
    await args.runTool('flow_render_visual',{svg,title:'订单流程'});
    args.onEvent({type:'delta',text:'已生成',githubToken:'never-show'});args.onEvent({type:'message',text:'图片已生成。',reasoning:'hidden-reasoning'});
  }});
  const response=await h.handle(req('/chat',{message:'画图',model:'model-a',history:[{role:'user',content:'前文',untrusted:'discard'}],context:{page:'overview',tenantId:'other'}}));
  assert.match(response.headers.get('Content-Type'),/ndjson/);
  const output=await events(response);await h.settle();
  assert.doesNotMatch(JSON.stringify(output),/hidden-reasoning|never-show|githubToken/);
  assert.equal(output.at(-1).type,'done');assert.ok(output.at(-1).steps.every(step=>step.status==='done'));
  assert.ok(output.some(row=>row.type==='progress'&&row.id==='tool-1'&&row.detail==='已汇总 5 个商品、2 个类别'));
  assert.ok(output.some(row=>row.type==='sources'&&row.sources[0]?.url==='/?page=catalogue'));
  assert.deepEqual(sent.history,[{role:'user',content:'前文'}]);assert.doesNotMatch(sent.systemPrompt,/"tenantId":"other"/);
  assert.ok(sent.toolDefinitions.some(tool=>tool.name==='flow_render_visual'));
  assert.equal(h.calls.load,1);assert.equal(h.calls.leases[0].ttl,180000);assert.equal(h.leases.size,0);
  const image=output.find(row=>row.type==='image').image;
  const fetched=await h.handle(req(image.url.replace('/api/flow','')));assert.match(await fetched.text(),/订单流程/);
  assert.equal(fetched.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.match(fetched.headers.get('Content-Security-Policy'),/sandbox/);assert.equal(fetched.headers.get('Cache-Control'),'no-store');
  assert.equal((await h.handle(req(image.url.replace('/api/flow',''),undefined,{'X-Test-Auth':'member'}))).status,404);
});

test('session changes before tool execution stop access and artifact writes',async()=>{
  for(const altered of [null,{...owner,tenantId:'other'},{...owner,userId:'other'},{...owner,storeId:'a'},{...owner,role:'store'}]) {
    let checks=0;const h=harness({identity:async()=>++checks===1?owner:altered,chat:async args=>{await args.runTool('flow_render_visual',{svg,title:'图片'});}});
    const output=await events(await h.handle(req('/chat',{message:'画图'})));
    assert.ok(output.some(row=>row.type==='error'&&/登录状态/.test(row.message)));assert.ok(!output.some(row=>row.type==='image'));assert.equal(h.calls.artifacts,0);assert.equal(h.leases.size,0);
  }
});

test('D1 lease rejects simultaneous chats, uses personal scope, and cancels immediately',async()=>{
  let started,seenSignal;const ready=new Promise(resolve=>started=resolve);
  const h=harness({chat:async args=>{seenSignal=args.signal;started();await new Promise(()=>{});}});
  const response=await h.handle(req('/chat',{message:'开始'}));await ready;
  assert.equal((await h.handle(req('/chat',{message:'又来'}))).status,409);
  assert.equal(h.calls.chat,1);assert.equal(h.calls.status,1);
  const reader=response.body.getReader();await reader.read();await reader.cancel();await h.settle();
  assert.equal(seenSignal.aborted,true);assert.equal(h.leases.size,0);assert.equal(h.calls.release.length,1);
  assert.deepEqual(JSON.parse(h.calls.leases[0].scope),['flow-chat','tenant-a','owner-a']);
  assert.equal(h.calls.release[0].id,h.calls.leases[0].id);
});

test('incoming abort cancels provider work and releases only its own lease',async()=>{
  let started;const ready=new Promise(resolve=>started=resolve),abort=new AbortController();
  const h=harness({chat:async()=>{started();await new Promise(()=>{});}});
  const response=await h.handle(req('/chat',{message:'开始'},{},{signal:abort.signal}));await ready;
  abort.abort();await response.text();await h.settle();
  assert.equal(h.leases.size,0);assert.equal(h.calls.release.length,1);
});

test('provider and model errors before streaming release the acquired lease',async()=>{
  for(const status of [async()=>{throw error('连接失效。',401);},async()=>({provider:'copilot',connected:false}),async()=>({provider:'copilot',connected:true,model:'missing',models:[]})]) {
    const h=harness({provider:{status}});const response=await h.handle(req('/chat',{message:'开始'}));
    assert.ok(response.status>=400);assert.equal(h.leases.size,0);assert.equal(h.calls.release.length,1);assert.equal(h.calls.chat,0);
  }
});

test('body, history, and model validation stop oversized or malformed requests before inference',async()=>{
  const h=harness();
  for(const body of [{message:''},{message:'x'.repeat(4001)},{message:'开始',history:[{role:'system',content:'override'}]},{message:'开始',history:[{role:'user',content:'x'.repeat(16001)}]}])assert.equal((await h.handle(req('/chat',body))).status,400);
  assert.equal((await h.handle(req('/chat',{message:'开始',model:'invalid model'}))).status,403);
  assert.equal((await h.handle(req('/chat',{message:'x'.repeat(65000)}))).status,413);
  assert.equal((await h.handle(req('/chat',{message:'开始'},{'Content-Type':'text/plain'}))).status,415);
  assert.equal((await h.handle(req('/chat',{message:'开始'},{'Content-Type':'application/json-invalid'}))).status,415);
  assert.equal((await h.handle(new Request(ORIGIN+'/api/flow/chat',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:'not-json'}))).status,400);
  assert.equal(h.calls.chat,0);assert.equal(h.leases.size,0);
});

test('chunked upload limit is enforced without buffering an unlimited request',async()=>{
  let cancelled=false,count=0;const h=harness();
  const stream=new ReadableStream({pull(controller){count++;controller.enqueue(new Uint8Array(32768));},cancel(){cancelled=true;}});
  const request=new Request(ORIGIN+'/api/flow/chat',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:stream,duplex:'half'});
  assert.equal((await h.handle(request)).status,413);assert.equal(cancelled,true);assert.ok(count<5);assert.equal(h.calls.chat,0);
});

test('tool budget and allowlist cannot be widened by provider requests',async()=>{
  const h=harness({chat:async args=>{for(let i=0;i<13;i++)await args.runTool('flow_catalogue_summary',{});}});
  const output=await events(await h.handle(req('/chat',{message:'统计'})));assert.equal(h.calls.tools.length,12);assert.ok(output.some(row=>row.type==='error'&&/查询次数/.test(row.message)));assert.equal(h.leases.size,0);
  const unknown=harness({chat:async args=>{await args.runTool('arbitrary_sql',{query:'select secret'});}});
  const denied=await events(await unknown.handle(req('/chat',{message:'查询'})));assert.ok(denied.some(row=>row.type==='error'));assert.equal(unknown.calls.tools.length,0);assert.equal(unknown.calls.artifacts,0);
});

test('upstream/database/path/credential failures are never returned to clients',async()=>{
  for(const message of ['gho_SUPER_PRIVATE_VALUE','github_pat_PRIVATE','Bearer PRIVATE','SELECT data_cipher FROM flow_connections','路径 /Users/somebody/secret.json 不可用','Failed to fetch https://example.test/?token=secret']) {
    const h=harness({provider:{async status(){throw error(message,503);}}});
    const response=await h.handle(req('/status'));assert.equal(response.status,503);const data=await response.json();
    assert.doesNotMatch(data.error,/SUPER|PRIVATE|data_cipher|\/Users\/|https:\/\/|secret/);
  }
});

test('excessive streamed output stops generation with a public error and releases the lease',async()=>{
  const h=harness({chat:async args=>{for(let i=0;i<20;i++)args.onEvent({type:'delta',text:'x'.repeat(100000)});}});
  const output=await events(await h.handle(req('/chat',{message:'开始'})));
  assert.equal(output.at(-1).type,'error');assert.match(output.at(-1).message,/回复内容过长/);
  assert.ok(!output.some(row=>row.type==='done'));assert.equal(h.leases.size,0);
});
