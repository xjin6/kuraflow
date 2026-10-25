import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,scryptSync} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../../backend/worker.js';
import {hashToken} from '../../backend/auth.js';

const origin='https://staff-deletion.example.test',password='Synthetic staff deletion password!';
const stamp=()=>Math.floor(Date.now()/1000);
let runtime,env,passwordHash,serial=0,platform;
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,check]);}
const pngHeader=Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]);
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',pngHeader),chunk('IDAT',deflateSync(Buffer.from([0,45,90,160,255]))),chunk('IEND',Buffer.alloc(0))]);
const image='data:image/png;base64,'+png.toString('base64');

before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'staff-deletion-test',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'staff-deletion-test'}}]}));
  const DB=await runtime.getD1Database('DB');
  for(const file of (await readdir(new URL('../../backend/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())await DB.exec((await readFile(new URL('../../backend/migrations/'+file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env={DB,PUBLIC_ORIGIN:origin,LOCAL_TEST:'0',STORE_CODE_KEY:'4'.repeat(64)};
  const salt=randomBytes(16).toString('hex');passwordHash=`scrypt$32768$8$3$${salt}$${scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex')}`;
  platform=await person({role:'platform',accountRole:'owner'});
});
after(async()=>runtime?.dispose());
async function request(path,body,cookie=platform.cookie,extra={}){
  const response=await worker.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':`198.51.100.${++serial%240+1}`,...extra.headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),extra.env||env,{});
  return {status:response.status,data:response.headers.get('Content-Type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
function ok(result,status=200){assert.equal(result.status,status,JSON.stringify(result.data));return result.data;}
async function row(id){return env.DB.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(id).first();}
async function session(id){const token=randomBytes(32).toString('hex'),current=await row(id);await env.DB.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,?)').bind(await hashToken(token),id,stamp()+3600,current.version).run();return '__Host-kuraflow_account='+token;}
async function person({tenantId=null,storeId=null,role=storeId?'store':'admin',accountRole='member',status='active'}={}){
  const id='staff-person-'+(++serial),loginId='test_'+id;
  await env.DB.prepare('INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,loginId,tenantId,storeId,role,accountRole,'测试人员 '+id,'contact-'+id,status,accountRole==='member'?passwordHash:null,stamp()).run();
  return {id,tenantId,storeId,role,accountRole,loginId,cookie:await session(id)};
}
async function fixture(){
  const tenantId='staff-tenant-'+(++serial),otherId='staff-tenant-'+(++serial),core={stores:[{id:'store-a',name:'测试门店甲'},{id:'store-b',name:'测试门店乙'}],settings:{companyName:'测试厨房'},manualTasks:[{id:'existing-todo',title:'保留原待办',source:'manual'}]};
  for(const id of [tenantId,otherId])await env.DB.batch([env.DB.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').bind(id,'测试厨房',JSON.stringify(core)),env.DB.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)').bind(id,'ORG-'+id,stamp())]);
  const owner=await person({tenantId,accountRole:'owner'}),member=await person({tenantId}),other=await person({tenantId}),storeOwner=await person({tenantId,storeId:'store-a',accountRole:'owner'}),storeMember=await person({tenantId,storeId:'store-a'}),sibling=await person({tenantId,storeId:'store-b'}),foreignOwner=await person({tenantId:otherId,accountRole:'owner'}),foreign=await person({tenantId:otherId}),platformMember=await person({role:'platform'});
  return {tenantId,otherId,core,owner,member,other,storeOwner,storeMember,sibling,foreignOwner,foreign,platformMember};
}
const mutation=(person,version=0)=>({accountId:person.id,version});
const team=(cookie,query='')=>request('/api/team/list'+query,undefined,cookie).then(result=>ok(result));
async function counts(id){const result=await env.DB.batch(['account_sessions','account_invites'].map(table=>env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).bind(id)));return result.map(value=>value.results[0].n);}
async function principalValid(cookie){return ok(await request('/api/accounts/session',undefined,cookie)).authenticated;}
function racingDB(intercept){
  const db=env.DB;let done=false,proxy;
  proxy=new Proxy(db,{get(base,key){if(key==='withSession')return ()=>proxy;if(key==='batch')return async statements=>{if(!done){done=true;await intercept();}return db.batch(statements);};const value=base[key];return typeof value==='function'?value.bind(base):value;}});
  return proxy;
}

test('deleting and restoring a member preserves identity, avatar and business history while revoking access',async()=>{
  const f=await fixture(),targetBefore=await row(f.member.id),tenantBefore=await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(f.tenantId).first();
  const avatar=ok(await request('/api/team/avatar',{accountId:f.member.id,version:0,image},f.owner.cookie)).account;
  await env.DB.prepare('INSERT INTO account_invites(hash,account_id,expires,version) VALUES(?,?,?,0)').bind(await hashToken('fixture-invite-'+f.member.id),f.member.id,stamp()+3600).run();
  const deleted=ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie)).account;
  assert.equal(deleted.id,f.member.id);assert.equal(deleted.version,1);assert.equal(deleted.status,'disabled');assert.ok(deleted.deletedAt>0);assert.equal(deleted.avatarUrl,avatar.avatarUrl);assert.equal(deleted.avatarVersion,1);
  assert.equal(await principalValid(f.member.cookie),false);assert.equal(await principalValid(f.other.cookie),true);assert.deepEqual(await counts(f.member.id),[0,0]);
  ok(await request('/api/accounts/login',{username:f.member.loginId,password,portal:'kitchen'},''),401);
  const targetAfter=await row(f.member.id);for(const key of ['id','login_id','tenant_id','store_id','role','account_role','name','contact','password_hash','created_at'])assert.equal(targetAfter[key],targetBefore[key]);
  const archived=(await team(f.owner.cookie)).accounts.find(item=>item.id===f.member.id);assert.equal(archived.deletedAt,deleted.deletedAt);assert.equal(archived.version,1);
  assert.equal((await team(f.other.cookie)).accounts.some(item=>item.id===f.member.id),false);
  const directory=ok(await request('/api/platform/customer?tenant='+f.tenantId));assert.equal(directory.managementAccounts.find(item=>item.id===f.member.id).deletedAt,deleted.deletedAt);
  assert.doesNotMatch(JSON.stringify(directory),/password_hash|key_hash|key_cipher/);
  assert.deepEqual((await request(avatar.avatarUrl,undefined,f.owner.cookie)).data,png);
  ok(await request(avatar.avatarUrl,undefined,f.other.cookie),404);
  const restored=ok(await request('/api/team/restore',mutation(f.member,1))).account;
  assert.equal(restored.deletedAt,null);assert.equal(restored.version,2);assert.equal(restored.status,'disabled');assert.equal(restored.avatarUrl,avatar.avatarUrl);
  assert.equal((await row(f.member.id)).password_hash,targetBefore.password_hash);assert.equal(await principalValid(f.member.cookie),false);
  ok(await request('/api/accounts/login',{username:f.member.loginId,password,portal:'kitchen'},''),401);
  assert.deepEqual(await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(f.tenantId).first(),tenantBefore);
  const audit=(await env.DB.prepare("SELECT action FROM account_audit WHERE target_id=? AND action IN ('删除管理员','恢复管理员') ORDER BY rowid").bind(f.member.id).all()).results.map(item=>item.action);assert.deepEqual(audit,['删除管理员','恢复管理员']);
});

test('platform and scoped owners may archive members but owners, self-service and foreign scopes are protected',async()=>{
  const f=await fixture();
  for(const cookie of ['',f.member.cookie,f.other.cookie,f.platformMember.cookie])ok(await request('/api/team/delete',mutation(f.member),cookie),cookie?403:401);
  for(const target of [f.owner,f.storeOwner,platform])ok(await request('/api/team/delete',mutation(target)),403);
  ok(await request('/api/team/delete',mutation(f.member),f.foreignOwner.cookie),403);
  ok(await request('/api/team/delete',mutation(f.sibling),f.storeOwner.cookie),403);
  const deleted=ok(await request('/api/team/delete',mutation(f.storeMember),f.storeOwner.cookie)).account;
  assert.ok(deleted.deletedAt);ok(await request('/api/team/restore',mutation(f.storeMember,1),f.owner.cookie));
  ok(await request('/api/team/delete',mutation(f.member)),200);
  for(const cookie of [f.other.cookie,f.foreignOwner.cookie])ok(await request('/api/team/restore',mutation(f.member,1),cookie),403);
});

test('delete and restore require exact fields and fresh versions and concurrent retries mutate once',async()=>{
  const f=await fixture();
  for(const body of [{},{accountId:f.member.id},{accountId:f.member.id,version:'0'},{accountId:f.member.id,version:-1},{accountId:f.member.id,version:0,status:'active'}])assert.ok([400,409].includes((await request('/api/team/delete',body)).status));
  ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie,{headers:{Origin:'https://elsewhere.invalid'}}),403);
  ok(await request('/api/team/restore',mutation(f.member)),409);
  const deletes=await Promise.all([request('/api/team/delete',mutation(f.member)),request('/api/team/delete',mutation(f.member),f.owner.cookie)]);assert.deepEqual(deletes.map(item=>item.status).sort(),[200,409]);
  ok(await request('/api/team/delete',mutation(f.member,1)),409);ok(await request('/api/team/restore',mutation(f.member)),409);
  const restores=await Promise.all([request('/api/team/restore',mutation(f.member,1)),request('/api/team/restore',mutation(f.member,1),f.owner.cookie)]);assert.deepEqual(restores.map(item=>item.status).sort(),[200,409]);
  assert.equal((await row(f.member.id)).version,2);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM staff_account_archives WHERE account_id=?').bind(f.member.id).first()).n,0);
});

