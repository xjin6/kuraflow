import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalFlowRuntime} from '../../scripts/flow/flow-local-runtime.mjs';
import {createFlowArchive,flowActorKey} from '../../scripts/flow/flow-archive.mjs';
import {createFlowStore} from '../../backend/flow-store.js';
import {getFlowPolicy} from '../../backend/flow-control.js';

const ORIGIN='http://localhost:8787';
const codeKey='a'.repeat(64);
const tokenA='gho_fake-local-runtime-tenant-a-token';
const tokenB='gho_fake-local-runtime-tenant-b-token';
const owner={role:'admin',accountRole:'owner',tenantId:'tenant-a',userId:'owner-a'};
const member={...owner,accountRole:'member',userId:'member-a'};
const other={...owner,tenantId:'tenant-b',userId:'owner-b'};
const platform={role:'platform',accountRole:'owner',userId:'platform-owner',displayName:'Platform'};
const models=[{id:'model-a',name:'Model A'},{id:'model-b',name:'Model B'}];
const hash=value=>createHash('sha256').update(value).digest('hex');
const migrationDir=new URL('../../backend/migrations/',import.meta.url);

class D1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    for(const file of readdirSync(migrationDir).filter(name=>name.endsWith('.sql')&&name<'0008').sort())this.sqlite.exec(readFileSync(new URL(file,migrationDir),'utf8'));
    for(const id of ['tenant-a','tenant-b','tenant-c','tenant-d'])this.addTenant(id);
    this.sqlite.exec(readFileSync(new URL('0008_tenant_features.sql',migrationDir),'utf8'));
    this.addAccount('owner-a','tenant-a');this.addAccount('owner-b','tenant-b');
  }
  addTenant(id){this.sqlite.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').run(id,'Kitchen '+id,'{"stores":[]}');}
  addAccount(id,tenantId,{role='admin',accountRole='owner',status='active',storeId=null}={}) {
    this.sqlite.prepare('INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,tenantId,storeId,role,accountRole,id,'',status,1);
  }
  prepare(sql) {
    const db=this.sqlite;
    const statement=(args=[])=>({bind:(...values)=>statement(values),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({success:true,meta:db.prepare(sql).run(...args)}),sync:()=>({success:true,meta:db.prepare(sql).run(...args)})});
    return statement();
  }
  async batch(statements){this.sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.sync());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  get(sql,...args){return this.sqlite.prepare(sql).get(...args);}
}

function request(route,body,actor='owner',extra={}) {
  return new Request(ORIGIN+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{Origin:ORIGIN,'Content-Type':'application/json','X-Test-Actor':actor},...extra});
}
async function body(response,status=200){assert.equal(response.status,status);return response.json();}
async function events(response){assert.equal(response.status,200);return (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function fixture(t,{chat}={}) {
  const privateDir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-local-runtime-'));
  const db=new D1(),calls={fetch:[],factory:[],chat:[],dispose:[],load:[]};
  const store=createFlowStore({DB:db,STORE_CODE_KEY:codeKey,LOCAL_TEST:'1'});
  const runtime=createLocalFlowRuntime({db,privateDir,codeKey,
    identity:async req=>({owner,member,other,platform,store:{role:'store',accountRole:'owner',tenantId:'tenant-a',storeId:'store-a',userId:'store-owner'}}[req.headers.get('X-Test-Actor')]||null),
    fetchImpl:async(url,init)=>{
      calls.fetch.push({url,init});assert.equal(init.redirect,'manual');
      if(url==='https://api.github.com/user')return Response.json({login:'private-test-login'});
      if(url==='https://api.github.com/copilot_internal/v2/token')return Response.json({token:'fake-exchanged-copilot-token'});
      if(url==='https://api.githubcopilot.com/models')return Response.json({data:models});
      throw new Error('Unexpected upstream request');
    },
    copilotFactory:options=>{
      calls.factory.push(options);
      return {async chat(args){calls.chat.push({args,options});if(chat)return chat(args);args.onEvent({type:'message',text:'已读取当前厨房。'});},async dispose(){calls.dispose.push(options);}};
    },
    loadData:async(database,principal)=>{assert.equal(database,db);calls.load.push(principal);return {index:{products:0,orders:0,complete:true}};},
  });
  t.after(async()=>{await runtime.dispose();db.sqlite.close();await fs.rm(privateDir,{recursive:true,force:true});});
  async function legacy(tenantId,value={provider:'copilot',githubToken:tokenA,copilotModel:'model-a'}) {
    const file=path.join(privateDir,'flow-providers',hash(tenantId)+'.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));return file;
  }
  const handle=(route,value,actor,extra)=>runtime.handle(request(route,value,actor,extra));
  const connect=async(tenantId='tenant-a',token=tokenA)=>body(await handle('/api/platform/flow/connection',{tenantId,token},'platform'));
  const savePolicy=async(enabled,{tenantId='tenant-a',model='model-b'}={})=>{
    const policy=await getFlowPolicy(db,tenantId);
    return body(await handle('/api/platform/flow',{tenantId,version:policy.version,enabled,...(model?{model}:{})},'platform'));
  };
  return {runtime,privateDir,db,calls,store,legacy,handle,connect,savePolicy};
}

test('imports only this app’s active management-owner connections, encrypting D1 without changing legacy files or archive',async t=>{
  const h=await fixture(t);
  h.db.sqlite.prepare('UPDATE staff_accounts SET status=? WHERE id=?').run('disabled','owner-b');
  h.db.addAccount('member-c','tenant-c',{accountRole:'member'});
  h.db.addAccount('store-d','tenant-d',{role:'store',storeId:'store-d'});
  const file=await h.legacy('tenant-a');const original=await fs.readFile(file,'utf8');
  for(const id of ['tenant-b','tenant-c','tenant-d','unknown'])await h.legacy(id);
  const archive=createFlowArchive({privateDir:h.privateDir});
  const image=await archive.createArtifact(owner,{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect x="0" y="0" width="800" height="500" fill="#fff"/></svg>',title:'原有图片'});
  const saved=await archive.save(owner,{messages:[{role:'user',text:'原有问题'},{role:'assistant',text:'原有回答',images:[image]}],draft:'保留本地草稿'});
  const result=await h.runtime.importConnections();assert.deepEqual(result,{imported:1});
  const connection=await h.store.getConnection(owner);assert.equal(connection.data.githubToken,tokenA);assert.equal(connection.data.model,'model-a');
  const cipher=h.db.get('SELECT data_cipher FROM flow_connections WHERE tenant_id=?','tenant-a').data_cipher;
  assert.doesNotMatch(cipher,/gho_|local-runtime|model-a/);assert.equal(h.db.get('SELECT COUNT(*) AS n FROM flow_connections').n,1);
  assert.deepEqual(await getFlowPolicy(h.db,'tenant-a'),{enabled:true,model:null,version:1});
  assert.equal(await fs.readFile(file,'utf8'),original);
  assert.deepEqual(await archive.get(owner,saved.id),saved);
  const visible=await body(await h.handle('/api/flow/conversations/'+saved.id));assert.deepEqual(visible.conversation,saved);
  assert.match(await (await h.handle(image.url)).text(),/<rect/);
  assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.factory.length,0);
});

test('repeat import cannot restore an old token or override platform disable and model changes',async t=>{
  const h=await fixture(t);const file=await h.legacy('tenant-a');await h.runtime.importConnections();
  await h.savePolicy(false,{model:null});
  assert.deepEqual(await h.runtime.importConnections(),{imported:0});assert.equal((await getFlowPolicy(h.db,'tenant-a')).enabled,false);
  await h.connect('tenant-a',tokenB);await h.savePolicy(true,{model:'model-b'});
  const before=await getFlowPolicy(h.db,'tenant-a');
  assert.deepEqual(await h.runtime.importConnections(),{imported:0});assert.deepEqual(await getFlowPolicy(h.db,'tenant-a'),before);
  assert.equal((await h.store.getConnection(owner)).data.githubToken,tokenB);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).githubToken,tokenA);
  assert.doesNotMatch(JSON.stringify(await body(await h.handle('/api/platform/flow?tenant=tenant-a',undefined,'platform'))),/gho_|private-test-login|githubToken/);
});

test('missing, malformed and unrelated legacy provider files are ignored without fallback credentials',async t=>{
  const h=await fixture(t);
  assert.deepEqual(await h.runtime.importConnections(),{imported:0});
  const file=await h.legacy('tenant-a');
  for(const contents of ['not-json',JSON.stringify({provider:'api',githubToken:tokenA}),JSON.stringify({provider:'copilot',githubToken:'short'}),JSON.stringify({provider:'copilot',githubToken:tokenA+'\n'}),'x'.repeat(20001)]) {
    await fs.writeFile(file,contents);
    assert.deepEqual(await h.runtime.importConnections(),{imported:0});assert.equal(await fs.readFile(file,'utf8'),contents);
  }
  assert.equal(await h.store.getConnection(owner),null);assert.equal((await getFlowPolicy(h.db,'tenant-a')).enabled,false);
  assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.factory.length,0);
});

test('first import does not undo an explicit platform disable for a newly created tenant',async t=>{
  const h=await fixture(t);h.db.addTenant('new');h.db.addAccount('owner-new','new');
  await h.savePolicy(false,{tenantId:'new',model:null});
  const before=await getFlowPolicy(h.db,'new');assert.equal(before.version,1);assert.equal(before.enabled,false);
  await h.legacy('new');await h.runtime.importConnections();
  assert.deepEqual(await getFlowPolicy(h.db,'new'),before);
});

test('unconfigured or disabled management gets inert status and cannot configure Flow; runtime is loopback-only',async t=>{
  const h=await fixture(t);
  const status=await body(await h.handle('/api/flow/status'));
  assert.equal(status.enabled,false);assert.equal(status.available,false);assert.equal(status.managed,true);assert.equal(status.models,undefined);
  for(const actor of ['owner','member'])for(const [route,value] of [['/api/flow/provider',{model:'model-a'}],['/api/flow/auth/token',{token:tokenA}],['/api/flow/auth/start',{}],['/api/flow/auth/poll',{authId:'x'}],['/api/platform/flow/connection',{tenantId:'tenant-a',token:tokenA}],['/api/flow/chat',{message:'查询'}]])assert.equal((await h.handle(route,value,actor)).status,403);
  for(const actor of ['platform','store','none'])assert.equal((await h.handle('/api/flow/status',undefined,actor)).status,actor==='none'?401:403);
  for(const origin of ['https://localhost:8787','http://example.com:8787'])assert.equal((await h.runtime.handle(new Request(origin+'/api/flow/status'))).status,403);
  assert.equal(await h.handle('/api/unrelated'),null);
  assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.factory.length,0);assert.equal(h.calls.load.length,0);
});

