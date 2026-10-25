import {getIdentity} from '../../backend/accounts.js';
import {createFlowDataContext, flowToolDefinitions, runFlowTool} from '../../backend/flow-tools.js';
import {buildFlowSystemPrompt} from '../../backend/flow-prompt.js';
import {createFlowConnections} from './flow-connections.mjs';
import {createFlowArchive,flowVisualTool,flowActorKey} from './flow-archive.mjs';

const json = (value, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);
const toolLabel = name => ({flow_catalogue_summary:'统计商品类别',flow_render_visual:'绘制图片',flow_search:'搜索站内数据',flow_get_record:'读取业务详情',flow_business_summary:'汇总经营数据',flow_catalogue_audit:'核对库存和报价',search_business:'搜索站内数据',get_record:'读取业务详情',summarize_business:'汇总经营数据',list_orders:'查询订单',analyze_quotes:'核对商品报价',inventory_overview:'检查库存'}[name] || '查询业务数据');

function safeHistory(history) {
  if (history == null) return [];
  if (!Array.isArray(history) || history.length > 40) fail('对话过长，请新建对话。');
  let total = 0;
  return history.slice(-12).map(item => {
    if (!item || !['user','assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 16000) fail('对话格式不正确。');
    total += item.content.length;
    if (total > 24000) fail('对话过长，请新建对话。');
    return {role:item.role, content:item.content};
  });
}
function safeContext(context = {}) {
  const output = {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) return output;
  for (const key of ['page','orderId','date']) if (typeof context[key] === 'string') output[key] = context[key].slice(0,160);
  return output;
}

export function createFlowService({db, privateDir, connections = createFlowConnections({privateDir}), identity = getIdentity, loadData = createFlowDataContext}) {
  const archive=createFlowArchive({privateDir}),activeChats=new Map();
  async function readBody(request,limit=64000) {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('请使用 JSON 请求。',415);
    const raw = await request.text();
    if (raw.length > limit) fail('请求内容过长。',413);
    let body; try { body=JSON.parse(raw); } catch { fail('请求格式不正确。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求格式不正确。');
    return body;
  }
  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/flow/')) return null;
    try {
      if (url.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(url.hostname)) return json({error:'Flow 当前仅供本地预览。'},404);
      const principal = await identity(request,{DB:db,LOCAL_TEST:'1',PUBLIC_ORIGIN:''});
      if (!principal) fail('请先登录管理端。',401);
      if (principal.role !== 'admin') fail('Flow 仅供管理端使用。',403);
      if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) fail('请求来源不正确。',403);
      if (url.pathname === '/api/flow/status' && request.method === 'GET') {
        const [provider,data] = await Promise.all([connections.selected(principal,{refresh:url.searchParams.get('refresh')==='1'}),loadData(db,principal)]);
        const {runtime,client,...publicProvider}=provider;
        return json({enabled:true,...publicProvider,providerLabel:publicProvider.connectionLabel,index:data.index});
      }
      const conversation=/^\/api\/flow\/conversations\/([^/]+)(?:\/(delete|restore))?$/.exec(url.pathname);
      const artifact=/^\/api\/flow\/artifacts\/([^/]+)$/.exec(url.pathname);
      if(request.method==='GET'&&url.pathname==='/api/flow/conversations')return json(await archive.list(principal));
      if(request.method==='GET'&&conversation&&!conversation[2])return json({conversation:await archive.get(principal,conversation[1])});
      if(request.method==='GET'&&artifact)return new Response(await archive.getArtifact(principal,artifact[1]),{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'none'; sandbox"}});
      if (request.method !== 'POST') fail('接口不存在。',404);
      const body = await readBody(request,url.pathname==='/api/flow/conversations'?640000:64000);
      if(url.pathname==='/api/flow/conversations')return json({conversation:await archive.save(principal,body)});
      if(conversation?.[2]==='delete')return json(await archive.remove(principal,conversation[1]));
      if(conversation?.[2]==='restore')return json({conversation:await archive.restore(principal,conversation[1])});
      if (url.pathname === '/api/flow/provider') {
        if (principal.accountRole !== 'owner') fail('请由负责人设置模型连接。',403);
        if(body.provider!=='copilot')fail('当前只支持 GitHub Copilot。');
        await connections.save(principal,body);return json({ok:true});
      }
      if (url.pathname === '/api/flow/auth/token') {
        if(principal.accountRole!=='owner')fail('请由负责人连接 GitHub Copilot。',403);
        return json(await connections.loginToken(principal,body.token));
      }
      if (url.pathname === '/api/flow/auth/start') {
        if (principal.accountRole !== 'owner') fail('请由负责人连接 GitHub Copilot。',403);
        return json(await connections.startAuth(principal));
      }
      if (url.pathname === '/api/flow/auth/poll') {
        if (principal.accountRole !== 'owner') fail('请由负责人连接 GitHub Copilot。',403);
        return json(await connections.pollAuth(principal,body.authId));
      }
      if (url.pathname !== '/api/flow/chat') fail('接口不存在。',404);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length>4000) fail('请输入 1～4000 字的问题。');
      const key=flowActorKey(principal);
      if(activeChats.has(key))fail('Flow 正在处理上一条问题，请稍等或先停止。',409);
      const history=safeHistory(body.history),context=safeContext(body.context);
      const provider=await connections.selected(principal,{refresh:true});
      if(provider.provider!=='copilot'||!provider.connected||!provider.client?.chat)fail('请先连接 GitHub Copilot。',409);
      const model=body.model || provider.model;
      if(!safeModel(model) || !provider.models?.some(row=>row.id===model))fail('所选模型当前不可用，请重新选择。');
      if(activeChats.has(key))fail('Flow 正在处理上一条问题，请稍等或先停止。',409);
      const controller=new AbortController(), signal=AbortSignal.any([request.signal,controller.signal,AbortSignal.timeout(120000)]);
      activeChats.set(key,controller);
      const stream=new ReadableStream({
        start(output) {
          const encoder=new TextEncoder();let closed=false;
          const emit=value=>{if(closed||signal.aborted)return;try{output.enqueue(encoder.encode(JSON.stringify(value)+'\n'));}catch{closed=true;controller.abort();}};
          const steps=new Map();
          const progress=(id,label,status='running',detail='')=>{const step={id,label,status,...(detail?{detail}:{})};steps.set(id,step);emit({type:'progress',...step});};
          const finishSteps=status=>{for(const step of [...steps.values()])if(step.status==='running')progress(step.id,step.label,status,step.detail);};
          let answerStarted=false;
          const responseEvent=event=>{
            // Only user-visible answer phases reach here from the SDK. Raw reasoning/status
            // payloads are never repurposed as thoughts; progress is generated from actual work.
            if(!['delta','message'].includes(event.type)||typeof event.text!=='string'||event.phase&&!['final','response','answer','final_answer'].includes(event.phase))return;
            if(!answerStarted){answerStarted=true;if(steps.get('model')?.status==='running')progress('model',steps.get('model').label,'done');progress('answer','整理回答');}
            emit(event);
          };
          (async()=>{
            try {
              progress('prepare','准备业务数据');
              const data=await loadData(db,principal),sources=new Map(),images=new Map();let toolsUsed=0;
              progress('prepare','准备业务数据','done','已确认当前厨房的数据范围');
              progress('model','理解问题');
              const execute=async(name,args)=>{
                signal.throwIfAborted();
                if(++toolsUsed>12)throw new Error('本轮查询次数已达上限，请缩小问题范围。');
                // Recheck session and organization access before each retrieval.
                const current=await identity(request,{DB:db,LOCAL_TEST:'1',PUBLIC_ORIGIN:''});
                if(!current || current.role!=='admin' || current.tenantId!==principal.tenantId || current.userId!==principal.userId || current.storeId)throw new Error('登录状态已变更，请重新登录。');
                const stepId='tool-'+toolsUsed,label=toolLabel(name);
                if(steps.get('model')?.status==='running')progress('model',steps.get('model').label,'done');
                progress(stepId,label);
                emit({type:'tool',name,label,status:'running'});
                let result;
                try {
                if(name===flowVisualTool.name){
                  const image=await archive.createArtifact(principal,args);
                  images.set(image.id,image);emit({type:'image',image});result={image,images:[image]};
                }else result=await runFlowTool(data,name,args);
                }catch(error){progress(stepId,label,'error','这一步未完成');emit({type:'tool',name,label,status:'error'});throw error;}
                const total=result.data?.total;
                const detail=result.image?'图片已生成':name==='flow_catalogue_summary'?`已汇总 ${result.data.total} 个商品、${result.data.categoryCount} 个类别`:Number.isInteger(total)&&total>=0?`找到 ${total} 条记录`:name==='flow_business_summary'?'已按完整历史计算':name==='flow_get_record'?'已读取记录详情':'';
                progress(stepId,label,'done',detail);
                progress('model','整理查询结果');
                for(const source of result.sources || [])sources.set(source.type+':'+source.id,source);
                emit({type:'tool',name,label:toolLabel(name),status:'done',count:result.sources?.length || 0});
                emit({type:'sources',sources:[...sources.values()].slice(0,20)});
                return result;
              };
              await provider.client.chat({message:body.message.trim(),history,model,systemPrompt:buildFlowSystemPrompt({index:data.index,context}),toolDefinitions:[...flowToolDefinitions,flowVisualTool],runTool:execute,onEvent:responseEvent,signal});
              emit({type:'sources',sources:[...sources.values()].slice(0,20)});
              finishSteps('done');
              emit({type:'done',model,images:[...images.values()],steps:[...steps.values()]});
            } catch(error) {
              if(!signal.aborted){finishSteps('error');emit({type:'error',message:cleanError(error)});}
              else if(!request.signal.aborted)try{output.enqueue(encoder.encode(JSON.stringify({type:'error',message:'本次查询超时，请缩小范围后重试。'})+'\n'));}catch{}
            } finally {
              if(activeChats.get(key)===controller)activeChats.delete(key);closed=true;try{output.close();}catch{}
            }
          })();
        },
        cancel(){controller.abort();if(activeChats.get(key)===controller)activeChats.delete(key);},
      });
      return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    } catch(error) { return json({error:cleanError(error)},error.status || 500); }
  }
  return {handle,async dispose(){for(const controller of activeChats.values())controller.abort();await connections.dispose();}};
}
function cleanError(error) {
  const message=String(error?.message || 'Flow 暂时无法连接，请重试。');
  if(/(?:gh[o-upsr]_[A-Za-z0-9]|Bearer |sk-[A-Za-z0-9]|api[_-]?key\s*[:=]|token\s*[:=])/i.test(message))return '模型连接失败，请检查连接设置。';
  return message.replace(/(?:\/Users\/|[A-Z]:\\)[^\s]+/g,'[本地路径]').slice(0,240);
}
