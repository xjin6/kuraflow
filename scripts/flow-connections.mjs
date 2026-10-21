import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createFlowCopilot} from './flow-copilot.mjs';

// Independent GitHub device OAuth. The application ID is public; tokens remain private.
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
const safeToken = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{16,4096}$/.test(value);
const modelsOnly = rows => [...new Map((Array.isArray(rows) ? rows : []).filter(row => safeModel(row?.id) && row.policy?.state !== 'disabled').slice(0,500).map(row => [row.id, {id:row.id, name:typeof row.name === 'string' ? row.name.slice(0,160) : row.id}])).values()];
const choose = (models, preferred) => models.some(row => row.id === preferred) ? preferred : models[0]?.id || '';

const selection = (models, preferred) => preferred && !models.some(row => row.id === preferred)
  ? {model:preferred,modelUnavailable:true,message:'原先选择的模型已不可用，请重新选择。'}
  : {model:choose(models,preferred),modelUnavailable:false};

function scope(principal, owner = false) {
  if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId || typeof principal.userId !== 'string' || !principal.userId || principal.role !== 'admin') fail('请先登录管理端。',403);
  if (owner && principal.accountRole !== 'owner') fail('请由负责人设置模型连接。',403);
  return hash(principal.tenantId);
}

/** Local-only connection manager. The HTTP host still enforces loopback and CSRF. */
export function createFlowConnections({privateDir, copilotFactory = options => createFlowCopilot(options), fetchImpl = fetch, now = Date.now, githubClientId = GITHUB_CLIENT_ID} = {}) {
  if (!path.isAbsolute(privateDir || '')) throw new TypeError('Flow requires an absolute private directory');
  const directory = path.join(privateDir,'flow-providers');
  const auths = new Map(), clients = new Map(), locks = new Map(), epochs = new Map();
  let disposed = false;
  const currentEpoch = tenant => epochs.get(tenant) || 0;
  const invalidate = tenant => { epochs.set(tenant,currentEpoch(tenant)+1); for(const [id,entry] of auths) if(entry.tenant === tenant) auths.delete(id); };
  const configPath = tenant => path.join(directory,tenant+'.json');
  async function locked(tenant, operation) {
    const previous = locks.get(tenant) || Promise.resolve();
    const next = previous.catch(()=>{}).then(operation);
    locks.set(tenant,next);
    try { return await next; } finally { if(locks.get(tenant) === next) locks.delete(tenant); }
  }
  async function config(tenant) {
    try {
      const raw = await fs.readFile(configPath(tenant),'utf8');
      if (raw.length > 20000) fail('模型连接配置无法读取，请重新设置。',500);
      const value = JSON.parse(raw);
      if(!value || typeof value !== 'object' || Array.isArray(value)) fail('模型连接配置无法读取，请重新设置。',500);
      return value;
    } catch(error) {
      if(error.code === 'ENOENT') return {provider:'copilot',connection:'direct'};
      fail('模型连接配置无法读取，请重新设置。',500);
    }
  }
  async function writeConfig(tenant, value) {
    await fs.mkdir(directory,{recursive:true,mode:0o700}); await fs.chmod(directory,0o700);
    const temporary = path.join(directory,'.'+tenant+'.'+randomUUID()+'.tmp');
    try {
      await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
      await fs.rename(temporary,configPath(tenant));
      await fs.chmod(configPath(tenant),0o600);
    } finally { await fs.rm(temporary,{force:true}); }
  }
  async function requestJSON(url, options = {}) {
    let response, value;
    try {
      response = await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      const raw = await response.text();
      if(raw.length > 1000000) throw new Error('oversized');
      value = JSON.parse(raw);
    } catch { fail('GitHub 暂时无法连接，请稍后重试。',502); }
    return {response,value};
  }
  async function githubForm(route, parameters) {
    return requestJSON('https://github.com'+route,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'KURAFLOW-Flow'},body:new URLSearchParams({client_id:githubClientId,...parameters}).toString()});
  }
  async function directClient(tenant, token) {
    const id = tenant+':'+hash(token);
    if(!clients.has(id)) {
      const client = copilotFactory({privateDir:path.join(privateDir,'flow-runtime-tenants',tenant,hash(token).slice(0,24)),gitHubToken:token,useLoggedInUser:false});
      clients.set(id,{client});
    }
    return clients.get(id);
  }
  async function directStatus(tenant, token, refresh = false) {
    const entry = await directClient(tenant,token);
    if(!refresh && entry.status && now()-entry.at < 30000) return {...entry.status,client:entry.client};
    if(!entry.pending) entry.pending = (async()=>{
      try {
        // A manager cache miss always requests a fresh SDK catalogue too.
        const state = await entry.client.status({refresh:true});
        const models = modelsOnly(state.models);
        entry.status = {connected:Boolean(state.connected && models.length),models,login:typeof state.login === 'string' ? state.login.slice(0,80) : '',modelSource:'github-copilot',
          ...(state.fetchedAt ? {fetchedAt:state.fetchedAt} : models.length ? {fetchedAt:new Date(now()).toISOString()} : {}),
          ...(state.message ? {message:'无法刷新 GitHub Copilot 模型，请稍后重试。'} : {})};
      } catch { entry.status = {connected:false,models:[],modelSource:'github-copilot',message:'无法刷新 GitHub Copilot 模型，请稍后重试。'}; }
      entry.at = now(); return entry.status;
    })().finally(()=>{entry.pending=undefined;});
    return {...await entry.pending,client:entry.client};
  }
  async function selected(principal,{refresh = false} = {}) {
    const tenant = scope(principal), saved = await config(tenant);
    if(saved.provider === 'api') {
      // Preserve older private settings verbatim on disk, but never activate or
      // disclose them after the API-key provider has been removed from Flow.
      return {provider:'copilot',connected:false,model:'',models:[],connection:'direct',connectionLabel:'GitHub Copilot',apiDisabled:true,
        message:'请连接 GitHub Copilot。'};
    }
    if(!safeToken(saved.githubToken)) return {provider:'copilot',connected:false,model:'',models:[],connection:'direct',connectionLabel:'GitHub Copilot'};
    const direct = await directStatus(tenant,saved.githubToken,refresh);
    return {provider:'copilot',...direct,...selection(direct.models,saved.copilotModel || saved.model),connection:'direct',connectionLabel:'GitHub Copilot'};
  }
  async function save(principal, body) {
    const tenant = scope(principal,true);
    if(!body || body.provider !== 'copilot') fail('目前只支持 GitHub Copilot 连接。');
    if(body.connection != null && body.connection !== 'direct') fail('请使用 Flow 自己的 GitHub Copilot 登录。');
    if(['apiKey','baseUrl','wireApi'].some(key=>Object.hasOwn(body,key))) fail('目前只支持 GitHub Copilot 连接。');
    return locked(tenant,async()=>{
      const current = await config(tenant);
      const next = {...current,provider:'copilot',connection:'direct'};
      if(body.model != null) {
        if(!safeModel(body.model)) fail('请选择有效的模型。');
        const choices = safeToken(next.githubToken) ? (await directStatus(tenant,next.githubToken,true)).models : [];
        if(!choices.some(row=>row.id === body.model)) fail('所选模型当前不可用，请重新选择。');
        next.copilotModel=body.model;
      }
      next.model=next.copilotModel || (current.provider === 'copilot' ? current.model : '') || '';
      await writeConfig(tenant,next); invalidate(tenant);
      return {ok:true};
    });
  }
  async function validateToken(tenant, token) {
    const {response,value}=await requestJSON('https://api.github.com/user',{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'User-Agent':'KURAFLOW-Flow'}});
    if(response.status === 401) fail('GitHub Token 无效，请确认已完整复制。',401);
    if(!response.ok || typeof value?.login !== 'string' || !value.login) fail('GitHub 暂时无法验证此 Token，请稍后重试。',502);
    const state=await directStatus(tenant,token,true);
    if(state.message) fail('GitHub Token 已验证，但模型列表暂时无法读取，请稍后重试。',502);
    if(!state.connected) fail('GitHub Token 有效，但没有读到可用的 Copilot 模型，请检查订阅和模型权限。',403);
    return {state,login:value.login.slice(0,80)};
  }
  async function loginToken(principal, candidate) {
    const tenant=scope(principal,true),epoch=currentEpoch(tenant);
    if(disposed) fail('Flow 已停止，请刷新页面。',503);
    if(typeof candidate !== 'string' || candidate.length > 4096 || !safeToken(candidate.trim())) fail('请粘贴完整的 GitHub Token。');
    const token=candidate.trim();
    // A rejected paste must not log out the existing account. GitHub identity
    // and a fresh entitlement/model catalogue are verified before any write.
    const {state,login}=await validateToken(tenant,token);
    return locked(tenant,async()=>{
      if(disposed || currentEpoch(tenant)!==epoch) fail('模型连接已变更，请重新连接。',409);
      const current=await config(tenant);
      const model=choose(state.models,current.copilotModel || (current.provider==='copilot'?current.model:''));
      await writeConfig(tenant,{...current,provider:'copilot',connection:'direct',githubToken:token,githubLogin:login,copilotModel:model,model});
      invalidate(tenant);
      return {connected:true,login,models:state.models,model,fetchedAt:state.fetchedAt,modelSource:'github-copilot'};
    });
  }
  function publicAuth(entry) {
    return {authId:entry.id,verificationUri:entry.uri,userCode:entry.userCode,expiresAt:new Date(entry.expires).toISOString(),pending:!entry.complete && !entry.error,connected:Boolean(entry.complete),...(entry.error?{error:entry.error}:{}),...(entry.login?{login:entry.login}:{}),...(entry.models?{models:entry.models,model:entry.model}:{})};
  }
  function prune() { for(const [id,entry] of auths) if(entry.expires <= now()) auths.delete(id); }
  async function startAuth(principal) {
    const tenant=scope(principal,true); prune();
    return locked(tenant,async()=>{
      if(disposed) fail('Flow 已停止，请刷新页面。',503);
      invalidate(tenant);
      const {response,value}=await githubForm('/login/device/code',{scope:'read:user'});
      let uri;
      try { uri=new URL(value.verification_uri); } catch {}
      if(!response.ok || !safeToken(value.device_code) || typeof value.user_code!=='string' || !/^[A-Za-z0-9-]{4,20}$/.test(value.user_code) || uri?.origin!=='https://github.com' || uri.pathname!=='/login/device') fail('无法开始 GitHub 授权，请稍后重试。',502);
      const interval=Math.min(60,Math.max(5,Number(value.interval)||5))*1000;
      const entry={id:randomUUID(),tenant,userId:principal.userId,epoch:currentEpoch(tenant),deviceCode:value.device_code,userCode:value.user_code,uri:'https://github.com/login/device',expires:now()+Math.min(1800,Math.max(60,Number(value.expires_in)||900))*1000,interval,nextPoll:now()+interval};
      auths.set(entry.id,entry); return publicAuth(entry);
    });
  }
  async function finishAuth(entry, token) {
    let verified;
    try { verified=await validateToken(entry.tenant,token); } catch(error) { entry.error=error.message; return; }
    const {state,login}=verified;
    await locked(entry.tenant,async()=>{
      if(disposed || currentEpoch(entry.tenant)!==entry.epoch || !auths.has(entry.id)) { entry.error='模型连接已变更，请重新连接。'; return; }
      const current=await config(entry.tenant);
      const model=choose(state.models,current.copilotModel || (current.provider==='copilot'?current.model:''));
      await writeConfig(entry.tenant,{...current,provider:'copilot',connection:'direct',githubToken:token,githubLogin:login,copilotModel:model,model});
      entry.complete=true; entry.login=login; entry.models=state.models; entry.model=model; delete entry.deviceCode;
    });
  }
  async function pollAuth(principal,authId) {
    const tenant=scope(principal,true),entry=auths.get(authId);
    if(!entry || entry.tenant!==tenant || entry.userId!==principal.userId || entry.epoch!==currentEpoch(tenant) || entry.expires<=now()) fail('连接已过期，请重新连接。',404);
    if(entry.complete || entry.error || now()<entry.nextPoll) return publicAuth(entry);
    if(!entry.pending) {
      entry.nextPoll=now()+entry.interval;
      entry.pending=(async()=>{
        try {
          const {response,value}=await githubForm('/login/oauth/access_token',{device_code:entry.deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
          if(safeToken(value.access_token) && response.ok) await finishAuth(entry,value.access_token);
          else if(value.error==='slow_down') { entry.interval=Math.min(60000,entry.interval+5000); entry.nextPoll=now()+entry.interval; }
          else if(value.error==='authorization_pending') { /* User has not approved yet. */ }
          else if(value.error==='access_denied') entry.error='GitHub 授权已取消，可以重新连接。';
          else if(value.error==='expired_token') entry.error='授权已过期，请重新连接。';
          else entry.error='GitHub 授权未完成，请重新连接。';
        } catch { entry.error='GitHub 暂时无法连接，请重新授权。'; }
      })().finally(()=>{entry.pending=undefined;});
    }
    await entry.pending;
    if(entry.epoch!==currentEpoch(tenant)) fail('模型连接已变更，请重新连接。',409);
    return publicAuth(entry);
  }
  async function dispose() {
    disposed=true; auths.clear();
    await Promise.allSettled([...clients.values()].map(entry=>entry.client.dispose()));
    clients.clear();
  }
  return {selected,save,loginToken,startAuth,pollAuth,dispose};
}
