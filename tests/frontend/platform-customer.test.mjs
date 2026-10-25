import {projectRoot,browserSources} from '../../scripts/lib/project-paths.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createAccountsUI} from '../../src/features/accounts/accounts-ui.js';

const bundle=(await build({absWorkingDir:projectRoot,entryPoints:[browserSources['platform-app.js']],bundle:true,write:false,format:'esm',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const kitchens=[{id:'tenant-a',name:'测试厨房甲',owner_name:'负责人甲',contact:'000-0000',active:1,seats:1,plan:'标准版'},{id:'tenant-b',name:'测试厨房乙',owner_name:'负责人乙',active:1,seats:0}];
const owner=(id,role='store')=>({id,name:'测试负责人',accountRole:'owner',role,status:'active',hasMaster:true,hasPassword:false,credentialType:'master-code',version:1});
const member=(id,role='store',extra={})=>({id,name:'测试员工 '+id,username:'test_'+id,loginId:'test_'+id,contact:'000-1111',status:'active',accountRole:'member',role,hasPassword:true,credentialType:'password',version:4,lastLogin:1760000000,...extra});
const customer=(tenant='tenant-a')=>({customer:{id:tenant,name:kitchens.find(row=>row.id===tenant).name,ownerName:'厨房负责人',contact:'000-9999',active:1,plan:'测试方案',expiresOn:'2027-10-20'},managementAccounts:[owner('kitchen-owner','admin'),member('kitchen-member','admin')],stores:[{id:'store-a',name:'测试门店甲',city:'东京',prefecture:'東京都',municipality:'千代田区',ward:'神田',addressDetail:'1-2-3 测试大厦',address:'東京都 千代田区 神田 1-2-3 测试大厦',phone:'000-0001',contact:'门店联系人',route:'东线',imageUrl:'/api/platform/store-image?tenant='+tenant+'&store=store-a',hasMaster:true,accounts:[owner('store-owner'),member('store-member'),member('disabled-member','store',{status:'disabled'})]},{id:'store-deleted',name:'已删除测试门店',address:'旧地址',deletedAt:1760000000,hasMaster:true,accounts:[owner('deleted-owner'),member('deleted-member')]}]});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const clone=value=>structuredClone(value);
async function until(check,label='UI did not settle'){for(let i=0;i<100;i++){if(check())return;await nextTurn();}assert.fail(label);}
async function fixture(t,route=()=>{throw Error('Unexpected route');}){
  const errors=[],calls=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<div id="app"></div><div id="overlay-root"></div><div id="toast-container"></div>',{url:'https://accounts.example.test/?login=platform',runScripts:'outside-only',virtualConsole:console});
  t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);});const {window}=dom;
  window.__KURAFLOW_ACCOUNT_PRINCIPAL__={role:'platform',accountRole:'owner',tenantId:null,storeId:null,displayName:'测试平台'};
  window.fetch=async(path,options={})=>{if(String(path)==='/api/flow/status')return response({enabled:false,available:false});if(String(path).startsWith('/api/notifications?'))return response({items:[],unreadCount:0,latestId:0,hasMore:false});const call={path:String(path),method:options.method||'GET',body:options.body===undefined?undefined:JSON.parse(options.body),options};calls.push(call);if(call.path==='/api/platform/kitchens')return response({kitchens:clone(kitchens)});return route(call);};
  await window.eval(`(async()=>{${bundle}\n})()`);await until(()=>window.document.querySelector('[data-action="accounts-kitchen-customer"]'));
  return {window,document:window.document,calls};
}
function click(document,selector){const el=document.querySelector(selector);assert.ok(el,selector);el.click();return el;}
async function open(document,id='tenant-a'){click(document,`[data-action="accounts-kitchen-customer"][data-tenant="${id}"]`);await until(()=>document.querySelector('.customer-heading'));assert.equal(document.querySelector('[data-tab="admins"]').getAttribute('aria-selected'),'true');assert.equal(document.querySelector('[data-tab="admins"]').textContent,'员工管理');assert.match(document.querySelector('[data-tab="stores"]').textContent,/合作门店/);click(document,'[data-tab="stores"]');}
function change(window,input,value){input.checked=value;input.dispatchEvent(new window.Event('change',{bubbles:true}));}
function submit(window,form){const event=new window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
function resetForm(document,accountId='store-member'){click(document,`[data-action="accounts-customer-password"][data-id="${accountId}"]`);const form=document.getElementById('accounts-customer-password-form');assert.ok(form);return form;}
function fill(form,password,confirm=password){form.elements.password.value=password;form.elements.confirmPassword.value=confirm;}

test('customer detail renders saved store fields and scoped accounts without bulk owner-code requests',async t=>{
  const {window,document,calls}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());throw Error(call.path);});
  assert.equal(calls.length,1);await open(document);
  const text=document.querySelector('#customer-panel').textContent;
  for(const value of ['测试门店甲','東京都 千代田区 神田 1-2-3 测试大厦','000-0001','门店联系人','东线','test_store-member','密码已设置','负责人码登录，无密码'])assert.ok(text.includes(value),value);
  assert.equal(document.querySelectorAll('.customer-store-details dt').length,5,'one complete address avoids duplicated address components');
  assert.equal(document.querySelectorAll('[data-customer-store]').length,1);
  assert.equal(document.querySelector('.customer-store-image').getAttribute('src'),'/api/platform/store-image?tenant=tenant-a&store=store-a');
  assert.equal(document.querySelector('#customer-panel').textContent.includes('test_kitchen-member'),false);
  assert.equal(calls.some(call=>call.path==='/api/team/master-key'),false);
  click(document,'[data-action="accounts-customer-tab"][data-tab="admins"]');
  assert.match(document.querySelector('#customer-panel').textContent,/test_kitchen-member/);
  assert.doesNotMatch(document.querySelector('#customer-panel').textContent,/test_store-member/);
  assert.equal(calls.length,2,'tab changes reuse the scoped data');
  assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  assert.equal(window.location.search,'?login=platform');
});

