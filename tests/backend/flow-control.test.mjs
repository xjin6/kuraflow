import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handlePlatformFlow,getFlowPolicy,getUIFeatures} from '../../backend/flow-control.js';
import {createFlowStore} from '../../backend/flow-store.js';
import worker from '../../backend/worker.js';
import {hashToken} from '../../backend/auth.js';

const ORIGIN='https://flow.example.test',platform={role:'platform',accountRole:'owner',userId:'platform-owner',displayName:'Platform Owner'};
const migrationDir=new URL('../../backend/migrations/',import.meta.url);
class D1 {
  constructor({seed=false}={}) {
    this.sqlite=new DatabaseSync(':memory:');
    for(const file of readdirSync(migrationDir).filter(name=>name.endsWith('.sql')&&name<'0008').sort())this.sqlite.exec(readFileSync(new URL(file,migrationDir),'utf8'));
    for(const id of ['tenant-a','tenant-b'])this.sqlite.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').run(id,'Kitchen '+id,'{"stores":[]}');
    if(seed)this.sqlite.prepare('INSERT INTO flow_connections(tenant_id,data_cipher,version,updated_at) VALUES(?,?,1,?)').run('tenant-a','seed-cipher','2026-10-19');
    this.sqlite.exec(readFileSync(new URL('0008_tenant_features.sql',migrationDir),'utf8'));
    for(const file of readdirSync(migrationDir).filter(name=>name.endsWith('.sql')&&name>'0008_tenant_features.sql').sort())this.sqlite.exec(readFileSync(new URL(file,migrationDir),'utf8'));
  }
  prepare(sql) {
    const db=this.sqlite;
    const statement=(args=[])=>({bind:(...values)=>statement(values),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({success:true,meta:db.prepare(sql).run(...args)}),sync:()=>({success:true,meta:db.prepare(sql).run(...args)})});
    return statement();
  }
  async batch(statements) {this.sqlite.exec('BEGIN');try{const result=statements.map(stmt=>stmt.sync());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  get(sql,...args){return this.sqlite.prepare(sql).get(...args);}
}
function request(route='',body,headers={}) {return new Request(ORIGIN+'/api/platform/flow'+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{Origin:ORIGIN,'Content-Type':'application/json',...headers}});}
const target=tenantId=>({role:'admin',accountRole:'owner',tenantId,userId:platform.userId});
function harness(options={}) {
  const env={PUBLIC_ORIGIN:ORIGIN,DB:new D1(),STORE_CODE_KEY:'6'.repeat(64),...options.env},store=createFlowStore(env),calls={status:[],token:[]};
  const provider={
    async status(p,opts={}) {
      calls.status.push({principal:p,options:opts});const saved=await store.getConnection(p);
      return {provider:'copilot',configured:Boolean(saved),connected:Boolean(saved),model:saved?.data.model,models:saved?[{id:'model-a',name:'Model A'},{id:'model-b',name:'Model B'}]:[],cacheState:'fresh',fetchedAt:'2026-10-19T00:00:00Z',githubToken:'never-public',login:'never-public',runtime:{token:'never-public'}};
    },
    async loginToken(p,token) {
      calls.token.push({principal:p});
      if(token==='invalid')throw Object.assign(new Error('GitHub Token 无效。'),{status:401});
      const saved=await store.getConnection(p);
      await store.saveConnection(p,{githubToken:token,model:saved?.data.model||'model-a'},saved?.version??null);
      return this.status(p);
    },
    ...options.provider,
  };
  const identity=options.identity||async function(req){const role=req.headers.get('X-Test-Auth');if(role==='none')return null;if(role==='member')return {...platform,accountRole:'member'};return role?{...platform,role}:platform;};
  const handle=req=>handlePlatformFlow(req,env,{}, {identity,store,provider});
  const connect=async(tenantId='tenant-a')=>{const response=await handle(request('/connection',{tenantId,token:'test-token-'+tenantId}));assert.equal(response.status,200);return response.json();};
  return {env,store,provider,calls,handle,connect};
}

test('migration preserves existing connections and defaults other or new tenants disabled',async()=>{
  const DB=new D1({seed:true});assert.deepEqual(await getFlowPolicy(DB,'tenant-a'),{enabled:true,model:null,version:1});assert.deepEqual(await getFlowPolicy(DB,'tenant-b'),{enabled:false,model:null,version:1});assert.deepEqual(await getFlowPolicy(DB,'future'),{enabled:false,model:null,version:0});
  DB.sqlite.prepare('UPDATE tenant_features SET flow_enabled=0 WHERE tenant_id=?').run('tenant-a');
  DB.sqlite.exec(readFileSync(new URL('0008_tenant_features.sql',migrationDir),'utf8'));
  assert.equal((await getFlowPolicy(DB,'tenant-a')).enabled,false);assert.equal(DB.get('SELECT data_cipher FROM flow_connections WHERE tenant_id=?','tenant-a').data_cipher,'seed-cipher');
});

test('platform assigned model replaces unavailable legacy preference in public configuration',async()=>{
  const h=harness(),initial=await h.connect();
  h.provider.status=async()=>({configured:true,connected:true,model:'model-a',modelUnavailable:true,models:[{id:'model-b',name:'Model B'}],cacheState:'fresh',message:'原先选择的模型已不可用，请重新选择。'});
  const response=await h.handle(request('',{tenantId:'tenant-a',version:initial.version,enabled:true,model:'model-b'}));
  assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.flow.model,'model-b');assert.equal(value.connection.model,'model-b');assert.equal(value.connection.message,undefined);
});

