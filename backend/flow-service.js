import {getIdentity} from './accounts.js';
import {createFlowDataContext, flowToolDefinitions, runFlowTool} from './flow-tools.js';
import {buildFlowSystemPrompt} from './flow-prompt.js';
import {createFlowStore} from './flow-store.js';
import {createFlowProvider} from './flow-provider.js';
import {flowVisualTool} from './flow-content.js';
import {getFlowPolicy} from './flow-control.js';

const CHAT_BUDGET_MS = 180000;
const STREAM_LIMIT = 1536000;
const securityHeaders = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy':'same-origin',
};
const json = (value, status = 200) => Response.json(value, {status, headers:securityHeaders});
const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status, publicError:true});};
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
const toolLabel = name => ({flow_catalogue_summary:'统计商品类别',flow_render_visual:'绘制图片',flow_search:'搜索站内数据',flow_get_record:'读取业务详情',flow_business_summary:'汇总经营数据',flow_catalogue_audit:'核对库存和报价'}[name] || '查询业务数据');

function assertPrincipal(principal) {
  if (!principal) fail('请先登录管理端。',401);
  if (principal.role !== 'admin' || principal.storeId || !principal.tenantId || !principal.userId) fail('Flow 仅供管理端使用。',403);
}
function assertEnabled(policy) {
  if (!policy.enabled) fail('Flow 未开通或已停用，请联系平台。',403);
}
function mutationOrigin(request, env) {
  const url = new URL(request.url);
  const local = env.LOCAL_TEST === '1' && ['localhost','127.0.0.1'].includes(url.hostname);
  if ((!local && (!env.PUBLIC_ORIGIN || url.origin !== env.PUBLIC_ORIGIN)) || request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail('请求来源不正确。',403);
}
async function readBody(request, limit = 64000) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') fail('请使用 JSON 请求。',415);
  if (Number(request.headers.get('Content-Length')) > limit) fail('请求内容过长。',413);
  const reader=request.body?.getReader(),parts=[];let length=0;
  if (reader) {
    try {
      for (;;) {
        const {done,value}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>limit){await reader.cancel();fail('请求内容过长。',413);}
        parts.push(value);
      }
    } finally {reader.releaseLock();}
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('请求格式不正确。');}
  if(!body || typeof body!=='object' || Array.isArray(body))fail('请求格式不正确。');
  return body;
}
function safeHistory(history) {
  if(history==null)return [];
  if(!Array.isArray(history)||history.length>40)fail('对话过长，请新建对话。');
  let total=0;
  return history.slice(-12).map(item=>{
    if(!item||!['user','assistant'].includes(item.role)||typeof item.content!=='string'||item.content.length>16000)fail('对话格式不正确。');
    total+=item.content.length;if(total>24000)fail('对话过长，请新建对话。');
    return {role:item.role,content:item.content};
  });
}
function safeContext(context) {
  const output={};
  if(!context||typeof context!=='object'||Array.isArray(context))return output;
  for(const key of ['page','orderId','date'])if(typeof context[key]==='string')output[key]=context[key].slice(0,160);
  return output;
}
function cleanError(error) {
  const message=String(error?.message || '');
  // Raw upstream errors, credentials, SQL and filesystem details never reach clients.
  if(/(?:gh[opusr]_[a-z0-9]|github_pat_|bearer\s|sk-[a-z0-9]|(?:api[_-]?key|token)\s*[:=]|https?:\/\/|(?:\/Users\/|\/home\/|[A-Z]:\\)|\b(?:SELECT|INSERT|UPDATE|DELETE|SQLITE|D1_ERROR)\b)/i.test(message))return '模型连接失败，请检查连接设置后重试。';
  if((error?.publicError || Number.isInteger(error?.status)) && /[\u3400-\u9fff]/.test(message))return message.slice(0,240);
  return 'Flow 暂时无法完成请求，请稍后重试。';
}
function errorStatus(error) {
  return Number.isInteger(error?.status) && error.status>=400 && error.status<=599 ? error.status : 500;
}
function managementStatus(policy,connection={}) {
  const model=policy.model||(safeModel(connection.model)?connection.model:null);
  const configured=connection.configured===true||connection.connected===true;
  const available=policy.enabled&&connection.connected===true&&safeModel(model)&&connection.models?.some(row=>row.id===model)===true;
  const result={enabled:policy.enabled,configured,available,connected:available,managed:true,model};
  const name=connection.models?.find(row=>row.id===model)?.name;
  if(typeof name==='string')result.modelName=name.slice(0,160);
  if(!policy.enabled)result.message=policy.version?'Flow 已停用，请联系平台。':'Flow 未开通，请联系平台。';
  else if(!configured)result.message='Flow 尚未配置，请联系平台。';
  else if(!available)result.message='Flow 模型暂时不可用，请联系平台。';
  return result;
}

