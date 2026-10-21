import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {tokyoDate} from '../settlement-data.js';
import {shiftDay} from '../overview-data.js';

const bundle=(await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['tasks-ui.js'],bundle:true,write:false,format:'iife',globalName:'OverviewModule',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const analyticsBundle=(await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['overview-ui.js'],bundle:true,write:false,format:'iife',globalName:'AnalyticsModule',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const today=tokyoDate();
const order=(id,changes={})=>({id,storeId:'s1',date:today,deliveryDate:today,stage:'pending',items:[{productId:'p1',productName:'历史牛肉',qty:3,packed:0,price:120,unit:'袋'}],...changes});
const shortage=(text='缺货 2 袋')=>({type:'shortage',status:'open',reportedAt:'2026-10-20T00:00:00.000Z',text});
function fixture(t,{orders=[],products,stock={},demo=false,manualTasks=[],tab='system'}={}) {
  const dom=new JSDOM('<div id="app"></div><div id="overlay-root"></div>',{url:'http://localhost:4173/?page=tasks',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const {window}=dom,document=window.document;
  window.eval(bundle);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const model={state:{orders,manualTasks,products:products||[{id:'p1',name:'新名称牛肉',unit:'袋',active:true},{id:'p2',name:'豆腐',unit:'盒',active:true}]},getStore:id=>({id,name:'木屋烧烤'}),getProduct(id){return this.state.products.find(item=>item.id===id);},getProducts(){return this.state.products.filter(item=>!item.deletedAt&&item.active!==false);},getStock:id=>Object.hasOwn(stock,id)?stock[id]:null,
    addManualTask(value){const task={id:'todo-'+(this.state.manualTasks.length+1),...value,source:'manual',createdAt:today+'T01:00:00.000Z',completedAt:null,deletedAt:null};this.state.manualTasks.push(task);return task;},
    setManualTaskDone(id,done){const task=this.state.manualTasks.find(task=>task.id===id);assert.ok(task);task.completedAt=done?today+'T02:00:00.000Z':null;return task;},
    setManualTaskDueDate(id,dueDate){const task=this.state.manualTasks.find(task=>task.id===id);assert.ok(task);task.dueDate=dueDate;return task;}};
  const ui={role:'admin',taskTab:tab,businessRange:'month',businessMetric:'amount',businessDemo:demo};
  const icon=name=>`<span class="icon" aria-hidden="true" data-icon="${name}"><svg></svg></span>`;
  const button=(label,action,variant='secondary',extra='',ico='')=>`<button class="btn btn-${variant}" data-action="${action}" ${extra}>${ico?icon(ico):''}${label}</button>`;
  let overview;
  const render=()=>{document.getElementById('app').innerHTML=overview.page();};
  overview=window.OverviewModule.createTasksUI({model,ui,escape:esc,money:value=>'¥'+value,icon,button,render,nav(){},modal(title,body,footer,formId){document.getElementById('overlay-root').innerHTML=`<section role="dialog"><h2>${title}</h2>${formId?`<form id="${formId}">${body}${footer}</form>`:body+footer}</section>`;},closeOverlay(){document.getElementById('overlay-root').innerHTML='';},emptyState:title=>`<div class="empty-state">${title}</div>`});
  document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(el)overview.handleAction(el.dataset.action,el);});
  document.addEventListener('input',event=>overview.handleInput(event.target));
  render();
  return {window,document,model,ui,overview,render};
}
const tasks=document=>[...document.querySelectorAll('#app .business-todo-row')];
const ids=document=>tasks(document).map(row=>row.dataset.taskId);
const click=(document,selector)=>{const el=document.querySelector(selector);assert.ok(el,selector);el.click();};

test('system tasks present actionable work once per order and excludes normal delivery and future packing',t=>{
  const {document}=fixture(t,{orders:[order('pending'),order('shortage',{deliveryDate:shiftDay(today,-1),stage:'packing',items:[{productId:'p1',productName:'历史牛肉',qty:3,packed:0,packingNote:'缺货 2 袋',packingIssue:shortage()}]}),order('ready',{stage:'ready'}),order('driving',{stage:'delivering'}),order('future',{deliveryDate:shiftDay(today,1)}),order('done',{stage:'delivered'})]});
  assert.deepEqual(ids(document),['order:shortage','order:pending','order:ready']);
  assert.equal(document.querySelector('.business-tasks-total').textContent,'3');
  assert.equal(document.querySelectorAll('[data-task-id="order:shortage"]').length,1);
  assert.equal(document.querySelector('.business-tasks').textContent.includes('配送中'),false);
  assert.equal(document.querySelector('.business-tasks input[type="checkbox"]'),null);
  assert.equal(document.querySelector('[data-task-id="order:ready"] button').textContent,'安排配送');
});

test('packing shortages show saved product names and safe notes with a direct order action',t=>{
  const text='缺货 2 袋 <img src=x onerror=alert(1)>';
  const {document}=fixture(t,{orders:[order('o&1',{stage:'packing',items:[{productId:'p1',productName:'历史牛肉',qty:3,packed:0,packingNote:text,packingIssue:shortage(text)}]})]});
  const row=tasks(document)[0];
  assert.equal(row.dataset.taskSource,'system');
  assert.equal(row.querySelector('.business-task-source').textContent,'系统');
  assert.equal(row.querySelector('.business-task-description').textContent,'历史牛肉：'+text);
  assert.equal(row.querySelector('img'),null);
  const action=row.querySelector('button');
  assert.equal(action.dataset.action,'order-detail');assert.equal(action.dataset.id,'o&1');
  assert.equal(action.textContent,'处理异常');
  assert.match(action.getAttribute('aria-label'),/处理异常：木屋烧烤/);
});

test('task filters preserve focus and use actual deduplicated counts, including replenishment',t=>{
  const {document,ui}=fixture(t,{orders:[order('issue',{issue:'送货地址需核对'}),order('packing')],stock:{p2:2}});
  assert.equal(document.querySelector('[data-filter="all"] strong').textContent,'3');
  assert.equal(document.querySelector('[data-filter="issue"] strong').textContent,'1');
  assert.equal(document.querySelector('[data-filter="packing"] strong').textContent,'1');
  click(document,'[data-action="business-task-filter"][data-filter="stock"]');
  assert.equal(ui.taskFilters.system,'stock');assert.deepEqual(ids(document),['product:p2']);
  assert.equal(document.activeElement.dataset.filter,'stock');
  const action=tasks(document)[0].querySelector('button');
  assert.equal(action.dataset.action,'stock');assert.equal(action.dataset.id,'p2');assert.equal(action.textContent,'更新库存');
  click(document,'[data-action="business-task-filter"][data-filter="ready"]');
  assert.equal(tasks(document).length,0);assert.match(document.querySelector('.business-tasks-empty').textContent,/当前没有待出发事项/);
});

test('the standalone task list displays all matching rows with their original business actions',t=>{
  const {document}=fixture(t,{orders:Array.from({length:7},(_,index)=>order('pack-'+index))});
  assert.equal(tasks(document).length,7);
  assert.equal(document.querySelector('[data-action="business-tasks-all"]'),null);
  for(const row of tasks(document)){assert.equal(row.querySelector('button').dataset.action,'order-detail');assert.equal(row.querySelector('button').textContent,'去配货');}
  assert.equal(document.querySelector('.task-page input[type="checkbox"]'),null);
});

test('resolved shortages leave the urgent list without erasing notes or marking the order packed',t=>{
  const record=order('issue',{stage:'packing',items:[{productId:'p1',productName:'历史牛肉',qty:3,packed:0,packingNote:'缺货 2 袋',packingIssue:shortage()}]});
  const {document,render}=fixture(t,{orders:[record]});
  assert.equal(tasks(document)[0].dataset.taskKind,'issue');
  record.items[0].packingIssue={...record.items[0].packingIssue,status:'resolved',resolvedAt:'2026-10-20T01:00:00.000Z'};
  render();
  assert.equal(tasks(document)[0].dataset.taskKind,'packing');assert.equal(tasks(document)[0].querySelector('button').textContent,'去配货');
  assert.equal(record.items[0].packed,0);assert.equal(record.items[0].packingNote,'缺货 2 袋');
  record.stage='delivered';render();assert.equal(tasks(document).length,0);
});

test('demo scope is respected and ordinary packing notes do not appear as anomalies',t=>{
  const {document,ui,render}=fixture(t,{orders:[order('demo',{isDemo:true,issue:'缺货'}),order('normal-note',{stage:'packing',items:[{productId:'p1',qty:3,packed:0,price:120,packingNote:'请轻拿轻放',packingIssue:{type:'other',status:'open'}}]})]});
  assert.deepEqual(ids(document),['order:normal-note']);
  assert.equal(tasks(document)[0].dataset.taskKind,'packing');
  ui.businessDemo=true;render();assert.equal(tasks(document).length,2);
  assert.match(document.querySelector('[data-task-id="order:demo"]').textContent,/演示/);
});

test('task UI does not grant management access to store-role actions',t=>{
  const {overview,ui}=fixture(t);
  ui.role='client';
  assert.throws(()=>overview.page(),/仅管理员/);
  assert.throws(()=>overview.handleAction('business-task-tab',{dataset:{tab:'manual'}}),/仅管理员/);
  assert.throws(()=>overview.handleAction('business-task-filter',{dataset:{filter:'all'}}),/仅管理员/);
  assert.throws(()=>overview.handleAction('business-task-add',{dataset:{}}),/仅管理员/);
  assert.throws(()=>overview.handleAction('business-manual-toggle',{dataset:{id:'todo-1'}}),/仅管理员/);
  assert.throws(()=>overview.handleAction('business-manual-date',{dataset:{id:'todo-1'}}),/仅管理员/);
});

test('adding a todo labels only the direct entry as manual and safely renders its text',async t=>{
  const {document,window,model,overview}=fixture(t,{tab:'manual',orders:[order('shortage',{stage:'packing',items:[{productId:'p1',productName:'历史牛肉',qty:3,packed:0,packingNote:'缺货 2 袋',packingIssue:shortage()}]})]});
  click(document,'[data-action="business-task-add"]');
  const form=document.querySelector('#manual-task-form');assert.ok(form);
  const title='  联系供应商 <img src=x onerror=alert(1)>  ',note='  明早确认到货 & 回电  ',dueDate=shiftDay(today,1);
  form.elements.title.value=title;form.elements.note.value=note;form.elements.dueDate.value=dueDate;
  for(const field of [form.elements.title,form.elements.note,form.elements.dueDate])field.dispatchEvent(new window.Event('input',{bubbles:true}));
  await overview.handleSubmit(form);
  assert.equal(document.querySelector('[role="dialog"]'),null);
  assert.equal(model.state.manualTasks.length,1);assert.equal(model.state.manualTasks[0].title,title.trim());assert.equal(model.state.manualTasks[0].note,note.trim());assert.equal(model.state.manualTasks[0].dueDate,dueDate);
  const manual=tasks(document)[0];assert.equal(manual.dataset.taskSource,'manual');
  assert.equal(manual.querySelector('.business-task-source').textContent,'手动');
  assert.equal(manual.querySelector('strong').textContent,title.trim());assert.equal(manual.querySelector('img'),null);
  assert.equal(manual.querySelector('.business-task-description').textContent,note.trim());
  assert.equal(manual.querySelector('.business-task-deadline time').dateTime,dueDate);
  assert.equal(manual.querySelector('[role="checkbox"]').getAttribute('aria-checked'),'false');
  assert.equal(manual.querySelectorAll('[role="checkbox"]').length,1);
  assert.equal(document.activeElement.dataset.action,'business-task-add');
  click(document,'[data-action="business-task-tab"][data-tab="system"]');
  assert.equal(document.querySelector('[data-task-id="order:shortage"]').dataset.taskSource,'system');
  assert.equal(document.querySelector('[data-task-id="order:shortage"] .business-task-source').textContent,'系统');
  assert.equal(document.querySelector('[data-task-id="order:shortage"] [role="checkbox"]'),null);
});

test('manual todo form validates, prevents duplicate saves, and preserves the draft after failure',async t=>{
  const {document,window,model,overview}=fixture(t,{tab:'manual'});
  click(document,'[data-action="business-task-add"]');
  const form=document.querySelector('#manual-task-form');
  form.elements.title.value='   ';
  await overview.handleSubmit(form);
  assert.equal(model.state.manualTasks.length,0);assert.match(form.querySelector('[role="alert"]').textContent,/请输入/);
  assert.equal(document.activeElement,form.elements.title);
  const dueDate=shiftDay(today,2);
  form.elements.title.value='检查明日到货';form.elements.note.value='联系供应商';form.elements.dueDate.value=dueDate;
  for(const field of [form.elements.title,form.elements.note,form.elements.dueDate])field.dispatchEvent(new window.Event('input',{bubbles:true}));
  let rejectSave,calls=0;const save=model.addManualTask.bind(model);
  model.addManualTask=()=>{calls++;return new Promise((resolve,reject)=>{rejectSave=reject;});};
  const pending=overview.handleSubmit(form);
  assert.equal(form.querySelector('[type="submit"]').disabled,true);
  await overview.handleSubmit(form);assert.equal(calls,1);
  rejectSave(new Error('连接中断，请重试。'));await pending;
  assert.match(form.querySelector('[role="alert"]').textContent,/连接中断/);
  assert.equal(form.elements.title.value,'检查明日到货');assert.equal(form.elements.note.value,'联系供应商');assert.equal(form.elements.dueDate.value,dueDate);
  assert.equal(form.querySelector('[type="submit"]').disabled,false);
  document.getElementById('overlay-root').innerHTML='';click(document,'[data-action="business-task-add"]');
  const reopened=document.querySelector('#manual-task-form');assert.equal(reopened.elements.title.value,'检查明日到货');assert.equal(reopened.elements.note.value,'联系供应商');assert.equal(reopened.elements.dueDate.value,dueDate);
  model.addManualTask=save;await overview.handleSubmit(reopened);assert.equal(model.state.manualTasks.length,1);assert.equal(model.state.manualTasks[0].dueDate,dueDate);
});

test('manual completion and restore retain the record and never resolve a system shortage',async t=>{
  const problem=order('issue',{issue:'缺货待补'}),todo={id:'todo-1',title:'联系供应商',note:'确认补货时间',source:'manual',createdAt:today+'T01:00:00.000Z',completedAt:null,deletedAt:null};
  const {document,model,overview}=fixture(t,{tab:'manual',orders:[problem],manualTasks:[todo]});
  const checkbox=document.querySelector('[data-action="business-manual-toggle"]');assert.ok(checkbox);
  await overview.handleAction('business-manual-toggle',checkbox);
  assert.ok(todo.completedAt);assert.equal(model.state.manualTasks.length,1);assert.equal(todo.note,'确认补货时间');
  assert.equal(document.querySelector('[data-action="business-manual-toggle"]'),null);
  assert.equal(document.querySelector('[data-filter="completed"] strong').textContent,'1');
  assert.equal(document.querySelector('.business-tasks-total').textContent,'0');
  assert.equal(problem.issue,'缺货待补');assert.equal(problem.issueResolvedAt,undefined);
  click(document,'[data-action="business-task-filter"][data-filter="completed"]');
  const completed=tasks(document)[0];assert.equal(completed.classList.contains('is-completed'),true);
  const restore=completed.querySelector('[role="checkbox"]');assert.equal(restore.getAttribute('aria-checked'),'true');assert.match(restore.getAttribute('aria-label'),/恢复待办/);
  await overview.handleAction('business-manual-toggle',restore);
  assert.equal(todo.completedAt,null);assert.equal(tasks(document).length,0);
  click(document,'[data-action="business-task-filter"][data-filter="all"]');
  assert.equal(tasks(document).length,1);assert.equal(tasks(document)[0].querySelector('[role="checkbox"]').getAttribute('aria-checked'),'false');
});

test('manual form submission is rejected for a store role before persistence',async t=>{
  const {document,model,ui,overview}=fixture(t,{tab:'manual'});
  click(document,'[data-action="business-task-add"]');
  const form=document.querySelector('#manual-task-form');form.elements.title.value='不应提交';ui.role='client';
  await assert.rejects(overview.handleSubmit(form),/仅管理员/);assert.equal(model.state.manualTasks.length,0);
});

test('each source tab scopes its own deadline labels, overdue counts and completed records',t=>{
  const past=shiftDay(today,-2),base={note:'',createdAt:today+'T01:00:00.000Z',completedAt:null,deletedAt:null};
  const {document}=fixture(t,{orders:[order('shortage',{issue:'缺货待补',deliveryDate:past})],stock:{p2:2},manualTasks:[
    {...base,id:'late',title:'联系供应商',dueDate:past},
    {...base,id:'today',title:'核对明日安排',dueDate:today},
    {...base,id:'legacy',title:'已有待办'},
    {...base,id:'done',title:'已完成跟进',dueDate:past,completedAt:today+'T02:00:00.000Z'}
  ]});
  assert.equal(document.querySelector('[data-task-id="manual:late"]'),null);
  const system=document.querySelector('[data-task-id="order:shortage"]');
  assert.equal(system.querySelector('.business-task-deadline time').dateTime,past);
  assert.equal(system.querySelector('.business-due-status').textContent,'逾期 2 天');
  assert.equal(system.querySelector('[data-action="business-manual-date"]'),null);
  assert.equal(document.querySelector('[data-task-id="product:p2"] .business-due-value').textContent,'未设截止日期');
  assert.equal(document.querySelector('[data-filter="overdue"] strong').textContent,'1');
  click(document,'[data-action="business-task-filter"][data-filter="overdue"]');assert.deepEqual(ids(document),['order:shortage']);
  click(document,'[data-action="business-task-tab"][data-tab="manual"]');
  assert.deepEqual(ids(document),['manual:late','manual:today','manual:legacy']);
  assert.equal(document.querySelector('[data-task-id="manual:today"] .business-due-value').textContent,'今天截止');
  assert.equal(document.querySelector('[data-task-id="manual:legacy"] .business-due-value').textContent,'设置截止日期');
  assert.equal(document.querySelector('[data-filter="overdue"] strong').textContent,'1');
  assert.equal(document.querySelector('[data-task-id="manual:late"] .business-due-status').textContent,'逾期 2 天');
  click(document,'[data-action="business-task-filter"][data-filter="completed"]');
  assert.deepEqual(ids(document),['manual:done']);assert.equal(tasks(document)[0].querySelector('.business-due-status'),null);
  click(document,'[data-action="business-task-tab"][data-tab="system"]');assert.deepEqual(ids(document),['order:shortage']);
  click(document,'[data-action="business-task-tab"][data-tab="manual"]');assert.deepEqual(ids(document),['manual:done']);
});

test('manual task creation requires a valid deadline before saving',async t=>{
  const {document,model,overview}=fixture(t,{tab:'manual'});
  click(document,'[data-action="business-task-add"]');
  const form=document.querySelector('#manual-task-form');
  assert.equal(form.elements.dueDate.required,true);assert.equal(form.elements.dueDate.value,today);
  form.elements.title.value='联系供应商';form.elements.dueDate.value='';
  await overview.handleSubmit(form);
  assert.equal(model.state.manualTasks.length,0);assert.match(form.querySelector('[role="alert"]').textContent,/截止日期/);
  assert.equal(form.elements.dueDate.getAttribute('aria-invalid'),'true');assert.equal(document.activeElement,form.elements.dueDate);
});

test('editing a saved manual deadline keeps other fields and retries safely after a failed save',async t=>{
  const todo={id:'todo-1',title:'联系供应商',note:'已有备注',dueDate:today,createdAt:today+'T01:00:00.000Z',completedAt:null,deletedAt:null};
  const {document,model,overview,ui}=fixture(t,{tab:'manual',orders:[order('shortage',{issue:'缺货'})],manualTasks:[todo]});
  const originalOrders=structuredClone(model.state.orders),newDate=shiftDay(today,3);
  click(document,'[data-action="business-manual-date"]');
  const form=document.querySelector('#manual-task-date-form');assert.equal(form.elements.dueDate.value,today);
  form.elements.dueDate.value='';await overview.handleSubmit(form);
  assert.equal(todo.dueDate,today);assert.match(form.querySelector('[role="alert"]').textContent,/截止日期/);
  form.elements.dueDate.value=newDate;
  const save=model.setManualTaskDueDate.bind(model);let calls=0,rejectSave;
  model.setManualTaskDueDate=(id,dueDate)=>{calls++;assert.equal(id,todo.id);assert.equal(dueDate,newDate);return new Promise((resolve,reject)=>{rejectSave=reject;});};
  const pending=overview.handleSubmit(form);await overview.handleSubmit(form);assert.equal(calls,1);
  assert.equal(form.querySelector('[type="submit"]').disabled,true);assert.equal(todo.dueDate,today);
  rejectSave(new Error('暂时无法保存'));await pending;
  assert.equal(form.elements.dueDate.value,newDate);assert.match(form.querySelector('[role="alert"]').textContent,/暂时无法保存/);
  assert.equal(form.querySelector('[type="submit"]').disabled,false);
  model.setManualTaskDueDate=save;await overview.handleSubmit(form);
  assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(todo.dueDate,newDate);
  assert.equal(todo.note,'已有备注');assert.equal(todo.completedAt,null);assert.deepEqual(model.state.orders,originalOrders);
  assert.equal(document.querySelector('[data-task-id="manual:todo-1"] .business-task-deadline time').dateTime,newDate);
  click(document,'[data-action="business-manual-date"]');ui.role='client';
  await assert.rejects(overview.handleSubmit(document.querySelector('#manual-task-date-form')),/仅管理员/);
  assert.equal(todo.dueDate,newDate);
});

test('source tabs preserve deep links and support keyboard switching without mixing scopes',t=>{
  const {document,window,overview}=fixture(t,{orders:[order('packing')],manualTasks:[{id:'one',title:'缺货跟进',source:'manual',createdAt:today+'T01:00:00.000Z',dueDate:today}]});
  assert.equal(document.querySelectorAll('[role="tablist"][aria-label="待办来源"] [role="tab"]').length,2);
  assert.equal(document.querySelector('[data-action="business-task-add"]'),null);
  const system=document.querySelector('#task-tab-system');
  overview.handleKeydown({target:system,key:'ArrowRight',preventDefault(){}});
  assert.equal(document.activeElement.id,'task-tab-manual');
  assert.equal(document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'),'task-tab-manual');
  assert.equal(window.location.search,'?page=tasks&tab=manual');assert.deepEqual(ids(document),['manual:one']);
  click(document,'[data-action="business-task-filter"][data-filter="completed"]');assert.match(window.location.search,/filter=completed/);
  overview.handleKeydown({target:document.querySelector('#task-tab-manual'),key:'Home',preventDefault(){}});
  assert.equal(document.activeElement.id,'task-tab-system');assert.deepEqual(ids(document),['order:packing']);
});

test('business overview keeps analytics and period drill-down after tasks move to their own page',t=>{
  const {window,document,model,ui}=fixture(t,{orders:[order('packing')]});
  window.eval(analyticsBundle);
  const overview=window.AnalyticsModule.createOverviewUI({model,ui,escape:value=>String(value),money:value=>'¥'+value,icon:()=>'',button:()=>'',render(){},nav(){},modal(){},emptyState:title=>title});
  document.getElementById('app').innerHTML=overview.page();
  assert.ok(document.querySelector('.business-metrics'));assert.ok(document.querySelector('.business-trend'));
  assert.equal(document.querySelector('.business-tasks'),null);assert.equal(document.querySelector('[data-action="business-task-add"]'),null);
  assert.ok(document.querySelector('[data-action="business-orders"]'));
  assert.equal(overview.handleAction('business-task-tab',{dataset:{tab:'manual'}}),false);
});
