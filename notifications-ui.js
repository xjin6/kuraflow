export function createNotificationsUI({list,markRead,modal,button,icon,escape:esc,includeDemo=()=>false,onCount=()=>{},onNavigate=()=>{},enabled=()=>true}={}) {
  let filter='unread',items=[],unreadCount=0,latestId=0,nextCursor=null,hasMore=false,loading=false,working=false,error='',sequence=0,destroyed=false,flight=null;
  const listeners=new AbortController();
  const root=()=>document.getElementById('notification-center');
  const safeId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
  const stamp=value=>{const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);};
  const eventIcon=item=>/shortage|issue|stock/.test(item.kind)?'alert':/deliver|ready/.test(item.kind)?'truck':'clipboard';
  function content() {
    return `<div class="notifications-toolbar"><div class="tabs" role="tablist" aria-label="通知筛选">${[['unread','未读'],['all','全部']].map(([key,label])=>`<button type="button" class="tab ${filter===key?'active':''}" role="tab" aria-selected="${filter===key}" data-action="notification-filter" data-filter="${key}">${label}${key==='unread'?` <span>${unreadCount}</span>`:''}</button>`).join('')}</div><button type="button" class="text-button" data-action="notification-read-all" ${working||!unreadCount||!latestId?'disabled':''}>全部标为已读</button></div>${error?`<div class="notifications-error" role="alert"><span>${esc(error)}</span><button type="button" class="text-button" data-action="notification-refresh">重试</button></div>`:''}<div class="notifications-event-list" aria-busy="${loading}">${items.length?`<ol>${items.map(item=>`<li class="notification-event ${item.read?'':'is-unread'}" data-notification-id="${item.id}"><span class="notification-event-icon ${/shortage|issue/.test(item.kind)?'has-issue':''}" aria-hidden="true">${icon(eventIcon(item))}</span><div class="notification-event-content"><div class="notification-event-heading"><strong>${esc(item.title)}</strong>${item.read?'':'<span class="notification-unread-dot" aria-label="未读"></span>'}</div>${item.body?`<p>${esc(item.body)}</p>`:''}<div class="notification-event-meta"><time datetime="${esc(item.createdAt||'')}">${esc(stamp(item.createdAt))}</time>${item.actorName?`<span>${esc(item.actorName)}</span>`:''}${item.isDemo?'<span>演示</span>':''}${item.currentStatus?.label?`<span class="notification-event-state ${item.currentStatus.resolved?'is-resolved':''}">${esc(item.currentStatus.label)}</span>`:''}</div><div class="notification-event-actions">${button(item.targetType==='product'?'查看商品':'查看货单','notification-open','ghost',`data-notification="${item.id}"`,'arrow')}${!item.read?`<button type="button" class="text-button" data-action="notification-read" data-notification="${item.id}" ${working?'disabled':''}>标为已读</button>`:''}</div></div></li>`).join('')}</ol>`:`<div class="notifications-empty">${icon(loading?'refresh':'bell')}<strong>${loading?'正在读取通知':error?'暂时无法读取通知':filter==='unread'?'暂无未读通知':'暂无通知'}</strong>${!loading&&!error&&filter==='unread'?'<button type="button" class="text-button" data-action="notification-filter" data-filter="all">查看全部通知</button>':''}</div>`}</div>${hasMore?`<button type="button" class="notifications-more text-button" data-action="notification-more" ${loading?'disabled':''}>${loading?'正在读取…':'加载更多'}</button>`:''}`;
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
    if(destroyed||!enabled())return Promise.resolve();
    if(flight&&!force&&!append)return flight;
    const requestId=++sequence,requestedFilter=filter,demo=includeDemo();loading=true;error='';render();
    const operation=(async()=>{
      try {
        const result=await list({filter:requestedFilter,includeDemo:demo,...(append&&nextCursor?{before:nextCursor}:{})});
        if(destroyed||requestId!==sequence)return;
        const rows=(Array.isArray(result.items)?result.items:[]).filter(item=>safeId(item.id)&&['order','product'].includes(item.targetType));
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
    if(!enabled())throw new Error('通知中心仅供管理端使用。');
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
    modal('通知中心','<section id="notification-center" aria-label="通知中心"></section>',button('关闭','close','secondary'));
    render();return refresh({force:true});
  }
  const timer=setInterval(()=>{if(!document.hidden)refresh();},15000);
  window.addEventListener('focus',()=>refresh(),{signal:listeners.signal});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();},{signal:listeners.signal});
  return {open,refresh,handleAction,getUnreadCount:()=>unreadCount,destroy(){destroyed=true;sequence++;clearInterval(timer);listeners.abort();}};
}
