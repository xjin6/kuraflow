import {scrypt, timingSafeEqual, randomBytes} from 'node:crypto';
import {hashToken, randomToken, deployment, readMutation, rateLimit} from './auth.js';
import {withAccountAvatars,withIdentityAvatars,organizationAvatar,withOrganizationAvatars} from './avatars.js';

const now = () => Math.floor(Date.now() / 1000);
const SESSION_AGE = 7 * 86400;
const MEMBER_LIMIT = 3;
const fail = (message, status=400, code='ACCOUNT_ERROR') => { throw Object.assign(new Error(message), {status, code}); };
const json = (value, status=200, headers={}) => Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const guard = db => db.prepare('INSERT INTO auth_atomic_guard(id,ok) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok');
const publicAccount = row => ({id:row.id,username:row.account_role==='member'?row.login_id:null,loginId:row.account_role==='member'?row.login_id:null,tenantId:row.tenant_id,storeId:row.store_id,role:row.role,accountRole:row.account_role,name:row.name,contact:row.contact,status:row.status,version:row.version??0,deletedAt:row.deleted_at??null,createdAt:row.created_at,lastLogin:row.last_login,avatarUrl:null,avatarVersion:0});
const identity = row => ({...publicAccount(row),userId:row.id,displayName:row.name});
const cookieName = config => config.local?'kuraflow_local_account':'__Host-kuraflow_account';
const cookie = (config,token,age=SESSION_AGE) => `${cookieName(config)}=${token}; Path=/; HttpOnly; ${config.local?'':'Secure; '}SameSite=Strict; Max-Age=${age}`;
function readCookie(request,config) { const entries=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName(config)+'=')); return entries.length===1?entries[0].slice(cookieName(config).length+1):null; }
function text(value,label,max=80,optional=false) { if(optional&&(value==null||value===''))return '';if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(`请填写${label}（最多 ${max} 字）。`);return value.trim(); }
function username(value) { const normalized=typeof value==='string'?value.normalize('NFKC').trim().toLowerCase():'';if(!/^[\p{L}\p{N}._-]{3,32}$/u.test(normalized))fail('账号名须为 3～32 位文字、字母、数字或 . _ -。');return normalized; }
const derive = (password,salt) => new Promise((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024},(err,key)=>err?reject(err):resolve(key)));
async function passwordHash(password) { if(typeof password!=='string'||password.length<12||password.length>128)fail('密码须为 12～128 个字符。');const salt=randomBytes(16).toString('hex');return `scrypt$32768$8$3$${salt}$${(await derive(password,salt)).toString('hex')}`; }
async function passwordMatches(password,stored) { const parts=(stored||'').split('$'),valid=parts.length===6&&parts[0]==='scrypt'&&parts[1]==='32768'&&parts[2]==='8'&&parts[3]==='3';const actual=await derive(password,valid?parts[4]:'0'.repeat(32));const expected=Buffer.from(valid?parts[5]:'0'.repeat(64),'hex');return valid&&expected.length===actual.length&&timingSafeEqual(actual,expected); }
export function generateMasterCode() {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for(;;){let raw='';while(raw.length<16)for(const byte of crypto.getRandomValues(new Uint8Array(24)))if(byte<252&&raw.length<16)raw+=alphabet[byte%36];if(/[A-Z]/.test(raw)&&/\d/.test(raw))return raw.match(/.{4}/g).join('-');}
}
function normalizeCode(value) { if(typeof value!=='string'||value.length>64)return '';const raw=value.toUpperCase().replace(/[\s-]/g,'');return /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{16}$/.test(raw)?raw.match(/.{4}/g).join('-'):''; }
async function cipherKey(env) { if(!/^[a-f0-9]{64}$/.test(env.STORE_CODE_KEY||''))fail('负责人码服务尚未配置。',503);return crypto.subtle.importKey('raw',Buffer.from(env.STORE_CODE_KEY,'hex'),'AES-GCM',false,['encrypt','decrypt']); }
function aad(account) { return new TextEncoder().encode(JSON.stringify(['kuraflow-master',account.id,account.tenant_id,account.store_id])); }
async function encryptCode(env,account,code) { const iv=crypto.getRandomValues(new Uint8Array(12)),encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(account)},await cipherKey(env),new TextEncoder().encode(code));return Buffer.concat([iv,Buffer.from(encrypted)]).toString('base64url'); }
async function decryptCode(env,account,cipher) { const bytes=Buffer.from(cipher,'base64url');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:aad(account)},await cipherKey(env),bytes.subarray(12))); }
async function legacyStoreCode(db,env,tenantId,storeId) {
  if(!storeId)return null;
  const row=await db.prepare('SELECT c.code_cipher FROM store_access_codes c JOIN users u ON u.id=c.user_id WHERE c.tenant_id=? AND c.store_id=? AND u.active=1').bind(tenantId,storeId).first();
  if(!row)return null;
  const bytes=Buffer.from(row.code_cipher,'base64url');
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:new TextEncoder().encode(JSON.stringify([tenantId,storeId]))},await cipherKey(env),bytes.subarray(12));
  return normalizeCode(new TextDecoder().decode(clear))||null;
}
function audit(db,actor,action,target,tenantId=actor.tenantId,storeId=actor.storeId) { return db.prepare('INSERT INTO account_audit(id,tenant_id,store_id,actor_id,actor_name,action,target_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),tenantId||null,storeId||null,actor.userId,actor.displayName,action,target||null,now()); }
async function orgFor(db,id) { return db.prepare('SELECT o.*,t.name,t.core_json FROM organizations o JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=?').bind(id).first(); }
function orgAvailable(org) { return org&&org.active===1&&(!org.expires_on||org.expires_on>=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())); }
function validStore(org,id) { return JSON.parse(org.core_json).stores?.find(s=>s.id===id&&!s.deletedAt); }
function requirePlatformOwner(actor) {
  if(actor?.role!=='platform'||actor.accountRole!=='owner'||actor.tenantId!=null||actor.storeId!=null||!actor.userId)fail('仅平台负责人可访问。',403);
}
function ownerWriteGuard(actor) {
  return {
    sql:`EXISTS(SELECT 1 FROM staff_accounts p WHERE p.id=? AND p.role=? AND p.account_role='owner' AND p.status='active' AND p.version=? AND p.tenant_id IS ? AND p.store_id IS ?
      AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=p.id)
      AND (p.role='platform' OR EXISTS(SELECT 1 FROM organizations o WHERE o.tenant_id=p.tenant_id AND o.active=1 AND (o.expires_on IS NULL OR o.expires_on>=?)))
      AND (p.store_id IS NULL OR EXISTS(SELECT 1 FROM tenants t,json_each(t.core_json,'$.stores') s WHERE t.id=p.tenant_id AND json_extract(s.value,'$.id')=p.store_id AND COALESCE(json_extract(s.value,'$.deletedAt'),'')='')))`,
    params:[actor.userId,actor.role,actor.version??0,actor.tenantId??null,actor.storeId??null,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())],
  };
}
const activeStoreGuard=`(? IS NULL OR EXISTS(SELECT 1 FROM tenants t,json_each(t.core_json,'$.stores') s WHERE t.id=? AND json_extract(s.value,'$.id')=? AND COALESCE(json_extract(s.value,'$.deletedAt'),'')=''))`;
export async function getIdentity(request,env) {
  const token=readCookie(request,deployment(request,env));if(!/^[a-f0-9]{64}$/.test(token||''))return null;
  const row=await env.DB.prepare("SELECT a.* FROM account_sessions s JOIN staff_accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires>? AND s.version=a.version AND a.status='active' AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=a.id)").bind(await hashToken(token),now()).first();
  if(!row)return null;
  if(row.role!=='platform'){const org=await orgFor(env.DB,row.tenant_id);if(!orgAvailable(org)||(row.role==='store'&&!validStore(org,row.store_id)))return null;}
  return withIdentityAvatars(env.DB,identity(row));
}
async function allowedScope(db,actor,body) {
  if(actor.role==='platform')requirePlatformOwner(actor);
  if(actor.role!=='platform'&&actor.accountRole!=='owner')fail('仅负责人可以管理员账号。',403);
  const tenantId=actor.role==='platform'?text(body.tenantId,'中央厨房',160):actor.tenantId;
  const storeId=actor.role==='store'?actor.storeId:(body.storeId?text(body.storeId,'门店',160):null);
  const org=await orgFor(db,tenantId);if(!org)fail('请先开通中央厨房。',409);
  if(storeId&&!validStore(org,storeId))fail('门店不存在或已停用。',404);
  return {tenantId,storeId,org,role:storeId?'store':'admin'};
}
async function ensureOrganization(db,tenantId) {
  const tenant=await db.prepare('SELECT * FROM tenants WHERE id=?').bind(tenantId).first();if(!tenant)fail('中央厨房不存在。',404);
  await db.prepare("INSERT OR IGNORE INTO organizations(tenant_id,code,plan,admin_limit,store_limit,created_at) VALUES(?,?,'标准版',3,3,?)").bind(tenantId,'ORG-'+crypto.randomUUID(),now()).run();
  return orgFor(db,tenantId);
}
export async function ensureMaster(db,env,tenantId,storeId=null,details={}) {
  const org=await ensureOrganization(db,tenantId),store=storeId?validStore(org,storeId):null;if(storeId&&!store)fail('门店不存在或已停用。',404);
  for(let attempt=0;attempt<4;attempt++) {
    const existing=await db.prepare("SELECT a.*,k.key_cipher FROM staff_accounts a LEFT JOIN account_keys k ON k.account_id=a.id WHERE a.tenant_id=? AND a.store_id IS ? AND a.account_role='owner'").bind(tenantId,storeId).first();
    if(existing?.key_cipher)return {account:(await withAccountAvatars(db,[publicAccount(existing)]))[0],masterCode:await decryptCode(env,existing,existing.key_cipher)};
    const account=existing||{id:crypto.randomUUID(),tenant_id:tenantId,store_id:storeId,role:storeId?'store':'admin',account_role:'owner',name:details.name||store?.contact||'厨房负责人',contact:details.contact||store?.phone||'',version:0,created_at:now()};
    const code=await legacyStoreCode(db,env,tenantId,storeId)||generateMasterCode(),cipher=await encryptCode(env,account,code),statements=[];
    if(existing)statements.push(db.prepare("UPDATE staff_accounts SET status='active',password_hash=NULL,version=version+1 WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM account_keys WHERE account_id=?)").bind(account.id,account.version,account.id),guard(db));
    else statements.push(db.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,?,?,'owner',?,?,'active',?)").bind(account.id,'master:'+account.id,tenantId,storeId,account.role,account.name,account.contact,account.created_at));
    statements.push(db.prepare("INSERT INTO account_keys(account_id,kind,key_hash,key_cipher,created_at) VALUES(?,'master',?,?,?)").bind(account.id,await hashToken(code),cipher,now()),db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(account.id),db.prepare('DELETE FROM account_invites WHERE account_id=?').bind(account.id));
    try{await db.batch(statements);return {account:publicAccount({...account,status:'active'}),masterCode:code};}catch(error){if(/UNIQUE|CHECK constraint/.test(error.message))continue;throw error;}
  }
  fail('负责人码生成冲突，请重试。',409);
}
export async function getStoreMasterCode(db,env,actor,storeId) {
  const scope=await allowedScope(db,actor,{tenantId:actor.tenantId,storeId});
  const result=await ensureMaster(db,env,scope.tenantId,scope.storeId);return {storeId,accessCode:result.masterCode};
}
export async function provisionPlatform(db,{key}) {
  let account=await db.prepare("SELECT * FROM staff_accounts WHERE role='platform' AND account_role='owner'").first();
  const credential=account&&await db.prepare('SELECT key_hash FROM account_keys WHERE account_id=?').bind(account.id).first();
  if(credential){if(key&&await hashToken(key)!==credential.key_hash)fail('已有平台密钥，不能自动覆盖。',409);return {account:publicAccount(account)};}
  const platformKey=key||'KF-PLATFORM-'+randomBytes(48).toString('base64url');if(platformKey.length<64||platformKey.length>256)fail('平台密钥长度不正确。');
  account||={id:crypto.randomUUID(),role:'platform',account_role:'owner',name:'平台负责人',contact:'',version:0};
  const statements=[db.prepare("INSERT INTO staff_accounts(id,login_id,role,account_role,name,contact,status,created_at) VALUES(?,?,'platform','owner',?,?,'active',?) ON CONFLICT(id) DO UPDATE SET status='active',password_hash=NULL,version=staff_accounts.version+1").bind(account.id,'platform:'+account.id,account.name,account.contact,now()),db.prepare("INSERT INTO account_keys(account_id,kind,key_hash,created_at) VALUES(?,'platform',?,?)").bind(account.id,await hashToken(platformKey),now()),db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(account.id),db.prepare('DELETE FROM account_invites WHERE account_id=?').bind(account.id)];
  await db.batch(statements);return {account:publicAccount({...account,status:'active'}),platformKey};
}
export async function migrateExistingOrganizations(db,env) {
  const tenants=await db.prepare('SELECT id,core_json FROM tenants').all();
  for(const tenant of tenants.results){await ensureMaster(db,env,tenant.id);for(const store of JSON.parse(tenant.core_json).stores||[])if(!store.deletedAt)await ensureMaster(db,env,tenant.id,store.id);}
  return {tenants:tenants.results.length};
}
function settings(body) { const plan=text(body.plan||'标准版','套餐',40),expires=body.expiresOn||null;if(expires&&(!/^\d{4}-\d{2}-\d{2}$/.test(expires)||Number.isNaN(Date.parse(expires))||new Date(expires).toISOString().slice(0,10)!==expires))fail('请选择有效的到期日期。');return {plan,expires}; }
export async function createKitchen(db,env,actor,body) {
  if(actor.role!=='platform')fail('仅平台可以开通中央厨房。',403);
  const name=text(body.name,'中央厨房名称'),ownerName=text(body.ownerName,'负责人姓名'),contact=text(body.contact,'联系方式',120,true),opts=settings(body);
  const tenantId=body.existingTenantId?text(body.existingTenantId,'中央厨房',160):text(body.requestId||crypto.randomUUID(),'请求编号',160);
  const existing=await db.prepare('SELECT id FROM tenants WHERE id=?').bind(tenantId).first();if(body.existingTenantId&&!existing)fail('中央厨房不存在。',404);
  const org=existing&&await orgFor(db,tenantId);
  if(!org){const core={version:2,stores:[],prices:{},quoteMeta:{},unitQuotes:{},inventory:{},storeAllocations:{},cart:{},settings:{companyName:name,currency:'JPY',language:'zh-CN',cutoffTime:'22:00'}};
    const statements=existing?[]:[db.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').bind(tenantId,name,JSON.stringify(core))];
    statements.push(db.prepare('INSERT INTO organizations(tenant_id,code,plan,expires_on,admin_limit,store_limit,created_at) VALUES(?,?,?,?,3,3,?)').bind(tenantId,'ORG-'+crypto.randomUUID(),opts.plan,opts.expires,now()),audit(db,actor,'开通中央厨房',tenantId,tenantId));
    try{await db.batch(statements);}catch(error){if(!/UNIQUE/.test(error.message))throw error;}
  }
  return {tenantId,...await ensureMaster(db,env,tenantId,null,{name:ownerName,contact})};
}
export async function createStaff(db,actor,body) {
  const scope=await allowedScope(db,actor,body),loginId=username(body.username),name=text(body.name||loginId,'姓名'),contact=text(body.contact,'联系方式',120,true);
  const id=text(body.requestId||crypto.randomUUID(),'请求编号',160),prior=await db.prepare('SELECT a.*,(SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at FROM staff_accounts a WHERE a.id=?').bind(id).first();
  if(prior){if(prior.tenant_id!==scope.tenantId||prior.store_id!==scope.storeId||prior.login_id!==loginId||prior.account_role!=='member'||prior.deleted_at)fail('请求编号冲突。',409);return {account:publicAccount(prior)};}
  const hashed=await passwordHash(body.password);
  try{await db.batch([
    db.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,password_hash,created_at) SELECT ?,?,?,?,?,'member',?,?,'active',?,? WHERE (SELECT COUNT(*) FROM staff_accounts WHERE tenant_id=? AND store_id IS ? AND account_role='member' AND status!='disabled')<3").bind(id,loginId,scope.tenantId,scope.storeId,scope.role,name,contact,hashed,now(),scope.tenantId,scope.storeId),guard(db),audit(db,actor,'添加管理员',id,scope.tenantId,scope.storeId)
  ]);}catch(error){if(/login_id|staff_username_normalized/.test(error.message))fail('账号名已被使用，请换一个。',409);if(/CHECK constraint/.test(error.message))fail('最多添加 3 个管理员，负责人不占名额。',409);throw error;}
  return {account:publicAccount({id,login_id:loginId,tenant_id:scope.tenantId,store_id:scope.storeId,role:scope.role,account_role:'member',name,contact,status:'active',created_at:now()})};
}
async function manageStaff(db,actor,body) {
  const target=await db.prepare('SELECT a.*,(SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at FROM staff_accounts a WHERE a.id=?').bind(text(body.accountId||body.id,'账号',160)).first();if(!target)fail('未找到账号。',404);
  const scope=await allowedScope(db,actor,{tenantId:target.tenant_id,storeId:target.store_id});
  if(scope.tenantId!==target.tenant_id||scope.storeId!==target.store_id||target.account_role!=='member')fail('无权修改此账号。',403);
  if(target.deleted_at)fail('此管理员已删除，请先恢复。',409,'ACCOUNT_CHANGED');
  const action=body.action;if(!['edit','disable','enable'].includes(action))fail('操作不正确。');
  const loginId=action==='edit'?username(body.username):target.login_id;
  const name=action==='edit'?text(body.name||loginId,'姓名'):target.name,contact=action==='edit'?text(body.contact,'联系方式',120,true):target.contact;
  const hashed=body.password?await passwordHash(body.password):target.password_hash;
  if(action==='enable'&&!hashed)fail('请先为此账号设置密码。');
  const status=action==='disable'?'disabled':action==='enable'||(action==='edit'&&target.status==='pending'&&hashed)?'active':target.status;
  const actorGuard=ownerWriteGuard(actor);
  try{await db.batch([
    db.prepare(`UPDATE staff_accounts SET login_id=?,name=?,contact=?,password_hash=?,status=?,version=version+1 WHERE id=? AND version=? AND account_role='member' AND tenant_id=? AND store_id IS ?
      AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id) AND ${actorGuard.sql} AND ${activeStoreGuard}
      AND (?='disabled' OR status!='disabled' OR (SELECT COUNT(*) FROM staff_accounts WHERE tenant_id=? AND store_id IS ? AND account_role='member' AND status!='disabled')<3)`).bind(loginId,name,contact,hashed,status,target.id,target.version,scope.tenantId,scope.storeId,...actorGuard.params,scope.storeId,scope.tenantId,scope.storeId,status,scope.tenantId,scope.storeId),guard(db),db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(target.id),db.prepare('DELETE FROM account_invites WHERE account_id=?').bind(target.id),audit(db,actor,{edit:'修改管理员',disable:'停用管理员',enable:'启用管理员'}[action],target.id,scope.tenantId,scope.storeId)
  ]);}catch(error){if(/login_id|staff_username_normalized/.test(error.message))fail('账号名已被使用。',409);if(/CHECK constraint/.test(error.message))fail('管理员名额已满或账号已变更，请刷新。',409);throw error;}
  return {ok:true};
}
async function archiveStaff(db,actor,body,restore=false) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||Object.keys(body).some(key=>!['accountId','version'].includes(key)))fail('管理员操作字段不正确。');
  const id=text(body.accountId,'账号',160);
  if(!Number.isSafeInteger(body.version)||body.version<0)fail('请刷新账号信息后重试。',409,'ACCOUNT_CHANGED');
  const target=await db.prepare('SELECT a.*,(SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at FROM staff_accounts a WHERE a.id=?').bind(id).first();
  if(!target)fail('未找到账号。',404);
  if(target.account_role!=='member'||!['admin','store'].includes(target.role)||target.id===actor.userId)fail('只能删除或恢复有权限管理的管理员账号。',403);
  const scope=await allowedScope(db,actor,{tenantId:target.tenant_id,storeId:target.store_id});
  if(scope.tenantId!==target.tenant_id||scope.storeId!==target.store_id)fail('无权修改此账号。',403);
  if(target.version!==body.version||Boolean(target.deleted_at)!==restore)fail('账号状态已变更，请刷新后重试。',409,'ACCOUNT_CHANGED');
  const actorGuard=ownerWriteGuard(actor),stamp=now();
  try{await db.batch([
    db.prepare(`UPDATE staff_accounts SET status='disabled',version=version+1 WHERE id=? AND version=? AND account_role='member' AND role=? AND tenant_id=? AND store_id IS ?
      AND ${restore?'':'NOT '}EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id)
      AND ${actorGuard.sql} AND ${activeStoreGuard}`).bind(id,body.version,target.role,scope.tenantId,scope.storeId,...actorGuard.params,scope.storeId,scope.tenantId,scope.storeId),
    guard(db),
    restore?db.prepare('DELETE FROM staff_account_archives WHERE account_id=?').bind(id):db.prepare('INSERT INTO staff_account_archives(account_id,deleted_at,deleted_by) VALUES(?,?,?)').bind(id,stamp,actor.userId),
    guard(db),
    db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(id),
    db.prepare('DELETE FROM account_invites WHERE account_id=?').bind(id),
    audit(db,actor,restore?'恢复管理员':'删除管理员',id,scope.tenantId,scope.storeId),
  ]);}catch(error){if(/CHECK constraint|UNIQUE constraint/.test(error.message))fail('账号状态已变更，请刷新后重试。',409,'ACCOUNT_CHANGED');throw error;}
  return {ok:true,account:(await withAccountAvatars(db,[publicAccount({...target,status:'disabled',version:body.version+1,deleted_at:restore?null:stamp})]))[0]};
}
async function masterKeyAction(db,env,actor,body) {
  const scope=await allowedScope(db,actor,body);
  const result=await ensureMaster(db,env,scope.tenantId,scope.storeId);
  if(body.rotate){if(actor.role!=='platform'&&!(actor.role==='admin'&&scope.storeId))fail('请联系上级重置负责人码。',403);
    const row=await db.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(result.account.id).first(),code=generateMasterCode(),cipher=await encryptCode(env,row,code);
    await db.batch([db.prepare("UPDATE staff_accounts SET version=version+1,status='active',password_hash=NULL WHERE id=? AND version=?").bind(row.id,row.version),guard(db),db.prepare('UPDATE account_keys SET key_hash=?,key_cipher=?,created_at=? WHERE account_id=?').bind(await hashToken(code),cipher,now(),row.id),db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(row.id),audit(db,actor,'重置负责人码',row.id,scope.tenantId,scope.storeId)]);
    result.masterCode=code;
  }
  return result;
}
async function listStaff(db,env,actor,params) {
  const tenantId=actor.role==='platform'?params.get('tenant')||'':actor.tenantId,org=await orgFor(db,tenantId);
  if(!org)return {accounts:[],stores:[],needsSetup:true,canManage:false,organization:null,limit:3};
  const storeId=actor.role==='store'?actor.storeId:params.get('store')||null;if(storeId&&!validStore(org,storeId))fail('门店不存在。',404);
  const canManage=actor.accountRole==='owner';
  const accounts=await db.prepare(`SELECT a.*,(SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at FROM staff_accounts a WHERE a.tenant_id=? AND a.store_id IS ? ${canManage?'':'AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=a.id)'} ORDER BY a.account_role DESC,a.created_at`).bind(tenantId,storeId).all();
  const stores=JSON.parse(org.core_json).stores.filter(s=>!s.deletedAt).map(s=>({id:s.id,name:s.name}));
  const [people,avatar]=await Promise.all([withAccountAvatars(db,accounts.results.map(publicAccount)),organizationAvatar(db,tenantId)]);
  return {accounts:people,stores:actor.role==='store'?stores.filter(s=>s.id===actor.storeId):stores,organization:{tenantId,name:org.name,...avatar},limit:MEMBER_LIMIT,storeId,canManage,canRotateMaster:actor.role==='platform'&&canManage||(actor.role==='admin'&&canManage&&!!storeId)};
}
const customerAccount = row => ({
  ...publicAccount(row),version:row.version,
  credentialType:row.account_role==='owner'?'master-code':'password',
  hasPassword:row.account_role==='member'&&!!row.has_password,
  hasMaster:row.account_role==='owner'&&!!row.has_master,
});
const customerAccountColumns = `a.id,a.login_id,a.tenant_id,a.store_id,a.role,a.account_role,a.name,a.contact,a.status,a.created_at,a.last_login,a.version,
  (SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at,
  (a.password_hash IS NOT NULL AND a.password_hash!='') AS has_password,
  EXISTS(SELECT 1 FROM account_keys k WHERE k.account_id=a.id AND k.kind='master') AS has_master`;
