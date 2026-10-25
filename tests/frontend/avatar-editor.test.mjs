import {projectRoot,browserSources} from '../../scripts/lib/project-paths.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {safeAvatarUrl} from '../../src/ui/avatar-editor.js';

const bundle=(await build({absWorkingDir:projectRoot,entryPoints:[browserSources['accounts-ui.js']],bundle:true,write:false,format:'iife',globalName:'AccountModule',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const owner={id:'owner-a',name:'厨房负责人',tenantId:'tenant-a',storeId:null,role:'admin',accountRole:'owner',status:'active',avatarUrl:'/api/account-avatar?account=owner-a&v=2',avatarVersion:2};
const member={id:'member-a',name:'管理员甲',username:'person_a',tenantId:'tenant-a',storeId:null,role:'admin',accountRole:'member',status:'active',avatarUrl:null,avatarVersion:0};
const organization={tenantId:'tenant-a',name:'厨房甲',avatarUrl:'/api/organization-avatar?tenant=tenant-a&v=3',avatarVersion:3};
const kitchenTeam={organization,accounts:[owner,member],stores:[{id:'store-a',name:'门店甲'}],storeId:null,canManage:true,limit:3};
async function until(condition){for(let attempt=0;attempt<100;attempt++){if(condition())return;await nextTurn();}assert.fail('UI did not settle');}
async function fixture(t,{principal={...owner,userId:owner.id,displayName:owner.name},route}={}){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<div id="app"></div><div id="overlay-root"></div>',{url:'https://accounts.test/?page=team',runScripts:'outside-only',virtualConsole:console});
  t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);});
  const {window}=dom,document=window.document;window.eval(bundle);
  const calls=[],changes=[];let ui;
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const button=(label,action,type='secondary',extra='')=>`<button class="btn btn-${type}" data-action="${action}" ${extra}>${label}</button>`;
  const render=()=>{document.getElementById('app').innerHTML=ui.page();};
  const request=async(path,body)=>{calls.push({path,body});if(route)return route(path,body);if(path.startsWith('/api/team/list'))return structuredClone(kitchenTeam);throw new Error(path);};
  const closeOverlay=()=>{ui.onOverlayClose();document.getElementById('overlay-root').innerHTML='';};
  ui=window.AccountModule.createAccountsUI({principal,request,escape:esc,icon:()=>'<svg></svg>',button,render,closeOverlay,toast(){},onProfileChange:data=>changes.push(data),modal(title,body,footer='',id=''){ui.onOverlayClose();document.getElementById('overlay-root').innerHTML=`<section class="modal" role="dialog"><h2>${title}</h2><form id="${id}">${body}${footer}</form></section>`;}});
  render();await until(()=>document.querySelector('.accounts-context'));
  return {ui,principal,window,document,calls,changes,render};
}

test('avatar sources accept only authenticated app image routes',()=>{
  assert.equal(safeAvatarUrl('/api/account-avatar?account=person&v=1'),'/api/account-avatar?account=person&v=1');
  assert.equal(safeAvatarUrl('/api/organization-avatar?tenant=kitchen&v=0'),'/api/organization-avatar?tenant=kitchen&v=0');
  for(const url of ['https://elsewhere.test/photo.png','data:image/svg+xml;base64,eA==','//elsewhere.test/a','/api/account-avatar?token=secret','/api/account-avatar?account=a&callback=x','/api/images/anything'])assert.equal(safeAvatarUrl(url),'');
});

