import {modelAttachments} from './flow-attachments.js';
import {flowToolFailure} from './flow-schema.js';
import {flowConnectionScope} from './flow-scope.js';
// Worker-native Copilot transport. All credentials belong to the current kitchen
// and stay in the encrypted store; this module never starts a local runtime.
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_API = 'https://api.github.com';
const COPILOT_API = 'https://api.githubcopilot.com';
const MAX_JSON = 1024 * 1024;
const MAX_STREAM = 2 * 1024 * 1024;
const MAX_TEXT = 100000;
const MAX_TOOLS = 12;
const MODEL_CACHE_TTL = 60000;
const PUBLIC_PHASES = new Set(['', 'final', 'response', 'answer', 'final_answer']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
const safeGitHubToken = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{16,4096}$/.test(value);
const safeBearer = value => typeof value === 'string' && /^[\x21-\x7e]{16,16384}$/.test(value);
const publicPhase = value => value == null || PUBLIC_PHASES.has(String(value).toLowerCase());
const problem = (code, message, status = 502) => Object.assign(new Error(message), {code, status});
function scope(principal, owner = false) {flowConnectionScope(principal,owner);}
function abortError() { return problem('FLOW_ABORTED', '已停止回答。', 499); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
async function pause(milliseconds, signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
    signal?.addEventListener('abort', cancelled, {once:true});
  });
}
function budget(parent, milliseconds) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', relay, {once:true});
  const timer = setTimeout(relay, milliseconds);
  return {signal:controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', relay); }};
}
function apiOrigin(value) {
  if (value == null) return COPILOT_API;
  let url;
  try { url = new URL(value); } catch { throw problem('FLOW_UPSTREAM_INVALID', 'GitHub Copilot 返回的服务地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname) || !/^api(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.githubcopilot\.com$/.test(url.hostname)) throw problem('FLOW_UPSTREAM_INVALID', 'GitHub Copilot 返回的服务地址无效。');
  return url.origin;
}
function githubHeaders(token) {
  return {'Accept':'application/json', 'User-Agent':'KuraFlow-Flow/1.0', ...(token ? {Authorization:'Bearer '+token} : {})};
}
function copilotHeaders(token) {
  return {...githubHeaders(), Authorization:'Bearer '+token, 'Editor-Version':'vscode/1.110.1', 'Editor-Plugin-Version':'copilot-chat/0.38.2', 'Copilot-Integration-Id':'vscode-chat', 'X-GitHub-Api-Version':'2025-10-01'};
}
async function readJSON(response, signal, limit = MAX_JSON) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw problem('FLOW_UPSTREAM_INVALID', 'GitHub 返回内容过大或无效。'); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const cancelled = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancelled, {once:true});
  let bytes = 0, raw = '';
  try {
    while (true) {
      checkAbort(signal);
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw problem('FLOW_UPSTREAM_INVALID', 'GitHub 返回内容过大。');
      raw += decoder.decode(value, {stream:true});
    }
    checkAbort(signal);
    raw += decoder.decode();
    try { return JSON.parse(raw); } catch { throw problem('FLOW_UPSTREAM_INVALID', 'GitHub 返回内容无效，请稍后重试。'); }
  } finally { signal?.removeEventListener('abort', cancelled); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function usableModels(value) {
  if (!Array.isArray(value?.data)) throw problem('FLOW_UPSTREAM_INVALID', 'GitHub 模型目录无效，请稍后重试。');
  const models = new Map(), protocols = new Map(), vision = new Map();
  for (const row of value.data.slice(0, 1000)) {
    if (!safeModel(row?.id) || row.policy?.state === 'disabled' || row.model_picker_enabled === false) continue;
    if (row.capabilities?.type && row.capabilities.type !== 'chat') continue;
    if (row.capabilities?.supports?.tool_calls === false || row.capabilities?.supports?.streaming === false) continue;
    const endpoints = row.supported_endpoints;
    const protocol = !Array.isArray(endpoints) || endpoints.includes('/chat/completions') ? 'chat' : endpoints.includes('/responses') ? 'responses' : null;
    if (!protocol) continue;
    models.set(row.id, {id:row.id, name:typeof row.name === 'string' ? row.name.slice(0, 160) : row.id});
    protocols.set(row.id, protocol);
    vision.set(row.id,row.capabilities?.supports?.vision);
  }
  return {models:[...models.values()], protocols,vision};
}
function selected(models, preferred) {
  if (preferred && !models.some(row => row.id === preferred)) return {model:preferred, modelUnavailable:true, message:'原先选择的模型已不可用，请重新选择。'};
  return {model:preferred || models[0]?.id || '', modelUnavailable:false};
}
function authPublic(id, data) {
  return {authId:id, verificationUri:'https://github.com/login/device', userCode:data.userCode, expiresAt:new Date(data.expiresAt).toISOString(), pending:!data.complete && !data.error, connected:Boolean(data.complete), ...(data.error ? {error:data.error} : {}), ...(data.login ? {login:data.login} : {}), ...(data.models ? {models:data.models, model:data.model} : {})};
}
export function safeFlowProviderError(error) {
  const messages = {
    FLOW_AUTH_REQUIRED:'请先连接 GitHub Copilot，再向 Flow 提问。',
    FLOW_ABORTED:'已停止回答。', FLOW_TIMEOUT:'回答超时，请稍后重试。',
    FLOW_MODEL_UNAVAILABLE:'所选模型当前不可用，请刷新模型列表后重新选择。',
    FLOW_TOOL_LIMIT:'本次查询已达到工具调用上限，请缩小查询范围。',
    FLOW_INVALID_INPUT:'问题或会话内容过长，请缩短后重试。',
    FLOW_BUSY:'Flow 正在处理另一条请求，请稍后再试。',
    FLOW_RATE_LIMIT:'GitHub Copilot 当前额度或请求频率已达上限，请稍后重试。',
    FLOW_FORBIDDEN:'当前账号不能执行此操作。',
  };
  return messages[error?.code] || 'Flow 暂时无法完成请求，请稍后重试或检查 Copilot 连接。';
}

/** Create per request: no tokens, clients, model caches or I/O at module scope. */
export function createFlowProvider({store, fetchImpl = fetch, now = Date.now, retryDelayMs = 180} = {}) {
  if (!store) throw new TypeError('Flow store required');
  async function requestJSON(url, options = {}, parent, retryTransient = false) {
    const clock = budget(parent, 20000);
    try {
      for (let attempt = 0; ; attempt++) {
        checkAbort(clock.signal);
        let response;
        try { response = await fetchImpl(url, {...options, redirect:'manual', signal:clock.signal}); }
        catch (error) {
          if (!retryTransient || attempt || clock.signal.aborted) throw error;
          await pause(retryDelayMs, clock.signal); continue;
        }
        if(response.status>=300&&response.status<400){await response.body?.cancel();throw problem('FLOW_UPSTREAM_INVALID','GitHub 返回了不允许的重定向。');}
        // Retry only safe catalogue/validation reads. Denial and rate limits
        // must retain their meaning even when their response body is not JSON.
        if (retryTransient && [401,403,429].includes(response.status)) { await response.body?.cancel(); return {response,value:null}; }
        if (retryTransient && !attempt && [502,503].includes(response.status)) {
          await response.body?.cancel(); await pause(retryDelayMs, clock.signal); continue;
        }
        if (retryTransient && !response.ok) { await response.body?.cancel(); return {response,value:null}; }
        const value = await readJSON(response, clock.signal);
        return {response, value};
      }
    } catch (error) {
      if (parent?.aborted) throw abortError();
      if (clock.signal.aborted) throw problem('FLOW_TIMEOUT', 'GitHub 请求超时，请稍后重试。', 504);
      if (error?.code?.startsWith('FLOW_')) throw error;
      // Never log arbitrary fetch errors: providers may include a request URL,
      // headers or credential fragments in their native diagnostic text.
      console.error(JSON.stringify({event:'flow_upstream_failed',host:new URL(url).hostname,path:new URL(url).pathname,kind:'network'}));
      throw problem('FLOW_UPSTREAM_FAILED', 'GitHub 暂时无法连接，请稍后重试。');
    } finally { clock.close(); }
  }
  async function exchange(token, signal) {
    const {response, value} = await requestJSON(GITHUB_API+'/copilot_internal/v2/token', {headers:{...githubHeaders(token), 'Editor-Version':'vscode/1.110.1', 'Editor-Plugin-Version':'copilot-chat/0.38.2'}}, signal, true);
    if ([401,403].includes(response.status)) throw problem('FLOW_AUTH_REQUIRED', 'GitHub Token 无法使用 Copilot，请检查 Token、订阅和模型权限。', 403);
    if (response.status === 429) throw problem('FLOW_RATE_LIMIT', 'GitHub Copilot 请求频率已达上限，请稍后重试。', 429);
    if (!response.ok || !safeBearer(value?.token)) throw problem('FLOW_UPSTREAM_FAILED', 'GitHub Copilot 暂时无法验证，请稍后重试。');
    return {token:value.token, origin:apiOrigin(value?.endpoints?.api)};
  }
  async function catalogue(access, signal) {
    const {response, value} = await requestJSON(access.origin+'/models', {headers:{...copilotHeaders(access.token), 'Cache-Control':'no-cache'}}, signal, true);
    if ([401,403].includes(response.status)) throw problem('FLOW_AUTH_REQUIRED', 'GitHub Copilot 连接已失效，请重新连接。', 401);
    if (response.status === 429) throw problem('FLOW_RATE_LIMIT', 'GitHub Copilot 请求频率已达上限，请稍后重试。', 429);
    if (!response.ok) throw problem('FLOW_UPSTREAM_FAILED', '无法刷新 GitHub Copilot 模型，请稍后重试。');
    return {...usableModels(value), fetchedAt:new Date(now()).toISOString()};
  }
  async function verify(token, signal) {
    const {response, value} = await requestJSON(GITHUB_API+'/user', {headers:githubHeaders(token)}, signal, true);
    if ([401,403].includes(response.status)) throw problem('FLOW_AUTH_REQUIRED', 'GitHub Token 无效或未授权，请确认后重试。', response.status);
    if (response.status === 429) throw problem('FLOW_RATE_LIMIT', 'GitHub 请求频率已达上限，请稍后重试。', 429);
    if (!response.ok || typeof value?.login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(value.login)) throw problem('FLOW_UPSTREAM_FAILED', 'GitHub 暂时无法验证此 Token，请稍后重试。');
    const access = await exchange(token, signal), snapshot = await catalogue(access, signal);
    if (!snapshot.models.length) throw problem('FLOW_MODEL_UNAVAILABLE', '没有读到可用的 Copilot 对话模型，请检查订阅和模型权限。', 403);
    return {models:snapshot.models, fetchedAt:snapshot.fetchedAt, login:value.login};
  }
  async function remember(principal, connectionVersion, snapshot) {
    return store.saveModelCatalogue(principal, connectionVersion, {models:snapshot.models, fetchedAt:Date.parse(snapshot.fetchedAt)});
  }
  async function status(principal, {refresh = false} = {}) {
    scope(principal);
    const current = await store.getConnection(principal), data = current?.data;
    const base = {provider:'copilot', connection:'direct', connectionLabel:'GitHub Copilot', available:true, mode:'read-write', configured:false, connected:false, models:[], model:'', modelSource:'github-copilot', cacheState:'stale', stale:false};
    if (!safeGitHubToken(data?.githubToken)) return base;
    const connectedBase = {...base, configured:true, login:String(data.login || '').slice(0,80), model:data.model || ''};
    const cached = await store.getModelCatalogue(principal, current.version);
    const fromSnapshot = (snapshot, cacheState) => ({...connectedBase, connected:true, models:snapshot.models, fetchedAt:typeof snapshot.fetchedAt === 'number' ? new Date(snapshot.fetchedAt).toISOString() : snapshot.fetchedAt, cacheState, stale:cacheState === 'stale', ...selected(snapshot.models, data.model)});
    if (!refresh && cached && now() >= cached.fetchedAt && now() - cached.fetchedAt < MODEL_CACHE_TTL) return fromSnapshot(cached, 'cached');
    const clock = budget(undefined, 12000);
    try {
      const access = await exchange(data.githubToken, clock.signal), snapshot = await catalogue(access, clock.signal);
      const saved = await remember(principal, current.version, snapshot);
      if (!saved && (await store.getConnection(principal))?.version !== current.version) throw problem('FLOW_CONFLICT', '模型连接已更新，请重新读取。', 409);
      return fromSnapshot(snapshot, 'fresh');
    } catch (error) {
      if (error?.code === 'FLOW_CONFLICT') return {...connectedBase, message:'模型连接已更新，请重新读取。', refreshError:'模型连接已更新，请重新读取。', retryable:true};
      if (error?.code === 'FLOW_AUTH_REQUIRED') {
        // A known invalid token may never be made to look usable by a previous
        // successful catalogue, including on the next normal status request.
        await store.deleteModelCatalogue(principal, current.version);
        return {...connectedBase, available:false, modelUnavailable:true, message:'GitHub Copilot 连接已失效，请重新连接。', refreshError:'GitHub Copilot 连接已失效，请重新连接。', retryable:false};
      }
      const message = error?.code === 'FLOW_RATE_LIMIT' ? 'GitHub 请求频率已达上限，请稍后刷新。' : '暂时无法刷新模型，请稍后重试。';
      // Recheck after I/O: never attach a stale list to a replacement token.
      const temporary = ['FLOW_RATE_LIMIT','FLOW_UPSTREAM_FAILED','FLOW_TIMEOUT','FLOW_ABORTED'].includes(error?.code);
      const latestCache = cached && temporary ? await store.getModelCatalogue(principal, current.version) : null;
      return {...(latestCache ? fromSnapshot(latestCache, 'stale') : connectedBase), cacheState:'stale', stale:true, refreshError:message, message:latestCache ? message+' 当前显示上次读取的列表。' : message, retryable:true, retryAfterSeconds:error?.code === 'FLOW_RATE_LIMIT' ? 60 : 5};
    } finally { clock.close(); }
  }
  async function loginToken(principal, candidate) {
    scope(principal, true);
    if (typeof candidate !== 'string' || candidate.length > 4096 || !safeGitHubToken(candidate.trim())) throw problem('FLOW_INVALID_INPUT', '请粘贴完整的 GitHub Token。', 400);
    const current = await store.getConnection(principal), token = candidate.trim();
    const state = await verify(token);
    const model = current?.data.model || state.models[0].id;
    const saved = await store.saveConnection(principal, {provider:'copilot', connection:'direct', githubToken:token, login:state.login, model}, current?.version ?? null);
    await remember(principal, saved.version, state);
    return {configured:true, connected:true, ...state, ...selected(state.models, model), modelSource:'github-copilot', cacheState:'fresh', stale:false};
  }
  async function save(principal, body) {
    scope(principal, true);
    if (!body || body.provider !== 'copilot' || Object.keys(body).some(key => !['provider','connection','model'].includes(key))) throw problem('FLOW_INVALID_INPUT', '目前只支持 GitHub Copilot 连接。', 400);
    if (body.connection != null && body.connection !== 'direct') throw problem('FLOW_INVALID_INPUT', '请使用 Flow 自己的 GitHub Copilot 登录。', 400);
    const current = await store.getConnection(principal), next = {...current?.data, provider:'copilot', connection:'direct'};
    if (body.model != null) {
      if (!safeModel(body.model)) throw problem('FLOW_INVALID_INPUT', '请选择有效的模型。', 400);
      if (!safeGitHubToken(next.githubToken)) throw problem('FLOW_AUTH_REQUIRED', '请先连接 GitHub Copilot。', 401);
      const {models} = await catalogue(await exchange(next.githubToken));
      if (!models.some(row => row.id === body.model)) throw problem('FLOW_MODEL_UNAVAILABLE', '所选模型当前不可用，请重新选择。', 400);
      next.model = body.model;
    }
    await store.saveConnection(principal, next, current?.version ?? null);
    return {ok:true};
  }
  async function githubForm(path, values) {
    return requestJSON('https://github.com'+path, {method:'POST', headers:{...githubHeaders(), 'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:GITHUB_CLIENT_ID, ...values}).toString()});
  }
  async function startAuth(principal) {
    scope(principal, true);
    const current = await store.getConnection(principal);
    const {response, value} = await githubForm('/login/device/code', {scope:'read:user'});
    let uri;
    try { uri = new URL(value?.verification_uri); } catch {}
    if (!response.ok || !safeGitHubToken(value?.device_code) || !/^[a-zA-Z0-9-]{4,20}$/.test(value?.user_code || '') || uri?.href !== 'https://github.com/login/device' || !Number.isFinite(Number(value?.expires_in)) || Number(value.expires_in) < 1) throw problem('FLOW_AUTH_FAILED', '无法开始 GitHub 授权，请稍后重试。');
    const id = crypto.randomUUID(), interval = Math.min(60, Math.max(5, Number(value.interval) || 5)) * 1000;
    const data = {deviceCode:value.device_code, userCode:value.user_code, uri:uri.href, interval, nextPoll:now()+interval, expiresAt:now()+Math.min(1800, Number(value.expires_in))*1000, connectionVersion:current?.version ?? null};
    await store.saveAuth(principal, id, data, data.expiresAt, null);
    return authPublic(id, data);
  }
  async function pollAuth(principal, id) {
    scope(principal, true);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw problem('FLOW_AUTH_EXPIRED', '连接已过期，请重新连接。', 404);
    let entry = await store.getAuth(principal, id), data = entry.data;
    if (data.expiresAt <= now()) throw problem('FLOW_AUTH_EXPIRED', '连接已过期，请重新连接。', 404);
    if (data.complete || data.error || now() < data.nextPoll) return authPublic(id, data);
    const lockScope = JSON.stringify(['flow-auth',principal.tenantId,principal.userId,id]), lockOwner = crypto.randomUUID();
    if (!await store.acquireLease(lockScope, lockOwner, 120000)) return authPublic(id, data);
    try {
      entry = await store.getAuth(principal, id); data = entry.data;
      if (data.expiresAt <= now()) throw problem('FLOW_AUTH_EXPIRED', '连接已过期，请重新连接。', 404);
      if (data.complete || data.error || now() < data.nextPoll) return authPublic(id, data);
      const current = await store.getConnection(principal);
      if ((current?.version ?? null) !== data.connectionVersion) throw problem('FLOW_CONFLICT', '模型连接已变更，请重新连接。', 409);
      data = {...data, nextPoll:now()+data.interval};
      entry = await store.saveAuth(principal, id, data, data.expiresAt, entry.version);
      try {
        const {response, value} = await githubForm('/login/oauth/access_token', {device_code:data.deviceCode, grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
        if (response.ok && safeGitHubToken(value?.access_token)) {
          const state = await verify(value.access_token);
          if (data.expiresAt <= now()) throw problem('FLOW_AUTH_EXPIRED', '授权已过期，请重新连接。', 404);
          const model = current?.data.model || state.models[0].id;
          const saved = await store.saveConnection(principal, {provider:'copilot', connection:'direct', githubToken:value.access_token, login:state.login, model}, data.connectionVersion);
          await remember(principal, saved.version, state);
          // Keep the catalogue in its version-bound cache, not OAuth records.
          data = {...data, complete:true, login:state.login, model};
          delete data.deviceCode;
        } else if (value?.error === 'slow_down') {
          data = {...data, interval:Math.min(60000,data.interval+5000)};
          data.nextPoll = now()+data.interval;
        } else if (value?.error !== 'authorization_pending') {
          data.error = value?.error === 'access_denied' ? 'GitHub 授权已取消，可以重新连接。' : value?.error === 'expired_token' ? '授权已过期，请重新连接。' : 'GitHub 授权未完成，请重新连接。';
          delete data.deviceCode;
        }
      } catch (error) {
        if (error?.status === 409) throw problem('FLOW_CONFLICT', '模型连接已变更，请重新连接。', 409);
        data.error = error?.code === 'FLOW_MODEL_UNAVAILABLE' ? '没有读到可用的 Copilot 对话模型，请检查订阅和模型权限。' : 'GitHub 授权未完成，请重新连接。';
        delete data.deviceCode;
      }
      await store.saveAuth(principal, id, data, data.expiresAt, entry.version);
      return authPublic(id, data);
    } finally { await store.releaseLease(lockScope, lockOwner); }
  }

  async function chat({principal, message, history = [], attachments, model, systemPrompt = '', toolDefinitions = [], runTool, onEvent = () => {}, signal}) {
    scope(principal);
    const attached=modelAttachments(attachments);
    if (typeof message !== 'string' || !message.trim() || message.length > 6000 || !Array.isArray(history) || history.length > 12 || JSON.stringify(history).length > 24000 || typeof systemPrompt !== 'string' || systemPrompt.length > 30000) throw problem('FLOW_INVALID_INPUT', '问题或会话内容过长，请缩短后重试。', 400);
    if (!Array.isArray(toolDefinitions) || toolDefinitions.length > 24 || typeof runTool !== 'function') throw problem('FLOW_INVALID_INPUT', 'Flow 查询工具配置无效。', 400);
    const tools = toolDefinitions.map(tool => {
      if (!tool || !/^flow_[a-z0-9_]{1,55}$/.test(tool.name) || !tool.parameters || tool.parameters.type !== 'object') throw problem('FLOW_INVALID_INPUT', 'Flow 查询工具配置无效。', 400);
      return {type:'function', function:{name:tool.name, description:String(tool.description || '').slice(0,4000), parameters:tool.parameters}};
    });
    const names = new Set(tools.map(tool => tool.function.name));
    if (names.size !== tools.length) throw problem('FLOW_INVALID_INPUT', 'Flow 查询工具配置无效。', 400);
    const clock = budget(signal, 180000);
    let connectionVersion;
    try {
      checkAbort(clock.signal);
      const current = await store.getConnection(principal);
      if (!safeGitHubToken(current?.data.githubToken)) throw problem('FLOW_AUTH_REQUIRED', '请先连接 GitHub Copilot。', 401);
      connectionVersion = current.version;
      let access = await exchange(current.data.githubToken, clock.signal);
      const snapshot = await catalogue(access, clock.signal), {models, protocols} = snapshot, wanted = model || current.data.model || models[0]?.id;
      const saved = await remember(principal, current.version, snapshot);
      if (!saved && (await store.getConnection(principal))?.version !== current.version) throw problem('FLOW_CONFLICT', '模型连接已更新，请重新提问。', 409);
      if (!models.some(row => row.id === wanted)) throw problem('FLOW_MODEL_UNAVAILABLE', '所选模型当前不可用，请刷新模型列表后重新选择。', 400);
      if(attached.images.length&&snapshot.vision.get(wanted)===false)throw problem('FLOW_VISION_UNAVAILABLE','当前模型不支持读图，请联系平台更换支持图片的模型，或上传文字版 PDF／表格。',400);
      const protocol = protocols.get(wanted);
      const userText=message.trim()+(attached.text?'\n\n'+attached.text:'');
      const content=attached.images.length ? [{type:protocol==='responses'?'input_text':'text',text:userText},...attached.images.map(image=>protocol==='responses'?{type:'input_image',image_url:'data:image/jpeg;base64,'+image.data,detail:'high'}:{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+image.data,detail:'high'}})] : userText;
      const messages = [{role:'system',content:systemPrompt}, ...history.filter(item => ['user','assistant'].includes(item?.role) && typeof item.content === 'string').map(item => ({role:item.role,content:item.content.slice(0,6000)})), {role:'user',content}];
      const input = messages.slice(1);
      let calls = 0;
      for (let iteration = 0; iteration < 8; iteration++) {
        checkAbort(clock.signal);
        if (JSON.stringify(protocol === 'responses' ? input : messages).length > 3200000) throw problem('FLOW_INVALID_INPUT', '本次查询结果过大，请缩小范围。', 400);
        const body = protocol === 'responses'
          ? {model:wanted, instructions:systemPrompt, input, stream:true, store:false, include:['reasoning.encrypted_content'], ...(tools.length ? {tools:tools.map(tool => ({type:'function',...tool.function,strict:false})),tool_choice:'auto'} : {})}
          : {model:wanted, messages, stream:true, ...(tools.length ? {tools,tool_choice:'auto'} : {})};
        let result;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { result = await completion(access, body, clock.signal, onEvent, protocol); break; }
          catch (error) {
            if (error.code !== 'FLOW_UPSTREAM_UNAUTHORIZED' || attempt) throw error;
            access = await exchange(current.data.githubToken, clock.signal);
          }
        }
        if (!result.tools.length) {
          if (!result.text.trim()) throw problem('FLOW_EMPTY_ANSWER', '模型没有返回回答，请重试。');
          await onEvent({type:'message',text:result.text});
          return {text:result.text, model:wanted, toolCalls:calls};
        }
        if (calls + result.tools.length > MAX_TOOLS) throw problem('FLOW_TOOL_LIMIT', '本次查询已达到工具调用上限，请缩小查询范围。', 400);
        // Stateless Responses continuation keeps encrypted reasoning and exact
        // upstream call IDs only here, never in UI events or conversation storage.
        if (protocol === 'responses') input.push(...result.output);
        else messages.push({role:'assistant',content:result.text || null,tool_calls:result.tools});
        for (const call of result.tools) {
          checkAbort(clock.signal);
          if (!names.has(call.function.name)) throw problem('FLOW_TOOL_DENIED', '模型请求了未开放的操作。', 400);
          calls++;
          let args, output;
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw problem('FLOW_TOOL_INVALID', '模型查询参数无效，请重试。', 400); }
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw problem('FLOW_TOOL_INVALID', '模型查询参数无效，请重试。', 400);
          try { output = JSON.stringify(await runTool(call.function.name, args)); }
          catch (error) {
            checkAbort(clock.signal);
            if ([401,403].includes(error?.status)) throw problem('FLOW_FORBIDDEN', '登录状态已变更，请重新登录。', 403);
            output = JSON.stringify(flowToolFailure(error));
          }
          checkAbort(clock.signal);
          if (typeof output !== 'string' || output.length > 240000) throw problem('FLOW_INVALID_INPUT', '本次查询结果过大，请缩小范围。', 400);
          if (protocol === 'responses') input.push({type:'function_call_output',call_id:call.id,output});
          else messages.push({role:'tool',tool_call_id:call.id,content:output});
        }
      }
      throw problem('FLOW_TOOL_LIMIT', '本次查询已达到工具调用上限，请缩小查询范围。', 400);
    } catch (error) {
      if (connectionVersion && ['FLOW_AUTH_REQUIRED','FLOW_UPSTREAM_UNAUTHORIZED'].includes(error?.code)) await store.deleteModelCatalogue(principal, connectionVersion);
      if (signal?.aborted) throw abortError();
      if (clock.signal.aborted) throw problem('FLOW_TIMEOUT', '回答超时，请稍后重试。', 504);
      if (error?.code?.startsWith('FLOW_') || error?.status === 409) throw error;
      throw problem('FLOW_UPSTREAM_FAILED', 'Flow 暂时无法完成请求，请稍后重试。');
    } finally { clock.close(); }
  }
  async function completion(access, body, parent, onEvent, protocol) {
    const clock = budget(parent, 90000);
    let response;
    try {
      response = await fetchImpl(access.origin+(protocol === 'responses' ? '/responses' : '/chat/completions'), {method:'POST', redirect:'manual', headers:{...copilotHeaders(access.token), 'Content-Type':'application/json', Accept:'text/event-stream', 'X-Request-Id':crypto.randomUUID()}, body:JSON.stringify(body), signal:clock.signal});
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw problem('FLOW_UPSTREAM_UNAUTHORIZED', 'GitHub Copilot 连接已失效，请重新连接。', 401);
        if (response.status === 429 || response.status === 402) throw problem('FLOW_RATE_LIMIT', 'GitHub Copilot 当前额度或请求频率已达上限，请稍后重试。', 429);
        if (response.status === 403) throw problem('FLOW_MODEL_UNAVAILABLE', '所选模型没有调用权限，请重新选择。', 403);
        if([400,415,422].includes(response.status)&&(body.input||body.messages||[]).some(row=>Array.isArray(row.content)&&row.content.some(part=>['input_image','image_url'].includes(part.type))))throw problem('FLOW_VISION_UNAVAILABLE','当前模型无法读取这些图片，请联系平台检查模型，或上传文字版 PDF／表格。',400);
        throw problem('FLOW_UPSTREAM_FAILED', 'GitHub Copilot 暂时无法回答，请稍后重试。');
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        const value = await readJSON(response, clock.signal);
        if (protocol === 'responses') {
          const result = responseResult(value);
          if (result.text) await onEvent({type:'delta',text:result.text});
          return result;
        }
        const choice = value?.choices?.[0], message = choice?.message;
        if (!message || !['stop','tool_calls'].includes(choice.finish_reason)) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。');
        const text = publicPhase(message.phase) && typeof message.content === 'string' ? message.content : '';
        if (text.length > MAX_TEXT) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
        const calls = validateCalls(message.tool_calls || []);
        if (text) await onEvent({type:'delta',text});
        return {text,tools:calls};
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw problem('FLOW_UPSTREAM_INVALID', '模型返回格式无效，请稍后重试。');
      return await (protocol === 'responses' ? readResponsesStream(response, clock.signal, onEvent) : readCompletionStream(response, clock.signal, onEvent));
    } catch (error) {
      if (parent?.aborted) throw abortError();
      if (clock.signal.aborted) throw problem('FLOW_TIMEOUT', '回答超时，请稍后重试。', 504);
      if (error?.code?.startsWith('FLOW_')) throw error;
      throw problem('FLOW_UPSTREAM_FAILED', 'GitHub Copilot 暂时无法回答，请稍后重试。');
    } finally { clock.close(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  return {status, loginToken, startAuth, pollAuth, save, chat};
}
function validateCalls(calls, responseIds = false) {
  if (!Array.isArray(calls) || calls.length > MAX_TOOLS) throw problem('FLOW_TOOL_LIMIT', '本次查询已达到工具调用上限。', 400);
  const ids = new Set();
  return calls.map(call => {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !(responseIds ? /^[\x21-\x7e]{1,8192}$/ : /^[a-zA-Z0-9_-]{1,200}$/).test(call.id) || ids.has(call.id) || !/^flow_[a-z0-9_]{1,55}$/.test(call.function?.name || '') || typeof call.function?.arguments !== 'string' || call.function.arguments.length > 64000) throw problem('FLOW_TOOL_INVALID', '模型查询参数无效，请重试。', 400);
    ids.add(call.id);
    return {id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments}};
  });
}
async function readCompletionStream(response, signal, onEvent) {
  if (!response.body) throw problem('FLOW_UPSTREAM_INVALID', '模型未返回回答。');
  const reader = response.body.getReader(), decoder = new TextDecoder(), calls = new Map();
  const cancelled = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelled, {once:true});
  let bytes = 0, buffer = '', text = '', finish = '', phase, doneMarker = false;
  async function event(block) {
    const raw = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!raw) return;
    if (raw.trim() === '[DONE]') { doneMarker = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { throw problem('FLOW_UPSTREAM_INVALID', '模型回答传输中断，请重试。'); }
    if (data.error) throw problem('FLOW_UPSTREAM_FAILED', '模型回答未能完成，请重试。');
    const choice = data.choices?.find(row => row.index == null || row.index === 0);
    if (!choice) return;
    const delta = choice.delta || {};
    if (own(delta,'phase') || own(data,'phase')) phase = delta.phase ?? data.phase;
    if (publicPhase(phase) && typeof delta.content === 'string') {
      text += delta.content;
      if (text.length > MAX_TEXT) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
      await onEvent({type:'delta',text:delta.content});
    }
    // reasoning_content, reasoning, analysis, thought signatures and all other
    // non-public fields are deliberately never forwarded or persisted.
    if (Array.isArray(delta.tool_calls)) for (const fragment of delta.tool_calls) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= MAX_TOOLS) throw problem('FLOW_TOOL_INVALID', '模型查询参数无效，请重试。', 400);
      const call = calls.get(fragment.index) || {id:'',type:'function',function:{name:'',arguments:''}};
      if (fragment.id != null) call.id += String(fragment.id);
      if (fragment.type != null && fragment.type !== 'function') throw problem('FLOW_TOOL_INVALID', '模型请求了未开放的操作。', 400);
      if (fragment.function?.name != null) call.function.name += String(fragment.function.name);
      if (fragment.function?.arguments != null) call.function.arguments += String(fragment.function.arguments);
      if (call.id.length > 200 || call.function.name.length > 60 || call.function.arguments.length > 64000) throw problem('FLOW_TOOL_INVALID', '模型查询参数过长，请缩小问题范围。', 400);
      calls.set(fragment.index,call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  try {
    while (!doneMarker) {
      checkAbort(signal);
      const {done,value} = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_STREAM) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
      buffer += decoder.decode(value,{stream:true});
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0,boundary.index);
        buffer = buffer.slice(boundary.index+boundary[0].length);
        await event(block);
        if (doneMarker) break;
      }
      if (buffer.length > 256000) throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容过大。');
    }
    if (buffer.trim() && !doneMarker) await event(buffer);
    checkAbort(signal);
    if (!['stop','tool_calls'].includes(finish)) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。');
    const result = validateCalls([...calls.entries()].sort(([a],[b]) => a-b).map(([,call]) => call));
    if (finish === 'tool_calls' && !result.length) throw problem('FLOW_TOOL_INVALID', '模型查询未完整生成，请重试。', 400);
    return {text,tools:result};
  } finally { signal.removeEventListener('abort', cancelled); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const safeOpaqueId = value => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
function responseResult(response, fallback = []) {
  if (!response || response.status !== 'completed' || response.error || response.incomplete_details) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。');
  const items = Array.isArray(response.output) ? response.output : fallback;
  if (!Array.isArray(items) || items.length > 60 || JSON.stringify(items).length > 700000) throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容过大或无效。');
  const output = [], calls = [], texts = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容无效。');
    if (item.type === 'reasoning') {
      // Encrypted reasoning is an opaque continuation token. Human-readable
      // reasoning summaries are neither sent to the UI nor retained in memory.
      if (item.encrypted_content != null) {
        if (!safeOpaqueId(item.id) || typeof item.encrypted_content !== 'string' || item.encrypted_content.length > 500000 || /[\u0000-\u001f]/.test(item.encrypted_content)) throw problem('FLOW_UPSTREAM_INVALID', '模型继续回答所需内容无效。');
        output.push({type:'reasoning',id:item.id,summary:[],encrypted_content:item.encrypted_content});
      }
      continue;
    }
    if (item.type === 'function_call') {
      if (item.status != null && item.status !== 'completed') throw problem('FLOW_TOOL_INVALID', '模型查询未完整生成，请重试。', 400);
      if (item.id != null && !safeOpaqueId(item.id)) throw problem('FLOW_TOOL_INVALID', '模型查询标识无效，请重试。', 400);
      const call = validateCalls([{type:'function',id:item.call_id,function:{name:item.name,arguments:item.arguments}}], true)[0];
      calls.push(call);
      output.push({type:'function_call',...(item.id ? {id:item.id} : {}),call_id:call.id,name:call.function.name,arguments:call.function.arguments});
      continue;
    }
    if (item.type === 'message') {
      if (item.role !== 'assistant' || item.status != null && item.status !== 'completed' || !Array.isArray(item.content)) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。');
      // Analysis-phase messages must not appear in a public reply or archive.
      if (!publicPhase(item.phase)) continue;
      const content = [];
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') content.push({type:'output_text',text:part.text,annotations:[]});
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') content.push({type:'refusal',refusal:part.refusal});
        else throw problem('FLOW_UPSTREAM_INVALID', '模型返回了不支持的内容，请重试。');
      }
      const text = content.map(part => part.text ?? part.refusal).join('');
      if (text.length > MAX_TEXT) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
      texts.push(text);
      if (item.id != null && !safeOpaqueId(item.id)) throw problem('FLOW_UPSTREAM_INVALID', '模型回答标识无效，请重试。');
      output.push({type:'message',role:'assistant',...(item.id ? {id:item.id} : {}),...(item.phase != null ? {phase:item.phase} : {}),content});
      continue;
    }
    // There are no built-in web/file/computer tools in the application allowlist.
    throw problem('FLOW_TOOL_DENIED', '模型请求了未开放的操作。', 400);
  }
  const text = texts.filter(Boolean).join('\n\n');
  if (text.length > MAX_TEXT) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
  return {text,tools:validateCalls(calls, true),output};
}
async function readResponsesStream(response, signal, onEvent) {
  if (!response.body) throw problem('FLOW_UPSTREAM_INVALID', '模型未返回回答。');
  const reader = response.body.getReader(), decoder = new TextDecoder(), states = new Map(), doneItems = new Map();
  const cancelled = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort',cancelled,{once:true});
  let bytes = 0, buffer = '', completed = null, visibleSize = 0;
  function indexOf(event) {
    if (!Number.isInteger(event.output_index) || event.output_index < 0 || event.output_index >= 60) throw problem('FLOW_UPSTREAM_INVALID', '模型回答标识无效，请重试。');
    return event.output_index;
  }
  async function event(block) {
    const lines = block.split(/\r?\n/), raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!raw) return;
    if (raw.trim() === '[DONE]') { if (!completed) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。'); return; }
    let data;
    try { data = JSON.parse(raw); } catch { throw problem('FLOW_UPSTREAM_INVALID', '模型回答传输中断，请重试。'); }
    const type = data.type || lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || data.error || data.response?.error) throw problem('FLOW_UPSTREAM_FAILED', '模型回答未能完成，请重试。');
    if (type === 'response.output_item.added') {
      const index = indexOf(data), item = data.item;
      if (!item || typeof item !== 'object') throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容无效。');
      states.set(index,{type:item.type,role:item.role,phase:item.phase});
      return;
    }
    if (type === 'response.output_text.delta') {
      const state = states.get(indexOf(data));
      // An unassociated delta waits for the authoritative completed output;
      // don't guess whether its missing item belongs to an analysis phase.
      if (state?.type === 'message' && state.role === 'assistant' && publicPhase(state.phase) && publicPhase(data.phase) && typeof data.delta === 'string') {
        visibleSize += data.delta.length;
        if (visibleSize > MAX_TEXT) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
        await onEvent({type:'delta',text:data.delta});
      }
      return;
    }
    if (type === 'response.output_item.done') {
      const index = indexOf(data);
      if (!data.item || typeof data.item !== 'object') throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容无效。');
      doneItems.set(index,data.item);
      return;
    }
    if (type === 'response.completed') {
      completed = responseResult(data.response,[...doneItems.entries()].sort(([a],[b])=>a-b).map(([,item])=>item));
    }
    // Reasoning/summary/signature deltas and function arguments are not emitted.
    // Only completed function calls can reach the controlled tool executor.
  }
  try {
    while (!completed) {
      checkAbort(signal);
      const {done,value} = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_STREAM) throw problem('FLOW_UPSTREAM_INVALID', '模型回答过长，请缩小问题范围。');
      buffer += decoder.decode(value,{stream:true});
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0,boundary.index);
        buffer = buffer.slice(boundary.index+boundary[0].length);
        await event(block);
        if (completed) break;
      }
      if (buffer.length > 800000) throw problem('FLOW_UPSTREAM_INVALID', '模型返回内容过大。');
    }
    if (buffer.trim() && !completed) await event(buffer);
    checkAbort(signal);
    if (!completed) throw problem('FLOW_UPSTREAM_INVALID', '模型回答未完整生成，请重试。');
    return completed;
  } finally { signal.removeEventListener('abort',cancelled); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
