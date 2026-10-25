import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlowProvider, safeFlowProviderError} from '../../backend/flow-provider.js';

const owner = {role:'admin',accountRole:'owner',tenantId:'tenant-a',userId:'owner-a'};
const member = {...owner,accountRole:'member',userId:'member-a'};
const other = {...owner,tenantId:'tenant-b',userId:'owner-b'};
const token = 'gho_fake-flow-provider-test-credential';
const bearer = 'fake-copilot-upstream-token';
const chatModels = [{id:'chat-one',name:'Chat one',supported_endpoints:['/chat/completions'],capabilities:{type:'chat',supports:{tool_calls:true,streaming:true}}},{id:'chat-two',name:'Chat two'}];
const toolDefinitions = [{name:'flow_search',description:'Search own kitchen',parameters:{type:'object',properties:{query:{type:'string'}},additionalProperties:false}}];
const json = (value,status = 200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const sse = (events,{split = false} = {}) => {
  const content = events.map(value => 'data: '+(typeof value === 'string' ? value : JSON.stringify(value))+'\r\n\r\n').join('');
  const encoded = new TextEncoder().encode(content);
  const stream = new ReadableStream({start(controller){ if(split) for(let i=0;i<encoded.length;i+=7) controller.enqueue(encoded.slice(i,i+7)); else controller.enqueue(encoded); controller.close(); }});
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
};
const delta = (value, finish_reason = null) => ({choices:[{index:0,delta:value,finish_reason}]});
const answer = text => sse([delta({content:text}),delta({},'stop'),'[DONE]']);
const call = (id='call_1',name='flow_search',args='{"query":"牛肉"}') => ({id,type:'function',function:{name,arguments:args}});
const toolResponse = calls => sse([delta({tool_calls:calls.map((row,index)=>({...row,index}))}),delta({},'tool_calls'),'[DONE]']);
function fakeStore(clock) {
  const connections = new Map(), auths = new Map(), leases = new Map(), catalogues = new Map();
  const copy = value => structuredClone(value);
  const denied = () => Object.assign(new Error('forbidden'),{status:403});
  const scope = (p,isOwner=false) => {if(p.role !== 'admin' || p.storeId || !p.tenantId || !p.userId || isOwner && p.accountRole !== 'owner')throw denied();};
  const authKey = (p,id) => JSON.stringify([p.tenantId,p.userId,id]);
  return {connections,auths,catalogues,
    async getConnection(p){scope(p);return copy(connections.get(p.tenantId) || null);},
    async saveConnection(p,data,expected=null){scope(p,true);const old=connections.get(p.tenantId);if((old?.version??null)!==expected)throw Object.assign(new Error('conflict'),{status:409});const row={data:copy(data),version:(old?.version||0)+1};connections.set(p.tenantId,row);return copy(row);},
    async getModelCatalogue(p,version){scope(p);const row=catalogues.get(p.tenantId);return connections.get(p.tenantId)?.version===version&&row?.version===version?copy(row.snapshot):null;},
    async saveModelCatalogue(p,version,snapshot){scope(p);if(connections.get(p.tenantId)?.version!==version)return false;const old=catalogues.get(p.tenantId);if(old?.version===version&&old.snapshot.fetchedAt>snapshot.fetchedAt)return false;catalogues.set(p.tenantId,{version,snapshot:copy(snapshot)});return true;},
    async deleteModelCatalogue(p,version){scope(p);if(catalogues.get(p.tenantId)?.version===version)catalogues.delete(p.tenantId);},
    async getAuth(p,id){scope(p,true);const row=auths.get(authKey(p,id));if(!row || row.expiresAt<=clock())throw Object.assign(new Error('not found'),{status:404});return copy(row);},
    async saveAuth(p,id,data,expiresAt,expected=null){scope(p,true);const key=authKey(p,id),old=auths.get(key);if((old?.version??null)!==expected)throw Object.assign(new Error('conflict'),{status:409});const row={data:copy(data),version:(old?.version||0)+1,expiresAt};auths.set(key,row);return copy(row);},
    async acquireLease(key,id,ttl){const old=leases.get(key);if(old && old.expires>clock())return false;leases.set(key,{id,expires:clock()+ttl});return true;},
    async releaseLease(key,id){if(leases.get(key)?.id===id)leases.delete(key);},
  };
}
function setup(options = {}) {
  let time = 1000000, models = structuredClone(options.models || chatModels), userStatus=200, tokenStatus=200, modelStatus=200;
  let poll={error:'authorization_pending'}, upstream=()=>answer('来自真实工具的回答');
  const requests=[], now=()=>time, store=fakeStore(now);
  const fetchImpl = async(url,init={}) => {
    requests.push({url,init});
    assert.equal(init.redirect,'manual');
    if (options.override) {const response=await options.override(url,init);if(response)return response;}
    if(url==='https://api.github.com/user')return json({login:'flow-user'},userStatus);
    if(url==='https://api.github.com/copilot_internal/v2/token')return json({token:bearer,...options.exchange},tokenStatus);
    if(url==='https://api.githubcopilot.com/models'||url==='https://api.business.githubcopilot.com/models')return json({data:models},modelStatus);
    if(url==='https://github.com/login/device/code')return json(options.device || {device_code:'fake-device-code-never-echo',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5});
    if(url==='https://github.com/login/oauth/access_token')return typeof poll==='function'?poll():json(poll);
    if(['/chat/completions','/responses'].some(path=>url==='https://api.githubcopilot.com'+path||url==='https://api.business.githubcopilot.com'+path))return upstream(url,init);
    throw new Error('Unexpected URL '+url);
  };
  const provider=createFlowProvider({store,fetchImpl,now,retryDelayMs:0});
  const chat = (extra={}) => provider.chat({principal:owner,message:'查一下商品',history:[],systemPrompt:'Only current kitchen read tools',toolDefinitions,runTool:async()=>({data:{count:2}}),...extra});
  return {provider,store,requests,chat,now,advance:ms=>time+=ms,setModels:value=>models=value,setUserStatus:value=>userStatus=value,setTokenStatus:value=>tokenStatus=value,setModelStatus:value=>modelStatus=value,setPoll:value=>poll=value,setUpstream:value=>upstream=value};
}

test('no own tenant connection means no upstream calls; role and owner boundaries are enforced',async()=>{
  const h=setup();
  assert.equal((await h.provider.status(owner)).connected,false);assert.equal(h.requests.length,0);
  for(const p of [{...owner,role:'store'},{...owner,role:'platform'},{...owner,storeId:'foreign-store'},{...owner,userId:''}]) await assert.rejects(h.provider.status(p),error=>error.status===403);
  for(const fn of [()=>h.provider.loginToken(member,token),()=>h.provider.startAuth(member),()=>h.provider.save(member,{provider:'copilot'})]) await assert.rejects(fn,error=>error.status===403);
  await h.provider.loginToken(owner,token);
  assert.equal((await h.provider.status(member)).connected,true);
  assert.equal((await h.provider.status(other)).connected,false);
});

test('login verifies identity, entitlement and current model directory before committing; no secrets returned',async()=>{
  const h=setup({models:[...chatModels,{id:'unsupported-api',supported_endpoints:['/embeddings']},{id:'disabled',policy:{state:'disabled'}},{id:'embedding',capabilities:{type:'embeddings'}},{id:'no-tools',capabilities:{supports:{tool_calls:false}}}]});
  const state=await h.provider.loginToken(owner,'  '+token+'  ');
  assert.deepEqual(state.models.map(row=>row.id),['chat-one','chat-two']);assert.equal(state.model,'chat-one');assert.equal(state.login,'flow-user');
  assert.doesNotMatch(JSON.stringify(state),/gho_|upstream-token|deviceCode/);
  assert.deepEqual(h.requests.map(row=>new URL(row.url).pathname),['/user','/copilot_internal/v2/token','/models']);
  assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  h.setUserStatus(401);await assert.rejects(h.provider.loginToken(owner,'gho_invalid-another-credential'),error=>error.status===401);assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  h.setUserStatus(200);h.setTokenStatus(403);await assert.rejects(h.provider.loginToken(owner,'gho_no-subscription-credential'),error=>error.status===403);assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  for(const bad of ['', 'short', 'gho_fake\nheader-injection-token', 'x'.repeat(4097)]) await assert.rejects(h.provider.loginToken(owner,bad),error=>error.status===400);
});

test('normal status uses a version-bound 60 s catalogue and explicit refresh actually reads upstream',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);
  const afterLogin=h.requests.length,cached=await h.provider.status(owner);assert.equal(cached.cacheState,'cached');assert.equal(h.requests.length,afterLogin);
  await h.provider.save(owner,{provider:'copilot',model:'chat-two'});
  h.setModels([chatModels[0]]);
  const before=h.requests.length,state=await h.provider.status(owner);
  assert.equal(h.requests.length,before+2);assert.equal(state.cacheState,'fresh');assert.equal(state.model,'chat-two');assert.equal(state.modelUnavailable,true);
  await h.provider.status(owner);assert.equal(h.requests.length,before+2);
  await h.provider.status(owner,{refresh:true});assert.equal(h.requests.length,before+4);
  h.advance(60000);await h.provider.status(owner);assert.equal(h.requests.length,before+6);
  await assert.rejects(h.chat(),error=>error.code==='FLOW_MODEL_UNAVAILABLE');
  await assert.rejects(h.provider.save(owner,{provider:'copilot',model:'invented'}),error=>error.code==='FLOW_MODEL_UNAVAILABLE');
  h.setModelStatus(500);const unavailable=await h.provider.status(owner,{refresh:true});assert.equal(unavailable.models.length,1);assert.equal(unavailable.cacheState,'stale');assert.equal(unavailable.stale,true);assert.match(unavailable.message,/上次读取/);
});

