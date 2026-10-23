import {createAccountsUI} from './accounts-ui.js';
import {setPortalIcon} from './portal-icon.js';
import {createFlowUI} from './flow-ui.js';
import {createNotificationsUI} from './notifications-ui.js';
import {createLocalNotifications} from './local-notifications.js';
import {isPackingShortage} from './notification-domain.js';
import { KitchenModel, DEMO_DATE, money, STORAGE_KEY, isWeightUnit, categories as businessCategories, SALE_UNIT_OPTIONS } from './data.js';
import { createBusinessUI } from './business-ui.js';
import { createStoreUI } from './store-ui.js';
import { initSelectControls } from './ui-controls.js';
import { createUIMotion } from './ui-motion.js';
import { createSettlementUI } from './settlement-ui.js';
import { createOverviewUI } from './overview-ui.js';
import { createTasksUI } from './tasks-ui.js';
import { notificationQueue } from './overview-data.js';
import { company } from './business-data.js';
import { isCloud, principal, createCloudModel, cloudRequest, imageDataBlob } from './cloud-client.js';

const model = isCloud ? createCloudModel(window.__KURAFLOW_SESSION__) : new KitchenModel();
const app = document.querySelector('#app');
const overlay = document.querySelector('#overlay-root');
let notificationsUI,localNotifications;
initSelectControls();
const uiMotion = createUIMotion(app);
const pageParams = new URLSearchParams(location.search);
const clientPortal = !isCloud && pageParams.get('view') === 'client';
const initialClient = isCloud ? principal?.role === 'store' : clientPortal;
setPortalIcon(initialClient ? 'store' : 'kitchen');
const clientSessionKey = 'kuraflow-preview-store-session';
let localClientCode = '';
try { if (clientPortal) localClientCode = sessionStorage.getItem(clientSessionKey) || ''; } catch { /* Preview login can stay in memory. */ }
const previewDrafts = new Map();
function previewClientStore() { return clientPortal ? model.getStoreByAccessCode(localClientCode) : null; }
function restoreClientDraft() {
  const store = previewClientStore();
  if (!store) return;
  const draftKey = 'kuraflow-preview-draft:' + store.id;
  let draft = previewDrafts.get(store.id);
  if (!draft) { try { draft = JSON.parse(sessionStorage.getItem(draftKey) || '{}'); } catch { draft = {}; } }
  draft = { ...draft, cart: { ...draft.cart }, cartUnits: { ...draft.cartUnits } };
  for (const id of new Set([...Object.keys(draft.cart), ...Object.keys(draft.cartUnits)])) {
    if (!model.getProduct(id) || model.getProduct(id).deletedAt) {
      delete draft.cart[id]; delete draft.cartUnits[id];
    }
  }
  previewDrafts.set(store.id, draft);
  try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* In-memory drafts still work. */ }
  Object.assign(model.state, { activeStoreId: store.id, cart: draft.cart || {}, cartUnits: draft.cartUnits || {}, cartNote: draft.cartNote || '', cartDeliveryDate: draft.cartDeliveryDate || '' });
}
if (clientPortal) {
  const originalSave = model.save.bind(model);
  model.save = () => {
    const store = previewClientStore();
    if (store) {
      model.state.activeStoreId = store.id;
      const {cart, cartUnits, cartNote, cartDeliveryDate} = model.state;
      const draft = structuredClone({cart, cartUnits, cartNote, cartDeliveryDate});
      previewDrafts.set(store.id, draft);
      try { sessionStorage.setItem('kuraflow-preview-draft:' + store.id, JSON.stringify(draft)); } catch { /* In-memory drafts still work. */ }
    }
    return originalSave();
  };
  restoreClientDraft();
}
const ui = { role: initialClient ? 'client' : 'admin', page: initialClient ? (isCloud&&pageParams.get('page')==='team'?'team':'products') : (['overview','tasks','orders','delivery','catalogue','stores','costs','documents','materials','team'].includes(pageParams.get('page')) ? (pageParams.get('page') === 'delivery' ? 'orders' : pageParams.get('page') === 'costs' ? 'catalogue' : pageParams.get('page')) : 'overview'), productTab: pageParams.get('page') === 'costs' || pageParams.get('tab') === 'costs' ? 'costs' : 'inventory', storeTab: pageParams.get('tab') === 'quotes' ? 'quotes' : 'stores', date: /^\d{4}-\d{2}-\d{2}$/.test(pageParams.get('date') || '') ? pageParams.get('date') : DEMO_DATE, status: 'all', query: '', category: '全部商品', catalogueTrash: !initialClient && pageParams.get('recycle') === '1', recycleQuery: '', quoteStore: pageParams.get('store') || model.state.activeStoreId, mobile: false, orderId: !initialClient && ['orders', 'delivery'].includes(pageParams.get('page')) ? pageParams.get('order') : null };
Object.assign(ui, { settlementStore:pageParams.get('page') === 'documents' ? pageParams.get('store') || '' : '', settlementMonth:pageParams.get('month') || '', settlementView:pageParams.get('tab') === 'monthly' ? 'monthly' : 'orders', settlementDemo:pageParams.get('demo') === '1' });
Object.assign(ui, { businessRange:['week','month','custom'].includes(pageParams.get('range')) ? pageParams.get('range') : 'month', businessStart:pageParams.get('from') || '', businessEnd:pageParams.get('to') || '', businessMetric:'amount', taskTab:pageParams.get('tab')==='manual'?'manual':'system', taskFilters:{system:pageParams.get('tab')!=='manual'?pageParams.get('filter')||'all':'all',manual:pageParams.get('tab')==='manual'?pageParams.get('filter')||'all':'all'}, businessDemo:['overview','tasks'].includes(pageParams.get('page')) && pageParams.has('demo') ? pageParams.get('demo') === '1' : !isCloud });
const labels = { pending: '待配货', packing: '配货中', ready: '待配送', delivering: '配送中', delivered: '已送达' };
const stages = ['pending', 'packing', 'ready', 'delivering', 'delivered'];
const categories = ['全部商品', ...businessCategories];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number(v || 0).toLocaleString('zh-CN');
const icons = {
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  box: '<path d="m3 7 9-5 9 5-9 5z"/><path d="M3 7v10l9 5 9-5V7M12 12v10M7.5 4.5l9 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="m8 13 2 2 5-5"/>',
  truck: '<path d="M3 5h11v12H3zM14 9h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  tag: '<path d="M21 13 13 21 3 11V3h8z"/><circle cx="7.5" cy="7.5" r="1"/>',
  store: '<path d="m3 9 2-6h14l2 6M3 9v2a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9M5 14v7h14v-7M9 21v-6h6v6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h12M9 12h12M9 18h12"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2zM12 9v4M12 17h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  leaf: '<path d="M20 3C10 3 3 8 4 15s15 7 16-12Z"/><path d="M3 21 15 9"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M17 11h4v5h-4a2.5 2.5 0 0 1 0-5ZM3 7V4l14-2v3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  minus: '<path d="M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
};
function icon(name, cls = '') { return `<span class="icon ${cls}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg></span>`; }
function button(text, action, type = 'secondary', extra = '', ico = '') { return `<button class="btn btn-${type}" data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${text}</button>`; }
function statusBadge(stage) { return `<span class="status-badge ${stage}"><i></i>${labels[stage]}</span>`; }
function storeAvatar(store) { if (store.image) return `<img class="store-avatar store-photo" src="${escape(store.image)}" alt="${escape(store.name)}门店图">`; return `<div class="store-avatar ${['mint', 'lavender', 'peach', 'sky', 'rose'][model.state.stores.indexOf(store) % 5] || 'mint'}">${escape(store.name.includes('杨国福') ? '杨' : store.name.slice(0, 1))}</div>`; }
function safeProfileImage(value,kind) {
  if(typeof value!=='string'||!value.startsWith('/api/'))return '';
  try{const url=new URL(value,location.origin);return url.origin===location.origin&&url.pathname===(kind==='organization'?'/api/organization-avatar':'/api/account-avatar')?value:'';}catch{return '';}
}
function personPortrait() {
  const image=safeProfileImage(principal?.avatarUrl,'account');
  return image?`<img src="${escape(image)}" alt="个人头像">`:escape(isCloud?(principal.displayName||'用户').slice(0,1):ui.role==='admin'?'管':'店');
}
function organizationPortrait() {
  const image=safeProfileImage(principal?.organizationAvatarUrl,'organization');
  return image?`<img src="${escape(image)}" alt="厨房头像">`:icon('store');
}
function syncAccountProfiles({account,organization}={}) {
  if(!isCloud)return;
  if(account?.id===principal.userId) {
    for(const key of ['avatarUrl','avatarVersion'])if(Object.hasOwn(account,key))principal[key]=account[key];
    if(account.name)principal.displayName=account.name;
  }
  if(organization?.tenantId===principal.tenantId) {
    if(Object.hasOwn(organization,'avatarUrl'))principal.organizationAvatarUrl=organization.avatarUrl;
    if(Object.hasOwn(organization,'avatarVersion'))principal.organizationAvatarVersion=organization.avatarVersion;
  }
  app.querySelectorAll('[data-person-avatar]').forEach(node=>{node.innerHTML=personPortrait();});
  const org=app.querySelector('.workspace-avatar');if(org&&ui.role==='admin')org.innerHTML=organizationPortrait();
  const name=app.querySelector('.sidebar-profile strong');if(name)name.textContent=principal.displayName;
}
function dateLabel(date) { return new Date(date + 'T12:00:00+09:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Tokyo' }); }
function dailyOrders() { return model.state.orders.filter(o => o.deliveryDate === ui.date); }
function linePacked(line) { return line.packedQty === line.qty && line.packingConfirmed !== false; }
function packedCount(order) { return order.items.filter(linePacked).length; }
function packedPercent(order) { return order.items.length ? Math.round(packedCount(order) / order.items.length * 100) : 0; }
function quoteStore() { return model.getStores().find(store => store.id === ui.quoteStore) || model.getStores()[0]; }
function activeStore() { return model.getStores().find(store => store.id === model.state.activeStoreId) || model.getStores()[0]; }
function clientStoreHeader(store = activeStore()) {
  return `<div class="client-store">${storeAvatar(store)}<div><strong>${escape(store.name)}</strong><p class="client-store-address">${icon('pin')}<span>${escape(store.address || '配送地址待补充')}</span></p></div></div>`;
}
function syncClientIdentity() {
  if (ui.role !== 'client') return;
  const store = activeStore();
  if (!store) return;
  document.title = store.name + ' · 门店订货 | 倉流';
  const banner = app.querySelector('.client-store');
  if (banner) banner.outerHTML = clientStoreHeader(store);
  const name = app.querySelector('.workspace-copy strong');
  if (name) name.textContent = store.name;
  const avatar = app.querySelector('.workspace-avatar');
  if (avatar) avatar.innerHTML = storeAvatar(store);
  const contact = app.querySelector('.sidebar-profile strong');
  if (contact) contact.textContent = isCloud ? principal.displayName : store.contact || '门店账号';
}
function cartItems() { return Object.entries(model.state.cart || {}).filter(([id, q]) => q > 0 && model.getProduct(id) && !model.getProduct(id).deletedAt).map(([id, qty]) => ({ product: model.getProduct(id), qty, unit: model.getCartUnit(id), price: model.getUnitQuote(activeStore().id,id,model.getCartUnit(id)).price })); }
function cartTotal() { return Math.round(cartItems().reduce((sum, i) => sum + Math.round(i.qty * i.price * 100) / 100, 0) * 100) / 100; }
function titleHeading(title, sub, actions = '', eyebrow = '') { return `<div class="page-heading"><div class="heading-copy"><h1>${title}</h1></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`; }
function managementTabs(group, active) {
  const tabs = group === 'products' ? [['inventory', 'box', '商品与库存'], ['costs', 'wallet', '采购成本']] : [['stores', 'store', '门店与账号'], ['quotes', 'tag', '门店报价']];
  return `<div class="catalogue-layer-switch management-tabs" role="tablist" aria-label="${group === 'products' ? '商品管理' : '门店管理'}分区">${tabs.map(([key, ico, label], index) => `<button type="button" role="tab" aria-selected="${active === key}" class="catalogue-layer management-tab ${active === key ? 'active' : ''}" data-action="management-tab" data-group="${group}" data-tab="${key}" data-layer="${index ? 'store' : 'warehouse'}">${icon(ico)}<div><strong>${label}</strong></div></button>`).join('')}</div>`;
}
function managementHeading(group, active, actions = '') {
  return `<div class="page-heading management-heading"><div class="management-heading-main"><h1>${group === 'products' ? '商品管理' : '门店管理'}</h1>${managementTabs(group, active)}</div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}
function productManagementPage() {
  ui.catalogueLayer = 'warehouse';
  return ui.productTab === 'costs' && !ui.catalogueTrash ? businessUI.costsPage() : businessUI.cataloguePage();
}
function storeManagementPage() {
  ui.catalogueLayer = 'store';
  return ui.storeTab === 'quotes' ? businessUI.cataloguePage() : storesPage();
}
function dateControl() { return `<label class="date-control"><input aria-label="配送日期" type="date" id="admin-date" required value="${ui.date}"></label>`; }
function filteredOrders() { return dailyOrders().filter(o => (ui.status === 'all' || o.stage === ui.status) && (model.getStore(o.storeId).name + o.id).toLowerCase().includes(ui.query.toLowerCase())); }
function shell() {
  const adminNav = [['overview', 'grid', '经营概览'], ['tasks', 'list', '待办事项'], ['orders', 'clipboard', '订单履约'], ['catalogue', 'tag', '商品管理'], ['stores', 'store', '门店管理'], ['documents', 'clipboard', '月结与统计']];
  const clientNav = [['products', 'box', '我要订货'], ['my-orders', 'clipboard', '我的订单'], ['my-statements', 'wallet', '我的月结与统计'], ['account', 'store', '门店信息']];
  const nav = ui.role === 'admin' ? adminNav : clientNav;
  const currentNav = nav.find(n => n[0] === ui.page) || (ui.page==='team'?['team','user','员工管理']:null) || (ui.page === 'materials' ? ['materials', 'clipboard', '资料与业务规则'] : null);
  const searchingRecycle = ui.role === 'admin' && ui.page === 'catalogue' && ui.catalogueTrash;
  const pending = model.state.orders.filter(o => ['pending', 'packing'].includes(o.stage)).length;
  const store = activeStore();
  return `<div class="app-shell ${ui.mobile ? 'mobile-open' : ''}">
    <aside class="sidebar"><a class="brand" href="#" data-action="home"><div class="brand-mark">${icon('box')}</div><div><div class="brand-name">倉流<span>KURAFLOW</span></div></div></a>
      <div class="workspace-switch">${ui.role==='admin'&&isCloud&&principal.accountRole==='owner'?`<button type="button" class="workspace-avatar workspace-avatar-button" data-action="organization-avatar" aria-label="修改厨房头像" title="修改厨房头像">${organizationPortrait()}</button>`:`<div class="workspace-avatar">${ui.role === 'admin' ? organizationPortrait() : storeAvatar(store)}</div>`}<div class="workspace-copy"><strong>${ui.role === 'admin' ? escape(company.name) : escape(store.name)}</strong></div></div>
      <div class="sidebar-label">${ui.role === 'admin' ? '运营管理' : '门店服务'}</div><nav class="nav-list">${nav.map(([page, ico, label]) => `<button class="nav-item ${ui.page === page ? 'active' : ''}" data-page="${page}"><span class="nav-icon">${icon(ico)}</span><span>${label}</span>${page === 'orders' && pending ? `<span class="nav-count">${pending}</span>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-footer"><button class="support-link" data-action="help">${icon('help')} 使用指南 ${icon('arrow')}</button>${isCloud?`<button type="button" class="sidebar-profile profile-entry" data-action="open-own-team" aria-label="员工管理与我的账号" title="员工管理与我的账号">`:'<div class="sidebar-profile">'}<div class="user-avatar" data-person-avatar>${personPortrait()}</div><div><strong>${isCloud?escape(principal.displayName):ui.role === 'admin' ? '管理员' : escape(store.contact)}</strong><span>${isCloud?(principal.accountRole==='owner'?'负责人 · 员工管理':'管理员 · 我的账号'):ui.role === 'admin' ? '管理员' : '门店采购负责人'}</span></div>${isCloud?icon('chevron'):'<span class="demo-indicator">演示</span>'}${isCloud?'</button>':'</div>'}</div>
    </aside><div class="mobile-backdrop" data-action="mobile-close"></div>
    <main class="main-shell"><header class="topbar"><div class="breadcrumb"><button class="icon-button menu-button" data-action="mobile-menu" aria-label="打开菜单">${icon('menu')}</button><strong>${currentNav?.[2] || ''}</strong>${ui.orderId && ui.page === 'orders' ? icon('chevron') + '<strong>货单详情</strong>' : ''}</div><div class="topbar-right"><label class="search-box">${icon('search')}<input id="global-search" placeholder="${searchingRecycle ? '搜索已删除商品…' : ui.role === 'admin' ? '搜索门店、订单…' : '搜索商品…'}" aria-label="搜索" value="${escape(searchingRecycle ? ui.recycleQuery : ui.query)}"><span class="search-shortcut">↵</span></label>${isCloud ? `<div class="cloud-session-actions"><span class="cloud-online-label" id="cloud-sync-status">已连接</span><button class="text-button" data-action="logout">退出</button></div>` : clientPortal ? '<button class="text-button" data-action="client-logout">退出登录</button>' : ''}${flowUI.launcher({compact:true})}${notificationButton()}${isCloud?`<button type="button" class="topbar-user personal-profile-button" data-action="open-own-team" aria-label="我的账号与员工管理" data-person-avatar>${personPortrait()}</button>`:`<div class="topbar-user">${ui.role === 'admin' ? '管' : '店'}</div>`}</div></header>
    <div class="page-content">${pageContent()}<footer class="page-footer"><span>倉流 KURAFLOW</span><span>${isCloud ? '云端工作台 · 东京时间 · 日元报价' : '本机交互演示 · 东京时间 · 日元报价 · 税口径按来源'}</span></footer></div></main></div>`;
}
function pageContent() {
  if(isCloud && ['overview','documents','my-statements'].includes(ui.page) && !model.reportHistoryReady) {
    if(!model.reportHistoryError && !model.pending) queueMicrotask(()=>model.loadReportHistory().then(()=>{
      if(['overview','documents','my-statements'].includes(ui.page) && !overlay.firstChild && !model.pending) render();
    }));
    return emptyState(model.reportHistoryError?'历史订单读取失败':'正在读取历史订单',model.reportHistoryError||'','clipboard')+(model.reportHistoryError?button('重新加载','reload-report-history','secondary'):'');
  }
  const pages = { team: () => accountsUI.page(), overview: overviewPage, tasks: () => tasksUI.page(), orders: () => ui.orderId ? orderDetailPage() : ordersPage(), delivery: ordersPage, catalogue: productManagementPage, stores: storeManagementPage, products: businessUI.clientProductsPage, costs: businessUI.costsPage, documents: () => settlementUI.page(), materials: businessUI.materialsPage, 'my-statements': () => settlementUI.page(), 'my-orders': clientOrdersPage, account: accountPage };
  return (pages[ui.page] || overviewPage)();
}
function renderClientLogin(message = '', value = '') {
  document.title = '门店登录 | 倉流 KURAFLOW';
  app.innerHTML = `<main class="store-login-shell"><section class="section-card store-login-card"><a class="store-login-brand" aria-label="倉流 KURAFLOW">${icon('box')}<strong>倉流 <span>KURAFLOW</span></strong></a><div class="eyebrow">RESTAURANT WORKSPACE</div><h1>登录你的门店</h1><form id="store-login-form"><div class="field"><label for="store-login-code">门店识别码</label><input class="input" id="store-login-code" name="accessCode" type="text" value="${escape(value)}" placeholder="XXXX-XXXX-XXXX-XXXX" required maxlength="24" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="store-login-hint store-login-error"></div><p class="form-hint" id="store-login-hint">16 位大写字母与数字，可直接粘贴识别码。</p><p class="store-login-error" id="store-login-error" role="alert">${escape(message)}</p><button class="btn btn-primary store-login-submit" type="submit">进入门店工作台 ${icon('arrow')}</button></form><p class="store-login-help">还没有识别码？请联系管理员。</p><span class="store-preview-label">本地交互预览</span></section></main>`;
}
function render() {
  const motionBefore = uiMotion.capture();
  if (clientPortal) {
    const store = previewClientStore();
    if (!store) { renderClientLogin(); return; }
    model.state.activeStoreId = store.id;
  }
  ui.localRefreshPending = false; ui.cloudRefreshPending = false;
  if (ui.role === 'client') model.normalizeStoreCart(activeStore().id);
  const catalogue = ui.role === 'client' ? model.getOrderableProducts(activeStore().id) : model.getProducts();
  if (ui.category !== '全部商品' && !catalogue.some(p => p.category === ui.category)) ui.category = '全部商品';
  document.title = (ui.role === 'admin' ? '每度商事 · 管理工作台' : activeStore().name + ' · 门店订货') + ' | 倉流'; app.innerHTML = shell();
  uiMotion.afterRender([ui.role, ui.page, ui.page === 'catalogue' ? ui.productTab + ':' + ui.catalogueTrash : ui.page === 'stores' ? ui.storeTab : ui.orderId || ''].join(':'), ui.page === 'orders' ? ui.status : '', motionBefore);
  flowUI.sync();
  scheduleOrderContext();
}
let orderContextFrame = 0;
function scheduleOrderContext() {
  if (orderContextFrame) return;
  orderContextFrame = requestAnimationFrame(() => {
    orderContextFrame = 0;
    const summary = app.querySelector('.order-detail-summary'), bar = app.querySelector('.order-context-bar');
    if (!summary || !bar) return;
    const rect = summary.getBoundingClientRect(), top = (app.querySelector('.topbar')?.getBoundingClientRect().bottom || 0) + 8;
    bar.hidden = rect.bottom > top;
    if (!bar.hidden) Object.assign(bar.style, { top: `${top}px`, left: `${rect.left}px`, width: `${rect.width}px` });
  });
}
window.addEventListener('scroll', scheduleOrderContext, { passive: true });
window.addEventListener('resize', scheduleOrderContext);
function hasLocalDraftEditor() {
  return Boolean(overlay.firstChild || document.querySelector('.inventory-editor, .quote-entry, [data-packing-saving]') || [...document.querySelectorAll('.inline-editor-feedback')].some(el => el.textContent === '未保存'));
}
function refreshLocalWhenReady() {
  if (!isCloud && ui.localRefreshPending && !hasLocalDraftEditor()) render();
}
function statCard(label, value, foot, ico, cls = '') { return `<article class="stat-card"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon ${cls}">${icon(ico)}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`; }
function overviewPage() { return overviewUI.page(); }

function ordersTable(orders) {
  if (!orders.length) return emptyState('当前没有订单', '可调整日期查看历史订单；门店提交的新订单会显示在这里。', 'clipboard');
  return `<div class="table-scroll" tabindex="0"><div class="table-scroll-hint">↔ 左右滑动查看全部列</div><table class="orders-table"><thead><tr><th>门店 / 订单</th><th>货品</th><th>订单金额</th><th>配货进度</th><th>状态</th><th class="align-right">操作</th></tr></thead><tbody>${orders.map(o => {
    const store = model.getStore(o.storeId);
    return `<tr><td><div class="store-cell">${storeAvatar(store)}<div class="cell-content"><div class="cell-primary">${escape(store.name)}</div><div class="cell-secondary">${o.id} ${o.isDemo ? '<span class="source-label">演示</span>' : ''} <span>·</span> ${escape(store.city)}</div></div></div></td><td><span class="cell-primary">${o.items.length} 种</span><div class="cell-secondary">统一规格</div></td><td class="amount-cell">${money(model.orderTotal(o))}${model.orderUnquotedCount(o) ? '<div class="cell-secondary">' + model.orderUnquotedCount(o) + ' 项待报价</div>' : ''}</td><td><div class="progress-label"><span>${packedCount(o)} / ${o.items.length}</span><span>${packedPercent(o)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${packedPercent(o)}%"></div></div></td><td>${statusBadge(o.stage)}</td><td class="align-right"><button class="table-action" data-action="order-detail" data-id="${o.id}">${['pending', 'packing'].includes(o.stage) ? '去配货' : '查看'} ${icon('chevron')}</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function categorySummary(orders) {
  const cats = categories.slice(1).map((category) => ({ category, count: orders.reduce((sum, o) => sum + o.items.filter(i => model.getProduct(i.productId).category === category).length, 0), packed: orders.reduce((sum, o) => sum + o.items.filter(i => model.getProduct(i.productId).category === category && linePacked(i)).length, 0) }));
  const max = Math.max(...cats.map(c => c.count), 1);
  return `<section class="section-card category-summary"><div class="section-header"><div><h2 class="section-title">各品类配货进度</h2></div><div class="chart-legend"><span><i class="legend-dot"></i>已核对</span><span><i class="legend-dot muted"></i>待核对</span></div></div><div class="category-bars">${cats.map(c => `<div class="category-bar-row"><span>${c.category}</span><div class="category-bar-track"><div style="width:${c.count / max * 100}%" class="category-bar-total"><div class="category-bar-packed" style="width:${c.count ? c.packed / c.count * 100 : 0}%"></div></div></div><strong>${c.packed}<span> / ${c.count}</span></strong></div>`).join('')}</div></section>`;
}
function alertsPanel(orders) {
  const packing = orders.filter(o => ['pending', 'packing'].includes(o.stage));
  const shortage = model.getProducts().filter(p => model.getStock(p.id) !== null && model.getStock(p.id) < 6);
  return `<section class="section-card"><div class="section-header"><h2 class="section-title">${icon('bell')} 待办提醒 <span class="counter orange">${packing.length + shortage.length}</span></h2></div><div class="alert-list">${packing.slice(0, 2).map(o => `<div class="alert-item"><div class="alert-symbol orange">${icon('box')}</div><div class="alert-copy"><strong>${escape(model.getStore(o.storeId).name)}</strong><p>${o.stage === 'pending' ? '订单尚未开始配货' : `还有 ${o.items.filter(i => i.packedQty < i.qty).length} 种货品未配齐`}</p><button class="text-button" data-action="order-detail" data-id="${o.id}">处理订单 ${icon('arrow')}</button></div></div>`).join('')}${shortage.slice(0, 1).map(p => `<div class="alert-item"><div class="alert-symbol red">${icon('alert')}</div><div class="alert-copy"><strong>${escape(p.name)}库存偏低</strong><p>可订库存仅剩 ${model.getStock(p.id)} ${p.unit}，请及时补货</p><button class="text-button" data-page="catalogue">查看库存 ${icon('arrow')}</button></div></div>`).join('')}${!packing.length && !shortage.length ? '<div class="all-clear">今日待办已全部处理 ✓</div>' : ''}</div><div class="section-footer"><button class="text-button" data-action="notifications">查看全部提醒 ${icon('arrow')}</button></div></section>`;
}
function routePanel(orders) {
  const active = orders.filter(o => ['ready', 'delivering'].includes(o.stage)).slice(0, 3);
  return `<section class="section-card route-summary"><div class="section-header"><h2 class="section-title">配送动态</h2><span class="live-pill"><i></i>实时</span></div><div class="route-header"><span class="route-region">关西配送</span><strong>${orders.filter(o => o.stage === 'delivering').length}<small> 单配送中</small></strong></div><div class="route-stops">${active.length ? active.map((o, i) => `<div class="route-stop"><div class="route-dot ${o.stage === 'delivering' ? 'active' : ''}">${i + 1}</div><div class="route-meta"><strong>${escape(model.getStore(o.storeId).name.replace('杨国福', ''))}</strong><span>${labels[o.stage]} · ${o.items.length} 种货品</span></div><button class="icon-button" aria-label="查看${escape(model.getStore(o.storeId).name)}订单" data-action="order-detail" data-id="${o.id}">${icon('chevron')}</button></div>`).join('') : '<p class="muted-copy">目前没有待发出的订单。</p>'}</div><div class="driver-card">${icon('truck')}<div><strong>配送流程</strong><span>配齐 → 出发 → 确认送达</span></div></div><div class="section-footer"><button class="text-button" data-page="orders">查看订单履约 ${icon('arrow')}</button></div></section>`;
}
function filterTabs() { return `<div class="tabs">${[['all', '全部订单'], ...Object.entries(labels)].map(([stage, label]) => `<button class="tab ${ui.status === stage ? 'active' : ''}" data-action="filter-status" data-status="${stage}">${label} <span>${dailyOrders().filter(o => stage === 'all' || o.stage === stage).length}</span></button>`).join('')}</div>`; }
function ordersPage() {
  const orders = filteredOrders().slice().sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage));
  return titleHeading('订单履约', '', dateControl() + button('导出配货单', 'export', 'secondary', '', 'download')) +
    `<section class="section-card fulfillment-workspace"><div class="filter-bar">${filterTabs()}</div><div class="list-search"><label class="search-box">${icon('search')}<input id="list-search" value="${escape(ui.query)}" placeholder="门店名称或订单编号" aria-label="搜索订单"></label><span>${orders.length} 笔订单</span></div></section><div class="fulfillment-list">${orders.map(o => {
      const store = model.getStore(o.storeId);
      const action = ['pending','packing'].includes(o.stage) ? button(o.stage === 'pending' ? '开始配货' : '继续配货', 'order-detail', 'primary', `data-id="${o.id}"`, 'box')
        : o.stage === 'ready' ? button('开始配送', 'stage', 'primary', `data-id="${o.id}" data-stage="delivering"`, 'truck')
        : o.stage === 'delivering' ? button('确认送达', 'confirm-delivery', 'primary', `data-id="${o.id}"`, 'check') : '';
      return `<article class="section-card fulfillment-card" data-fulfillment-order="${o.id}"><div class="fulfillment-card-heading"><div class="store-cell">${storeAvatar(store)}<div class="fulfillment-identity"><div class="fulfillment-title-row"><h2>${escape(store.name)}</h2><div class="fulfillment-address">${icon('pin')}<span>${escape(store.address || '地址待填写')}</span></div></div><div class="cell-secondary">${escape(o.id)}${o.isDemo ? ' · 演示' : ''}${store.deletedAt ? ' · 门店已删除' : ''}</div></div></div>${statusBadge(o.stage)}</div><div class="fulfillment-card-body"><dl class="fulfillment-facts"><div><dt>配送日期</dt><dd>${o.deliveryDate}</dd></div><div><dt>商品</dt><dd>${o.items.length} 种</dd></div><div><dt>已配齐</dt><dd>${packedCount(o)} / ${o.items.length}</dd></div><div><dt>报价金额</dt><dd>${money(model.orderTotal(o))}${model.orderUnquotedCount(o) ? `<small>${model.orderUnquotedCount(o)} 项待报价</small>` : ''}</dd></div></dl>${orderIssueHTML(o)}</div><div class="fulfillment-card-footer">${fulfillmentSteps(o)}<div class="fulfillment-actions">${['pending','packing'].includes(o.stage) ? '' : button('订单明细','order-detail','secondary',`data-id="${o.id}"`)}${action}</div></div></article>`;
    }).join('') || emptyState('暂无订单', '调整日期或状态查看。', 'clipboard')}</div>`;
}
function storesPage() { return storeUI.storesPage(); }
function clientStoreSelect() { return ''; }
function qtyControl(id, qty, max) { const p = {...model.getProduct(id),unit:model.getCartUnit(id)}; return `<div class="qty-control"><button data-action="cart-minus" data-id="${id}" aria-label="减少${escape(p.name)}数量" ${qty <= 0 ? 'disabled' : ''}>${icon('minus')}</button><input type="number" min="0" ${max === null ? '' : 'max="' + max + '"'} step="${isWeightUnit(p.unit) ? '0.001' : '1'}" value="${qty}" data-cart-input="${id}" aria-label="${escape(p.name)}订购数量（${escape(p.unit)}）"><button data-action="cart-plus" data-id="${id}" aria-label="增加${escape(p.name)}数量" ${max !== null && qty >= max ? 'disabled' : ''}>${icon('plus')}</button></div>`; }
function mobileCartBar() { return cartItems().length ? `<div class="mobile-cart-bar"><div><span>${cartItems().length} 种商品 · 商品金额</span><strong>${money(cartTotal())}</strong></div>${button('查看订货单', 'cart-scroll', 'primary', '', 'arrow')}</div>` : ''; }
function cartPanel() {
  const items = cartItems();
  const nextDay = new Date(new Date(`${DEMO_DATE}T12:00:00+09:00`).getTime() + 86400000).toISOString().slice(0, 10);
  const date = model.state.cartDeliveryDate || (isCloud ? nextDay : '2026-10-09');
  return `<aside class="cart-panel section-card"><div class="section-header"><h2 class="section-title">我的订货单 <span class="counter">${items.length}</span></h2>${items.length ? '<button class="text-button" data-action="clear-cart">清空</button>' : ''}</div><div class="cart-body">${items.length ? `<div class="cart-lines">${items.map(i => `<div class="cart-line"><span class="cart-product-icon">${icon('box')}</span><div class="cart-line-details"><strong>${escape(i.product.name)}</strong><span>${money(i.price)} / ${i.unit} × ${i.qty}</span></div><strong>${money(i.qty * i.price)}</strong><button class="icon-button" data-action="remove-cart" data-id="${i.product.id}" aria-label="移除${escape(i.product.name)}">${icon('close')}</button></div>`).join('')}</div>` : `<div class="cart-empty">${icon('box')}<strong>尚未选择商品</strong><p>点击商品旁的 + 开始订货</p></div>`}<div class="field"><label for="delivery-date">期望配送日期</label><input class="input" type="date" id="delivery-date" required min="${DEMO_DATE}" value="${escape(date)}"></div><div class="field"><label for="order-note">配送备注 <span>选填</span></label><textarea class="input" id="order-note" rows="2" placeholder="例如：请在午市前送达">${escape(model.state.cartNote || '')}</textarea></div><div class="cart-summary"><span>${items.length} 种商品 · 日元报价</span><div class="cart-total"><span>商品小计</span><strong>${money(cartTotal())}</strong></div></div>${button('提交订货单', 'submit-order', 'primary', items.length ? '' : 'disabled', 'arrow')}<p class="cart-hint">${icon('check')} 提交后厨房即可接收并安排配货</p></div></aside>`;
}
function clientOrdersPage() {
  const orders = model.state.orders.filter(o => o.storeId === activeStore().id).slice().sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return titleHeading('我的订单', '查看订单明细、配货进度与配送状态。', clientStoreSelect() + button('继续订货', 'client-products', 'primary', '', 'plus'), 'YOUR ORDERS') +
    `<div class="order-cards">${orders.map(o => `<article class="order-card section-card"><div class="order-card-header"><div><strong>${o.id}</strong><span>配送日期：${o.deliveryDate}</span></div>${statusBadge(o.stage)}</div><div class="client-order-progress">${stages.map((s, i) => `<div class="delivery-step ${stages.indexOf(o.stage) >= i ? 'done' : ''}"><i>${stages.indexOf(o.stage) > i ? '✓' : i + 1}</i><span>${labels[s]}</span></div>`).join('')}</div><div class="order-line-summary">${o.items.map(i => `<div><span>${escape(model.getProduct(i.productId).icon)} ${escape(model.getProduct(i.productId).name)} <small>× ${i.qty} ${i.unit || model.getProduct(i.productId).unit}</small></span><strong>${money(lineAmount(i))}</strong></div>`).join('')}</div>${o.issue ? `<div class="notice ${o.issueResolvedAt?'':'notice-warning'}">${icon(o.issueResolvedAt?'check':'alert')} 厨房提醒：${escape(o.issue)}${o.issueResolvedAt?' · 已处理':''}</div>` : ''}<div class="order-card-footer"><span>${o.note ? '备注：' + escape(o.note) : '下单价格已锁定 · 税口径按来源'}</span><div>已知报价金额${model.orderUnquotedCount(o) ? '（另有 ' + model.orderUnquotedCount(o) + ' 项待报价）' : ''} <strong>${money(model.orderTotal(o))}</strong></div></div></article>`).join('') || emptyState('还没有订货记录', '前往「我要订货」，创建你的第一笔订单。', 'clipboard')}</div>`;
}
function accountPage() {
  const s = activeStore();
  return titleHeading('门店信息', '', clientStoreSelect(), 'STORE PROFILE') + `<section class="section-card profile-card"><div class="profile-card-top">${storeAvatar(s)}<div><h2>${escape(s.name)}</h2><p>${escape(s.city)} · 合作门店</p></div></div><div class="profile-fields">${[s.accessCode ? ['门店识别码', s.accessCode] : ['门店', s.name], ['联系人', s.contact], ['联系电话', s.phone], ['配送地址', s.address], ['供货方', company.name]].map(([label, value]) => `<div><span>${label}</span><strong>${escape(value || '待录入')}</strong></div>`).join('')}</div></section><div class="notice">${icon('help')} 地址或联系人需要调整时，请联系管理员。${isCloud ? '' : '当前为本机演示账号。'}</div>`;
}
async function readProductImage(file) {
  if (!file) return null;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) throw new Error('图片仅支持 PNG、JPEG、WebP，大小不超过 3 MB。');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1,800 / Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(bitmap.width*scale)); canvas.height = Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
  let data = canvas.toDataURL('image/webp',0.82);
  if (isCloud) {
    for (const quality of [0.65, 0.45, 0.3]) {
      if (imageDataBlob(data).size <= 200 * 1024) break;
      data = canvas.toDataURL('image/webp', quality);
    }
    if (imageDataBlob(data).size > 200 * 1024) {
      const small = document.createElement('canvas'); small.width = Math.max(1, Math.round(canvas.width / 2)); small.height = Math.max(1, Math.round(canvas.height / 2));
      small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height); data = small.toDataURL('image/webp', 0.7);
    }
  }
  return data;
}
function emptyState(title, copy, ico) { return `<div class="empty-state">${icon(ico)}<h3>${title}</h3><p>${copy}</p></div>`; }