test('archived members cannot be edited, enabled, reset or have their avatar changed before restoration',async()=>{
  const f=await fixture();ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie));const snapshot=await row(f.member.id);
  for(const action of ['enable','disable','edit'])ok(await request('/api/team/update',{id:f.member.id,action,username:f.member.loginId,name:'不应修改',password},f.owner.cookie),409);
  ok(await request('/api/platform/staff/password',{tenantId:f.tenantId,storeId:null,accountId:f.member.id,version:1,password:password+' replacement'}),404);
  ok(await request('/api/team/avatar',{accountId:f.member.id,version:0,image}),404);
  ok(await request('/api/team/create',{requestId:f.member.id,username:f.member.loginId,name:'不应复活',password},f.owner.cookie),409);
  assert.deepEqual(await row(f.member.id),snapshot);
});

test('restoration stays disabled and can be enabled even with more than three admins',async()=>{
  const f=await fixture(),third=await person({tenantId:f.tenantId});
  ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie));
  const replacement=ok(await request('/api/team/create',{username:'replacement-'+(++serial),name:'替补人员',password,requestId:crypto.randomUUID()},f.owner.cookie),201).account;
  const restored=ok(await request('/api/team/restore',mutation(f.member,1),f.owner.cookie)).account;assert.equal(restored.status,'disabled');
  ok(await request('/api/team/update',{id:f.member.id,action:'enable'},f.owner.cookie));
  ok(await request('/api/team/update',{id:replacement.id,action:'disable'},f.owner.cookie));
  ok(await request('/api/team/update',{id:f.member.id,action:'enable'},f.owner.cookie));
  assert.equal((await row(f.member.id)).status,'active');assert.equal(await principalValid(f.member.cookie),false);
  ok(await request('/api/accounts/login',{username:f.member.loginId,password,portal:'kitchen'},''));
  assert.equal((await team(f.owner.cookie)).accounts.filter(item=>item.accountRole==='member'&&item.status!=='disabled').length,3);assert.equal((await row(third.id)).status,'active');
});

