import {projectRoot,browserSources} from '../../scripts/lib/project-paths.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';

const bundle=(await build({absWorkingDir:projectRoot,entryPoints:[browserSources['platform-app.js']],bundle:true,write:false,format:'esm',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const kitchens=[{id:'tenant-a',name:'测试厨房甲',owner_name:'负责人甲',active:1,seats:1},{id:'tenant-b',name:'测试厨房乙',owner_name:'负责人乙',active:1,seats:0}];
const config=(tenantId='tenant-a',changes={})=>({tenantId,name:kitchens.find(row=>row.id===tenantId)?.name,version:4,flow:{enabled:true,model:'model-one'},connection:{configured:true,hasToken:true,model:'model-one',models:[{id:'model-one',name:'模型一'},{id:'model-two',name:'模型二'}],fetchedAt:Date.now(),cacheState:'fresh'},...changes});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});

async function until(check,label='UI did not settle') {
  for(let attempt=0;attempt<100;attempt++){if(check())return;await nextTurn();}
  assert.fail(label);
}
async function fixture(t,route) {
  const errors=[],calls=[],console=new VirtualConsole();
  console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<div id="app"></div><div id="overlay-root"></div><div id="toast-container"></div>',{url:'https://accounts.example.test/?login=platform',runScripts:'outside-only',virtualConsole:console});
  t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);});
  const {window}=dom;
  window.__KURAFLOW_ACCOUNT_PRINCIPAL__={role:'platform',accountRole:'owner',displayName:'测试平台'};
  window.fetch=async(path,options={})=>{
    const call={path:String(path),method:options.method||'GET',body:options.body===undefined?undefined:JSON.parse(options.body)};calls.push(call);
    if(call.path==='/api/platform/kitchens')return response({kitchens});
    return route(call);
  };
  await window.eval(`(async()=>{${bundle}\n})()`);
  await until(()=>window.document.querySelector('[data-action="accounts-kitchen-features"]'));
  return {window,document:window.document,calls};
}
function click(document,selector){const el=document.querySelector(selector);assert.ok(el,selector);el.click();return el;}
async function open(document,tenant='tenant-a') {
  click(document,`[data-action="accounts-kitchen-features"][data-tenant="${tenant}"]`);
  await until(()=>document.getElementById('accounts-flow-form')?.getAttribute('aria-busy')==='false');
  return document.getElementById('accounts-flow-form');
}
function change(window,input,value){if(input.type==='checkbox')input.checked=value;else input.value=value;input.dispatchEvent(new window.Event('change',{bubbles:true}));}
function submit(window,form){const event=new window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}

test('platform config uses the kitchen scope, shared model dropdown and CAS feature payload',async t=>{
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/flow?tenant=tenant-a')return response(config());
    if(call.path==='/api/platform/flow')return response(config('tenant-a',{version:5}));
    throw Error(call.path);
  });
  assert.equal(document.querySelectorAll('[data-action="accounts-kitchen-features"]').length,2);
  const form=await open(document);
  assert.equal(form.querySelector('.accounts-flow-customer').textContent,'测试厨房甲');
  assert.equal(form.querySelector('#accounts-flow-token').type,'password');
  assert.equal(form.querySelector('#accounts-flow-token').getAttribute('value'),null);
  assert.equal(form.querySelector('#accounts-flow-token').value,'');
  await until(()=>form.querySelector('.ui-select [role="combobox"]'));
  click(document,'.accounts-flow-modal [role="combobox"]');
  assert.equal(document.querySelectorAll('.accounts-flow-modal [role="option"]').length,3);
  click(document,'.accounts-flow-modal [role="option"][data-index="2"]');
  assert.equal(form.elements.flowModel.value,'model-two');
  submit(window,form);
  await until(()=>!document.getElementById('accounts-flow-form'));
  const write=calls.find(call=>call.path==='/api/platform/flow');
  assert.deepEqual(write.body,{tenantId:'tenant-a',version:4,enabled:true,model:'model-two'});
  assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
});

test('explicit model refresh shows stale provenance and preserves draft fields and unsent token',async t=>{
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/flow?tenant=tenant-a')return response(config());
    if(call.path==='/api/platform/flow/models')return response(config('tenant-a',{connection:{...config().connection,stale:true,cacheState:'stale',refreshError:'GitHub 暂时不可用，保留上次目录。'}}));
    throw Error(call.path);
  });
  const form=await open(document),token=form.querySelector('#accounts-flow-token');
  token.value='SYNTHETIC-UNSENT-TOKEN';
  change(window,form.elements.flowModel,'model-two');change(window,form.elements.flowEnabled,false);
  click(document,'[data-action="accounts-flow-refresh"]');
  await until(()=>form.querySelector('[data-flow-catalogue-status]').textContent.includes('缓存目录'));
  assert.equal(form.querySelector('#accounts-flow-token'),token);
  assert.equal(token.value,'SYNTHETIC-UNSENT-TOKEN');
  assert.equal(form.elements.flowModel.value,'model-two');assert.equal(form.elements.flowEnabled.checked,false);
  assert.match(form.querySelector('[data-flow-connection-message]').textContent,/保留上次目录/);
  assert.deepEqual(calls.find(call=>call.path==='/api/platform/flow/models').body,{tenantId:'tenant-a'});
  assert.equal(form.innerHTML.includes('SYNTHETIC-UNSENT-TOKEN'),false);
  assert.equal(window.localStorage.length,0);
});