let previousFocus;
function openOverlay(content) {
  previousFocus = previousFocus || document.activeElement;
  accountsUI?.onOverlayClose?.();
  overlay.innerHTML = content;
  document.body.style.overflow = 'hidden';
  if (overlay.querySelector('.document-detail')) overlay.querySelector('.modal').classList.add('modal-wide');
  requestAnimationFrame(() => overlay.querySelector('input:not([type="hidden"]):not([hidden]), textarea, button:not([hidden])')?.focus({ preventScroll: true }));
}
function closeOverlay() {
  accountsUI?.onOverlayClose?.();
  overlay.innerHTML = '';
  storeUI?.dispose?.();
  document.body.style.overflow = '';
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll:true });
  previousFocus = null;
}
function modal(title, body, footer = '', formId = '') {
  openOverlay(`<div class="modal-overlay" data-action="overlay-close"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${title}</h2></div><button class="icon-button" data-action="close" aria-label="关闭弹窗">${icon('close')}</button></div>${formId ? `<form id="${formId}">` : ''}<div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}${formId ? '</form>' : ''}</section></div>`);
}
function validQuantity(raw, product) {
  const n = Number(raw), factor = isWeightUnit(product.unit) ? 1000 : 1;
  return Number.isFinite(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER / 1000 && Math.abs(n * factor - Math.round(n * factor)) < 1e-7;
}
function lineAmount(line) { return line.price === null || line.price === undefined ? null : Math.round(line.price * line.qty * 100) / 100; }
function field(label, name, value = '', options = '') { return `<div class="field"><label for="field-${name}">${label}</label><input class="input" id="field-${name}" name="${name}" value="${escape(value)}" ${options}></div>`; }
function fulfillmentSteps(order) {
  const current = stages.indexOf(order.stage);
  return `<ol class="fulfillment-steps" aria-label="订单进度">${stages.map((stage, index) => {
    const done = index < current || order.stage === 'delivered';
    return `<li class="${done ? 'done' : ''} ${index === current ? 'current' : ''}" ${index === current ? 'aria-current="step"' : ''}><span class="fulfillment-step-node">${done ? icon('check') : index + 1}</span><span class="fulfillment-step-label">${labels[stage]}</span></li>`;
  }).join('')}</ol>`;
}
function orderActionHint(order) {
  const remaining = order.items.length - packedCount(order);
  return ['pending', 'packing'].includes(order.stage) ? (remaining ? `还有 ${remaining} 种未配齐` : '全部商品已配齐') : order.stage === 'ready' ? '已配齐，等待出发' : order.stage === 'delivering' ? '已出发，等待门店签收' : '门店已签收';
}
function orderDetailActions(order) {
  const next = stages[stages.indexOf(order.stage) + 1], editable = ['pending', 'packing'].includes(order.stage);
  const nextText = { packing: '开始配货', ready: '确认配货完成', delivering: '开始配送', delivered: '确认送达' };
  return `<div class="order-action-progress"><strong data-packed-count>${packedCount(order)} / ${order.items.length} 种已配齐</strong><span data-order-action-hint>${orderActionHint(order)}</span></div><div class="order-action-buttons">${editable ? button('记录缺货', 'record-issue', 'secondary', `data-id="${order.id}"`, 'alert') : ''}${next ? button(nextText[next], next === 'delivered' ? 'confirm-delivery' : 'stage', 'primary', `data-id="${order.id}" data-stage="${next}" ${next === 'ready' && order.items.some(line => !linePacked(line)) ? 'disabled' : ''}`, next === 'delivering' ? 'truck' : 'check') : `<span class="delivered-note">${icon('check')} 已完成配送</span>`}</div>`;
}
function packingNoteHTML(order,line,editable) {
  const open=isPackingShortage(line),resolved=line.packingIssue?.type==='shortage'&&line.packingIssue?.status==='resolved';
  return `<span>${escape(line.packingNote||'')}</span>${open||resolved?`<span class="packing-issue-state ${resolved?'is-resolved':''}">${open?'缺货待处理':'缺货已处理'}</span>`:''}${open&&editable?`<button type="button" class="text-button" data-action="resolve-packing-issue" data-id="${escape(order.id)}" data-product="${escape(line.productId)}">标记已解决</button>`:''}`;
}
function orderIssueHTML(order) {
  if(!order.issue)return '';
  const resolved=Boolean(order.issueResolvedAt||order.stage==='delivered');
  return `<div class="notice ${resolved?'':'notice-warning'} order-issue-notice ${resolved?'is-resolved':''}">${icon(resolved?'check':'alert')}<span>${escape(order.issue)}${resolved?' · 已处理':''}</span>${resolved?'':`<button class="text-button" data-action="resolve-order-issue" data-id="${escape(order.id)}">标记已解决</button>`}</div>`;
}
function packingLine(order, line, editable) {
  const product = model.getProduct(line.productId), unit = line.unit || product.unit, complete = linePacked(line);
  const name = line.productName || product.name, note = line.packingNote || '';
  return `<div class="detail-item order-line ${complete ? 'complete' : ''}" role="listitem" data-packing-product="${escape(line.productId)}"><div class="order-line-product">${product.image ? `<img class="order-line-image" src="${escape(product.image)}" alt="" loading="lazy">` : `<span class="order-line-placeholder">${icon('box')}</span>`}<div><strong>${escape(name)}</strong><span>${escape(line.spec || product.spec)} · ${line.price == null ? '单价待确认' : money(line.price) + ' / ' + escape(unit)}</span></div></div><div class="packing-required"><span>需配</span><strong>${line.qty} <small>${escape(unit)}</small></strong></div><button class="packing-note-button icon-button ${note ? 'has-note' : ''}" data-action="packing-note" data-id="${escape(order.id)}" data-product="${escape(line.productId)}" aria-label="${note ? '编辑' : '添加'}${escape(name)}的异常备注" title="异常备注" ${editable ? '' : 'hidden'}>${icon('edit')}<span>备注</span></button><button class="packing-toggle" role="checkbox" aria-checked="${complete}" aria-label="${complete ? '取消配齐' : '确认配齐'}${escape(name)}" data-action="pack-line" data-id="${escape(order.id)}" data-product="${escape(line.productId)}" ${editable ? '' : 'disabled'}><span class="packing-checkbox">${icon('check')}</span></button><div class="packing-item-note packing-note-content" ${note ? '' : 'hidden'}>${packingNoteHTML(order,line,editable)}</div></div>`;
}
function orderDetailPage() {
  const order = model.state.orders.find(order => order.id === ui.orderId);
  if (!order) return titleHeading('货单详情', '') + `<section class="section-card">${emptyState('未找到这张货单', '', 'clipboard')}${button('返回订单', 'order-list')}</section>`;
  const store = model.getStore(order.storeId), editable = ['pending', 'packing'].includes(order.stage);
  return `<div class="order-detail-page" data-order="${escape(order.id)}" data-stage="${order.stage}"><div class="order-detail-heading"><button class="icon-button order-back" data-action="order-list" aria-label="返回订单">${icon('arrow')}</button><div class="order-detail-title"><h1>货单详情</h1><span>${escape(order.id)}${order.isDemo ? ' · 演示' : ''}</span></div><div class="order-detail-heading-actions">${button('结算明细','settlement-detail','secondary',`data-id="${escape(order.id)}"`)}${button('PDF','order-pdf','secondary',`data-id="${escape(order.id)}"`,'download')}</div></div>
  <section class="section-card order-detail-summary"><div class="order-detail-store"><div class="store-cell">${storeAvatar(store)}<div><h2>${escape(store.name)}</h2>${store.deletedAt ? '<span class="cell-secondary">门店已删除</span>' : ''}</div></div><div class="order-summary-address">${icon('pin')}<span>${escape(store.address || '地址待填写')}</span></div><div data-order-status>${statusBadge(order.stage)}</div></div><dl class="order-detail-facts"><div><dt>配送日期</dt><dd>${order.deliveryDate}</dd></div><div><dt>联系人</dt><dd>${escape(store.contact || '待填写')}</dd></div><div><dt>联系电话</dt><dd>${escape(store.phone || '待填写')}</dd></div><div><dt>报价金额</dt><dd>${money(model.orderTotal(order))}${model.orderUnquotedCount(order) ? `<small>${model.orderUnquotedCount(order)} 项待报价</small>` : ''}</dd></div></dl><div class="order-detail-flow">${fulfillmentSteps(order)}</div>${order.note && !order.isDemo ? `<div class="order-note">${icon('clipboard')} ${escape(order.note)}</div>` : ''}<div data-order-issue>${orderIssueHTML(order)}</div>${order.deliveredAt ? `<div class="notice order-delivery-receipt">${icon('check')}<span>${new Date(order.deliveredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })} 已送达${order.receivedBy ? ' · 签收人：' + escape(order.receivedBy) : ''}</span></div>` : ''}</section>
  <aside class="order-context-bar" aria-hidden="true" hidden><div class="order-context-identity">${storeAvatar(store)}<div><strong>${escape(store.name)}</strong><span>${escape(order.id)} · ${order.deliveryDate}</span></div></div><div class="order-context-address">${icon('pin')}<span>${escape(store.address || '地址待填写')}</span></div><div class="order-context-progress"><span data-order-status>${statusBadge(order.stage)}</span><strong data-packed-count>${packedCount(order)} / ${order.items.length} 种已配齐</strong></div></aside>
  <section class="section-card order-packing-panel"><div class="order-packing-heading"><h2>配货清单</h2><span data-packed-count aria-live="polite">${packedCount(order)} / ${order.items.length} 种已配齐</span></div><div class="progress-track"><div class="progress-fill" style="width:${packedPercent(order)}%"></div></div><div class="detail-items order-detail-items" role="list" aria-label="配货清单">${order.items.map(line => packingLine(order, line, editable)).join('')}</div></section><div class="order-detail-actions">${orderDetailActions(order)}</div></div>`;
}
function openOrderDetail(id) {
  if (ui.role !== 'admin') throw new Error('配货管理仅供管理员操作。');
  const order = model.state.orders.find(order => order.id === id);
  if (!order) throw new Error('未找到订单。');
  const returnView = { page: ui.page, date: ui.date, status: ui.status, query: ui.query, scrollY: window.scrollY };
  history.replaceState({ kuraflowView: returnView }, '', location.href);
  closeOverlay();
  ui.page = 'orders'; ui.orderId = id; ui.date = order.deliveryDate; ui.mobile = false;
  history.pushState({ kuraflowOrder: true, returnToList: returnView.page === 'orders' }, '', `?page=orders&order=${encodeURIComponent(id)}&date=${order.deliveryDate}`);
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelector('.order-detail-title h1')?.setAttribute('tabindex', '-1');
  document.querySelector('.order-detail-title h1')?.focus({ preventScroll: true });
}
async function saveOrderInputs(id) {
  await Promise.all([...packingSaves.values()].filter(save => save.orderId === id).map(save => save.operation));
}
async function returnOrderList() {
  if (ui.orderId) await saveOrderInputs(ui.orderId);
  if (history.state?.kuraflowOrder && history.state.returnToList) { history.back(); return; }
  ui.orderId = null;
  nav('orders');
}
function notificationState() { return notificationQueue(model, ui.role, activeStore()?.id || '', {includeDemo:ui.businessDemo}); }
function notificationButton() {
  const count=ui.role==='admin'?(notificationsUI?.getUnreadCount()||0):notificationState().count;
  const label=ui.role==='admin'?`通知中心，${count?count+'条未读':'暂无未读'}`:`查看订单提醒，${count?count+'项':'暂无待处理'}`;
  return `<button class="icon-button notification-button ${count?'has-notifications':''}" aria-label="${label}" data-action="notifications">${icon('bell')}${count?`<span class="notification-badge" aria-hidden="true">${count>99?'99+':count}</span>`:''}</button>`;
}
function syncNotificationBadge() {
  const el=app.querySelector('.notification-button');if(!el)return;
  const count=ui.role==='admin'?(notificationsUI?.getUnreadCount()||0):notificationState().count;
  el.setAttribute('aria-label',ui.role==='admin'?`通知中心，${count?count+'条未读':'暂无未读'}`:`查看订单提醒，${count?count+'项':'暂无待处理'}`);
  el.classList.toggle('has-notifications',count>0);
  let badge=el.querySelector('.notification-badge');
  if(!count){badge?.remove();return;}
  if(!badge){badge=document.createElement('span');badge.className='notification-badge';badge.setAttribute('aria-hidden','true');el.append(badge);}
  badge.textContent=count>99?'99+':String(count);
}
function notificationsModal() {
  if(ui.role==='admin')return notificationsUI.open();
  const {orders,low,count}=notificationState(),admin=ui.role==='admin';
  const rows=orders.map(order=>`<div class="notification-row"><div class="alert-symbol ${order.issue&&!order.issueResolvedAt?'red':'mint'}">${icon(order.issue&&!order.issueResolvedAt?'alert':order.stage==='delivering'?'truck':'box')}</div><div><strong>${escape(admin?model.getStore(order.storeId)?.name || order.storeId:order.id)}</strong><p>${admin?escape(order.id)+' · ':''}${labels[order.stage]}${order.isDemo?' · 演示':''} · ${escape(order.deliveryDate)}${order.issue?' · '+escape(order.issue)+(order.issueResolvedAt?'（已处理）':''):''}</p></div>${admin?button('查看','order-detail','secondary',`data-id="${escape(order.id)}"`,'arrow'):''}</div>`).join('')
    + low.map(product=>`<div class="notification-row"><div class="alert-symbol red">${icon('alert')}</div><div><strong>${escape(product.name)}库存偏低</strong><p>剩余 ${model.getStock(product.id)} ${escape(product.unit)}</p></div>${button('更新库存','stock','secondary',`data-id="${escape(product.id)}"`)}</div>`).join('');
  modal(admin?'待处理提醒':'我的订单提醒',`<p class="notification-count-heading">${count} 项待处理</p><div class="notification-list">${rows || emptyState('暂无待处理事项','','check')}</div>`,button('关闭','close','secondary')+(admin?'':'<button class="btn btn-primary" data-page="my-orders">查看我的订单</button>'));
}

