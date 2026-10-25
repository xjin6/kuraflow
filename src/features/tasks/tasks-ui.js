import {t, tx, ta, translatedError, setI18nText} from "../../i18n/index.js";
import {validDay} from '../../shared/overview-data.js';
import {tokyoDate} from '../../shared/settlement-data.js';

export function createTasksUI(ctx) {
  const {model,ui,escape:esc,icon,button,render,modal,closeOverlay=()=>{},toast=()=>{}}=ctx;
  const drafts=new Map(),saving=new Set(),collapsed=new Set();let drag=null,sorting=false;
  document.addEventListener('error',event=>{if(event.target.matches?.('.task-author-avatar img'))event.target.remove();},true);
  ui.taskFilters||={manual:'all'};ui.taskView||='dates';
  const filter=()=>['all','overdue','completed'].includes(ui.taskFilters.manual)?ui.taskFilters.manual:'all';
  const dateLabel=value=>!value?t('未设日期'):value===tokyoDate()?t('今天 · ')+value.slice(5).replace('-','/'):value.replaceAll('-','/');
  const ordered=()=>model.orderedManualTasks().filter(task=>!task.deletedAt);
  const select=(tasks,key=filter())=>tasks.filter(task=>key==='completed'?!!task.completedAt:!task.completedAt&&(key!=='overdue'||task.dueDate&&task.dueDate<tokyoDate()));
  function saveURL(){const query=new URLSearchParams({page:'tasks'});if(filter()!=='all')query.set('filter',filter());if(ui.taskView==='list')query.set('view','list');history.replaceState(null,'','?'+query);}
  function deadline(task){
    const overdue=!task.completedAt&&task.dueDate&&task.dueDate<tokyoDate();
    return `<button type="button" class="business-task-deadline business-due-button ${overdue?'is-overdue':''}" data-action="business-manual-date" data-id="${esc(task.id)}" ${ta("aria-label", "修改截止日期：{0}", [esc(task.title)])}>${(task.dueDate ? `<time datetime="${esc(task.dueDate)}">${esc(dateLabel(task.dueDate))}</time>` : tx("设置截止日期"))}${(overdue ? `<span class="business-due-status">${tx("已逾期")}</span>` : '')}</button>`;
  }
  let authors=null,authorsLoading=false;
  function author(task){
    const person=authors?.find(p=>p.id===task.createdBy);
    const recordedName=person?.name||task.createdByName;
    const name=recordedName||'创建人未记录';
    const url=person?.avatarUrl;
    const photo=typeof url==='string'&&url.startsWith('/api/account-avatar?')?`<img src="${esc(url)}" alt="" loading="lazy">`:'';
    return `<span class="task-author" data-task-author="${esc(task.id)}" ${ta("aria-label", "添加人：{0}", [esc(name)])}><span class="task-author-avatar" aria-hidden="true"><span>${esc((name==='创建人未记录' ? '?' : Array.from(name)[0]))}</span>${photo}</span><span class="task-author-name">${recordedName?esc(name):tx("创建人未记录")}</span></span>`;
  }
  function loadAuthors(){
    if(!ctx.loadAuthors||authorsLoading||authors)return;
    authorsLoading=true;
    Promise.resolve().then(()=>ctx.loadAuthors()).then(rows=>{authors=rows||[];for(const task of model.state.manualTasks||[]){const slot=[...document.querySelectorAll('[data-task-author]')].find(n=>n.dataset.taskAuthor===task.id);if(slot)slot.outerHTML=author(task);}}).catch(()=>{}).finally(()=>{authorsLoading=false;});
  }
  function row(task){const done=!!task.completedAt;return `<li class="business-todo-row ${done?'is-completed':''}" data-task-id="manual:${esc(task.id)}" data-manual-id="${esc(task.id)}"><button type="button" class="task-drag-handle" data-task-drag="${esc(task.id)}" ${ta("aria-label", "排序 {0}", [esc(task.title)])} title="${(ui.taskView==='dates' ? t("同一天内拖动排序；跨日期请切换列表") : t("拖动排序，也可用上下方向键"))}" ${sorting?'disabled':''}><svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor"><circle cx="5" cy="5" r="1.2"/><circle cx="11" cy="5" r="1.2"/><circle cx="5" cy="10" r="1.2"/><circle cx="11" cy="10" r="1.2"/><circle cx="5" cy="15" r="1.2"/><circle cx="11" cy="15" r="1.2"/></svg></button><div class="business-todo-copy"><div class="business-todo-title"><button type="button" class="task-title-edit" data-action="business-task-edit" data-id="${esc(task.id)}">${esc(task.title)}</button></div>${(task.note ? `<p class="business-task-description">${esc(task.note)}</p>` : '')}</div>${author(task)}${deadline(task)}<div class="task-row-actions"><button type="button" class="icon-button task-delete-button" data-action="business-task-delete" data-id="${esc(task.id)}" ${ta("aria-label", "彻底删除待办：{0}", [esc(task.title)])} ${ta("title", "彻底删除")}>${icon('trash')}</button><button type="button" class="icon-button" data-action="business-task-edit" data-id="${esc(task.id)}" ${ta("aria-label", "编辑待办：{0}", [esc(task.title)])}>${icon('edit')}</button><button type="button" class="business-manual-check" role="checkbox" aria-checked="${done}" aria-label="${(done ? t("恢复待办：") : t("完成待办："))}${esc(task.title)}" title="${(done ? t("恢复未完成") : t("完成待办"))}" data-action="business-manual-toggle" data-id="${esc(task.id)}" ${saving.has(task.id)?'disabled':''}><span>${icon('check')}</span></button></div></li>`;}
  function page(){
    if(ui.role!=='admin')throw new Error('仅管理员可查看待办。');loadAuthors();const tasks=ordered(),visible=select(tasks);
    const list=(rows,group='list')=>`<ul class="business-todo-list is-full" data-task-group="${group}" ${collapsed.has(group)?'hidden':''}>${rows.map(row).join('')}</ul>`;
    let content='';
    if(!visible.length)content='<div class="business-tasks-empty">'+icon('list')+`<span>${(filter()==='completed' ? tx("暂无已完成的待办") : (filter()==='overdue' ? tx("暂无逾期待办") : tx("暂无待办事项")))}</span></div>`;
    else if(ui.taskView==='list')content=list(visible);
    else {const dates=[...new Set(visible.map(t=>t.dueDate||''))].sort((a,b)=>(a||'9999').localeCompare(b||'9999'));content=dates.map(date=>{const group=date||'undated',rows=visible.filter(t=>(t.dueDate||'')===date);return `<section class="task-date-group"><button type="button" class="task-date-heading" data-action="business-task-date-group" data-group="${group}" aria-expanded="${!collapsed.has(group)}">${icon('chevron')}<strong>${esc(dateLabel(date))}</strong><span>${rows.length}</span></button>${list(rows,group)}</section>`;}).join('');}
    return `<div class="task-page"><div class="page-heading task-page-heading"><div class="heading-copy"><h1>${tx("待办事项")}</h1></div><div class="heading-actions">${button(tx("新增待办"),'business-task-add','primary','type="button"','plus')}</div></div><section class="section-card business-tasks" id="task-panel"><div class="business-tasks-header task-toolbar"><div class="business-task-filters" role="group" ${ta("aria-label", "待办状态")}>${[['all','未完成'],['overdue','逾期'],['completed','已完成']].map(([key,label])=>`<button type="button" class="business-task-filter ${filter()===key?'active':''}" data-action="business-task-filter" data-filter="${key}" aria-pressed="${filter()===key}"><span>${tx(label)}</span><strong>${select(tasks,key).length}</strong></button>`).join('')}</div><div class="view-switch" role="group" ${ta("aria-label", "待办显示方式")}>${[['list','列表'],['dates','按日期']].map(([key,label])=>`<button type="button" class="${ui.taskView===key?'active':''}" aria-pressed="${ui.taskView===key}" data-action="business-task-view" data-view="${key}">${tx(label)}</button>`).join('')}</div></div>${content}</section></div>`;
  }
  function refreshTasks(){const previous=document.querySelector('.task-page');if(previous)previous.outerHTML=page();}
  function openForm(id=''){
    const task=id?model.state.manualTasks.find(t=>t.id===id&&!t.deletedAt):null;if(id&&!task)throw new Error('待办不存在。');
    const draft=drafts.get(id)||{title:task?.title||'',note:task?.note||'',dueDate:id?(task.dueDate||''):tokyoDate(),version:task?.version||0};drafts.set(id,draft);
    modal((id ? tx("编辑待办") : tx("新增待办")),`<div class="manual-task-fields"><div class="field"><label for="manual-task-title">${tx("待办事项")}</label><input class="input" id="manual-task-title" name="title" value="${esc(draft.title)}" maxlength="120" required autocomplete="off"></div><div class="field"><label for="manual-task-due">${tx("截止日期")}</label><input class="input" type="date" id="manual-task-due" name="dueDate" value="${esc(draft.dueDate)}" required min="1000-01-01" max="9999-12-31"></div><div class="field"><label for="manual-task-note">${tx("备注")} <span class="manual-task-optional">${tx("选填")}</span></label><textarea class="input" id="manual-task-note" name="note" rows="3" maxlength="500">${esc(draft.note)}</textarea></div><div id="manual-task-error" class="inline-editor-feedback" role="alert"></div>${(id ? button(tx("读取最新资料"),'business-task-refresh-edit','ghost',`type="button" data-id="${esc(id)}" hidden`) : '')}</div>`,button(tx("取消"),'close','secondary','type="button"')+`<button class="btn btn-primary" type="submit">${(id ? tx("保存修改") : tx("添加待办"))}</button>`,'manual-task-form');
    const form=document.getElementById('manual-task-form');form.dataset.taskId=id;form.dataset.version=draft.version;form.closest('.modal')?.classList.add('manual-task-modal');form.querySelector('#manual-task-title').focus({preventScroll:true});
  }
  function handleInput(input){if(!['manual-task-title','manual-task-note','manual-task-due'].includes(input.id))return false;const form=input.closest('form'),key=form.dataset.taskId||'',draft=drafts.get(key);if(draft)draft[input.name]=input.value;const error=form.querySelector('#manual-task-error');error.textContent='';return true;}
  async function handleSubmit(form){
    if(form.id==='task-delete-form'){
      if(ui.role!=='admin')throw new Error('仅管理员可删除待办。');
      const submit=form.querySelector('[type=submit]');if(saving.has(form))return true;saving.add(form);submit.disabled=true;
      try{await model.purgeManualTask(form.dataset.taskId,Number(form.dataset.version));drafts.delete(form.dataset.taskId);closeOverlay();refreshTasks();toast('待办已彻底删除。');}
      catch(error){setI18nText(form.querySelector('[role=alert]'), () => (translatedError(error.message) || t("删除失败，请重试。")), "textContent");}
      finally{saving.delete(form);submit.disabled=false;}return true;
    }
    if(form.id!=='manual-task-form')return false;if(ui.role!=='admin')throw new Error('仅管理员可编辑待办。');
    const id=form.dataset.taskId||'',value={title:form.elements.title.value.trim(),note:form.elements.note.value.trim(),dueDate:form.elements.dueDate.value};
    const error=form.querySelector('#manual-task-error');if(!value.title||!validDay(value.dueDate)){setI18nText(error, () => (!value.title ? t("请输入待办事项。") : t("请选择有效的截止日期。")), "textContent");return true;}
    if(saving.has(form))return true;saving.add(form);const submit=form.querySelector('[type=submit]');submit.disabled=true;
    try{if(id)await model.updateManualTask(id,value,Number(form.dataset.version));else await model.addManualTask(value);drafts.delete(id);if(!id){ui.taskFilters.manual='all';collapsed.delete(value.dueDate);saveURL();}closeOverlay();refreshTasks();toast(id?'待办已更新。':'待办已添加。');}
    catch(failure){setI18nText(error, () => (translatedError(failure.message) || t("保存失败，请重试。")), "textContent");if(id&&failure.status===409)form.querySelector('[data-action="business-task-refresh-edit"]').hidden=false;}
    finally{saving.delete(form);submit.disabled=false;}return true;
  }
  async function persistOrder(list,version,focusId){
    const ids=[...list.querySelectorAll('[data-manual-id]')].map(row=>row.dataset.manualId);sorting=true;
    try{await model.reorderManualTasks(ids,version);toast('顺序已保存。');}catch(error){toast(translatedError(error.message)||'排序失败，请重试。');}finally{sorting=false;refreshTasks();if(focusId)[...document.querySelectorAll('[data-task-drag]')].find(n=>n.dataset.taskDrag===focusId)?.focus({preventScroll:true});}
  }
  async function handleAction(action,el){
    if(!['business-task-delete','business-task-add','business-task-edit','business-task-refresh-edit','business-manual-date','business-manual-toggle','business-task-filter','business-task-view','business-task-date-group','business-task-tab'].includes(action))return false;
    if(ui.role!=='admin')throw new Error('仅管理员可编辑待办。');
    if(action==='business-task-delete'){
      const task=model.state.manualTasks.find(t=>t.id===el.dataset.id);if(!task)throw new Error('待办不存在。');
      modal(tx("彻底删除待办"),`<p>${tx("确定彻底删除「{0}」？", [esc(task.title)])}</p><p class="muted-copy">${tx("删除后无法恢复，也不会保留在已完成列表中。")}</p><p role="alert" class="inline-editor-feedback"></p>`,button(tx("取消"),'close','secondary','type="button"')+`<button type="submit" class="btn btn-danger">${tx("彻底删除")}</button>`,'task-delete-form');
      const form=document.getElementById('task-delete-form');form.dataset.taskId=task.id;form.dataset.version=task.version||0;
    }
    else if(action==='business-task-add')openForm();
    else if(['business-task-edit','business-manual-date','business-task-refresh-edit'].includes(action)){if(action==='business-task-refresh-edit')drafts.delete(el.dataset.id);openForm(el.dataset.id);}
    else if(action==='business-manual-toggle'){
      const task=model.state.manualTasks.find(t=>t.id===el.dataset.id);if(!task||saving.has(task.id))return true;saving.add(task.id);el.disabled=true;
      const done=!task.completedAt;try{await model.setManualTaskDone(task.id,done);refreshTasks();toast(done?'已完成，可在「已完成」中恢复。':'已恢复为未完成。');}finally{saving.delete(task.id);if(el.isConnected)el.disabled=false;}
    }else if(action==='business-task-date-group'){const group=el.dataset.group;collapsed.has(group)?collapsed.delete(group):collapsed.add(group);refreshTasks();}
    else if(action==='business-task-view'){ui.taskView=el.dataset.view==='list'?'list':'dates';saveURL();refreshTasks();}
    else {ui.taskFilters.manual=action==='business-task-tab'?'all':el.dataset.filter;saveURL();refreshTasks();}
    return true;
  }
  function handleKeydown(event){const handle=event.target.closest?.('[data-task-drag]');if(!handle||!['ArrowUp','ArrowDown'].includes(event.key)||sorting)return;event.preventDefault();const row=handle.closest('li'),list=row.parentElement,other=event.key==='ArrowUp'?row.previousElementSibling:row.nextElementSibling;if(!other)return;list.insertBefore(row,event.key==='ArrowUp'?other:other.nextSibling);persistOrder(list,model.state.manualTaskOrderVersion||0,row.dataset.manualId);}
  document.addEventListener('pointerdown',event=>{const handle=event.target.closest?.('[data-task-drag]');if(!handle||event.button!==0||sorting||ui.role!=='admin')return;drag={order:[...handle.closest('li').parentElement.children].map(n=>n.dataset.manualId).join(','),row:handle.closest('li'),handle,y:event.clientY,version:model.state.manualTaskOrderVersion||0,moved:false};handle.setPointerCapture?.(event.pointerId);});
  document.addEventListener('pointermove',event=>{if(!drag)return;if(Math.abs(event.clientY-drag.y)<5&&!drag.moved)return;drag.moved=true;drag.row.classList.add('is-dragging');const target=document.elementFromPoint?.(event.clientX,event.clientY)?.closest('[data-manual-id]');if(target&&target!==drag.row&&target.parentElement===drag.row.parentElement){const box=target.getBoundingClientRect();target.parentElement.insertBefore(drag.row,event.clientY<box.top+box.height/2?target:target.nextSibling);}});
  document.addEventListener('pointerup',()=>{if(!drag)return;const state=drag;drag=null;state.row.classList.remove('is-dragging');if(state.moved&&state.row.isConnected&&state.order!==[...state.row.parentElement.children].map(n=>n.dataset.manualId).join(','))persistOrder(state.row.parentElement,state.version,state.row.dataset.manualId);});
  document.addEventListener('pointercancel',()=>{drag=null;refreshTasks();});
  return {page,handleAction,handleChange:()=>false,handleInput,handleSubmit,handleKeydown,saveURL};
}
