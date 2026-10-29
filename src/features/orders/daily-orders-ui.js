import {t,tx,ta,mp,getLocale} from '../../i18n/index.js';
import {groupDailyOrders,filterDailyOrders} from '../../shared/daily-orders.js';

export function createDailyOrdersUI(ctx) {
  const {model,ui,escape:esc,money,button,icon,storeAvatar,activeStore}=ctx;
  const labels={pending:'待配货',packing:'配货中',ready:'待配送',delivering:'配送中',delivered:'已送达'};
  const quantity=value=>Number(value).toLocaleString(getLocale(),{maximumFractionDigits:3});
  const scope=()=>model.state.orders.filter(order=>ui.role!=='client'||order.storeId===activeStore().id);
  const groups=orders=>groupDailyOrders(model,orders.filter(order=>ui.role!=='client'||order.storeId===activeStore().id));
  const tax=q=>q.taxBasis==='inclusive'?tx('含税'):q.taxBasis==='exclusive'?tx('未税')+(q.taxRate===null?'':' · '+quantity(q.taxRate*100)+'%'):tx('税率待确认');
  function modeSwitch(){return `<div class="view-switch daily-order-view" role="tablist" ${ta('aria-label','订单视图')}>${[['daily','按日合并'],['individual','逐笔订单']].map(([value,label])=>`<button type="button" class="${ui.orderView===value?'active':''}" role="tab" aria-selected="${ui.orderView===value}" data-action="order-view" data-view="${value}">${tx(label)}</button>`).join('')}</div>`;}
  function lineHTML(line) {
    const prices=line.prices.length===1
      ? `<span>${line.price===null?tx('待报价'):money(line.price)+' / '+tx(line.unit)} · ${tax(line.prices[0])}</span>`
      : `<details class="daily-price-breakdown"><summary>${tx('分项价格（{0}）',[line.prices.length])}</summary>${line.prices.map(row=>`<div><span>${quantity(row.qty)} ${tx(row.unit)} × ${row.price===null?tx('待报价'):money(row.price)}</span><small>${tax(row)}</small></div>`).join('')}</details>`;
    return `<li class="daily-product"><div class="daily-product-main"><div><strong>${esc(line.name)}</strong>${line.spec?`<span>${esc(line.spec)}</span>`:''}</div><strong class="daily-product-qty">${quantity(line.qty)} <small>${tx(line.unit)}</small></strong></div><div class="daily-product-money">${prices}<strong>${line.total===null?(line.knownAmount?tx('已知 {0}',[money(line.knownAmount)]):tx('待确认')):money(line.total)}</strong></div></li>`;
  }
  function originalOrders(group) {
    return `<details class="daily-originals"><summary>${tx('原始订单')}<span>${group.orders.length}</span>${icon('chevron')}</summary><div>${group.records.map(record=>{
      const order=record.order,time=order.submittedAt&&Number.isFinite(Date.parse(order.submittedAt))?new Date(order.submittedAt).toLocaleString(getLocale(),{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
      return `<div class="daily-original-row"><div><strong>${esc(order.id)}</strong>${time?`<small>${esc(time)}</small>`:''}</div><span class="status-badge ${esc(order.stage)}">${tx(labels[order.stage]||order.stage)}</span><strong class="daily-original-amount">${money(record.amount)}</strong>${button(tx(ui.role==='admin'&&['pending','packing'].includes(order.stage)?'去配货':'查看'),ui.role==='admin'?'order-detail':'settlement-detail','ghost',`data-id="${esc(order.id)}"`)}${order.note?`<p>${esc(order.note)}</p>`:''}</div>`;
    }).join('')}</div></details>`;
  }
  function cards(list) {
    if(!list.length)return ctx.emptyState(tx('暂无订单'),tx('调整日期或状态查看。'),'clipboard');
    return `<div class="daily-order-list">${list.map(group=>{
      const day=group.day?group.day.replaceAll('-','/'):t('配送日期待确认'),preview=group.summaryLines.slice(0,3),rest=group.summaryLines.slice(3);
      return `<article class="section-card daily-order-card" data-daily-group="${esc(group.key)}"><header class="daily-order-heading">${ui.role==='admin'?storeAvatar(group.store):''}<div class="daily-order-identity"><h2>${esc(ui.role==='admin'?group.store.name:day)}</h2><p>${ui.role==='admin'?esc(day)+' · ':''}${tx('{0} 笔订单',[group.orders.length])}${group.order.isDemo?tx(' · 演示'):''}</p></div><div class="daily-order-value"><span>${tx(group.unpriced?'已知货品金额':'货品金额')}</span><strong>${money(group.amount)}</strong></div></header>
      <div class="daily-order-statuses">${group.statuses.map(row=>`<span>${tx(labels[row.stage])}<b>${row.count}</b></span>`).join('')}</div>
      <div class="daily-products-heading"><h3>${tx('商品汇总')}</h3><span>${tx('{0} 种商品',[group.productCount])}</span></div><ul class="daily-products">${preview.map(lineHTML).join('')}</ul>
      ${rest.length?`<details class="daily-more-products"><summary><span class="daily-expand-label">${tx('展开其余 {0} 项',[rest.length])}</span><span class="daily-collapse-label">${tx('收起')}</span>${icon('chevron')}</summary><ul class="daily-products">${rest.map(lineHTML).join('')}</ul></details>`:''}
      ${originalOrders(group)}
      <footer class="daily-order-footer">${group.unpriced?`<span>${tx('{0} 项单价待确认',[group.unpriced])}</span>`:'<span></span>'}${button(tx('导出纳品书'),'daily-order-pdf','secondary',`data-key="${esc(group.key)}" ${group.day?'':'disabled'}`,'download')}</footer></article>`;
    }).join('')}</div>`;
  }
  async function handleAction(action,el){
    if(action==='order-view'){
      ui.orderView=el.dataset.view==='individual'?'individual':'daily';
      const query=new URLSearchParams(location.search);query.set('orderView',ui.orderView);history.replaceState(null,'','?'+query);ctx.render();return true;
    }
    if(action==='daily-order-pdf'){
      if(model.reportHistoryReady===false){await model.loadReportHistory();if(!model.reportHistoryReady)throw new Error('历史订单读取失败');}
      const group=groups(scope()).find(row=>row.key===el.dataset.key);
      if(!group)throw new Error('无法查看该订单。');
      if(!group.day)throw new Error('配送日期待确认');
      await ctx.exportRecord(group,el,`${group.store.name}_${group.day}_合并纳品书.pdf`);return true;
    }
    return false;
  }
  return {modeSwitch,cards,groups,filter:filterDailyOrders,handleAction};
}