test('platform owner scope and a real known tenant are required before provider access',async()=>{
  const h=harness();assert.equal(await h.handle(new Request(ORIGIN+'/api/health')),null);
  for(const [auth,status] of [['none',401],['admin',403],['store',403],['member',403]])for(const req of [request('?tenant=tenant-a',undefined,{'X-Test-Auth':auth}),request('/connection',{tenantId:'tenant-a',token:'ignored'},{'X-Test-Auth':auth}),request('',{tenantId:'tenant-a',enabled:true,version:1,model:'model-a'},{'X-Test-Auth':auth})])assert.equal((await h.handle(req)).status,status);
  assert.equal((await h.handle(request('?tenant=unknown'))).status,404);assert.equal((await h.handle(request('?tenant='))).status,400);assert.equal(h.calls.status.length,0);assert.equal(h.calls.token.length,0);
  const forged=harness({identity:async()=>({...platform,tenantId:'tenant-a'})});assert.equal((await forged.handle(request('?tenant=tenant-b'))).status,403);
});

test('platform connection targets only requested tenant and returns no secret or account metadata',async()=>{
  const h=harness(),result=await h.connect();
  assert.equal(result.tenantId,'tenant-a');assert.equal(result.flow.enabled,false);assert.equal(result.connection.configured,true);assert.equal(result.connection.hasToken,true);assert.equal(result.connection.models.length,2);
  assert.doesNotMatch(JSON.stringify(result),/test-token|never-public|githubToken|runtime|login/);
  assert.deepEqual(h.calls.token[0].principal,target('tenant-a'));
  assert.equal(await h.store.getConnection(target('tenant-b')),null);
  assert.equal(h.env.DB.get('SELECT action FROM account_audit WHERE tenant_id=?','tenant-a').action,'flow.connection.update');
  const cipher=h.env.DB.get('SELECT data_cipher FROM flow_connections WHERE tenant_id=?','tenant-a').data_cipher;assert.ok(!cipher.includes('test-token'));
  const failed=await h.handle(request('/connection',{tenantId:'tenant-a',token:'invalid'}));assert.equal(failed.status,401);assert.equal((await h.store.getConnection(target('tenant-a'))).version,1);
});

test('explicit model refresh is live and normal config read leaves the refresh flag off',async()=>{
  const h=harness();await h.connect();h.calls.status=[];
  assert.equal((await h.handle(request('?tenant=tenant-a'))).status,200);assert.equal(h.calls.status[0].options.refresh,undefined);
  assert.equal((await h.handle(request('/models',{tenantId:'tenant-a'}))).status,200);assert.equal(h.calls.status[1].options.refresh,true);
});

test('enable and model are one atomic policy change; stale form cannot overwrite it',async()=>{
  const h=harness();await h.connect();
  const first=await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-b'}));assert.equal(first.status,200);const body=await first.json();assert.deepEqual(body.flow,{enabled:true,model:'model-b'});assert.equal(body.version,2);
  assert.equal((await h.store.getConnection(target('tenant-a'))).data.model,'model-a');
  const responses=await Promise.all(['model-a','model-b'].map(model=>h.handle(request('',{tenantId:'tenant-a',version:2,enabled:true,model}))));assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);
  assert.equal((await getFlowPolicy(h.env,'tenant-a')).version,3);assert.equal((await getFlowPolicy(h.env,'tenant-b')).enabled,false);
  const audits=h.env.DB.get("SELECT count(*) AS total FROM account_audit WHERE action='flow.feature.enable'");assert.equal(audits.total,2);
});

test('first policy creation uses insert-only CAS and unknown tenants cannot be created',async()=>{
  const h=harness();h.env.DB.sqlite.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').run('new','New Kitchen','{}');
  assert.equal((await h.handle(request('',{tenantId:'new',version:0,enabled:false}))).status,200);
  assert.equal((await h.handle(request('',{tenantId:'new',version:0,enabled:false}))).status,409);
  assert.equal((await h.handle(request('',{tenantId:'unknown',version:0,enabled:false}))).status,404);
});