function setCart(id, quantity, fullRender = true) {
  const product = model.getProduct(id);
  if (!product || product.deletedAt) {
    delete model.state.cart[id]; delete model.state.cartUnits?.[id];
    model.save();
    throw new Error('该商品已删除，请选择其他商品。');
  }
  const q = Number(quantity), stock = model.getUnitOrderableStock(activeStore().id,id,model.getCartUnit(id));
  if (!validQuantity(q, {unit:model.getCartUnit(id)})) throw new Error(isWeightUnit(model.getCartUnit(id)) ? 'KG 数量最多保留三位小数。' : '按完整订货单位填写整数数量。');
  if (q > 0 && model.getUnitQuote(activeStore().id,id,model.getCartUnit(id)).price === null) throw new Error('该商品尚待报价确认。');
  if (stock !== null && q > stock) throw new Error(`${model.getProduct(id).name}目前可订 ${stock} ${model.getProduct(id).unit}。`);
  if ((model.state.cart[id] || 0) === q) return;
  if (q) model.state.cart[id] = q; else delete model.state.cart[id];
  model.save();
  if (fullRender) render();
  else {
    const input = app.querySelector('[data-cart-input="' + id + '"]');
    const control = input?.closest('.qty-control');
    if (control) { control.querySelector('[data-action="cart-minus"]').disabled = q === 0; control.querySelector('[data-action="cart-plus"]').disabled = stock !== null && q >= stock; }
    const amountCell = app.querySelector('[data-line-amount="' + id + '"]');
    if (amountCell) amountCell.textContent = q > 0 ? money(Math.round(q * model.getUnitQuote(activeStore().id,id,model.getCartUnit(id)).price * 100) / 100) : '—';
    const cart = app.querySelector('.cart-panel');
    if (cart) cart.outerHTML = cartPanel();
    const bar = app.querySelector('.mobile-cart-bar');
    if (bar) bar.outerHTML = mobileCartBar(); else app.querySelector('.client-order-layout')?.insertAdjacentHTML('afterend', mobileCartBar());
  }
}
function nav(page, tab = '') {
  if (page === 'delivery') page = 'orders';
  if (page === 'costs') { page = 'catalogue'; tab = 'costs'; }
  if (isCloud) ui.role = principal.role === 'store' ? 'client' : 'admin';
  const allowed = ui.role === 'admin' ? ['overview', 'tasks', 'orders', 'delivery', 'catalogue', 'stores', 'costs', 'documents', 'materials', 'team'] : ['products', 'my-orders', 'my-statements', 'account', 'team'];
  if (!allowed.includes(page)) throw new Error('当前账号无法访问此页面。');
  clearTimeout(searchTimer);
  if (page === 'catalogue') ui.productTab = tab === 'costs' ? 'costs' : 'inventory';
  if (page === 'tasks' && tab) ui.taskTab=tab==='manual'?'manual':'system';
  if (page === 'stores') ui.storeTab = tab === 'quotes' ? 'quotes' : 'stores';
  if (page === 'documents' && tab !== 'store-settlement') { ui.settlementStore=''; ui.settlementDemo=false; }
  const section = page === 'catalogue' ? ui.productTab : page === 'stores' ? ui.storeTab : page === 'tasks' ? ui.taskTab : '';
  history.replaceState(null, '', ui.role === 'client' ? '?view=client&page=' + page : '?page=' + page + (section ? '&tab=' + section : '') + (page === 'stores' && ui.storeTab === 'quotes' && ui.quoteStore ? '&store=' + encodeURIComponent(ui.quoteStore) : ''));
  closeOverlay(); ui.orderId = null; ui.page = page; ui.query = ''; ui.catalogueTrash = false; ui.recycleQuery = ''; ui.status = 'all'; ui.mobile = false; ui.category = '全部商品'; if(page === 'overview') overviewUI.saveURL(); if(page === 'tasks') tasksUI.saveURL(); render(); window.scrollTo({ top: 0 });
}
function switchStore(id) {
  if (!model.getStore(id) || (ui.role === 'client' && id !== (isCloud ? principal.storeId : previewClientStore()?.id))) throw new Error('无法访问此门店。');
  if (Object.keys(model.state.cart).length) toast('已切换门店，原订货单已清空。');
  model.state.activeStoreId = id; model.state.cart = {}; model.state.cartUnits = {}; model.state.cartNote = ''; model.save(); ui.query = ''; render();
}
function download(name, contents, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(value) { if (typeof value === 'string' && /^[=+\-@]/.test(value)) value = String.fromCharCode(39) + value; return '"' + String(value ?? '').replaceAll('"', '""') + '"'; }
function exportOrders() {
  const rows = [['订单编号', '门店', '配送日期', '状态', '商品', '规格', '单位', '订购数量', '实配数量', '缺配数量', '报价单价JPY', '金额JPY', '备注']];
  dailyOrders().forEach(o => o.items.forEach(i => { const p = model.getProduct(i.productId); rows.push([o.id, model.getStore(o.storeId).name, o.deliveryDate, labels[o.stage], p.name, p.spec, i.unit || p.unit, i.qty, i.packedQty, i.qty - i.packedQty, i.price === null ? '待报价' : i.price, lineAmount(i) === null ? '待报价' : lineAmount(i), o.note]); }));
  if (rows.length === 1) return toast('当前日期没有可导出的订单。', 'error');
  download(`倉流配货单-${ui.date}.csv`, '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
  toast('配货单已导出，可用 Excel 打开。');
}
function parseCSV(text) {
  const rows = []; let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value.trim()); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('CSV 的引号未闭合，请检查文件。');
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}
async function importProducts(text) {
  const rows = parseCSV(text);
  const expected = ['商品名称', '品类', '销售单位', '规格', '基础售价', '可订库存'];
  if (rows.length < 2 || expected.some((h, i) => rows[0][i] !== h)) throw new Error('请按示例模板填写 6 列表头和商品行。');
  const names = new Set(model.state.products.map(p => [p.name.toLocaleLowerCase(), p.spec, p.unit].join('|')));
  const deletedNames = new Set(model.getDeletedProducts().map(p => [p.name.toLocaleLowerCase(), p.spec, p.unit].join('|')));
  const entries = rows.slice(1).map((row, i) => {
    if (row.length !== 6) throw new Error('第 ' + (i + 2) + ' 行需要恰好 6 列。');
    const [name, category, unit, spec, rawPrice, rawStock] = row;
    const basePrice = rawPrice === '' ? null : Number(rawPrice), stock = rawStock === '' ? null : Number(rawStock);
    const key = [name.toLocaleLowerCase(), spec, unit].join('|');
    if (deletedNames.has(key)) throw new Error(`第 ${i + 2} 行商品已在回收站，请先恢复。`);
    if (!name || names.has(key)) throw new Error(`第 ${i + 2} 行名称为空，或名称、规格和单位重复。`);
    if (!categories.slice(1).includes(category)) throw new Error(`第 ${i + 2} 行品类不正确。`);
    if (!unit || !spec || (basePrice !== null && (!Number.isFinite(basePrice) || basePrice <= 0 || Math.abs(basePrice * 100 - Math.round(basePrice * 100)) > 1e-7)) || (stock !== null && !validQuantity(stock, { unit }))) throw new Error(`第 ${i + 2} 行请填写完整规格和有效报价、库存。`);
    names.add(key);
    return { name, category, unit, spec, basePrice, stock, description: spec, icon: category === '蔬菜' ? '🥬' : category === '肉类' ? '🥩' : category === '丸滑类' ? '🍡' : '🥟' };
  });
  const before = JSON.stringify(model.state);
  if (isCloud) await model.importProducts(entries);
  else { try { entries.forEach(p => model.addProduct(p)); } catch (error) { model.state = JSON.parse(before); model.save(); throw error; } }
  closeOverlay(); ui.category = '全部商品'; ui.query = ''; render(); toast(`已导入 ${entries.length} 个商品。`);
}
function toast(message, type = 'success') {
  const el = document.createElement('div'); el.className = 'toast ' + type; el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = icon(type === 'error' ? 'alert' : 'check') + '<span>' + escape(message) + '</span>';
  document.querySelector('#toast-container').append(el); setTimeout(() => el.remove(), 4200);
}
const packingSaves = new Map();
function updatePacking(orderId) {
  const order = model.state.orders.find(order => order.id === orderId);
  const detail = app.querySelector('.order-detail-page');
  if (!detail || detail.dataset.order !== orderId) return;
  if (!order) { render(); return; }
  if (detail.dataset.stage !== order.stage) {
    syncNotificationBadge();
    detail.dataset.stage = order.stage;
    detail.querySelectorAll('[data-order-status]').forEach(el => { el.innerHTML = statusBadge(order.stage); });
    detail.querySelector('.order-detail-flow').innerHTML = fulfillmentSteps(order);
    detail.querySelector('.order-detail-actions').innerHTML = orderDetailActions(order);
  }
  detail.querySelectorAll('[data-packed-count]').forEach(el => { el.textContent = `${packedCount(order)} / ${order.items.length} 种已配齐`; });
  detail.querySelector('[data-order-action-hint]').textContent = orderActionHint(order);
  detail.querySelector('.order-packing-panel > .progress-track .progress-fill').style.width = packedPercent(order) + '%';
  const editable = ['pending', 'packing'].includes(order.stage);
  order.items.forEach(line => {
    const row = detail.querySelector(`[data-packing-product="${CSS.escape(line.productId)}"]`);
    if (!row) return;
    const check = row.querySelector('.packing-toggle'), complete = linePacked(line);
    const saving = packingSaves.has(orderId + ':' + line.productId);
    row.classList.toggle('complete', complete);
    row.toggleAttribute('data-packing-saving', saving);
    row.setAttribute('aria-busy', String(saving));
    check.setAttribute('aria-checked', String(complete));
    check.disabled = !editable || saving;
    check.setAttribute('aria-label', `${complete ? '取消配齐' : '确认配齐'}${line.productName || model.getProduct(line.productId).name}`);
    const note = line.packingNote || '', noteButton = row.querySelector('.packing-note-button');
    noteButton.hidden = !editable;
    noteButton.classList.toggle('has-note', Boolean(note));
    noteButton.setAttribute('aria-label', `${note ? '编辑' : '添加'}${line.productName || model.getProduct(line.productId).name}的异常备注`);
    const noteArea=row.querySelector('.packing-item-note'),noteHTML=packingNoteHTML(order,line,editable);
    if(noteArea.innerHTML!==noteHTML)noteArea.innerHTML=noteHTML;
    row.querySelector('.packing-item-note').hidden = !note;
  });
  const issueArea=detail.querySelector('[data-order-issue]');if(issueArea){const html=orderIssueHTML(order);if(issueArea.innerHTML!==html)issueArea.innerHTML=html;}
  const next = detail.querySelector('.order-detail-actions [data-action="stage"]');
  if (next && editable) {
    next.dataset.stage = order.stage === 'pending' ? 'packing' : 'ready';
    next.disabled = [...packingSaves.values()].some(save => save.orderId === orderId) || (order.stage === 'packing' && packedCount(order) !== order.items.length);
    next.innerHTML = icon('check') + (order.stage === 'pending' ? '开始配货' : '确认配货完成');
  }
}
async function savePackingCompletion(orderId, productId, complete) {
  const key = orderId + ':' + productId;
  if (packingSaves.has(key)) return packingSaves.get(key).operation;
  const operation = Promise.resolve().then(() => model.setPackLineDone(orderId, productId, complete));
  packingSaves.set(key, { orderId, operation }); updatePacking(orderId);
  try { await operation; }
  finally { packingSaves.delete(key); updatePacking(orderId); notificationsUI?.refresh(); }
}
async function runAction(action, el) {
  const id = el.dataset.id;
  if(action==='open-own-team') {if(!isCloud)return;accountsUI.openOwnTeam();return nav('team');}
  if(action==='organization-avatar') {
    if(!isCloud||principal.role!=='admin'||principal.accountRole!=='owner')throw new Error('仅负责人可修改厨房头像。');
    return accountsUI.openOrganizationAvatar({tenantId:principal.tenantId,name:model.state.settings?.companyName||company.name,avatarUrl:principal.organizationAvatarUrl,avatarVersion:principal.organizationAvatarVersion||0});
  }
  if(action==='manage-store-team') {
    if(!isCloud||principal.role!=='admin'||principal.accountRole!=='owner')throw new Error('仅负责人可管理门店账号。');
    const target=model.getStore(id);if(!target||target.deletedAt)throw new Error('门店不存在。');
    accountsUI.openStoreTeam(id);nav('team');history.replaceState(null,'','?page=team&store='+encodeURIComponent(id));return;
  }
  if(action==='reload-report-history' && isCloud) {model.reportHistoryError='';render();return;}
  const adminActions = ['invite-store', 'store-prices', 'show-store-code', 'copy-store-code', 'pack-line', 'packing-note', 'resolve-packing-issue', 'resolve-order-issue', 'stage', 'confirm-delivery', 'record-issue', 'edit-price', 'stock', 'add-store', 'edit-store', 'delete-store', 'confirm-delete-store', 'add-product', 'import-products', 'download-template', 'export', 'view-orders', 'reset', 'reset-confirm'];
  if (ui.role !== 'admin' && adminActions.includes(action)) throw new Error('此操作仅供管理员使用。');
  if (isCloud && principal.role === 'store' && [...adminActions, 'role-admin'].includes(action)) throw new Error('此操作需要管理员权限。');
  if (isCloud && ['reset', 'reset-confirm'].includes(action)) throw new Error('线上工作台不支持恢复演示数据。');
  if(await notificationsUI?.handleAction(action,el))return;
  if(action==='resolve-packing-issue'||action==='resolve-order-issue') {
    if(action==='resolve-packing-issue')await model.resolvePackingIssue(id,el.dataset.product);else await model.resolveOrderIssue(id);
    if(ui.orderId)updatePacking(ui.orderId);else render();notificationsUI?.refresh();toast('已处理，记录已保留。');return;
  }
  if (action === 'management-tab') { if (ui.role !== 'admin') throw new Error('仅管理员可访问。'); return nav(el.dataset.group === 'products' ? 'catalogue' : 'stores', el.dataset.tab); }
  if (await accountsUI.handleAction(action, el)) return;
  if (await tasksUI.handleAction(action, el)) return;
  if (await overviewUI.handleAction(action, el)) return;
  if (await settlementUI.handleAction(action, el)) return;
  if (await storeUI.handleAction?.(action, el)) { refreshLocalWhenReady(); return; }
  if (await businessUI.handleAction(action, el)) { refreshLocalWhenReady(); return; }
  if (action === 'logout') { model.save(); await cloudRequest('/api/accounts/logout', {}); location.href = principal.role === 'admin' ? '/?login=admin' : '/?view=client'; return; }
  if (action === 'invite-store') {
    const store = model.getStore(id);
    const invite = await cloudRequest('/api/admin/invites', { storeId: id, displayName: store.contact || store.name });
    modal('开通门店登录', `<p class="modal-intro">${escape(store.name)} · 将此链接发给门店负责人。对方设置通行密钥后即可登录。</p><textarea class="input cloud-invite-link" id="cloud-invite-link" readonly aria-label="门店开通链接">${escape(invite.url)}</textarea><p class="form-hint">链接仅可使用一次，有效期至 ${escape(new Date(invite.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' }))}（东京时间）。</p>`, button('关闭', 'close') + button('复制邀请链接', 'copy-invite', 'primary')); return;
  }
  if (action === 'copy-invite') {
    const field = document.querySelector('#cloud-invite-link');
    try { await navigator.clipboard.writeText(field.value); toast('邀请链接已复制。'); } catch { field.focus(); field.select(); toast('请复制已选中的邀请链接。'); } return;
  }
  if (['role-admin', 'role-client', 'visit-store'].includes(action)) throw new Error('请使用各自的登录入口访问工作台。');
  if (action === 'client-logout' && clientPortal) {
    model.save(); localClientCode = ''; try { sessionStorage.removeItem(clientSessionKey); } catch { /* In-memory logout still applies. */ }
    closeOverlay(); ui.page = 'products'; render(); return;
  }
  if (action === 'show-store-code') return storeUI.showCode(model.getStore(id));
  if (action === 'copy-store-code') return storeUI.copyCode(id);
  if (action === 'home') return nav(ui.role === 'admin' ? 'overview' : 'products');
  if (action === 'view-orders') return nav('orders');
  if (action === 'client-products') return nav('products');
  if (action === 'cart-scroll') return document.querySelector('.cart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (action === 'mobile-menu') { ui.mobile = !ui.mobile; app.querySelector('.app-shell')?.classList.toggle('mobile-open', ui.mobile); return; }
  if (action === 'mobile-close') { ui.mobile = false; app.querySelector('.app-shell')?.classList.remove('mobile-open'); return; }
  if (action === 'close' || action === 'overlay-close') { closeOverlay(); refreshLocalWhenReady(); return; }
  if (action === 'filter-status') { ui.status = el.dataset.status; return render(); }
  if (action === 'category') { ui.category = el.dataset.category; return render(); }
  if (action === 'order-detail') return openOrderDetail(id);
  if (action === 'order-list') return returnOrderList();
  if (action === 'export') return exportOrders();
  if (action === 'notifications') return notificationsModal();
  if (action === 'cart-plus' || action === 'cart-minus') return setCart(id, Math.max(0, Math.round(((model.state.cart[id] || 0) + (action === 'cart-plus' ? 1 : -1)) * 1000) / 1000));
  if (action === 'remove-cart') return setCart(id, 0);
  if (action === 'clear-cart') { model.state.cart = {}; model.save(); return render(); }
  if (action === 'submit-order') {
    for (const input of app.querySelectorAll('[data-cart-input]')) {
      const p = model.getProduct(input.dataset.cartInput), stock = model.getUnitOrderableStock(activeStore().id,p.id,model.getCartUnit(p.id));
      if (!validQuantity(input.value, {unit:model.getCartUnit(p.id)}) || (stock !== null && Number(input.value) > stock)) throw new Error('请先修正商品数量，再提交订货单。');
    }
    const date = document.querySelector('#delivery-date').value, note = document.querySelector('#order-note').value;
    if (date < DEMO_DATE) throw new Error(isCloud ? '配送日期不能早于今日。' : '配送日期不能早于演示日期。');
    const order = await model.submitOrder(activeStore().id, model.state.cart, date, note);
    model.state.cartNote = ''; model.save(); ui.date = date; nav('my-orders');
    toast(`订货成功，${order.id} 已发送到中央厨房。`); return;
  }
  if (action === 'store-prices') { ui.quoteStore = id; return nav('stores', 'quotes'); }
  if (action === 'pack-line') {
    const order = model.state.orders.find(order => order.id === id), line = order?.items.find(item => item.productId === el.dataset.product);
    if (!line || !['pending','packing'].includes(order.stage)) throw new Error('当前订单不可修改配货。');
    await savePackingCompletion(id, line.productId, !linePacked(line));
    return;
  }
  if (action === 'packing-note') {
    const order = model.state.orders.find(order => order.id === id), line = order?.items.find(item => item.productId === el.dataset.product);
    if (!line || !['pending','packing'].includes(order.stage)) throw new Error('当前订单不可修改配货备注。');
    const product = model.getProduct(line.productId);
    const noteType=line.packingIssue?.type||(isPackingShortage(line)||!line.packingNote?'shortage':'other');
    modal('异常备注', `<p class="modal-intro">${escape(line.productName || product.name)} · 需配 ${line.qty} ${escape(line.unit || product.unit)}</p><input type="hidden" name="orderId" value="${escape(id)}"><input type="hidden" name="productId" value="${escape(line.productId)}"><div class="field"><label for="packing-note-type">类型</label><select class="input" name="type" id="packing-note-type"><option value="shortage" ${noteType==='shortage'?'selected':''}>缺货</option><option value="other" ${noteType==='other'?'selected':''}>普通备注</option></select></div><div class="field"><label for="packing-note">备注</label><textarea class="input" name="note" id="packing-note" rows="3" maxlength="1000" placeholder="例如：缺货 2 袋，等待补货">${escape(line.packingNote || '')}</textarea></div>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">保存备注</button>', 'packing-note-form');
    return;
  }
  if (action === 'stage') {
    await saveOrderInputs(id);
    await model.setStage(id, el.dataset.stage);
    if (ui.orderId === id) updatePacking(id); else render();
    toast(`${id} 已更新为「${labels[el.dataset.stage]}」。`); return;
  }
  if (action === 'confirm-delivery') {
    const o = model.state.orders.find(o => o.id === id);
    modal('确认货品已送达', `<p class="modal-intro">${escape(model.getStore(o.storeId).name)} · ${id}</p><input type="hidden" name="orderId" value="${id}">${field('签收人', 'receivedBy', model.getStore(o.storeId).contact, 'required maxlength="40"')}<label class="checkbox-field"><input type="checkbox" name="received" required> 已与门店核对并确认货品完成交付</label>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">确认已送达</button>', 'delivery-form'); return;
  }
  if (action === 'record-issue') {
    const o = model.state.orders.find(o => o.id === id);
    modal('记录缺货与配货异常', `<p class="modal-intro">记录会显示在该门店的订单中，方便双方核对。</p><input type="hidden" name="orderId" value="${id}"><div class="field"><label for="issue-note">异常说明</label><textarea class="input" name="issue" id="issue-note" required rows="3" maxlength="200" placeholder="例如：鱼豆腐少 6 袋，补货后随下一车配送">${escape(o.issue || '')}</textarea></div>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">保存异常提醒</button>', 'issue-form'); return;
  }

  if (action === 'edit-price') {
    const p = model.getProduct(id), store = quoteStore(), q = model.getQuote(store.id, id);
    const taxes = [['unspecified', '未注明 / 待确认'], ['exclusive', '未税'], ['inclusive', '含税']];
    modal('设置门店报价与税口径', `<p class="modal-intro">${escape(store.name)} · ${escape(p.name)} · ${escape(p.spec)}</p><input type="hidden" name="productId" value="${id}"><input type="hidden" name="storeId" value="${store.id}">${field('门店单价（日元 / ' + p.unit + '）', 'price', q.price, 'type="number" min="0.01" step="0.01" required')}<div class="form-grid"><div class="field"><label for="quote-tax-basis">税口径</label><select class="select" id="quote-tax-basis" name="taxBasis">${taxes.map(([value, label]) => `<option value="${value}" ${q.taxBasis === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${field('税率（%，未确认可留空）', 'taxRate', q.taxRate === null ? '' : q.taxRate * 100, 'type="number" min="0" max="100" step="0.01"')}</div><p class="form-hint">保留小数单价。保存后用于该门店的新订单，历史订单的报价与税口径不变。</p>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">保存门店报价</button>', 'price-form'); return;
  }

  if (action === 'stock') {
    const p = model.getProduct(id), stock = model.getStock(id);
    modal('盘点并更新可订库存', `<p class="modal-intro">${escape(p.name)} · ${escape(p.spec)} · 按${escape(p.unit)}计量</p><input type="hidden" name="productId" value="${id}">${field('扣除订单预留后的可订数量', 'stock', stock, 'type="number" min="0" step="' + (isWeightUnit(p.unit) ? '0.001' : '1') + '"')}<p class="form-hint">没有实际库存数据时留空，保留“未盘点”。不要把每箱包装数量填成库存。</p>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">保存库存</button>', 'stock-form'); return;
  }
  if (action === 'add-store') { storeUI.openCreate(); return; }
  if (action === 'add-product') {
    modal('新增统一供货商品', `<div class="form-grid">${field('商品名称', 'name', '', 'required maxlength="50"')}<div class="field"><label for="product-category">品类</label><select class="select" name="category" id="product-category">${categories.slice(1).map(c => `<option>${c}</option>`).join('')}</select></div><div class="field"><label for="new-product-unit">库存单位</label><select class="select" id="new-product-unit" name="unit">${SALE_UNIT_OPTIONS.map(u => `<option ${u==='袋'?'selected':''}>${u}</option>`).join('')}</select></div>${field('商品规格', 'spec', '1 kg / 袋', 'required maxlength="40"')}${field('基础报价（日元，可留空）', 'basePrice', '', 'type="number" min="0.01" step="0.01"')}${field('可订库存（未盘点可留空）', 'stock', '', 'type="number" min="0" step="any"')}<div class="field field-full"><label for="product-image">商品图片</label><input class="input" id="product-image" name="productImage" type="file" accept="image/png,image/jpeg,image/webp"><p class="form-hint">PNG、JPEG 或 WebP，最大 3 MB。</p><img id="product-image-preview" class="new-product-preview" hidden alt="商品图片预览"></div><div class="field field-full"><label for="product-description">商品详情</label><textarea class="input" name="description" id="product-description" rows="4" maxlength="3000" placeholder="填写食材介绍、保存方式、包装或使用说明"></textarea></div></div>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">创建商品</button>', 'product-form'); return;
  }
  if (action === 'import-products') {
    modal('导入供货目录', `<p class="modal-intro">使用 CSV 批量新增统一供货商品。可先下载模板，用 Excel 填写后另存为 CSV UTF-8。</p><div class="notice">${icon('clipboard')} 列顺序：商品名称、品类、销售单位、规格、基础售价、可订库存。同名商品按规格和单位区分。报价留空表示待报价，库存留空表示未盘点；KG 支持三位小数。</div>${button('下载 CSV 示例模板', 'download-template', 'secondary', '', 'download')}<div class="field"><label for="catalogue-file">选择 CSV 文件</label><input class="input" type="file" id="catalogue-file" accept=".csv,text/csv"></div><div class="field"><label for="csv-text">或粘贴 CSV 内容</label><textarea class="input" id="csv-text" name="csvText" rows="6" placeholder="商品名称,品类,销售单位,规格,基础售价,可订库存"></textarea></div>`, button('取消', 'close', 'secondary') + '<button type="submit" class="btn btn-primary">检查并导入</button>', 'import-form'); return;
  }
  if (action === 'download-template') return download('倉流供货目录模板.csv', '\uFEFF商品名称,品类,销售单位,规格,基础售价,可订库存\r\n新品鱼丸,冷冻品,袋,1kg/袋,680,40\r\n新品豆皮,常温品,袋,500g/袋,420,50');
  if (action === 'help' && ui.role === 'client') {
    modal('门店订货指南', `<div class="guide-step"><span>01</span><div><strong>选择商品与数量</strong><p>每种商品选择一个购买单位，填写数量与期望配送日期。</p></div></div><div class="guide-step"><span>02</span><div><strong>跟进配货与配送</strong><p>提交后，在「我的订单」查看进度或向厨房反馈问题。</p></div></div><div class="guide-step"><span>03</span><div><strong>核对门店信息</strong><p>地址、联系人或识别码需要调整时，请联系管理员。</p></div></div>`, button('知道了', 'close', 'primary')); return;
  }
  if (action === 'help' && isCloud) {
    modal('倉流使用指南', `<div class="guide-step"><span>01</span><div><strong>管理商品与报价</strong><p>管理员盘点公司库存，配置售卖单位，并为每家门店设置额度与报价。</p></div></div><div class="guide-step"><span>02</span><div><strong>门店在线订货</strong><p>门店使用专属识别码登录，每种商品选择一个单位，再填写数量和配送日期。</p></div></div><div class="guide-step"><span>03</span><div><strong>配货与交付</strong><p>厨房逐项核对实配数量，全部配齐后确认出发，交付时记录签收人。</p></div></div><div class="notice">${icon('check')} 已保存的业务数据存放在云端。页面会定期更新，购物车草稿保留在当前设备。</div>`, button('知道了', 'close', 'primary')); return;
  }
  if (action === 'help') {
    modal('从第一张订单开始', `<div class="guide-step"><span>01</span><div><strong>管理商品与门店报价</strong><p>在「商品管理」维护商品，在「门店管理」设置门店报价。</p></div></div><div class="guide-step"><span>02</span><div><strong>门店端：选商品，提交订货单</strong><p>在门店独立登录页输入识别码，选择商品数量与配送日期。</p></div></div><div class="guide-step"><span>03</span><div><strong>管理端：逐项配齐，确认配送</strong><p>管理端选择同一配送日期，打开订单，按需配数量逐项勾选，配齐后确认出发与送达。</p></div></div><div class="notice">${icon('help')} 这是浏览器本机交互预览，门店识别码与订单保存在当前浏览器。本地预览独立保存，正式工作台数据存放云端。</div>`, button('恢复演示数据', 'reset-confirm', 'ghost', '', 'refresh') + button('开始体验', 'close', 'primary')); return;
  }
  if (action === 'reset-confirm') return modal('恢复初始演示数据', '<p>将清空本浏览器中的新增商品、门店、报价与订单修改，重新载入初始示例数据。</p>', button('取消', 'close', 'secondary') + button('确认恢复', 'reset', 'danger'));
  if (action === 'reset') { model.reset(); ui.date = DEMO_DATE; ui.quoteStore = model.state.activeStoreId; closeOverlay(); ui.role = 'admin'; nav('overview'); return toast('已恢复初始演示数据。'); }
}
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action], [data-page]');
  if (!target || target.disabled) return;
  clearTimeout(searchTimer);
  if (target.dataset.action === 'overlay-close' && event.target !== target) return;
  event.preventDefault();
  if (target.dataset.busy) return;
  target.dataset.busy = 'true';
  try { if (target.dataset.page) nav(target.dataset.page); else await runAction(target.dataset.action, target); } catch (error) { toast(error.message, 'error'); }
  finally { delete target.dataset.busy; }
});
document.addEventListener('change', async event => {
  const input = event.target;
  try {
    if (accountsUI.handleChange(input)) return;
    if (tasksUI.handleChange(input)) return;
    if (overviewUI.handleChange(input)) {notificationsUI?.refresh({force:true});return;}
    if (settlementUI.handleChange(input)) return;
    if (storeUI.updateAddress(input)) return;
    if (businessUI.handleInlineChange?.(input)) return;
    if (input.matches('.inline-tax-fields select')) { const rate = input.closest('form').querySelector('[name=taxRate]'); rate.disabled = input.value === 'unspecified'; if (rate.disabled) rate.value = ''; }
    if (input.id === 'product-image') {
      const preview = document.querySelector('#product-image-preview');
      try { const url = await readProductImage(input.files[0]); preview.hidden = !url; if (url) preview.src = url; }
      catch (error) { input.value = ''; preview.hidden = true; throw error; }
    }
    if (input.id === 'admin-date') { if (!input.value) throw new Error('请选择配送日期。'); ui.date = input.value; render(); }
    if (input.id === 'quote-store') { ui.quoteStore = input.value; if (ui.page === 'stores') history.replaceState(null, '', '?page=stores&tab=quotes&store=' + encodeURIComponent(input.value)); render(); }
    if (input.dataset.cartUnit) {
      const hadQty = model.state.cart[input.dataset.cartUnit] > 0;
      model.setCartUnit(input.dataset.cartUnit,input.value);
      render();
      if (hadQty) toast('已切换购买单位，原数量已清空，请重新填写。');
    }
    if (input.id === 'client-store') switchStore(input.value);
    if (input.dataset.cartInput) setCart(input.dataset.cartInput, input.value, false);
    if (input.id === 'quote-tax-basis' && input.value === 'unspecified') document.querySelector('[name="taxRate"]').value = '';
    if (input.id === 'catalogue-file') { const file = input.files[0]; if (file) { if (file.size > 1000000) throw new Error('请使用小于 1 MB 的 CSV 文件。'); document.querySelector('#csv-text').value = await file.text(); } }
    if (input.id === 'delivery-date') { model.state.cartDeliveryDate = input.value; model.save(); }
    // Search rendering is debounced in the input handler; rendering from a
    // change/blur event would re-enter innerHTML while old inputs are removed.
  } catch (error) { toast(error.message, 'error'); if (input.dataset.cartInput) render(); }
});
let searchTimer;
document.addEventListener('input', async event => {
  if (tasksUI.handleInput(event.target)) return;
  if(event.target.id==='accounts-search'){accountsUI.search(event.target.value);return;}
  if (storeUI.updateAddress(event.target)) return;
  businessUI.handleInlineChange?.(event.target);

  if (event.target.id === 'recycle-search') {
    const field = event.target, value = field.value, position = field.selectionStart;
    clearTimeout(searchTimer); ui.recycleQuery = value;
    searchTimer = setTimeout(() => {
      ui.recycleQuery = value; render();
      const next = document.getElementById('recycle-search');
      if (next) { next.focus(); next.setSelectionRange(position, position); }
    }, 180);
    return;
  }

  if (['list-search', 'product-search', 'catalogue-search', 'cost-search'].includes(event.target.id)) {
    const field = event.target, fieldId = field.id, value = field.value, position = field.selectionStart;
    clearTimeout(searchTimer); ui.query = value;
    searchTimer = setTimeout(() => { ui.query = value; render(); const next = document.getElementById(fieldId); if (next) { next.focus(); next.setSelectionRange(position, position); } }, 180);
  }
  if (event.target.closest('[data-inline-kind]')) { const el = event.target.closest('form').querySelector('.inline-editor-feedback'); el.textContent = '未保存'; el.className = 'inline-editor-feedback'; }
  if (event.target.id === 'order-note') { model.state.cartNote = event.target.value; model.save(); }
  const input = event.target;
  try {
    if (input.dataset.cartInput) setCart(input.dataset.cartInput, input.value, false);
    input.removeAttribute('aria-invalid');
  } catch { input.setAttribute('aria-invalid', 'true'); }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { closeOverlay(); refreshLocalWhenReady(); if (ui.mobile) { ui.mobile = false; app.querySelector('.app-shell')?.classList.remove('mobile-open'); } }
  if (event.key === 'Enter' && event.target.id === 'global-search') {
    event.preventDefault();
    const leavingOrder = Boolean(ui.orderId);
    if (ui.role === 'admin' && ui.page === 'catalogue' && ui.catalogueTrash) ui.recycleQuery = event.target.value.trim();
    else { ui.query = event.target.value.trim(); ui.page = ui.role === 'admin' ? (['catalogue', 'stores'].includes(ui.page) ? ui.page : 'orders') : 'products'; ui.status = 'all'; }
    ui.orderId = null;
    if (leavingOrder) history.replaceState(null, '', '?page=orders&date=' + ui.date);
    render();
  }
  if (event.key === 'Tab' && overlay.firstChild) {
    const focusable = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(.ui-select-native):not(:disabled), textarea, a[href]')].filter(el => el.getClientRects().length && !el.closest('[hidden]'));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'store-login-form' && clientPortal) {
    event.preventDefault();
    const raw = new FormData(event.target).get('accessCode');
    const store = model.getStoreByAccessCode(raw);
    if (!store) {
      renderClientLogin('识别码不正确，请核对后重试。', raw);
      const input = document.querySelector('#store-login-code'); input.setAttribute('aria-invalid', 'true'); input.focus(); return;
    }
    localClientCode = store.accessCode;
    try { sessionStorage.setItem(clientSessionKey, localClientCode); } catch { /* Keep this preview session in memory. */ }
    restoreClientDraft(); ui.page = 'products'; ui.query = ''; ui.category = '全部商品'; render(); return;
  }
  if (event.target.matches('[data-inline-kind]')) { event.preventDefault(); await businessUI.handleInlineSubmit(event.target); refreshLocalWhenReady(); return; }
  if (!event.target.closest('#overlay-root')) return;
  event.preventDefault();
  const form = event.target, data = Object.fromEntries(new FormData(form));
  if (form.dataset.submitting) return;
  form.dataset.submitting = 'true';
  const submitButton = form.querySelector('[type=submit]');
  if (submitButton) submitButton.disabled = true;
  try {
    if(await accountsUI.handleSubmit(form))return;
    if(await tasksUI.handleSubmit(form))return;
    if (ui.role !== 'admin') throw new Error('管理表单仅供管理员使用。');
    if (form.id === 'sale-units-form') { await businessUI.handleUnitsSubmit(form); return; }
    if (form.id === 'price-form') { await model.setPrice(data.storeId, data.productId, data.price, data.taxBasis || 'unspecified', data.taxBasis === 'unspecified' || !data.taxRate ? null : Number(data.taxRate) / 100); closeOverlay(); render(); toast('门店专属报价与税口径已保存。'); }
    if (form.id === 'store-form') { await storeUI.createStore(form, data); }
    if (form.id === 'delivery-form') { if (isCloud) await model.confirmDelivery(data.orderId, data.receivedBy.trim()); else { await model.setStage(data.orderId, 'delivered'); const o = model.state.orders.find(o => o.id === data.orderId); o.receivedBy = data.receivedBy.trim(); model.save(); } closeOverlay(); render(); toast('已确认送达，门店端状态同步更新。'); }
    if (form.id === 'packing-note-form') { await model.setPackingNote(data.orderId, data.productId, data.note, data.type); closeOverlay(); updatePacking(data.orderId); notificationsUI?.refresh(); toast(data.note.trim() ? '备注已保存。' : '备注已清除。'); }
    if (form.id === 'issue-form') { const o = model.state.orders.find(o => o.id === data.orderId); if (!['pending', 'packing'].includes(o.stage)) throw new Error('仅待配货订单可记录配货异常。'); const issue = data.issue.trim(); if (!issue) throw new Error('请填写异常说明。'); await model.recordIssue(o.id, issue); closeOverlay();if(ui.orderId)updatePacking(o.id);else render();notificationsUI?.refresh();toast('缺货已记录并加入待办。'); }
    if (form.id === 'stock-form') { await model.setStock(data.productId, data.stock); closeOverlay(); render(); toast('可订库存已更新。'); }
    if (form.id === 'product-form') { if (form.dataset.saving) return; form.dataset.saving = 'true'; const submit = form.querySelector('[type=submit]'); submit.disabled = true; const image = await readProductImage(form.querySelector('[name=productImage]')?.files[0]); await model.addProduct({ ...data, image, description: data.description || '', icon: data.category === '蔬菜' ? '🥬' : data.category === '肉类' ? '🥩' : data.category === '丸滑类' ? '🍡' : '🥟' }); closeOverlay(); ui.query = ''; ui.category = '全部商品'; render(); toast('商品已创建。'); }
    if (form.id === 'import-form') await importProducts(data.csvText);
  } catch (error) { if (form.id === 'product-form') { delete form.dataset.saving; form.querySelector('[type=submit]').disabled = false; } toast(error.message, 'error'); }
  finally { delete form.dataset.submitting; if (submitButton) submitButton.disabled = false; }
});
window.addEventListener('popstate', event => {
  if (ui.role !== 'admin') return;
  const params = new URLSearchParams(location.search), previous = event.state?.kuraflowView;
  const requested = params.get('page') || 'overview';
  closeOverlay();
  ui.page = ['overview', 'tasks', 'orders', 'catalogue', 'stores', 'documents', 'materials', 'team'].includes(requested) ? requested : requested === 'delivery' ? 'orders' : requested === 'costs' ? 'catalogue' : 'overview';
  ui.orderId = ui.page === 'orders' ? params.get('order') : null;
  ui.productTab = requested === 'costs' || params.get('tab') === 'costs' ? 'costs' : 'inventory';
  ui.storeTab = params.get('tab') === 'quotes' ? 'quotes' : 'stores';
  if(isCloud&&ui.page==='team') {
    if(principal.role==='admin'&&principal.accountRole==='owner'&&params.get('store'))accountsUI.openStoreTeam(params.get('store'));
    else accountsUI.openOwnTeam();
  }
  ui.catalogueTrash = params.get('recycle') === '1';
  if (ui.page === 'tasks') {ui.taskTab=params.get('tab')==='manual'?'manual':'system';ui.taskFilters[ui.taskTab]=params.get('filter')||'all';ui.businessDemo=params.has('demo')?params.get('demo')==='1':!isCloud;}
  if (ui.page === 'overview') { ui.businessRange=['week','month','custom'].includes(params.get('range'))?params.get('range'):'month';ui.businessStart=params.get('from')||'';ui.businessEnd=params.get('to')||'';ui.businessDemo=params.has('demo')?params.get('demo')==='1':!isCloud; }
  if (ui.page === 'documents') { ui.settlementStore=params.get('store') || '';ui.settlementMonth=params.get('month') || '';ui.settlementView=params.get('tab') === 'monthly' ? 'monthly' : 'orders';ui.settlementDemo=params.get('demo') === '1'; }
  ui.quoteStore = params.get('store') || ui.quoteStore;
  ui.date = previous?.date || params.get('date') || (ui.orderId && model.state.orders.find(order => order.id === ui.orderId)?.deliveryDate) || DEMO_DATE;
  ui.status = previous?.status || 'all'; ui.query = previous?.query || ''; ui.mobile = false;
  render(); window.scrollTo({ top: previous?.scrollY || 0, behavior: 'instant' });
});
window.addEventListener('storage', event => {
  if (isCloud || event.key !== STORAGE_KEY) return;
  model.state = new KitchenModel().state; localNotifications?.refresh(); if (clientPortal) restoreClientDraft();
  // Incorporate other tabs' business writes without destroying an in-progress
  // stock/quote form. The existing controls save against this fresh model state.
  ui.localRefreshPending = true;
  syncClientIdentity(); syncNotificationBadge();
  if (ui.orderId) { updatePacking(ui.orderId, true); return; }
  if (hasLocalDraftEditor()) return;
  render();
});
const storeUI = createStoreUI({ model, ui, isCloud, personalAccounts:Boolean(principal?.accountRole), canManageAccounts:principal?.accountRole==='owner', escape, icon, button, titleHeading, managementTabs, managementHeading, modal, storeAvatar, closeOverlay, render, toast });
const businessUI = createBusinessUI({ isCloud, model, ui, money, escape, icon, button, titleHeading, managementTabs, managementHeading, clientStoreSelect, cartPanel, qtyControl, cartTotal, cartItems, mobileCartBar, emptyState, modal, closeOverlay, activeStore, clientStoreHeader, statCard, render, nav, toast });
const settlementUI = createSettlementUI({ model, ui, escape, money, icon, button, modal, activeStore, storeAvatar, company, statCard, emptyState, render, nav, toast, download, getDocumentProfile:isCloud?()=>cloudRequest('/api/document-profile'):null });
const accountsUI=createAccountsUI({request:cloudRequest,principal:principal||{role:'admin'},escape,button,icon,modal,closeOverlay,toast,render:()=>{if(ui.page==='team')render();},onProfileChange:syncAccountProfiles});
if(isCloud&&ui.page==='team'&&principal.role==='admin'&&principal.accountRole==='owner'&&pageParams.get('store'))accountsUI.openStoreTeam(pageParams.get('store'));
const tasksUI = createTasksUI({ model, ui, escape, icon, button, render, modal, closeOverlay, toast });
const overviewUI = createOverviewUI({ model, ui, escape, money, icon, button, render, nav, modal, emptyState, closeOverlay, toast });
if(!isCloud)localNotifications=createLocalNotifications({model,actorId:'local-admin',actorName:'本地管理员',storage:model.storage,onChange:()=>notificationsUI?.refresh()});
notificationsUI=createNotificationsUI({
  list:params=>isCloud?cloudRequest('/api/notifications?'+new URLSearchParams({...params,includeDemo:params.includeDemo?'1':'0'})):localNotifications.list(params),
  markRead:body=>isCloud?cloudRequest('/api/notifications/read',body):localNotifications.markRead(body),
  modal,button,icon,escape,includeDemo:()=>ui.businessDemo,enabled:()=>ui.role==='admin',onCount:syncNotificationBadge,
  onNavigate:async item=>{
    if(item.targetType==='order'){
      let order=model.state.orders.find(order=>order.id===(item.orderId||item.targetId));if(!order&&isCloud){await model.loadReportHistory();order=model.state.orders.find(order=>order.id===(item.orderId||item.targetId));}if(!order)throw new Error('该货单暂未加载，请刷新业务页面后重试。');
      closeOverlay();openOrderDetail(order.id);
      if(item.productId)requestAnimationFrame(()=>{const line=app.querySelector('[data-packing-product="'+CSS.escape(item.productId)+'"]');line?.scrollIntoView({block:'center',behavior:'instant'});});
    }else{
      const product=model.getProduct(item.productId||item.targetId);if(!product||product.deletedAt)throw new Error('该商品已归档。');
      closeOverlay();await runAction('stock',{dataset:{id:product.id}});
    }
  },
});
window.addEventListener('kuraflow-notifications-changed',()=>notificationsUI.refresh());
const flowUI = createFlowUI({
  enabled:isCloud && principal?.role === 'admin' && window.__KURAFLOW_FLOW_ENABLED__ === true,
  principal,
  getContext:() => ({page:ui.page, orderId:ui.orderId || undefined, storeId:ui.page === 'stores' ? ui.quoteStore : undefined, date:ui.date}),
  onBusinessChange:()=>window.dispatchEvent(new Event('kuraflow-flow-data-changed')),
  onOpen:() => {ui.mobile = false; app.querySelector('.app-shell')?.classList.remove('mobile-open');},
  onNavigate:url => {
    const query=new URL(url,location.origin).searchParams,page=query.get('page');
    if(window.matchMedia('(max-width:720px)').matches||query.get('product'))flowUI.close();
    if(page==='orders'&&query.get('order')) {openOrderDetail(query.get('order'));return;}
    if(page==='stores'&&query.get('store'))ui.quoteStore=query.get('store');
    nav(page,query.get('tab')||'');
    if(page==='catalogue'&&query.get('product')&&model.getProduct(query.get('product')))businessUI.handleAction('price-info',{dataset:{id:query.get('product')}});
  },
});
document.addEventListener('keydown', event => {overviewUI.handleKeydown(event);tasksUI.handleKeydown(event);});
render();notificationsUI.refresh();
if(pageParams.get('flow')==='1')flowUI.open();

if (isCloud) {
  let expired = false, refreshing = false, flowRefreshPending = false;
  window.addEventListener('kuraflow-session-expired', () => {
    if (expired) return;
    expired = true; model.save();
    closeOverlay();
    app.innerHTML = '<div class="cloud-session-error"><section class="section-card"><h2>请重新登录</h2><p>登录已过期。购物车草稿已保留，登录后可以继续。</p><button class="btn btn-primary" id="cloud-relogin">重新登录</button></section></div>';
    document.querySelector('#cloud-relogin').addEventListener('click', () => location.reload());
  });
  window.addEventListener('kuraflow-state-changed', () => {
    syncNotificationBadge();
    if (!expired) { if (ui.orderId) updatePacking(ui.orderId, true); else render(); }
  });
  async function refreshCloudState() {
    if (expired || refreshing || document.hidden || model.pending || overlay.firstChild || document.querySelector('.ui-calendar, .ui-select-menu') || app.querySelector('[data-packing-saving]')) return;
    if ([...document.querySelectorAll('.inline-editor-feedback')].some(el => el.textContent === '未保存')) return;
    refreshing = true; flowRefreshPending = false;
    try {
      if (await model.refresh()) {
        syncClientIdentity(); syncNotificationBadge();
        if (app.contains(document.activeElement) && document.activeElement?.matches('input, textarea, select, .ui-select-trigger')) ui.cloudRefreshPending = true;
        else if (ui.orderId) updatePacking(ui.orderId, true); else render();
      }
      const status = document.querySelector('#cloud-sync-status');
      if (status) { status.textContent = '已连接'; status.classList.remove('cloud-reconnect'); }
    } catch {
      const status = document.querySelector('#cloud-sync-status');
      if (status) { status.textContent = '连接中断，正在重试'; status.classList.add('cloud-reconnect'); }
    } finally { refreshing = false; if (flowRefreshPending) void refreshCloudState(); }
  }
  setInterval(refreshCloudState, 30000);
  window.addEventListener('online', refreshCloudState);
  window.addEventListener('kuraflow-flow-data-changed', () => {flowRefreshPending = true; void refreshCloudState();});
  window.addEventListener('focus', refreshCloudState);
  document.addEventListener('focusout', () => setTimeout(() => {
    if (flowRefreshPending) void refreshCloudState();
    if (ui.cloudRefreshPending && !expired && !hasLocalDraftEditor() && !document.activeElement?.matches('input, textarea, select, .ui-select-trigger')) {
      if (ui.orderId) { ui.cloudRefreshPending = false; updatePacking(ui.orderId, true); } else render();
    }
  }, 0));
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  document.addEventListener('visibilitychange', refreshCloudState);
}
