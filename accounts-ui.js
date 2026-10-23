import {createAvatarEditor,safeAvatarUrl} from './avatar-editor.js';

export function createAccountsUI(ctx) {
  const {request,principal,escape:esc,button,icon,modal,closeOverlay,toast,render}=ctx;
  let kitchens=null,team=null,events=null,loading=false,error='',tenant='',store='',section=principal.role==='platform'?'kitchens':'team',query='',handoff=null,epoch=0;
  let recovered=ctx.recoveredDraft||null,flowConfig=null,customerData=null,customerTab='stores',customerDeleted=false,passwordReset=null,peopleDeleted=false,lifecycle=null;
  let customerView='list', directoryView='card';
  const field=(label,name,value='',extra='')=>`<div class="field"><label for="account-${name}">${label}</label><input class="input" id="account-${name}" name="${name}" value="${esc(value)}" ${extra}></div>`;
  const heading=(title,actions='')=>`<div class="page-heading accounts-page-heading"><h1>${title}</h1><div class="heading-actions">${actions}</div></div>`;
  const footer=label=>button('取消','close','secondary','type="button"')+`<button type="submit" class="btn btn-primary">${label}</button>`;
  const personAvatar=(row,{action='',extra='',label=''}={})=>{
    const url=safeAvatarUrl(row?.avatarUrl),name=row?.name||row?.displayName||'用户';
    const contents=url?`<img src="${esc(url)}" alt="${esc(name)}的头像" loading="lazy">`:`<span aria-hidden="true">${esc(name.slice(0,1))}</span>`;
    return action?`<button type="button" class="account-avatar account-avatar-button" data-action="${action}" ${extra} aria-label="${esc(label||'修改'+name+'的头像')}" title="修改头像">${contents}</button>`:`<span class="account-avatar">${contents}</span>`;
  };
  const editableAvatar=row=>Boolean(row&&!row.deletedAt&&(row.id===(principal.userId||principal.id)||principal.role==='platform'&&principal.accountRole==='owner'||team?.canManage&&principal.accountRole==='owner'));
  const customerSection=()=>section==='customer'||section==='stores';
  const archivedToggle=()=>`<label class="accounts-check accounts-archived"><input type="checkbox" id="accounts-archived" ${peopleDeleted?'checked':''}>含已删除管理员</label>`;
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
  const status=row=>`<span class="account-status ${row.deletedAt?'disabled':row.status}">${row.deletedAt?'已删除':({active:'已启用',disabled:'已停用',pending:'待设置密码'}[row.status]||'未开通')}</span>`;
  async function load() {
    if(loading)return;loading=true;error='';const id=++epoch;
    try {
      if(principal.role==='platform'&&['kitchens','team','stores'].includes(section)){
        const rows=(await request('/api/platform/kitchens')).kitchens;if(id!==epoch)return;kitchens=rows;
        if(['team','stores'].includes(section)&&!rows.some(row=>row.id===tenant))tenant=rows[0]?.id||'';
      }
      if(section==='team') {const data=tenant||principal.role!=='platform'?await request('/api/team/list?'+new URLSearchParams({...(tenant?{tenant}:{}),...(store?{store}:{})})):{accounts:[],stores:[],canManage:false,needsSetup:true,limit:3};if(id!==epoch)return;team=data;const me=data.accounts?.find(row=>row.id===(principal.userId||principal.id));if(me&&Object.hasOwn(me,'avatarUrl')){Object.assign(principal,{avatarUrl:me.avatarUrl,avatarVersion:me.avatarVersion});ctx.onProfileChange?.({account:me});}if(principal.role==='admin'&&!data.storeId&&Object.hasOwn(data.organization||{},'avatarUrl')){principal.organizationAvatarUrl=data.organization.avatarUrl;principal.organizationAvatarVersion=data.organization.avatarVersion;ctx.onProfileChange?.({organization:data.organization});}}
      if(customerSection()&&platformOwner()){const data=tenant?await request('/api/platform/customer?'+new URLSearchParams({tenant})):{customer:null,stores:[],managementAccounts:[]};if(id!==epoch)return;customerData=data;if(section==='stores')ctx.onDirectoryChange?.(tenant);}
      if(section==='audit'){const data=await request('/api/team/audit'+(tenant?'?tenant='+encodeURIComponent(tenant):''));if(id!==epoch)return;events=data.events;}
    }catch(e){if(id===epoch)error=e.message;}finally{if(id===epoch){loading=false;render();}}
  }
  function reload(){epoch++;loading=false;team=null;events=null;kitchens=null;customerData=null;error='';ctx.onSectionChange?.(section);render();}
  function page(){const ready=section==='kitchens'?kitchens:section==='audit'?events:customerSection()?customerData:team;if(!ready){if(!loading&&!error)queueMicrotask(load);return `<section class="section-card accounts-empty"><h2>${error?'读取失败':section==='stores'?'正在读取门店':'正在读取账号'}</h2>${error?`<p>${esc(error)}</p>${button('重试','accounts-reload','secondary')}`:''}</section>`;}return section==='kitchens'?kitchenPage():section==='audit'?auditPage():section==='customer'?customerPage():section==='stores'?storesDirectoryPage():teamPage();}
  const directoryViewSwitch=(kind,view,label)=>`<div class="view-switch accounts-view-switch" role="group" aria-label="${label}">${['list','card'].map(key=>`<button type="button" class="${view===key?'active':''}" aria-pressed="${view===key}" data-action="accounts-${kind}-view" data-view="${key}">${key==='list'?'列表':'卡片'}</button>`).join('')}</div>`;
  const cardField=(label,value)=>`<div><span>${label}</span><strong>${esc(value||'—')}</strong></div>`;
  const directoryAvatar=(name,url)=>`<div class="store-avatar${url?' store-photo':''}">${url?`<img src="${esc(url)}" alt="${esc(name)}" loading="lazy">`:esc(name.slice(0,1))}</div>`;
  function kitchenActions(row){
    const extra=`data-tenant="${esc(row.id)}"`;
    return button('负责人码','accounts-kitchen-key','secondary',extra)+button('员工管理','accounts-kitchen-team','secondary',extra)+button('功能配置','accounts-kitchen-features','secondary',extra);
  }
  function kitchenCard(row){
    return `<article class="store-card" data-customer-card="${esc(row.id)}">
      <header class="store-card-heading">${directoryAvatar(row.name,safeAvatarUrl(row.avatarUrl))}<div class="store-card-identity"><h3><button class="directory-name-link" data-action="accounts-kitchen-customer" data-tenant="${esc(row.id)}">${esc(row.name)}</button></h3><span class="store-city">中央厨房</span></div><div class="store-card-tools"><button type="button" class="icon-button" data-action="accounts-kitchen-edit" data-tenant="${esc(row.id)}" aria-label="设置${esc(row.name)}" title="设置">${icon('edit')}</button><span class="account-status ${row.active===1?'active':'disabled'}">${row.active===1?'已启用':'已停用'}</span></div></header>
      <div class="store-card-info">${cardField('负责人',row.owner_name)}${cardField('联系方式',row.contact)}${cardField('套餐',row.plan||'标准版')}${cardField('有效期',row.expires_on||'长期有效')}${cardField('管理员',`${row.seats} / 3`)}</div>
      <footer class="store-card-footer">${kitchenActions(row)}</footer>
    </article>`;
  }
  function kitchenPage(){
    const rows=kitchens.filter(row=>[row.name,row.owner_name,row.contact].join(' ').toLowerCase().includes(query.toLowerCase()));
    const cards=`<div class="stores-grid platform-directory-grid">${rows.map(kitchenCard).join('')||'<section class="section-card accounts-empty"><h2>暂无中央厨房</h2></section>'}</div>`;
    const table=`<section class="section-card accounts-table"><div class="table-scroll"><table><thead><tr><th>中央厨房</th><th>负责人</th><th>套餐 / 有效期</th><th>管理员</th><th>状态</th><th class="align-right">操作</th></tr></thead><tbody>${rows.map(row=>`<tr><td><div class="account-person-cell">${personAvatar({...row,name:row.name})}<button class="customer-name-link" data-action="accounts-kitchen-customer" data-tenant="${esc(row.id)}"><strong>${esc(row.name)}</strong><span>门店与账号 ${icon('arrow')}</span></button></div></td><td>${esc(row.owner_name||'—')}<span class="cell-secondary">${esc(row.contact||'')}</span></td><td>${esc(row.plan||'标准版')}<span class="cell-secondary">${esc(row.expires_on||'长期有效')}</span></td><td>${row.seats} / 3</td><td><span class="account-status ${row.active===1?'active':'disabled'}">${row.active===1?'已启用':'已停用'}</span></td><td class="accounts-actions">${kitchenActions(row)}${button('设置','accounts-kitchen-edit','ghost',`data-tenant="${esc(row.id)}"`)}</td></tr>`).join('')||'<tr><td colspan="6" class="accounts-empty">暂无中央厨房</td></tr>'}</tbody></table></div></section>`;
    return heading('中央厨房',button('开通中央厨房','accounts-kitchen-new','primary','','plus'))+`<div class="accounts-summary"><div><span>客户总数</span><strong>${kitchens.length}</strong></div><div><span>已启用</span><strong>${kitchens.filter(k=>k.active===1).length}</strong></div></div><section class="accounts-directory"><div class="accounts-directory-toolbar"><h2 class="section-title">客户列表</h2><div class="accounts-list-tools"><input class="input accounts-search" id="accounts-search" aria-label="搜索中央厨房" placeholder="搜索名称、负责人" value="${esc(query)}">${directoryViewSwitch('customer',customerView,'客户列表视图')}</div></div>${customerView==='card'?cards:table}</section>`;
  }
  const platformOwner=()=>principal.role==='platform'&&principal.accountRole==='owner'&&!principal.tenantId&&!principal.storeId;
  const displayDate=value=>{if(!value)return '—';const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';};
  const customerAccount=(accountId,storeId=null)=>((storeId?customerData?.stores?.find(item=>item.id===storeId)?.accounts:customerData?.managementAccounts)||[]).find(item=>item.id===accountId);
  function customerAccounts(accounts=[],storeId=null,deleted=false){
    const rows=accounts.filter(row=>peopleDeleted||!row.deletedAt),scope=`data-store="${esc(storeId||'')}"`;
    return `<div class="customer-account-list"><div class="customer-account-head" aria-hidden="true"><span>姓名 / 身份</span><span>账号名 / 密码</span><span>联系方式</span><span>状态 / 最近登录</span><span>操作</span></div>${rows.map(row=>{
      const canEdit=!deleted&&!row.deletedAt&&platformOwner(),extra=`data-id="${esc(row.id)}" ${scope}`;
      const actions=(canEdit?button('编辑头像','accounts-customer-avatar','ghost',extra):'')+(row.accountRole==='member'?(!row.deletedAt?button('重置密码','accounts-customer-password','secondary',`${extra} ${deleted?'disabled':''}`):'')+button(row.deletedAt?'恢复':'删除',row.deletedAt?'accounts-staff-restore':'accounts-staff-delete',row.deletedAt?'secondary':'danger',`${extra} ${deleted?'disabled':''}`):'');
      return `<article class="customer-account-row" data-member-id="${esc(row.id)}"><div class="customer-account-person"><div class="account-person-cell">${personAvatar(row,{action:canEdit?'accounts-customer-avatar':'',extra})}<div class="customer-account-name"><strong>${esc(row.name||'未填写姓名')}</strong><span>${row.accountRole==='owner'?'负责人':'管理员'}</span></div></div></div><div class="customer-account-login">${row.accountRole==='owner'?'<span>负责人码登录，无密码</span>':`<code>${esc(row.username||row.loginId||'—')}</code><span>密码${row.hasPassword?'已设置':'待设置'}</span>`}</div><div class="customer-account-contact"><span class="customer-mobile-label">联系方式</span>${esc(row.contact||'—')}</div><div class="customer-account-state">${status(row)}<span title="最近登录">${displayDate(row.lastLogin)}</span></div><div class="customer-account-action"><div class="account-action-buttons">${actions}</div></div></article>`;
    }).join('')||'<p class="customer-account-empty">暂无账号</p>'}</div>`;
  }
  function customerStore(row){
    const detail=(label,value,wide=false)=>`<div${wide?' class="customer-detail-wide"':''}><dt>${label}</dt><dd>${esc(value||'—')}</dd></div>`;
    const address=row.address||[row.prefecture,row.municipality,row.ward,row.addressDetail].filter(Boolean).join('')||row.city;
    return `<section class="section-card customer-store" data-customer-store="${esc(row.id)}"><header class="customer-store-heading"><div class="customer-store-identity">${row.imageUrl?`<img src="${esc(row.imageUrl)}" alt="${esc(row.name)}门店图" class="customer-store-image" loading="lazy">`:`<span class="customer-store-image customer-store-placeholder" aria-hidden="true">${icon('store')}</span>`}<div><h2>${esc(row.name)}</h2>${row.deletedAt?'<span class="account-status disabled">已删除门店</span>':''}</div></div><div class="customer-store-actions">${button('负责人码','accounts-customer-key','secondary',`data-store="${esc(row.id)}" ${row.deletedAt||!row.hasMaster?'disabled':''}`,'copy')}${button('员工管理','accounts-customer-team','ghost',`data-store="${esc(row.id)}" ${row.deletedAt?'disabled':''}`)}</div></header><dl class="customer-store-details">${detail('联系人',row.contact)}${detail('联系电话',row.phone)}${detail('配送路线',row.route)}${detail('门店编号',row.id)}${detail('配送地址',address,true)}${row.postalCode?detail('邮政编码',row.postalCode):''}</dl>${customerAccounts(row.accounts,row.id,!!row.deletedAt)}</section>`;
  }
  function customerStoreCard(row){
    const address=row.address||[row.prefecture,row.municipality,row.ward,row.addressDetail].filter(Boolean).join('')||row.city;
    const extra=`data-store="${esc(row.id)}"`,members=(row.accounts||[]).filter(account=>account.accountRole==='member'&&!account.deletedAt);
    return `<article class="store-card" data-customer-store="${esc(row.id)}">
      <header class="store-card-heading">${directoryAvatar(row.name,row.imageUrl)}<div class="store-card-identity"><h3><button class="directory-name-link" data-action="accounts-customer-store-detail" ${extra}>${esc(row.name)}</button></h3><span class="store-city">${esc(customerData.customer.name)}</span></div><span class="account-status ${row.deletedAt?'disabled':'active'}">${row.deletedAt?'已删除门店':'合作门店'}</span></header>
      <div class="store-card-info">${cardField('联系人',row.contact)}${cardField('联系电话',row.phone)}${cardField('配送地址',address)}${cardField('配送路线',row.route)}${cardField('管理员',`${members.length} / 3`)}</div>
      <footer class="store-card-footer">${button('门店资料','accounts-customer-store-detail','secondary',extra)}${button('负责人码','accounts-customer-key','secondary',`${extra} ${row.deletedAt||!row.hasMaster?'disabled':''}`)}${button('员工管理','accounts-customer-team','secondary',`${extra} ${row.deletedAt?'disabled':''}`)}</footer>
    </article>`;
  }
  function storesDirectoryPage(){
    const stores=customerData?.stores||[],visible=stores.filter(row=>customerDeleted||!row.deletedAt);
    const picker=`<div class="accounts-tenant-picker"><label for="accounts-store-tenant">中央厨房</label><select class="input" id="accounts-store-tenant">${(kitchens||[]).map(row=>`<option value="${esc(row.id)}" ${row.id===tenant?'selected':''}>${esc(row.name)}</option>`).join('')||'<option value="">暂无中央厨房</option>'}</select></div>`;
    return heading('门店管理',button('刷新','accounts-reload','secondary','','refresh'))+`<div class="platform-store-toolbar">${picker}<div class="platform-store-filters"><label class="accounts-check"><input type="checkbox" id="accounts-customer-deleted" ${customerDeleted?'checked':''}>含已删除门店</label><div class="accounts-filter-slot" ${directoryView==='card'?'inert aria-hidden="true"':''}>${archivedToggle()}</div>${directoryViewSwitch('directory',directoryView,'门店列表视图')}</div></div><div class="platform-store-count">${visible.length} 家门店</div><div class="${directoryView==='card'?'stores-grid platform-directory-grid':'platform-store-list is-list'}">${visible.map(directoryView==='card'?customerStoreCard:customerStore).join('')||'<section class="section-card accounts-empty"><h2>暂无门店</h2></section>'}</div>`;
  }
  function openCustomerStoreDetail(storeId){
    if(!platformOwner()||!customerSection())return;
    const row=customerData?.stores.find(item=>item.id===storeId);if(!row)return;
    modal('门店资料',`<div class="accounts-store-detail">${customerStore(row)}</div>`,button('关闭','close','secondary'));
    document.querySelector('.accounts-store-detail')?.closest('.modal')?.classList.add('accounts-store-detail-modal');
  }
  function openStores(tenantId=''){
    if(!platformOwner())return;
    closeOverlay();tenant=tenantId||tenant;store='';section='stores';customerDeleted=false;peopleDeleted=false;reload();
  }
  function openMemberLifecycle(accountId,storeId,operation){
    const row=section==='team'?team?.accounts?.find(item=>item.id===accountId):customerSection()?customerAccount(accountId,storeId):null;
    const scopeDeleted=storeId&&customerSection()&&customerData?.stores?.find(item=>item.id===storeId)?.deletedAt;
    if(!row||row.accountRole!=='member'||scopeDeleted||!(platformOwner()||section==='team'&&team?.canManage&&principal.accountRole==='owner'))return;
    if(operation==='restore'?!row.deletedAt:!!row.deletedAt)return;
    const title=operation==='restore'?'恢复管理员':'删除管理员';
    modal(title,`<div class="customer-reset-identity"><strong>${esc(row.name||row.username)}</strong><code>${esc(row.username||row.loginId||'')}</code></div><p class="form-hint">${operation==='restore'?'恢复后保持停用，启用后即可使用原账号登录。':'删除后立即退出登录，历史记录保留，可在已删除管理员中恢复。'}</p><p class="accounts-form-error" role="alert"></p>`,button('取消','close','secondary','type="button"')+`<button type="submit" class="btn btn-${operation==='restore'?'primary':'danger'}">确认${operation==='restore'?'恢复':'删除'}</button>`,'accounts-member-lifecycle-form');
    lifecycle={accountId,version:Number.isSafeInteger(row.version)?row.version:0,operation,busy:false,conflict:false,form:document.getElementById('accounts-member-lifecycle-form')};
  }
  async function saveMemberLifecycle(form){
    const state=lifecycle;if(!state||state.form!==form||!form.isConnected||state.busy)return true;
    const error=form.querySelector('.accounts-form-error');if(state.conflict){error.textContent='账号已变更，请关闭并刷新后重试。';return true;}
    state.busy=true;error.textContent='';form.querySelector('[type="submit"]').disabled=true;
    try{await request('/api/team/'+state.operation,{accountId:state.accountId,version:state.version});if(lifecycle!==state||!form.isConnected)return true;closeOverlay();reload();toast(state.operation==='restore'?'管理员已恢复，当前为停用状态。':'管理员已删除，可在已删除管理员中恢复。');}
    catch(failure){if(lifecycle===state&&form.isConnected){state.conflict=failure.status===409;error.textContent=state.conflict?'账号已变更，请关闭并刷新后重试。':failure.message||'操作失败，请重试。';}}
    finally{state.busy=false;if(form.isConnected)form.querySelector('[type="submit"]').disabled=state.conflict;}
    return true;
  }
  function customerPage(){
    const customer=customerData.customer,stores=customerData.stores||[],visible=stores.filter(row=>customerDeleted||!row.deletedAt),activeStores=stores.filter(row=>!row.deletedAt).length;
    return `<div class="customer-back">${button('中央厨房','accounts-kitchens','ghost','','arrow')}</div><div class="page-heading customer-heading"><div><h1>${esc(customer.name)}</h1><div class="customer-summary"><span>${esc(customer.ownerName||'未填写负责人')}</span><span>${esc(customer.contact||'未填写联系方式')}</span><span>${esc(customer.plan||'标准版')} · ${esc(customer.expiresOn||'长期有效')}</span><span class="account-status ${customer.active?'active':'disabled'}">${customer.active?'已启用':'已停用'}</span></div></div><div class="heading-actions">${button('刷新','accounts-reload','secondary','','refresh')}</div></div><div class="customer-toolbar"><div class="customer-tabs" role="tablist" aria-label="客户资料"><button type="button" role="tab" id="customer-tab-admins" aria-controls="customer-panel" aria-selected="${customerTab==='admins'}" data-action="accounts-customer-tab" data-tab="admins">管理端管理员</button><button type="button" role="tab" id="customer-tab-stores" aria-controls="customer-panel" aria-selected="${customerTab==='stores'}" data-action="accounts-customer-tab" data-tab="stores">门店与账号 <span>${activeStores}</span></button></div>${customerTab==='stores'?`<label class="accounts-check"><input type="checkbox" id="accounts-customer-deleted" ${customerDeleted?'checked':''}>含已删除门店${stores.length>activeStores?' · '+(stores.length-activeStores):''}</label>`:''}${archivedToggle()}</div><div id="customer-panel" role="tabpanel" aria-labelledby="customer-tab-${customerTab}">${customerTab==='stores'?(visible.map(customerStore).join('')||'<section class="section-card accounts-empty"><h2>暂无门店</h2></section>'):`<section class="section-card customer-store"><header class="customer-store-heading"><h2>管理端账号</h2><div class="customer-store-actions">${button('负责人码','accounts-customer-key','secondary',`data-store="" ${!customerData.managementAccounts?.some(row=>row.accountRole==='owner'&&row.hasMaster)?'disabled':''}`,'copy')}${button('员工管理','accounts-customer-team','ghost','data-store=""')}</div></header>${customerAccounts(customerData.managementAccounts)}</section>`}</div>`;
  }
  function openCustomer(tenantId){if(!platformOwner()||!tenantId)return;closeOverlay();tenant=tenantId;store='';section='customer';customerTab='stores';customerDeleted=false;reload();}
  function clearPasswordReset(){const form=document.getElementById('accounts-customer-password-form');form?.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});passwordReset=null;}
  function passwordResetForm(state=passwordReset){const form=document.getElementById('accounts-customer-password-form');return state&&passwordReset===state&&form?.dataset.account===state.accountId&&form.dataset.tenant===state.tenantId?form:null;}
  function openCustomerPassword(accountId,storeId=null){
    if(!platformOwner()||!customerSection()||!customerData)return;
    const row=customerAccount(accountId,storeId),targetStore=storeId?customerData.stores.find(item=>item.id===storeId):null;
    if(!row||row.accountRole!=='member'||row.deletedAt||targetStore?.deletedAt)return;
    modal('重置管理员密码',`<div class="customer-reset-identity"><strong>${esc(row.name||row.username||row.loginId)}</strong><code>${esc(row.username||row.loginId||'')}</code><span>${esc(targetStore?.name||customerData.customer.name)} · ${targetStore?'门店端':'管理端'}</span></div><div class="field"><label for="customer-new-password">新密码</label><input class="input" id="customer-new-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><div class="field"><label for="customer-confirm-password">确认新密码</label><input class="input" id="customer-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><p class="form-hint">密码 12～128 个字符。原密码无法查看，重置后该管理员需重新登录。</p><p class="accounts-form-error" role="alert"></p>${button('读取最新账号','accounts-customer-password-refresh','ghost','type="button" hidden')}`,footer('重置密码'),'accounts-customer-password-form');
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
      form.querySelector('.customer-reset-identity strong').textContent=row.name||row.username||row.loginId||'管理员';form.querySelector('.customer-reset-identity code').textContent=row.username||row.loginId||'';
      form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});
      form.querySelector('.accounts-form-error').textContent='账号已更新，请重新填写并确认密码。';
      form.querySelector('[data-action="accounts-customer-password-refresh"]').hidden=true;
    }catch(error){if(passwordResetForm(state))form.querySelector('.accounts-form-error').textContent=error.message;}
    finally{if(passwordResetForm(state)){state.busy=false;form.querySelector('[type="submit"]').disabled=!!state.unavailable;}}
  }
  async function saveCustomerPassword(form){
    const state=passwordReset;if(!platformOwner()||passwordResetForm(state)!==form||state.busy||state.unavailable)return;
    const password=form.elements.namedItem('password').value,confirmation=form.elements.namedItem('confirmPassword').value,errorNode=form.querySelector('.accounts-form-error');
    errorNode.textContent='';
    if(password.length<12||password.length>128){errorNode.textContent='密码需要 12～128 个字符。';return;}
    if(password!==confirmation){errorNode.textContent='两次输入的密码不一致。';return;}
    if(state.conflict){errorNode.textContent='请先读取最新账号，再确认重置。';return;}
    state.busy=true;form.setAttribute('aria-busy','true');form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';input.disabled=true;});
    try{const result=await request('/api/platform/staff/password',{tenantId:state.tenantId,storeId:state.storeId,accountId:state.accountId,version:state.version,password});if(!passwordResetForm(state))return;
      const rows=state.storeId?customerData?.stores?.find(row=>row.id===state.storeId)?.accounts:customerData?.managementAccounts,index=rows?.findIndex(row=>row.id===state.accountId);
      if(index>=0&&result.account)rows[index]=result.account;
      closeOverlay();render();toast('密码已重置，该管理员需重新登录。');
    }catch(error){if(passwordResetForm(state)){state.conflict=error.status===409;errorNode.textContent=String(error.message||'重置失败，请重试。').split(password).join('［已隐藏］');form.querySelector('[data-action="accounts-customer-password-refresh"]').hidden=!state.conflict;}}
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
    const picker=principal.role==='platform'?`<div class="accounts-tenant-picker"><label for="accounts-tenant">中央厨房</label><select class="input" id="accounts-tenant">${(kitchens||[]).map(k=>`<option value="${esc(k.id)}" ${k.id===tenant?'selected':''}>${esc(k.name)}</option>`).join('')||'<option value="">暂无中央厨房</option>'}</select></div>`:'';
    const own=principal.accountRole==='member'?button('我的账号','accounts-profile','secondary'):'';
    const organization=team.organization||{},orgEditable=!team.storeId&&(principal.role==='platform'&&principal.accountRole==='owner'||principal.role==='admin'&&principal.accountRole==='owner');
    const orgAvatar=personAvatar({...organization,name:organization.name||'中央厨房'},{action:orgEditable?'accounts-organization-avatar':'',label:'修改厨房头像'});
    const scope=principal.role==='platform'?`<select class="input" id="accounts-store" aria-label="管理员所属组织"><option value="">管理端管理员</option>${stores.map(item=>`<option value="${esc(item.id)}" ${item.id===team.storeId?'selected':''}>${esc(item.name)} · 门店管理员</option>`).join('')}</select>`:`<strong>${esc(selectedStore?.name||(principal.role==='store'?'本门店':'管理端团队'))}</strong>`;
    return heading(selectedStore&&principal.role==='admin'?'门店员工管理':'员工管理',own+(team.canManage?button('添加管理员','accounts-staff-new','primary',used>=3?'disabled':'','plus'):''))+picker+(team.needsSetup?`<section class="section-card accounts-empty"><h2>请先开通中央厨房</h2>${principal.role==='platform'?button('开通中央厨房','accounts-kitchen-new','primary'):''}</section>`:`<section class="accounts-context"><div class="accounts-organization">${orgAvatar}<div><strong>${esc(organization.name)}</strong><span class="accounts-seat">负责人独立 · 管理员 ${used} / 3</span></div></div><div class="accounts-scope">${scope}${team.canManage?button('负责人码','accounts-scope-key','secondary','','copy'):''}</div></section><section class="section-card accounts-table"><div class="section-header"><h2 class="section-title">${esc(selectedStore?.name||'管理端')} · 账号</h2><div class="accounts-team-tools">${team.canManage?archivedToggle()+button('操作记录','accounts-audit','ghost'):''}</div></div><div class="table-scroll"><table><thead><tr><th>姓名 / 身份</th><th>账号名</th><th>联系方式</th><th>状态</th><th class="align-right">操作</th></tr></thead><tbody>${rows.map(row=>{
      const extra=`data-id="${esc(row.id)}" data-store="${esc(team.storeId||'')}"`;
      let actions=platformOwner()&&editableAvatar(row)?button('编辑头像','accounts-person-avatar','ghost',extra):'';
      if(row.accountRole==='member'&&team.canManage)actions+=row.deletedAt?button('恢复','accounts-staff-restore','secondary',extra):button('编辑账号','accounts-staff-edit','secondary',extra)+button(row.status==='disabled'?'启用':'停用','accounts-staff-confirm','ghost',`${extra} data-operation="${row.status==='disabled'?'enable':'disable'}"`)+button('删除','accounts-staff-delete','danger',extra);
      else if(row.id===(principal.userId||principal.id)&&row.accountRole==='member')actions+=button('修改账号名与密码','accounts-profile','secondary');
      return `<tr data-member-id="${esc(row.id)}"><td><div class="account-person-cell">${personAvatar(row,{action:editableAvatar(row)?'accounts-person-avatar':'',extra})}<div><strong>${esc(row.name)}</strong><span class="cell-secondary">${row.accountRole==='owner'?'负责人':'管理员'}${row.id===(principal.userId||principal.id)?' · 我':''}</span></div></div></td><td>${row.accountRole==='owner'?'<span class="muted">负责人码登录</span>':`<code>${esc(row.username)}</code>`}</td><td>${esc(row.contact||'—')}</td><td>${status(row)}</td><td class="accounts-actions"><div class="account-action-buttons">${actions||'—'}</div></td></tr>`;
    }).join('')}</tbody></table></div></section>`);
  }
  function auditPage(){const labels={'flow.connection.update':'更新 Flow 模型连接','flow.feature.enable':'启用或配置 Flow','flow.feature.disable':'停用 Flow',submitOrder:'提交订单',addStore:'创建门店',updateStore:'修改门店',deleteStore:'删除门店',confirmPackLine:'确认配货',setPackLineDone:'更新配货勾选',setPackingNote:'修改配货备注',packLine:'修改配货数量',confirmDelivery:'确认送达',setStage:'更新履约状态',setPrice:'修改报价',setUnitQuote:'修改单位报价'};return heading('操作记录',button('返回','accounts-back','secondary'))+`<section class="section-card accounts-table"><div class="table-scroll"><table><thead><tr><th>操作人</th><th>操作</th><th>时间</th></tr></thead><tbody>${events.map(row=>`<tr><td>${esc(row.actor_name)}</td><td>${esc(labels[row.action]||row.action)}</td><td>${new Date(row.created_at*1000).toLocaleString('zh-CN')}</td></tr>`).join('')||'<tr><td colspan="3" class="accounts-empty">暂无操作记录</td></tr>'}</tbody></table></div></section>`;}
  function kitchenForm(id='',edit=false){const row=kitchens?.find(r=>r.id===id)||{},saved=recovered&&recovered.id===id?recovered:{};modal(edit?'中央厨房设置':'开通中央厨房',`<input type="hidden" name="tenantId" value="${esc(id)}"><input type="hidden" name="operation" value="${edit?'edit':'create'}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div class="form-grid">${!edit?`<div class="field-full">${field('中央厨房名称','name',saved.name||row.name||'','required maxlength="80"')}</div>`:''}${field('负责人姓名','ownerName',saved.ownerName||row.owner_name||'','required maxlength="80"')}${field('联系方式','contact',saved.contact||row.contact||'','maxlength="120"')}${field('套餐名称','plan',row.plan||'标准版','required maxlength="40"')}${field('有效期至','expiresOn',row.expires_on||'','type="date"')}${edit?`<label class="accounts-check field-full"><input name="active" type="checkbox" ${row.active===1?'checked':''}>启用此中央厨房</label>`:''}</div><p class="form-hint">1 个负责人，另可添加 3 个管理员。</p><p class="accounts-form-error" role="alert"></p>`,footer(edit?'保存':'开通并生成负责人码'),'accounts-kitchen-form');}
  function staffForm(id=''){const row=team.accounts.find(r=>r.id===id)||{};modal(id?'编辑管理员':'添加管理员',`<input type="hidden" name="accountId" value="${esc(id)}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><div class="form-grid">${field('账号名','username',row.username||'','required minlength="3" maxlength="32" autocomplete="off"')}${field(id?'新密码（留空保留）':'密码','password','','type="password" autocomplete="new-password" minlength="12" maxlength="128" '+(id?'':'required'))}${field('姓名','name',row.name||'','maxlength="80"')}${field('联系方式','contact',row.contact||'','maxlength="120"')}</div><p class="form-hint">账号名全平台唯一。密码 12～128 个字符，管理员登录后可自行修改。</p><p class="accounts-form-error" role="alert"></p>`,footer(id?'保存修改':'创建管理员'),'accounts-staff-form');}
  function showMaster(result,scope={}){handoff={...scope,...result};const role=result.account.role;modal('负责人登录码',`<div class="account-handoff"><h3>${esc(result.account.name)}</h3><label for="account-master-code">16 位负责人码</label><div class="account-master-code-row"><input class="input account-master-input" id="account-master-code" readonly value="${esc(result.masterCode)}"><button class="icon-button" data-action="accounts-copy-master" aria-label="复制负责人码">${icon('copy')}</button></div><p>使用此码登录${role==='store'?'门店端':'管理端'}，无需额外密码。</p>${principal.role==='platform'?`<a class="text-button" href="/?login=${role==='store'?'store':'kitchen'}" target="_blank" rel="noopener">打开登录入口 ${icon('arrow')}</a>`:''}</div>`,button('完成','close','secondary')+button('复制登录信息','accounts-copy-handoff','primary','','copy')+(scope.canRotate?button('重置负责人码','accounts-master-reset-confirm','ghost'):''));}
  async function copy(value){try{await navigator.clipboard.writeText(value);toast('已复制。');}catch{modal('复制信息',`<textarea class="input account-copy-text" readonly>${esc(value)}</textarea>`,button('关闭','close','secondary'));const input=document.querySelector('.account-copy-text');input.focus();input.select();}}
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
    state.model=form.elements.namedItem('flowModel').value;
  }
  function patchFlowForm(state) {
    const form=flowForm(state);if(!form)return;
    const data=state.data,enabled=form.elements.namedItem('flowEnabled'),model=form.elements.namedItem('flowModel');
    const locked=!!state.busy||!data;
    form.setAttribute('aria-busy',String(!!state.busy));
    enabled.disabled=locked;enabled.checked=state.enabled;
    enabled.setAttribute('aria-checked',String(state.enabled));
    form.querySelector('[data-flow-toggle-label]').textContent=state.enabled?'已启用':'已停用';
    const connectionState=form.querySelector('[data-flow-connection-state]');
    connectionState.textContent=!data?'正在读取':data.configured?'已配置':'未配置';
    connectionState.classList.toggle('active',!!data?.configured);
    const token=form.querySelector('#accounts-flow-token');token.disabled=locked;
    token.placeholder=data?.configured?'粘贴新 Token 以更换连接':'gho_…';
    form.querySelector('[data-action="accounts-flow-connect"]').disabled=locked;
    form.querySelector('[data-action="accounts-flow-connect"]').textContent=state.busy==='connect'?'正在验证连接…':'连接并读取模型';
    form.querySelector('[data-action="accounts-flow-refresh"]').disabled=locked||!data?.configured;
    form.querySelector('[data-action="accounts-flow-refresh"]').classList.toggle('is-loading',state.busy==='refresh');
    const available=data?.models||[],missing=state.model&&!available.some(row=>row.id===state.model);
    const options=`<option value="">${data?.configured?'选择模型':'请先连接 GitHub Copilot'}</option>`+(missing?`<option value="${esc(state.model)}" disabled>${esc(state.model)} · 未在当前目录中</option>`:'')+available.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');
    if(model.dataset.options!==options){model.innerHTML=options;model.dataset.options=options;}
    model.value=state.model;model.disabled=locked||!available.length;
    model.setAttribute('aria-invalid',String(!!missing));
    form.querySelector('[data-flow-saved-model]').textContent=data?.model?`当前模型：${available.find(row=>row.id===data.model)?.name||data.model}`:'尚未指定模型';
    const catalogue=form.querySelector('[data-flow-catalogue-status]');
    let time='';
    if(data?.fetchedAt){const date=new Date(data.fetchedAt);if(Number.isFinite(date.getTime()))time=date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
    catalogue.textContent=state.busy==='refresh'?'正在向 GitHub 读取最新模型…':data?.fetchedAt?`${data.stale?'缓存目录':data.cacheState==='cached'?'最近目录':'已更新'} · ${time} · ${available.length} 个模型`:data?.configured?'模型目录尚未读取成功':'连接后读取可用模型';
    catalogue.classList.toggle('is-stale',!!data?.stale);
    form.querySelector('[data-flow-connection-message]').textContent=data?.message||'';
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
      if(first){state.enabled=state.data.enabled;state.model=state.data.model;}
    }catch(error){if(flowForm(state))state.error=error.message;}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function openFlowConfig(tenantId) {
    if(principal.role!=='platform')return;
    const row=kitchens?.find(item=>item.id===tenantId);if(!row)return;
    modal('功能配置',`<div class="accounts-flow-customer">${esc(row.name)}</div><div class="accounts-feature-row"><div><h3>Flow AI</h3><span class="accounts-flow-caption">管理端 AI 助手</span></div><label class="accounts-feature-switch"><span data-flow-toggle-label>已停用</span><input id="accounts-flow-enabled" name="flowEnabled" type="checkbox" role="switch" aria-label="启用 Flow AI" aria-checked="false" disabled><span class="accounts-switch-track" aria-hidden="true"></span></label></div><section class="accounts-flow-connection"><div class="accounts-flow-section-heading"><h3>GitHub Copilot</h3><span class="account-status" data-flow-connection-state>正在读取</span></div><div class="field"><label for="accounts-flow-token">GitHub Token</label><div class="accounts-flow-token-row"><input class="input" id="accounts-flow-token" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" aria-describedby="accounts-flow-token-hint" placeholder="gho_…" maxlength="1024" disabled>${button('连接并读取模型','accounts-flow-connect','secondary','type="button" disabled')}</div><p id="accounts-flow-token-hint" class="accounts-flow-caption">保存后不再显示 Token；留空保留当前连接。</p></div><div class="field"><div class="accounts-flow-model-label"><label for="accounts-flow-model">运行模型</label>${button('刷新模型','accounts-flow-refresh','ghost','type="button" disabled','refresh')}</div><select class="input" id="accounts-flow-model" name="flowModel" aria-describedby="accounts-flow-catalogue-status" disabled><option value="">正在读取</option></select><p id="accounts-flow-catalogue-status" class="accounts-flow-caption" data-flow-catalogue-status></p><p class="accounts-flow-caption" data-flow-saved-model></p></div><p class="accounts-flow-warning" data-flow-connection-message role="status"></p></section><p class="accounts-form-error" role="alert"></p>${button('读取最新配置','accounts-flow-reload','ghost','type="button" hidden')}`,footer('保存功能设置'),'accounts-flow-form');
    const state={tenantId,data:null,enabled:false,model:'',busy:'',error:''};
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
    }catch(error){if(flowForm(state))state.error=String(error.message).replaceAll(token,'[已隐藏]');}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function saveFlowConfig(form) {
    const state=flowConfig;if(!state||flowForm(state)!==form||state.busy||!state.data)return;
    readFlowDraft(state);
    form.querySelector('#accounts-flow-token').value='';
    if(state.enabled&&(!state.data.configured||!state.model)){state.error=!state.data.configured?'请先连接 GitHub Copilot。':'请选择运行模型。';patchFlowForm(state);return;}
    state.busy='save';state.error='';patchFlowForm(state);
    try {
      await request('/api/platform/flow',{tenantId:state.tenantId,version:state.data.version,enabled:state.enabled,model:state.model||null});
      if(!flowForm(state))return;
      closeOverlay();toast('功能配置已保存。');
    }catch(error){if(flowForm(state))state.error=error.message;}
    finally{if(flowForm(state)){state.busy='';patchFlowForm(state);}}
  }
  async function handleAction(action,el){if(!action.startsWith('accounts-'))return false;if(action.startsWith('accounts-avatar-'))return avatarEditor.handleAction(action,el);const id=el.dataset.id;
    if(action==='accounts-self-avatar')openAccountAvatar({...principal,id:principal.userId||principal.id,name:principal.displayName||principal.name});
    if(action==='accounts-person-avatar')openAccountAvatar(team?.accounts.find(row=>row.id===id));
    if(action==='accounts-customer-avatar'&&platformOwner()&&customerSection()){const targetStore=el.dataset.store?customerData.stores.find(row=>row.id===el.dataset.store):null;if(!targetStore?.deletedAt)openAccountAvatar(customerAccount(id,el.dataset.store||null));}
    if(action==='accounts-organization-avatar')openOrganizationAvatar(team?.organization);

    if(action==='accounts-reload')reload();
    if(action==='accounts-kitchens'){section='kitchens';tenant='';store='';reload();}
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
    if(action==='accounts-customer-team'&&platformOwner()&&customerSection()){store=el.dataset.store||'';if(!store||customerData.stores.some(row=>row.id===store&&!row.deletedAt)){section='team';reload();}}
    if(action==='accounts-kitchen-features')await openFlowConfig(el.dataset.tenant);
    if(action==='accounts-flow-connect')await connectFlowConfig();
    if(action==='accounts-flow-refresh')await loadFlowConfig(flowConfig,{refresh:true});
    if(action==='accounts-flow-reload')await loadFlowConfig(flowConfig);
    if(action==='accounts-kitchen-edit')kitchenForm(el.dataset.tenant,true);
    if(action==='accounts-kitchen-team'){tenant=el.dataset.tenant;store='';section='team';reload();}
    if(action==='accounts-kitchen-key')await showScopeKey(el.dataset.tenant,null);
    if(action==='accounts-scope-key')await showScopeKey();
    if(action==='accounts-staff-new')staffForm();
    if(action==='accounts-staff-edit')staffForm(id);
    if(action==='accounts-audit'){section='audit';reload();}
    if(action==='accounts-back'){section=principal.role==='platform'&&!tenant?'kitchens':'team';reload();}
    if(action==='accounts-copy-master'&&handoff)await copy(handoff.masterCode);
    if(action==='accounts-copy-handoff'&&handoff)await copy(`${handoff.account.name}\n负责人码：${handoff.masterCode}\n登录入口：${location.origin}/?login=${handoff.account.role==='store'?'store':'kitchen'}\n选择负责人登录，无需额外密码。`);
    if(action==='accounts-master-reset-confirm'&&handoff)modal('重置负责人码',`<p>重置后旧码与该负责人的登录会话立即失效，管理员账号保持可用。</p>`,button('取消','close','secondary')+button('确认重置','accounts-master-reset','danger'));
    if(action==='accounts-master-reset'&&handoff){const result=await request('/api/team/master-key',{tenantId:handoff.tenantId,storeId:handoff.storeId,rotate:true});showMaster(result,handoff);}
    if(action==='accounts-staff-confirm'){const row=team.accounts.find(r=>r.id===id),operation=el.dataset.operation;modal(operation==='disable'?'停用管理员':'启用管理员',`<p>${esc(row.name)} · ${esc(row.username)}</p><p>${operation==='disable'?'停用后立即退出登录，历史操作记录保留。':'启用后可以使用原账号名和密码登录。'}</p>`,button('取消','close','secondary')+button('确认','accounts-staff-update','primary',`data-id="${esc(id)}" data-operation="${operation}"`));}
    if(action==='accounts-staff-update'){await request('/api/team/update',{accountId:id,action:el.dataset.operation});closeOverlay();reload();toast('账号状态已更新。');}
    if(action==='accounts-profile')modal('我的账号',`${field('账号名','username',principal.username||principal.loginId||'','required minlength="3" maxlength="32" autocomplete="username"')}${field('当前密码','oldPassword','','type="password" autocomplete="current-password" required maxlength="128"')}${field('新密码（留空保留）','password','','type="password" autocomplete="new-password" minlength="12" maxlength="128"')}${field('确认新密码','confirmPassword','','type="password" autocomplete="new-password" maxlength="128"')}<p class="form-hint">修改账号名或密码后需要重新登录。</p><p class="accounts-form-error" role="alert"></p>`,footer('保存并重新登录'),'accounts-profile-form');
    return true;
  }
  async function handleSubmit(form){const formId=form.getAttribute('id');if(!formId?.startsWith('accounts-'))return false;if(formId==='accounts-member-lifecycle-form')return await saveMemberLifecycle(form);if(formId==='accounts-avatar-form'){return await avatarEditor.handleSubmit(form);}if(formId==='accounts-flow-form'){await saveFlowConfig(form);return true;}if(formId==='accounts-customer-password-form'){await saveCustomerPassword(form);return true;}const data=Object.fromEntries(new FormData(form));try{
    if(formId==='accounts-kitchen-form'){const result=await request(data.operation==='edit'?'/api/platform/update':'/api/platform/create',{...data,active:form.elements.namedItem('active')?.checked,...(data.tenantId?{existingTenantId:data.tenantId}:{})});recovered=null;closeOverlay();if(result.tenantId){tenant=result.tenantId;store='';section='team';}reload();if(result.masterCode)showMaster(result,{tenantId:result.tenantId,storeId:null,canRotate:true});else toast('客户资料已保存。');}
    if(formId==='accounts-staff-form'){await request(data.accountId?'/api/team/update':'/api/team/create',{...data,action:'edit',tenantId:tenant||principal.tenantId,storeId:store||principal.storeId||null});closeOverlay();reload();toast(data.accountId?'管理员已更新。':'管理员已创建，可直接登录。');}
    if(formId==='accounts-profile-form'){if(data.password&&data.password!==data.confirmPassword)throw new Error('两次输入的密码不一致。');await request('/api/accounts/profile',{username:data.username,oldPassword:data.oldPassword,password:data.password});location.href='/?login='+(principal.role==='store'?'store':'kitchen')+'&tab=admin';}
  }catch(error){const node=form.querySelector('.accounts-form-error');if(node)node.textContent=error.message;throw error;}return true;}
  function handleChange(input){if(input.id==='accounts-store-tenant'&&platformOwner()&&section==='stores'){tenant=input.value;store='';reload();return true;}if(input.id==='accounts-archived'){peopleDeleted=input.checked;render();return true;}if(input.id==='accounts-customer-deleted'&&customerSection()){customerDeleted=input.checked;render();return true;}if(input.id==='accounts-flow-enabled'||input.id==='accounts-flow-model'){const state=flowConfig;if(flowForm(state)){readFlowDraft(state);state.error='';patchFlowForm(state);}return true;}if(input.id==='accounts-store'){if(principal.role!=='platform')return false;store=input.value;reload();return true;}if(input.id==='accounts-tenant'){tenant=input.value;store='';reload();return true;}return false;}
  function search(value){query=value;render();document.getElementById('accounts-search')?.focus();}
  return {page,handleAction,handleSubmit,handleChange,search,onOverlayClose:()=>{clearFlowConfig();clearPasswordReset();avatarEditor.dispose();lifecycle=null;},openAudit:()=>{section='audit';reload();},openKitchens:()=>{section='kitchens';reload();},openOrganizationAvatar,openStores,openOwnTeam:()=>{section='team';tenant='';store='';reload();},openStoreTeam:storeId=>{if(principal.role!=='admin'||principal.accountRole!=='owner'||!storeId)return;section='team';tenant='';store=storeId;reload();},openTeam:()=>{section='team';if(principal.role!=='platform'){tenant='';store='';}reload();}};
}
