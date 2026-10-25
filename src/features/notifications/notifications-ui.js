import {t, tx, ta, me, setI18nText, getLocale, translatedError} from "../../i18n/index.js";
export function createNotificationsUI({list,markRead,modal,button,icon,escape:esc,includeDemo=()=>false,onCount=()=>{},onNavigate=()=>{},enabled=()=>true}={}) {
  let filter='unread',items=[],unreadCount=0,latestId=0,nextCursor=null,hasMore=false,loading=false,working=false,error='',sequence=0,destroyed=false,flight=null;
  const listeners=new AbortController();
  const root=()=>document.getElementById('notification-center');
  const safeId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
  const stamp=value=>{const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat(getLocale(),{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);};
  const eventIcon=item=>/shortage|issue|stock/.test(item.kind)?'alert':/deliver|ready/.test(item.kind)?'truck':'clipboard';
  const targetLabels={product:'查看商品',order:'查看货单',customer:'查看客户',team:'员工管理'};
  const structuredTitleKeys=new Set(['订单已提交','订单已完成配货','订单已开始配送','订单已送达','催单已提交','已开通客户','客户配置已更新','客户已停用','已添加管理员','管理员资料已更新','管理员已停用','管理员已启用','管理员已删除','管理员已恢复','登录凭据已更新','个人资料已更新','个人头像已更新','客户头像已更新','Flow 连接已更新','Flow 已启用','Flow 已停用','多语言已启用','多语言已停用','端口功能已更新']);
  const structuredBodyKeys=new Set(['订单 {0} · 配送日期 {1}','客户：{0}','平台员工']);
  const eventTitle=item=>structuredTitleKeys.has(item.titleKey)?tx(item.titleKey):esc(translatedError(item.title));
  const eventBody=item=>structuredBodyKeys.has(item.bodyKey)?tx(item.bodyKey,Array.isArray(item.bodyParams)?item.bodyParams.map(value=>me(String(value??''))):[]):esc(item.body||'');
  function content() {
    if(!enabled())return `<div class="notifications-empty">${icon('bell')}<strong>${tx('通知功能尚未开启。')}</strong></div>`;
    return `<div class="notifications-toolbar"><div class="tabs" role="tablist" ${ta("aria-label", "通知筛选")}>${[['unread','未读'],['all','全部']].map(([key,label])=>`<button type="button" class="tab ${filter===key?'active':''}" role="tab" aria-selected="${filter===key}" data-action="notification-filter" data-filter="${key}">${tx(label)}${(key==='unread' ? ` <span>${unreadCount}</span>` : '')}</button>`).join('')}</div><button type="button" class="text-button" data-action="notification-read-all" ${working||!unreadCount||!latestId?'disabled':''}>${tx("全部标为已读")}</button></div>${(error ? `<div class="notifications-error" role="alert"><span>${esc(translatedError(error))}</span><button type="button" class="text-button" data-action="notification-refresh">${tx("重试")}</button></div>` : '')}<div class="notifications-event-list" aria-busy="${loading}">${(items.length ? `<ol>${items.map(item=>`<li class="notification-event ${item.read?'':'is-unread'}" data-notification-id="${item.id}"><span class="notification-event-icon ${/shortage|issue/.test(item.kind)?'has-issue':''}" aria-hidden="true">${icon(eventIcon(item))}</span><div class="notification-event-content"><div class="notification-event-heading"><strong>${eventTitle(item)}</strong>${(item.read ? '' : `<span class="notification-unread-dot" ${ta("aria-label", "未读")}></span>`)}</div>${(item.body||structuredBodyKeys.has(item.bodyKey) ? `<p>${eventBody(item)}</p>` : '')}<div class="notification-event-meta"><time datetime="${esc(item.createdAt||'')}">${esc(stamp(item.createdAt))}</time>${(item.actorName ? `<span>${esc(item.actorName)}</span>` : '')}${(item.isDemo ? `<span>${tx("演示")}</span>` : '')}${(item.currentStatus?.label ? `<span class="notification-event-state ${item.currentStatus.resolved?'is-resolved':''}">${tx(item.currentStatus.label)}</span>` : '')}</div><div class="notification-event-actions">${button(t(targetLabels[item.targetType]),'notification-open','ghost',`data-notification="${item.id}"`,'arrow')}${(!item.read ? `<button type="button" class="text-button" data-action="notification-read" data-notification="${item.id}" ${working?'disabled':''}>${tx("标为已读")}</button>` : '')}</div></div></li>`).join('')}</ol>` : `<div class="notifications-empty">${icon(loading?'refresh':'bell')}<strong>${(loading ? tx("正在读取通知") : (error ? tx("暂时无法读取通知") : (filter==='unread' ? tx("暂无未读通知") : tx("暂无通知"))))}</strong>${(!loading&&!error&&filter==='unread' ? `<button type="button" class="text-button" data-action="notification-filter" data-filter="all">${tx("查看全部通知")}</button>` : '')}</div>`)}</div>${(hasMore ? `<button type="button" class="notifications-more text-button" data-action="notification-more" ${loading?'disabled':''}>${(loading ? tx("正在读取…") : tx("加载更多"))}</button>` : '')}`;
  }
  function render() {
    const node=root();if(!node)return;
    const oldList=node.querySelector('.notifications-event-list'),scroll=oldList?.scrollTop||0,active=document.activeElement;
    const action=active?.dataset?.action,id=active?.dataset?.notification,activeFilter=active?.dataset?.filter;
    node.innerHTML=content();node.closest('.modal')?.classList.add('notifications-modal');
    const nextList=node.querySelector('.notifications-event-list');if(nextList)nextList.scrollTop=scroll;
    if(action){const selector=`[data-action="${CSS.escape(action)}"]${id?`[data-notification="${CSS.escape(id)}"]`:''}${activeFilter?`[data-filter="${CSS.escape(activeFilter)}"]`:''}`;node.querySelector(selector)?.focus({preventScroll:true});}
  }
  function refresh({append=false,force=false}={}) {
    if(destroyed)return Promise.resolve();
    if(!enabled()){
      sequence++;flight=null;items=[];unreadCount=0;latestId=0;nextCursor=null;hasMore=false;loading=false;error='';onCount(0);render();
      return Promise.resolve();
    }
    if(flight&&!force&&!append)return flight;
    const requestId=++sequence,requestedFilter=filter,demo=includeDemo();loading=true;error='';render();
    const operation=(async()=>{
      try {
        const result=await list({filter:requestedFilter,includeDemo:demo,...(append&&nextCursor?{before:nextCursor}:{})});
        if(destroyed||requestId!==sequence)return;
        if(!enabled()){await refresh();return;}
        const rows=(Array.isArray(result.items)?result.items:[]).filter(item=>safeId(item.id)&&Object.hasOwn(targetLabels,item.targetType));
        items=append?[...new Map([...items,...rows].map(item=>[item.id,item])).values()]:rows;
        unreadCount=Math.max(0,Number(result.unreadCount)||0);latestId=Number(result.latestId)||0;nextCursor=result.nextCursor;hasMore=result.hasMore===true;
        error=result.persistenceWarning||'';onCount(unreadCount);
      } catch(failure){if(!destroyed&&requestId===sequence)error=failure.message||'通知读取失败，请重试。';}
      finally{if(requestId===sequence){loading=false;flight=null;render();}}
    })();flight=operation;return operation;
  }
  async function readOne(item) {
    if(item.read)return;
    await markRead({ids:[item.id],includeDemo:includeDemo()});
  }
  async function handleAction(action,el) {
    if(!action.startsWith('notification-'))return false;
    if(!enabled())throw new Error('通知功能尚未开启。');
    if(action==='notification-filter'){filter=el.dataset.filter==='all'?'all':'unread';items=[];hasMore=false;await refresh({force:true});return true;}
    if(action==='notification-refresh'){await refresh({force:true});return true;}
    if(action==='notification-more'){if(!loading&&hasMore)await refresh({append:true});return true;}
    if(working)return true;
    if(['notification-read','notification-open','notification-read-all'].includes(action)){
      const item=items.find(row=>String(row.id)===el.dataset.notification);if(action!=='notification-read-all'&&!item)return true;
      working=true;error='';render();
      try {
        if(action==='notification-read-all'){if(latestId)await markRead({through:latestId,includeDemo:includeDemo()});}
        else await readOne(item);
        await refresh({force:true});
        if(action==='notification-open')await onNavigate(item);
      } catch(failure){error=failure.message||'操作未完成，请重试。';}
      finally{working=false;render();}
    }
    return true;
  }
  function open() {
    if(!enabled())return;
    modal(t("通知中心"),`<section id="notification-center" ${ta("aria-label", "通知中心")}></section>`,button(t("关闭"),'close','secondary'));
    const modalRoot=document.querySelector('#notification-center')?.closest('.modal');
    if(modalRoot?.querySelector('h2'))setI18nText(modalRoot.querySelector('h2'),()=>t('通知中心'));
    const closeButton=modalRoot?.querySelector('footer button,[data-action=close]');if(closeButton)setI18nText(closeButton,()=>t('关闭'));
    render();return refresh({force:true});
  }
  document.addEventListener('kuraflow:language-change',()=>render(),{signal:listeners.signal});
  const timer=setInterval(()=>{if(!document.hidden)refresh();},15000);
  window.addEventListener('focus',()=>refresh(),{signal:listeners.signal});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();},{signal:listeners.signal});
  return {open,refresh,handleAction,getUnreadCount:()=>unreadCount,destroy(){destroyed=true;sequence++;clearInterval(timer);listeners.abort();}};
}
