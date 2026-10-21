import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const bundle=(await build({entryPoints:['notifications-ui.js'],bundle:true,write:false,format:'iife',globalName:'NotificationsUI',logLevel:'silent'})).outputFiles[0].text;
const clone=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const event=(id,overrides={})=>({id,kind:'order-submitted',title:`门店 ${id} 提交了新订单`,body:`订单 ORD-${id}`,targetType:'order',targetId:`ORD-${id}`,orderId:`ORD-${id}`,createdAt:'2026-10-20T04:30:00.000Z',actorName:'门店负责人',isDemo:false,read:false,currentStatus:{label:'待配货',resolved:false},...overrides});
const response=(items,overrides={})=>({items,unreadCount:items.filter(item=>!item.read).length,latestId:Math.max(0,...items.map(item=>item.id)),nextCursor:null,hasMore:false,...overrides});

function fixture(t,options={}) {
  const dom=new JSDOM('<!doctype html><main id="app"><button id="outside">业务页面</button></main>',{url:'http://localhost:8787/?page=overview',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom;
  const timers=new Map(),clearedTimers=[];let timerId=0;
  window.setInterval=(callback,milliseconds)=>{const id=++timerId;timers.set(id,{callback,milliseconds});return id;};
  window.clearInterval=id=>{clearedTimers.push(id);timers.delete(id);};
  window.CSS={escape:value=>String(value).replace(/[^a-zA-Z0-9_-]/g,character=>`\\${character}`)};
  window.eval(bundle);
  const listCalls=[],readCalls=[],navigations=[],counts=[],modals=[];
  const ui=window.NotificationsUI.createNotificationsUI({
    list:async params=>{listCalls.push(clone(params));return options.list?options.list(params):response([]);},
    markRead:async body=>{readCalls.push(clone(body));return options.markRead?options.markRead(body):{unreadCount:0};},
    modal:(title,html,footer)=>{modals.push({title,html,footer});window.document.querySelector('.modal')?.remove();window.document.body.insertAdjacentHTML('beforeend',`<section class="modal"><h2>${escape(title)}</h2>${html}<footer>${footer}</footer></section>`);},
    button:(label,action,variant='',attributes='',glyph='')=>`<button type="button" class="${escape(variant)}" data-action="${escape(action)}" ${attributes}>${glyph?`<svg aria-hidden="true" data-icon="${escape(glyph)}"></svg>`:''}${escape(label)}</button>`,
    icon:name=>`<svg data-icon="${escape(name)}" aria-hidden="true"></svg>`,
    escape,
    includeDemo:options.includeDemo||(()=>false),
    onCount:count=>{counts.push(count);options.onCount?.(count);},
    onNavigate:async item=>{navigations.push(clone(item));await options.onNavigate?.(item);},
    enabled:options.enabled||(()=>true),
  });
  t.after(()=>{ui.destroy();window.close();});
  const document=window.document;
  const act=(action,attributes={})=>ui.handleAction(action,{dataset:attributes});
  return {window,document,ui,act,listCalls,readCalls,navigations,counts,modals,timers,clearedTimers};
}

test('opening notifications shows current state without marking anything read or changing business data',async t=>{
  const order=Object.freeze({id:'ORD-1',stage:'packing',issue:'缺货 2 包'});
  const saved=clone(order);
  const {document,ui,readCalls,navigations,listCalls}=fixture(t,{list:async()=>response([event(1,{kind:'packing-shortage',body:order.issue,currentStatus:{label:'缺货待处理',resolved:false}})])});
  await ui.open();
  assert.equal(document.querySelector('h2').textContent,'通知中心');
  assert.equal(document.querySelector('.modal').classList.contains('notifications-modal'),true);
  assert.match(document.querySelector('.notification-event-state').textContent,/缺货待处理/);
  assert.equal(document.querySelector('.notification-unread-dot').getAttribute('aria-label'),'未读');
  assert.equal(ui.getUnreadCount(),1);
  assert.deepEqual(listCalls,[{filter:'unread',includeDemo:false}]);
  assert.deepEqual(readCalls,[]);
  assert.deepEqual(navigations,[]);
  assert.deepEqual(order,saved);
});

test('marking one notice read only changes personal read state and retains the event under all',async t=>{
  const notice=event(1,{currentStatus:{label:'缺货待处理',resolved:false}});
  const order={id:'ORD-1',stage:'packing',packedQty:0,packingIssue:{type:'shortage',status:'open'}};
  const saved=clone(order);
  const {document,ui,act,readCalls,navigations}=fixture(t,{
    list:async({filter})=>response(filter==='unread'&&notice.read?[]:[notice],{unreadCount:notice.read?0:1,latestId:1}),
    markRead:async()=>{notice.read=true;return {unreadCount:0};},
  });
  await ui.open();
  await act('notification-read',{notification:'1'});
  assert.deepEqual(readCalls,[{ids:[1],includeDemo:false}]);
  assert.equal(ui.getUnreadCount(),0);
  assert.equal(document.querySelector('.notification-event'),null);
  assert.match(document.querySelector('.notifications-empty').textContent,/暂无未读通知/);
  assert.deepEqual(order,saved);
  assert.deepEqual(navigations,[]);
  await act('notification-filter',{filter:'all'});
  assert.equal(document.querySelectorAll('.notification-event').length,1);
  assert.equal(document.querySelector('.notification-event').classList.contains('is-unread'),false);
  assert.equal(document.querySelector('.notification-event-state').textContent,'缺货待处理');
  assert.equal(document.querySelector('[data-action="notification-read"]'),null);
  assert.equal(document.querySelector('[data-action="notification-read-all"]').disabled,true);
});

test('opening an unread order waits for successful read persistence before navigating',async t=>{
  const save=deferred(),notice=event(4),sequence=[];
  const {ui,act,readCalls,navigations}=fixture(t,{
    list:async()=>{sequence.push('list');return response([notice],{latestId:4});},
    markRead:async()=>{sequence.push('post-start');await save.promise;notice.read=true;sequence.push('post-done');return {unreadCount:0};},
    onNavigate:async()=>{sequence.push('navigate');},
  });
  await ui.open();
  const operation=act('notification-open',{notification:'4'});
  assert.equal(readCalls.length,1);
  assert.deepEqual(navigations,[]);
  save.resolve();await operation;
  assert.deepEqual(sequence,['list','post-start','post-done','list','navigate']);
  assert.equal(navigations[0].orderId,'ORD-4');
});

test('failed read persistence keeps the notice unread and does not navigate; retry remains available',async t=>{
  const notice=event(4);let fail=true;
  const {document,ui,act,navigations,readCalls}=fixture(t,{
    list:async()=>response([notice]),
    markRead:async()=>{if(fail)throw new Error('保存失败，请重试');notice.read=true;return {unreadCount:0};},
  });
  await ui.open();
  await act('notification-open',{notification:'4'});
  assert.equal(ui.getUnreadCount(),1);
  assert.equal(document.querySelector('.notification-event').classList.contains('is-unread'),true);
  assert.deepEqual(navigations,[]);
  assert.match(document.querySelector('[role="alert"]').textContent,/保存失败，请重试/);
  assert.ok(document.querySelector('[data-action="notification-refresh"]'));
  assert.equal(document.querySelector('[data-action="notification-read"]').disabled,false);
  fail=false;
  await act('notification-open',{notification:'4'});
  assert.equal(readCalls.length,2);
  assert.equal(navigations.length,1);
  assert.equal(ui.getUnreadCount(),0);
  assert.equal(document.querySelector('[role="alert"]'),null);
});

test('mark all uses the displayed snapshot boundary so a notification arriving during save stays unread',async t=>{
  const rows=[event(5),event(4)];let calls=0;
  const {document,ui,act,readCalls}=fixture(t,{
    includeDemo:()=>true,
    list:async({filter})=>{calls++;return response(rows.filter(row=>filter==='all'||!row.read),{unreadCount:rows.filter(row=>!row.read).length,latestId:Math.max(...rows.map(row=>row.id))});},
    markRead:async body=>{rows.unshift(event(6));for(const row of rows)if(row.id<=body.through)row.read=true;return {unreadCount:1};},
  });
  await ui.open();
  await act('notification-read-all');
  assert.deepEqual(readCalls,[{through:5,includeDemo:true}]);
  assert.equal(calls,2);
  assert.equal(ui.getUnreadCount(),1);
  assert.deepEqual([...document.querySelectorAll('.notification-event')].map(row=>row.dataset.notificationId),['6']);
  assert.ok(rows.filter(row=>row.id<6).every(row=>row.read));
});

test('an older unread-list response cannot replace the newly selected all filter',async t=>{
  const unread=deferred(),all=deferred();
  const {document,ui,act,listCalls}=fixture(t,{list:params=>params.filter==='unread'?unread.promise:all.promise});
  const opened=ui.open();
  const filtered=act('notification-filter',{filter:'all'});
  all.resolve(response([event(9,{read:true})],{unreadCount:0}));await filtered;
  unread.resolve(response([event(2)]));await opened;
  assert.deepEqual(listCalls.map(row=>row.filter),['unread','all']);
  assert.equal(document.querySelector('[aria-selected="true"]').dataset.filter,'all');
  assert.equal(document.querySelector('.notification-event').dataset.notificationId,'9');
  assert.equal(ui.getUnreadCount(),0);
  assert.equal(document.querySelector('.notifications-event-list').getAttribute('aria-busy'),'false');
});

test('a refresh failure preserves loaded notices and count until a successful retry',async t=>{
  let fail=false;
  const {document,ui,act}=fixture(t,{list:async()=>{if(fail)throw new Error('网络暂时不可用');return response([event(1)]);}});
  await ui.open();fail=true;
  await ui.refresh({force:true});
  assert.equal(document.querySelector('.notification-event').dataset.notificationId,'1');
  assert.equal(ui.getUnreadCount(),1);
  assert.match(document.querySelector('[role="alert"]').textContent,/网络暂时不可用/);
  assert.equal(document.querySelector('.notifications-event-list').getAttribute('aria-busy'),'false');
  fail=false;await act('notification-refresh');
  assert.equal(document.querySelector('[role="alert"]'),null);
  assert.equal(document.querySelector('.notification-event').dataset.notificationId,'1');
});

test('pagination requests the server cursor, appends without duplicates and ignores repeated clicks while loading',async t=>{
  const page=deferred();let pageRequests=0;
  const {document,ui,act,listCalls}=fixture(t,{list:async params=>{
    if(params.before){pageRequests++;return page.promise;}
    return response([event(6),event(5)],{unreadCount:4,latestId:6,hasMore:true,nextCursor:5});
  }});
  await ui.open();
  const more=act('notification-more');
  assert.equal(document.querySelector('[data-action="notification-more"]').disabled,true);
  await act('notification-more');
  assert.equal(pageRequests,1);
  page.resolve(response([event(5),event(4),event(3)],{unreadCount:4,latestId:6,hasMore:false}));await more;
  assert.deepEqual(listCalls,[{filter:'unread',includeDemo:false},{filter:'unread',includeDemo:false,before:5}]);
  assert.deepEqual([...document.querySelectorAll('.notification-event')].map(row=>row.dataset.notificationId),['6','5','4','3']);
  assert.equal(document.querySelector('[data-action="notification-more"]'),null);
  await act('notification-more');
  assert.equal(listCalls.length,2);
});

test('notification text, actors and current-state labels render safely; product notices retain their correct action',async t=>{
  const hostile='<img src=x onerror="window.pwned=true">';
  const {window,document,ui}=fixture(t,{list:async()=>response([event(3,{
    kind:'stock-low',targetType:'product',targetId:'p-3',productId:'p-3',orderId:undefined,
    title:hostile,body:'<script>window.pwned=true</script>',actorName:hostile,isDemo:true,
    currentStatus:{label:'已恢复 <库存>',resolved:true},
  })])});
  await ui.open();
  assert.equal(document.querySelector('.notification-event-heading strong').textContent,hostile);
  assert.equal(document.querySelector('.notification-event-content p').textContent,'<script>window.pwned=true</script>');
  assert.equal(document.querySelector('#notification-center img'),null);
  assert.equal(document.querySelector('#notification-center script'),null);
  assert.equal(window.pwned,undefined);
  assert.equal(document.querySelector('.notification-event-state').textContent,'已恢复 <库存>');
  assert.equal(document.querySelector('.notification-event-state').classList.contains('is-resolved'),true);
  assert.equal(document.querySelector('[data-action="notification-open"]').textContent,'查看商品');
  assert.match(document.querySelector('.notification-event-meta').textContent,/演示/);
});

test('already read history opens without sending another read mutation',async t=>{
  const {ui,act,readCalls,navigations}=fixture(t,{list:async()=>response([event(7,{read:true,currentStatus:{label:'已送达',resolved:true}})])});
  await ui.open();await act('notification-filter',{filter:'all'});
  await act('notification-open',{notification:'7'});
  assert.deepEqual(readCalls,[]);
  assert.equal(navigations.length,1);
  assert.equal(navigations[0].currentStatus.label,'已送达');
});

test('repeated read actions during a save do not send duplicate writes',async t=>{
  const save=deferred();
  const {ui,act,readCalls}=fixture(t,{list:async()=>response([event(1)]),markRead:()=>save.promise});
  await ui.open();
  const first=act('notification-read',{notification:'1'});
  await act('notification-read',{notification:'1'});
  await act('notification-read-all');
  assert.equal(readCalls.length,1);
  save.resolve({unreadCount:0});await first;
});

test('disabled portals cannot open, refresh or act on notifications',async t=>{
  const {ui,act,listCalls,readCalls,modals}=fixture(t,{enabled:()=>false});
  await ui.open();await ui.refresh();
  await assert.rejects(act('notification-read-all'),/仅供管理端/);
  assert.equal(await act('unrelated-action'),false);
  assert.deepEqual(listCalls,[]);
  assert.deepEqual(readCalls,[]);
  assert.deepEqual(modals,[]);
});

test('destroy removes focus and refresh timers and rejects late list results',async t=>{
  const result=deferred();
  const {window,document,ui,timers,clearedTimers,listCalls,counts}=fixture(t,{list:()=>result.promise});
  const opening=ui.open();
  assert.equal(timers.size,1);
  assert.equal([...timers.values()][0].milliseconds,15000);
  ui.destroy();
  assert.equal(timers.size,0);
  assert.equal(clearedTimers.length,1);
  window.dispatchEvent(new window.Event('focus'));
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await ui.refresh();
  result.resolve(response([event(1)]));await opening;
  assert.equal(listCalls.length,1);
  assert.deepEqual(counts,[]);
  assert.equal(document.querySelector('.notification-event'),null);
});

test('refresh retains list scroll and keyboard focus for a still available action',async t=>{
  const {document,ui}=fixture(t,{list:async()=>response([event(1),event(2)])});
  await ui.open();
  document.querySelector('.notifications-event-list').scrollTop=72;
  document.querySelector('[data-action="notification-open"][data-notification="2"]').focus();
  await ui.refresh({force:true});
  assert.equal(document.querySelector('.notifications-event-list').scrollTop,72);
  assert.equal(document.activeElement.dataset.action,'notification-open');
  assert.equal(document.activeElement.dataset.notification,'2');
});