test('enable requires a configured token and an available fresh model catalogue',async()=>{
  const h=harness();assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a'}))).status,409);await h.connect();
  assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'invented'}))).status,400);
  const original=h.provider.status;
  for(const override of [{connected:false,message:'GitHub 连接失效。'},{stale:true,cacheState:'stale',message:'暂时无法刷新。'}]) {
    h.provider.status=async(...args)=>({...await original(...args),...override});
    assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a'}))).status,409);
    assert.equal((await getFlowPolicy(h.env,'tenant-a')).enabled,false);
  }
});

test('disable remains possible during GitHub failure and preserves policy/model/history',async()=>{
  const h=harness();await h.connect();await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-b'}));
  const conversation=await h.store.save(target('tenant-a'),{messages:[],draft:'preserved'});
  h.provider.status=async()=>{throw new Error('upstream unavailable');};
  const response=await h.handle(request('',{tenantId:'tenant-a',version:2,enabled:false,model:'model-b'}));assert.equal(response.status,200);assert.deepEqual((await response.json()).flow,{enabled:false,model:'model-b'});
  assert.equal((await h.store.get(target('tenant-a'),conversation.id)).draft,'preserved');assert.equal((await h.store.getConnection(target('tenant-a'))).data.githubToken,'test-token-tenant-a');
});

test('a broken credential cipher cannot prevent an urgent platform disable',async()=>{
  const h=harness();await h.connect();await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a'}));
  h.env.DB.sqlite.prepare('UPDATE flow_connections SET data_cipher=? WHERE tenant_id=?').run('damaged','tenant-a');
  const response=await h.handle(request('',{tenantId:'tenant-a',version:2,enabled:false}));assert.equal(response.status,200);assert.equal((await response.json()).flow.enabled,false);
  assert.equal((await getFlowPolicy(h.env,'tenant-a')).enabled,false);
});

test('connection changed during model validation rolls back feature update and its audit',async()=>{
  const h=harness();await h.connect();const original=h.provider.status;
  h.provider.status=async(...args)=>{const snapshot=await original(...args),saved=await h.store.getConnection(target('tenant-a'));await h.store.saveConnection(target('tenant-a'),{...saved.data,model:'model-b'},saved.version);return snapshot;};
  const response=await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a'}));assert.equal(response.status,409);assert.deepEqual(await getFlowPolicy(h.env,'tenant-a'),{enabled:false,model:null,version:1});
  assert.equal(h.env.DB.get("SELECT count(*) AS total FROM account_audit WHERE action='flow.feature.enable'").total,0);
});

test('mutations reject bad origins and unexpected fields; errors never expose provider details',async()=>{
  const h=harness();
  for(const headers of [{Origin:'https://evil.test'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await h.handle(request('/connection',{tenantId:'tenant-a',token:'secret'},headers))).status,403);
  for(const body of [{tenantId:'tenant-a',enabled:'true',version:1},{tenantId:'tenant-a',enabled:true,version:1,provider:'arbitrary'},{tenantId:'tenant-a',enabled:true,version:-1},{tenantId:'tenant-a',enabled:true,version:1,model:'invalid model'}])assert.equal((await h.handle(request('',body))).status,400);
  assert.equal((await h.handle(request('/connection',{tenantId:'tenant-a',token:'x'.repeat(9000)}))).status,413);
  h.provider.status=async()=>{throw Object.assign(new Error('错误 gho_PRIVATE_SECRET /Users/name/file'),{status:503});};
  const text=await (await h.handle(request('?tenant=tenant-a'))).text();assert.doesNotMatch(text,/PRIVATE|\/Users/);
  assert.equal((await h.handle(request('/connection',{tenantId:'tenant-a',token:'x',model:'model-a'}))).status,400);
});

test('multilingual defaults off, uses the shared version, and remains independent of Flow credentials',async()=>{
  const h=harness();
  const initial=await (await h.handle(request('?tenant=tenant-a'))).json();assert.deepEqual(initial.multilingual,{enabled:false});
  const response=await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:false,multilingualEnabled:true}));assert.equal(response.status,200);
  const saved=await response.json();assert.equal(saved.version,2);assert.deepEqual(saved.multilingual,{enabled:true});assert.deepEqual(saved.flow,{enabled:false,model:null});
  assert.equal((await getUIFeatures(h.env,{role:'admin',tenantId:'tenant-a',userId:'admin-a'})).multilingualEnabled,true);
  assert.equal((await getUIFeatures(h.env,{role:'store',tenantId:'tenant-a',storeId:'store-a',userId:'store-a'})).multilingualEnabled,true);
  assert.deepEqual(await getUIFeatures(h.env,{role:'admin',tenantId:'tenant-b',userId:'admin-b'}),{flowEnabled:false,multilingualEnabled:false,notificationsEnabled:true,version:1});
  assert.equal(h.env.DB.get("SELECT count(*) AS total FROM account_audit WHERE action='ui.multilingual.enable'").total,1);
  // Repeatable migration never resets configured tenants.
  h.env.DB.sqlite.exec(readFileSync(new URL('0014_multilingual.sql',migrationDir),'utf8'));
  assert.equal((await getUIFeatures(h.env,{role:'admin',tenantId:'tenant-a',userId:'admin-a'})).multilingualEnabled,true);
});