test('transient catalogue failures retry once, retain actual previous fetch time and recover',async()=>{
  let failures=0;
  const h=setup({override:url=>{
    if(url.endsWith('/models')&&failures>0){failures--;return new Response('temporarily unavailable',{status:503});}
  }});
  const login=await h.provider.loginToken(owner,token);h.advance(5000);failures=2;
  const before=h.requests.length,stale=await h.provider.status(owner,{refresh:true});
  assert.equal(h.requests.length,before+3);assert.equal(stale.connected,true);assert.equal(stale.configured,true);assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,login.fetchedAt);assert.equal(stale.retryAfterSeconds,5);assert.deepEqual(stale.models,login.models);
  h.advance(5000);failures=1;h.setModels([chatModels[1]]);
  const fresh=await h.provider.status(owner,{refresh:true});assert.equal(fresh.stale,false);assert.equal(fresh.cacheState,'fresh');assert.equal(fresh.fetchedAt,new Date(h.now()).toISOString());assert.equal(fresh.model,'chat-one');assert.equal(fresh.modelUnavailable,true);
});

test('native network retry is bounded and diagnostic content cannot expose credentials',async()=>{
  let failures=0;const logs=[],prior=console.error;
  const h=setup({override:url=>{if(url.endsWith('/models')&&failures-- >0)throw new TypeError('private credential '+token);}});
  await h.provider.loginToken(owner,token);failures=2;console.error=(...args)=>logs.push(args.join(' '));
  try{const before=h.requests.length,result=await h.provider.status(owner,{refresh:true});assert.equal(h.requests.length,before+3);assert.equal(result.stale,true);assert.equal(result.connected,true);}
  finally{console.error=prior;}
  assert.doesNotMatch(logs.join(''),/gho_|credential|private/);assert.match(logs.join(''),/network/);
});

