import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,readdir,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createFlowConnections} from './flow-connections.mjs';

const owner={role:'admin',accountRole:'owner',tenantId:'tenant-a',userId:'owner-a'};
const other={...owner,tenantId:'tenant-b',userId:'owner-b'};
const member={...owner,accountRole:'member',userId:'member-a'};
const token='gho_fake-flow-test-token-not-a-real-credential';
const key='fake-test-api-key';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

async function setup(t,options={}) {
  const privateDir=await mkdtemp(path.join(os.tmpdir(),'flow-connections-test-'));
  const requests=[],instances=[],polls=[];
  let time=1000000,pollResponse={error:'authorization_pending'},userStatus=200;
  let directState=options.directState || {connected:true,login:'flow-test-user',models:[{id:'gpt-4.1',name:'GPT-4.1'},{id:'gpt-6-luna',name:'GPT-6 Luna'},{id:'blocked',policy:{state:'disabled'}}],unexpectedToken:token};
  const fetchImpl=async(url,init={})=>{
    requests.push({url,init});
    if(url==='https://github.com/login/device/code') return response(options.device || {device_code:'fake-device-code-'+requests.length,user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5});
    if(url==='https://github.com/login/oauth/access_token') { polls.push(init); return typeof pollResponse==='function'?pollResponse():response(pollResponse); }
    if(url==='https://api.github.com/user') return options.userResponse ? options.userResponse() : response(userStatus === 200 ? {login:'flow-test-user'} : {},userStatus);
    throw new Error('unexpected URL');
  };
  const copilotFactory=configuration=>{
    const record={configuration,disposed:false,statusCalls:0,statusOptions:[]};
    record.client={async status(settings){record.statusCalls++;record.statusOptions.push(settings);return directState;},async dispose(){record.disposed=true;},async chat(){return {text:'scoped'};}};
    instances.push(record);return record.client;
  };
  const manager=createFlowConnections({privateDir,fetchImpl,copilotFactory,now:()=>time});
  t.after(async()=>{await manager.dispose();await rm(privateDir,{recursive:true,force:true});});
  const configPath=principal=>path.join(privateDir,'flow-providers',createHash('sha256').update(principal.tenantId).digest('hex')+'.json');
  return {manager,requests,instances,polls,privateDir,configPath,advance:(ms=5000)=>time+=ms,setPoll:value=>pollResponse=value,setDirectState:value=>directState=value,setUserStatus:value=>userStatus=value};
}

test('independent connection returns only live safe models and remembers actual selection',async t=>{
  const h=await setup(t);
  await h.manager.loginToken(owner,token);
  const initial=await h.manager.selected(owner);
  assert.equal(initial.connectionLabel,'GitHub Copilot');
  assert.deepEqual(initial.models.map(row=>row.id),['gpt-4.1','gpt-6-luna']);
  assert.equal(initial.model,'gpt-4.1','initial selection comes from returned catalogue order');
  await h.manager.save(owner,{provider:'copilot',model:'gpt-6-luna'});
  assert.equal((await h.manager.selected(owner)).model,'gpt-6-luna');
  await assert.rejects(h.manager.save(owner,{provider:'copilot',model:'invented-model'}),/当前不可用/);
  assert.equal((await h.manager.selected(owner)).model,'gpt-6-luna');
});

test('without its own tenant token Flow stays disconnected and never inherits any external auth',async t=>{
  const h=await setup(t);
  const status=await h.manager.selected(owner);
  assert.equal(status.connected,false);assert.equal(status.models.length,0);assert.equal(h.instances.length,0);
  await h.manager.save(owner,{provider:'copilot',connection:'direct'});
  assert.equal((await h.manager.selected(owner)).connected,false);assert.equal(h.instances.length,0);
  assert.equal(h.requests.length,0,'no external app discovery or ambient credential lookup');
});

