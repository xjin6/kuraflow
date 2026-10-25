import {projectRoot} from '../../scripts/lib/project-paths.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {setImmediate as tick} from 'node:timers/promises';
import {tokyoDate} from '../../src/shared/settlement-data.js';
const bundle=(await build({stdin:{contents:"export {createTasksUI} from './src/features/tasks/tasks-ui.js'; export {createOverviewUI} from './src/features/overview/overview-ui.js'; export {createPricingUI} from './src/features/catalogue/pricing-ui.js'; export {KitchenModel} from './src/shared/data.js';",resolveDir:projectRoot},bundle:true,write:false,format:'iife',globalName:'UI',logLevel:'silent'})).outputFiles[0].text;
function fixture(t){
 const dom=new JSDOM('<div id="app"></div><div id="overlay-root"></div>',{url:'http://localhost:8787/?page=tasks',runScripts:'outside-only'});t.after(()=>dom.window.close());const {window}=dom,document=window.document;window.eval(bundle);
 const model=new window.UI.KitchenModel();model.state.manualTasks=[];model.state.manualTaskOrder=[];model.state.orders=[{id:'unrelated-order',stage:'packing',deliveryDate:tokyoDate(),date:tokyoDate(),items:[],storeId:model.getStores()[0]?.id}];
 for(const name of ['A','B','C'])model.addManualTask(window.JSON.parse(JSON.stringify({title:name,note:'备注',dueDate:tokyoDate()})));
 const ui={role:'admin',taskTab:'system',taskFilters:{manual:'all'},businessRange:'month',businessMetric:'amount',businessDemo:false,query:''};
 const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');let tasks;
 const context={model,ui,escape:esc,icon:n=>`<span data-icon="${n}"></span>`,money:v=>v==null?'—':'¥'+v,button:(label,action,variant,extra='')=>`<button data-action="${action}" ${extra}>${label}</button>`,render:()=>document.getElementById('app').innerHTML=tasks.page(),modal:(title,body,footer,id)=>{document.getElementById('overlay-root').innerHTML=`<section class="modal" role="dialog"><h2>${title}</h2><form id="${id}">${body}${footer}</form></section>`;},closeOverlay:()=>document.getElementById('overlay-root').innerHTML='',toast(){},nav(){},managementHeading:(g,tab,actions)=>`<h1>${tab}</h1>${actions}`};
 tasks=window.UI.createTasksUI(context);context.render();
 document.addEventListener('click',e=>{const button=e.target.closest('[data-action]');if(button)tasks.handleAction(button.dataset.action,button);});document.addEventListener('keydown',e=>tasks.handleKeydown(e));document.addEventListener('input',e=>tasks.handleInput(e.target));
 const click=async selector=>{const node=document.querySelector(selector);assert.ok(node,selector);node.click();await tick();};
 return {window,document,model,ui,tasks,context,click};
}

test('tasks show only recorded items without system/manual tabs or source badges',t=>{
 const {document}=fixture(t);assert.equal(document.querySelectorAll('.business-todo-row').length,3);assert.doesNotMatch(document.getElementById('app').textContent,/系统推送|手动记录|手动|unrelated-order/);assert.equal(document.querySelector('[aria-label="待办来源"]'),null);assert.ok(document.querySelector('[data-action="business-task-add"]'));
});

test('existing tasks edit their title, note and deadline using the same form; failure retains input',async t=>{
 const {document,model,tasks,click}=fixture(t),id=model.state.manualTasks[0].id;
 await click(`[data-action="business-task-edit"][data-id="${id}"]`);let form=document.querySelector('#manual-task-form');form.elements.title.value='<更新 A>';form.elements.note.value='更新的备注';
 const save=model.updateManualTask;model.updateManualTask=()=>{throw new Error('暂时保存失败');};await tasks.handleSubmit(form);assert.match(form.textContent,/保存失败/);assert.equal(form.elements.title.value,'<更新 A>');
 model.updateManualTask=save;await tasks.handleSubmit(form);assert.equal(model.state.manualTasks[0].title,'<更新 A>');assert.equal(document.querySelector('.task-title-edit').textContent,'<更新 A>');assert.equal(document.querySelector('.business-todo-copy script'),null);assert.equal(model.state.manualTasks[0].note,'更新的备注');
});

test('completed tasks move to completed and restore to active without losing their content',async t=>{
 const {document,model,click}=fixture(t),id=model.state.manualTasks[0].id;
 await click(`[data-action="business-manual-toggle"][data-id="${id}"]`);assert.equal(document.querySelectorAll('.business-todo-row').length,2);
 await click('[data-filter="completed"]');assert.equal(document.querySelectorAll('.business-todo-row').length,1);assert.equal(document.querySelector('[role="checkbox"]').getAttribute('aria-checked'),'true');
 await click('[data-action="business-manual-toggle"]');assert.equal(document.querySelectorAll('.business-todo-row').length,0);await click('[data-filter="all"]');assert.equal(document.querySelectorAll('.business-todo-row').length,3);assert.equal(model.state.manualTasks[0].completedAt,null);assert.equal(model.state.manualTasks[0].note,'备注');
});