test('authorization denial is never retried or concealed by cached models, including later status reads',async()=>{
  for(const path of ['token','model'])for(const denial of [401,403]){
    const h=setup();await h.provider.loginToken(owner,token);
    path==='token'?h.setTokenStatus(denial):h.setModelStatus(denial);
    const before=h.requests.length,result=await h.provider.status(owner,{refresh:true});
    assert.equal(h.requests.length,before+(path==='token'?1:2));assert.equal(result.connected,false);assert.equal(result.available,false);assert.equal(result.configured,true);assert.equal(result.retryable,false);assert.deepEqual(result.models,[]);
    assert.equal(await h.store.getModelCatalogue(owner,1),null);assert.equal((await h.provider.status(owner)).connected,false);assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  }
});

test('rate limits do not trigger retries and no-cache outages retain configuration without invented models',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);h.setModelStatus(429);
  const before=h.requests.length,result=await h.provider.status(owner,{refresh:true});assert.equal(h.requests.length,before+2);assert.equal(result.stale,true);assert.equal(result.retryAfterSeconds,60);assert.match(result.refreshError,/频率/);
  await h.store.saveConnection(owner,{githubToken:token,model:'previous-selection'},1);h.setTokenStatus(503);
  const empty=await h.provider.status(owner);assert.equal(empty.configured,true);assert.equal(empty.connected,false);assert.equal(empty.model,'previous-selection');assert.deepEqual(empty.models,[]);assert.equal(empty.fetchedAt,undefined);
});

