import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';

const root=fileURLToPath(new URL('../',import.meta.url));
const [platformBundle,accountsBundle]=await Promise.all(['platform-app.js','accounts-ui.js'].map(async entry=>(await build({
  absWorkingDir:root,entryPoints:[entry],bundle:true,write:false,format:'iife',globalName:entry==='accounts-ui.js'?'AccountsModule':undefined,target:'es2022',logLevel:'silent',
})).outputFiles[0].text));
const origin='https://platform-refinements.example.test';
const kitchens=[
  {id:'tenant-a',name:'测试厨房甲',owner_name:'负责人甲',contact:'000-1000',active:1,seats:1,plan:'标准版'},
  {id:'tenant-b',name:'测试厨房乙',owner_name:'负责人乙',contact:'000-2000',active:1,seats:1,plan:'标准版'},
];
const account=(id,role='admin',accountRole='member',extra={})=>({
  id,tenantId:'tenant-a',storeId:role==='store'?'store-a':null,role,accountRole,name:id==='kitchen-owner'?'厨房负责人':'人员 '+id,
  username:accountRole==='member'?'user_'+id:null,loginId:accountRole==='member'?'user_'+id:null,contact:'000-1111',status:'active',
  version:4,deletedAt:null,avatarUrl:null,avatarVersion:0,hasPassword:accountRole==='member',hasMaster:accountRole==='owner',...extra,
});
const customer=(tenantId='tenant-a')=>{
  const second=tenantId==='tenant-b',suffix=second?'b':'a',storeId='store-'+suffix;
  return {
    customer:{id:tenantId,name:second?'测试厨房乙':'测试厨房甲',ownerName:second?'负责人乙':'负责人甲',contact:'000-1000',active:true,plan:'标准版',avatarUrl:null,avatarVersion:0},
    managementAccounts:[account('kitchen-owner','admin','owner',{tenantId}),account('kitchen-member','admin','member',{tenantId})],
    stores:[{id:storeId,name:second?'乙厨房门店':'甲厨房门店',contact:'门店联系人',phone:'000-3333',route:'配送东线',city:'千代田区',prefecture:'東京都',municipality:'千代田区',ward:'神田',addressDetail:'1-2-3 测试大厦',address:'東京都 千代田区 神田 1-2-3 测试大厦',hasMaster:true,accounts:[
      account('store-owner','store','owner',{tenantId,storeId}),account('store-member','store','member',{tenantId,storeId}),
    ]}],
  };
};
const platformPrincipal={id:'platform-owner',userId:'platform-owner',role:'platform',accountRole:'owner',tenantId:null,storeId:null,displayName:'测试平台',avatarUrl:null,avatarVersion:0};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data)});
async function until(check,message='UI did not settle'){
  for(let index=0;index<150;index++){if(check())return;await nextTurn();}
  assert.fail(message);
}
function click(document,selector){const node=document.querySelector(selector);assert.ok(node,selector);node.click();return node;}
function change(window,node,value){assert.ok(node);if(node.type==='checkbox')node.checked=value;else node.value=value;node.dispatchEvent(new window.Event('change',{bubbles:true}));}
function submit(window,form){const event=new window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
function action(document,name,id){return document.querySelector(`[data-action="${name}"][data-id="${id}"]`);}
function visibleAvatarAction(document,id){return [...document.querySelectorAll(`[data-action="accounts-customer-avatar"][data-id="${id}"]`)].find(node=>node.textContent.trim()==='编辑头像');}

async function fixture(t,{principal=platformPrincipal,controller=false,route=()=>{throw Error('Unexpected route');}}={}){
  const errors=[],calls=[],virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="overlay-root"></div><div id="toast-container"></div>',{url:origin+'/?login=platform',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  t.after(()=>{dom.window.close();assert.deepEqual(errors,[],'no DOM or native navigation errors');});
  const {window}=dom,document=window.document;
  const fetch=async(path,options={})=>{
    const call={path:String(path),method:options.method||'GET',body:options.body===undefined?undefined:JSON.parse(options.body)};calls.push(call);
    if(call.path==='/api/platform/kitchens')return response({kitchens});
    return route(call);
  };
  window.fetch=fetch;
  let accounts;
  if(controller){
    window.eval(accountsBundle);
    const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const button=(label,name,style='secondary',extra='')=>`<button type="button" class="btn btn-${style}" data-action="${name}" ${extra}>${label}</button>`;
    const render=()=>{document.getElementById('app').innerHTML=accounts.page();};
    const closeOverlay=()=>{accounts.onOverlayClose?.();document.getElementById('overlay-root').innerHTML='';};
    const request=async(path,body)=>{const result=await fetch(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});const data=await result.json();if(!result.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:result.status});return data;};
    accounts=window.AccountsModule.createAccountsUI({request,principal,escape:esc,button,icon:()=>'',render,toast(){},closeOverlay,modal(title,body,footer='',formId=''){
      accounts.onOverlayClose?.();document.getElementById('overlay-root').innerHTML=`<section class="modal" role="dialog"><h2>${title}</h2>${formId?`<form id="${formId}">${body}${footer}</form>`:body+footer}</section>`;
    }});
    document.addEventListener('click',async event=>{const node=event.target.closest('[data-action]');if(!node)return;event.preventDefault();if(node.dataset.action==='close')closeOverlay();else await accounts.handleAction(node.dataset.action,node);});
    document.addEventListener('change',event=>accounts.handleChange(event.target));
    document.addEventListener('submit',async event=>{event.preventDefault();await accounts.handleSubmit(event.target);});
    render();
  }else{
    window.__KURAFLOW_ACCOUNT_PRINCIPAL__=principal;window.eval(platformBundle);
  }
  await until(()=>document.querySelector(controller&&principal.role!=='platform'?'.accounts-table':'[data-action="accounts-kitchen-customer"]'));
  return {window,document,calls,accounts};
}
async function openStores(document){click(document,'.nav-list [data-action="platform-stores"]');await until(()=>document.querySelector('#accounts-store-tenant')&&document.querySelector('[data-customer-store]'));}