test('platform token and pinned model drive the local SDK with tenant-isolated clients and no ambient login',async t=>{
  const h=await fixture(t);await h.legacy('tenant-a',{provider:'copilot',githubToken:'gho_legacy-token-must-not-be-used',model:'model-a'});
  const connected=await h.connect();assert.equal(connected.flow.enabled,false);assert.equal(connected.connection.hasToken,true);
  await h.savePolicy(true);
  const status=await body(await h.handle('/api/flow/status',undefined,'member'));
  assert.equal(status.available,true);assert.equal(status.model,'model-b');assert.equal(status.modelName,'Model B');
  assert.doesNotMatch(JSON.stringify(status),/models|github|Token|private-test|fetchedAt/);
  assert.equal((await h.handle('/api/flow/chat',{message:'查询',model:'model-a'})).status,403);
  const response=await events(await h.handle('/api/flow/chat',{message:'查询',tenantId:'tenant-b'},'member'));
  assert.equal(response.at(-1).type,'done');assert.equal(response.at(-1).model,'model-b');
  assert.equal(h.calls.factory.length,1);assert.equal(h.calls.factory[0].gitHubToken,tokenA);assert.equal(h.calls.factory[0].useLoggedInUser,false);
  assert.ok(h.calls.factory[0].privateDir.startsWith(path.join(h.privateDir,'flow-runtime-tenants',hash('tenant-a'))));
  assert.ok(!h.calls.factory[0].privateDir.includes(tokenA));assert.equal(h.calls.chat[0].args.model,'model-b');assert.deepEqual(h.calls.chat[0].args.principal,member);
  await events(await h.handle('/api/flow/chat',{message:'下一条'}));assert.equal(h.calls.factory.length,1);
  await h.connect('tenant-b',tokenB);await h.savePolicy(true,{tenantId:'tenant-b',model:'model-a'});
  await events(await h.handle('/api/flow/chat',{message:'其他厨房'},'other'));
  assert.equal(h.calls.factory.length,2);assert.equal(h.calls.factory[1].gitHubToken,tokenB);assert.notEqual(h.calls.factory[1].privateDir,h.calls.factory[0].privateDir);
  assert.deepEqual(h.calls.load.map(p=>p.tenantId),['tenant-a','tenant-a','tenant-b']);
  await h.connect('tenant-a',tokenB);await events(await h.handle('/api/flow/chat',{message:'更新后'}));assert.equal(h.calls.factory.length,3);
  assert.equal(h.calls.factory[2].gitHubToken,tokenB);assert.notEqual(h.calls.factory[2].privateDir,h.calls.factory[0].privateDir);
  await h.runtime.dispose();assert.equal(h.calls.dispose.length,3);
  assert.equal((await h.handle('/api/flow/status')).status,503);
});