test('slow refresh and token replacement cannot publish or restore the prior connection catalogue',async()=>{
  let wait=false,release,entered;
  const waiting=new Promise(resolve=>entered=resolve);
  const h=setup({override:async url=>{if(wait&&url.endsWith('/models')){wait=false;entered();await new Promise(resolve=>release=resolve);return json({data:[chatModels[0]]});}}});
  await h.provider.loginToken(owner,token);wait=true;
  const pending=h.provider.status(owner,{refresh:true});await waiting;
  h.setModels([chatModels[1]]);await h.provider.loginToken(owner,'gho_replacement-github-credential');release();
  const old=await pending;assert.equal(old.connected,false);assert.deepEqual(old.models,[]);assert.match(old.message,/已更新/);
  const next=await h.provider.status(owner);assert.deepEqual(next.models.map(row=>row.id),['chat-two']);assert.equal(next.model,'chat-one');assert.equal(next.modelUnavailable,true);assert.equal(await h.store.getModelCatalogue(owner,1),null);
});

test('chat validates the real catalogue despite a fresh display cache and clears revoked credentials cache',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);h.setModels([chatModels[1]]);
  await assert.rejects(h.chat(),error=>error.code==='FLOW_MODEL_UNAVAILABLE');
  h.setTokenStatus(401);await assert.rejects(h.chat(),error=>error.code==='FLOW_AUTH_REQUIRED');assert.equal(await h.store.getModelCatalogue(owner,1),null);
});

test('only fixed GitHub hosts and validated Copilot API origins are used; alternate providers rejected',async()=>{
  for(const origin of ['http://127.0.0.1:18921','https://api.githubcopilot.com.evil.test','https://api.githubcopilot.com@evil.test','https://api.githubcopilot.com:8443','https://api.githubcopilot.com/models','https://api.githubcopilot.com?token=evil']) {
    const h=setup({exchange:{endpoints:{api:origin}}});await assert.rejects(h.provider.loginToken(owner,token),error=>error.code==='FLOW_UPSTREAM_INVALID');assert.ok(h.requests.every(row=>new URL(row.url).hostname==='api.github.com'));
  }
  const h=setup({exchange:{endpoints:{api:'https://api.business.githubcopilot.com'}}});await h.provider.loginToken(owner,token);assert.ok(h.requests.some(row=>row.url==='https://api.business.githubcopilot.com/models'));
  for(const body of [{provider:'api'},{provider:'copilot',apiKey:'private'},{provider:'copilot',baseUrl:'http://localhost:18921'},{provider:'copilot',wireApi:'responses'},{provider:'copilot',connection:'auto'}])await assert.rejects(h.provider.save(owner,body),error=>error.status===400);
});

test('concurrent token login cannot overwrite newer connection after verification',async()=>{
  let release,entered;
  const waiting=new Promise(resolve=>entered=resolve);
  const h=setup({override:async(url,init)=>{
    if(url==='https://api.github.com/user'&&init.headers.Authorization.includes('late-token')) {entered();await new Promise(resolve=>release=resolve);}
  }});
  const pending=h.provider.loginToken(owner,'gho_fake-late-token-credential');await waiting;
  await h.provider.loginToken(owner,token);release();
  await assert.rejects(pending,error=>error.status===409);assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
});