test('platform store management is the second menu and selects each kitchen without repeated address fields',async t=>{
  const {document,window,calls}=await fixture(t,{route:call=>{
    if(call.path.startsWith('/api/platform/customer?'))return response(customer(new URL(call.path,origin).searchParams.get('tenant')));
    throw Error(call.path);
  }});
  const navigation=[...document.querySelectorAll('.nav-list [data-action]')];
  assert.equal(navigation[1].dataset.action,'platform-stores');assert.equal(navigation[1].textContent.trim(),'门店管理');
  assert.equal(document.querySelector('.nav-list [data-action="platform-team"]'),null);
  await openStores(document);
  const card=document.querySelector('[data-customer-store="store-a"]');assert.ok(card);
  const address='東京都 千代田区 神田 1-2-3 测试大厦';
  assert.equal(card.textContent.split(address).length-1,1);
  assert.equal(card.textContent.split('1-2-3 测试大厦').length-1,1,'detail address is not repeated after the full address');
  assert.ok(card.textContent.includes('门店联系人'));assert.ok(card.textContent.includes('000-3333'));assert.ok(card.textContent.includes('配送东线'));
  const beforeWrites=calls.filter(call=>call.method==='POST').length;
  change(window,document.getElementById('accounts-store-tenant'),'tenant-b');
  await until(()=>document.querySelector('[data-customer-store="store-b"]'));
  assert.equal(document.querySelector('[data-customer-store="store-a"]'),null);
  assert.equal(document.getElementById('accounts-store-tenant').value,'tenant-b');
  assert.equal(calls.filter(call=>call.method==='POST').length,beforeWrites,'switching kitchens only reads the selected directory');
  assert.ok(calls.some(call=>call.path==='/api/platform/customer?tenant=tenant-b'));
});

test('a late kitchen directory response cannot replace the subsequently chosen kitchen',async t=>{
  let resolveA;const pendingA=new Promise(resolve=>{resolveA=resolve;});
  const {document,accounts,calls}=await fixture(t,{controller:true,route:call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a')return pendingA;
    if(call.path==='/api/platform/customer?tenant=tenant-b')return response(customer('tenant-b'));
    throw Error(call.path);
  }});
  accounts.openStores('tenant-a');await until(()=>calls.some(call=>call.path==='/api/platform/customer?tenant=tenant-a'));
  accounts.openStores('tenant-b');await until(()=>document.querySelector('[data-customer-store="store-b"]'));
  resolveA(response(customer('tenant-a')));await nextTurn();await nextTurn();
  assert.ok(document.querySelector('[data-customer-store="store-b"]'));assert.equal(document.querySelector('[data-customer-store="store-a"]'),null);
  assert.equal(document.getElementById('accounts-store-tenant').value,'tenant-b');
});