test('token submit clears the input immediately, redacts errors and retains the configured model',async t=>{
  let resolveConnection;
  const pending=new Promise(resolve=>{resolveConnection=resolve;});
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/flow?tenant=tenant-a')return response(config());
    if(call.path==='/api/platform/flow/connection')return pending;
    throw Error(call.path);
  });
  const form=await open(document),token=form.querySelector('#accounts-flow-token');
  token.value='SYNTHETIC-REJECTED-TOKEN';change(window,form.elements.flowModel,'model-two');
  click(document,'[data-action="accounts-flow-connect"]');
  assert.equal(token.value,'');assert.equal(token.disabled,true);
  assert.deepEqual(calls.find(call=>call.path==='/api/platform/flow/connection').body,{tenantId:'tenant-a',token:'SYNTHETIC-REJECTED-TOKEN'});
  resolveConnection(response({error:'无法验证 SYNTHETIC-REJECTED-TOKEN'},400));
  await until(()=>form.querySelector('.accounts-form-error').textContent);
  assert.equal(token.value,'');assert.equal(token.disabled,false);
  assert.equal(form.innerHTML.includes('SYNTHETIC-REJECTED-TOKEN'),false);
  assert.match(form.querySelector('.accounts-form-error').textContent,/已隐藏/);
  assert.equal(form.elements.flowModel.value,'model-two');
  assert.equal(form.querySelector('[data-flow-connection-state]').textContent,'已配置');
  assert.equal(window.location.search,'?login=platform');
});

test('a version conflict retains feature choices until latest configuration is explicitly read',async t=>{
  let version=4,writes=0;
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/flow?tenant=tenant-a')return response(config('tenant-a',{version}));
    if(call.path==='/api/platform/flow'){
      writes++;if(writes===1){version=5;return response({error:'配置已被更新，请读取最新配置。'},409);}
      return response(config('tenant-a',{version:6}));
    }
    throw Error(call.path);
  });
  const form=await open(document);
  change(window,form.elements.flowEnabled,false);change(window,form.elements.flowModel,'model-two');
  submit(window,form);
  await until(()=>form.querySelector('.accounts-form-error').textContent);
  assert.equal(form.elements.flowEnabled.checked,false);assert.equal(form.elements.flowModel.value,'model-two');
  click(document,'[data-action="accounts-flow-reload"]');
  await until(()=>form.getAttribute('aria-busy')==='false'&&!form.querySelector('.accounts-form-error').textContent);
  assert.equal(form.elements.flowEnabled.checked,false);assert.equal(form.elements.flowModel.value,'model-two');
  submit(window,form);await until(()=>!document.getElementById('accounts-flow-form'));
  assert.deepEqual(calls.filter(call=>call.path==='/api/platform/flow').map(call=>call.body.version),[4,5]);
});

test('closing a pending connection clears credentials and cannot overwrite another kitchen dialog',async t=>{
  let resolveConnection;const pending=new Promise(resolve=>{resolveConnection=resolve;});
  const {document}=await fixture(t,call=>{
    if(call.path.startsWith('/api/platform/flow?'))return response(config(new URL(call.path,'https://test.invalid').searchParams.get('tenant')));
    if(call.path==='/api/platform/flow/connection')return pending;
    throw Error(call.path);
  });
  const first=await open(document);first.querySelector('#accounts-flow-token').value='SYNTHETIC-TOKEN';
  click(document,'[data-action="accounts-flow-connect"]');
  click(document,'.modal-header [data-action="close"]');
  assert.equal(first.querySelector('#accounts-flow-token').value,'');
  const second=await open(document,'tenant-b');
  resolveConnection(response(config('tenant-a',{flow:{enabled:false,model:'wrong-tenant-model'}})));
  await nextTurn();await nextTurn();
  assert.equal(document.getElementById('accounts-flow-form'),second);
  assert.equal(second.dataset.tenant,'tenant-b');assert.equal(second.elements.flowModel.value,'model-one');
});

test('disabled Flow can be saved while no GitHub connection or catalogue is available',async t=>{
  const empty=config('tenant-a',{version:0,flow:{enabled:false,model:null},connection:{configured:false,models:[],message:'尚未配置连接。'}});
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/flow?tenant=tenant-a')return response(empty);
    if(call.path==='/api/platform/flow')return response({...empty,version:1});
    throw Error(call.path);
  });
  const form=await open(document);assert.equal(form.elements.flowModel.disabled,true);
  submit(window,form);await until(()=>!document.getElementById('accounts-flow-form'));
  assert.deepEqual(calls.find(call=>call.path==='/api/platform/flow').body,{tenantId:'tenant-a',version:0,enabled:false,model:null});
});