test('date sections expand and collapse; list keyboard sorting persists the new order',async t=>{
 const {document,model,window,click}=fixture(t);await click('[data-action="business-task-date-group"]');assert.equal(document.querySelector('[data-task-group]').hidden,true);await click('[data-action="business-task-date-group"]');assert.equal(document.querySelector('[data-task-group]').hidden,false);
 await click('[data-action="business-task-view"][data-view="list"]');const rows=[...document.querySelectorAll('[data-manual-id]')],second=rows[1].dataset.manualId;rows[1].querySelector('[data-task-drag]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));await tick();assert.equal(model.state.manualTaskOrder[0],second);assert.equal(document.querySelector('[data-manual-id]').dataset.manualId,second);
});

test('clients cannot render or submit task editing',async t=>{
 const {ui,tasks,document,click}=fixture(t);await click('[data-action="business-task-add"]');ui.role='client';assert.throws(()=>tasks.page(),/仅管理员/);await assert.rejects(tasks.handleSubmit(document.querySelector('#manual-task-form')),/仅管理员/);
});

test('quote management shows the current product catalogue and allows plan creation without importing duplicate products',async t=>{
 const {window,document,model,context,ui}=fixture(t);model.state.quotePlans=[];const pricing=window.UI.createPricingUI(context),count=model.getProducts().length;document.getElementById('app').innerHTML=pricing.page();assert.equal(document.querySelectorAll('.pricing-table tbody tr').length,count);
 await pricing.handleAction('new-quote-plan',{});const form=document.querySelector('#pricing-plan-form');form.elements.name.value='测试方案';await pricing.handleSubmit(form);assert.equal(model.getQuotePlans().length,1);assert.equal(model.getProducts().length,count);ui.role='client';assert.throws(()=>pricing.page(),/仅管理员/);
});

test('business overview still contains analytics without tasks',t=>{
 const {window,document,context}=fixture(t);const overview=window.UI.createOverviewUI({...context,emptyState:title=>title});document.getElementById('app').innerHTML=overview.page();assert.ok(document.querySelector('.business-metrics'));assert.ok(document.querySelector('.business-trend'));assert.equal(document.querySelector('.business-tasks'),null);assert.ok(document.querySelector('[data-action="business-orders"]'));
});

test('new quote plan stays available after three examples and saves a fourth plan',async t=>{
 const {window,document,model,context}=fixture(t);model.state.quotePlans=[];for(const name of ['A','B','C'])model.createQuotePlan(name);
 let pricing;const render=()=>{document.getElementById('app').innerHTML=pricing.page();};pricing=window.UI.createPricingUI({...context,render});render();
 assert.equal(document.querySelector('[data-action="new-quote-plan"]').disabled,false);
 await pricing.handleAction('new-quote-plan',{});const form=document.querySelector('#pricing-plan-form');form.elements.name.value='D';await pricing.handleSubmit(form);
 assert.equal(model.getQuotePlans().length,4);assert.equal(document.querySelector('.pricing-plan-tabs .active').textContent.trim(),'D0 店');assert.equal(document.querySelector('[data-action="new-quote-plan"]').disabled,false);
});

test('store quote selector persists the selected store scope and recovers its saved choice after an error',async t=>{
 const {window,document,model,context}=fixture(t);model.state.quotePlans=[];const plan=model.createQuotePlan('公共方案'),store=model.getStores()[0];
 let pricing;const render=()=>{document.getElementById('app').innerHTML=pricing.selector(model.getStore(store.id));};pricing=window.UI.createPricingUI({...context,render});render();
 let input=document.getElementById('store-quote-plan');input.value=plan.id;await pricing.handleChange(input);assert.equal(model.getStore(store.id).quotePlanId,plan.id);
 const save=model.setStoreQuotePlan;model.setStoreQuotePlan=()=>{throw new Error('保存失败');};input=document.getElementById('store-quote-plan');input.value='';await pricing.handleChange(input);
 assert.equal(model.getStore(store.id).quotePlanId,plan.id);assert.equal(document.getElementById('store-quote-plan').value,plan.id);assert.equal(document.getElementById('store-quote-plan').disabled,false);model.setStoreQuotePlan=save;
});

test('task author uses saved creator identity and safely renders current profile with legacy fallback',async t=>{
 const {window,document,model,context}=fixture(t);
 model.state.manualTasks[0].createdBy='creator-1';model.state.manualTasks[0].createdByName='原姓名';
 const tasks=window.UI.createTasksUI({...context,loadAuthors:async()=>[{id:'creator-1',name:'<张三>',avatarUrl:'/api/account-avatar?account=creator-1&v=2'}]});
 document.getElementById('app').innerHTML=tasks.page();await tick();await tick();
 const authors=document.querySelectorAll('.task-author');assert.equal(authors[0].querySelector('.task-author-name').textContent,'<张三>');assert.equal(authors[0].querySelector('img').getAttribute('src'),'/api/account-avatar?account=creator-1&v=2');assert.equal(authors[0].querySelector('张三'),null);
 assert.equal(authors[1].querySelector('.task-author-name').textContent,'创建人未记录');
 model.updateManualTask(model.state.manualTasks[0].id,window.JSON.parse(JSON.stringify({title:'修改后',note:'',dueDate:tokyoDate()})),0);model.setManualTaskDone(model.state.manualTasks[0].id,true);assert.equal(model.state.manualTasks[0].createdBy,'creator-1');
});

test('permanent task deletion requires a separate confirmation and removes completed records',async t=>{
 const {document,model,click,tasks}=fixture(t);const id=model.state.manualTasks[0].id;
 await click(`[data-action="business-task-delete"][data-id="${id}"]`);assert.equal(model.state.manualTasks.length,3);assert.match(document.querySelector('#task-delete-form').textContent,/无法恢复/);
 await tasks.handleSubmit(document.querySelector('#task-delete-form'));assert.equal(model.state.manualTasks.length,2);assert.equal(document.querySelector(`[data-manual-id="${id}"]`),null);
});
