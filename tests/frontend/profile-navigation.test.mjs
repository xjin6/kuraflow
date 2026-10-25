import {projectRoot,browserSources} from '../../scripts/lib/project-paths.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';

const root=projectRoot;
const bundles=await Promise.all(['app.js','platform-app.js'].map(async entry=>(await build({
  absWorkingDir:root,entryPoints:[browserSources[entry]],bundle:true,write:false,format:'iife',target:'es2022',logLevel:'silent',
  plugins:[{name:'synthetic-business-data',setup(builder){builder.onResolve({filter:/business-data\.js$/},()=>({path:fileURLToPath(new URL('../../src/shared/cloud-seed.js',import.meta.url))}));}}],
})).outputFiles[0].text));
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const principal=(changes={})=>({id:'person-owner',userId:'person-owner',role:'admin',accountRole:'owner',tenantId:'tenant-test',storeId:null,displayName:'测试负责人',name:'测试负责人',avatarUrl:'/api/account-avatar?account=person-owner&v=2',avatarVersion:2,organizationAvatarUrl:'/api/organization-avatar?tenant=tenant-test&v=4',organizationAvatarVersion:4,...changes});
const makeState=()=>({version:2,products:[],stores:[{id:'store-a',name:'测试门店',contact:'店长',city:'大阪市',address:'大阪市テスト1-1',phone:'000-0000-0000'}],orders:[],documents:[],prices:{},quoteMeta:{},unitQuotes:{},inventory:{},storeAllocations:{},reminders:[],manualTasks:[],priceHistory:[],materialSummary:{},settings:{companyName:'测试厨房',currency:'JPY',language:'zh-CN'},cart:{},cartUnits:{},activeStoreId:'store-a'});
async function until(condition,label='the UI did not settle'){
  for(let i=0;i<100;i++){if(condition())return;await nextTurn();}
  assert.fail(label);
}
function click(document,selector){const node=document.querySelector(selector);assert.ok(node,selector);node.click();return node;}
async function fixture(t,{platform=false,url='https://profile.example.test/?page=overview',person=principal()}={}){
  const errors=[],calls=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="overlay-root"></div><div id="toast-container"></div>',{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const {window}=dom,state=makeState();
  window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  window.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  window.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.__KURAFLOW_FLOW_ENABLED__=false;
  if(platform)window.__KURAFLOW_ACCOUNT_PRINCIPAL__=person;
  else window.__KURAFLOW_SESSION__={principal:person,state,revision:1};
  window.fetch=async(path,options={})=>{
    const route=String(path),body=options.body?JSON.parse(options.body):undefined;calls.push({path:route,body});
    if(route.startsWith('/api/notifications'))return response({items:[],unreadCount:0,through:0,hasMore:false});
    if(route==='/api/state')return response({principal:person,state,revision:1});
    if(route==='/api/flow/status')return response({enabled:false,managed:true,connected:false});
    if(route==='/api/platform/kitchens')return response({kitchens:[{id:'tenant-test',name:'测试厨房',owner_name:'测试负责人',active:1,seats:0,avatarUrl:null,avatarVersion:0}]});
    if(route.startsWith('/api/team/list?')){
      const params=new URL(route,'https://profile.example.test').searchParams,storeId=params.get('store')||null;
      return response({organization:{tenantId:'tenant-test',name:'测试厨房',avatarUrl:person.organizationAvatarUrl||null,avatarVersion:person.organizationAvatarVersion||0},accounts:[{id:storeId?'store-owner':person.userId,name:storeId?'店长':person.displayName,role:storeId?'store':'admin',accountRole:'owner',tenantId:'tenant-test',storeId,status:'active',avatarUrl:storeId?null:person.avatarUrl,avatarVersion:storeId?0:person.avatarVersion}],stores:state.stores,storeId,canManage:person.accountRole==='owner',needsSetup:false,limit:3});
    }
    if(route==='/api/admin/store-code')return response({storeId:'store-a',accessCode:'TEST-ONLY-CODE-0001'});
    throw new Error('Unexpected test request '+route);
  };
  t.after(()=>{window.close();assert.deepEqual(errors,[],'the shell must not raise DOM exceptions or navigate natively');});
  window.eval(bundles[platform?1:0]);
  await until(()=>window.document.querySelector('.sidebar-profile'));
  return {window,document:window.document,calls};
}

