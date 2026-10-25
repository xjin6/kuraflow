import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createFlowStore} from '../../backend/flow-store.js';

let runtime,env;
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#fff"/><text x="40" y="60" font-size="24">库存概览</text></svg>';
const actor=()=>({role:'admin',accountRole:'owner',tenantId:crypto.randomUUID(),userId:crypto.randomUUID()});
before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'flow-store',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'flow-store'}}]}));
  const DB=await runtime.getD1Database('DB');
  await DB.exec((await readFile(new URL('../../backend/migrations/0007_flow.sql',import.meta.url),'utf8')).replace(/\s+/g,' '));
  const features=await readFile(new URL('../../backend/migrations/0008_tenant_features.sql',import.meta.url),'utf8');
  await DB.exec(features.slice(features.indexOf('CREATE TABLE IF NOT EXISTS flow_model_catalogues')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env={DB,STORE_CODE_KEY:'4'.repeat(64)};
});
after(async()=>runtime?.dispose());

test('connection secrets are encrypted, tenant authenticated, owner mutable and CAS guarded',async()=>{
  const store=createFlowStore(env),owner=actor(),other=actor(),data={githubToken:'TEST_ONLY_GITHUB_TOKEN',login:'owner',model:'model-a'};
  assert.equal(await store.getConnection(owner),null);
  const first=await store.saveConnection(owner,data);
  assert.equal(first.version,1);
  const raw=await env.DB.prepare('SELECT data_cipher FROM flow_connections WHERE tenant_id=?').bind(owner.tenantId).first();
  assert.ok(!raw.data_cipher.includes(data.githubToken));assert.ok(!raw.data_cipher.includes('owner'));
  assert.deepEqual(await createFlowStore(env).getConnection({...owner,accountRole:'member',userId:'member'}),first);
  assert.equal(await store.getConnection(other),null);
  await assert.rejects(store.saveConnection({...owner,accountRole:'member'},data,first.version),{status:403});
  await assert.rejects(store.saveConnection(owner,{...data,model:'clobber'}),{status:409});
  const results=await Promise.allSettled(['model-b','model-c'].map(model=>createFlowStore(env).saveConnection(owner,{...data,model},first.version)));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.status,409);
  const saved=await store.getConnection(owner);assert.equal(saved.version,2);assert.notEqual(saved.data.model,'model-a');
  await env.DB.prepare('INSERT INTO flow_connections(tenant_id,data_cipher,version,updated_at) VALUES(?,?,1,?)').bind(other.tenantId,raw.data_cipher,new Date().toISOString()).run();
  await assert.rejects(store.getConnection(other),{status:503});
  await assert.rejects(createFlowStore({...env,STORE_CODE_KEY:'5'.repeat(64)}).getConnection(owner),{status:503});
});

test('model catalogues are tenant/version scoped, allowlisted and reject stale concurrent writes',async()=>{
  let time=Date.now();const store=createFlowStore(env,{now:()=>time}),owner=actor(),other=actor();
  const connection=await store.saveConnection(owner,{githubToken:'TEST_ONLY_CACHE_TOKEN',model:'a'});
  assert.equal(await store.getModelCatalogue(owner,connection.version),null);
  const snapshot={models:[{id:'a',name:'Model A',credential:'never retain'}],fetchedAt:time};
  assert.equal(await store.saveModelCatalogue(owner,1,snapshot),true);
  assert.deepEqual(await store.getModelCatalogue({...owner,userId:'another',accountRole:'member'},1),{models:[{id:'a',name:'Model A'}],fetchedAt:time});
  const raw=await env.DB.prepare('SELECT * FROM flow_model_catalogues WHERE tenant_id=?').bind(owner.tenantId).first();assert.doesNotMatch(raw.data_json,/credential|TEST_ONLY|never retain/);
  assert.equal(await store.getModelCatalogue(other,1),null);assert.equal(await store.saveModelCatalogue(other,1,snapshot),false);
  assert.equal(await store.saveModelCatalogue(owner,1,{models:[{id:'old',name:'Old'}],fetchedAt:time-1}),false);
  await store.saveConnection(owner,{githubToken:'TEST_ONLY_NEW_TOKEN',model:'b'},1);
  assert.equal(await store.getModelCatalogue(owner,1),null);assert.equal(await store.getModelCatalogue(owner,2),null);
  assert.equal(await store.saveModelCatalogue(owner,1,snapshot),false);
  time+=100;assert.equal(await store.saveModelCatalogue(owner,2,{models:[{id:'b',name:'Model B'}],fetchedAt:time}),true);
  assert.equal(await store.deleteModelCatalogue(owner,1),false);assert.equal((await store.getModelCatalogue(owner,2)).models[0].id,'b');
  assert.equal(await store.deleteModelCatalogue(owner,2),true);assert.equal(await store.getModelCatalogue(owner,2),null);
  for(const bad of [{...owner,role:'platform'},{...owner,role:'store'},{...owner,storeId:'bad'}]){
    await assert.rejects(store.getModelCatalogue(bad,2),{status:403});await assert.rejects(store.saveModelCatalogue(bad,2,snapshot),{status:403});
  }
  await assert.rejects(store.saveModelCatalogue(owner,2,{models:[{id:'bad\nmodel',name:'bad'}],fetchedAt:time}),{status:400});
  await assert.rejects(store.saveModelCatalogue(owner,2,{models:[],fetchedAt:time+60000}),{status:400});
});