test('device OAuth is private, throttled across requests, owner/user scoped, and completes through CAS',async()=>{
  const h=setup(),started=await h.provider.startAuth(owner);
  assert.equal(started.userCode,'ABCD-EFGH');assert.doesNotMatch(JSON.stringify(started),/fake-device|deviceCode|access_token/);
  const form=new URLSearchParams(h.requests[0].init.body);assert.equal(form.get('client_id'),'Iv1.b507a08c87ecfe98');assert.equal(form.get('scope'),'read:user');
  await h.provider.pollAuth(owner,started.authId);assert.equal(h.requests.length,1);
  await assert.rejects(h.provider.pollAuth(other,started.authId),error=>error.status===404);
  await assert.rejects(h.provider.pollAuth({...owner,userId:'another'},started.authId),error=>error.status===404);
  h.advance(5000);h.setPoll({error:'slow_down'});await h.provider.pollAuth(owner,started.authId);
  h.advance(5000);const before=h.requests.length;await h.provider.pollAuth(owner,started.authId);assert.equal(h.requests.length,before);
  h.advance(5000);h.setPoll({access_token:token});
  const result=await h.provider.pollAuth(owner,started.authId);assert.equal(result.connected,true);assert.equal(result.pending,false);assert.doesNotMatch(JSON.stringify(result),/gho_|fake-device|deviceCode|access_token/);
  assert.equal((await h.provider.status(owner)).connected,true);
  const saved=await h.store.getAuth(owner,started.authId);assert.equal(saved.data.deviceCode,undefined);
});

test('parallel polling sends one request and late OAuth cannot overwrite a newer login',async()=>{
  const h=setup(),started=await h.provider.startAuth(owner);h.advance(5000);
  let entered,release;const waiting=new Promise(resolve=>entered=resolve);
  h.setPoll(()=>{entered();return new Promise(resolve=>release=resolve);});
  const first=h.provider.pollAuth(owner,started.authId);await waiting;
  const second=await h.provider.pollAuth(owner,started.authId);assert.equal(second.pending,true);
  await h.provider.loginToken(owner,token);release(json({access_token:'gho_fake-late-oauth-token'}));
  await assert.rejects(first,error=>error.status===409);assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  assert.equal(h.requests.filter(row=>row.url.endsWith('/login/oauth/access_token')).length,1);
});

test('expired and denied OAuth fail without altering working connection',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);const auth=await h.provider.startAuth(owner);
  h.advance(5000);h.setPoll({error:'access_denied'});const result=await h.provider.pollAuth(owner,auth.authId);assert.match(result.error,/已取消/);assert.equal(result.connected,false);
  assert.equal((await h.store.getConnection(owner)).data.githubToken,token);
  h.advance(901000);await assert.rejects(h.provider.pollAuth(owner,auth.authId),error=>error.status===404);
});

test('streaming handles split SSE and UTF-8, exposes public content only and returns authoritative final text',async()=>{
  const h=setup(),events=[];await h.provider.loginToken(owner,token);
  h.setUpstream(()=>sse([
    delta({phase:'analysis',content:'never expose analysis',reasoning_content:'private reasoning'}),
    delta({phase:'final',content:'你好，'}),delta({content:'共有 2 件。',reasoning:'never expose either'}),delta({},'stop'),'[DONE]'
  ],{split:true}));
  const result=await h.chat({onEvent:event=>events.push(event)});
  assert.equal(result.text,'你好，共有 2 件。');assert.equal(events.at(-1).type,'message');assert.equal(events.at(-1).text,result.text);
  assert.doesNotMatch(JSON.stringify(events),/analysis|reasoning|never expose/);
});

