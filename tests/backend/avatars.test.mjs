import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import worker from '../../backend/worker.js';
import {hashToken} from '../../backend/auth.js';
import {parseAvatarImage} from '../../backend/avatars.js';

const origin='https://avatars.example.test';
let runtime,env,serial=0,platformAccount;
const stamp=()=>Math.floor(Date.now()/1000);
function checksum(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(checksum(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);}
function makePNG(width=1,height=1){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const pixels=Buffer.from([0,240,120,10,255]);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
const png=makePNG(),image='data:image/png;base64,'+png.toString('base64');

before(async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'avatar-test',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'avatar-test'}}]}));
  const DB=await runtime.getD1Database('DB');
  for(const file of (await readdir(new URL('../../backend/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())await DB.exec((await readFile(new URL('../../backend/migrations/'+file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env={DB,STORE_CODE_KEY:'3'.repeat(64),PUBLIC_ORIGIN:origin,LOCAL_TEST:'0'};
});
after(async()=>runtime?.dispose());
async function request(path,body,cookie='',extra={}){const response=await worker.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...extra.headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),extra.env||env,{});return {status:response.status,headers:response.headers,data:response.headers.get('Content-Type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};}
function ok(result,status=200){assert.equal(result.status,status,JSON.stringify(result.data));return result.data;}
async function account({tenantId=null,storeId=null,role=storeId?'store':'admin',accountRole='member',status='active'}={}){const id='avatar-person-'+(++serial);await env.DB.prepare('INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,'test_'+id,tenantId,storeId,role,accountRole,'测试人员','测试联系方式',status,accountRole==='member'?'fixture-unusable-password-hash':null,stamp()).run();return {id,tenantId,storeId,role,accountRole};}
async function session(account){const token=randomBytes(32).toString('hex');const current=await env.DB.prepare('SELECT version FROM staff_accounts WHERE id=?').bind(account.id).first();await env.DB.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,?)').bind(await hashToken(token),account.id,stamp()+3600,current.version).run();return '__Host-kuraflow_account='+token;}
async function fixture(){const tenantId='avatar-tenant-'+(++serial),otherId='avatar-tenant-'+(++serial);for(const id of [tenantId,otherId])await env.DB.batch([env.DB.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').bind(id,'测试厨房',JSON.stringify({stores:[{id:'store-a',name:'本店'},{id:'store-b',name:'另一家门店'},{id:'deleted',name:'已删除',deletedAt:'2026-01-01'}],settings:{}})),env.DB.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)').bind(id,'ORG-'+id,stamp())]);
  const owner=await account({tenantId,accountRole:'owner'}),member=await account({tenantId}),colleague=await account({tenantId}),storeOwner=await account({tenantId,storeId:'store-a',accountRole:'owner'}),storeMember=await account({tenantId,storeId:'store-a'}),sibling=await account({tenantId,storeId:'store-b'}),foreign=await account({tenantId:otherId}),deleted=await account({tenantId,storeId:'deleted'}),platform=platformAccount||=(await account({role:'platform',accountRole:'owner'})),platformMember=await account({role:'platform'});
  const rows={owner,member,colleague,storeOwner,storeMember,sibling,foreign,deleted,platform,platformMember};for(const row of Object.values(rows))row.cookie=await session(row);return {tenantId,otherId,...rows};}
const save=(person,version=0)=>({accountId:person.id,version,image});

 test('person and organization avatars persist independently and do not alter login credentials or business revisions',async()=>{
  const f=await fixture();const before=await env.DB.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(f.owner.id).first(),tenantBefore=await env.DB.prepare('SELECT core_json,revision FROM tenants WHERE id=?').bind(f.tenantId).first();
  const result=ok(await request('/api/team/avatar',save(f.owner),f.owner.cookie));assert.equal(result.account.avatarVersion,1);assert.match(result.account.avatarUrl,/^\/api\/account-avatar\?account=/);
  assert.deepEqual((await request(result.account.avatarUrl,undefined,f.owner.cookie)).data,png);
  const organization=ok(await request('/api/organization/avatar',{tenantId:f.tenantId,version:0,image},f.owner.cookie)).organization;assert.equal(organization.avatarVersion,1);assert.notEqual(organization.avatarUrl,result.account.avatarUrl);
  const principal=ok(await request('/api/accounts/session',undefined,f.owner.cookie)).principal;assert.equal(principal.avatarUrl,result.account.avatarUrl);assert.equal(principal.organizationAvatarUrl,organization.avatarUrl);
  const team=ok(await request('/api/team/list',undefined,f.owner.cookie));assert.equal(team.organization.avatarUrl,organization.avatarUrl);assert.equal(team.accounts.find(row=>row.id===f.owner.id).avatarVersion,1);assert.doesNotMatch(JSON.stringify(team),/base64|fixture-unusable-password-hash/);
  const directory=ok(await request('/api/platform/customer?tenant='+f.tenantId,undefined,f.platform.cookie));assert.equal(directory.managementAccounts.find(row=>row.id===f.owner.id).avatarUrl,result.account.avatarUrl);assert.equal(directory.customer.avatarUrl,organization.avatarUrl);
  assert.equal(ok(await request('/api/platform/kitchens',undefined,f.platform.cookie)).kitchens.find(row=>row.id===f.tenantId).avatarUrl,organization.avatarUrl);
  assert.deepEqual(await env.DB.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(f.owner.id).first(),before);
  assert.deepEqual(await env.DB.prepare('SELECT core_json,revision FROM tenants WHERE id=?').bind(f.tenantId).first(),tenantBefore);
  assert.equal(ok(await request('/api/accounts/session',undefined,f.owner.cookie)).authenticated,true);
});

test('avatars enforce personal, role, tenant and store boundaries for reads and writes',async()=>{
  const f=await fixture();const ownerAvatar=ok(await request('/api/team/avatar',save(f.owner),f.owner.cookie)).account.avatarUrl;
  const memberAvatar=ok(await request('/api/team/avatar',save(f.member),f.member.cookie)).account.avatarUrl;
  const storeAvatar=ok(await request('/api/team/avatar',save(f.storeMember),f.storeOwner.cookie)).account.avatarUrl;
  for(const cookie of [f.foreign.cookie,f.storeOwner.cookie,f.storeMember.cookie,f.platformMember.cookie]){ok(await request(ownerAvatar,undefined,cookie),403);ok(await request('/api/team/avatar',{accountId:f.owner.id,version:1,image},cookie),403);}
  ok(await request(ownerAvatar,undefined,f.member.cookie));ok(await request(memberAvatar,undefined,f.colleague.cookie));
  ok(await request('/api/team/avatar',{accountId:f.colleague.id,version:0,image},f.member.cookie),403);
  ok(await request(storeAvatar,undefined,f.sibling.cookie),403);ok(await request('/api/team/avatar',save(f.sibling),f.storeOwner.cookie),403);
  ok(await request('/api/team/avatar',save(f.foreign),f.owner.cookie),403);ok(await request('/api/team/avatar',save(f.deleted),f.platform.cookie),404);
  ok(await request(ownerAvatar,undefined,''),401);ok(await request('/api/team/avatar',save(f.foreign),''),401);
  const organization=ok(await request('/api/organization/avatar',{tenantId:f.tenantId,version:0,image},f.owner.cookie)).organization;
  ok(await request(organization.avatarUrl,undefined,f.storeMember.cookie));ok(await request(organization.avatarUrl,undefined,f.foreign.cookie),403);
  for(const cookie of [f.member.cookie,f.storeOwner.cookie,f.storeMember.cookie,f.foreign.cookie,f.platformMember.cookie])ok(await request('/api/organization/avatar',{tenantId:f.tenantId,version:1,image},cookie),403);
  ok(await request('/api/organization/avatar',{tenantId:f.tenantId,version:1,image},f.platform.cookie));
  ok(await request('/api/team/avatar',save(f.platform),f.platform.cookie));
});

test('avatar compare-and-set permits one concurrent edit and removal has its own retained revision',async()=>{
  const f=await fixture(),payload=save(f.member);const results=await Promise.all([request('/api/team/avatar',payload,f.owner.cookie),request('/api/team/avatar',payload,f.member.cookie)]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  ok(await request('/api/team/avatar',payload,f.owner.cookie),409);
  const removed=ok(await request('/api/team/avatar',{accountId:f.member.id,version:1,image:null},f.member.cookie));assert.equal(removed.account.avatarUrl,null);assert.equal(removed.account.avatarVersion,2);
  ok(await request('/api/account-avatar?account='+f.member.id,undefined,f.member.cookie),404);
  assert.equal(ok(await request('/api/team/list',undefined,f.owner.cookie)).accounts.find(row=>row.id===f.member.id).avatarVersion,2);
  const saved=ok(await request('/api/team/avatar',{...save(f.member),version:2},f.owner.cookie));assert.equal(saved.account.avatarVersion,3);
});

test('invalid raster payloads, forged fields, stale versions and cross-origin writes fail without changing avatars',async()=>{
  const f=await fixture();const invalid=[undefined,'https://example.test/image.png','data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64'),'data:image/png;base64,'+Buffer.from('invalid image bytes').toString('base64'),image.slice(0,-4),image+'AAAA','data:image/png;base64,'+makePNG(5000,5000).toString('base64')];
  for(const bad of invalid)ok(await request('/api/team/avatar',{accountId:f.owner.id,version:0,image:bad},f.owner.cookie),400);
  ok(await request('/api/team/avatar',{...save(f.owner),tenantId:f.otherId},f.owner.cookie),400);
  ok(await request('/api/team/avatar',{...save(f.owner),version:-1},f.owner.cookie),409);
  ok(await request('/api/team/avatar',save(f.owner),f.owner.cookie,{headers:{Origin:'https://foreign.example'}}),403);
  ok(await request('/api/team/avatar',save(f.owner),f.owner.cookie,{headers:{'Sec-Fetch-Site':'cross-site'}}),403);
  ok(await request('/api/team/avatar',{...save(f.owner),image:'x'.repeat(280001)},f.owner.cookie),413);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_avatars WHERE account_id=?').bind(f.owner.id).first()).n,0);
});

test('avatar storage and audit failure roll back the image, revision and metadata together',async()=>{
  const f=await fixture();await env.DB.exec(`CREATE TRIGGER fail_avatar_audit BEFORE INSERT ON account_audit WHEN NEW.target_id='${f.member.id}' AND NEW.action='更新个人头像' BEGIN SELECT RAISE(ABORT,'avatar_test_failure'); END;`);
  ok(await request('/api/team/avatar',save(f.member),f.owner.cookie),500);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_avatars WHERE account_id=?').bind(f.member.id).first()).n,0);
  await env.DB.exec('DROP TRIGGER fail_avatar_audit');ok(await request('/api/team/avatar',save(f.member),f.owner.cookie));
  const row=await env.DB.prepare('SELECT action,target_id FROM account_audit WHERE target_id=?').bind(f.member.id).first();assert.equal(row.action,'更新个人头像');assert.equal(row.target_id,f.member.id);
});

test('an actor suspension or store deletion racing avatar validation aborts the write',async()=>{
  for(const race of ['suspend','store-delete']){
    const f=await fixture(),db=env.DB,target=race==='suspend'?f.owner:f.storeMember;
    let raced=false,proxy;
    proxy=new Proxy(db,{get(base,key){
      if(key==='withSession')return ()=>proxy;
      if(key==='batch')return async statements=>{if(!raced){raced=true;if(race==='suspend')await db.prepare("UPDATE staff_accounts SET status='disabled' WHERE id=?").bind(f.owner.id).run();else{const row=await db.prepare('SELECT core_json FROM tenants WHERE id=?').bind(f.tenantId).first(),core=JSON.parse(row.core_json);core.stores.find(store=>store.id==='store-a').deletedAt='2026-10-21';await db.prepare('UPDATE tenants SET core_json=? WHERE id=?').bind(JSON.stringify(core),f.tenantId).run();}}return db.batch(statements);};
      const value=base[key];return typeof value==='function'?value.bind(base):value;
    }});
    ok(await request('/api/team/avatar',save(target),f.owner.cookie,{env:{...env,DB:proxy}}),409);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_avatars WHERE account_id=?').bind(target.id).first()).n,0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE target_id=? AND action='更新个人头像'").bind(target.id).first()).n,0);
  }
});

test('raster parser accepts valid PNG and rejects modified chunks or a signature-only image',()=>{
  assert.deepEqual(parseAvatarImage(image).bytes,png);
  const corrupt=Buffer.from(png);corrupt[corrupt.length-5]^=1;
  assert.throws(()=>parseAvatarImage('data:image/png;base64,'+corrupt.toString('base64')),/无法读取/);
  assert.throws(()=>parseAvatarImage('data:image/png;base64,'+png.subarray(0,20).toString('base64')),/无法读取/);
});