test('platform has explicit editable avatar actions for both kitchen owner and kitchen administrator',async t=>{
  const {document,calls}=await fixture(t,{route:call=>{if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());throw Error(call.path);}});
  click(document,'[data-action="accounts-kitchen-customer"][data-tenant="tenant-a"]');await until(()=>document.querySelector('.customer-heading'));
  click(document,'[data-action="accounts-customer-tab"][data-tab="admins"]');
  for(const id of ['kitchen-owner','kitchen-member']){
    const edit=visibleAvatarAction(document,id);assert.ok(edit,'visible avatar edit action for '+id);assert.equal(edit.disabled,false);edit.click();
    await until(()=>document.getElementById('accounts-avatar-form'));
    assert.match(document.querySelector('#accounts-avatar-form').textContent,new RegExp(id==='kitchen-owner'?'厨房负责人':'kitchen-member'));
    click(document,'.modal-header [data-action="close"]');
  }
  assert.equal(calls.some(call=>call.method==='POST'),false,'opening portrait editors does not modify credentials or upload an image');
  assert.equal(action(document,'accounts-staff-delete','kitchen-owner'),null,'owners cannot be deleted');
});

test('platform deletes and restores only the confirmed member using the displayed version',async t=>{
  const saved=customer();let finishDelete;
  const pendingDelete=new Promise(resolve=>{finishDelete=resolve;});
  const {document,window,calls}=await fixture(t,{route:call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a')return response(saved);
    if(call.path==='/api/team/delete')return pendingDelete;
    if(call.path==='/api/team/restore'){
      const row=saved.stores[0].accounts.find(item=>item.id==='store-member');Object.assign(row,{deletedAt:null,status:'disabled',version:6});
      return response({ok:true,account:row});
    }
    throw Error(call.path);
  }});
  await openStores(document);click(document,'[data-action="accounts-directory-view"][data-view="list"]');assert.equal(action(document,'accounts-staff-delete','store-owner'),null);
  action(document,'accounts-staff-delete','store-member').click();const form=document.getElementById('accounts-member-lifecycle-form');assert.ok(form);
  submit(window,form);submit(window,form);await until(()=>calls.some(call=>call.path==='/api/team/delete'));
  const deletes=calls.filter(call=>call.path==='/api/team/delete');assert.equal(deletes.length,1);assert.deepEqual(deletes[0].body,{accountId:'store-member',version:4});
  const row=saved.stores[0].accounts.find(item=>item.id==='store-member');Object.assign(row,{deletedAt:1761000000,status:'disabled',version:5});
  finishDelete(response({ok:true,account:row}));await until(()=>!document.getElementById('accounts-member-lifecycle-form')&&!action(document,'accounts-staff-delete','store-member'));
  assert.equal(document.querySelector('[data-customer-store="store-a"]').textContent.includes('user_store-member'),false);
  change(window,document.getElementById('accounts-archived'),true);
  const restore=action(document,'accounts-staff-restore','store-member');assert.ok(restore);
  const avatar=visibleAvatarAction(document,'store-member');assert.ok(!avatar||avatar.disabled,'archived people cannot have their avatar edited');
  restore.click();const restoreForm=document.getElementById('accounts-member-lifecycle-form');assert.ok(restoreForm);submit(window,restoreForm);
  await until(()=>!document.getElementById('accounts-member-lifecycle-form')&&calls.some(call=>call.path==='/api/team/restore'));
  assert.deepEqual(calls.find(call=>call.path==='/api/team/restore').body,{accountId:'store-member',version:5});
  assert.ok(document.querySelector('[data-customer-store="store-a"]').textContent.includes('user_store-member'));
  assert.equal(row.status,'disabled','restoring an account does not silently enable it or take an active seat');
});