test('device auth follows GitHub flow, respects interval, keeps credentials private and uses isolated SDK',async t=>{
  const h=await setup(t),auth=await h.manager.startAuth(owner);
  assert.equal(auth.verificationUri,'https://github.com/login/device');assert.equal(auth.userCode,'ABCD-EFGH');
  assert.doesNotMatch(JSON.stringify(auth),/device_code|fake-device-code|access_token/);
  const form=new URLSearchParams(h.requests[0].init.body);
  assert.equal(form.get('client_id'),'Iv1.b507a08c87ecfe98');assert.equal(form.get('scope'),'read:user');
  assert.equal(h.requests[0].init.redirect,'error');
  await h.manager.pollAuth(owner,auth.authId);assert.equal(h.polls.length,0);
  h.advance();h.setPoll({access_token:token});
  const result=await h.manager.pollAuth(owner,auth.authId);
  assert.equal(result.connected,true);assert.equal(result.pending,false);assert.equal(result.login,'flow-test-user');
  assert.deepEqual(result.models.map(row=>row.id),['gpt-4.1','gpt-6-luna']);
  assert.doesNotMatch(JSON.stringify(result),/gho_|access_token|fake-device-code/);
  assert.equal(h.instances.length,1);assert.equal(h.instances[0].configuration.gitHubToken,token);assert.equal(h.instances[0].configuration.useLoggedInUser,false);
  assert.ok(h.instances[0].configuration.privateDir.startsWith(h.privateDir));
  const status=await h.manager.selected(owner);
  assert.equal(status.connection,'direct');assert.equal(status.connected,true);assert.equal(status.client,h.instances[0].client);assert.equal(status.runtime,undefined);
  const {client,...publicStatus}=status;assert.doesNotMatch(JSON.stringify(publicStatus),/gho_|fake-flow|unexpectedToken/);
  const saved=JSON.parse(await readFile(h.configPath(owner),'utf8'));assert.equal(saved.githubToken,token);
  assert.equal((await stat(h.configPath(owner))).mode&0o777,0o600);
  assert.equal((await stat(path.dirname(h.configPath(owner)))).mode&0o777,0o700);
  assert.equal((await readdir(path.dirname(h.configPath(owner)))).filter(name=>name.endsWith('.tmp')).length,0);
  assert.equal((await h.manager.selected(other)).connection,'direct');
  await h.manager.save(other,{provider:'copilot',connection:'direct'});assert.equal((await h.manager.selected(other)).connected,false);
});

test('owner and auth session scopes are enforced and cross-tenant/user polling is refused',async t=>{
  const h=await setup(t),auth=await h.manager.startAuth(owner);
  await assert.rejects(h.manager.startAuth(member),error=>error.status===403);
  await assert.rejects(h.manager.save(member,{provider:'copilot'}),error=>error.status===403);
  await assert.rejects(h.manager.loginToken(member,token),error=>error.status===403);
  await assert.rejects(h.manager.selected({...owner,role:'store'}),error=>error.status===403);
  await assert.rejects(h.manager.pollAuth(other,auth.authId),error=>error.status===404);
  await assert.rejects(h.manager.pollAuth({...owner,userId:'another-owner'},auth.authId),error=>error.status===404);
  h.advance(901000);await assert.rejects(h.manager.pollAuth(owner,auth.authId),error=>error.status===404);
  assert.equal(h.polls.length,0);
});

test('slow_down increases interval, concurrent polls share one request and cancellation is reported',async t=>{
  const h=await setup(t),auth=await h.manager.startAuth(owner);
  h.advance();h.setPoll({error:'slow_down'});await h.manager.pollAuth(owner,auth.authId);
  h.advance();await h.manager.pollAuth(owner,auth.authId);assert.equal(h.polls.length,1);
  h.advance();h.setPoll({error:'access_denied'});
  const [a,b]=await Promise.all([h.manager.pollAuth(owner,auth.authId),h.manager.pollAuth(owner,auth.authId)]);
  assert.equal(h.polls.length,2);assert.equal(a.connected,false);assert.match(a.error,/已取消/);
  assert.ok(b.pending || b.error);
});

test('failed Copilot entitlement preserves prior provider and cannot claim connected',async t=>{
  const h=await setup(t);
  await h.manager.loginToken(owner,token);
  const before=await readFile(h.configPath(owner),'utf8');
  h.setDirectState({connected:true,models:[]});
  const auth=await h.manager.startAuth(owner);h.advance();h.setPoll({access_token:'gho_fake-new-candidate-token'});
  const result=await h.manager.pollAuth(owner,auth.authId);
  assert.equal(result.connected,false);assert.match(result.error,/没有读到可用/);
  const status=await h.manager.selected(owner);assert.equal(status.connection,'direct');assert.equal(status.connected,true);assert.equal(status.model,'gpt-4.1');
  assert.equal(await readFile(h.configPath(owner),'utf8'),before);
  assert.equal(JSON.parse(await readFile(h.configPath(owner),'utf8')).githubToken,token);
});

