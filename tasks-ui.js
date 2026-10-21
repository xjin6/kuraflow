import {businessTasks,validDay} from './overview-data.js';
import {tokyoDate} from './settlement-data.js';

export function createTasksUI(ctx) {
  const {model,ui,escape:esc,icon,button,render,modal,closeOverlay=()=>{},toast=()=>{}}=ctx;
  let manualDraft={title:'',note:'',dueDate:''},draftVersion=0;
  const savingForms=new WeakSet(),savingTasks=new Set();
  const now=()=>tokyoDate();
  const shortDate=date=>date.slice(5).replace('-','/');
  const scope=()=>({includeDemo:ui.businessDemo});
  const taskKinds=[['all','全部'],['issue','异常'],['overdue','逾期'],['packing','待配货'],['ready','待出发'],['stock','待补货'],['completed','已完成']];
  const taskTab=()=>ui.taskTab==='manual'?'manual':'system';
  ui.taskFilters||={system:'all',manual:'all'};
  const filters=()=>taskTab()==='manual'?[['all','未完成'],['overdue','逾期'],['completed','已完成']]:taskKinds.filter(([key])=>key!=='completed');
  const taskFilter=()=>filters().some(([key])=>key===ui.taskFilters[taskTab()])?ui.taskFilters[taskTab()]:'all';
  const allTaskRecords=result=>[...(result.tasks||[]),...(result.completedTasks||[])];
  const selectTasks=(tasks,key=taskFilter())=>tasks.filter(task=>task.source===taskTab()&&(key==='completed'?Boolean(task.completedAt):!task.completedAt&&(key==='all'||task.kind===key||(key==='overdue'&&task.isOverdue))));
  function saveURL() {
    const params=new URLSearchParams({page:'tasks',tab:taskTab()});
    if(taskFilter()!=='all')params.set('filter',taskFilter());
    if(model.state.orders.some(order=>order.isDemo))params.set('demo',ui.businessDemo?'1':'0');
    history.replaceState(null,'','?'+params);
  }
  function sourceTabs(result) {
    return `<div class="catalogue-layer-switch management-tabs task-source-tabs" role="tablist" aria-label="待办来源">${[['system','bell','系统推送'],['manual','edit','手动记录']].map(([key,ico,label],index)=>`<button type="button" id="task-tab-${key}" role="tab" aria-selected="${taskTab()===key}" aria-controls="task-panel" tabindex="${taskTab()===key?0:-1}" class="catalogue-layer management-tab ${taskTab()===key?'active':''}" data-action="business-task-tab" data-tab="${key}" data-layer="${index?'store':'warehouse'}">${icon(ico)}<div><strong>${label}</strong></div><span class="task-tab-count">${result.tasks.filter(task=>task.source===key).length}</span></button>`).join('')}</div>`;
  }
  function taskList(tasks,today) {
    const filter=taskFilter(),label=filters().find(([key])=>key===filter)?.[1]||'';
    const empty=filter==='completed'?'暂无已完成的记录':filter==='all'?(taskTab()==='manual'?'暂无手动记录':'当前没有系统待办'):`当前没有${label}事项`;
    return tasks.length?`<ul class="business-todo-list is-full">${tasks.map(task=>taskRow(task,today)).join('')}</ul>`:`<div class="business-tasks-empty">${icon(taskTab()==='manual'?'edit':'check')}<span>${empty}</span></div>`;
  }
  function page() {
    if(ui.role!=='admin')throw new Error('仅管理员可查看待办事项。');
    const result=businessTasks(model,now(),scope()),tasks=allTaskRecords(result),selected=taskFilter(),visible=selectTasks(tasks);
    const demo=taskTab()==='system'&&model.state.orders.some(order=>order.isDemo)?`<label class="business-demo"><input id="tasks-demo" type="checkbox" ${ui.businessDemo?'checked':''}>含演示订单</label>`:'';
    const taskAction=taskTab()==='manual'?button('新增待办','business-task-add','secondary','type="button"','plus'):demo||`<span class="btn btn-secondary business-task-action-placeholder" aria-hidden="true" inert>${icon('plus')}新增待办</span>`;
    return `<div class="task-page"><div class="page-heading management-heading task-page-heading"><div class="management-heading-main"><h1>待办事项</h1>${sourceTabs(result)}</div></div><section class="section-card business-tasks" id="task-panel" role="tabpanel" aria-labelledby="task-tab-${taskTab()}"><div class="business-tasks-header"><div class="business-task-filters" role="group" aria-label="${taskTab()==='manual'?'手动记录状态':'系统待办分类'}">${filters().map(([key,label])=>`<button type="button" class="business-task-filter ${key===selected?'active':''}" aria-pressed="${key===selected}" data-action="business-task-filter" data-filter="${key}" ${key==='completed'?'aria-label="已完成的手动待办"':''}><span>${label}</span><strong>${selectTasks(tasks,key).length}</strong></button>`).join('')}</div><div class="business-tasks-actions">${taskAction}</div></div><div class="business-task-list-heading" aria-hidden="true"><span>事项 <span class="business-tasks-total">${visible.length}</span></span><span>截止日期</span><span>操作</span></div>${taskList(visible,result.today)}</section></div>`;
  }
  function refreshTasks() {
    const previous=document.querySelector('.task-page');
    if(previous)previous.outerHTML=page();
  }
  function taskDescription(task) {
    if(task.description || !task.issues?.length)return task.description || '';
    const order=task.orderId?model.state.orders.find(item=>item.id===task.orderId):null;
    return task.issues.map(issue=>{
      const name=issue.productId?(order?.items?.find(item=>item.productId===issue.productId)?.productName || model.getProduct(issue.productId)?.name || issue.productId):'';
      return name?`${name}：${issue.text}`:issue.text;
    }).filter(Boolean).join('；');
  }
  function deadlineHTML(task,today) {
    const manual=task.source==='manual',date=task.dueDate;
    const label=date?(date===today?'今天截止':(date.slice(0,4)===today.slice(0,4)?shortDate(date):date.replaceAll('-','/'))+' 截止'):manual?'设置截止日期':'未设截止日期';
    const days=task.isOverdue?Math.round((Date.parse(today+'T12:00:00Z')-Date.parse(date+'T12:00:00Z'))/86400000):0;
    const content=`<span class="business-due-value">${date?`<time datetime="${date}">${esc(label)}</time>`:esc(label)}</span>${days?`<span class="business-due-status">逾期 ${days} 天</span>`:''}`;
    const classes=`business-task-deadline ${task.isOverdue?'is-overdue':date===today&&!task.completedAt?'is-today':''} ${date?'':'is-unset'}`;
    return manual?`<button type="button" class="${classes} business-due-button" data-action="business-manual-date" data-id="${esc(task.manualId)}" aria-label="${esc((date?'修改':'设置')+'截止日期：'+task.title)}">${content}</button>`:`<div class="${classes}" ${date?'title="按订单配送日期"':''}>${content}</div>`;
  }
  function taskRow(task,today) {
    const manual=task.source==='manual',completed=Boolean(task.completedAt);
    const kind=taskKinds.find(([key])=>key===task.kind)?.[1] || '待处理';
    const action=task.productId&&!task.orderId?'stock':'order-detail';
    const id=action==='stock'?task.productId:task.orderId;
    const label=task.kind==='stock'?'更新库存':task.kind==='issue'?'处理异常':task.stage==='delivering'?'跟进配送':task.kind==='ready'||task.stage==='ready'?'安排配送':'去配货';
    const description=taskDescription(task);
    const control=manual?`<button type="button" class="business-manual-check" role="checkbox" aria-checked="${completed}" aria-label="${esc((completed?'恢复待办：':'完成待办：')+task.title)}" title="${completed?'恢复待办':'完成待办'}" data-action="business-manual-toggle" data-id="${esc(task.manualId)}" ${savingTasks.has(task.manualId)?'disabled aria-busy="true"':''}><span>${icon('check')}</span></button>`:button(label,action,'secondary',`data-id="${esc(id)}" aria-label="${esc(label+'：'+task.title)}"`,'arrow');
    const meta=[task.orderId?`<span>${esc(task.orderId)}</span>`:'',completed?`<span>完成 ${esc(shortDate(task.completedDate))}</span>`:'',task.isDemo?'<span>演示</span>':''].filter(Boolean).join('');
    return `<li class="business-todo-row ${task.kind==='issue'||task.isOverdue?'is-urgent':''} ${completed?'is-completed':''}" data-task-id="${esc(task.id)}" data-task-kind="${esc(task.kind)}" data-task-source="${manual?'manual':'system'}"><div class="business-todo-copy"><div class="business-todo-title"><strong>${esc(task.title)}</strong><span class="business-task-source ${manual?'is-manual':''}">${manual?'手动':'系统'}</span>${manual?'':`<span class="business-task-kind">${kind}</span>`}</div>${description?`<p class="business-task-description" title="${esc(description)}">${esc(description)}</p>`:''}${meta?`<div class="business-task-meta">${meta}</div>`:''}</div>${deadlineHTML(task,today)}${control}</li>`;
  }
  function addTaskForm() {
    draftVersion++;
    modal('新增待办',`<div class="manual-task-fields"><div class="field"><label for="manual-task-title">待办事项 <span class="business-task-source is-manual">手动</span></label><input class="input" id="manual-task-title" name="title" value="${esc(manualDraft.title)}" maxlength="120" required placeholder="例如：联系供应商确认明日到货" autocomplete="off"></div><div class="field manual-task-date-field"><label for="manual-task-due">截止日期</label><input class="input" type="date" id="manual-task-due" name="dueDate" value="${esc(manualDraft.dueDate||now())}" required min="1000-01-01" max="9999-12-31"></div><div class="field"><label for="manual-task-note">备注 <span class="manual-task-optional">选填</span></label><textarea class="input" id="manual-task-note" name="note" maxlength="500" rows="3" placeholder="补充需要跟进的内容">${esc(manualDraft.note)}</textarea></div><div class="inline-editor-feedback" id="manual-task-error" role="alert"></div></div>`,button('取消','close','secondary','type="button"')+'<button type="submit" class="btn btn-primary">添加待办</button>','manual-task-form');
    document.getElementById('manual-task-form')?.closest('.modal')?.classList.add('manual-task-modal');
    globalThis.requestAnimationFrame?.(()=>document.getElementById('manual-task-title')?.focus({preventScroll:true}));
  }
  function handleInput(input) {
    if(input.id==='manual-task-date'){input.removeAttribute('aria-invalid');const error=document.getElementById('manual-task-date-error');if(error)error.textContent='';return true;}
    if(!['manual-task-title','manual-task-note','manual-task-due'].includes(input.id))return false;
    manualDraft={...manualDraft,[input.name]:input.value};
    const error=document.getElementById('manual-task-error');if(error)error.textContent='';
    input.removeAttribute('aria-invalid');return true;
  }
  async function handleSubmit(form) {
    if(form.id==='manual-task-date-form')return saveTaskDate(form);
    if(form.id!=='manual-task-form')return false;
    if(ui.role!=='admin')throw new Error('仅管理员可添加待办。');
    if(savingForms.has(form))return true;
    const title=form.elements.title.value.trim(),note=form.elements.note.value.trim(),dueDate=form.elements.dueDate.value,error=form.querySelector('#manual-task-error');
    if(!title||title.length>120||note.length>500){error.textContent=!title?'请输入待办事项。':title.length>120?'待办事项最多 120 个字。':'备注最多 500 个字。';const field=!title||title.length>120?form.elements.title:form.elements.note;field.setAttribute('aria-invalid','true');field.focus({preventScroll:true});return true;}
    if(!validDay(dueDate)||dueDate<'1000-01-01'){error.textContent='请选择有效的截止日期。';form.elements.dueDate.setAttribute('aria-invalid','true');form.elements.dueDate.focus({preventScroll:true});return true;}
    const version=draftVersion,submit=form.querySelector('[type="submit"]');
    savingForms.add(form);if(submit){submit.disabled=true;submit.textContent='添加中…';}error.textContent='';
    try {
      await model.addManualTask({title,note,dueDate});
      if(version===draftVersion)manualDraft={title:'',note:'',dueDate:''};
      if(form.isConnected){closeOverlay();ui.taskTab='manual';ui.taskFilters.manual='all';saveURL();refreshTasks();document.querySelector('[data-action="business-task-add"]')?.focus({preventScroll:true});toast('待办已添加。');}
    } catch(failure) {if(form.isConnected)error.textContent=failure.message||'添加失败，请重试。';}
    finally {savingForms.delete(form);if(submit){submit.disabled=false;submit.textContent='添加待办';}}
    return true;
  }
  function taskDateForm(id) {
    const task=(model.state.manualTasks||[]).find(task=>task.id===id&&!task.deletedAt);
    if(!task)throw new Error('待办不存在，请刷新后重试。');
    modal(task.dueDate?'修改截止日期':'设置截止日期',`<div class="manual-task-fields"><p class="manual-task-date-title">${esc(task.title)}</p><div class="field"><label for="manual-task-date">截止日期</label><input class="input" type="date" id="manual-task-date" name="dueDate" value="${esc(task.dueDate||now())}" required min="1000-01-01" max="9999-12-31"></div><div class="inline-editor-feedback" id="manual-task-date-error" role="alert"></div></div>`,button('取消','close','secondary','type="button"')+'<button type="submit" class="btn btn-primary">保存日期</button>','manual-task-date-form');
    const form=document.getElementById('manual-task-date-form');form.dataset.taskId=id;form.closest('.modal')?.classList.add('manual-task-modal');
  }
  async function saveTaskDate(form) {
    if(ui.role!=='admin')throw new Error('仅管理员可修改待办。');
    if(savingForms.has(form))return true;
    const dueDate=form.elements.dueDate.value,error=form.querySelector('#manual-task-date-error');
    if(!validDay(dueDate)||dueDate<'1000-01-01'){error.textContent='请选择有效的截止日期。';form.elements.dueDate.setAttribute('aria-invalid','true');form.elements.dueDate.focus({preventScroll:true});return true;}
    const submit=form.querySelector('[type="submit"]');savingForms.add(form);submit.disabled=true;submit.textContent='保存中…';error.textContent='';
    try {await model.setManualTaskDueDate(form.dataset.taskId,dueDate);if(form.isConnected){closeOverlay();refreshTasks();toast('截止日期已更新。');}}
    catch(failure){if(form.isConnected)error.textContent=failure.message||'保存失败，请重试。';}
    finally {savingForms.delete(form);submit.disabled=false;submit.textContent='保存日期';}
    return true;
  }
  async function toggleManualTask(el) {
    const id=el.dataset.id,task=(model.state.manualTasks||[]).find(task=>task.id===id);
    if(!task)throw new Error('待办不存在，请刷新后重试。');
    if(savingTasks.has(id))return true;
    const done=!task.completedAt;
    const index=[...document.querySelector('.business-tasks').querySelectorAll('.business-manual-check')].indexOf(el);
    savingTasks.add(id);el.disabled=true;el.setAttribute('aria-busy','true');
    try {
      await model.setManualTaskDone(id,done);savingTasks.delete(id);refreshTasks();
      const area=document.querySelector('.business-tasks');
      const checks=[...(area?.querySelectorAll('.business-manual-check')||[])];
      (checks[Math.min(index,checks.length-1)]||document.querySelector(`[data-action="business-task-filter"][data-filter="${taskFilter()}"]`))?.focus({preventScroll:true});
      toast(done?'待办已完成，可在「已完成」中恢复。':'已恢复待办。');
    } finally {savingTasks.delete(id);if(el.isConnected){el.disabled=false;el.removeAttribute('aria-busy');}}
    return true;
  }
  function handleChange(input) {
    if(input.id!=='tasks-demo')return false;
    if(ui.role!=='admin')throw new Error('仅管理员可查看待办事项。');
    ui.businessDemo=input.checked;saveURL();render();document.getElementById('tasks-demo')?.focus({preventScroll:true});return true;
  }
  function switchTab(tab) {
    ui.taskTab=tab==='manual'?'manual':'system';saveURL();render();
    document.querySelector(`[data-action="business-task-tab"][data-tab="${taskTab()}"]`)?.focus({preventScroll:true});
  }
  function handleAction(action,el) {
    if(!['business-task-tab','business-task-filter','business-task-add','business-manual-toggle','business-manual-date'].includes(action))return false;
    if(ui.role!=='admin')throw new Error('仅管理员可查看待办事项。');
    if(action==='business-task-tab'){switchTab(el.dataset.tab);return true;}
    if(action==='business-task-add'){addTaskForm();return true;}
    if(action==='business-manual-toggle')return toggleManualTask(el);
    if(action==='business-manual-date'){taskDateForm(el.dataset.id);return true;}
    ui.taskFilters[taskTab()]=filters().some(([key])=>key===el.dataset.filter)?el.dataset.filter:'all';
    saveURL();render();document.querySelector(`[data-action="business-task-filter"][data-filter="${taskFilter()}"]`)?.focus({preventScroll:true});return true;
  }
  function handleKeydown(event) {
    if(event.isComposing)return;
    const tab=event.target.closest?.('[data-action="business-task-tab"]');
    if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();switchTab(event.key==='Home'?'system':event.key==='End'?'manual':tab.dataset.tab==='system'?'manual':'system');
  }
  return {page,handleAction,handleChange,handleInput,handleSubmit,handleKeydown,saveURL};
}
