import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createFlowActions,findFlowAddresses} from './flow-actions.js';
import {createFlowDataContext,runFlowTool} from './flow-tools.js';
import {getIdentity} from './accounts.js';
import {hashToken} from './auth.js';
import {getFlowPolicy} from './flow-control.js';
import {seedTenant,loadState,executeCommand,tokyoToday} from './repository.js';
import {handleFlow} from './flow-service.js';
import {createFlowStore} from './flow-store.js';
import {createLocalFlowRuntime} from '../scripts/flow-local-runtime.mjs';

let runtime,db;
before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'flow-actions-test',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'flow-actions-test'}}]}));
  db=await runtime.getD1Database('DB');
  for(const name of (await readdir(new URL('./migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL('./migrations/'+name,import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  }
});
after(async()=>runtime?.dispose());
const details={name:'测试门店',prefectureCode:'27',municipalityCode:'27100',wardCode:'27111',addressDetail:'難波中1丁目2番3号',contact:'测试店长',phone:'090-1234-5678'};
const testError=(message,status)=>Object.assign(new Error(message),{status,publicError:true});
async function fixture({member=false,local=false}={}) {
  const tenantId=crypto.randomUUID(),userId=crypto.randomUUID(),token=crypto.randomUUID().replaceAll('-','').repeat(2);
  const state={version:2,products:[],stores:[],orders:[],documents:[],inventory:{},prices:{},quoteMeta:{},unitQuotes:{},storeAllocations:{},cart:{},cartUnits:{},settings:{companyName:'Flow 写入测试厨房',currency:'JPY'}};
  await seedTenant(db,{tenantId,state});
  await db.batch([
    db.prepare("INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,1)").bind(tenantId,'ORG-'+tenantId),
    db.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,'admin',?,'测试操作员','','active',1)").bind(userId,userId,tenantId,member?'member':'owner'),
    db.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,0)').bind(await hashToken(token),userId,Math.floor(Date.now()/1000)+3600),
    db.prepare("INSERT INTO tenant_features(tenant_id,flow_enabled,flow_model,version,updated_at) VALUES(?,1,'test-model',1,?)").bind(tenantId,new Date().toISOString()),
  ]);
  const origin=local?'http://localhost:8787':'https://flow-write.example.test';
  const env={DB:db,STORE_CODE_KEY:'a'.repeat(64),LOCAL_TEST:local?'1':'0',PUBLIC_ORIGIN:local?'':origin};
  const request=(body={},extra={})=>new Request(origin+'/api/flow/chat',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:(local?'kuraflow_local_account':'__Host-kuraflow_account')+'='+token},body:JSON.stringify(body),...extra});
  const principal=await getIdentity(request(),env),mutations=[];
  async function turn(requestId=crypto.randomUUID(),options={}) {
    const req=options.request||request(),data=await createFlowDataContext(env.DB,principal);
    const checkAccess=async()=>{
      req.signal.throwIfAborted();
      const actor=await getIdentity(req,env);
      if(!actor||actor.userId!==principal.userId||actor.version!==principal.version)throw testError('登录已变更。',401);
      if(!(await getFlowPolicy(env,tenantId)).enabled)throw testError('Flow 已停用。',403);
    };
    const actions=createFlowActions({request:req,env,principal,requestId,data,checkAccess,onMutation:row=>mutations.push(row)});
    return {...actions,data,requestId};
  }
  const business=async()=>(await loadState(db,tenantId)).state;
  const count=async table=>(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=?`).bind(tenantId).first()).n;
  return {tenantId,userId,env,principal,request,turn,business,count,mutations};
}
async function stream(response) {
  assert.equal(response.status,200);
  return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
}
function interceptBusinessWrite(beforeWrite=async()=>{},extra=()=>[]) {
  const wrap=(statement,sql)=>({statement,sql,
    bind:(...values)=>wrap(statement.bind(...values),sql),
    first:(...args)=>statement.first(...args),all:(...args)=>statement.all(...args),run:(...args)=>statement.run(...args),
  });
  return {prepare:sql=>wrap(db.prepare(sql),sql),async batch(statements){
    const writing=statements.some(row=>row.sql.startsWith('UPDATE tenants SET core_json'));
    if(writing)await beforeWrite();
    return db.batch([...statements.map(row=>row.statement),...(writing?extra():[])]);
  }};
}


const actionRequest=(h,id,decision,body={})=>{
  const base=h.request(),url=new URL(base.url);url.pathname='/api/flow/actions/'+id+(decision?'/'+decision:'');
  return new Request(url,{method:decision?'POST':'GET',headers:base.headers,...(decision?{body:JSON.stringify(body)}:{})});
};
const prepare=async(h,name,args)=>{const turn=await h.turn();const result=await turn.execute(name,args);return {turn,proposal:result.data.proposal};};
const save=async(h,name,args)=>{const {turn,proposal}=await prepare(h,name,args);const result=await turn.resolve(proposal.id,'confirm');return result.mutations.find(row=>row.operation===name);};

test('address lookup returns actual hierarchy codes and rejects scope injection',()=>{
  assert.equal(findFlowAddresses({prefecture:'大阪',municipality:'大阪市',ward:'浪速'}).data.results[0].wardCode,'27111');
  assert.equal(findFlowAddresses({prefecture:'不存在'}).data.total,0);
  assert.throws(()=>findFlowAddresses({tenantId:'foreign'}),/不支持/);
});

test('prepare validates a store and saves only an immutable proposal; confirmation creates the store and owner once',async()=>{
  const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);
  assert.equal(proposal.status,'pending');assert.match(proposal.details.find(row=>row.label==='地址').value,/大阪府大阪市浪速区/);
  assert.equal((await h.business()).stores.length,0);assert.equal(await h.count('command_idempotency'),0);assert.equal(h.mutations.length,0);
  assert.equal(await h.count('staff_accounts'),1);assert.equal(await h.count('flow_proposals'),1);
  const result=await turn.resolve(proposal.id,'confirm'),mutation=result.mutations[0];
  assert.equal(result.proposal.status,'saved');assert.equal(mutation.status,'saved');
  const store=(await h.business()).stores[0];assert.equal(mutation.recordId,store.id);assert.equal(store.phone,details.phone);
  assert.equal(await h.count('staff_accounts'),2);assert.equal(await h.count('business_audit_log'),1);
  const replay=await (await h.turn(turn.requestId)).resolve(proposal.id,'confirm');
  assert.equal(replay.mutations[0].recordId,store.id);assert.equal(await h.count('command_idempotency'),1);
  assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(h.mutations),/masterCode|accessCode|password|key_cipher|key_hash|STORE_CODE_KEY/);
});

test('retries reuse immutable proposals; changed retry arguments cannot create a second proposal',async()=>{
  const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);
  assert.equal((await turn.execute('flow_create_store',{...details})).data.proposal.id,proposal.id);
  const retry=await h.turn(turn.requestId);
  assert.equal((await retry.execute('flow_create_store',details)).data.proposal.id,proposal.id);
  await assert.rejects(retry.execute('flow_create_store',{...details,name:'换名重试'}),{status:409});
  await retry.resolve(proposal.id,'cancel');
  assert.equal((await retry.resolve(proposal.id,'confirm')).proposal.status,'cancelled');
  assert.equal((await h.business()).stores.length,0);
});

test('incomplete, invalid, extra identity and prototype fields cannot even create a proposal',async()=>{
  const h=await fixture();
  for(const args of [{name:'不完整'},{...details,phone:'not-a-phone'},{...details,municipalityCode:'13113'},{...details,tenantId:'other'},{...details,masterCode:'forged'},{...details,confirmed:true},JSON.parse(JSON.stringify(details).replace('"name":','"__proto__":{},"name":'))])await assert.rejects((await h.turn()).execute('flow_create_store',args));
  assert.equal(await h.count('flow_proposals'),0);assert.equal((await h.business()).stores.length,0);
});

test('confirmation is bound to the kitchen and personal account, and ignores no client-supplied changes',async()=>{
  const a=await fixture(),b=await fixture(),{turn,proposal}=await prepare(a,'flow_create_store',details);
  assert.equal((await handleFlow(actionRequest(b,proposal.id,'confirm'),b.env)).status,404);
  const otherUser=crypto.randomUUID();
  await db.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,'admin','member','另一个人','','active',1)").bind(otherUser,otherUser,a.tenantId).run();
  const otherPrincipal={...a.principal,userId:otherUser};
  const foreign=createFlowActions({request:a.request(),env:a.env,principal:otherPrincipal,requestId:turn.requestId,data:turn.data,checkAccess:async()=>{}});
  await assert.rejects(foreign.resolve(proposal.id,'confirm'),{status:404});
  assert.equal((await handleFlow(actionRequest(a,proposal.id,'confirm',{name:'篡改'}),a.env)).status,400);
  const cross=actionRequest(a,proposal.id,'confirm');cross.headers.set('Origin','https://foreign.test');
  assert.equal((await handleFlow(cross,a.env)).status,403);
  assert.equal((await a.business()).stores.length,0);
});

test('members retain business permissions; foreign targets and credential edits are refused',async()=>{
  const a=await fixture({member:true}),b=await fixture(),store=await save(b,'flow_create_store',details);
  await assert.rejects((await a.turn()).execute('flow_update_store',{storeId:store.recordId,changes:{name:'跨厨房'}}),{status:404});
  const own=await save(a,'flow_create_store',details);
  await assert.rejects((await a.turn()).execute('flow_update_store',{storeId:own.recordId,changes:{accessCode:'forged'}}));
  for(const principal of [{...a.principal,role:'store'},{...a.principal,role:'platform'},{...a.principal,storeId:'foreign'}])assert.throws(()=>createFlowActions({principal,requestId:crypto.randomUUID()}),{status:403});
});

for(const change of ['disable_flow','replace_flow','expire_proposal','logout','disable_account','archive_account','suspend_kitchen','cancel_proposal'])test('atomic guard rejects '+change+' racing the final check',async()=>{
  const h=await fixture(),prepared=await prepare(h,'flow_create_store',details);let changed=false;
  h.env.DB=interceptBusinessWrite(async()=>{
    if(changed)return;changed=true;
    if(change==='disable_flow')await db.prepare('UPDATE tenant_features SET flow_enabled=0,version=version+1 WHERE tenant_id=?').bind(h.tenantId).run();
    if(change==='replace_flow')await db.prepare('UPDATE tenant_features SET version=version+1 WHERE tenant_id=?').bind(h.tenantId).run();
    if(change==='expire_proposal')await db.prepare('UPDATE flow_proposals SET expires_at=1 WHERE id=?').bind(prepared.proposal.id).run();
    if(change==='logout')await db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(h.userId).run();
    if(change==='disable_account')await db.prepare("UPDATE staff_accounts SET status='disabled' WHERE id=?").bind(h.userId).run();
    if(change==='archive_account')await db.prepare('INSERT INTO staff_account_archives(account_id,deleted_at,deleted_by) VALUES(?,?,?)').bind(h.userId,Math.floor(Date.now()/1000),h.userId).run();
    if(change==='suspend_kitchen')await db.prepare('UPDATE organizations SET active=0 WHERE tenant_id=?').bind(h.tenantId).run();
    if(change==='cancel_proposal')await db.prepare("UPDATE flow_proposals SET status='cancelled' WHERE id=?").bind(prepared.proposal.id).run();
  });
  await assert.rejects((await h.turn(prepared.turn.requestId)).resolve(prepared.proposal.id,'confirm'));
  assert.equal(changed,true);assert.equal((await h.business()).stores.length,0);assert.equal(await h.count('command_idempotency'),0);assert.equal(h.mutations.length,0);
});

test('stale business data, expired cards and changed configuration require a fresh review',async()=>{
  for(const change of ['business','expiry','policy','account']){
    const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);
    if(change==='business')await db.prepare('UPDATE tenants SET revision=revision+1 WHERE id=?').bind(h.tenantId).run();
    if(change==='expiry')await db.prepare('UPDATE flow_proposals SET expires_at=1 WHERE id=?').bind(proposal.id).run();
    if(change==='policy')await db.prepare('UPDATE tenant_features SET version=version+1 WHERE tenant_id=?').bind(h.tenantId).run();
    if(change==='account')await db.prepare('UPDATE flow_proposals SET account_version=account_version+1 WHERE id=?').bind(proposal.id).run();
    await assert.rejects(turn.resolve(proposal.id,'confirm'),{status:409});assert.equal((await h.business()).stores.length,0);
  }
});

test('independent operations in one request can be confirmed in either order; two concurrent confirmations save once',async()=>{
  const h=await fixture(),turn=await h.turn();
  const a=(await turn.execute('flow_create_task',{title:'事项 A',dueDate:'2026-12-01'})).data.proposal;
  const b=(await turn.execute('flow_create_product',{name:'商品 B',category:'冷冻品',unit:'KG'})).data.proposal;
  const attempts=await Promise.allSettled([(await h.turn(turn.requestId)).resolve(b.id,'confirm'),(await h.turn(turn.requestId)).resolve(b.id,'confirm')]);
  assert.ok(attempts.some(row=>row.status==='fulfilled'));
  await (await h.turn(turn.requestId)).resolve(a.id,'confirm');
  assert.equal((await h.business()).products.length,1);assert.equal((await h.business()).manualTasks.length,1);assert.equal(await h.count('command_idempotency'),2);
});

test('transaction failure rolls back the business write, audit and confirmation state together',async()=>{
  const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);
  h.env.DB=interceptBusinessWrite(undefined,()=>[db.prepare("INSERT INTO business_write_assertion(id,ok) VALUES('intentional-flow-test-failure',0)")]);
  await assert.rejects((await h.turn(turn.requestId)).resolve(proposal.id,'confirm'));
  assert.equal((await h.business()).stores.length,0);assert.equal(await h.count('business_audit_log'),0);
  assert.equal((await turn.proposals())[0].status,'pending');
});

test('interrupted owner provisioning retains the confirmed store and repairs it without duplicate creation',async()=>{
  const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);h.env.STORE_CODE_KEY='invalid';
  await assert.rejects(turn.resolve(proposal.id,'confirm'),/资料已保存/);
  assert.equal((await h.business()).stores.length,1);assert.equal(h.mutations.at(-1).status,'pending_account');
  h.env.STORE_CODE_KEY='a'.repeat(64);
  const result=await (await h.turn(turn.requestId)).resolve(proposal.id,'confirm');
  assert.equal(result.mutations[0].status,'saved');assert.equal(await h.count('command_idempotency'),1);
});

test('store edits, stock, quote and task changes remain gated and use existing business rules',async()=>{
  const h=await fixture(),store=await save(h,'flow_create_store',details),product=await save(h,'flow_create_product',{name:'称重商品',category:'冷冻品',unit:'KG'});
  assert.equal((await h.business()).inventory[product.recordId],null);
  await save(h,'flow_update_store',{storeId:store.recordId,changes:{name:'改名测试店'}});
  assert.equal((await h.business()).stores[0].phone,details.phone);
  await save(h,'flow_set_stock',{productId:product.recordId,unit:'KG',quantity:12.375});
  const quote=await save(h,'flow_set_quote',{storeId:store.recordId,productId:product.recordId,unit:'KG',price:250.25,taxBasis:'exclusive',taxRate:0.08});
  assert.equal(quote.recordId,store.recordId);assert.match(quote.href,/tab=quotes/);
  const todo=await save(h,'flow_create_task',{title:'联系供应商',dueDate:'2026-12-01'});
  await save(h,'flow_set_task_deadline',{taskId:todo.recordId,dueDate:'2026-12-02'});
  await save(h,'flow_set_task_done',{taskId:todo.recordId,done:true});
  const state=await h.business();assert.equal(state.inventory[product.recordId],12.375);assert.equal(state.prices[store.recordId][product.recordId],250.25);
  assert.equal(state.manualTasks[0].source,'manual');assert.equal(state.manualTasks[0].dueDate,'2026-12-02');assert.ok(state.manualTasks[0].completedAt);
});

test('store/product/task deletion is soft, preserves history and permits supported restores',async()=>{
  const h=await fixture(),store=await save(h,'flow_create_store',details),product=await save(h,'flow_create_product',{name:'商品',category:'冷冻品',unit:'袋'}),task=await save(h,'flow_create_task',{title:'待办',dueDate:'2026-12-01'});
  await save(h,'flow_set_quote',{storeId:store.recordId,productId:product.recordId,unit:'袋',price:100,taxBasis:'unspecified'});
  await save(h,'flow_set_stock',{productId:product.recordId,unit:'袋',quantity:10});
  const historicalOrder=await executeCommand(db,{...h.principal,role:'store',storeId:store.recordId},{type:'submitOrder',args:[store.recordId,{[product.recordId]:1},tokyoToday()],idempotencyKey:crypto.randomUUID(),expectedQuotes:{[product.recordId]:{price:100,taxBasis:'unspecified',taxRate:null,unit:'袋',perBase:1}}});
  assert.ok(historicalOrder.result.id);
  const original=await h.business(),{turn,proposal}=await prepare(h,'flow_delete_store',{storeId:store.recordId});
  assert.ok(!(await h.business()).stores[0].deletedAt);
  await turn.resolve(proposal.id,'confirm');
  await save(h,'flow_delete_product',{productId:product.recordId});await save(h,'flow_delete_task',{taskId:task.recordId});
  let state=await h.business();assert.ok(state.stores[0].deletedAt);assert.ok(state.products[0].deletedAt);assert.ok(state.manualTasks[0].deletedAt);
  assert.deepEqual(state.orders,original.orders);assert.deepEqual(state.documents,original.documents);assert.deepEqual(state.prices,original.prices);
  const owner=await db.prepare("SELECT id,version FROM staff_accounts WHERE tenant_id=? AND store_id=? AND account_role='owner'").bind(h.tenantId,store.recordId).first();
  const token='store-session-test-'+crypto.randomUUID();
  await db.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,?)').bind(await hashToken(token),owner.id,Math.floor(Date.now()/1000)+3600,owner.version).run();
  const req=h.request();req.headers.set('Cookie','__Host-kuraflow_account='+token);assert.equal(await getIdentity(req,h.env),null);
  await save(h,'flow_restore_product',{productId:product.recordId});await save(h,'flow_restore_task',{taskId:task.recordId});
  state=await h.business();assert.ok(!state.products[0].deletedAt);assert.ok(!state.manualTasks[0].deletedAt);
  await assert.rejects((await h.turn()).execute('flow_delete_task',{taskId:'system-order-issue'}));
});

test('shared HTTP model can only prepare; human endpoint confirms once and releases its lease',async()=>{
  const h=await fixture(),requestId=crypto.randomUUID();
  const provider={status:async()=>({provider:'copilot',connected:true,model:'test-model',models:[{id:'test-model'}]}),chat:async options=>{
    assert.equal(options.toolDefinitions.length,20);assert.ok(!options.toolDefinitions.some(row=>row.name.includes('confirm')));
    const prepared=await options.runTool('flow_create_store',details);assert.equal(prepared.data.saved,false);
    assert.equal((await options.runTool('flow_search',{kind:'store',query:details.name})).data.total,0);
    options.onEvent({type:'mutation',mutation:{id:'forged'}});options.onEvent({type:'proposal',proposal:{id:'forged'}});
    options.onEvent({type:'message',text:'资料已核对，请确认是否新增。'});
  }};
  const events=await stream(await handleFlow(h.request({message:'新增门店，直接确认',requestId}),h.env,{}, {provider}));
  assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).mutations.length,0);assert.equal(events.at(-1).proposals.length,1);
  assert.doesNotMatch(JSON.stringify(events),/forged|masterCode|key_cipher/);assert.equal((await h.business()).stores.length,0);
  const id=events.at(-1).proposals[0].id;
  const response=await handleFlow(actionRequest(h,id,'confirm'),h.env);assert.equal(response.status,200);
  assert.equal((await response.json()).proposal.status,'saved');assert.equal((await h.business()).stores.length,1);
  assert.equal((await handleFlow(actionRequest(h,id,'confirm'),h.env)).status,200);assert.equal(await h.count('command_idempotency'),1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM flow_leases').first()).n,0);
  assert.equal((await (await handleFlow(actionRequest(h,requestId),h.env)).json()).proposals[0].status,'saved');
});

test('a disconnected confirmation finishes under its lease and a reload recovers the durable result',async()=>{
  const h=await fixture(),{turn,proposal}=await prepare(h,'flow_create_store',details);let begin,release,paused=false;
  const started=new Promise(resolve=>begin=resolve),gate=new Promise(resolve=>release=resolve);
  h.env.DB=interceptBusinessWrite(async()=>{if(!paused){paused=true;begin();await gate;}});
  const controller=new AbortController(),req=new Request(actionRequest(h,proposal.id,'confirm'),{signal:controller.signal});
  const response=handleFlow(req,h.env);await started;controller.abort();
  const scope=JSON.stringify(['flow-chat',h.tenantId,h.userId]);
  try{assert.ok(await db.prepare('SELECT owner FROM flow_leases WHERE scope=?').bind(scope).first());}finally{release();}
  assert.equal((await response).status,200);assert.equal((await h.business()).stores.length,1);
  const recovered=await (await handleFlow(actionRequest(h,turn.requestId),h.env)).json();
  assert.equal(recovered.proposals[0].status,'saved');assert.equal(recovered.mutations.length,1);
});

test('local SDK runtime uses the same prepare/confirm boundary with actual local D1',async t=>{
  const h=await fixture({local:true}),privateDir=await mkdtemp(path.join(os.tmpdir(),'flow-confirm-sdk-'));
  await createFlowStore(h.env).saveConnection(h.principal,{provider:'copilot',connection:'direct',githubToken:'SYNTHETIC_TEST_GITHUB_TOKEN',model:'test-model'});
  const local=createLocalFlowRuntime({db,privateDir,codeKey:h.env.STORE_CODE_KEY,fetchImpl:async url=>{
    if(url.endsWith('/models'))return Response.json({data:[{id:'test-model',name:'Test model'}]});
    if(url.endsWith('/copilot_internal/v2/token'))return Response.json({token:'synthetic-exchanged-token'});
    if(url.endsWith('/user'))return Response.json({login:'synthetic-test-user'});
    throw new Error('Unexpected test network request');
  },copilotFactory:()=>({chat:async options=>{
    const result=await options.runTool('flow_create_store',details);assert.equal(result.data.saved,false);
    options.onEvent({type:'message',text:'请确认新增门店。'});
  },dispose:async()=>{}})});
  t.after(async()=>{await local.dispose();await rm(privateDir,{recursive:true,force:true});});
  const events=await stream(await local.handle(h.request({message:'新增门店',requestId:crypto.randomUUID()})));
  assert.equal(events.at(-1).type,'done');assert.equal((await h.business()).stores.length,0);
  const response=await local.handle(actionRequest(h,events.at(-1).proposals[0].id,'confirm'));
  assert.equal(response.status,200);assert.equal((await h.business()).stores.length,1);
});