test('language-only save preserves enabled Flow when its connection is unavailable, and legacy writes preserve language',async()=>{
  const h=harness();await h.connect();await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a'}));
  const cipher=h.env.DB.get('SELECT data_cipher FROM flow_connections WHERE tenant_id=?','tenant-a').data_cipher;
  h.provider.status=async()=>{throw new Error('provider offline');};
  const response=await h.handle(request('',{tenantId:'tenant-a',version:2,enabled:true,multilingualEnabled:true}));assert.equal(response.status,200);
  const saved=await response.json();assert.deepEqual(saved.flow,{enabled:true,model:'model-a'});assert.deepEqual(saved.multilingual,{enabled:true});
  assert.equal(h.env.DB.get('SELECT data_cipher FROM flow_connections WHERE tenant_id=?','tenant-a').data_cipher,cipher);
  const legacy=await h.handle(request('',{tenantId:'tenant-a',version:3,enabled:false}));assert.equal(legacy.status,200);assert.equal((await legacy.json()).multilingual.enabled,true);
});

test('language changes reject stale versions, non-platform actors and invalid input without partial saves',async()=>{
  const h=harness();
  for(const auth of ['admin','store','member'])assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:false,multilingualEnabled:true},{'X-Test-Auth':auth}))).status,403);
  for(const multilingualEnabled of ['true',1,null])assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:false,multilingualEnabled}))).status,400);
  assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:0,enabled:false,multilingualEnabled:true}))).status,409);
  assert.equal((await h.handle(request('',{tenantId:'tenant-a',version:1,enabled:true,model:'model-a',multilingualEnabled:true}))).status,409);
  assert.equal(h.env.DB.get('SELECT count(*) AS total FROM tenant_ui_features').total,0);
  const results=await Promise.all([true,false].map(multilingualEnabled=>h.handle(request('',{tenantId:'tenant-a',version:1,enabled:false,multilingualEnabled}))));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await getFlowPolicy(h.env,'tenant-a')).version,2);assert.equal((await getFlowPolicy(h.env,'tenant-b')).version,1);
});

test('UI feature HTTP endpoint requires a valid session and ignores attempts to select another tenant',async()=>{
  const h=harness(),db=h.env.DB,stamp=Math.floor(Date.now()/1000);
  for(const tenantId of ['tenant-a','tenant-b']){
    db.sqlite.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)').run(tenantId,'ORG-'+tenantId,stamp);
    db.sqlite.prepare('UPDATE tenants SET core_json=? WHERE id=?').run(JSON.stringify({stores:[{id:'store-a',name:'Store A'}]}),tenantId);
  }
  db.sqlite.prepare('INSERT INTO tenant_ui_features(tenant_id,multilingual_enabled,updated_at) VALUES(?,1,?)').run('tenant-a',new Date().toISOString());
  async function account(role,tenantId=null,storeId=null){
    const id=crypto.randomUUID(),token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    db.sqlite.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,?,?,'owner','Name','','active',?)").run(id,id,tenantId,storeId,role,stamp);
    db.sqlite.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,0)').run(await hashToken(token),id,stamp+3600);
    return '__Host-kuraflow_account='+token;
  }
  const admin=await account('admin','tenant-a'),store=await account('store','tenant-a','store-a'),other=await account('admin','tenant-b'),platformCookie=await account('platform');
  const call=(cookie='',query='')=>worker.fetch(new Request(ORIGIN+'/api/ui-features'+query,{headers:{Cookie:cookie}}),h.env,{});
  assert.equal((await call()).status,401);
  for(const cookie of [admin,store]){const result=await call(cookie,'?tenant=tenant-b');assert.equal(result.status,200);assert.deepEqual(await result.json(),{flowEnabled:false,multilingualEnabled:true,notificationsEnabled:true,version:1});}
  assert.deepEqual(await (await call(other,'?tenant=tenant-a')).json(),{flowEnabled:false,multilingualEnabled:false,notificationsEnabled:true,version:1});
  assert.deepEqual(await (await call(platformCookie)).json(),{flowEnabled:false,multilingualEnabled:true,notificationsEnabled:true,version:1});
});