test('audit failure rolls back delete and restore including version and session changes',async()=>{
  const f=await fixture(),before=await row(f.member.id);
  await env.DB.exec("CREATE TRIGGER fail_staff_archive_audit BEFORE INSERT ON account_audit WHEN NEW.action IN ('删除管理员','恢复管理员') BEGIN SELECT RAISE(ABORT,'injected archive audit failure'); END;");
  try{ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie),500);assert.deepEqual(await row(f.member.id),before);assert.equal(await principalValid(f.member.cookie),true);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM staff_account_archives WHERE account_id=?').bind(f.member.id).first()).n,0);}finally{await env.DB.exec('DROP TRIGGER fail_staff_archive_audit');}
  ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie));const deleted=await row(f.member.id);
  await env.DB.exec("CREATE TRIGGER fail_staff_restore_audit BEFORE INSERT ON account_audit WHEN NEW.action='恢复管理员' BEGIN SELECT RAISE(ABORT,'injected restore audit failure'); END;");
  try{ok(await request('/api/team/restore',mutation(f.member,1),f.owner.cookie),500);assert.deepEqual(await row(f.member.id),deleted);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM staff_account_archives WHERE account_id=?').bind(f.member.id).first()).n,1);}finally{await env.DB.exec('DROP TRIGGER fail_staff_restore_audit');}
});