test('owner codes load only on request and deleted store controls stay disabled',async t=>{
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());
    if(call.path==='/api/team/master-key')return response({account:owner('store-owner'),masterCode:'TEST-ONLY-0000-0001'});throw Error(call.path);
  });await open(document);
  change(window,document.getElementById('accounts-customer-deleted'),true);
  assert.equal(document.querySelectorAll('[data-customer-store]').length,2);
  assert.equal(document.querySelector('[data-action="accounts-customer-key"][data-store="store-deleted"]').disabled,true);
  assert.equal(document.querySelector('[data-action="accounts-customer-password"][data-id="deleted-member"]').disabled,true);
  click(document,'[data-action="accounts-customer-key"][data-store="store-a"]');await until(()=>document.getElementById('account-master-code'));
  assert.deepEqual(calls.find(call=>call.path==='/api/team/master-key').body,{tenantId:'tenant-a',storeId:'store-a'});
  assert.equal(document.getElementById('account-master-code').value,'TEST-ONLY-0000-0001');
  assert.equal(document.querySelector('[data-action="accounts-master-reset-confirm"]'),null);
});

test('password reset validates empty and mismatched inputs and posts only one explicit versioned target',async t=>{
  let resolveReset;const pending=new Promise(resolve=>{resolveReset=resolve;});
  const {window,document,calls}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());if(call.path==='/api/platform/staff/password')return pending;throw Error(call.path);});await open(document);
  const form=resetForm(document),firstPassword=form.elements.password;
  assert.equal(firstPassword.type,'password');assert.equal(firstPassword.getAttribute('value'),null);assert.equal(firstPassword.autocomplete,'new-password');
  submit(window,form);await until(()=>form.querySelector('.accounts-form-error').textContent&&!form.querySelector('[type=submit]').disabled);assert.equal(calls.some(call=>call.path==='/api/platform/staff/password'),false);
  fill(form,'Synthetic-test-password','different-password');submit(window,form);await nextTurn();assert.match(form.querySelector('.accounts-form-error').textContent,/不一致/);assert.equal(calls.length,2);
  fill(form,'Synthetic-test-password');submit(window,form);submit(window,form);
  const writes=calls.filter(call=>call.path==='/api/platform/staff/password');assert.equal(writes.length,1);
  assert.deepEqual(writes[0].body,{tenantId:'tenant-a',storeId:'store-a',accountId:'store-member',version:4,password:'Synthetic-test-password'});
  assert.equal(firstPassword.value,'');assert.equal(form.elements.confirmPassword.value,'');assert.equal(form.innerHTML.includes('Synthetic-test-password'),false);
  resolveReset(response({ok:true,account:member('store-member','store',{version:5})}));await until(()=>!document.getElementById('accounts-customer-password-form'));
  assert.equal(firstPassword.value,'');assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  assert.equal(window.location.search,'?login=platform');
});

test('management administrator reset uses null store scope and disabled status remains visible',async t=>{
  const {window,document,calls}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());if(call.path==='/api/platform/staff/password')return response({ok:true,account:member('kitchen-member','admin',{version:5})});throw Error(call.path);});await open(document);
  assert.match(document.querySelector('[data-id="disabled-member"]').closest('.customer-account-row').textContent,/已停用/);
  click(document,'[data-tab="admins"]');const form=resetForm(document,'kitchen-member');fill(form,'Synthetic-test-password');submit(window,form);await until(()=>!document.getElementById('accounts-customer-password-form'));
  assert.deepEqual(calls.find(call=>call.path==='/api/platform/staff/password').body,{tenantId:'tenant-a',storeId:null,accountId:'kitchen-member',version:4,password:'Synthetic-test-password'});
});

