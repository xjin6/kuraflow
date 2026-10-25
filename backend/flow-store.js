import {cleanAttachmentRefs} from '../src/shared/flow-attachment-data.js';
import {cleanFlowMessages,sanitizeFlowSVG} from './flow-content.js';
import {flowStorageScope,flowConnectionScope} from './flow-scope.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT=100;
const encoder=new TextEncoder(),decoder=new TextDecoder();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clip=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const modelId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
function catalogueData(value) {
  if(!Array.isArray(value?.models)||value.models.length>1000)fail('模型目录格式不正确。');
  const models=new Map();
  for(const row of value.models){
    if(!modelId(row?.id)||typeof row.name!=='string'||row.name.length>160)fail('模型目录格式不正确。');
    models.set(row.id,{id:row.id,name:row.name});
  }
  return {models:[...models.values()]};
}
function actor(principal,owner=false) {
  if(owner)flowConnectionScope(principal,true);
  return flowStorageScope(principal);
}
function checkedId(id) {if(typeof id!=='string'||!UUID.test(id))fail('未找到该记录。',404);return id;}
const changed=result=>Number(result?.meta?.changes||0)>0;
function version(value) {if(!Number.isSafeInteger(value)||value<1)fail('内容已在其他窗口更新，请重新打开后继续。',409);return value;}
function publicConversation(row) {
  const data=JSON.parse(row.data_json);
  return {id:row.id,title:row.title,version:row.version,messages:data.messages,draft:data.draft,attachments:data.attachments||[],updatedAt:row.updated_at};
}
function base64url(bytes) {
  let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function decode64(value) {
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid cipher');
  const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(raw,char=>char.charCodeAt(0));
}

// Create per request; the D1 session and derived key never cross request/tenant contexts.
export function createFlowStore(env,{now=Date.now}={}) {
  if(!env.DB?.prepare)fail('Flow 存储暂不可用。',503);
  const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
  let key;
  async function cipherKey() {
    if(!/^[a-f0-9]{64}$/.test(env.STORE_CODE_KEY||''))fail('Flow 连接存储尚未配置。',503);
    if(!key)key=(async()=>{
      const raw=Uint8Array.from(env.STORE_CODE_KEY.match(/.{2}/g),byte=>parseInt(byte,16));
      const source=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
      return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('kuraflow-flow'),info:encoder.encode('flow-storage-v1')},source,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    })();
    return key;
  }
  const aad=(namespace,ids)=>encoder.encode(JSON.stringify(['flow-storage-v1',namespace,...ids]));
  async function encrypt(namespace,ids,data) {
    if(!data||typeof data!=='object'||Array.isArray(data))fail('连接内容格式不正确。');
    const raw=encoder.encode(JSON.stringify(data));
    if(raw.length>64000)fail('连接内容过大。',413);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const content=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(namespace,ids)},await cipherKey(),raw);
    return 'v1.'+base64url(iv)+'.'+base64url(new Uint8Array(content));
  }
  async function decrypt(namespace,ids,cipher) {
    const secret=await cipherKey();
    try {
      const parts=cipher.split('.');if(parts.length!==3||parts[0]!=='v1')throw new Error('Invalid cipher');
      const iv=decode64(parts[1]);if(iv.length!==12)throw new Error('Invalid cipher');
      const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(namespace,ids)},secret,decode64(parts[2]));
      return JSON.parse(decoder.decode(raw));
    } catch {fail('Flow 连接资料无法读取，请重新连接。',503);}
  }
  async function getConnection(principal) {
    const tenantId=flowConnectionScope(principal);
    const row=await db.prepare('SELECT data_cipher,version FROM flow_connections WHERE tenant_id=?').bind(tenantId).first();
    return row?{data:await decrypt('connection',[tenantId],row.data_cipher),version:row.version}:null;
  }
  async function saveConnection(principal,data,expectedVersion=null) {
    const tenantId=flowConnectionScope(principal,true),cipher=await encrypt('connection',[tenantId],data),updatedAt=new Date(now()).toISOString();
    const result=expectedVersion===null
      ?await db.prepare('INSERT INTO flow_connections(tenant_id,data_cipher,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(tenant_id) DO NOTHING').bind(tenantId,cipher,updatedAt).run()
      :await db.prepare('UPDATE flow_connections SET data_cipher=?,version=version+1,updated_at=? WHERE tenant_id=? AND version=?').bind(cipher,updatedAt,tenantId,version(expectedVersion)).run();
    if(!changed(result))fail('模型连接已更新，请刷新后重试。',409);
    return {data,version:expectedVersion===null?1:expectedVersion+1};
  }
  async function getModelCatalogue(principal,connectionVersion) {
    const tenantId=flowConnectionScope(principal);
    // A lookup may follow slow upstream I/O. Start at primary again so a
    // concurrently replaced token cannot reuse this request's older bookmark.
    const latest=env.DB.withSession?env.DB.withSession('first-primary'):db;
    const row=await latest.prepare('SELECT m.data_json,m.fetched_at FROM flow_model_catalogues m JOIN flow_connections c ON c.tenant_id=m.tenant_id AND c.version=m.connection_version WHERE m.tenant_id=? AND m.connection_version=?').bind(tenantId,version(connectionVersion)).first();
    if(!row||!Number.isSafeInteger(row.fetched_at)||row.fetched_at<0)return null;
    try{return {...catalogueData(JSON.parse(row.data_json)),fetchedAt:row.fetched_at};}catch{return null;}
  }
  async function saveModelCatalogue(principal,connectionVersion,snapshot) {
    const tenantId=flowConnectionScope(principal),connection=version(connectionVersion),data=JSON.stringify(catalogueData(snapshot));
    if(!Number.isSafeInteger(snapshot.fetchedAt)||snapshot.fetchedAt<0||snapshot.fetchedAt>now()+30000)fail('模型目录时间无效。');
    // The INSERT and its current-connection check are one statement: a slow
    // response cannot restore a catalogue from a replaced GitHub connection.
    const result=await db.prepare('INSERT INTO flow_model_catalogues(tenant_id,connection_version,data_json,fetched_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM flow_connections WHERE tenant_id=? AND version=?) ON CONFLICT(tenant_id) DO UPDATE SET connection_version=excluded.connection_version,data_json=excluded.data_json,fetched_at=excluded.fetched_at WHERE flow_model_catalogues.connection_version<>excluded.connection_version OR flow_model_catalogues.fetched_at<=excluded.fetched_at').bind(tenantId,connection,data,snapshot.fetchedAt,tenantId,connection).run();
    return changed(result);
  }
  async function deleteModelCatalogue(principal,connectionVersion) {
    const tenantId=flowConnectionScope(principal);
    const result=await db.prepare('DELETE FROM flow_model_catalogues WHERE tenant_id=? AND connection_version=?').bind(tenantId,version(connectionVersion)).run();
    return changed(result);
  }
  async function getAuth(principal,id) {
    const ids=[...actor(principal,true),checkedId(id)];
    const row=await db.prepare('SELECT data_cipher,version,expires_at FROM flow_auth WHERE tenant_id=? AND user_id=? AND id=?').bind(...ids).first();
    if(!row)fail('未找到该登录请求。',404);
    if(row.expires_at<=now())fail('登录请求已过期，请重新连接。',410);
    return {data:await decrypt('auth',ids,row.data_cipher),version:row.version};
  }
  async function saveAuth(principal,id,data,expiresAt,expectedVersion=null) {
    const ids=[...actor(principal,true),checkedId(id)],time=now();
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=time||expiresAt>time+86400000)fail('登录请求已过期，请重新连接。',410);
    const cipher=await encrypt('auth',ids,data);
    const result=expectedVersion===null
      ?await db.prepare('INSERT INTO flow_auth(tenant_id,user_id,id,data_cipher,version,expires_at) VALUES(?,?,?,?,1,?) ON CONFLICT(tenant_id,user_id,id) DO NOTHING').bind(...ids,cipher,expiresAt).run()
      :await db.prepare('UPDATE flow_auth SET data_cipher=?,version=version+1,expires_at=? WHERE tenant_id=? AND user_id=? AND id=? AND version=? AND expires_at>?').bind(cipher,expiresAt,...ids,version(expectedVersion),time).run();
    if(!changed(result))fail('登录请求已更新，请重试。',409);
    return {data,version:expectedVersion===null?1:expectedVersion+1};
  }
  async function deleteAuth(principal,id) {
    const ids=[...actor(principal,true),checkedId(id)];
    await db.prepare('DELETE FROM flow_auth WHERE tenant_id=? AND user_id=? AND id=?').bind(...ids).run();
    return {ok:true};
  }
  async function read(principal,id) {
    const ids=[...actor(principal),checkedId(id)];
    const row=await db.prepare('SELECT * FROM flow_conversations WHERE tenant_id=? AND user_id=? AND id=?').bind(...ids).first();
    if(!row)fail('未找到该对话。',404);return row;
  }
  async function get(principal,id) {
    const row=await read(principal,id);if(row.deleted_at)fail('该对话已删除，可撤销删除后继续。',410);
    return publicConversation(row);
  }
  async function list(principal) {
    const ids=actor(principal);
    const result=await db.prepare("SELECT id,title,updated_at,json_array_length(data_json,'$.messages') AS message_count FROM flow_conversations WHERE tenant_id=? AND user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 100").bind(...ids).all();
    return {limit:LIMIT,conversations:result.results.map(row=>({id:row.id,title:row.title,updatedAt:row.updated_at,messageCount:row.message_count}))};
  }
  async function save(principal,body) {
    const ids=actor(principal);
    if(!body||typeof body!=='object')fail('对话内容格式不正确。');
    const prior=body.id?await read(principal,body.id):null;
    if(prior?.deleted_at)fail('该对话已删除，未覆盖已删除的内容。',410);
    if(prior&&version(body.version)!==prior.version)fail('对话已在其他窗口更新，请重新打开后继续。',409);
    const messages=cleanFlowMessages(body.messages),draft=body.draft??'';
    if(typeof draft!=='string'||draft.length>4000)fail('草稿过长。');
    const imageIds=[...new Set(messages.flatMap(row=>row.images||[]).filter(image=>image.url.startsWith('/api/flow/artifacts/')).map(image=>image.url.split('/').at(-1)))];
    for(let offset=0;offset<imageIds.length;offset+=80){
      const batch=imageIds.slice(offset,offset+80);
      const found=await db.prepare(`SELECT id FROM flow_artifacts WHERE tenant_id=? AND user_id=? AND id IN (${batch.map(()=>'?').join(',')})`).bind(...ids,...batch).all();
      if(found.results.length!==batch.length)fail('图片不存在或已不可用。',404);
    }
    const data=JSON.stringify({messages,draft,attachments:cleanAttachmentRefs(body.attachments||[])});if(encoder.encode(data).length>512000)fail('对话内容过大，请新建对话。',413);
    const id=prior?.id||crypto.randomUUID(),title=clip(messages.find(message=>message.role==='user')?.text.replace(/\s+/g,' ').trim(),48)||'新对话',updatedAt=new Date(now()).toISOString();
    const row=prior
      ?await db.prepare('UPDATE flow_conversations SET title=?,data_json=?,version=version+1,updated_at=? WHERE tenant_id=? AND user_id=? AND id=? AND version=? AND deleted_at IS NULL RETURNING *').bind(title,data,updatedAt,...ids,id,body.version).first()
      :await db.prepare('INSERT INTO flow_conversations(tenant_id,user_id,id,title,data_json,version,updated_at,deleted_at) SELECT ?,?,?,?,?,1,?,NULL WHERE (SELECT COUNT(*) FROM flow_conversations WHERE tenant_id=? AND user_id=? AND deleted_at IS NULL)<? RETURNING *').bind(...ids,id,title,data,updatedAt,...ids,LIMIT).first();
    if(!row)fail(prior?'对话已在其他窗口更新，请重新打开后继续。':'对话已达到 100 条，请删除不需要的对话。',409);
    return publicConversation(row);
  }
  async function remove(principal,id) {
    const ids=[...actor(principal),checkedId(id)],deletedAt=new Date(now()).toISOString();
    const result=await db.prepare('UPDATE flow_conversations SET deleted_at=?,version=version+1 WHERE tenant_id=? AND user_id=? AND id=? AND deleted_at IS NULL').bind(deletedAt,...ids).run();
    if(!changed(result))await read(principal,id);
    return {ok:true};
  }
  async function restore(principal,id) {
    const ids=actor(principal),prior=await read(principal,id);
    if(!prior.deleted_at)return publicConversation(prior);
    const row=await db.prepare('UPDATE flow_conversations SET deleted_at=NULL,version=version+1,updated_at=? WHERE tenant_id=? AND user_id=? AND id=? AND version=? AND deleted_at IS NOT NULL AND (SELECT COUNT(*) FROM flow_conversations WHERE tenant_id=? AND user_id=? AND deleted_at IS NULL)<? RETURNING *').bind(new Date(now()).toISOString(),...ids,id,prior.version,...ids,LIMIT).first();
    if(!row)fail('对话列表已更新或已满，请刷新后重试。',409);
    return publicConversation(row);
  }
  async function createArtifact(principal,{svg,title}) {
    const ids=actor(principal),content=sanitizeFlowSVG(svg),id=crypto.randomUUID(),cleanTitle=clip(title,160)||'Flow 图片';
    await db.prepare('INSERT INTO flow_artifacts(tenant_id,user_id,id,svg,title,created_at) VALUES(?,?,?,?,?,?)').bind(...ids,id,content,cleanTitle,new Date(now()).toISOString()).run();
    return {id,url:'/api/flow/artifacts/'+id,title:cleanTitle,alt:clip(title,200)||'Flow 生成的图片'};
  }
  async function getArtifact(principal,id) {
    const ids=[...actor(principal),checkedId(id)];
    const row=await db.prepare('SELECT svg FROM flow_artifacts WHERE tenant_id=? AND user_id=? AND id=?').bind(...ids).first();
    if(!row)fail('图片不存在或已不可用。',404);return row.svg;
  }
  function checkedLease(scope,owner) {
    if(typeof scope!=='string'||!scope||scope.length>1024||typeof owner!=='string'||!owner||owner.length>256)fail('请求锁格式不正确。');
  }
  async function acquireLease(scope,owner,ttlMs) {
    checkedLease(scope,owner);
    if(!Number.isFinite(ttlMs)||ttlMs<=0)fail('请求锁期限不正确。');
    const time=now(),expiresAt=time+Math.min(Math.ceil(ttlMs),180000);
    const result=await db.prepare('INSERT INTO flow_leases(scope,owner,expires_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE flow_leases.expires_at<=?').bind(scope,owner,expiresAt,time).run();
    return changed(result);
  }
  async function releaseLease(scope,owner) {
    checkedLease(scope,owner);
    await db.prepare('DELETE FROM flow_leases WHERE scope=? AND owner=?').bind(scope,owner).run();
  }
  return {getConnection,saveConnection,getModelCatalogue,saveModelCatalogue,deleteModelCatalogue,getAuth,saveAuth,deleteAuth,list,get,save,remove,restore,createArtifact,getArtifact,acquireLease,releaseLease};
}