test('management uses a list icon and the personal footer opens its own employee scope',async t=>{
  const {document,calls,window}=await fixture(t);
  const todo=document.querySelector('.nav-list [data-page="tasks"]');assert.ok(todo);
  assert.equal(todo.querySelectorAll('svg circle').length,3,'the todo navigation uses bullet markers');
  assert.equal(document.querySelector('.nav-list [data-page="team"]'),null);
  const footer=document.querySelector('.sidebar-footer [data-action="open-own-team"]');
  assert.equal(footer.tagName,'BUTTON');assert.ok(footer.getAttribute('aria-label'));
  assert.equal(footer.querySelector('img').getAttribute('src'),'/api/account-avatar?account=person-owner&v=2');
  assert.equal(document.querySelector('.workspace-avatar img').getAttribute('src'),'/api/organization-avatar?tenant=tenant-test&v=4');
  click(document,'.sidebar-footer [data-action="open-own-team"]');
  await until(()=>document.querySelector('.accounts-table'));
  assert.equal(window.location.search,'?page=team');
  assert.equal(document.querySelector('#accounts-store'),null,'the management employee page cannot switch to stores');
  const reads=calls.filter(call=>call.path.startsWith('/api/team/list?'));
  assert.ok(reads.length);assert.ok(reads.every(call=>!new URL(call.path,window.location.origin).searchParams.has('store')));
});

test('management store cards omit employee management while the personal footer remains available',async t=>{
  const {document}=await fixture(t,{url:'https://profile.example.test/?page=stores&tab=stores'});
  const card=document.querySelector('.store-card[data-store-card="store-a"]');assert.ok(card);
  assert.equal(document.querySelector('[data-action="manage-store-team"][data-id="store-a"]'),null,'store cards do not expose employee management');
  assert.equal(card.querySelector('.store-city').textContent,'大阪市テスト1-1');
  assert.equal([...card.querySelectorAll('.store-card-info > div > span')].some(node=>node.textContent==='配送地址'),false);
  const footerActions=[...document.querySelectorAll('.store-card-footer [data-action]')].map(node=>node.dataset.action);
  assert.deepEqual(footerActions,['edit-store','store-settlement','store-prices']);
  assert.ok(document.querySelector('.sidebar-footer button[data-action="open-own-team"]'));
  await nextTurn();
});

test('ordinary management members keep their personal entry without store staff or kitchen-avatar controls',async t=>{
  const {document}=await fixture(t,{url:'https://profile.example.test/?page=stores&tab=stores',person:principal({userId:'member-one',id:'member-one',accountRole:'member',displayName:'测试员工',avatarUrl:null,avatarVersion:0})});
  assert.equal(document.querySelector('[data-action="manage-store-team"]'),null);
  assert.equal(document.querySelector('[data-action="organization-avatar"]'),null);
  assert.ok(document.querySelector('.sidebar-footer button[data-action="open-own-team"]'));
  assert.equal(document.querySelector('.topbar button[data-action="open-own-team"]'), null);
});

test('platform retains customer employee support and its personal footer opens an avatar editor',async t=>{
  const person=principal({role:'platform',tenantId:null,organizationAvatarUrl:null,organizationAvatarVersion:0});
  const {document}=await fixture(t,{platform:true,url:'https://profile.example.test/?login=platform',person});
  await until(()=>document.querySelector('[data-action="accounts-kitchen-team"]'));
  assert.ok(document.querySelector('.nav-list [data-action="platform-stores"]'));
  assert.equal(document.querySelector('.nav-list [data-action="platform-team"]'),null);
  const footer=document.querySelector('.sidebar-footer [data-action="platform-personal-avatar"]');assert.equal(footer.tagName,'BUTTON');
  assert.equal(footer.querySelector('img').getAttribute('src'),person.avatarUrl);
  footer.click();
  await until(()=>document.querySelector('#accounts-avatar-form'));
  assert.equal(document.querySelector('#modal-title').textContent,'个人头像');
  assert.equal(document.querySelector('#account-avatar-file').accept,'image/png,image/jpeg,image/webp');
});
