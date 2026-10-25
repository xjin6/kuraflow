import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {scryptSync,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../../backend/worker.js';
import {hashToken} from '../../backend/auth.js';

const origin='https://platform-customer.example',oldPassword='Fixture password before reset!',newPassword='New fixture password after reset!';
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
let runtime,env,platform,platformId,passwordHash,serial=0;
const media=new Map();
const stamp=()=>Math.floor(Date.now()/1000);

before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'platform-customer-tests',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'platform-customers'}}]}));
  const DB=await runtime.getD1Database('DB');
  for(const file of (await readdir(new URL('../../backend/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())await DB.exec((await readFile(new URL('../../backend/migrations/'+file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env={DB,PUBLIC_ORIGIN:origin,STORE_CODE_KEY:'2'.repeat(64),MEDIA:{get:async key=>media.get(key)||null}};
  const salt=randomBytes(16).toString('hex');passwordHash=`scrypt$32768$8$3$${salt}$${scryptSync(oldPassword,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex')}`;
  platformId=crypto.randomUUID();await account({id:platformId,role:'platform',accountRole:'owner'});platform=await session(platformId);
});
after(async()=>runtime?.dispose());
async function account({id=crypto.randomUUID(),tenantId=null,storeId=null,role=storeId?'store':'admin',accountRole='member',status='active',hasPassword=accountRole==='member'}={}){
  await env.DB.prepare('INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,'fixture-'+id.slice(0,24),tenantId,storeId,role,accountRole,'账户 '+id,'contact-'+id,status,hasPassword?passwordHash:null,stamp()).run();return id;
}
async function session(id){const token=randomBytes(32).toString('hex');const row=await env.DB.prepare('SELECT version FROM staff_accounts WHERE id=?').bind(id).first();await env.DB.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,?)').bind(await hashToken(token),id,stamp()+3600,row.version).run();return '__Host-kuraflow_account='+token;}
async function request(path,body,cookie=platform,overrides={}){
  const response=await worker.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':`192.0.2.${++serial%240+1}`,...overrides.headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),overrides.env||env,{});
  const data=response.headers.get('Content-Type')?.startsWith('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return {status:response.status,headers:response.headers,data};
}
function ok(result,status=200){assert.equal(result.status,status,JSON.stringify(result.data));return result.data;}
async function fixture(){
  const tenantId=crypto.randomUUID(),otherId=crypto.randomUUID(),image=crypto.randomUUID(),foreignImage=crypto.randomUUID();
  const store={id:'shared-store',name:'门店完整资料',city:'大阪市',prefecture:'大阪府',municipality:'大阪市',ward:'中央区',addressDetail:'難波1-1',address:'大阪府大阪市中央区難波1-1',prefectureCode:'27',municipalityCode:'27100',wardCode:'27128',phone:'090-0000-0000',contact:'店负责人',route:'大阪路线',image:'/api/images/'+image,accessCode:'DO-NOT-LEAK',password:'DO-NOT-LEAK',extra:{secret:'DO-NOT-LEAK'}};
  const core={stores:[store,{id:'deleted-store',name:'已删除门店',deletedAt:'2026-10-20T00:00:00Z',image:'/api/images/'+image},{id:'no-owner',name:'未生成负责人码'},{id:'inline-image',name:'旧版图片',image:'data:image/png;base64,'+png.toString('base64')},{id:'external-image',name:'外部图片',image:'https://external.invalid/secret.png'},{id:'foreign-image',name:'错误图片',image:'/api/images/'+foreignImage}],settings:{privateKey:'DO-NOT-LEAK'},prices:{hidden:123},privateToken:'DO-NOT-LEAK'};
  for(const [id,data] of [[tenantId,core],[otherId,{stores:[{id:'shared-store',name:'其他客户门店'}]}]])await env.DB.batch([env.DB.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').bind(id,'客户 '+id,JSON.stringify(data)),env.DB.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)').bind(id,'ORG-'+id,stamp())]);
  const owner=await account({tenantId,accountRole:'owner'}),manager=await account({tenantId}),storeOwner=await account({tenantId,storeId:'shared-store',accountRole:'owner'}),storeMember=await account({tenantId,storeId:'shared-store'}),deletedOwner=await account({tenantId,storeId:'deleted-store',accountRole:'owner',status:'disabled'}),deletedMember=await account({tenantId,storeId:'deleted-store',status:'disabled'}),pending=await account({tenantId,storeId:'shared-store',status:'pending',hasPassword:false}),foreignMember=await account({tenantId:otherId,storeId:'shared-store'});
  await env.DB.prepare("INSERT INTO account_keys(account_id,kind,key_hash,key_cipher,created_at) VALUES(?,'master',?,?,?)").bind(storeOwner,await hashToken('test-master-'+storeOwner),'DO-NOT-LEAK-CIPHER',stamp()).run();
  for(const [id,tenant] of [[image,tenantId],[foreignImage,otherId]]){await env.DB.prepare('INSERT INTO media_files(id,tenant_id,object_key,mime,bytes,created_at) VALUES(?,?,?,?,?,?)').bind(id,tenant,tenant+'/'+id,'image/png',png.length,new Date().toISOString()).run();media.set(tenant+'/'+id,png);}
  return {tenantId,otherId,core,image,foreignImage,owner,manager,storeOwner,storeMember,deletedOwner,deletedMember,pending,foreignMember};
}
const customerUrl=f=>'/api/platform/customer?'+new URLSearchParams({tenant:f.tenantId});
const imageUrl=(f,store='shared-store')=>'/api/platform/store-image?'+new URLSearchParams({tenant:f.tenantId,store});
const resetBody=(f,accountId=f.storeMember,storeId='shared-store',version=0)=>({tenantId:f.tenantId,storeId,accountId,version,password:newPassword});
async function row(id){return env.DB.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(id).first();}
async function counts(id){const result=await env.DB.batch(['account_sessions','account_invites'].map(table=>env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).bind(id)));return result.map(x=>x.results[0].n);}

test('platform customer overview is read-only, explicitly scoped and never returns credentials',async()=>{
  const f=await fixture();const before=await env.DB.prepare('SELECT id,version,status FROM staff_accounts WHERE tenant_id=? ORDER BY id').bind(f.tenantId).all();
  const result=await request(customerUrl(f)),data=ok(result);
  assert.equal(data.customer.id,f.tenantId);assert.equal(data.customer.active,true);assert.equal(data.stores.length,f.core.stores.length);
  assert.deepEqual(data.managementAccounts.map(a=>a.id).sort(),[f.owner,f.manager].sort());
  const store=data.stores.find(s=>s.id==='shared-store');for(const key of ['name','city','prefecture','municipality','ward','addressDetail','address','prefectureCode','municipalityCode','wardCode','phone','contact','route'])assert.equal(store[key],f.core.stores[0][key]);
  assert.equal(store.imageUrl,imageUrl(f));assert.equal(store.hasMaster,true);assert.equal(store.accounts.find(a=>a.id===f.storeOwner).hasPassword,false);assert.equal(store.accounts.find(a=>a.id===f.storeOwner).credentialType,'master-code');
  assert.equal(store.accounts.find(a=>a.id===f.storeMember).hasPassword,true);assert.equal(store.accounts.find(a=>a.id===f.pending).hasPassword,false);
  assert.equal(data.stores.find(s=>s.id==='deleted-store').accounts.find(a=>a.id===f.deletedMember).status,'disabled');
  assert.deepEqual(data.stores.find(s=>s.id==='no-owner').accounts,[]);assert.equal(data.stores.find(s=>s.id==='no-owner').hasMaster,false);
  assert.ok(!JSON.stringify(data).includes(f.foreignMember));assert.doesNotMatch(JSON.stringify(data),/DO-NOT-LEAK|password_hash|key_hash|key_cipher|privateToken|privateKey|"prices"/);
  assert.equal(data.stores.find(s=>s.id==='external-image').imageUrl,null);assert.equal(data.stores.find(s=>s.id==='foreign-image').imageUrl,null);
  assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal(result.headers.get('X-Content-Type-Options'),'nosniff');
  assert.deepEqual((await env.DB.prepare('SELECT id,version,status FROM staff_accounts WHERE tenant_id=? ORDER BY id').bind(f.tenantId).all()).results,before.results);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE account_id=?').bind(f.deletedOwner).first()).n,0);
});

test('platform directory reads allow platform members while credentials remain owner-only',async()=>{
  const f=await fixture(),platformMember=await account({role:'platform',accountRole:'member'});
  for(const [cookie,status] of [['',401],...[f.owner,f.manager,f.storeOwner,f.storeMember].map(id=>[id,403])]){
    const actual=cookie?await session(cookie):'';
    for(const [url,body] of [[customerUrl(f),undefined],[imageUrl(f),undefined],['/api/platform/staff/password',resetBody(f)]])ok(await request(url,body,actual),status);
  }
  const memberSession=await session(platformMember);
  ok(await request(customerUrl(f),undefined,memberSession));
  ok(await request(imageUrl(f),undefined,memberSession));
  ok(await request('/api/platform/staff/password',resetBody(f),memberSession),403);
  ok(await request('/api/team/master-key',{tenantId:f.tenantId,storeId:'shared-store'},await session(platformMember)),403);
  ok(await request('/api/platform/customer?tenant=missing'),404);ok(await request('/api/platform/customer'),400);
});

test('platform store images require the assigned tenant/store image and support deleted and bounded inline photos',async()=>{
  const f=await fixture();
  for(const store of ['shared-store','deleted-store','inline-image']){const r=await request(imageUrl(f,store));assert.deepEqual(ok(r),png);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Content-Type'),'image/png');assert.equal(r.headers.get('Cross-Origin-Resource-Policy'),'same-origin');}
  for(const store of ['missing','no-owner','external-image','foreign-image'])ok(await request(imageUrl(f,store)),404);
  ok(await request('/api/images/'+f.image),403);
  ok(await request('/api/platform/store-image?'+new URLSearchParams({tenant:f.otherId,store:'shared-store'})),404);
  f.core.stores.find(s=>s.id==='inline-image').image='data:image/png;base64,'+Buffer.from('<svg onload="alert(1)">').toString('base64');
  await env.DB.prepare('UPDATE tenants SET core_json=? WHERE id=?').bind(JSON.stringify(f.core),f.tenantId).run();ok(await request(imageUrl(f,'inline-image')),404);
  f.core.stores[0].image='data:image/png;base64,'+Buffer.concat([png,Buffer.alloc(204800)]).toString('base64');
  await env.DB.prepare('UPDATE tenants SET core_json=? WHERE id=?').bind(JSON.stringify(f.core),f.tenantId).run();ok(await request(imageUrl(f)),404);
});

test('reset changes only the named member password, revokes their sessions/invites and audits no secret',async()=>{
  const f=await fixture(),targetBefore=await row(f.storeMember),othersBefore=await env.DB.prepare('SELECT * FROM staff_accounts WHERE tenant_id=? AND id!=? ORDER BY id').bind(f.tenantId,f.storeMember).all();
  const targetCookie=await session(f.storeMember),otherCookie=await session(f.manager);await session(f.storeMember);
  await env.DB.prepare('INSERT INTO account_invites(hash,account_id,expires,version) VALUES(?,?,?,0)').bind(await hashToken('invite-'+f.storeMember),f.storeMember,stamp()+3600).run();
  assert.deepEqual(await counts(f.storeMember),[2,1]);
  const result=ok(await request('/api/platform/staff/password',resetBody(f)));assert.equal(result.account.version,1);assert.equal(result.account.hasPassword,true);assert.doesNotMatch(JSON.stringify(result),/password_hash|key_cipher/);assert.ok(!JSON.stringify(result).includes(newPassword));
  const targetAfter=await row(f.storeMember);assert.notEqual(targetAfter.password_hash,targetBefore.password_hash);assert.match(targetAfter.password_hash,/^scrypt\$/);assert.equal(targetAfter.version,1);
  for(const field of ['login_id','tenant_id','store_id','role','account_role','name','contact','status','created_at'])assert.equal(targetAfter[field],targetBefore[field]);
  assert.deepEqual(await counts(f.storeMember),[0,0]);assert.equal(ok(await request('/api/accounts/session',undefined,targetCookie)).authenticated,false);assert.equal(ok(await request('/api/accounts/session',undefined,otherCookie)).authenticated,true);
  assert.deepEqual((await env.DB.prepare('SELECT * FROM staff_accounts WHERE tenant_id=? AND id!=? ORDER BY id').bind(f.tenantId,f.storeMember).all()).results,othersBefore.results);
  ok(await request('/api/accounts/login',{username:targetAfter.login_id,password:oldPassword,portal:'store'},''),401);ok(await request('/api/accounts/login',{username:targetAfter.login_id,password:newPassword,portal:'store'},''));
  const audit=await env.DB.prepare('SELECT * FROM account_audit WHERE target_id=?').bind(f.storeMember).all();assert.equal(audit.results.length,1);assert.equal(audit.results[0].action,'平台重置管理员密码');assert.ok(!JSON.stringify(audit).includes(newPassword));assert.ok(!JSON.stringify(audit).includes(passwordHash));
});

test('reset accepts management members and preserves pending/disabled states without touching usernames',async()=>{
  const f=await fixture();await env.DB.prepare("UPDATE staff_accounts SET status='disabled' WHERE id=?").bind(f.manager).run();
  for(const [id,storeId,status] of [[f.manager,null,'disabled'],[f.pending,'shared-store','pending']]){const before=await row(id),result=ok(await request('/api/platform/staff/password',resetBody(f,id,storeId)));assert.equal(result.account.status,status);assert.equal(result.account.username,before.login_id);assert.equal((await row(id)).status,status);}
});

test('reset rejects foreign scopes, owners, removed stores, invalid shape/password, stale version and cross-origin',async()=>{
  const f=await fixture(),base=resetBody(f),before=await row(f.storeMember);
  for(const [body,status] of [[{...base,tenantId:f.otherId},404],[{...base,storeId:null},404],[{...base,accountId:f.foreignMember},404],[{...base,accountId:f.owner,storeId:null},404],[{...base,accountId:f.storeOwner},404],[{...base,accountId:platformId},404],[{...base,accountId:f.deletedMember,storeId:'deleted-store'},404],[{...base,password:'short'},400],[{...base,password:'x'.repeat(129)},400],[{...base,password:123},400],[{...base,version:-1},409],[{...base,version:'0'},409],[{...base,version:2},409],[{...base,status:'active'},400],[{tenantId:f.tenantId,accountId:f.manager,version:0,password:newPassword},400]])ok(await request('/api/platform/staff/password',body),status);
  ok(await request('/api/platform/staff/password',base,platform,{headers:{Origin:'https://foreign.invalid'}}),403);
  assert.deepEqual(await row(f.storeMember),before);assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_audit WHERE target_id=?').bind(f.storeMember).first()).n,0);
});

test('simultaneous platform password resets permit exactly one matching version',async()=>{
  const f=await fixture(),body=resetBody(f),responses=await Promise.all([request('/api/platform/staff/password',body),request('/api/platform/staff/password',{...body,password:newPassword+' two'})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await row(f.storeMember)).version,1);assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_audit WHERE target_id=?').bind(f.storeMember).first()).n,1);
});

test('store deletion racing password hashing aborts the entire reset',async()=>{
  const f=await fixture(),before=await row(f.storeMember);await session(f.storeMember);
  let raced=false;const DB={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{if(!raced){raced=true;f.core.stores[0].deletedAt='2026-10-20';await env.DB.prepare('UPDATE tenants SET core_json=? WHERE id=?').bind(JSON.stringify(f.core),f.tenantId).run();}return env.DB.batch(statements);}};
  ok(await request('/api/platform/staff/password',resetBody(f),platform,{env:{...env,DB}}),409);assert.equal(raced,true);assert.deepEqual(await row(f.storeMember),before);assert.deepEqual(await counts(f.storeMember),[1,0]);assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_audit WHERE target_id=?').bind(f.storeMember).first()).n,0);
});

test('an audit/storage failure rolls back password, version and session revocation',async()=>{
  const f=await fixture(),before=await row(f.storeMember);await session(f.storeMember);
  const trigger='test_reset_failure';await env.DB.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON account_audit WHEN NEW.action='平台重置管理员密码' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END`);
  try{ok(await request('/api/platform/staff/password',resetBody(f)),500);assert.deepEqual(await row(f.storeMember),before);assert.deepEqual(await counts(f.storeMember),[1,0]);}finally{await env.DB.exec('DROP TRIGGER '+trigger);}
});