/** All Flow request state belongs to this request; durable locks and data live in D1. */
export async function handleFlow(request, env, ctx, {identity=getIdentity,store,provider,loadData=createFlowDataContext,getPolicy=getFlowPolicy} = {}) {
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/flow/'))return null;
  let pendingLease;
  try {
    const principal=await identity(request,env);assertPrincipal(principal);
    if(request.method==='POST')mutationOrigin(request,env);
    store ||= createFlowStore(env);
    provider ||= createFlowProvider({store});
    if(url.pathname==='/api/flow/provider'||url.pathname.startsWith('/api/flow/auth/'))fail('Flow 由平台统一配置。',403);
    const policy=await getPolicy(env,principal.tenantId);
    if(request.method==='GET'&&url.pathname==='/api/flow/status') {
      if(!policy.enabled)return json(managementStatus(policy));
      const connection=await provider.status(principal);
      return json(managementStatus(policy,connection));
    }
    assertEnabled(policy);
    const conversation=/^\/api\/flow\/conversations\/([^/]+)(?:\/(delete|restore))?$/.exec(url.pathname);
    const artifact=/^\/api\/flow\/artifacts\/([^/]+)$/.exec(url.pathname);
    if(request.method==='GET'&&url.pathname==='/api/flow/conversations')return json(await store.list(principal));
    if(request.method==='GET'&&conversation&&!conversation[2])return json({conversation:await store.get(principal,conversation[1])});
    if(request.method==='GET'&&artifact)return new Response(await store.getArtifact(principal,artifact[1]),{headers:{...securityHeaders,'Content-Type':'image/svg+xml; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'none'; sandbox"}});
    if(request.method!=='POST')fail('接口不存在。',404);
    const body=await readBody(request,url.pathname==='/api/flow/conversations'?640000:64000);
    if(url.pathname==='/api/flow/conversations')return json({conversation:await store.save(principal,body)});
    if(conversation?.[2]==='delete')return json(await store.remove(principal,conversation[1]));
    if(conversation?.[2]==='restore')return json({conversation:await store.restore(principal,conversation[1])});
    if(url.pathname!=='/api/flow/chat')fail('接口不存在。',404);
    if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000)fail('请输入 1～4000 字的问题。');
    const history=safeHistory(body.history),context=safeContext(body.context);
    const startedAt=Date.now(),scope=JSON.stringify(['flow-chat',principal.tenantId,principal.userId]),owner=crypto.randomUUID();
    if(!await store.acquireLease(scope,owner,CHAT_BUDGET_MS))fail('Flow 正在处理上一条问题，请稍等或先停止。',409);
    pendingLease={scope,owner};
    const connection=await provider.status(principal);
    if(connection.provider!=='copilot'||!connection.connected)fail('Flow 模型暂时不可用，请联系平台。',409);
    const model=policy.model||connection.model;
    if(body.model!=null&&body.model!==model)fail('Flow 模型由平台统一设置。',403);
    if(!safeModel(model)||!connection.models?.some(row=>row.id===model))fail('Flow 模型暂时不可用，请联系平台。',409);
    const latestPolicy=await getPolicy(env,principal.tenantId);assertEnabled(latestPolicy);
    if(latestPolicy.model&&latestPolicy.model!==model)fail('Flow 配置已更新，请重试。',409);
    request.signal.throwIfAborted();
    const remainingBudget=CHAT_BUDGET_MS-(Date.now()-startedAt);
    if(remainingBudget<=0)fail('本次查询超时，请重试。',504);
    const response=chatResponse({request,env,ctx,principal,identity,store,provider,loadData,getPolicy,model,history,context,message:body.message.trim(),scope,owner,remainingBudget});
    pendingLease=null;return response;
  } catch(error) {
    if(pendingLease)try{await store.releaseLease(pendingLease.scope,pendingLease.owner);}catch{}
    return json({error:cleanError(error)},errorStatus(error));
  }
}

function abortable(promise,signal) {
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
function chatResponse({request,env,ctx,principal,identity,store,provider,loadData,getPolicy,model,history,context,message,scope,owner,remainingBudget}) {
  const controller=new AbortController(),signal=controller.signal;
  const cancel=()=>controller.abort(request.signal.reason);
  request.signal.addEventListener('abort',cancel,{once:true});
  if(request.signal.aborted)cancel();
  const timer=setTimeout(()=>controller.abort(new DOMException('Flow request timed out','TimeoutError')),remainingBudget);
  let released=false,closed=false,streamBytes=0,consumerCancelled=false,policyTimer;
  let lastPolicyCheck=0,policyChecking;
  const checkAccess=async(force=false)=>{
    signal.throwIfAborted();
    if(!force&&Date.now()-lastPolicyCheck<750)return;
    policyChecking||=(async()=>{
      const current=await identity(request,env);
      if(!current||current.role!=='admin'||current.tenantId!==principal.tenantId||current.userId!==principal.userId||current.storeId)fail('登录状态已变更，请重新登录。',401);
      const policy=await getPolicy(env,principal.tenantId);assertEnabled(policy);
      if(policy.model&&policy.model!==model)fail('Flow 配置已更新，请重新提问。',409);
      lastPolicyCheck=Date.now();
    })();
    const checking=policyChecking;
    try{await checking;}finally{if(policyChecking===checking)policyChecking=null;}
    signal.throwIfAborted();
  };
  const release=async()=>{if(released)return;released=true;await store.releaseLease(scope,owner);};
  const stream=new ReadableStream({
    start(output) {
      const encoder=new TextEncoder(),steps=new Map();let answerStarted=false;
      const emit=(value,force=false)=>{
        if(closed||consumerCancelled||request.signal.aborted||signal.aborted&&!force)return;
        const bytes=encoder.encode(JSON.stringify(value)+'\n');streamBytes+=bytes.byteLength;
        if(streamBytes>STREAM_LIMIT&&!force){controller.abort(new DOMException('Flow response too large','QuotaExceededError'));return;}
        try{output.enqueue(bytes);}catch{closed=true;controller.abort();}
      };
      const progress=(id,label,status='running',detail='')=>{const step={id,label,status,...(detail?{detail}:{})};steps.set(id,step);emit({type:'progress',...step});};
      const finishSteps=status=>{for(const step of [...steps.values()])if(step.status==='running')progress(step.id,step.label,status,step.detail);};
      let eventQueue=Promise.resolve(),queuedBytes=0,firstAnswer=true;
      const responseEvent=event=>{
        // Explicit user-visible answer allowlist: never pass raw provider/reasoning payloads.
        if(!event||!['delta','message'].includes(event.type)||typeof event.text!=='string'||event.phase&&!['final','response','answer','final_answer'].includes(event.phase))return;
        queuedBytes+=encoder.encode(event.text).byteLength;
        if(event.text.length>128000||queuedBytes>STREAM_LIMIT){controller.abort(new DOMException('Flow response too large','QuotaExceededError'));return;}
        const force=firstAnswer||event.type==='message';firstAnswer=false;
        eventQueue=eventQueue.then(async()=>{
          await checkAccess(force);
          if(!answerStarted){answerStarted=true;if(steps.get('model')?.status==='running')progress('model',steps.get('model').label,'done');progress('answer','整理回答');}
          emit({type:event.type,text:event.text});
        }).catch(error=>controller.abort(error));
      };
      const task=(async()=>{
        try {
          await checkAccess(true);progress('prepare','准备业务数据');
          // Stop stalled inference promptly after platform revocation, even without tool events.
          policyTimer=setInterval(()=>{checkAccess(true).catch(error=>controller.abort(error));},1000);
          const data=await abortable(loadData(env.DB,principal),signal),sources=new Map(),images=new Map();let toolsUsed=0;
          await checkAccess(true);progress('prepare','准备业务数据','done','已确认当前厨房的数据范围');progress('model','理解问题');
          const execute=async(name,args)=>{
            signal.throwIfAborted();
            if(++toolsUsed>12)fail('本轮查询次数已达上限，请缩小问题范围。');
            // Recheck the platform entitlement and identity before every data/tool operation.
            await checkAccess(true);
            const stepId='tool-'+toolsUsed,label=toolLabel(name);
            if(steps.get('model')?.status==='running')progress('model',steps.get('model').label,'done');
            progress(stepId,label);emit({type:'tool',name,label,status:'running'});
            let result;
            try {
              if(name===flowVisualTool.name) {
                const image=await store.createArtifact(principal,args);await checkAccess(true);
                images.set(image.id,image);emit({type:'image',image});result={image,images:[image]};
              } else result=await runFlowTool(data,name,args);
            } catch(error) {progress(stepId,label,'error','这一步未完成');emit({type:'tool',name,label,status:'error'});throw error;}
            await checkAccess(true);
            const total=result.data?.total;
            const detail=result.image?'图片已生成':name==='flow_catalogue_summary'?`已汇总 ${result.data.total} 个商品、${result.data.categoryCount} 个类别`:Number.isInteger(total)&&total>=0?`找到 ${total} 条记录`:name==='flow_business_summary'?'已按完整历史计算':name==='flow_get_record'?'已读取记录详情':'';
            progress(stepId,label,'done',detail);progress('model','整理查询结果');
            for(const source of result.sources||[])sources.set(source.type+':'+source.id,source);
            emit({type:'tool',name,label,status:'done',count:result.sources?.length||0});emit({type:'sources',sources:[...sources.values()].slice(0,20)});
            return result;
          };
          await abortable(provider.chat({principal,message,history,model,systemPrompt:buildFlowSystemPrompt({index:data.index,context}),toolDefinitions:[...flowToolDefinitions,flowVisualTool],runTool:execute,onEvent:responseEvent,signal}),signal);
          await eventQueue;await checkAccess(true);emit({type:'sources',sources:[...sources.values()].slice(0,20)});finishSteps('done');emit({type:'done',model,images:[...images.values()],steps:[...steps.values()]});
        } catch(error) {
          if(!signal.aborted){finishSteps('error');emit({type:'error',message:cleanError(error)});}
          else if(!consumerCancelled&&!request.signal.aborted)emit({type:'error',message:signal.reason?.publicError?cleanError(signal.reason):signal.reason?.name==='QuotaExceededError'?'回复内容过长，请缩小范围后重试。':'本次查询超时，请缩小范围后重试。'},true);
        } finally {
          clearTimeout(timer);clearInterval(policyTimer);request.signal.removeEventListener('abort',cancel);
          try{await release();}catch{/* Expiring lease cannot outlive its fixed budget. */}
          closed=true;try{output.close();}catch{}
        }
      })();
      // The returned body streams the task's results. waitUntil also preserves bounded cleanup
      // after a disconnect; HTTP streaming itself keeps the normal request invocation active.
      ctx?.waitUntil?.(task);
      return task;
    },
    async cancel() {
      consumerCancelled=true;controller.abort();clearTimeout(timer);clearInterval(policyTimer);request.signal.removeEventListener('abort',cancel);
      const cleanup=release().catch(()=>{});ctx?.waitUntil?.(cleanup);await cleanup;
    },
  });
  return new Response(stream,{headers:{...securityHeaders,'Content-Type':'application/x-ndjson; charset=utf-8'}});
}