test('device authorizations are encrypted and isolate tenant, user, id, expiry and versions',async()=>{
  let time=Date.now();const store=createFlowStore(env,{now:()=>time}),owner=actor(),id=crypto.randomUUID(),data={deviceCode:'TEST_ONLY_DEVICE_CODE',userCode:'TEST-CODE',nextPoll:time+5000};
  const first=await store.saveAuth(owner,id,data,time+60000);assert.equal(first.version,1);
  const raw=await env.DB.prepare('SELECT data_cipher FROM flow_auth WHERE tenant_id=? AND user_id=? AND id=?').bind(owner.tenantId,owner.userId,id).first();
  assert.ok(!raw.data_cipher.includes(data.deviceCode));assert.ok(!raw.data_cipher.includes(data.userCode));
  assert.deepEqual(await store.getAuth(owner,id),first);
  for(const other of [{...owner,tenantId:'another-tenant'},{...owner,userId:'another-user'}])await assert.rejects(store.getAuth(other,id),{status:404});
  await assert.rejects(store.getAuth({...owner,accountRole:'member'},id),{status:403});
  const results=await Promise.allSettled([1,2].map(nextPoll=>store.saveAuth(owner,id,{...data,nextPoll},time+60000,1)));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.status,409);
  const otherId=crypto.randomUUID();await env.DB.prepare('INSERT INTO flow_auth(tenant_id,user_id,id,data_cipher,version,expires_at) VALUES(?,?,?,?,1,?)').bind(owner.tenantId,owner.userId,otherId,raw.data_cipher,time+60000).run();
  await assert.rejects(store.getAuth(owner,otherId),{status:503});
  time+=60000;await assert.rejects(store.getAuth(owner,id),{status:410});
  await assert.rejects(store.saveAuth(owner,id,data,time-1,2),{status:410});
  await store.deleteAuth(owner,id);await assert.rejects(store.getAuth(owner,id),{status:404});
});

test('conversations persist with per-person tenant isolation and allowlisted metadata',async()=>{
  const store=createFlowStore(env),owner=actor();
  const row=await store.save(owner,{draft:'继续查询',messages:[{role:'user',text:'查看库存'},{role:'assistant',text:'已查询',steps:[{id:'prepare',label:'准备业务数据',status:'done'},{id:'private-reasoning',label:'hidden',status:'done'}],sources:[{title:'商品',url:'/?page=catalogue'},{title:'bad',url:'javascript:alert(1)'}]}]});
  assert.equal(row.version,1);assert.equal(row.title,'查看库存');assert.equal((await createFlowStore(env).get(owner,row.id)).draft,'继续查询');
  assert.deepEqual(row.messages[1].steps,[{id:'prepare',label:'准备业务数据',status:'done'}]);assert.deepEqual(row.messages[1].sources,[{label:'商品',href:'/?page=catalogue'}]);
  assert.equal((await store.list(owner)).conversations[0].messageCount,2);
  for(const other of [{...owner,tenantId:'other-tenant'},{...owner,userId:'other-user'}]){assert.equal((await store.list(other)).conversations.length,0);await assert.rejects(store.get(other,row.id),{status:404});}
  for(const bad of [null,{...owner,role:'store'},{...owner,role:'platform'},{...owner,storeId:'a'}])await assert.rejects(store.list(bad),{status:403});
  await assert.rejects(store.get(owner,'../../secret'),{status:404});
});