test('management team separates organization and personal portraits and cannot switch stores from a dropdown',async t=>{
  const {document,ui,calls}=await fixture(t);
  assert.equal(document.querySelector('#accounts-store'),null);
  assert.equal(document.querySelectorAll('[data-action="accounts-person-avatar"]').length,2);
  assert.equal(document.querySelector('[data-action="accounts-organization-avatar"] img').getAttribute('src'),organization.avatarUrl);
  assert.equal(document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"] img').getAttribute('src'),owner.avatarUrl);
  assert.equal(ui.handleChange({id:'accounts-store',value:'store-a'}),false);
  assert.equal(calls.filter(call=>call.path.includes('store=')).length,0);
  ui.openStoreTeam('store-a');await nextTurn();ui.openOwnTeam();await until(()=>document.querySelector('.accounts-context'));
  assert.equal(calls.at(-1).path,'/api/team/list?');
});

test('avatar removal uses a dedicated versioned endpoint and preserves credential forms and session identity',async t=>{
  const {document,ui,calls,changes,principal}=await fixture(t,{route:(path,body)=>{
    if(path.startsWith('/api/team/list'))return structuredClone(kitchenTeam);
    if(path==='/api/team/avatar'){assert.deepEqual(JSON.parse(JSON.stringify(body)),{accountId:'owner-a',version:2,image:null});return {ok:true,account:{id:'owner-a',avatarUrl:null,avatarVersion:3}};}
    throw Error(path);
  }});
  await ui.handleAction('accounts-person-avatar',document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"]'));
  const form=document.querySelector('#accounts-avatar-form');assert.ok(form);
  assert.equal(form.querySelector('input[type="password"]'),null);
  await ui.handleAction('accounts-avatar-remove',{});await ui.handleSubmit(form);
  assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(principal.avatarUrl,null);assert.equal(principal.avatarVersion,3);
  assert.equal(principal.accountRole,'owner');assert.equal(principal.userId,'owner-a');
  assert.ok(changes.some(change=>change.account?.avatarVersion===3));assert.equal(calls.filter(call=>call.path==='/api/team/avatar').length,1);
  assert.equal(calls.some(call=>/profile|logout/.test(call.path)),false);
});

test('organization avatar removal is independent and stale saves retain the preview for retry',async t=>{
  const {document,ui,calls}=await fixture(t,{route:(path)=>{
    if(path.startsWith('/api/team/list'))return structuredClone(kitchenTeam);
    if(path==='/api/organization/avatar')throw Object.assign(new Error('conflict'),{status:409});
    throw Error(path);
  }});
  await ui.handleAction('accounts-organization-avatar',{dataset:{}});const form=document.querySelector('#accounts-avatar-form');
  assert.equal(form.querySelector('h2'),null);await ui.handleAction('accounts-avatar-remove',{});await ui.handleSubmit(form);
  assert.match(form.querySelector('[role="alert"]').textContent,/已被更新/);assert.equal(form.querySelector('[type="submit"]').disabled,false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).body)),{tenantId:'tenant-a',version:3,image:null});
  assert.equal(document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"] img').getAttribute('src'),owner.avatarUrl);
});

test('ordinary administrators can edit only their own personal avatar',async t=>{
  const {document,ui}=await fixture(t,{principal:{...member,userId:member.id,displayName:member.name},route:path=>path.startsWith('/api/team/list')?structuredClone({...kitchenTeam,canManage:false}):Promise.reject(Error(path))});
  assert.equal(document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"]'),null);
  assert.ok(document.querySelector('[data-action="accounts-person-avatar"][data-id="member-a"]'));
  assert.equal(document.querySelector('[data-action="accounts-organization-avatar"]'),null);
  ui.openOrganizationAvatar({tenantId:'tenant-a',name:'厨房甲'});assert.equal(document.querySelector('[role="dialog"]'),null);
});

test('a selected photo stays local until its square crop is applied and explicitly saved',async t=>{
  const calls=[];
  const {document,window,ui}=await fixture(t,{route:(path,body)=>{
    if(path.startsWith('/api/team/list'))return structuredClone(kitchenTeam);
    calls.push({path,body});return {ok:true,account:{id:'owner-a',avatarUrl:'/api/account-avatar?account=owner-a&v=3',avatarVersion:3}};
  }});
  window.URL.createObjectURL=()=> 'blob:test-avatar';window.URL.revokeObjectURL=()=>{};
  window.Image=class {constructor(){this.naturalWidth=640;this.naturalHeight=320;}decode(){return Promise.resolve();}};
  const draws=[];window.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},drawImage(...args){draws.push(args);}});
  const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV6kAAAAASUVORK5CYII=';
  window.HTMLCanvasElement.prototype.toDataURL=()=>data;
  await ui.handleAction('accounts-person-avatar',document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"]'));
  const form=document.querySelector('#accounts-avatar-form'),input=form.querySelector('input[type="file"]');
  Object.defineProperty(input,'files',{configurable:true,value:[new window.File(['synthetic'], 'photo.png',{type:'image/png'})]});
  input.dispatchEvent(new window.Event('change',{bubbles:true}));
  await until(()=>!form.querySelector('#avatar-crop').hidden);
  assert.equal(calls.length,0);assert.equal(form.querySelector('[type="submit"]').disabled,true);
  const draw=draws.at(-1);assert.equal(draw[3],draw[4],'source crop is square');assert.equal(draw[7],draw[8],'output crop is square');
  await ui.handleAction('accounts-avatar-apply-crop',{dataset:{}});assert.equal(form.querySelector('#avatar-crop').hidden,true);
  assert.equal(form.querySelector('[type="submit"]').disabled,false);assert.equal(calls.length,0);
  await ui.handleSubmit(form);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/team/avatar');assert.equal(calls[0].body.image,data);
  assert.equal(document.querySelector('[data-action="accounts-person-avatar"][data-id="owner-a"] img').getAttribute('src'),'/api/account-avatar?account=owner-a&v=3');
});