test('deletion rechecks actor suspension, target store removal and account edits inside the write',async()=>{
  for(const race of ['actor-disable','store-delete','account-edit']){
    const f=await fixture(),target=race==='store-delete'?f.storeMember:f.member,before=await row(target.id);
    const DB=racingDB(async()=>{if(race==='actor-disable')await env.DB.prepare("UPDATE staff_accounts SET status='disabled' WHERE id=?").bind(f.owner.id).run();else if(race==='store-delete'){f.core.stores[0].deletedAt='2026-10-21';await env.DB.prepare('UPDATE tenants SET core_json=? WHERE id=?').bind(JSON.stringify(f.core),f.tenantId).run();}else await env.DB.prepare('UPDATE staff_accounts SET version=version+1 WHERE id=?').bind(target.id).run();});
    ok(await request('/api/team/delete',mutation(target),f.owner.cookie,{env:{...env,DB}}),409);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM staff_account_archives WHERE account_id=?').bind(target.id).first()).n,0);
    const current=await row(target.id);assert.equal(current.status,before.status);assert.equal(current.version,race==='account-edit'?before.version+1:before.version);
  }
});

test('a deletion racing edit, enable, reset or avatar writes prevents those operations from reviving or changing it',async()=>{
  for(const operation of ['edit','enable','reset','avatar']){
    const f=await fixture();
    if(operation==='enable')await env.DB.prepare("UPDATE staff_accounts SET status='disabled' WHERE id=?").bind(f.member.id).run();
    const before=await row(f.member.id);
    const DB=racingDB(async()=>{ok(await request('/api/team/delete',mutation(f.member),f.owner.cookie));});
    const route=operation==='avatar'?'/api/team/avatar':operation==='reset'?'/api/platform/staff/password':'/api/team/update';
    const body=operation==='avatar'?{accountId:f.member.id,version:0,image}:operation==='reset'?{tenantId:f.tenantId,storeId:null,accountId:f.member.id,version:0,password:password+' changed'}:{id:f.member.id,action:operation,username:f.member.loginId,name:'应保留原名',password:operation==='edit'?password:undefined};
    ok(await request(route,body,operation==='reset'?platform.cookie:f.owner.cookie,{env:{...env,DB}}),409);
    const current=await row(f.member.id);assert.equal(current.status,'disabled');assert.equal(current.version,1);assert.equal(current.name,before.name);assert.equal(current.password_hash,before.password_hash);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM account_avatars WHERE account_id=?').bind(f.member.id).first()).n,0);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM staff_account_archives WHERE account_id=?').bind(f.member.id).first()).n,1);
  }
});

test('the real platform owner can edit both kitchen owner and employee avatars without changing their account roles',async()=>{
  const f=await fixture();
  for(const target of [f.owner,f.member]){
    const before=await row(target.id),avatar=ok(await request('/api/team/avatar',{accountId:target.id,version:0,image})).account;
    assert.equal(avatar.avatarVersion,1);assert.deepEqual((await request(avatar.avatarUrl,undefined,f.owner.cookie)).data,png);assert.deepEqual(await row(target.id),before);
  }
});