test('a failed member deletion keeps its confirmation and saved member visible',async t=>{
  const saved=customer();
  const {document,window,calls}=await fixture(t,{route:call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a')return response(saved);
    if(call.path==='/api/team/delete')return response({error:'账号已变更，请刷新。',code:'ACCOUNT_CHANGED'},409);
    throw Error(call.path);
  }});
  await openStores(document);click(document,'[data-action="accounts-directory-view"][data-view="list"]');action(document,'accounts-staff-delete','store-member').click();const form=document.getElementById('accounts-member-lifecycle-form');
  submit(window,form);await until(()=>form.querySelector('[role="alert"]')?.textContent.includes('账号已变更'));
  assert.equal(document.getElementById('accounts-member-lifecycle-form'),form);
  assert.ok(document.querySelector('[data-customer-store="store-a"]').textContent.includes('user_store-member'));
  assert.equal(saved.stores[0].accounts[1].deletedAt,null);assert.equal(calls.filter(call=>call.path==='/api/team/delete').length,1);
});

test('management owner can remove members while ordinary administrators receive no deletion controls',async t=>{
  const ownerPrincipal={...account('kitchen-owner','admin','owner'),userId:'kitchen-owner',displayName:'厨房负责人'};
  const team={organization:{tenantId:'tenant-a',name:'测试厨房甲'},storeId:null,stores:[],canManage:true,limit:3,accounts:[account('kitchen-owner','admin','owner'),account('kitchen-member')]};
  const ownerCalls=[];
  const first=await fixture(t,{controller:true,principal:ownerPrincipal,route:call=>{
    if(call.path.startsWith('/api/team/list?'))return response(team);
    if(call.path==='/api/team/delete'){ownerCalls.push(call);Object.assign(team.accounts[1],{deletedAt:1761000000,status:'disabled',version:5});return response({ok:true,account:team.accounts[1]});}
    throw Error(call.path);
  }});
  assert.equal(action(first.document,'accounts-staff-delete','kitchen-owner'),null);
  action(first.document,'accounts-staff-delete','kitchen-member').click();const form=first.document.getElementById('accounts-member-lifecycle-form');
  await first.accounts.handleSubmit(form);assert.deepEqual(ownerCalls[0].body,{accountId:'kitchen-member',version:4});
  const memberPrincipal={...account('kitchen-member'),userId:'kitchen-member',displayName:'普通管理员'};
  const second=await fixture(t,{controller:true,principal:memberPrincipal,route:call=>{if(call.path.startsWith('/api/team/list?'))return response({...team,canManage:false,accounts:[account('kitchen-owner','admin','owner'),account('kitchen-member')]});throw Error(call.path);}});
  assert.equal(second.document.querySelector('[data-action="accounts-staff-delete"]'),null);
  assert.equal(second.document.querySelector('[data-action="accounts-staff-restore"]'),null);
});

test('directory cards keep full store accounts reachable without loading credentials or mutating records',async t=>{
  const {document,calls}=await fixture(t,{route:call=>{
    if(call.path==='/api/platform/customer?tenant=tenant-a')return response(customer());
    throw Error(call.path);
  }});
  click(document,'[data-action="accounts-customer-view"][data-view="card"]');
  assert.ok(document.querySelector('.stores-grid > .store-card[data-customer-card="tenant-a"]'));
  await openStores(document);
  const card=document.querySelector('.stores-grid > .store-card[data-customer-store="store-a"]');assert.ok(card);
  assert.equal(card.querySelector('.customer-account-list'),null);
  click(document,'[data-action="accounts-customer-store-detail"][data-store="store-a"]');
  const detail=document.querySelector('[role="dialog"]');assert.ok(detail);
  assert.match(detail.textContent,/user_store-member/);
  assert.ok(detail.querySelector('[data-action="accounts-customer-avatar"][data-id="store-owner"]'));
  assert.ok(detail.querySelector('[data-action="accounts-staff-delete"][data-id="store-member"]'));
  assert.equal(calls.some(call=>call.method==='POST'),false);
  assert.equal(calls.some(call=>call.path==='/api/team/master-key'),false);
  click(document,'[data-action="close"]');
  assert.ok(document.querySelector('.stores-grid > .store-card[data-customer-store="store-a"]'));
});