test('disabled local Flow keeps filesystem history and images intact and restores only the same actor’s archive',async t=>{
  const h=await fixture(t);await h.connect();await h.savePolicy(true);
  const archive=createFlowArchive({privateDir:h.privateDir});
  const image=await archive.createArtifact(owner,{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><circle cx="100" cy="100" r="30" fill="#548abf"/></svg>',title:'原有图表'});
  const saved=await body(await h.handle('/api/flow/conversations',{messages:[{role:'user',text:'现有对话'},{role:'assistant',text:'图表',images:[image]}],draft:'未发送草稿'}));
  const filename=path.join(h.privateDir,'flow-conversations',flowActorKey(owner),saved.conversation.id+'.json'),original=await fs.readFile(filename,'utf8');
  const originalImage=await archive.getArtifact(owner,image.id);
  const privateMember=await archive.save(member,{messages:[{role:'user',text:'员工个人问题'}],draft:'员工草稿'});
  await h.savePolicy(false);
  assert.equal((await body(await h.handle('/api/flow/status'))).available,false);
  for(const route of ['/api/flow/conversations','/api/flow/conversations/'+saved.conversation.id,image.url])assert.equal((await h.handle(route)).status,403);
  assert.equal((await h.handle('/api/flow/conversations/'+saved.conversation.id+'/delete',{})).status,403);
  assert.equal(await fs.readFile(filename,'utf8'),original);assert.equal((await archive.get(owner,saved.conversation.id)).draft,'未发送草稿');
  assert.equal(await archive.getArtifact(owner,image.id),originalImage);
  await h.savePolicy(true);
  const restored=await body(await h.handle('/api/flow/conversations/'+saved.conversation.id));assert.deepEqual(restored,saved);
  assert.equal(await (await h.handle(image.url)).text(),originalImage);
  const list=await body(await h.handle('/api/flow/conversations',undefined,'member'));assert.deepEqual(list.conversations.map(row=>row.id),[privateMember.id]);
  assert.equal((await h.handle('/api/flow/conversations/'+saved.conversation.id,undefined,'member')).status,404);
  assert.equal((await h.handle(image.url,undefined,'member')).status,404);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM flow_conversations').n,0);
});

test('platform disable during SDK inference blocks subsequent output and releases the local D1 lease',async t=>{
  let h;
  h=await fixture(t,{chat:async args=>{await h.savePolicy(false);args.onEvent({type:'message',text:'REVOKED_ANSWER_MUST_NOT_APPEAR'});}});
  await h.connect();await h.savePolicy(true);
  const result=await events(await h.handle('/api/flow/chat',{message:'生成中停用'}));
  assert.ok(result.some(row=>row.type==='error'));assert.ok(!result.some(row=>row.type==='done'));
  assert.doesNotMatch(JSON.stringify(result),/REVOKED_ANSWER/);
  assert.equal((await body(await h.handle('/api/flow/status'))).enabled,false);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM flow_leases').n,0);
});