test('tool loop sends exact schemas, validates names/arguments, uses actual results and replaces pre-tool text',async()=>{
  const h=setup(),events=[],executions=[];await h.provider.loginToken(owner,token);let turn=0;
  h.setUpstream((url,init)=>{
    const payload=JSON.parse(init.body);assert.equal(payload.model,'chat-one');assert.equal(payload.tools[0].function.name,'flow_search');
    if(turn++===0)return sse([delta({content:'我先查询。',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'flow_',arguments:'{"query":'}}]}),delta({tool_calls:[{index:0,function:{name:'search',arguments:'"牛肉"}'}}]}),delta({},'tool_calls'),'[DONE]']);
    assert.equal(payload.messages.at(-1).role,'tool');assert.deepEqual(JSON.parse(payload.messages.at(-1).content),{data:{count:7}});
    return answer('有 7 件。');
  });
  const result=await h.chat({runTool:async(name,args)=>{executions.push({name,args});return {data:{count:7}};},onEvent:event=>events.push(event)});
  assert.equal(result.text,'有 7 件。');assert.equal(result.toolCalls,1);assert.deepEqual(executions,[{name:'flow_search',args:{query:'牛肉'}}]);assert.equal(events.at(-1).text,'有 7 件。');
  h.setUpstream(()=>toolResponse([call('call_2','flow_shell','{}')]));await assert.rejects(h.chat(),error=>error.code==='FLOW_TOOL_DENIED');
  h.setUpstream(()=>toolResponse([call('call_3','flow_search','[1]')]));await assert.rejects(h.chat(),error=>error.code==='FLOW_TOOL_INVALID');
});

test('tool failures are reported as failures, authorization changes terminate, and loops are bounded',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);let turn=0;
  h.setUpstream((url,init)=>{if(turn++===0)return toolResponse([call()]);const msg=JSON.parse(init.body).messages.at(-1);assert.match(JSON.parse(msg.content).error,/没有取得/);assert.doesNotMatch(msg.content,/credential|secret/);return answer('查询没有成功。');});
  assert.equal((await h.chat({runTool:async()=>{throw new Error('credential secret');}})).text,'查询没有成功。');
  h.setUpstream(()=>toolResponse([call()]));await assert.rejects(h.chat({runTool:async()=>{throw Object.assign(new Error('revoked'),{status:403});}}),error=>error.status===403);
  await assert.rejects(h.chat(),error=>error.code==='FLOW_TOOL_LIMIT');
});

test('abort cancels upstream stream immediately; malformed, incomplete and oversized outputs fail safely',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);let entered,cancelled=false;
  const waiting=new Promise(resolve=>entered=resolve);h.setUpstream(()=>{entered();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});});
  const controller=new AbortController(),pending=h.chat({signal:controller.signal});await waiting;controller.abort();await assert.rejects(pending,error=>error.code==='FLOW_ABORTED');assert.equal(cancelled,true);
  h.setUpstream(()=>sse([delta({content:'incomplete'})]));await assert.rejects(h.chat(),error=>error.code==='FLOW_UPSTREAM_INVALID');
  h.setUpstream(()=>answer('x'.repeat(100001)));await assert.rejects(h.chat(),error=>error.code==='FLOW_UPSTREAM_INVALID');
  h.setUpstream(()=>new Response('data: not-json\n\n',{headers:{'content-type':'text/event-stream'}}));await assert.rejects(h.chat(),error=>error.code==='FLOW_UPSTREAM_INVALID');
});

test('upstream errors never reflect token/path bodies and unauthorized chat retries once',async()=>{
  const h=setup();await h.provider.loginToken(owner,token);let calls=0;
  h.setUpstream(()=>calls++===0?json({error:'token '+token},401):answer('retry succeeded'));
  assert.equal((await h.chat()).text,'retry succeeded');assert.equal(calls,2);
  h.setUpstream(()=>json({error:'credential '+token+' at /private/secret'},400));
  await assert.rejects(h.chat(),error=>{assert.doesNotMatch(error.message,/gho_|private\/secret/);assert.doesNotMatch(safeFlowProviderError(error),/gho_/);return true;});
  h.setUpstream(()=>json({error:'too many'},429));await assert.rejects(h.chat(),error=>error.code==='FLOW_RATE_LIMIT');
});

const responsesModel = {id:'responses-only-real-model',name:'Responses model',supported_endpoints:['/responses'],capabilities:{type:'chat',supports:{streaming:true,tool_calls:true}}};
const responseMessage = (text,phase='final',id='msg_1') => ({type:'message',role:'assistant',id,status:'completed',phase,content:[{type:'output_text',text,annotations:[]}]});
const responsesSSE = (items,events = [],split = false) => sse([...events,...items.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{type:'response.completed',response:{id:'resp_1',status:'completed',output:items}}],{split});

