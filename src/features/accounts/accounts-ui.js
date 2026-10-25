import {mp, mj, me, t, tx, ta, translatedError, setI18nText, getLocale} from "../../i18n/index.js";
import {storeDirectoryCard,storeCardAddress} from '../../ui/directory-card.js';
import {createAvatarEditor,safeAvatarUrl} from '../../ui/avatar-editor.js';
import {createPortalFeatureDraft,renderPortalFeatureFields,readPortalFeatureFields,patchPortalFeatureFields,serializePortalFeatureFields} from './portal-feature-fields.js';

export function createAccountsUI(ctx) {
  const {request,principal,escape:esc,button:renderButton,icon,modal,closeOverlay,toast,render}=ctx;
  const ownerActions=new Set(['accounts-kitchen-new','accounts-kitchen-edit','accounts-kitchen-key','accounts-kitchen-features','accounts-customer-key','accounts-customer-password','accounts-customer-password-refresh','accounts-customer-avatar','accounts-staff-new','accounts-staff-edit','accounts-staff-confirm','accounts-staff-update','accounts-staff-delete','accounts-staff-restore','accounts-master-reset-confirm','accounts-master-reset','accounts-scope-key','accounts-flow-connect','accounts-flow-refresh','accounts-flow-reload','accounts-organization-avatar']);
  const button=(...args)=>principal.role==='platform'&&principal.accountRole!=='owner'&&ownerActions.has(args[1])?'':renderButton(...args);
  let kitchens=null,team=null,events=null,loading=false,error='',tenant='',store='',section=principal.role==='platform'?'kitchens':'team',query='',handoff=null,epoch=0;
  let recovered=ctx.recoveredDraft||null,flowConfig=null,customerData=null,customerTab='admins',customerDeleted=false,passwordReset=null,peopleDeleted=false,lifecycle=null;
  let customerView='list', directoryView='card',platformTeam=false;
  const field=(label,name,value='',extra='')=>`<div class="field"><label for="account-${name}">${tx(label)}</label><input class="input" id="account-${name}" name="${name}" value="${esc(value)}" ${extra}></div>`;
  const heading=(title,actions='')=>`<div class="page-heading accounts-page-heading"><h1>${title}</h1><div class="heading-actions">${actions}</div></div>`;
  const footer=label=>button(tx("取消"),'close','secondary','type="button"')+`<button type="submit" class="btn btn-primary">${tx(label)}</button>`;
  const personAvatar=(row,{action='',extra='',label=''}={})=>{
    const url=safeAvatarUrl(row?.avatarUrl),name=row?.name||row?.displayName||'用户';
    const contents=url?`<img src="${esc(url)}" ${ta("alt", "{0}的头像", [esc(name)])} loading="lazy">`:`<span aria-hidden="true">${esc(name.slice(0,1))}</span>`;
    return action?`<button type="button" class="account-avatar account-avatar-button" data-action="${action}" ${extra} aria-label="${esc((label || '修改'+name+'的头像'))}" ${ta("title", "修改头像")}>${contents}</button>`:`<span class="account-avatar">${contents}</span>`;
  };
  const editableAvatar=row=>Boolean(row&&!row.deletedAt&&(row.id===(principal.userId||principal.id)||principal.role==='platform'&&principal.accountRole==='owner'||team?.canManage&&principal.accountRole==='owner'));
  const customerSection=()=>section==='customer'||section==='stores';
  const archivedToggle=()=>`<label class="accounts-check accounts-archived"><input type="checkbox" id="accounts-archived" ${peopleDeleted?'checked':''}>${tx("含已删除管理员")}</label>`;
  function applyProfileChange(data){
    if(data.account){
      const patch=data.account;
      if(team)team.accounts=team.accounts.map(row=>row.id===patch.id?{...row,...patch}:row);
      if(customerData){customerData.managementAccounts=customerData.managementAccounts.map(row=>row.id===patch.id?{...row,...patch}:row);customerData.stores=customerData.stores.map(item=>({...item,accounts:item.accounts.map(row=>row.id===patch.id?{...row,...patch}:row)}));}
      if(patch.id===(principal.userId||principal.id))Object.assign(principal,patch);
    }
    if(data.organization){const patch=data.organization,id=patch.tenantId;
      if(team?.organization&&(team.organization.tenantId||tenant||principal.tenantId)===id)Object.assign(team.organization,patch);
      if(kitchens)kitchens=kitchens.map(row=>row.id===id?{...row,...patch}:row);
      if(customerData?.customer.id===id)Object.assign(customerData.customer,patch);
      if(principal.tenantId===id){principal.organizationAvatarUrl=patch.avatarUrl;principal.organizationAvatarVersion=patch.avatarVersion;}
    }
    ctx.onProfileChange?.(data);render();
  }
  const avatarEditor=createAvatarEditor({request,modal,button,icon,escape:esc,closeOverlay,toast,onSaved:applyProfileChange});
  function openAccountAvatar(row){if(!row||!editableAvatar(row))return;avatarEditor.open({kind:'account',id:row.id||row.userId,name:row.name||row.displayName,...row});}
  function openOrganizationAvatar(row={}){
    const tenantId=row.tenantId||row.id||team?.organization?.tenantId||tenant||principal.tenantId;
    if(!tenantId||!(principal.role==='platform'&&principal.accountRole==='owner'||principal.role==='admin'&&principal.accountRole==='owner'&&tenantId===principal.tenantId))return;
    avatarEditor.open({kind:'organization',id:tenantId,name:row.name||team?.organization?.name||'中央厨房',avatarUrl:row.avatarUrl??principal.organizationAvatarUrl,avatarVersion:row.avatarVersion??principal.organizationAvatarVersion??0});
  }
  const status=row=>`<span class="account-status ${row.deletedAt?'disabled':row.status}">${(row.deletedAt ? tx("已删除") : tx({active:'已启用',disabled:'已停用',pending:'待设置密码'}[row.status] || '未开通'))}</span>`;
  async function load() {
    if(loading)return;loading=true;error='';const id=++epoch;
    try {
      if(principal.role==='platform'&&['kitchens','team','stores'].includes(section)&&!platformTeam){
        const rows=(await request('/api/platform/kitchens')).kitchens;if(id!==epoch)return;kitchens=rows;
        if(['team','stores'].includes(section)&&!rows.some(row=>row.id===tenant))tenant=rows[0]?.id||'';
      }
      if(section==='team') {const data=await request('/api/team/list?'+new URLSearchParams({...(tenant?{tenant}:{}),...(store?{store}:{})}));if(id!==epoch)return;team=data;const me=data.accounts?.find(row=>row.id===(principal.userId||principal.id));if(me&&Object.hasOwn(me,'avatarUrl')){Object.assign(principal,{avatarUrl:me.avatarUrl,avatarVersion:me.avatarVersion});ctx.onProfileChange?.({account:me});}if(principal.role==='admin'&&!data.storeId&&Object.hasOwn(data.organization||{},'avatarUrl')){principal.organizationAvatarUrl=data.organization.avatarUrl;principal.organizationAvatarVersion=data.organization.avatarVersion;ctx.onProfileChange?.({organization:data.organization});}}
      if(customerSection()&&platformRead()){const data=tenant?await request('/api/platform/customer?'+new URLSearchParams({tenant})):{customer:null,stores:[],managementAccounts:[]};if(id!==epoch)return;customerData=data;if(section==='stores')ctx.onDirectoryChange?.(tenant);}
      if(section==='audit'){const data=await request('/api/team/audit'+(tenant?'?tenant='+encodeURIComponent(tenant):''));if(id!==epoch)return;events=data.events;}
    }catch(e){if(id===epoch)error=e.message;}finally{if(id===epoch){loading=false;render();}}
  }
  function reload(){epoch++;loading=false;team=null;events=null;kitchens=null;customerData=null;error='';ctx.onSectionChange?.(section);render();}
  function page(){const ready=section==='kitchens'?kitchens:section==='audit'?events:customerSection()?customerData:team;if(!ready){if(!loading&&!error)queueMicrotask(load);return `<section class="section-card accounts-empty"><h2>${(error ? tx("读取失败") : (section==='stores' ? tx("正在读取门店") : tx("正在读取账号")))}</h2>${(error ? `<p>${esc(error)}</p>${button(tx("重试"),'accounts-reload','secondary')}` : '')}</section>`;}return section==='kitchens'?kitchenPage():section==='audit'?auditPage():section==='customer'?customerPage():section==='stores'?storesDirectoryPage():teamPage();}
  const directoryViewSwitch=(kind,view,label)=>`<div class="view-switch accounts-view-switch" role="group" ${ta("aria-label", label)}>${['list','card'].map(key=>`<button type="button" class="${view===key?'active':''}" aria-pressed="${view===key}" data-action="accounts-${kind}-view" data-view="${key}">${(key==='list' ? tx("列表") : tx("卡片"))}</button>`).join('')}</div>`;
  const cardField=(label,value)=>`<div><span>${tx(label)}</span><strong>${esc((value || '—'))}</strong></div>`;
  const directoryAvatar=(name,url)=>`<div class="store-avatar${url?' store-photo':''}">${(url ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy">` : esc(name.slice(0,1)))}</div>`;
  function kitchenActions(row){
    const extra=`data-tenant="${esc(row.id)}"`;
    return button(tx("负责人码"),'accounts-kitchen-key','secondary',extra)+button(tx("员工管理"),'accounts-kitchen-team','secondary',extra)+button(tx("功能配置"),'accounts-kitchen-features','secondary',extra);
  }
  function kitchenCard(row){
    return `<article class="store-card" data-customer-card="${esc(row.id)}">
      <header class="store-card-heading">${directoryAvatar(row.name,safeAvatarUrl(row.avatarUrl))}<div class="store-card-identity"><h3><button class="directory-name-link" data-action="accounts-kitchen-customer" data-tenant="${esc(row.id)}">${esc(row.name)}</button></h3><span class="store-city">${tx("中央厨房")}</span></div><div class="store-card-tools">${platformOwner()?`<button type="button" class="icon-button" data-action="accounts-kitchen-edit" data-tenant="${esc(row.id)}" ${ta("aria-label", "设置{0}", [esc(row.name)])} ${ta("title", "设置")}>${icon('edit')}</button>`:''}<span class="account-status ${row.active===1?'active':'disabled'}">${(row.active===1 ? tx("已启用") : tx("已停用"))}</span></div></header>
      <div class="store-card-info">${cardField('负责人',row.owner_name)}${cardField('联系方式',row.contact)}${cardField('套餐',row.plan||'标准版')}${cardField('有效期',row.expires_on||'长期有效')}${cardField('管理员',`${row.seats} 人`)}</div>
      <footer class="store-card-footer">${kitchenActions(row)}</footer>
    </article>`;
  }
  function kitchenPage(){
    const rows=kitchens.filter(row=>[row.name,row.owner_name,row.contact].join(' ').toLowerCase().includes(query.toLowerCase()));
    const cards=`<div class="stores-grid platform-directory-grid">${(rows.map(kitchenCard).join('') || `<section class="section-card accounts-empty"><h2>${tx("暂无中央厨房")}</h2></section>`)}</div>`;
    const table=`<section class="section-card accounts-table"><div class="table-scroll"><table><thead><tr><th>${tx("中央厨房")}</th><th>${tx("负责人")}</th><th>${tx("套餐 / 有效期")}</th><th>${tx("管理员")}</th><th>${tx("状态")}</th><th class="align-right">${tx("操作")}</th></tr></thead><tbody>${(rows.map(row=>`<tr><td><div class="account-person-cell">${personAvatar({...row,name:row.name})}<button class="customer-name-link" data-action="accounts-kitchen-customer" data-tenant="${esc(row.id)}"><strong>${esc(row.name)}</strong></button></div></td><td>${esc((row.owner_name || '—'))}<span class="cell-secondary">${esc((row.contact || ''))}</span></td><td>${esc((row.plan || t("标准版")))}<span class="cell-secondary">${esc((row.expires_on || t("长期有效")))}</span></td><td>${tx("{0} 人", [row.seats])}</td><td><span class="account-status ${row.active===1?'active':'disabled'}">${(row.active===1 ? tx("已启用") : tx("已停用"))}</span></td><td class="accounts-actions">${kitchenActions(row)}${button(tx("设置"),'accounts-kitchen-edit','ghost',`data-tenant="${esc(row.id)}"`)}</td></tr>`).join('') || `<tr><td colspan="6" class="accounts-empty">${tx("暂无中央厨房")}</td></tr>`)}</tbody></table></div></section>`;
    return heading(tx("中央厨房"),button(tx("开通中央厨房"),'accounts-kitchen-new','primary','','plus'))+`<div class="accounts-summary"><div><span>${tx("客户总数")}</span><strong>${kitchens.length}</strong></div><div><span>${tx("已启用")}</span><strong>${kitchens.filter(k=>k.active===1).length}</strong></div></div><section class="accounts-directory"><div class="accounts-directory-toolbar"><h2 class="section-title">${tx("客户列表")}</h2><div class="accounts-list-tools"><input class="input accounts-search" id="accounts-search" ${ta("aria-label", "搜索中央厨房")} ${ta("placeholder", "搜索名称、负责人")} value="${esc(query)}">${directoryViewSwitch('customer',customerView,'客户列表视图')}</div></div>${(customerView==='card' ? cards : table)}</section>`;
  }
  const platformRead=()=>principal.role==='platform'&&!principal.tenantId&&!principal.storeId;
  const platformOwner=()=>principal.role==='platform'&&principal.accountRole==='owner'&&!principal.tenantId&&!principal.storeId;
  const displayDate=value=>{if(!value)return '—';const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleString(getLocale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';};
  const customerAccount=(accountId,storeId=null)=>((storeId?customerData?.stores?.find(item=>item.id===storeId)?.accounts:customerData?.managementAccounts)||[]).find(item=>item.id===accountId);
  function customerAccounts(accounts=[],storeId=null,deleted=false){
    const rows=accounts.filter(row=>peopleDeleted||!row.deletedAt),scope=`data-store="${esc(storeId||'')}"`;
    return `<div class="customer-account-list"><div class="customer-account-head" aria-hidden="true"><span>${tx("姓名 / 身份")}</span><span>${tx("账号名 / 密码")}</span><span>${tx("联系方式")}</span><span>${tx("状态 / 最近登录")}</span><span>${tx("操作")}</span></div>${(rows.map(row=>{
      const canEdit=!deleted&&!row.deletedAt&&platformOwner(),extra=`data-id="${esc(row.id)}" ${scope}`;
      const actions=(canEdit?button(tx("编辑头像"),'accounts-customer-avatar','ghost',extra):'')+(row.accountRole==='member'?(!row.deletedAt?button(tx("重置密码"),'accounts-customer-password','secondary',`${extra} ${deleted?'disabled':''}`):'')+button((row.deletedAt ? tx("恢复") : tx("删除")),row.deletedAt?'accounts-staff-restore':'accounts-staff-delete',row.deletedAt?'secondary':'danger',`${extra} ${deleted?'disabled':''}`):'');
      return `<article class="customer-account-row" data-member-id="${esc(row.id)}"><div class="customer-account-person"><div class="account-person-cell">${personAvatar(row,{action:canEdit?'accounts-customer-avatar':'',extra})}<div class="customer-account-name"><strong>${esc((row.name || t("未填写姓名")))}</strong><span>${(row.accountRole==='owner' ? tx("负责人") : tx("管理员"))}</span></div></div></div><div class="customer-account-login">${(row.accountRole==='owner' ? `<span>${tx("负责人码登录，无密码")}</span>` : `<code>${esc((row.username||row.loginId || '—'))}</code><span>${tx("密码{0}", [(row.hasPassword ? mp("已设置") : mp("待设置"))])}</span>`)}</div><div class="customer-account-contact"><span class="customer-mobile-label">${tx("联系方式")}</span>${esc((row.contact || '—'))}</div><div class="customer-account-state">${status(row)}<span ${ta("title", "最近登录")}>${displayDate(row.lastLogin)}</span></div><div class="customer-account-action"><div class="account-action-buttons">${actions}</div></div></article>`;
    }).join('') || `<p class="customer-account-empty">${tx("暂无账号")}</p>`)}</div>`;
  }
  function customerStore(row){
    const detail=(label,value,wide=false)=>`<div${wide?' class="customer-detail-wide"':''}><dt>${tx(label)}</dt><dd>${esc((value || '—'))}</dd></div>`;
    const address=row.address||[row.prefecture,row.municipality,row.ward,row.addressDetail].filter(Boolean).join('')||row.city;
    return `<section class="section-card customer-store" data-customer-store="${esc(row.id)}"><header class="customer-store-heading"><div class="customer-store-identity">${(row.imageUrl ? `<img src="${esc(row.imageUrl)}" ${ta("alt", "{0}门店图", [esc(row.name)])} class="customer-store-image" loading="lazy">` : `<span class="customer-store-image customer-store-placeholder" aria-hidden="true">${icon('store')}</span>`)}<div><h2>${esc(row.name)}</h2>${(row.deletedAt ? `<span class="account-status disabled">${tx("已删除门店")}</span>` : '')}</div></div><div class="customer-store-actions">${button(tx("负责人码"),'accounts-customer-key','secondary',`data-store="${esc(row.id)}" ${row.deletedAt||!row.hasMaster?'disabled':''}`,'copy')}${button(tx("员工管理"),'accounts-customer-team','ghost',`data-store="${esc(row.id)}" ${row.deletedAt?'disabled':''}`)}</div></header><dl class="customer-store-details">${detail('联系人',row.contact)}${detail('联系电话',row.phone)}${detail('配送路线',row.route)}${detail('门店编号',row.id)}${detail('配送地址',address,true)}${(row.postalCode ? detail('邮政编码',row.postalCode) : '')}</dl>${customerAccounts(row.accounts,row.id,!!row.deletedAt)}</section>`;
  }
  function customerStoreCard(row){
    const extra=`data-store="${esc(row.id)}"`,members=(row.accounts||[]).filter(account=>account.accountRole==='member'&&!account.deletedAt);
    return storeDirectoryCard({
      attributes:`data-customer-store="${esc(row.id)}"`,
      title:`<button class="directory-name-link" data-action="accounts-customer-store-detail" ${extra}>${esc(row.name)}</button>`,
      subtitle:esc(storeCardAddress(row)),
      image:directoryAvatar(row.name,row.imageUrl),
      status:`<span class="account-status ${row.deletedAt?'disabled':'active'}">${(row.deletedAt ? tx("已删除门店") : tx("合作门店"))}</span>`,
      details:cardField('联系人',row.contact)+cardField('联系电话',row.phone)+cardField('配送路线',row.route)+cardField('管理员',`${members.length} 人`),
      actions:button(tx("门店资料"),'accounts-customer-store-detail','secondary',extra)+button(tx("负责人码"),'accounts-customer-key','secondary',`${extra} ${row.deletedAt||!row.hasMaster?'disabled':''}`)
    });
  }
  function storesDirectoryPage(){
    const stores=customerData?.stores||[],visible=stores.filter(row=>customerDeleted||!row.deletedAt);
    const picker=`<div class="accounts-tenant-picker"><label for="accounts-store-tenant">${tx("中央厨房")}</label><select class="input" id="accounts-store-tenant">${((kitchens||[]).map(row=>`<option value="${esc(row.id)}" ${row.id===tenant?'selected':''}>${esc(row.name)}</option>`).join('') || `<option value="">${tx("暂无中央厨房")}</option>`)}</select></div>`;
    return heading(tx("门店管理"),button(tx("刷新"),'accounts-reload','secondary','','refresh'))+`<div class="platform-store-toolbar">${picker}<div class="platform-store-filters"><label class="accounts-check"><input type="checkbox" id="accounts-customer-deleted" ${customerDeleted?'checked':''}>${tx("含已删除门店")}</label><div class="accounts-filter-slot" ${directoryView==='card'?'inert aria-hidden="true"':''}>${archivedToggle()}</div>${directoryViewSwitch('directory',directoryView,'门店列表视图')}</div></div><div class="platform-store-count">${tx("{0} 家门店", [visible.length])}</div><div class="${directoryView==='card'?'stores-grid platform-directory-grid':'platform-store-list is-list'}">${(visible.map(directoryView==='card'?customerStoreCard:customerStore).join('') || `<section class="section-card accounts-empty"><h2>${tx("暂无门店")}</h2></section>`)}</div>`;
  }
  function openCustomerStoreDetail(storeId){
    if(!platformRead()||!customerSection())return;
    const row=customerData?.stores.find(item=>item.id===storeId);if(!row)return;
    modal(tx("门店资料"),`<div class="accounts-store-detail">${customerStore(row)}</div>`,button(tx("关闭"),'close','secondary'));
    document.querySelector('.accounts-store-detail')?.closest('.modal')?.classList.add('accounts-store-detail-modal');
  }
  function openStores(tenantId=''){
    if(!platformRead())return;
    platformTeam=false;closeOverlay();tenant=tenantId||tenant;store='';section='stores';customerDeleted=false;peopleDeleted=false;reload();
  }
  function openMemberLifecycle(accountId,storeId,operation){
    const row=section==='team'?team?.accounts?.find(item=>item.id===accountId):customerSection()?customerAccount(accountId,storeId):null;
    const scopeDeleted=storeId&&customerSection()&&customerData?.stores?.find(item=>item.id===storeId)?.deletedAt;
    if(!row||row.accountRole!=='member'||scopeDeleted||!(platformOwner()||section==='team'&&team?.canManage&&principal.accountRole==='owner'))return;
    if(operation==='restore'?!row.deletedAt:!!row.deletedAt)return;
    const title=operation==='restore'?'恢复管理员':'删除管理员';
    modal(title,`<div class="customer-reset-identity"><strong>${esc((row.name || row.username))}</strong><code>${esc((row.username||row.loginId || ''))}</code></div><p class="form-hint">${(operation==='restore' ? tx("恢复后保持停用，启用后即可使用原账号登录。") : tx("删除后立即退出登录，历史记录保留，可在已删除管理员中恢复。"))}</p><p class="accounts-form-error" role="alert"></p>`,button(tx("取消"),'close','secondary','type="button"')+`<button type="submit" class="btn btn-${operation==='restore'?'primary':'danger'}">${tx("确认{0}", [(operation==='restore' ? mp("恢复") : mp("删除"))])}</button>`,'accounts-member-lifecycle-form');
    lifecycle={accountId,version:Number.isSafeInteger(row.version)?row.version:0,operation,busy:false,conflict:false,form:document.getElementById('accounts-member-lifecycle-form')};
  }
  async function saveMemberLifecycle(form){
    const state=lifecycle;if(!state||state.form!==form||!form.isConnected||state.busy)return true;
    const error=form.querySelector('.accounts-form-error');if(state.conflict){setI18nText(error, () => t("账号已变更，请关闭并刷新后重试。"), "textContent");return true;}
    state.busy=true;error.textContent='';form.querySelector('[type="submit"]').disabled=true;
    try{await request('/api/team/'+state.operation,{accountId:state.accountId,version:state.version});if(lifecycle!==state||!form.isConnected)return true;closeOverlay();reload();toast(state.operation==='restore'?'管理员已恢复，当前为停用状态。':'管理员已删除，可在已删除管理员中恢复。');}
    catch(failure){if(lifecycle===state&&form.isConnected){state.conflict=failure.status===409;setI18nText(error, () => (state.conflict ? t("账号已变更，请关闭并刷新后重试。") : (translatedError(failure.message) || t("操作失败，请重试。"))), "textContent");}}
    finally{state.busy=false;if(form.isConnected)form.querySelector('[type="submit"]').disabled=state.conflict;}
    return true;
  }
  function customerPage(){
    const customer=customerData.customer,stores=customerData.stores||[],visible=stores.filter(row=>customerDeleted||!row.deletedAt),activeStores=stores.filter(row=>!row.deletedAt).length;
    return `<div class="customer-back">${button(tx("中央厨房"),'accounts-kitchens','ghost','','arrow')}</div><div class="page-heading customer-heading"><div><h1>${esc(customer.name)}</h1><div class="customer-summary"><span>${esc((customer.ownerName || t("未填写负责人")))}</span><span>${esc((customer.contact || t("未填写联系方式")))}</span><span>${esc((customer.plan || t("标准版")))} · ${esc((customer.expiresOn || t("长期有效")))}</span><span class="account-status ${customer.active?'active':'disabled'}">${(customer.active ? tx("已启用") : tx("已停用"))}</span></div></div><div class="heading-actions">${button(tx("刷新"),'accounts-reload','secondary','','refresh')}</div></div><div class="customer-toolbar"><div class="customer-tabs" role="tablist" ${ta("aria-label", "客户资料")}><button type="button" role="tab" id="customer-tab-admins" aria-controls="customer-panel" aria-selected="${customerTab==='admins'}" data-action="accounts-customer-tab" data-tab="admins">${tx("员工管理")}</button><button type="button" role="tab" id="customer-tab-stores" aria-controls="customer-panel" aria-selected="${customerTab==='stores'}" data-action="accounts-customer-tab" data-tab="stores">${tx("合作门店")} <span>${activeStores}</span></button></div>${(customerTab==='stores' ? `<label class="accounts-check"><input type="checkbox" id="accounts-customer-deleted" ${customerDeleted?'checked':''}>${tx("含已删除门店{0}", [(stores.length>activeStores ? ' · '+(stores.length-activeStores) : '')])}</label>` : '')}${archivedToggle()}</div><div id="customer-panel" role="tabpanel" aria-labelledby="customer-tab-${customerTab}">${(customerTab==='stores' ? (visible.map(customerStore).join('') || `<section class="section-card accounts-empty"><h2>${tx("暂无门店")}</h2></section>`) : `<section class="section-card customer-store"><header class="customer-store-heading"><h2>${tx("管理端账号")}</h2><div class="customer-store-actions">${button(tx("负责人码"),'accounts-customer-key','secondary',`data-store="" ${!customerData.managementAccounts?.some(row=>row.accountRole==='owner'&&row.hasMaster)?'disabled':''}`,'copy')}${button(tx("员工管理"),'accounts-customer-team','ghost','data-store=""')}</div></header>${customerAccounts(customerData.managementAccounts)}</section>`)}</div>`;
  }
  function openCustomer(tenantId){if(!platformRead()||!tenantId)return;platformTeam=false;closeOverlay();tenant=tenantId;store='';section='customer';customerTab='admins';customerDeleted=false;reload();}
  function clearPasswordReset(){const form=document.getElementById('accounts-customer-password-form');form?.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});passwordReset=null;}
  function passwordResetForm(state=passwordReset){const form=document.getElementById('accounts-customer-password-form');return state&&passwordReset===state&&form?.dataset.account===state.accountId&&form.dataset.tenant===state.tenantId?form:null;}
  function openCustomerPassword(accountId,storeId=null){
    if(!platformOwner()||!customerSection()||!customerData)return;
    const row=customerAccount(accountId,storeId),targetStore=storeId?customerData.stores.find(item=>item.id===storeId):null;
    if(!row||row.accountRole!=='member'||row.deletedAt||targetStore?.deletedAt)return;
    modal(tx("重置管理员密码"),`<div class="customer-reset-identity"><strong>${esc((row.name||row.username || row.loginId))}</strong><code>${esc((row.username||row.loginId || ''))}</code><span>${esc((targetStore?.name || customerData.customer.name))} · ${(targetStore ? tx("门店端") : tx("管理端"))}</span></div><div class="field"><label for="customer-new-password">${tx("新密码")}</label><input class="input" id="customer-new-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><div class="field"><label for="customer-confirm-password">${tx("确认新密码")}</label><input class="input" id="customer-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><p class="form-hint">${tx("密码 12～128 个字符。原密码无法查看，重置后该管理员需重新登录。")}</p><p class="accounts-form-error" role="alert"></p>${button(tx("读取最新账号"),'accounts-customer-password-refresh','ghost','type="button" hidden')}`,footer('重置密码'),'accounts-customer-password-form');
    passwordReset={tenantId:tenant,storeId,accountId,version:row.version,busy:false,conflict:false};
    const form=document.getElementById('accounts-customer-password-form');form.dataset.account=accountId;form.dataset.tenant=tenant;
  }
  async function refreshCustomerPassword(){
    const state=passwordReset,form=passwordResetForm(state);if(!form||state.busy)return;
    state.busy=true;form.querySelector('[type="submit"]').disabled=true;
    try{const data=await request('/api/platform/customer?'+new URLSearchParams({tenant:state.tenantId}));if(!passwordResetForm(state))return;
      const targetStore=state.storeId?data.stores?.find(row=>row.id===state.storeId):null;
      const row=(state.storeId?targetStore?.accounts:data.managementAccounts)?.find(row=>row.id===state.accountId);
      if(!row||row.accountRole!=='member'||targetStore?.deletedAt){state.unavailable=true;throw new Error('此账号已不可修改，请关闭后刷新客户资料。');}
      state.version=row.version;state.conflict=false;customerData=data;
      setI18nText(form.querySelector('.customer-reset-identity strong'), () => (row.name||row.username||row.loginId || t("管理员")), "textContent");form.querySelector('.customer-reset-identity code').textContent=row.username||row.loginId||'';
      form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});
      setI18nText(form.querySelector('.accounts-form-error'), () => t("账号已更新，请重新填写并确认密码。"), "textContent");
      form.querySelector('[data-action="accounts-customer-password-refresh"]').hidden=true;
    }catch(error){if(passwordResetForm(state))form.querySelector('.accounts-form-error').textContent=translatedError(error.message);}
    finally{if(passwordResetForm(state)){state.busy=false;form.querySelector('[type="submit"]').disabled=!!state.unavailable;}}
  }
  async function saveCustomerPassword(form){
    const state=passwordReset;if(!platformOwner()||passwordResetForm(state)!==form||state.busy||state.unavailable)return;
    const password=form.elements.namedItem('password').value,confirmation=form.elements.namedItem('confirmPassword').value,errorNode=form.querySelector('.accounts-form-error');
    errorNode.textContent='';
    if(password.length<12||password.length>128){setI18nText(errorNode, () => t("密码需要 12～128 个字符。"), "textContent");return;}
    if(password!==confirmation){setI18nText(errorNode, () => t("两次输入的密码不一致。"), "textContent");return;}
    if(state.conflict){setI18nText(errorNode, () => t("请先读取最新账号，再确认重置。"), "textContent");return;}
    state.busy=true;form.setAttribute('aria-busy','true');form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';input.disabled=true;});
    try{const result=await request('/api/platform/staff/password',{tenantId:state.tenantId,storeId:state.storeId,accountId:state.accountId,version:state.version,password});if(!passwordResetForm(state))return;
      const rows=state.storeId?customerData?.stores?.find(row=>row.id===state.storeId)?.accounts:customerData?.managementAccounts,index=rows?.findIndex(row=>row.id===state.accountId);
      if(index>=0&&result.account)rows[index]=result.account;
      closeOverlay();render();toast('密码已重置，该管理员需重新登录。');
    }catch(error){if(passwordResetForm(state)){state.conflict=error.status===409;setI18nText(errorNode, () => String(translatedError(error.message)||'重置失败，请重试。').split(password).join('［已隐藏］'), "textContent");form.querySelector('[data-action="accounts-customer-password-refresh"]').hidden=!state.conflict;}}
    finally{if(passwordResetForm(state)){state.busy=false;form.setAttribute('aria-busy','false');form.querySelectorAll('input[type="password"]').forEach(input=>{input.disabled=false;});}}
  }
  async function showCustomerKey(storeId=null){
    if(!platformOwner()||!customerSection()||!customerData)return;
    const targetStore=storeId?customerData.stores.find(row=>row.id===storeId):null;
    if(storeId&&(!targetStore||targetStore.deletedAt||!targetStore.hasMaster))return;
    const targetTenant=tenant,id=epoch,result=await request('/api/team/master-key',{tenantId:targetTenant,storeId});
    if(id!==epoch||!customerSection()||tenant!==targetTenant)return;
    showMaster(result,{tenantId:targetTenant,storeId,canRotate:false});
  }
  function teamPage(){
    const accounts=team.accounts||[],rows=accounts.filter(row=>peopleDeleted||!row.deletedAt),stores=team.stores||[],used=accounts.filter(row=>!row.deletedAt&&row.accountRole==='member'&&row.status!=='disabled').length,selectedStore=stores.find(row=>row.id===team.storeId);
    const picker=principal.role==='platform'&&!platformTeam?`<div class="accounts-tenant-picker"><label for="accounts-tenant">${tx("中央厨房")}</label><select class="input" id="accounts-tenant">${((kitchens||[]).map(k=>`<option value="${esc(k.id)}" ${k.id===tenant?'selected':''}>${esc(k.name)}</option>`).join('') || `<option value="">${tx("暂无中央厨房")}</option>`)}</select></div>`:'';
    const own=principal.accountRole==='member'?button(tx("我的账号"),'accounts-profile','secondary'):'';
    const organization=team.organization||{},orgEditable=!platformTeam&&!team.storeId&&(principal.role==='platform'&&principal.accountRole==='owner'||principal.role==='admin'&&principal.accountRole==='owner');
    const orgAvatar=platformTeam?'':personAvatar({...organization,name:organization.name||'中央厨房'},{action:orgEditable?'accounts-organization-avatar':'',label:'修改厨房头像'});
    const scope=platformTeam?`<strong>${tx("平台端")}</strong>`:principal.role==='platform'?`<select class="input" id="accounts-store" ${ta("aria-label", "管理员所属组织")}><option value="">${tx("管理端管理员")}</option>${stores.map(item=>`<option value="${esc(item.id)}" ${item.id===team.storeId?'selected':''}>${tx("{0} · 门店管理员", [esc(item.name)])}</option>`).join('')}</select>`:`<strong>${esc((selectedStore?.name || (principal.role==='store' ? t("本门店") : t("管理端团队"))))}</strong>`;
    return heading((selectedStore&&principal.role==='admin' ? tx("门店员工管理") : tx("员工管理")),own+(team.canManage?button(tx("添加管理员"),'accounts-staff-new','primary','','plus'):''))+picker+(team.needsSetup?`<section class="section-card accounts-empty"><h2>${tx("请先开通中央厨房")}</h2>${(principal.role==='platform' ? button(tx("开通中央厨房"),'accounts-kitchen-new','primary') : '')}</section>`:`<section class="accounts-context"><div class="accounts-organization">${orgAvatar}<div><strong>${platformTeam?tx("平台端"):esc(organization.name)}</strong><span class="accounts-seat">${tx("负责人独立 · 管理员 {0} 人", [used])}</span></div></div><div class="accounts-scope">${scope}${(team.canManage&&!platformTeam ? button(tx("负责人码"),'accounts-scope-key','secondary','','copy') : '')}</div></section><section class="section-card accounts-table"><div class="section-header"><h2 class="section-title">${tx("{0} · 账号", [me((selectedStore?.name || mp(platformTeam?"平台端":"管理端")))])}</h2><div class="accounts-team-tools">${(team.canManage ? archivedToggle()+button(tx("操作记录"),'accounts-audit','ghost') : '')}</div></div><div class="table-scroll"><table><thead><tr><th>${tx("姓名 / 身份")}</th><th>${tx("账号名")}</th><th>${tx("联系方式")}</th><th>${tx("状态")}</th><th class="align-right">${tx("操作")}</th></tr></thead><tbody>${rows.map(row=>{
      const extra=`data-id="${esc(row.id)}" data-store="${esc(team.storeId||'')}"`;
      let actions=platformOwner()&&editableAvatar(row)?button(tx("编辑头像"),'accounts-person-avatar','ghost',extra):'';
      if(row.accountRole==='member'&&team.canManage)actions+=row.deletedAt?button(tx("恢复"),'accounts-staff-restore','secondary',extra):button(tx("编辑账号"),'accounts-staff-edit','secondary',extra)+button((row.status==='disabled' ? tx("启用") : tx("停用")),'accounts-staff-confirm','ghost',`${extra} data-operation="${row.status==='disabled'?'enable':'disable'}"`)+button(tx("删除"),'accounts-staff-delete','danger',extra);
      else if(row.id===(principal.userId||principal.id)&&row.accountRole==='member')actions+=button(tx("修改账号名与密码"),'accounts-profile','secondary');
      return `<tr data-member-id="${esc(row.id)}"><td><div class="account-person-cell">${personAvatar(row,{action:editableAvatar(row)?'accounts-person-avatar':'',extra})}<div><strong>${esc(row.name)}</strong><span class="cell-secondary">${(row.accountRole==='owner' ? tx("负责人") : tx("管理员"))}${(row.id===(principal.userId||principal.id) ? tx(" · 我") : '')}</span></div></div></td><td>${(row.accountRole==='owner' ? `<span class="muted">${tx(row.role==='platform'?"平台密钥登录":"负责人码登录")}</span>` : `<code>${esc(row.username)}</code>`)}</td><td>${esc((row.contact || '—'))}</td><td>${status(row)}</td><td class="accounts-actions"><div class="account-action-buttons">${(actions || '—')}</div></td></tr>`;
    }).join('')}</tbody></table></div></section>`);
  }
  function auditPage(){const labels={'ui.multilingual.enable':'启用多语言','ui.multilingual.disable':'停用多语言','flow.connection.update':'更新 Flow 模型连接','flow.feature.enable':'启用或配置 Flow','flow.feature.disable':'停用 Flow',submitOrder:'提交订单',addStore:'创建门店',updateStore:'修改门店',deleteStore:'删除门店',confirmPackLine:'确认配货',setPackLineDone:'更新配货勾选',setPackingNote:'修改配货备注',packLine:'修改配货数量',confirmDelivery:'确认送达',setStage:'更新履约状态',setPrice:'修改报价',setUnitQuote:'修改单位报价'};return heading(tx("操作记录"),button(tx("返回"),'accounts-back','secondary'))+`<section class="section-card accounts-table"><div class="table-scroll"><table><thead><tr><th>${tx("操作人")}</th><th>${tx("操作")}</th><th>${tx("时间")}</th></tr></thead><tbody>${(events.map(row=>`<tr><td>${esc(row.actor_name)}</td><td>${labels[row.action]?tx(labels[row.action]):esc(row.action)}</td><td>${new Date(row.created_at*1000).toLocaleString(getLocale())}</td></tr>`).join('') || `<tr><td colspan="3" class="accounts-empty">${tx("暂无操作记录")}</td></tr>`)}</tbody></table></div></section>`;}
  function kitchenForm(id='',edit=false){const row=kitchens?.find(r=>r.id===id)||{},saved=recovered&&recovered.id===id?recovered:{};modal((edit ? tx("中央厨房设置") : tx("开通中央厨房")),`<input type="hidden" name="tenantId" value="${esc(id)}"><input type="hidden" name="operation" value="${edit?'edit':'create'}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div class="form-grid">${(!edit ? `<div class="field-full">${field(tx("中央厨房名称"),'name',saved.name||row.name||'','required maxlength="80"')}</div>` : '')}${field(tx("负责人姓名"),'ownerName',saved.ownerName||row.owner_name||'','required maxlength="80"')}${field(tx("联系方式"),'contact',saved.contact||row.contact||'','maxlength="120"')}${field(tx("套餐名称"),'plan',row.plan||'标准版','required maxlength="40"')}${field(tx("有效期至"),'expiresOn',row.expires_on||'','type="date"')}${(edit ? `<label class="accounts-check field-full"><input name="active" type="checkbox" ${row.active===1?'checked':''}>${tx("启用此中央厨房")}</label>` : '')}</div><p class="form-hint">${tx("管理员人数不限。")}</p><p class="accounts-form-error" role="alert"></p>`,footer(edit?'保存':'开通并生成负责人码'),'accounts-kitchen-form');}
  function staffForm(id=''){const row=team.accounts.find(r=>r.id===id)||{};modal((id ? tx("编辑管理员") : tx("添加管理员")),`<input type="hidden" name="accountId" value="${esc(id)}"><input type="hidden" name="version" value="${row.version??0}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div class="form-grid">${field(tx("账号名"),'username',row.username||'','required minlength="3" maxlength="32" autocomplete="off"')}${field((id ? tx("新密码（留空保留）") : tx("密码")),'password','','type="password" autocomplete="new-password" minlength="12" maxlength="128" '+(id?'':'required'))}${field(tx("姓名"),'name',row.name||'','maxlength="80"')}${field(tx("联系方式"),'contact',row.contact||'','maxlength="120"')}</div><p class="form-hint">${tx("账号名全平台唯一。密码 12～128 个字符，管理员登录后可自行修改。")}</p><p class="accounts-form-error" role="alert"></p>`,footer(id?'保存修改':'创建管理员'),'accounts-staff-form');}
  function showMaster(result,scope={}){handoff={...scope,...result};const role=result.account.role;modal(tx("负责人登录码"),`<div class="account-handoff"><h3>${esc(result.account.name)}</h3><label for="account-master-code">${tx("16 位负责人码")}</label><div class="account-master-code-row"><input class="input account-master-input" id="account-master-code" readonly value="${esc(result.masterCode)}"><button class="icon-button" data-action="accounts-copy-master" ${ta("aria-label", "复制负责人码")}>${icon('copy')}</button></div><p>${tx("使用此码登录{0}，无需额外密码。", [(role==='store' ? mp("门店端") : mp("管理端"))])}</p>${(principal.role==='platform' ? `<a class="text-button" href="/?login=${role==='store'?'store':'kitchen'}" target="_blank" rel="noopener">${tx("打开登录入口 {0}", [icon('arrow')])}</a>` : '')}</div>`,button(tx("完成"),'close','secondary')+button(tx("复制登录信息"),'accounts-copy-handoff','primary','','copy')+(scope.canRotate?button(tx("重置负责人码"),'accounts-master-reset-confirm','ghost'):''));}
  async function copy(value){try{await navigator.clipboard.writeText(value);toast('已复制。');}catch{modal(tx("复制信息"),`<textarea class="input account-copy-text" readonly>${esc(value)}</textarea>`,button(tx("关闭"),'close','secondary'));const input=document.querySelector('.account-copy-text');input.focus();input.select();}}
  async function showScopeKey(targetTenant=tenant||principal.tenantId,targetStore=store||principal.storeId||null){const result=await request('/api/team/master-key',{tenantId:targetTenant,storeId:targetStore});showMaster(result,{tenantId:targetTenant,storeId:targetStore,canRotate:principal.role==='platform'||principal.role==='admin'&&!!targetStore});}
  function clearFlowConfig() {
    const input=document.getElementById('accounts-flow-token');
    if(input)input.value='';
    flowConfig=null;
  }
  function flowForm(state=flowConfig) {
    const form=document.getElementById('accounts-flow-form');
    return state&&flowConfig===state&&form?.dataset.tenant===state.tenantId?form:null;
  }
  function safeFlowConfig(data) {
    const connection=data.connection||{};
    return {
      version:Number(data.version)||0,
      enabled:data.flow?.enabled===true,
      multilingualEnabled:data.multilingual?.enabled===true,
      portals:createPortalFeatureDraft(data),
      model:String(data.flow?.model||connection.model||''),
      configured:connection.configured===true||connection.hasToken===true,
      models:Array.isArray(connection.models)?connection.models.filter(row=>typeof row.id==='string').map(row=>({id:row.id,name:String(row.name||row.id)})):[],
      fetchedAt:connection.fetchedAt||null,
      stale:connection.stale===true||connection.cacheState==='stale',
      cacheState:connection.cacheState||'',
      message:String(connection.refreshError||connection.message||''),
    };
  }
  function readFlowDraft(state) {
    const form=flowForm(state);if(!form)return;
    state.enabled=form.elements.namedItem('flowEnabled').checked;
    if(state.tenantId!=='@platform'){state.portals=readPortalFeatureFields(form,{portals:state.portals});state.enabled=state.portals.admin.flowEnabled;state.multilingualEnabled=state.portals.admin.multilingualEnabled;}
    state.model=form.elements.namedItem('flowModel').value;
  }
  function patchFlowForm(state) {
    const form=flowForm(state);if(!form)return;
    const data=state.data,enabled=form.elements.namedItem('flowEnabled'),model=form.elements.namedItem('flowModel');
    const locked=!!state.busy||!data;
    form.setAttribute('aria-busy',String(!!state.busy));
    if(state.tenantId==='@platform'){
      enabled.disabled=locked;enabled.checked=state.enabled;
      enabled.setAttribute('aria-checked',String(state.enabled));
      setI18nText(form.querySelector('[data-flow-toggle-label]'), () => (state.enabled ? t("已启用") : t("已停用")), "textContent");
    }else patchPortalFeatureFields(form,state.portals,{disabled:locked});
    const connectionState=form.querySelector('[data-flow-connection-state]');
    setI18nText(connectionState, () => (!data ? t("正在读取") : (data.configured ? t("已配置") : t("未配置"))), "textContent");
    connectionState.classList.toggle('active',!!data?.configured);
    const token=form.querySelector('#accounts-flow-token');token.disabled=locked;
    setI18nText(token, () => (data?.configured ? t("粘贴新 Token 以更换连接") : 'gho_…'), "placeholder");
    form.querySelector('[data-action="accounts-flow-connect"]').disabled=locked;
    setI18nText(form.querySelector('[data-action="accounts-flow-connect"]'), () => (state.busy==='connect' ? t("正在验证连接…") : t("连接并读取模型")), "textContent");
    form.querySelector('[data-action="accounts-flow-refresh"]').disabled=locked||!data?.configured;
    form.querySelector('[data-action="accounts-flow-refresh"]').classList.toggle('is-loading',state.busy==='refresh');
    const available=data?.models||[],missing=state.model&&!available.some(row=>row.id===state.model);
    const options=`<option value="">${(data?.configured ? tx("选择模型") : tx("请先连接 GitHub Copilot"))}</option>`+(missing?`<option value="${esc(state.model)}" disabled>${tx("{0} · 未在当前目录中", [esc(state.model)])}</option>`:'')+available.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');
    if(model.dataset.options!==options){model.innerHTML=options;model.dataset.options=options;}
    model.value=state.model;model.disabled=locked||!available.length;
    model.setAttribute('aria-invalid',String(!!missing));
    setI18nText(form.querySelector('[data-flow-saved-model]'), () => (data?.model ? t("当前模型：{0}", [available.find(row=>row.id===data.model)?.name||data.model]) : t("尚未指定模型")), "textContent");
    const catalogue=form.querySelector('[data-flow-catalogue-status]');
    let time='';
    if(data?.fetchedAt){const date=new Date(data.fetchedAt);if(Number.isFinite(date.getTime()))time=date.toLocaleString(getLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
    setI18nText(catalogue, () => (state.busy==='refresh' ? t("正在向 GitHub 读取最新模型…") : (data?.fetchedAt ? t("{0} · {1} · {2} 个模型", [data.stale?'缓存目录':data.cacheState==='cached'?'最近目录':'已更新', time, available.length]) : (data?.configured ? t("模型目录尚未读取成功") : t("连接后读取可用模型")))), "textContent");
    catalogue.classList.toggle('is-stale',!!data?.stale);
    setI18nText(form.querySelector('[data-flow-connection-message]'),()=>translatedError(data?.message||''));
    form.querySelector('.accounts-form-error').textContent=state.error||'';
    form.querySelector('[data-action="accounts-flow-reload"]').hidden=!state.error;
    form.querySelector('[type="submit"]').disabled=locked;
  }
  async function loadFlowConfig(state,{refresh=false}={}) {
    if(!flowForm(state)||state.busy)return;
    if(state.data)readFlowDraft(state);
    state.busy=refresh?'refresh':'load';state.error='';patchFlowForm(state);
    try {
      const result=await request(refresh?'/api/platform/flow/models':'/api/platform/flow?'+new URLSearchParams({tenant:state.tenantId}),refresh?{tenantId:state.tenantId}:undefined);
      if(!flowForm(state))return;
      const first=!state.data;state.data=safeFlowConfig(result);
      if(first){state.enabled=state.data.enabled;state.model=state.data.model;state.multilingualEnabled=state.data.multilingualEnabled;state.portals=state.data.portals;}
    }catch(error){if(flowForm(state))state.error=translatedError(error.message);}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function openFlowConfig(tenantId) {
    if(!platformOwner())return;
    const row=tenantId==='@platform'?{name:t('平台端')}:kitchens?.find(item=>item.id===tenantId);if(!row)return;
    modal(tx("功能配置"),`<div class="accounts-flow-customer">${esc(row.name)}</div>${tenantId==='@platform'?`<div class="accounts-feature-row"><div><h3>Flow AI</h3></div><label class="accounts-feature-switch"><span data-flow-toggle-label>${tx("已停用")}</span><input id="accounts-flow-enabled" name="flowEnabled" type="checkbox" role="switch" ${ta("aria-label", "启用 Flow AI")} aria-checked="false" disabled><span class="accounts-switch-track" aria-hidden="true"></span></label></div>`:renderPortalFeatureFields()}<section class="accounts-flow-connection"><div class="accounts-flow-section-heading"><h3>GitHub Copilot</h3><span class="account-status" data-flow-connection-state>${tx("正在读取")}</span></div><div class="field"><label for="accounts-flow-token">GitHub Token</label><div class="accounts-flow-token-row"><input class="input" id="accounts-flow-token" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" aria-describedby="accounts-flow-token-hint" placeholder="gho_…" maxlength="1024" disabled>${button(tx("连接并读取模型"),'accounts-flow-connect','secondary','type="button" disabled')}</div><p id="accounts-flow-token-hint" class="accounts-flow-caption">${tx("保存后不再显示 Token；留空保留当前连接。")}</p></div><div class="field"><div class="accounts-flow-model-label"><label for="accounts-flow-model">${tx("运行模型")}</label>${button(tx("刷新模型"),'accounts-flow-refresh','ghost','type="button" disabled','refresh')}</div><select class="input" id="accounts-flow-model" name="flowModel" aria-describedby="accounts-flow-catalogue-status" disabled><option value="">${tx("正在读取")}</option></select><p id="accounts-flow-catalogue-status" class="accounts-flow-caption" data-flow-catalogue-status></p><p class="accounts-flow-caption" data-flow-saved-model></p></div><p class="accounts-flow-warning" data-flow-connection-message role="status"></p></section><p class="accounts-form-error" role="alert"></p>${button(tx("读取最新配置"),'accounts-flow-reload','ghost','type="button" hidden')}`,footer('保存功能设置'),'accounts-flow-form');
    const state={tenantId,data:null,enabled:false,multilingualEnabled:false,portals:createPortalFeatureDraft(),model:'',busy:'',error:''};
    flowConfig=state;document.getElementById('accounts-flow-form').dataset.tenant=tenantId;
    await loadFlowConfig(state);
  }
  async function connectFlowConfig(state=flowConfig) {
    const form=flowForm(state);if(!form||state.busy||!state.data)return;
    const input=form.querySelector('#accounts-flow-token'),token=input.value.trim();
    input.value='';
    if(!token){state.error='请粘贴 GitHub Token。';patchFlowForm(state);input.focus();return;}
    readFlowDraft(state);state.busy='connect';state.error='';patchFlowForm(state);
    try {
      const result=await request('/api/platform/flow/connection',{tenantId:state.tenantId,token});
      if(!flowForm(state))return;
      state.data=safeFlowConfig(result);
      toast('GitHub Copilot 已连接，模型目录已更新。');
    }catch(error){if(flowForm(state))state.error=String(translatedError(error.message)).replaceAll(token,'[已隐藏]');}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function saveFlowConfig(form) {
    const state=flowConfig;if(!state||flowForm(state)!==form||state.busy||!state.data)return;
    readFlowDraft(state);
    form.querySelector('#accounts-flow-token').value='';
    const flowChanged=state.enabled!==state.data.enabled||state.model!==state.data.model||state.tenantId!=='@platform'&&state.portals.store.flowEnabled!==state.data.portals.store.flowEnabled;
    if(flowChanged&&(state.enabled||state.tenantId!=='@platform'&&state.portals.store.flowEnabled)&&(!state.data.configured||!state.model)){state.error=!state.data.configured?'请先连接 GitHub Copilot。':'请选择运行模型。';patchFlowForm(state);return;}
    state.busy='save';state.error='';patchFlowForm(state);
    try {
      await request('/api/platform/flow',{tenantId:state.tenantId,version:state.data.version,model:flowChanged?(state.model||null):null,...(state.tenantId==='@platform'?{enabled:state.enabled}:serializePortalFeatureFields(state.portals))});
      if(!flowForm(state))return;
      closeOverlay();ctx.onFeatureChange?.(state.tenantId);toast('功能配置已保存。');
    }catch(error){if(flowForm(state))state.error=translatedError(error.message);}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function handleAction(action,el){if(!action.startsWith('accounts-'))return false;if(principal.role==='platform'&&!platformOwner()&&ownerActions.has(action))return true;if(action.startsWith('accounts-avatar-'))return avatarEditor.handleAction(action,el);const id=el.dataset.id;
    if(action==='accounts-self-avatar')openAccountAvatar({...principal,id:principal.userId||principal.id,name:principal.displayName||principal.name});
    if(action==='accounts-person-avatar')openAccountAvatar(team?.accounts.find(row=>row.id===id));
    if(action==='accounts-customer-avatar'&&platformOwner()&&customerSection()){const targetStore=el.dataset.store?customerData.stores.find(row=>row.id===el.dataset.store):null;if(!targetStore?.deletedAt)openAccountAvatar(customerAccount(id,el.dataset.store||null));}
    if(action==='accounts-organization-avatar')openOrganizationAvatar(team?.organization);

    if(action==='accounts-reload')reload();
    if(action==='accounts-kitchens'){platformTeam=false;section='kitchens';tenant='';store='';reload();}
    if(action==='accounts-kitchen-new')kitchenForm(el.dataset.tenant||'');
    if(action==='accounts-kitchen-customer')openCustomer(el.dataset.tenant);
    if(action==='accounts-customer-tab'&&section==='customer'){customerTab=el.dataset.tab==='admins'?'admins':'stores';render();}
    if(action==='accounts-customer-view'){customerView=el.dataset.view==='card'?'card':'list';render();}
    if(action==='accounts-directory-view'){directoryView=el.dataset.view==='list'?'list':'card';render();}
    if(action==='accounts-customer-store-detail')openCustomerStoreDetail(el.dataset.store);
    if(action==='accounts-customer-key')await showCustomerKey(el.dataset.store||null);
    if(action==='accounts-customer-password')openCustomerPassword(id,el.dataset.store||null);
    if(action==='accounts-customer-password-refresh')await refreshCustomerPassword();
    if(action==='accounts-staff-delete'||action==='accounts-staff-restore')openMemberLifecycle(id,el.dataset.store||null,action==='accounts-staff-restore'?'restore':'delete');
    if(action==='accounts-customer-team'&&platformRead()&&customerSection()){store=el.dataset.store||'';if(!store||customerData.stores.some(row=>row.id===store&&!row.deletedAt)){section='team';reload();}}
    if(action==='accounts-kitchen-features')await openFlowConfig(el.dataset.tenant);
    if(action==='accounts-flow-connect')await connectFlowConfig();
    if(action==='accounts-flow-refresh')await loadFlowConfig(flowConfig,{refresh:true});
    if(action==='accounts-flow-reload')await loadFlowConfig(flowConfig);
    if(action==='accounts-kitchen-edit')kitchenForm(el.dataset.tenant,true);
    if(action==='accounts-kitchen-team'){platformTeam=false;tenant=el.dataset.tenant;store='';section='team';reload();}
    if(action==='accounts-kitchen-key')await showScopeKey(el.dataset.tenant,null);
    if(action==='accounts-scope-key')await showScopeKey();
    if(action==='accounts-staff-new')staffForm();
    if(action==='accounts-staff-edit')staffForm(id);
    if(action==='accounts-audit'){section='audit';reload();}
    if(action==='accounts-back'){section=principal.role==='platform'&&!tenant&&!platformTeam?'kitchens':'team';reload();}
    if(action==='accounts-copy-master'&&handoff)await copy(handoff.masterCode);
    if(action==='accounts-copy-handoff'&&handoff)await copy(`${handoff.account.name}\n负责人码：${handoff.masterCode}\n登录入口：${location.origin}/?login=${handoff.account.role==='store'?'store':'kitchen'}\n选择负责人登录，无需额外密码。`);
    if(action==='accounts-master-reset-confirm'&&handoff)modal(tx("重置负责人码"),`<p>${tx("重置后旧码与该负责人的登录会话立即失效，管理员账号保持可用。")}</p>`,button(tx("取消"),'close','secondary')+button(tx("确认重置"),'accounts-master-reset','danger'));
    if(action==='accounts-master-reset'&&handoff){const result=await request('/api/team/master-key',{tenantId:handoff.tenantId,storeId:handoff.storeId,rotate:true});showMaster(result,handoff);}
    if(action==='accounts-staff-confirm'){const row=team.accounts.find(r=>r.id===id),operation=el.dataset.operation;modal((operation==='disable' ? tx("停用管理员") : tx("启用管理员")),`<p>${esc(row.name)} · ${esc(row.username)}</p><p>${(operation==='disable' ? tx("停用后立即退出登录，历史操作记录保留。") : tx("启用后可以使用原账号名和密码登录。"))}</p>`,button(tx("取消"),'close','secondary')+button(tx("确认"),'accounts-staff-update','primary',`data-id="${esc(id)}" data-operation="${operation}" data-version="${row.version??0}"`));}
    if(action==='accounts-staff-update'){await request('/api/team/update',{accountId:id,version:Number(el.dataset.version),action:el.dataset.operation});closeOverlay();reload();toast('账号状态已更新。');}
    if(action==='accounts-profile')modal(tx("我的账号"),`${field(tx("账号名"),'username',principal.username||principal.loginId||'','required minlength="3" maxlength="32" autocomplete="username"')}${field(tx("姓名"),'name',principal.name||principal.displayName||'','required maxlength="80"')}${field(tx("联系方式"),'contact',principal.contact||'','maxlength="120"')}${field(tx("当前密码"),'oldPassword','','type="password" autocomplete="current-password" required maxlength="128"')}${field(tx("新密码（留空保留）"),'password','','type="password" autocomplete="new-password" minlength="12" maxlength="128"')}${field(tx("确认新密码"),'confirmPassword','','type="password" autocomplete="new-password" maxlength="128"')}<p class="form-hint">${tx("修改账号名或密码后需要重新登录。")}</p><p class="accounts-form-error" role="alert"></p>`,footer('保存并重新登录'),'accounts-profile-form');
    return true;
  }
  async function handleSubmit(form){const formId=form.getAttribute('id');if(!formId?.startsWith('accounts-'))return false;if(formId==='accounts-member-lifecycle-form')return await saveMemberLifecycle(form);if(formId==='accounts-avatar-form'){return await avatarEditor.handleSubmit(form);}if(formId==='accounts-flow-form'){await saveFlowConfig(form);return true;}if(formId==='accounts-customer-password-form'){await saveCustomerPassword(form);return true;}const data=Object.fromEntries(new FormData(form));try{
    if(formId==='accounts-kitchen-form'){const result=await request(data.operation==='edit'?'/api/platform/update':'/api/platform/create',{...data,active:form.elements.namedItem('active')?.checked,...(data.tenantId?{existingTenantId:data.tenantId}:{})});recovered=null;closeOverlay();if(result.tenantId){tenant=result.tenantId;store='';section='team';}reload();if(result.masterCode)showMaster(result,{tenantId:result.tenantId,storeId:null,canRotate:true});else toast('客户资料已保存。');}
    if(formId==='accounts-staff-form'){await request(data.accountId?'/api/team/update':'/api/team/create',{...data,version:data.accountId?Number(data.version):undefined,action:'edit',tenantId:platformTeam?null:tenant||principal.tenantId,storeId:store||principal.storeId||null});closeOverlay();reload();toast(data.accountId?'管理员已更新。':'管理员已创建，可直接登录。');}
    if(formId==='accounts-profile-form'){if(data.password&&data.password!==data.confirmPassword)throw new Error('两次输入的密码不一致。');await request('/api/accounts/profile',{username:data.username,name:data.name,contact:data.contact,oldPassword:data.oldPassword,password:data.password});location.href='/?login='+(principal.role==='platform'?'platform':principal.role==='store'?'store':'kitchen')+'&tab=admin';}
  }catch(error){const node=form.querySelector('.accounts-form-error');if(node)node.textContent=translatedError(error.message);throw error;}return true;}
  function handleChange(input){if(input.id==='accounts-store-tenant'&&platformRead()&&section==='stores'){tenant=input.value;store='';reload();return true;}if(input.id==='accounts-archived'){peopleDeleted=input.checked;render();return true;}if(input.id==='accounts-customer-deleted'&&customerSection()){customerDeleted=input.checked;render();return true;}if(input.closest?.('#accounts-flow-form')&&['flowEnabled','flowModel','multilingualEnabled','adminNotificationsEnabled','storeFlowEnabled','storeMultilingualEnabled','storeNotificationsEnabled'].includes(input.name)){const state=flowConfig;if(flowForm(state)){readFlowDraft(state);state.error='';patchFlowForm(state);}return true;}if(input.id==='accounts-store'){if(principal.role!=='platform')return false;store=input.value;reload();return true;}if(input.id==='accounts-tenant'){tenant=input.value;store='';reload();return true;}return false;}
  function search(value){query=value;render();document.getElementById('accounts-search')?.focus();}
  return {page,handleAction,handleSubmit,handleChange,search,onOverlayClose:()=>{clearFlowConfig();clearPasswordReset();avatarEditor.dispose();lifecycle=null;},openAudit:()=>{section='audit';reload();},openKitchens:()=>{platformTeam=false;section='kitchens';reload();},openOrganizationAvatar,openStores,openCustomer,openPlatformFlowConfig:()=>openFlowConfig('@platform'),openPlatformTeam:()=>{if(!platformRead())return;platformTeam=true;section='team';tenant='';store='';reload();},openOwnTeam:()=>{platformTeam=principal.role==='platform';section='team';tenant='';store='';reload();},openStoreTeam:storeId=>{if(principal.role!=='admin'||principal.accountRole!=='owner'||!storeId)return;section='team';tenant='';store=storeId;reload();},openTeam:()=>{platformTeam=false;section='team';if(principal.role!=='platform'){tenant='';store='';}reload();}};
}