test('concurrent saves cannot overwrite newer drafts and deleted rows cannot silently resurrect',async()=>{
  const owner=actor(),store=createFlowStore(env),row=await store.save(owner,{messages:[],draft:'original'});
  const results=await Promise.allSettled(['one','two'].map(draft=>createFlowStore(env).save(owner,{...row,draft})));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.status,409);
  const current=await store.get(owner,row.id);assert.equal(current.version,2);
  await store.remove(owner,row.id);await store.remove(owner,row.id);assert.equal((await store.list(owner)).conversations.length,0);
  await assert.rejects(store.get(owner,row.id),{status:410});await assert.rejects(store.save(owner,{...current,draft:'stale'}),{status:410});
  const restored=await store.restore(owner,row.id);assert.equal(restored.draft,current.draft);assert.equal(restored.version,4);assert.deepEqual(await store.restore(owner,row.id),restored);
});

test('100 active conversation cap holds atomically for concurrent creation and restore',async()=>{
  const owner=actor(),store=createFlowStore(env),stamp=new Date().toISOString();
  await env.DB.batch(Array.from({length:99},()=>env.DB.prepare('INSERT INTO flow_conversations(tenant_id,user_id,id,title,data_json,version,updated_at) VALUES(?,?,?,?,?,1,?)').bind(owner.tenantId,owner.userId,crypto.randomUUID(),'seed','{"messages":[],"draft":""}',stamp)));
  const results=await Promise.allSettled([1,2].map(()=>createFlowStore(env).save(owner,{messages:[]})));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.status,409);
  const full=await store.list(owner);assert.equal(full.conversations.length,100);
  const deletedId=full.conversations[0].id;await store.remove(owner,deletedId);await store.save(owner,{messages:[]});
  await assert.rejects(store.restore(owner,deletedId),{status:409});await assert.rejects(store.get(owner,deletedId),{status:410});
});

test('artifacts are inert SVG, privately scoped, and cannot be attached across users',async()=>{
  const owner=actor(),store=createFlowStore(env),image=await store.createArtifact(owner,{svg,title:'库存概览'});
  assert.match(await store.getArtifact(owner,image.id),/库存概览/);
  const other={...owner,userId:'other'};await assert.rejects(store.getArtifact(other,image.id),{status:404});
  const row=await store.save(owner,{messages:[{role:'assistant',text:'图表',images:[image,{url:'https://evil.test/track'}]}]});assert.equal(row.messages[0].images.length,1);
  await assert.rejects(store.save(other,{messages:[{role:'assistant',text:'stolen',images:[image]}]}),{status:404});
  await assert.rejects(store.createArtifact(owner,{svg:svg.replace('<rect','<script>alert(1)</script><rect')}),{status:400});
  await assert.rejects(store.save(owner,{messages:[{role:'user',text:'x'.repeat(40001)}]}),{status:400});
  await assert.rejects(store.save(owner,{messages:[],draft:'x'.repeat(4001)}),{status:400});
});

test('leases survive independent request stores and an old owner cannot release a replacement lock',async()=>{
  let time=Date.now();const first=createFlowStore(env,{now:()=>time}),second=createFlowStore(env,{now:()=>time}),scope=crypto.randomUUID();
  const claims=await Promise.all([first.acquireLease(scope,'a',1000),second.acquireLease(scope,'b',1000)]);assert.equal(claims.filter(Boolean).length,1);
  const owner=claims[0]?'a':'b';await first.releaseLease(scope,'wrong');assert.equal(await second.acquireLease(scope,'new',1000),false);
  time+=1001;assert.equal(await second.acquireLease(scope,'replacement',1e9),true);
  await first.releaseLease(scope,owner);assert.equal(await first.acquireLease(scope,'old',1000),false);
  const raw=await env.DB.prepare('SELECT * FROM flow_leases WHERE scope=?').bind(scope).first();assert.equal(raw.expires_at,time+180000);
  await second.releaseLease(scope,'replacement');assert.equal(await first.acquireLease(scope,'after',1000),true);
});