test('changing provider during OAuth prevents late completion replacing newer settings',async t=>{
  const h=await setup(t),auth=await h.manager.startAuth(owner);h.advance();
  let resolveToken;h.setPoll(()=>new Promise(resolve=>{resolveToken=resolve;}));
  const poll=h.manager.pollAuth(owner,auth.authId);
  await new Promise(resolve=>setImmediate(resolve));
  await h.manager.save(owner,{provider:'copilot',connection:'direct'});
  resolveToken(response({access_token:token}));
  await assert.rejects(poll,error=>error.status===409);
  const current=await h.manager.selected(owner);assert.equal(current.connection,'direct');assert.equal(current.connected,false);
  assert.equal(JSON.parse(await readFile(h.configPath(owner),'utf8')).githubToken,undefined);
});

test('API key provider is rejected server-side, including disguised custom settings',async t=>{
  const h=await setup(t);
  for(const body of [
    {provider:'api',baseUrl:'https://api.example.test/v1',model:'api-model',apiKey:key},
    {provider:'copilot',apiKey:key},
    {provider:'copilot',baseUrl:'https://api.example.test/v1'},
    {provider:'copilot',wireApi:'responses'},
  ]) {
    await assert.rejects(h.manager.save(owner,body),/只支持 GitHub Copilot/);
  }
  await assert.rejects(h.manager.save(owner,{provider:'copilot',connection:'auto'}),/Flow 自己/);
  await assert.rejects(readFile(h.configPath(owner)),error=>error.code==='ENOENT');
});

test('older private API configuration remains untouched but is disabled and never returned',async t=>{
  const h=await setup(t);await mkdir(path.dirname(h.configPath(owner)),{recursive:true});
  const raw=JSON.stringify({provider:'api',baseUrl:'https://api.example.test/v1',model:'legacy-model',apiKey:key});
  await writeFile(h.configPath(owner),raw);
  const state=await h.manager.selected(owner);assert.equal(state.provider,'copilot');assert.equal(state.connected,false);assert.equal(state.runtime,undefined);assert.equal(state.model,'');
  assert.equal(await readFile(h.configPath(owner),'utf8'),raw);assert.doesNotMatch(JSON.stringify(state),/fake-test-api-key|apiKey|baseUrl|legacy-model/);
  await writeFile(h.configPath(owner),'broken config');
  await assert.rejects(h.manager.selected(owner),/无法读取/);
});