test('real metadata chooses Responses or Chat Completions exactly and never exposes internal protocols',async()=>{
  const h=setup({models:[...chatModels,responsesModel,{id:'both',supported_endpoints:['/responses','/chat/completions']} ]});
  const login=await h.provider.loginToken(owner,token);assert.ok(login.models.some(row=>row.id===responsesModel.id));assert.equal(login.protocols,undefined);
  const status=await h.provider.status(owner);assert.deepEqual(Object.keys(status.models.at(-1)),['id','name']);assert.equal(status.protocols,undefined);
  h.setUpstream((url,init)=>{const body=JSON.parse(init.body);assert.ok(url.endsWith('/responses'));assert.equal(body.model,responsesModel.id);assert.equal(body.instructions,'Only current kitchen read tools');assert.equal(body.store,false);assert.deepEqual(body.include,['reasoning.encrypted_content']);assert.equal(body.tools[0].name,'flow_search');assert.equal(body.tools[0].function,undefined);assert.deepEqual(body.input,[{role:'user',content:'查一下商品'}]);return responsesSSE([responseMessage('模型目录实时匹配。')]);});
  assert.equal((await h.chat({model:responsesModel.id})).text,'模型目录实时匹配。');
  h.setUpstream(url=>{assert.ok(url.endsWith('/chat/completions'));return answer('Chat works');});assert.equal((await h.chat({model:'both'})).text,'Chat works');
});

test('Responses stateless continuation retains encrypted reasoning and exact call ID privately and executes real tool result',async()=>{
  const h=setup({models:[responsesModel]}),events=[],executed=[];await h.provider.loginToken(owner,token);let turn=0;
  const encrypted='opaque-private-reasoning-not-for-browser',callId='encrypted/call+value==',itemId='encrypted/item+value==';
  h.setUpstream((url,init)=>{
    const body=JSON.parse(init.body);assert.ok(url.endsWith('/responses'));
    if(turn++===0)return responsesSSE([
      {type:'reasoning',id:'rs_private',summary:[{type:'summary_text',text:'never expose hidden reasoning'}],encrypted_content:encrypted},
      responseMessage('hidden phase must disappear','analysis','analysis_private'),
      {type:'function_call',id:itemId,call_id:callId,name:'flow_search',arguments:'{"query":"牛肉"}',status:'completed'},
    ],[
      {type:'response.output_item.added',output_index:1,item:{type:'message',role:'assistant',phase:'analysis',id:'first-encrypted-id'}},
      {type:'response.output_text.delta',output_index:1,item_id:'different-encrypted-id',delta:'never expose hidden reasoning'},
      {type:'response.reasoning_summary_text.delta',output_index:0,delta:'never expose summary'},
      {type:'response.reasoning_text.delta',output_index:0,delta:'never expose reasoning'},
    ],true);
    const reasoning=body.input.find(item=>item.type==='reasoning');assert.equal(reasoning.encrypted_content,encrypted);assert.deepEqual(reasoning.summary,[]);
    assert.ok(!body.input.some(item=>item.phase==='analysis'));
    const called=body.input.find(item=>item.type==='function_call');assert.equal(called.call_id,callId);assert.equal(called.id,itemId);
    assert.deepEqual(body.input.at(-1),{type:'function_call_output',call_id:callId,output:JSON.stringify({data:{count:12}})});
    return responsesSSE([responseMessage('查到 12 件。')],[
      {type:'response.output_item.added',output_index:0,item:{type:'message',role:'assistant',phase:'final',id:'first-final-id'}},
      {type:'response.output_text.delta',output_index:0,item_id:'rotated-final-id',delta:'查到 '},
      {type:'response.output_text.delta',output_index:0,delta:'12 件。'},
    ],true);
  });
  const result=await h.chat({runTool:async(name,args)=>{executed.push({name,args});return {data:{count:12}};},onEvent:event=>events.push(event)});
  assert.equal(result.text,'查到 12 件。');assert.equal(result.toolCalls,1);assert.deepEqual(executed,[{name:'flow_search',args:{query:'牛肉'}}]);
  assert.deepEqual(events.map(event=>event.type),['delta','delta','message']);assert.doesNotMatch(JSON.stringify(events)+JSON.stringify(result),/opaque-private|never expose|encrypted\/|analysis_private/);
});

