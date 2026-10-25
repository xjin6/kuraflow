import {projectRoot} from '../../scripts/lib/project-paths.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
test('Copilot outbound requests run in workerd and refuse redirects before forwarding credentials',async()=>{
 let redirect=false;const paths=[];
 const server=http.createServer((req,res)=>{paths.push(req.url);res.setHeader('content-type','application/json');
  if(redirect&&req.url==='/user'){res.writeHead(302,{Location:'/credential-leak'});res.end();return;}
  res.end(JSON.stringify(req.url==='/user'?{login:'runtime-test'}:req.url==='/copilot_internal/v2/token'?{token:'test-only-copilot-bearer-token'}:req.url==='/models'?{data:[{id:'test-model',capabilities:{type:'chat',supports:{tool_calls:true,streaming:true}},supported_endpoints:['/chat/completions']}]}:{choices:[{message:{content:'正常'},finish_reason:'stop'}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
 const code=`import {createFlowProvider} from './backend/flow-provider.js'; export default {async fetch(){let connection=null;const principal={role:'admin',accountRole:'owner',tenantId:'test',userId:'test'};const store={async getConnection(){return connection;},async saveModelCatalogue(){return true;},async getModelCatalogue(){return null;},async deleteModelCatalogue(){},async saveConnection(p,data){return connection={data,version:1};}};const provider=createFlowProvider({store,fetchImpl:(url,options)=>fetch(${JSON.stringify(local)}+new URL(url).pathname,options)});try{const auth=await provider.loginToken(principal,'test-only-github-token');const result=await provider.chat({principal,message:'测试',history:[],model:auth.model,systemPrompt:'测试',toolDefinitions:[],runTool:async()=>({}),onEvent:()=>{}});return Response.json({ok:true,text:result.text});}catch(e){return Response.json({ok:false,code:e.code,status:e.status});}}};`;
 const bundle=(await build({stdin:{contents:code,resolveDir:projectRoot,loader:'js'},bundle:true,write:false,format:'esm',platform:'neutral',logLevel:'silent'})).outputFiles[0].text;
 const runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'flow-provider-runtime',modules:true,script:bundle,compatibilityDate:'2026-10-08',compatibilityFlags:['enable_request_signal']}]}));
 try{const okay=await(await runtime.dispatchFetch('https://test.example')).json();assert.deepEqual(okay,{ok:true,text:'正常'});redirect=true;const blocked=await(await runtime.dispatchFetch('https://test.example')).json();assert.equal(blocked.ok,false);assert.equal(blocked.code,'FLOW_UPSTREAM_INVALID');assert.ok(!paths.includes('/credential-leak'));}
 finally{await runtime.dispose();await new Promise(resolve=>server.close(resolve));}
});