test('malicious OAuth URLs and device payloads never reach browser',async t=>{
  for(const device of [
    {device_code:'fake-device-code-long',user_code:'ABCD-EFGH',verification_uri:'https://evil.example/login/device'},
    {device_code:'fake-device-code-long',user_code:'<script>',verification_uri:'https://github.com/login/device'},
    {device_code:'short',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device'},
  ]) { const h=await setup(t,{device});await assert.rejects(h.manager.startAuth(owner),/无法开始/); }
});

test('pasted GitHub token is verified before saving and returns only identity and live models',async t=>{
  const h=await setup(t);
  const result=await h.manager.loginToken(owner,'  '+token+'  ');
  assert.equal(result.connected,true);assert.equal(result.login,'flow-test-user');assert.equal(result.modelSource,'github-copilot');
  assert.equal(result.models.length,2);assert.doesNotMatch(JSON.stringify(result),/gho_|fake-flow|unexpectedToken/);
  assert.equal(h.requests[0].url,'https://api.github.com/user');assert.equal(h.requests[0].init.headers.Authorization,'Bearer '+token);
  assert.deepEqual(h.instances[0].statusOptions,[{refresh:true}]);
  assert.equal(h.instances[0].configuration.gitHubToken,token);assert.equal(h.instances[0].configuration.useLoggedInUser,false);
  assert.equal((await h.manager.selected(owner)).connection,'direct');
  assert.equal((await stat(h.configPath(owner))).mode&0o777,0o600);
});

test('invalid pasted token and missing Copilot entitlement retain the working connection byte-for-byte',async t=>{
  const h=await setup(t);await h.manager.loginToken(owner,token);
  const before=await readFile(h.configPath(owner),'utf8');
  h.setUserStatus(401);
  await assert.rejects(h.manager.loginToken(owner,'gho_fake-invalid-token'),error=>error.status===401 && /Token 无效/.test(error.message));
  assert.equal(h.instances.length,1,'invalid GitHub identity never starts another SDK client');
  assert.equal(await readFile(h.configPath(owner),'utf8'),before);
  h.setUserStatus(200);h.setDirectState({connected:true,models:[]});
  await assert.rejects(h.manager.loginToken(owner,'gho_fake-no-copilot-token'),error=>error.status===403 && /订阅/.test(error.message));
  assert.equal(await readFile(h.configPath(owner),'utf8'),before);
  assert.equal((await h.manager.selected(owner)).connected,true,'failed replacement did not change existing cached connection');
  for(const malformed of ['', 'short', 'gho_bad\nheader-injection', 'gho_bad\0token-value', 'a'.repeat(4097)]) await assert.rejects(h.manager.loginToken(owner,malformed),/完整的 GitHub Token/);
});

test('manual refresh bypasses manager TTL, requests SDK refresh, and preserves a vanished selection',async t=>{
  const h=await setup(t);await h.manager.loginToken(owner,token);
  await h.manager.save(owner,{provider:'copilot',model:'gpt-4.1'});
  const before=await h.manager.selected(owner),calls=h.instances[0].statusCalls;
  h.setDirectState({connected:true,login:'flow-test-user',models:[{id:'new-real-model'}]});h.advance(1);
  assert.equal((await h.manager.selected(owner)).models[0].id,'gpt-4.1');assert.equal(h.instances[0].statusCalls,calls);
  const current=await h.manager.selected(owner,{refresh:true});
  assert.deepEqual(current.models,[{id:'new-real-model',name:'new-real-model'}]);assert.equal(h.instances[0].statusCalls,calls+1);
  assert.deepEqual(h.instances[0].statusOptions.at(-1),{refresh:true});assert.notEqual(current.fetchedAt,before.fetchedAt);
  assert.equal(current.model,'gpt-4.1');assert.equal(current.modelUnavailable,true);assert.match(current.message,/重新选择/);
  await assert.rejects(h.manager.save(owner,{provider:'copilot',model:'gpt-4.1'}),/当前不可用/);
  await h.manager.save(owner,{provider:'copilot',model:'new-real-model'});
  assert.equal((await h.manager.selected(owner)).modelUnavailable,false);
});

test('legacy automatic config is preserved but only an owned GitHub token can activate Flow',async t=>{
  const h=await setup(t);await mkdir(path.dirname(h.configPath(owner)),{recursive:true});
  const legacy=JSON.stringify({provider:'copilot',connection:'auto',model:'old-external-model'});
  await writeFile(h.configPath(owner),legacy);
  const inactive=await h.manager.selected(owner,{refresh:true});
  assert.equal(inactive.connected,false);assert.equal(inactive.connection,'direct');assert.equal(h.requests.length,0);assert.equal(h.instances.length,0);
  assert.equal(await readFile(h.configPath(owner),'utf8'),legacy);
  await writeFile(h.configPath(owner),JSON.stringify({provider:'copilot',connection:'auto',githubToken:token,model:'gpt-4.1'}));
  const active=await h.manager.selected(owner,{refresh:true});
  assert.equal(active.connected,true);assert.equal(active.connection,'direct');assert.equal(active.modelSource,'github-copilot');assert.equal(h.instances[0].configuration.gitHubToken,token);
});

test('connection change during token verification prevents late token login from overwriting it',async t=>{
  let resolveUser;
  const h=await setup(t,{userResponse:()=>new Promise(resolve=>{resolveUser=resolve;})});
  const pending=h.manager.loginToken(owner,token);
  await new Promise(resolve=>setImmediate(resolve));
  await h.manager.save(owner,{provider:'copilot',connection:'direct'});
  resolveUser(response({login:'flow-test-user'}));
  await assert.rejects(pending,error=>error.status===409);
  const state=await h.manager.selected(owner);assert.equal(state.connection,'direct');assert.equal(state.connected,false);
  assert.equal(JSON.parse(await readFile(h.configPath(owner),'utf8')).githubToken,undefined);
});