test('Responses unassociated deltas wait for final phase, fallback done items require completed status, JSON response works',async()=>{
  const h=setup({models:[responsesModel]}),events=[];await h.provider.loginToken(owner,token);
  h.setUpstream(()=>sse([
    {type:'response.output_text.delta',output_index:0,delta:'unknown phase should not stream'},
    {type:'response.output_item.done',output_index:0,item:responseMessage('最终回答。')},
    {type:'response.completed',response:{status:'completed'}},
  ]));
  assert.equal((await h.chat({onEvent:event=>events.push(event)})).text,'最终回答。');assert.deepEqual(events,[{type:'message',text:'最终回答。'}]);
  h.setUpstream(()=>json({status:'completed',output:[responseMessage('JSON 也可以。')]}));assert.equal((await h.chat()).text,'JSON 也可以。');
});

test('Responses rejects incomplete, failed, malformed, external tool and excessive output without leaking raw errors',async()=>{
  const h=setup({models:[responsesModel]});await h.provider.loginToken(owner,token);
  for(const upstream of [
    ()=>sse([{type:'response.output_item.done',output_index:0,item:responseMessage('partial only')}]),
    ()=>sse([{type:'response.completed',response:{status:'incomplete',output:[responseMessage('partial')]}}]),
    ()=>sse([{type:'response.failed',response:{error:{message:'credential '+token}}}]),
    ()=>sse([{type:'error',error:{message:'secret '+token}}]),
    ()=>responsesSSE([{type:'web_search_call',id:'ws_1',status:'completed'}]),
    ()=>responsesSSE([responseMessage('x'.repeat(100001))]),
    ()=>new Response('data: broken-json\n\n',{headers:{'content-type':'text/event-stream'}}),
    ()=>responsesSSE([{type:'function_call',id:'call_item',call_id:'call_1',name:'flow_search',arguments:'[]',status:'completed'}]),
  ]) {h.setUpstream(upstream);await assert.rejects(h.chat(),error=>{assert.doesNotMatch(error.message,/gho_|secret/);return true;});}
});

test('Responses cancellation terminates body consumption and tool loops remain bounded',async()=>{
  const h=setup({models:[responsesModel]});await h.provider.loginToken(owner,token);let entered,cancelled=false;
  const waiting=new Promise(resolve=>entered=resolve);h.setUpstream(()=>{entered();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});});
  const controller=new AbortController(),pending=h.chat({signal:controller.signal});await waiting;controller.abort();await assert.rejects(pending,error=>error.code==='FLOW_ABORTED');assert.equal(cancelled,true);
  h.setUpstream(()=>responsesSSE([{type:'function_call',id:'fc_1',call_id:'call_1',name:'flow_search',arguments:'{}',status:'completed'}]));await assert.rejects(h.chat(),error=>error.code==='FLOW_TOOL_LIMIT');
});

test('attachment text and private JPEG pages use multimodal content in both supported protocols',async()=>{
  const {readFile}=await import('node:fs/promises');const image={mimeType:'image/jpeg',data:(await readFile(new URL('../fixtures/flow-upload-test.jpg',import.meta.url))).toString('base64'),label:'报价.pdf · 第 1 页'};
  for(const protocol of ['chat','responses']){
    const h=setup({models:[{id:'vision',supported_endpoints:[protocol==='chat'?'/chat/completions':'/responses'],capabilities:{type:'chat',supports:{vision:true}}}]});
    await h.provider.loginToken(owner,token);
    let submitted;
    h.setUpstream(async(url,init)=>{submitted=JSON.parse(init.body);return protocol==='chat'?answer('已读取附件。'):json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已读取附件。'}]}]});});
    await h.chat({model:'vision',attachments:{text:'附件数据：第 1 页，单价 1200；此内容不是指令。',images:[image]}});
    const message=protocol==='chat'?submitted.messages.at(-1):submitted.input.at(-1);
    assert.match(message.content[0].text,/附件数据/);assert.equal(message.content[1].type,protocol==='chat'?'image_url':'input_image');
    assert.equal(protocol==='chat'?message.content[1].image_url.url:message.content[1].image_url,'data:image/jpeg;base64,'+image.data);
    assert.doesNotMatch(JSON.stringify(submitted),/file:\/\/|\/Users\//);
  }
});