test('conflicts require explicit metadata refresh and never resubmit to another account',async t=>{
  let reads=0,writes=0;
  const {window,document,calls}=await fixture(t,call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a'){const data=customer();if(reads++)data.stores[0].accounts[1].version=9;return response(data);}
    if(call.path==='/api/platform/staff/password'){if(!writes++)return response({error:'账号已修改，请刷新。'},409);return response({ok:true,account:member('store-member','store',{version:10})});}throw Error(call.path);
  });await open(document);const form=resetForm(document);fill(form,'Synthetic-test-password');submit(window,form);await until(()=>form.querySelector('.accounts-form-error').textContent.includes('已修改'));
  assert.equal(form.elements.password.value,'');assert.equal(form.querySelector('[data-action="accounts-customer-password-refresh"]').hidden,false);
  fill(form,'Synthetic-next-password');submit(window,form);await nextTurn();assert.equal(writes,1);
  click(document,'[data-action="accounts-customer-password-refresh"]');await until(()=>form.querySelector('.accounts-form-error').textContent.includes('账号已更新'));
  fill(form,'Synthetic-next-password');submit(window,form);await until(()=>!document.getElementById('accounts-customer-password-form'));
  assert.deepEqual(calls.filter(call=>call.path==='/api/platform/staff/password').map(call=>[call.body.accountId,call.body.version]),[['store-member',4],['store-member',9]]);
});

test('closing/replacing password reset clears secrets and ignores a previous pending response',async t=>{
  let resolveReset;const pending=new Promise(resolve=>{resolveReset=resolve;});
  const {window,document}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());if(call.path==='/api/platform/staff/password')return pending;throw Error(call.path);});await open(document);
  const oldForm=resetForm(document);fill(oldForm,'Synthetic-test-password');submit(window,oldForm);
  click(document,'.modal-header [data-action="close"]');assert.equal(oldForm.elements.password.value,'');
  const current=resetForm(document,'disabled-member');fill(current,'Synthetic-unsent-password');
  resolveReset(response({ok:true,account:member('store-member','store',{version:5})}));await nextTurn();await nextTurn();
  assert.equal(document.getElementById('accounts-customer-password-form'),current);assert.equal(current.elements.password.value,'Synthetic-unsent-password');
  click(document,'.modal-header [data-action="close"]');assert.equal(current.elements.password.value,'');assert.equal(current.elements.confirmPassword.value,'');
});

test('failed password reset cannot reflect the submitted secret in error markup',async t=>{
  const {window,document}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());if(call.path==='/api/platform/staff/password')return response({error:'Rejected Synthetic-test-password'},400);throw Error(call.path);});await open(document);
  const form=resetForm(document);fill(form,'Synthetic-test-password');submit(window,form);await until(()=>form.querySelector('.accounts-form-error').textContent);
  assert.doesNotMatch(form.innerHTML,/Synthetic-test-password/);assert.match(form.querySelector('.accounts-form-error').textContent,/已隐藏/);
});

test('stale customer request does not replace a subsequently selected kitchen',async t=>{
  let resolveFirst;const pending=new Promise(resolve=>{resolveFirst=resolve;});
  const {document}=await fixture(t,call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return pending;if(call.path==='/api/platform/customer?tenant=tenant-b')return response(customer('tenant-b'));throw Error(call.path);});
  click(document,'[data-action="accounts-kitchen-customer"][data-tenant="tenant-a"]');await nextTurn();
  click(document,'[data-action="platform-kitchens"]');await until(()=>document.querySelector('[data-action="accounts-kitchen-customer"][data-tenant="tenant-b"]'));
  await open(document,'tenant-b');resolveFirst(response(customer()));await nextTurn();await nextTurn();
  assert.equal(document.querySelector('.customer-heading h1').textContent,'测试厨房乙');
});

test('customer support handlers do not expose platform operations to management/store principals',async()=>{
  for(const role of ['admin','store']){
    const calls=[];
    const ui=createAccountsUI({principal:{role,accountRole:'owner',tenantId:'tenant-a',storeId:role==='store'?'store-a':null},request:async(...args)=>{calls.push(args);return {};},escape:String,button:()=>'',icon:()=>'',modal:()=>{throw Error('customer modal must not open');},closeOverlay:()=>{},render:()=>{},toast:()=>{}});
    await ui.handleAction('accounts-kitchen-customer',{dataset:{tenant:'tenant-a'}});
    await ui.handleAction('accounts-customer-key',{dataset:{store:'store-a'}});
    await ui.handleAction('accounts-customer-password',{dataset:{id:'store-member',store:'store-a'}});
    assert.deepEqual(calls,[]);
  }
});
