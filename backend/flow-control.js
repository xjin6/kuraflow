import {getIdentity} from './accounts.js';
import {createFlowStore} from './flow-store.js';
import {createFlowProvider} from './flow-provider.js';
import {PLATFORM_FLOW_SCOPE,flowConnectionScope} from './flow-scope.js';
import {getPortalFeaturePolicy,getPortalFeatureMatrix,checkedPortalFlags,portalFeatureStatement} from './portal-features.js';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
const json=(value,status=200)=>Response.json(value,{status,headers});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status,publicError:true});};
const safeModel=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
const safeError=error=>{
  const message=String(error?.message||'');
  if(!error?.publicError&&!Number.isInteger(error?.status)||!/[\u3400-\u9fff]/.test(message)||/(?:gh[opusr]_|github_pat_|bearer\s|sk-|token\s*[:=]|https?:\/\/|\/Users\/|\/home\/|\b(?:SELECT|INSERT|UPDATE|DELETE|SQLITE|D1_ERROR)\b)/i.test(message))return 'Flow 配置暂时无法完成，请稍后重试。';
  return message.slice(0,240);
};
const dbFor=envOrDB=>{const db=envOrDB.DB||envOrDB;if(!db?.prepare)fail('Flow 功能配置暂不可用。',503);return db.withSession?db.withSession('first-primary'):db;};

/** No policy row means unlicensed. Read from the primary so revocation is not replica-delayed. */
export async function getFlowPolicy(envOrDB,tenantId) {
  if(typeof tenantId!=='string'||!tenantId)fail('管理端范围不正确。',403);
  if(tenantId===PLATFORM_FLOW_SCOPE){const row=await dbFor(envOrDB).prepare('SELECT flow_enabled,flow_model,version FROM platform_features WHERE id=1').first();return row?{enabled:row.flow_enabled===1,model:safeModel(row.flow_model)?row.flow_model:null,version:row.version}:{enabled:false,model:null,version:0};}
  const row=await dbFor(envOrDB).prepare('SELECT flow_enabled,flow_model,version FROM tenant_features WHERE tenant_id=?').bind(tenantId).first();
  return row?{enabled:row.flow_enabled===1,model:safeModel(row.flow_model)?row.flow_model:null,version:row.version}:{enabled:false,model:null,version:0};
}

async function multilingualPolicy(db,tenantId) {
  const row=await db.prepare('SELECT multilingual_enabled FROM tenant_ui_features WHERE tenant_id=?').bind(tenantId).first();
  return row?.multilingual_enabled===1;
}

/** UI capability reads are scoped to the authenticated account, never URL parameters. */
export async function getUIFeatures(envOrDB,actor) {
  return getPortalFeaturePolicy(envOrDB,actor);
}

function assertPlatform(actor) {
  if(!actor)fail('请先登录平台端。',401);
  if(actor.role!=='platform'||actor.accountRole!=='owner'||!actor.userId||actor.storeId||actor.tenantId)fail('仅平台负责人可以配置功能。',403);
}
function origin(request,env) {
  const url=new URL(request.url),local=env.LOCAL_TEST==='1'&&['localhost','127.0.0.1'].includes(url.hostname);
  if((!local&&(!env.PUBLIC_ORIGIN||env.PUBLIC_ORIGIN!==url.origin))||request.headers.get('Origin')!==url.origin||request.headers.get('Sec-Fetch-Site')==='cross-site')fail('请求来源不正确。',403);
}
async function bodyOf(request) {
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')fail('请使用 JSON 请求。',415);
  if(Number(request.headers.get('Content-Length'))>8192)fail('请求内容过长。',413);
  const reader=request.body?.getReader(),parts=[];let length=0;
  if(reader)try{for(;;){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192){await reader.cancel();fail('请求内容过长。',413);}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('请求格式不正确。');}
  if(!body||typeof body!=='object'||Array.isArray(body))fail('请求格式不正确。');return body;
}
function publicConnection(value={},saved) {
  const configured=Boolean(saved?.data?.githubToken)||value.configured===true;
  const result={configured,hasToken:configured,connected:value.connected===true,model:safeModel(saved?.data?.model)?saved.data.model:'',models:(Array.isArray(value.models)?value.models:[]).filter(row=>safeModel(row?.id)).slice(0,300).map(row=>({id:row.id,name:typeof row.name==='string'?row.name.slice(0,160):row.id}))};
  if(['fresh','cached','stale'].includes(value.cacheState))result.cacheState=value.cacheState;
  if(typeof value.fetchedAt==='string'||Number.isFinite(value.fetchedAt))result.fetchedAt=value.fetchedAt;
  if(value.stale===true)result.stale=true;
  if(typeof value.retryable==='boolean')result.retryable=value.retryable;
  for(const key of ['message','refreshError'])if(typeof value[key]==='string'&&value[key])result[key]=safeError({message:value[key],publicError:true});
  return result;
}
function audit(db,actor,action,tenantId) {
  return db.prepare('INSERT INTO account_audit(id,tenant_id,store_id,actor_id,actor_name,action,target_id,created_at) VALUES(?,?,NULL,?,?,?,?,?)').bind(crypto.randomUUID(),tenantId===PLATFORM_FLOW_SCOPE?null:tenantId,actor.userId,String(actor.displayName||'平台负责人').slice(0,100),action,tenantId,Math.floor(Date.now()/1000));
}
async function offlineConnection(store,target,db) {
  const raw=await db.prepare('SELECT version FROM flow_connections WHERE tenant_id=?').bind(flowConnectionScope(target)).first();
  let saved={data:{}},cache,message;
  try{saved=await store.getConnection(target)||saved;if(raw&&store.getModelCatalogue)cache=await store.getModelCatalogue(target,raw.version);}
  catch{message='Flow 连接资料暂时无法读取。';}
  return {saved,status:{configured:Boolean(raw),connected:false,models:cache?.models||[],...(cache?{fetchedAt:cache.fetchedAt,cacheState:'cached'}:{}),...(message?{message}:{})}};
}

