import {deployment} from './auth.js';

const MAX_BYTES=204800,MAX_JSON=280000;
const fail=(message,status=400,code='AVATAR_ERROR')=>{throw Object.assign(new Error(message),{status,code});};
const isPlatformOwner=actor=>actor.role==='platform'&&actor.accountRole==='owner'&&actor.tenantId==null&&actor.storeId==null;
const isPlatform=actor=>actor.role==='platform'&&['owner','member'].includes(actor.accountRole)&&actor.tenantId==null&&actor.storeId==null;
const identifier=value=>{if(typeof value!=='string'||!value.trim()||value.length>160)fail('头像所属账号或组织不正确。');return value;};
const metadata=(kind,id,row)=>({avatarUrl:row?.has_image?'/api/'+(kind==='account'?'account-avatar?account=':'organization-avatar?tenant=')+encodeURIComponent(id)+'&v='+row.version:null,avatarVersion:row?.version||0});

export const avatarRoutes=new Set(['/api/account-avatar','/api/organization-avatar','/api/team/avatar','/api/organization/avatar']);

export async function withAccountAvatars(db,accounts) {
  if(!accounts.length)return accounts;
  const ids=[...new Set(accounts.map(row=>row.id))];
  const rows=await db.prepare('SELECT account_id,version,image IS NOT NULL AS has_image FROM account_avatars WHERE account_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all();
  const byId=new Map(rows.results.map(row=>[row.account_id,row]));
  return accounts.map(account=>({...account,...metadata('account',account.id,byId.get(account.id))}));
}
export async function organizationAvatar(db,tenantId) {
  if(!tenantId)return {avatarUrl:null,avatarVersion:0};
  return metadata('organization',tenantId,await db.prepare('SELECT version,image IS NOT NULL AS has_image FROM organization_avatars WHERE tenant_id=?').bind(tenantId).first());
}
export async function withIdentityAvatars(db,actor) {
  const [accounts,organization]=await Promise.all([withAccountAvatars(db,[actor]),organizationAvatar(db,actor.tenantId)]);
  return {...accounts[0],organizationAvatarUrl:organization.avatarUrl,organizationAvatarVersion:organization.avatarVersion};
}
export async function withOrganizationAvatars(db,organizations) {
  if(!organizations.length)return organizations;
  const rows=await db.prepare('SELECT tenant_id,version,image IS NOT NULL AS has_image FROM organization_avatars WHERE tenant_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(organizations.map(row=>row.id||row.tenantId))).all();
  const byId=new Map(rows.results.map(row=>[row.tenant_id,row]));
  return organizations.map(row=>({...row,...metadata('organization',row.id||row.tenantId,byId.get(row.id||row.tenantId))}));
}

const dimension=(width,height)=>Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=4096&&height<=4096&&width*height<=4000000;
const u32=(bytes,at)=>((bytes[at]*0x1000000)+(bytes[at+1]<<16)+(bytes[at+2]<<8)+bytes[at+3])>>>0;
const le32=(bytes,at)=>u32(Uint8Array.of(bytes[at+3],bytes[at+2],bytes[at+1],bytes[at]),0);
function crc(bytes,start,end) {let value=0xffffffff;for(let i=start;i<end;i++){value^=bytes[i];for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function validPNG(bytes) {
  if(!Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
  let at=8,header=false,data=false,end=false;
  while(at+12<=bytes.length){const length=u32(bytes,at),type=Buffer.from(bytes.subarray(at+4,at+8)).toString('ascii');if(length>MAX_BYTES||at+12+length>bytes.length||crc(bytes,at+4,at+8+length)!==u32(bytes,at+8+length))return false;
    if(!header){if(type!=='IHDR'||length!==13||!dimension(u32(bytes,at+8),u32(bytes,at+12)))return false;const depth=bytes[at+16],color=bytes[at+17];if(!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color]?.includes(depth))||bytes[at+18]!==0||bytes[at+19]!==0||bytes[at+20]>1)return false;header=true;}
    else if(type==='IHDR')return false;
    if(type==='IDAT'){if(!length)return false;data=true;}
    at+=12+length;if(type==='IEND'){if(length||!data||at!==bytes.length)return false;end=true;break;}
  }
  return header&&data&&end;
}
function validJPEG(bytes) {
  if(bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return false;
  let at=2,frame=false,scan=false;
  while(at<bytes.length-2){if(bytes[at++]!==255)return false;while(bytes[at]===255)at++;const marker=bytes[at++];
    if(marker===0xda){if(!frame||at+2>bytes.length)return false;const length=bytes[at]*256+bytes[at+1];if(length<6||at+length>=bytes.length-2)return false;scan=true;break;}
    if(marker===0xd8||marker===0xd9||marker===0||marker>=0xd0&&marker<=0xd7)return false;
    if(at+2>bytes.length)return false;const length=bytes[at]*256+bytes[at+1];if(length<2||at+length>bytes.length-2)return false;
    if([0xc0,0xc1,0xc2].includes(marker)){if(length<11||!dimension(bytes[at+5]*256+bytes[at+6],bytes[at+3]*256+bytes[at+4]))return false;frame=true;}
    at+=length;
  }
  return frame&&scan;
}
function validWEBP(bytes) {
  if(Buffer.from(bytes.subarray(0,4)).toString()!=='RIFF'||Buffer.from(bytes.subarray(8,12)).toString()!=='WEBP'||le32(bytes,4)!==bytes.length-8)return false;
  let at=12,frame=false;
  while(at+8<=bytes.length){const type=Buffer.from(bytes.subarray(at,at+4)).toString(),length=le32(bytes,at+4),start=at+8;if(!length||start+length>bytes.length)return false;
    if(type==='ANIM'||type==='ANMF')return false;
    if(type==='VP8 '){if(length<10||bytes[start+3]!==157||bytes[start+4]!==1||bytes[start+5]!==42||!dimension((bytes[start+6]|bytes[start+7]<<8)&16383,(bytes[start+8]|bytes[start+9]<<8)&16383))return false;frame=true;}
    if(type==='VP8L'){if(length<5||bytes[start]!==47)return false;const bits=le32(bytes,start+1);if(!dimension((bits&16383)+1,((bits>>>14)&16383)+1))return false;frame=true;}
    if(type==='VP8X'){if(length!==10||bytes[start]&2)return false;const width=1+bytes[start+4]+(bytes[start+5]<<8)+(bytes[start+6]<<16),height=1+bytes[start+7]+(bytes[start+8]<<8)+(bytes[start+9]<<16);if(!dimension(width,height))return false;}
    at=start+length+(length%2);
  }
  return frame&&at===bytes.length;
}
export function parseAvatarImage(value) {
  if(value===null)return {mime:null,bytes:null};
  if(typeof value!=='string'||value.length>MAX_JSON)fail('头像须为压缩后的 PNG、JPEG 或 WebP，最大 200 KB。');
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match||match[2].length%4!==0)fail('头像图片格式不正确。');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length<16||bytes.length>MAX_BYTES||bytes.toString('base64')!==match[2]||!(match[1]==='image/png'?validPNG(bytes):match[1]==='image/jpeg'?validJPEG(bytes):validWEBP(bytes)))fail('头像图片无法读取，请重新上传有效图片。');
  return {mime:match[1],bytes};
}

async function scopedAccount(db,actor,id,write=false) {
  const target=await db.prepare('SELECT a.id,a.tenant_id,a.store_id,a.role,a.account_role,a.status,(SELECT deleted_at FROM staff_account_archives x WHERE x.account_id=a.id) AS deleted_at FROM staff_accounts a WHERE a.id=?').bind(identifier(id)).first();
  if(!target)fail('账号不存在。',404);
  const self=target.id===actor.userId;
  const ownTenant=target.tenant_id===actor.tenantId&&actor.tenantId!=null;
  const ownTeam=ownTenant&&target.role===actor.role&&target.store_id===actor.storeId;
  const kitchenOwner=actor.role==='admin'&&actor.accountRole==='owner'&&ownTenant&&['admin','store'].includes(target.role);
  const storeOwner=actor.role==='store'&&actor.accountRole==='owner'&&ownTeam;
  if(!(self||isPlatformOwner(actor)||kitchenOwner||storeOwner||!write&&(ownTeam||isPlatform(actor))))fail('无权访问此账号头像。',403);
  if(target.deleted_at&&(write||!(isPlatformOwner(actor)||kitchenOwner||storeOwner)))fail('此管理员已删除，请先恢复。',404);
  if(write&&!self&&!isPlatformOwner(actor)&&!kitchenOwner&&!storeOwner)fail('仅负责人可以修改其他员工头像。',403);
  if(target.role==='platform'&&!self&&!isPlatform(actor))fail('无权访问此账号头像。',403);
  if(write&&target.store_id){const tenant=await db.prepare('SELECT core_json FROM tenants WHERE id=?').bind(target.tenant_id).first();if(!tenant||!JSON.parse(tenant.core_json).stores?.some(store=>store.id===target.store_id&&!store.deletedAt))fail('门店不存在或已删除。',404);}
  return target;
}
async function scopedOrganization(db,actor,id,write=false) {
  const tenantId=identifier(id);
  if(!isPlatform(actor)&&actor.tenantId!==tenantId)fail('无权访问此厨房头像。',403);
  if(write&&!isPlatformOwner(actor)&&!(actor.role==='admin'&&actor.accountRole==='owner'&&actor.tenantId===tenantId))fail('仅厨房负责人可以修改厨房头像。',403);
  const tenant=await db.prepare('SELECT id FROM tenants WHERE id=?').bind(tenantId).first();if(!tenant)fail('中央厨房不存在。',404);return tenant;
}
async function readAvatar(db,actor,kind,id) {
  if(kind==='account')await scopedAccount(db,actor,id);else await scopedOrganization(db,actor,id);
  const row=await db.prepare(`SELECT mime,image FROM ${kind==='account'?'account_avatars WHERE account_id':'organization_avatars WHERE tenant_id'}=?`).bind(id).first();
  if(!row?.image)fail('头像不存在。',404);
  return new Response(new Uint8Array(row.image),{headers:{'Content-Type':row.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
async function readBody(request,env) {
  const config=deployment(request,env);
  if(request.headers.get('Origin')!==config.origin||request.headers.get('Sec-Fetch-Site')==='cross-site')fail('请求来源不正确。',403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail('请使用 JSON 请求。',415);
  if(Number(request.headers.get('Content-Length'))>MAX_JSON)fail('头像上传内容过大。',413);
  const reader=request.body?.getReader();if(!reader)fail('请求内容不正确。');let length=0;const parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_JSON){await reader.cancel();fail('头像上传内容过大。',413);}parts.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail('请求内容不正确。');}
}
async function saveAvatar(db,actor,kind,body) {
  const idKey=kind==='account'?'accountId':'tenantId';
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==3||Object.keys(body).some(key=>![idKey,'image','version'].includes(key)))fail('头像字段不正确。');
  const id=identifier(body[idKey]);if(!Number.isSafeInteger(body.version)||body.version<0)fail('请刷新头像后重试。',409,'AVATAR_CHANGED');
  const target=kind==='account'?await scopedAccount(db,actor,id,true):await scopedOrganization(db,actor,id,true);
  const image=parseAvatarImage(body.image),stamp=Math.floor(Date.now()/1000),table=kind==='account'?'account_avatars':'organization_avatars',key=kind==='account'?'account_id':'tenant_id';
  // Recheck account status/scope and store existence inside the write, so a
  // disable or deletion racing validation cannot leave an unauthorized update.
  const actorGuard="EXISTS(SELECT 1 FROM staff_accounts a WHERE a.id=? AND a.status='active' AND a.role=? AND a.account_role=? AND a.tenant_id IS ? AND a.store_id IS ? AND (a.role='platform' OR EXISTS(SELECT 1 FROM organizations o WHERE o.tenant_id=a.tenant_id AND o.active=1 AND (o.expires_on IS NULL OR o.expires_on>=?))))";
  const targetGuard=kind==='account'?"EXISTS(SELECT 1 FROM staff_accounts t WHERE t.id=? AND t.tenant_id IS ? AND t.store_id IS ? AND t.role=? AND t.account_role=? AND NOT EXISTS(SELECT 1 FROM staff_account_archives x WHERE x.account_id=t.id)) AND (? IS NULL OR EXISTS(SELECT 1 FROM tenants z,json_each(z.core_json,'$.stores') s WHERE z.id=? AND json_extract(s.value,'$.id')=? AND COALESCE(json_extract(s.value,'$.deletedAt'),'')=''))":"EXISTS(SELECT 1 FROM tenants WHERE id=?)";
  const actorParams=[actor.userId,actor.role,actor.accountRole,actor.tenantId??null,actor.storeId??null,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())];
  const targetParams=kind==='account'?[target.id,target.tenant_id,target.store_id,target.role,target.account_role,target.store_id,target.tenant_id,target.store_id]:[id];
  try{await db.batch([
    db.prepare(`INSERT INTO ${table}(${key},mime,image,version,updated_at,updated_by) SELECT ?,?,?,1,?,? WHERE COALESCE((SELECT version FROM ${table} WHERE ${key}=?),0)=? AND ${actorGuard} AND ${targetGuard} ON CONFLICT(${key}) DO UPDATE SET mime=excluded.mime,image=excluded.image,version=${table}.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE ${table}.version=?`).bind(id,image.mime,image.bytes?new Uint8Array(image.bytes).buffer:null,stamp,actor.userId,id,body.version,...actorParams,...targetParams,body.version),
    db.prepare('INSERT INTO auth_atomic_guard(id,ok) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok'),
    db.prepare('INSERT INTO account_audit(id,tenant_id,store_id,actor_id,actor_name,action,target_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),kind==='account'?target.tenant_id:id,kind==='account'?target.store_id:null,actor.userId,actor.displayName||'',kind==='account'?'更新个人头像':'更新厨房头像',id,stamp),
  ]);}catch(error){if(/CHECK constraint/.test(error.message))fail('头像或账号已变更，请刷新后重试。',409,'AVATAR_CHANGED');throw error;}
  const updated=metadata(kind,id,{version:body.version+1,has_image:image.bytes?1:0});
  return kind==='account'?{ok:true,account:{id,...updated}}:{ok:true,organization:{tenantId:id,...updated}};
}
export async function handleAvatars(request,env,actor) {
  const url=new URL(request.url),path=url.pathname;
  if(request.method==='GET'&&(path==='/api/account-avatar'||path==='/api/organization-avatar'))return readAvatar(env.DB,actor,path==='/api/account-avatar'?'account':'organization',identifier(url.searchParams.get(path==='/api/account-avatar'?'account':'tenant')));
  if(request.method==='POST'&&(path==='/api/team/avatar'||path==='/api/organization/avatar'))return Response.json(await saveAvatar(env.DB,actor,path==='/api/team/avatar'?'account':'organization',await readBody(request,env)),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  fail('请求方式不正确。',405);
}
