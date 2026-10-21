import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFlowService} from './flow-service.mjs';
const owner={role:'admin',accountRole:'owner',tenantId:'test-tenant',userId:'test-owner'};
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><text x="40" y="50" font-size="24">订单流程</text></svg>';
function req(route,body,headers={}){return new Request('http://localhost:8787/api/flow'+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{Origin:'http://localhost:8787','Content-Type':'application/json',...headers}});}
async function setup(t,options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-service-'));const counters={auth:0,provider:0,chat:0,token:0,refresh:[]};
 const copilot={async chat({runTool,onEvent}){counters.chat++;onEvent({type:'reasoning',text:'private reasoning sentinel'});onEvent({type:'status',message:'private reasoning sentinel'});onEvent({type:'message',phase:'analysis',text:'private reasoning sentinel'});await runTool('flow_render_visual',{svg,title:'订单流程'});onEvent({type:'message',text:'流程图已生成。'});},async dispose(){}};
 const connections={async selected(principal,options){counters.refresh.push(options?.refresh||false);return {connected:true,provider:'copilot',model:'test-model',models:[{id:'test-model',name:'测试模型'}],connectionLabel:'GitHub Copilot',runtime:{apiKey:'never-show'},client:copilot};},async loginToken(principal,token){counters.token++;assert.equal(principal.userId,owner.userId);assert.equal(token,'test-user-provided-token');return {connected:true,model:'test-model',models:[{id:'test-model'}],login:'test-user'};},async save(){counters.provider++;},async startAuth(){counters.auth++;return {authId:'test-auth'};},async pollAuth(){return {connected:true};},async dispose(){}};
 const service=createFlowService({db:{},privateDir:dir,copilot,connections,identity:async request=>request.headers.get('X-Test-Auth')==='none'?null:request.headers.get('X-Test-Auth')==='store'?{...owner,role:'store'}:request.headers.get('X-Test-Auth')==='platform'?{...owner,role:'platform'}:request.headers.get('X-Test-Auth')==='member'?{...owner,userId:'member',accountRole:'member'}:owner,loadData:async()=>({index:{products:0,orders:0}}),...options});
 t.after(async()=>{await service.dispose();await fs.rm(dir,{recursive:true,force:true});});return {service,counters};
}
test('all history and image endpoints keep management authentication and same-origin mutations',async t=>{
 const {service,counters}=await setup(t);
 for(const route of ['/conversations','/artifacts/11111111-1111-1111-1111-111111111111','/status'])for(const [auth,status] of [['none',401],['store',403],['platform',403]])assert.equal((await service.handle(req(route,undefined,{'X-Test-Auth':auth}))).status,status);
 assert.equal((await service.handle(req('/conversations',{messages:[]},{Origin:'https://evil.test'}))).status,403);
 assert.equal((await service.handle(req('/auth/start',{}, {'X-Test-Auth':'member'}))).status,403);
 assert.equal((await service.handle(req('/provider',{provider:'copilot'},{'X-Test-Auth':'member'}))).status,403);
 assert.equal(counters.auth,0);assert.equal(counters.provider,0);
 const status=await (await service.handle(req('/status'))).json();assert.equal(status.model,'test-model');assert.equal(status.runtime,undefined);assert.equal(status.client,undefined);assert.doesNotMatch(JSON.stringify(status),/never-show/);
});
test('history HTTP save, reopen, delete and undo retain full user-scoped content',async t=>{
 const {service}=await setup(t);const saved=await (await service.handle(req('/conversations',{messages:[{role:'user',text:'我想看订单'}],draft:'下一句'}))).json();const id=saved.conversation.id;
 assert.equal((await (await service.handle(req('/conversations'))).json()).conversations.length,1);
 assert.equal((await (await service.handle(req('/conversations/'+id))).json()).conversation.draft,'下一句');
 assert.equal((await service.handle(req('/conversations/'+id,undefined,{'X-Test-Auth':'member'}))).status,404);
 assert.equal((await service.handle(req('/conversations/'+id+'/delete',{}))).status,200);
 assert.equal((await service.handle(req('/conversations/'+id))).status,410);
 assert.equal((await service.handle(req('/conversations/'+id+'/restore',{}))).status,200);
});
test('a real visual tool execution emits a renderable private artifact and final image metadata',async t=>{
 const {service}=await setup(t);const response=await service.handle(req('/chat',{message:'画一个订单流程图',history:[]}));assert.equal(response.status,200);
 const events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));const image=events.find(e=>e.type==='image').image;
 assert.equal(events.at(-1).images[0].url,image.url);
 assert.doesNotMatch(JSON.stringify(events),/private reasoning sentinel/);
 assert.ok(events.some(e=>e.type==='progress'&&e.id==='prepare'&&e.status==='done'));
 assert.ok(events.some(e=>e.type==='progress'&&e.id==='tool-1'&&e.label==='绘制图片'&&e.status==='done'));
 assert.ok(events.at(-1).steps.every(step=>step.status==='done'));
 const preview=await service.handle(req(image.url.replace('/api/flow','')));assert.equal(preview.status,200);assert.match(preview.headers.get('Content-Type'),/image\/svg\+xml/);assert.match(preview.headers.get('Content-Security-Policy'),/sandbox/);assert.match(await preview.text(),/订单流程/);
 assert.equal((await service.handle(req(image.url.replace('/api/flow',''),undefined,{'X-Test-Auth':'member'}))).status,404);
});
test('session changes during tool execution stop artifact creation',async t=>{
 let checks=0;const {service}=await setup(t,{identity:async()=>++checks===1?owner:{...owner,userId:'changed'}});
 const response=await service.handle(req('/chat',{message:'绘图',history:[]}));const events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.ok(events.some(e=>e.type==='error'));assert.ok(!events.some(e=>e.type==='image'));
});

test('token login remains owner-only, custom API is rejected, and manual refresh reaches the connection manager',async t=>{
 const {service,counters}=await setup(t);
 assert.equal((await service.handle(req('/auth/token',{token:'test-user-provided-token'},{'X-Test-Auth':'member'}))).status,403);
 assert.equal((await service.handle(req('/auth/token',{token:'test-user-provided-token'},{Origin:'https://evil.test'}))).status,403);
 assert.equal(counters.token,0);
 const login=await (await service.handle(req('/auth/token',{token:'test-user-provided-token'}))).json();
 assert.equal(login.connected,true);assert.equal(counters.token,1);assert.doesNotMatch(JSON.stringify(login),/test-user-provided-token/);
 assert.equal((await service.handle(req('/provider',{provider:'api',baseUrl:'https://example.com',model:'old-model',apiKey:'old-key'}))).status,400);
 assert.equal(counters.provider,0);
 await service.handle(req('/status'));await service.handle(req('/status?refresh=1'));
 assert.deepEqual(counters.refresh,[false,true]);
});