/** Only platform configuration routes; never grants platform access to tenant chats or data tools. */
export async function handlePlatformFlow(request,env,ctx,{identity=getIdentity,store,provider}={}) {
  const url=new URL(request.url);
  if(!/^\/api\/platform\/flow(?:\/(?:connection|models))?$/.test(url.pathname))return null;
  try {
    const actor=await identity(request,env);assertPlatform(actor);
    if(!['GET','POST'].includes(request.method)||request.method==='GET'&&url.pathname!=='/api/platform/flow')fail('接口不存在。',404);
    if(request.method==='POST')origin(request,env);
    const body=request.method==='POST'?await bodyOf(request):{},tenantId=body.tenantId??url.searchParams.get('tenant');
    if(typeof tenantId!=='string'||!tenantId.trim()||tenantId.length>160||tenantId!==tenantId.trim())fail('请选择有效的管理端。');
    const db=dbFor(env),platformScope=tenantId===PLATFORM_FLOW_SCOPE,tenant=platformScope?{id:PLATFORM_FLOW_SCOPE,name:'平台端'}:await db.prepare('SELECT id,name FROM tenants WHERE id=?').bind(tenantId).first();
    if(!tenant)fail('管理端不存在。',404);
    const target=platformScope?actor:{role:'admin',accountRole:'owner',tenantId,userId:actor.userId};
    store||=createFlowStore(env);provider||=createFlowProvider({store});
    let policy=await getFlowPolicy(db,tenantId),multilingualEnabled=platformScope?true:await multilingualPolicy(db,tenantId),matrix=platformScope?null:await getPortalFeatureMatrix(db,tenantId),snapshot,saved;
    const reply=async()=>{
      saved||=await store.getConnection(target);
      if(!snapshot)try{snapshot=await provider.status(target);}catch(error){snapshot={connected:false,message:safeError(error)};}
      const model=policy.model||(safeModel(saved?.data?.model)?saved.data.model:null),connection=publicConnection(snapshot,saved);
      connection.model=model||'';
      // Once platform pins a model, an obsolete legacy preference must not
      // report that the newly assigned, available model is still unavailable.
      if(policy.model&&snapshot.modelUnavailable&&snapshot.models?.some(row=>row.id===model)&&snapshot.message==='原先选择的模型已不可用，请重新选择。')delete connection.message;
      return json({tenantId,name:String(tenant.name||'').slice(0,160),version:policy.version,flow:{enabled:policy.enabled,model},multilingual:{enabled:multilingualEnabled},...(matrix?{portals:{admin:matrix.admin,store:matrix.store}}:{}),connection});
    };
    if(request.method==='GET')return await reply();
    if(url.pathname.endsWith('/connection')) {
      if(Object.keys(body).some(key=>!['tenantId','token'].includes(key)))fail('连接内容格式不正确。');
      snapshot=await provider.loginToken(target,body.token);
      await audit(db,actor,'flow.connection.update',tenantId).run();
      return await reply();
    }
    if(url.pathname.endsWith('/models')) {
      if(Object.keys(body).some(key=>key!=='tenantId'))fail('请求格式不正确。');
      snapshot=await provider.status(target,{refresh:true});return await reply();
    }
    if(Object.keys(body).some(key=>!['tenantId','version','enabled','model','multilingualEnabled','portals'].includes(key))||typeof body.enabled!=='boolean'||!Number.isSafeInteger(body.version)||body.version<0||body.model!=null&&!safeModel(body.model)||Object.hasOwn(body,'multilingualEnabled')&&typeof body.multilingualEnabled!=='boolean')fail('功能配置格式不正确。');
    if(body.version!==policy.version)fail('功能配置已更新，请重新打开后重试。',409);
    if(platformScope&&(body.portals||body.multilingualEnabled===false))fail('平台功能配置格式不正确。');
    const portals=body.portals?checkedPortalFlags(body.portals):matrix?{admin:{...matrix.admin,flowEnabled:body.enabled},store:{...matrix.store}}:null;
    if(portals&&portals.admin.flowEnabled!==body.enabled)fail('功能配置格式不正确。');
    if(portals&&!body.portals&&Object.hasOwn(body,'multilingualEnabled')){portals.admin.multilingualEnabled=body.multilingualEnabled;portals.store.multilingualEnabled=body.multilingualEnabled;}
    const hasLanguage=Object.hasOwn(body,'multilingualEnabled'),languageChanged=hasLanguage&&body.multilingualEnabled!==multilingualEnabled;
    const languageOnly=(hasLanguage||body.portals)&&body.enabled===policy.enabled&&(body.model==null||body.model===policy.model)&&(!portals||portals.store.flowEnabled===matrix.store.flowEnabled);
    const disabling=(policy.enabled||matrix?.store.flowEnabled)&&!body.enabled&&!portals?.store.flowEnabled;
    const changingModel=!disabling&&body.model!=null&&body.model!==policy.model;
    let model=disabling?policy.model:body.model??policy.model,connectionVersion=null;
    if(!languageOnly&&(body.enabled||portals?.store.flowEnabled||changingModel)) {
      saved=await store.getConnection(target);connectionVersion=saved?.version;
      if(!saved?.data?.githubToken)fail('请先连接 GitHub Copilot。',409);
      snapshot=await provider.status(target);
      model||=saved.data.model;
      if(!snapshot.connected)fail(snapshot.message||'GitHub Copilot 当前不可用，请检查连接后重试。',409);
      if(snapshot.stale)fail('模型目录暂未刷新，请刷新成功后再保存。',409);
      if(!safeModel(model)||!snapshot.models?.some(row=>row.id===model))fail('请选择当前可用的模型。');
    }
    const stamp=new Date().toISOString(),connectionGuard=connectionVersion==null?'':' AND EXISTS(SELECT 1 FROM flow_connections WHERE tenant_id=? AND version=?)';
    const params=platformScope?[body.enabled?1:0,model,stamp,policy.version]:policy.version===0?[tenantId,body.enabled?1:0,model,stamp,tenantId]:[body.enabled?1:0,model,stamp,tenantId,policy.version];
    if(connectionVersion!=null)params.push(tenantId,connectionVersion);
    const statement=platformScope?db.prepare('UPDATE platform_features SET flow_enabled=?,flow_model=?,version=version+1,updated_at=? WHERE id=1 AND version=?'+connectionGuard).bind(...params):policy.version===0
      ?db.prepare('INSERT INTO tenant_features(tenant_id,flow_enabled,flow_model,version,updated_at) SELECT ?,?,?,1,? WHERE EXISTS(SELECT 1 FROM tenants WHERE id=?)'+connectionGuard+' ON CONFLICT(tenant_id) DO NOTHING').bind(...params)
      :db.prepare('UPDATE tenant_features SET flow_enabled=?,flow_model=?,version=version+1,updated_at=? WHERE tenant_id=? AND version=?'+connectionGuard).bind(...params);
    // Both feature families and their audits share the same CAS transaction.
    const statements=[statement,db.prepare('INSERT INTO auth_atomic_guard(id,ok) VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok')];
    if(!platformScope&&hasLanguage)statements.push(db.prepare('INSERT INTO tenant_ui_features(tenant_id,multilingual_enabled,updated_at) VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET multilingual_enabled=excluded.multilingual_enabled,updated_at=excluded.updated_at').bind(tenantId,body.multilingualEnabled?1:0,stamp));
    if(portals)statements.push(portalFeatureStatement(db,tenantId,portals,stamp));
    if(body.portals)statements.push(audit(db,actor,'portal.features.update',tenantId));
    if(!languageOnly)statements.push(audit(db,actor,body.enabled?'flow.feature.enable':'flow.feature.disable',tenantId));
    if(languageChanged)statements.push(audit(db,actor,body.multilingualEnabled?'ui.multilingual.enable':'ui.multilingual.disable',tenantId));
    try {await db.batch(statements);}
    catch(error){if(/CHECK constraint|UNIQUE constraint/.test(error?.message||''))fail('功能或模型连接已更新，请重新打开后重试。',409);throw error;}
    policy={enabled:body.enabled,model,version:policy.version+1};
    if(portals)matrix={...matrix,...portals,version:policy.version};
    if(hasLanguage)multilingualEnabled=body.multilingualEnabled;
    if(!snapshot)({saved,status:snapshot}=await offlineConnection(store,target,db));
    return await reply();
  } catch(error) {return json({error:safeError(error)},Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500);}
}