const customerStoreFields=['id','name','city','prefecture','municipality','ward','addressDetail','address','prefectureCode','municipalityCode','wardCode','phone','contact','route','deletedAt','createdAt','updatedAt'];
const imagePath=/^\/api\/images\/([a-f0-9-]{36})$/;
function supportedImage(mime,bytes) {
  if(!bytes||bytes.length<16||bytes.length>204800)return false;
  return mime==='image/png'?Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    :mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255
      :mime==='image/webp'&&Buffer.from(bytes.subarray(0,4)).toString()==='RIFF'&&Buffer.from(bytes.subarray(8,12)).toString()==='WEBP';
}
function inlineStoreImage(value) {
  if(typeof value!=='string'||value.length>280000)return null;
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match||match[2].length%4!==0)return null;
  const bytes=Buffer.from(match[2],'base64');return supportedImage(match[1],bytes)?{mime:match[1],bytes}:null;
}
async function platformCustomer(db,actor,params) {
  requirePlatformOwner(actor);
  const tenantId=text(params.get('tenant'),'中央厨房',160),org=await orgFor(db,tenantId);
  if(!org)fail('中央厨房不存在。',404);
  const stored=JSON.parse(org.core_json).stores||[];
  // Select the credential-presence flags in SQL; never load hashes or ciphers
  // into this read-only overview, and never provision missing owner accounts.
  const [accountRows,mediaRows]=await db.batch([
    db.prepare(`SELECT ${customerAccountColumns} FROM staff_accounts a WHERE a.tenant_id=? AND a.role IN ('admin','store') ORDER BY a.account_role DESC,a.created_at,a.id`).bind(tenantId),
    db.prepare("SELECT id,mime FROM media_files WHERE tenant_id=? AND id IN (SELECT substr(json_extract(value,'$.image'),13) FROM json_each(?))").bind(tenantId,JSON.stringify(stored)),
  ]);
  const accounts=await withAccountAvatars(db,accountRows.results.map(customerAccount)),media=new Set(mediaRows.results.filter(row=>['image/png','image/jpeg','image/webp'].includes(row.mime)).map(row=>row.id));
  const managementAccounts=accounts.filter(account=>account.role==='admin'&&account.storeId===null);
  const owner=managementAccounts.find(account=>account.accountRole==='owner');
  const stores=stored.map(store=>{
    const fields=Object.fromEntries(customerStoreFields.map(key=>[key,['string','number'].includes(typeof store[key])?store[key]:null]));
    const scoped=accounts.filter(account=>account.role==='store'&&account.storeId===store.id);
    const uploaded=imagePath.exec(store.image||'');
    const imageUrl=(uploaded&&media.has(uploaded[1]))||inlineStoreImage(store.image)
      ?'/api/platform/store-image?'+new URLSearchParams({tenant:tenantId,store:store.id}):null;
    return {...fields,imageUrl,hasMaster:scoped.some(account=>account.hasMaster),accounts:scoped};
  });
  return {customer:{id:tenantId,name:org.name,active:org.active===1,plan:org.plan,expiresOn:org.expires_on,ownerName:owner?.name||'',contact:owner?.contact||'',...await organizationAvatar(db,tenantId)},stores,managementAccounts};
}
async function platformStoreImage(env,actor,params) {
  requirePlatformOwner(actor);
  const tenantId=text(params.get('tenant'),'中央厨房',160),storeId=text(params.get('store'),'门店',160),org=await orgFor(env.DB,tenantId);
  const store=org&&JSON.parse(org.core_json).stores?.find(item=>item.id===storeId);
  if(!store)fail('门店不存在。',404);
  let image=inlineStoreImage(store.image);
  if(!image){
    const match=imagePath.exec(store.image||'');if(!match)fail('门店图片不存在。',404);
    const file=await env.DB.prepare('SELECT object_key,mime,bytes FROM media_files WHERE id=? AND tenant_id=?').bind(match[1],tenantId).first();
    if(!file||file.object_key!==tenantId+'/'+match[1]||file.bytes>204800)fail('门店图片不存在。',404);
    const body=await env.MEDIA.get(file.object_key,'arrayBuffer');
    const bytes=body?new Uint8Array(body):null;
    if(!supportedImage(file.mime,bytes))fail('门店图片暂时不可用。',404);
    image={mime:file.mime,bytes};
  }
  return new Response(image.bytes,{headers:{'Content-Type':image.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
async function platformResetPassword(db,actor,body) {
  requirePlatformOwner(actor);
  const fields=['tenantId','storeId','accountId','version','password'];
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length!==fields.length||Object.keys(body).some(key=>!fields.includes(key)))fail('重置密码字段不正确。');
  const tenantId=text(body.tenantId,'中央厨房',160),storeId=body.storeId===null?null:text(body.storeId,'门店',160),accountId=text(body.accountId,'账号',160);
  if(!Number.isSafeInteger(body.version)||body.version<0)fail('请刷新账号信息后重试。',409,'ACCOUNT_CHANGED');
  const org=await orgFor(db,tenantId);if(!org)fail('中央厨房不存在。',404);
  if(storeId&&!validStore(org,storeId))fail('门店不存在或已删除。',404);
  const target=await db.prepare(`SELECT ${customerAccountColumns} FROM staff_accounts a WHERE a.id=? AND a.tenant_id=? AND a.store_id IS ? AND a.role=? AND a.account_role='member' AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=a.id)`).bind(accountId,tenantId,storeId,storeId?'store':'admin').first();
  if(!target)fail('无法重置此管理员的密码。',404);
  if(target.version!==body.version)fail('账号已变更，请刷新后重试。',409,'ACCOUNT_CHANGED');
  const hashed=await passwordHash(body.password);
  try{
    await db.batch([
      db.prepare(`UPDATE staff_accounts SET password_hash=?,version=version+1 WHERE id=? AND tenant_id=? AND store_id IS ? AND role=? AND account_role='member' AND version=?
        AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id)
        AND EXISTS(SELECT 1 FROM staff_accounts p WHERE p.id=? AND p.role='platform' AND p.account_role='owner' AND p.tenant_id IS NULL AND p.store_id IS NULL AND p.status='active')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM tenants t,json_each(t.core_json,'$.stores') s WHERE t.id=? AND json_extract(s.value,'$.id')=? AND COALESCE(json_extract(s.value,'$.deletedAt'),'')=''))`).bind(hashed,target.id,tenantId,storeId,target.role,body.version,actor.userId,storeId,tenantId,storeId),
      guard(db),
      db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(target.id),
      db.prepare('DELETE FROM account_invites WHERE account_id=?').bind(target.id),
      audit(db,actor,'平台重置管理员密码',target.id,tenantId,storeId),
    ]);
  }catch(error){if(/CHECK constraint/.test(error.message))fail('账号或门店已变更，请刷新后重试。',409,'ACCOUNT_CHANGED');throw error;}
  return {ok:true,account:(await withAccountAvatars(db,[customerAccount({...target,version:body.version+1,has_password:1})]))[0]};
}
async function platformList(db,actor) {
  if(actor.role!=='platform')fail('仅平台可访问。',403);
  const rows=await db.prepare("SELECT t.id,t.name,o.plan,o.active,o.expires_on,o.admin_limit,o.store_limit,a.name AS owner_name,a.contact,a.status AS owner_status,k.account_id AS has_master,(SELECT COUNT(*) FROM staff_accounts x WHERE x.tenant_id=t.id AND x.role='admin' AND x.account_role='member' AND x.status!='disabled') AS seats FROM tenants t LEFT JOIN organizations o ON o.tenant_id=t.id LEFT JOIN staff_accounts a ON a.tenant_id=t.id AND a.role='admin' AND a.account_role='owner' LEFT JOIN account_keys k ON k.account_id=a.id ORDER BY t.created_at DESC").all();return {kitchens:await withOrganizationAvatars(db,rows.results)};
}
async function editKitchen(db,actor,body) {
  if(actor.role!=='platform')fail('仅平台可访问。',403);const id=text(body.tenantId||body.id,'中央厨房',160),org=await orgFor(db,id);if(!org)fail('中央厨房尚未开通。',404);const opts=settings(body),active=body.active===false?0:1;
  const details=body.ownerName?[db.prepare("UPDATE staff_accounts SET name=?,contact=? WHERE tenant_id=? AND role='admin' AND account_role='owner'").bind(text(body.ownerName,'负责人姓名'),text(body.contact,'联系方式',120,true),id)]:[];
  await db.batch([db.prepare('UPDATE organizations SET plan=?,active=?,expires_on=?,admin_limit=3,store_limit=3 WHERE tenant_id=?').bind(opts.plan,active,opts.expires,id),...details,...(active?[]:[db.prepare('DELETE FROM account_sessions WHERE account_id IN (SELECT id FROM staff_accounts WHERE tenant_id=?)').bind(id)]),audit(db,actor,active?'更新客户配置':'停用中央厨房',id,id)]);return {ok:true};
}
async function issueSession(db,account,config) {
  const token=randomToken();await db.batch([db.prepare("INSERT INTO account_sessions(hash,account_id,expires,version) SELECT ?,id,?,version FROM staff_accounts WHERE id=? AND version=? AND status='active' AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id)").bind(await hashToken(token),now()+SESSION_AGE,account.id,account.version),guard(db),db.prepare('UPDATE staff_accounts SET last_login=? WHERE id=?').bind(now(),account.id)]);
  return json({principal:await withIdentityAvatars(db,identity(account))},200,{'Set-Cookie':cookie(config,token)});
}
async function accountRate(db,label) { const bucket='account:'+await hashToken(label+':'+Math.floor(now()/900));const row=await db.prepare('INSERT INTO auth_rate_limits(bucket,attempts,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=min(attempts+1,7) RETURNING attempts').bind(bucket,now()+1800).first();if(row.attempts>6)fail('尝试次数较多，请 15 分钟后重试。',429);return bucket; }
async function authEndpoint(request,env,path,config) {
  const db=env.DB;
  if(path==='/api/accounts/session'&&request.method==='GET'){const current=await getIdentity(request,env);return json({authenticated:!!current,principal:current});}
  if(request.method!=='POST')fail('请求方式不正确。',405);const body=await readMutation(request,config.origin);
  if(path==='/api/accounts/logout'){const token=readCookie(request,config);if(token)await db.prepare('DELETE FROM account_sessions WHERE hash=?').bind(await hashToken(token)).run();return json({ok:true},200,{'Set-Cookie':cookie(config,'',0)});}
  await rateLimit(request,env,config.local);
  if(path==='/api/accounts/platform-login') {
    const key=typeof body.key==='string'?body.key.trim():'';if(key.length<64||key.length>256)fail('平台密钥不正确。',401);
    const row=await db.prepare("SELECT a.* FROM account_keys k JOIN staff_accounts a ON a.id=k.account_id WHERE k.kind='platform' AND k.key_hash=? AND a.role='platform' AND a.status='active'").bind(await hashToken(key)).first();if(!row)fail('平台密钥不正确。',401);return issueSession(db,row,config);
  }
  if(path==='/api/accounts/master-login') {
    const code=normalizeCode(body.code),role=body.portal==='kitchen'?'admin':body.portal==='store'?'store':null;if(!code||!role)fail('负责人码不正确或已停用。',401);
    const row=await db.prepare("SELECT a.* FROM account_keys k JOIN staff_accounts a ON a.id=k.account_id WHERE k.kind='master' AND k.key_hash=? AND a.role=? AND a.account_role='owner' AND a.status='active'").bind(await hashToken(code),role).first();if(!row)fail('负责人码不正确或已停用。',401);
    const org=await orgFor(db,row.tenant_id);if(!orgAvailable(org)||(role==='store'&&!validStore(org,row.store_id)))fail('所属中央厨房或门店已停用。',403);return issueSession(db,row,config);
  }
  if(path==='/api/accounts/login') {
    const loginId=username(body.username||body.loginId),role=body.portal==='kitchen'?'admin':body.portal==='store'?'store':null;if(!role||typeof body.password!=='string'||body.password.length>128)fail('账号名或密码不正确。',401);
    const bucket=await accountRate(db,role+':'+loginId),row=await db.prepare("SELECT * FROM staff_accounts WHERE login_id=? AND role=? AND account_role='member' AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id)").bind(loginId,role).first();const matches=await passwordMatches(body.password,row?.password_hash);if(!matches||row?.status!=='active')fail('账号名或密码不正确，或账号已停用。',401);
    const org=await orgFor(db,row.tenant_id);if(!orgAvailable(org)||(role==='store'&&!validStore(org,row.store_id)))fail('所属中央厨房或门店已停用。',403);await db.prepare('DELETE FROM auth_rate_limits WHERE bucket=?').bind(bucket).run();return issueSession(db,row,config);
  }
  if(path==='/api/accounts/profile') {
    const actor=await getIdentity(request,env);if(!actor||actor.accountRole!=='member')fail('请以管理员账号登录。',403);const row=await db.prepare('SELECT * FROM staff_accounts WHERE id=?').bind(actor.userId).first();
    if(typeof body.oldPassword!=='string'||body.oldPassword.length>128||!await passwordMatches(body.oldPassword,row.password_hash))fail('当前密码不正确。');
    const nextName=username(body.username),hashed=body.password?await passwordHash(body.password):row.password_hash;
    try{await db.batch([db.prepare("UPDATE staff_accounts SET login_id=?,password_hash=?,version=version+1 WHERE id=? AND version=? AND status='active' AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=staff_accounts.id)").bind(nextName,hashed,row.id,row.version),guard(db),db.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(row.id),audit(db,actor,'修改自己的登录信息',row.id)]);}catch(error){if(/login_id|staff_username_normalized/.test(error.message))fail('账号名已被使用。',409);if(/CHECK constraint/.test(error.message))fail('账号状态已变更，请重新登录。',409,'ACCOUNT_CHANGED');throw error;}
    return json({ok:true},200,{'Set-Cookie':cookie(config,'',0)});
  }
  fail('接口不存在。',404);
}
export async function handleAccounts(request,env) {
  const url=new URL(request.url),path=url.pathname;if(!path.startsWith('/api/accounts/')&&!path.startsWith('/api/platform/')&&!path.startsWith('/api/team/'))return null;
  try {
    if(['/api/platform/customer','/api/platform/store-image','/api/platform/staff/password','/api/team/delete','/api/team/restore','/api/team/list'].includes(path)&&env.DB.withSession)env={...env,DB:env.DB.withSession('first-primary')};
    const config=deployment(request,env);if(path.startsWith('/api/accounts/'))return await authEndpoint(request,env,path,config);
    const actor=await getIdentity(request,env);if(!actor)fail('请先登录。',401);
    if(request.method==='GET') {
      if(path==='/api/platform/customer')return json(await platformCustomer(env.DB,actor,url.searchParams));
      if(path==='/api/platform/store-image')return await platformStoreImage(env,actor,url.searchParams);
      if(path==='/api/platform/kitchens')return json(await platformList(env.DB,actor));
      if(path==='/api/team/list')return json(await listStaff(env.DB,env,actor,url.searchParams));
      if(path==='/api/team/audit'){if(actor.role!=='platform'&&actor.accountRole!=='owner')fail('仅负责人可查看。',403);const tenantId=actor.role==='platform'?url.searchParams.get('tenant')||null:actor.tenantId;const result=await env.DB.prepare(`SELECT actor_name,action,target_id,created_at FROM account_audit WHERE (? IS NULL OR tenant_id=?) ${actor.role==='store'?'AND store_id=?':''} ORDER BY created_at DESC LIMIT 100`).bind(tenantId,tenantId,...(actor.role==='store'?[actor.storeId]:[])).all();return json({events:result.results});}
    }
    if(request.method!=='POST')fail('请求方式不正确。',405);const body=await readMutation(request,config.origin);
    if(path==='/api/platform/create')return json(await createKitchen(env.DB,env,actor,body),201);
    if(path==='/api/platform/update')return json(await editKitchen(env.DB,actor,body));
    if(path==='/api/platform/staff/password')return json(await platformResetPassword(env.DB,actor,body));
    if(path==='/api/team/create')return json(await createStaff(env.DB,actor,body),201);
    if(path==='/api/team/update')return json(await manageStaff(env.DB,actor,body));
    if(path==='/api/team/delete')return json(await archiveStaff(env.DB,actor,body));
    if(path==='/api/team/restore')return json(await archiveStaff(env.DB,actor,body,true));
    if(path==='/api/team/master-key')return json(await masterKeyAction(env.DB,env,actor,body));
    if(path==='/api/platform/upgrade-existing'){if(actor.role!=='platform')fail('无权访问。',403);return json(await migrateExistingOrganizations(env.DB,env));}
    fail('接口不存在。',404);
  }catch(error){const status=error.status||500;if(status>=500)console.error(JSON.stringify({event:'account_error',path,code:error.code||'internal'}));return json({error:status<500?error.message:'账号服务暂时不可用，请稍后重试。',code:error.code},status);}
}
